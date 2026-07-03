/**
 * DagTree — DAG tree with permission-based access control inside a Star DO
 *
 * Encapsulates all DAG tree operations: node CRUD, edge management,
 * permission grants, and permission resolution. Uses Star's SQLite storage
 * and a lazy in-memory cache for reads.
 */

import type { CallContext } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import {
  ROOT_NODE_ID,
  validateNodeId,
  validateSlug,
  checkSlugUniqueness,
  detectCycle,
  resolvePermission,
  getEffectivePermission as getEffectivePermissionPure,
  getNodeAncestors as getNodeAncestorsPure,
  getNodeDescendants as getNodeDescendantsPure,
  buildDagTreeView,
  makeEdgeKey,
} from './dag-ops';
import type { PermissionTier, DagTreeState, DagTreeView, EdgeKey, DagTreeNodeData } from './dag-ops';
import { PermissionDeniedError, NodeNotFoundError, NodeIdCollisionError } from './errors';

export class DagTree {
  #ctx: DurableObjectState
  #_cached: DagTreeState | null = null
  #_view: DagTreeView | null = null
  #getCallContext: () => CallContext
  #onChanged: () => void

  constructor(ctx: DurableObjectState, getCallContext: () => CallContext, onChanged: () => void) {
    this.#ctx = ctx
    this.#getCallContext = getCallContext
    this.#onChanged = onChanged
    this.#createSchema()
    this.#ensureRoot()
  }

  // ─── Schema & Initialization ──────────────────────────────────────

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Nodes (
        nodeId TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        deleted BOOLEAN NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS Edges (
        parentNodeId TEXT NOT NULL,
        childNodeId TEXT NOT NULL,
        PRIMARY KEY (parentNodeId, childNodeId),
        FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
        FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Edges_child ON Edges(childNodeId);

      CREATE TABLE IF NOT EXISTS Permissions (
        nodeId TEXT NOT NULL,
        sub TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('admin', 'write', 'read')),
        PRIMARY KEY (nodeId, sub),
        FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Permissions_sub ON Permissions(sub);
    `)
  }

  #ensureRoot() {
    this.#ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO Nodes (nodeId, slug, label, deleted) VALUES (?, 'root', 'Root', 0)`,
      ROOT_NODE_ID,
    )
  }

  // ─── Cache ────────────────────────────────────────────────────────

  get #cached(): DagTreeState {
    if (!this.#_cached) {
      this.#_cached = this.#buildState()
      this.#_view = null
    }
    return this.#_cached
  }

  /** Adjacency-indexed view of `#cached`; rebuilt lazily on next read after a state change. */
  get #view(): DagTreeView {
    if (!this.#_view) {
      this.#_view = buildDagTreeView(this.#cached)
    }
    return this.#_view
  }

  /** Invalidate both the state cache and its derived view. Call after any SQL mutation. */
  #invalidate(): void {
    this.#_cached = null
    this.#_view = null
  }

  #buildState(): DagTreeState {
    const nodes = new Map<string, DagTreeNodeData>()
    const edges = new Set<EdgeKey>()
    const permissions = new Map<string, Map<string, PermissionTier>>()

    // Load all nodes
    const nodeRows = this.#ctx.storage.sql.exec('SELECT nodeId, slug, label, deleted FROM Nodes').toArray()
    for (const row of nodeRows) {
      nodes.set(row.nodeId as string, {
        slug: row.slug as string,
        label: row.label as string,
        deleted: Boolean(row.deleted),
      })
    }

    // Load all edges
    const edgeRows = this.#ctx.storage.sql.exec('SELECT parentNodeId, childNodeId FROM Edges').toArray()
    for (const row of edgeRows) {
      edges.add(makeEdgeKey(row.parentNodeId as string, row.childNodeId as string))
    }

    // Load all permissions
    const permRows = this.#ctx.storage.sql.exec('SELECT nodeId, sub, permission FROM Permissions').toArray()
    for (const row of permRows) {
      const nodeId = row.nodeId as string
      const sub = row.sub as string
      const tier = row.permission as PermissionTier
      let nodePerms = permissions.get(nodeId)
      if (!nodePerms) {
        nodePerms = new Map()
        permissions.set(nodeId, nodePerms)
      }
      nodePerms.set(sub, tier)
    }

    return { nodes, edges, permissions }
  }

  // ─── Auth Helpers ─────────────────────────────────────────────────

  #requireAuth(): string {
    const cc = this.#getCallContext()
    const sub = cc.originAuth?.sub
    if (!sub) throw new Error('Authentication required')
    return sub
  }

  requirePermission(nodeId: string, tier: PermissionTier): string {
    this.#requireNodeExists(nodeId)
    const cc = this.#getCallContext()
    const sub = cc.originAuth?.sub
    if (!sub) throw new Error('Authentication required')
    const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined
    if (claims?.access?.admin) return sub // Galaxy/Universe-scope admin bypass (NOT a Star admin — that's a DAG `admin` grant on root). `access.admin` is only minted with an `aud` inside the admin's authScopePattern (nebula-auth.ts mint + router.ts re-check), so trusting it here is sound: the Star is provably within the admin's scope.
    if (!resolvePermission(this.#view, sub, nodeId, tier)) {
      throw new PermissionDeniedError(tier, nodeId)
    }
    return sub
  }

  #requireNodeExists(nodeId: string): void {
    if (!this.#cached.nodes.has(nodeId)) {
      throw new NodeNotFoundError(nodeId)
    }
  }

  // ─── Tree Structure Mutations ─────────────────────────────────────

  createNode(nodeId: string, parentNodeId: string, slug: string, label: string): string {
    // Permission runs FIRST — before the id-presence check — because the replay
    // path returns node CONTENT (slug + label), so it must be gated exactly like
    // a fresh create. A retry by a caller who has since lost write legitimately
    // fails (ADR-005: the non-monotonic permission check stays authoritative
    // per-attempt). This deliberately differs from the void idempotent no-ops
    // (addEdge/deleteNode below), which short-circuit BEFORE requirePermission
    // precisely because they return nothing and disclose nothing.
    this.#requireNodeExists(parentNodeId)
    this.requirePermission(parentNodeId, 'write')
    validateNodeId(nodeId)

    // Replay vs conflict — read the committed cache, after the permission gate.
    // The id-existence check discloses only Star-wide-visible structure (ADR-008).
    if (this.#cached.nodes.has(nodeId)) {
      const existing = this.#cached.nodes.get(nodeId)!
      const edgeMatches = this.#cached.edges.has(makeEdgeKey(parentNodeId, nodeId))
      if (existing.slug === slug && edgeMatches) {
        return nodeId // idempotent replay: same node — return it, skip slug-uniqueness
      }
      // Reused id under a different parent/slug — a client bug, never a silent no-op.
      throw new NodeIdCollisionError(nodeId)
    }

    validateSlug(slug)
    checkSlugUniqueness(this.#view, parentNodeId, slug)

    this.#ctx.storage.transactionSync(() => {
      // Both inserts OR IGNORE so a partial replay (node landed but not the edge,
      // or vice versa) converges on retry.
      this.#ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Nodes (nodeId, slug, label, deleted) VALUES (?, ?, ?, 0)',
        nodeId, slug, label,
      )
      this.#ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        parentNodeId, nodeId,
      )
      this.#invalidate()
    })
    this.#onChanged()
    return nodeId
  }

  addEdge(parentNodeId: string, childNodeId: string): void {
    this.#requireNodeExists(parentNodeId)
    this.#requireNodeExists(childNodeId)

    // Idempotent: if edge already exists, no-op (skip permission check).
    // NOTE: short-circuiting BEFORE requirePermission is non-disclosing ONLY
    // because the org tree is universally visible (M7; ADR-008) — edge/grant
    // existence is already public. If tree visibility ever becomes per-branch,
    // every such short-circuit (here + removeEdge, deleteNode, undeleteNode,
    // revokePermission) must move AFTER requirePermission, or it leaks existence
    // to unauthorized callers.
    if (this.#cached.edges.has(makeEdgeKey(parentNodeId, childNodeId))) return

    this.requirePermission(parentNodeId, 'write')
    // Adding a parent edge is an access grant in structural clothing: everyone
    // holding grants on/above the new parent gains cascaded access to the
    // child's subtree. So it demands setPermission's tier, held on the child —
    // 'write' here would let any write-tier collaborator self-promote to admin
    // by grafting the node under a subtree they control.
    this.requirePermission(childNodeId, 'admin')
    detectCycle(this.#view, parentNodeId, childNodeId)
    const child = this.#cached.nodes.get(childNodeId)!
    checkSlugUniqueness(this.#view, parentNodeId, child.slug)

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        parentNodeId, childNodeId,
      )
      this.#invalidate()
    })
    this.#onChanged()
  }

  removeEdge(parentNodeId: string, childNodeId: string): void {
    this.#requireNodeExists(parentNodeId)
    this.#requireNodeExists(childNodeId)

    // Idempotent: if edge doesn't exist, no-op (skip permission check)
    if (!this.#cached.edges.has(makeEdgeKey(parentNodeId, childNodeId))) return

    this.requirePermission(parentNodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Edges WHERE parentNodeId = ? AND childNodeId = ?',
        parentNodeId, childNodeId,
      )
      this.#invalidate()
    })
    this.#onChanged()
  }

  reparentNode(childNodeId: string, oldParentId: string, newParentId: string): void {
    this.#requireNodeExists(childNodeId)
    this.#requireNodeExists(oldParentId)
    this.#requireNodeExists(newParentId)

    // Verify old edge exists
    if (!this.#cached.edges.has(makeEdgeKey(oldParentId, childNodeId))) {
      throw new Error(`Edge from ${oldParentId} to ${childNodeId} does not exist`)
    }

    this.requirePermission(oldParentId, 'write')
    this.requirePermission(newParentId, 'write')
    // Re-parenting adds a parent edge (newParent→child), so it carries addEdge's
    // access-widening property: everyone holding grants on/above newParent gains
    // cascaded access to the child's subtree. Like addEdge, it therefore demands
    // setPermission's tier held on the child — write@newParent alone would let a
    // write-tier collaborator graft the node under a subtree they control and
    // self-promote to admin. Removing the old edge is net-neutral for the actor
    // but doesn't undo the grant handed to newParent's other grantees.
    this.requirePermission(childNodeId, 'admin')

    // Cycle detection: would newParent→child create a cycle?
    detectCycle(this.#view, newParentId, childNodeId)

    // Slug uniqueness under new parent
    const child = this.#cached.nodes.get(childNodeId)!
    checkSlugUniqueness(this.#view, newParentId, child.slug)

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Edges WHERE parentNodeId = ? AND childNodeId = ?',
        oldParentId, childNodeId,
      )
      this.#ctx.storage.sql.exec(
        'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        newParentId, childNodeId,
      )
      this.#invalidate()
    })
    this.#onChanged()
  }

  deleteNode(nodeId: string): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot delete root node')

    // Idempotent: if already deleted, no-op (skip permission check)
    const node = this.#cached.nodes.get(nodeId)!
    if (node.deleted) return

    this.requirePermission(nodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET deleted = 1 WHERE nodeId = ?', nodeId)
      this.#invalidate()
    })
    this.#onChanged()
  }

  undeleteNode(nodeId: string): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot undelete root node')

    // Idempotent: if not deleted, no-op (skip permission check)
    const node = this.#cached.nodes.get(nodeId)!
    if (!node.deleted) return

    this.requirePermission(nodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET deleted = 0 WHERE nodeId = ?', nodeId)
      this.#invalidate()
    })
    this.#onChanged()
  }

  renameNode(nodeId: string, newSlug: string): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot rename root node')
    this.requirePermission(nodeId, 'write')
    validateSlug(newSlug)

    // Check uniqueness under every parent of this node
    const parents = this.#view.parentsByChild.get(nodeId) ?? new Set<string>()
    for (const parentId of parents) {
      checkSlugUniqueness(this.#view, parentId, newSlug, nodeId)
    }

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET slug = ? WHERE nodeId = ?', newSlug, nodeId)
      this.#invalidate()
    })
    this.#onChanged()
  }

  relabelNode(nodeId: string, newLabel: string): void {
    this.#requireNodeExists(nodeId)
    this.requirePermission(nodeId, 'write')
    if (!newLabel) throw new Error('Label must not be empty')
    if (newLabel.length > 500) throw new Error('Label must be 500 characters or fewer')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET label = ? WHERE nodeId = ?', newLabel, nodeId)
      this.#invalidate()
    })
    this.#onChanged()
  }

  // ─── Permission Management ────────────────────────────────────────

  setPermission(nodeId: string, targetSub: string, level: PermissionTier): void {
    this.#requireNodeExists(nodeId)
    this.requirePermission(nodeId, 'admin')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?) ON CONFLICT(nodeId, sub) DO UPDATE SET permission = excluded.permission',
        nodeId, targetSub, level,
      )
      this.#invalidate()
    })
    this.#onChanged()
  }

  revokePermission(nodeId: string, targetSub: string): void {
    this.#requireNodeExists(nodeId)

    // Idempotent: if no grant exists, no-op (skip permission check)
    const nodePerms = this.#cached.permissions.get(nodeId)
    if (!nodePerms || !nodePerms.has(targetSub)) return

    this.requirePermission(nodeId, 'admin')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Permissions WHERE nodeId = ? AND sub = ?',
        nodeId, targetSub,
      )
      this.#invalidate()
    })
    this.#onChanged()
  }

  // ─── Permission Queries ───────────────────────────────────────────

  checkPermission(nodeId: string, requiredTier: PermissionTier, targetSub?: string): boolean {
    this.#requireNodeExists(nodeId)
    const sub = targetSub ?? this.#requireAuth()
    return resolvePermission(this.#view, sub, nodeId, requiredTier)
  }

  /**
   * Batch permission evaluation for an EXPLICIT subscriber `sub` (NOT the live
   * caller) — the per-push read recheck (D3) + the query-membership filter (D4)
   * use this. Distinct from {@link requirePermission} on three axes:
   *   1. **Non-throwing** — returns `{ allowed, denied }` Sets, never throws (a
   *      lost-read subscriber is skipped, never dropped — D5).
   *   2. **No short-circuit** — every `nodeId` is evaluated so the `denied` set is
   *      COMPLETE (it drives request-access; a query caller already named these
   *      nodes — ADR-008 / D14). Do NOT early-return on the first denial.
   *   3. **Explicit `sub` + stored `accessAdmin`** — at push time we don't hold the
   *      subscriber's live JWT, so `requirePermission`'s `claims.access.admin`
   *      bypass (a Galaxy/Universe scope-admin who holds no DAG grant — dag-tree.ts
   *      `requirePermission`) is replicated here from the `accessAdmin` flag stored
   *      on the subscriber row at subscribe time (D16). `accessAdmin:true` ⇒ ALL
   *      allowed. Otherwise `resolvePermission` per node, which already honors a
   *      **Star** DAG `admin` grant (so a Star admin needs no `accessAdmin`).
   *
   * Unknown / missing nodeIds resolve to `denied` (no grant climbs to them) — no
   * throw, matching the non-throwing contract.
   */
  evaluatePermissions(
    nodeIds: string[],
    tier: PermissionTier,
    sub: string,
    accessAdmin: boolean,
  ): { allowed: Set<string>; denied: Set<string> } {
    const allowed = new Set<string>()
    const denied = new Set<string>()
    for (const nodeId of nodeIds) {
      if (accessAdmin || resolvePermission(this.#view, sub, nodeId, tier)) {
        allowed.add(nodeId)
      } else {
        denied.add(nodeId)
      }
    }
    return { allowed, denied }
  }

  getEffectivePermission(nodeId: string, targetSub?: string): PermissionTier | null {
    this.#requireNodeExists(nodeId)
    const sub = targetSub ?? this.#requireAuth()
    return getEffectivePermissionPure(this.#view, sub, nodeId)
  }

  // ─── State & Traversal Queries ────────────────────────────────────

  getState(): DagTreeState {
    this.#requireAuth()
    return this.#cached
  }

  getNodeAncestors(nodeId: string): Set<string> {
    this.#requireAuth()
    this.#requireNodeExists(nodeId)
    return getNodeAncestorsPure(this.#view, nodeId)
  }

  getNodeDescendants(nodeId: string): Set<string> {
    this.#requireAuth()
    this.#requireNodeExists(nodeId)
    return getNodeDescendantsPure(this.#view, nodeId)
  }
}

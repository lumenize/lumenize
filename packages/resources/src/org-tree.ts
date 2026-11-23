/**
 * OrgTree — DAG tree with permission-based access control, inside every host's resource plane
 *
 * Encapsulates all DAG tree operations: node CRUD, edge management,
 * permission grants, and permission resolution. Uses Star's SQLite storage
 * and a lazy in-memory cache for reads.
 */

import type { CallContext } from '@lumenize/mesh';
import type { AuthClaims } from '@lumenize/mesh';
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
  buildOrgTreeView,
  makeEdgeKey,
  isPermissionTier,
} from './org-ops';
import type { PermissionTier, OrgTreeState, OrgTreeView, EdgeKey, OrgTreeNodeData, NodeGrant, CreateNodeResult } from './org-ops';
import { PermissionDeniedError, NodeNotFoundError } from './errors';
import { hasDominionOverHost } from './host-dominion';

/** Refuse `grants` that are not an array of `{ sub, tier }`, before anything is written. */
function requireNodeGrants(grants: unknown): asserts grants is NodeGrant[] {
  if (!Array.isArray(grants)) {
    throw new Error('createNode\'s grants are an array of { sub, tier }, and this is no array')
  }
  for (const grant of grants) {
    if (typeof grant?.sub !== 'string' || grant.sub === '') {
      throw new Error('Each of createNode\'s grants names who holds it, as a non-empty `sub`')
    }
    if (!isPermissionTier(grant.tier)) {
      throw new Error(`A grant's tier is 'read', 'write' or 'admin', and ${JSON.stringify(grant.tier)} is none of them`)
    }
  }
}

export class OrgTree {
  #ctx: DurableObjectState
  #_cached: OrgTreeState | null = null
  #_view: OrgTreeView | null = null
  #getCallContext: () => CallContext
  #onChanged: () => void
  #getHostName: () => string | undefined

  /**
   * @param getHostName - The host DO's instance name as a **thunk** (never a captured value — the
   *   host builds this in `onStart()`, before its identity is stamped). It is the scope the
   *   `access.scopeAdmin` bypass is confined to in {@link requirePermission}.
   */
  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    onChanged: () => void,
    getHostName: () => string | undefined,
  ) {
    this.#ctx = ctx
    this.#getCallContext = getCallContext
    this.#onChanged = onChanged
    this.#getHostName = getHostName
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
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
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

  /**
   * Create the root, which every tree has and nothing can delete. It passes no permission check:
   * creating a tree is bookkeeping no one person asked for (ADR-025). Every other node is created
   * through {@link createNode}, by a caller the tree admits, a host's own `onStart` included. A
   * construction after the first writes nothing.
   */
  #ensureRoot() {
    this.#ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO Nodes (nodeId, slug, label, deleted) VALUES (?, 'root', 'Root', 0)`,
      ROOT_NODE_ID,
    )
  }

  // ─── Cache ────────────────────────────────────────────────────────

  get #cached(): OrgTreeState {
    if (!this.#_cached) {
      this.#_cached = this.#buildState()
      this.#_view = null
    }
    return this.#_cached
  }

  /** Adjacency-indexed view of `#cached`; rebuilt lazily on next read after a state change. */
  get #view(): OrgTreeView {
    if (!this.#_view) {
      this.#_view = buildOrgTreeView(this.#cached)
    }
    return this.#_view
  }

  /** Invalidate both the state cache and its derived view. Call after any SQL mutation. */
  #invalidate(): void {
    this.#_cached = null
    this.#_view = null
  }

  #buildState(): OrgTreeState {
    const nodes = new Map<string, OrgTreeNodeData>()
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
    const claims = cc.originAuth?.claims as AuthClaims | undefined
    // Scope-admin bypass — being a scope admin confers no DAG grant, a Star's own admin included, so
    // without this they could not act on the tree they govern.
    //
    // ⚠️ Confined to THIS host (`hasDominionOverHost`), never the bare `access.scopeAdmin` bit. The bit
    // alone is not dominion: `requirePassage` deliberately admits a caller whose own scope sits
    // BELOW this node (its upward arm), so a bare check let an admin of a child scope act as admin
    // on its ancestors. The prior comment here justified the bare bit with "`access.scopeAdmin` is only
    // minted with an `aud` at or below the admin's `authScope`" — true, but it establishes that about
    // `aud`, NOT about THIS HOST, which is the question actually being asked.
    // (It held only because every OrgTree host WAS a star-tier leaf — an incidental property the
    // Galaxy collapse deleted: the collapsed Galaxy hosts a DAG at `{u}.{g}`, so a `{u}.{g}.dev`
    // admin now reaches a host their scope does not cover. That denial is the live case, and
    // `confine-org-plane.test.ts` drives it against the real chat plane.)
    // An absent host name grants no bypass, so the caller falls through to the ordinary DAG
    // lookup and needs a real grant. Never coerce it to a sentinel: it would flow into
    // `isAtOrAbove`, where a superuser's root scope covers any string.
    if (hasDominionOverHost(claims, this.#getHostName())) return sub
    if (!resolvePermission(this.#view, sub, nodeId, tier)) {
      throw new PermissionDeniedError(tier, nodeId)
    }
    return sub
  }

  #requireNodeExists(nodeId: string): void {
    // A caller that read an id off something missing passes `undefined`, which is no node's id.
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new Error('A node id is required, and none was given')
    }
    if (!this.#cached.nodes.has(nodeId)) {
      throw new NodeNotFoundError(nodeId)
    }
  }

  // ─── Tree Structure Mutations ─────────────────────────────────────

  /**
   * Create the node `nodeId` under `parentNodeId`, only where that id is absent, and say what was
   * found ({@link CreateNodeResult}). The caller mints the id, a constant in source for a node its
   * code names, so the same call can run at every start: a node that exists is left as it stands,
   * whatever an admin has since renamed, moved or revoked.
   *
   * `grants` are written with the node, in its transaction, and never for a node that exists.
   * Granting takes more than creating does, so a caller that passes any is checked as
   * `setPermission` checks, at the parent, whether or not the node exists.
   *
   * @throws PermissionDeniedError without `write` at the parent, or without `admin` there when
   *   `grants` is non-empty; SlugTakenError when another node under the parent holds the slug.
   */
  createNode(nodeId: string, parentNodeId: string, slug: string, label: string, grants: NodeGrant[] = []): CreateNodeResult {
    // Every check runs before the id is looked up, so a caller who may not create here learns
    // nothing from the answer, and a repeat by a caller who has since lost `write` is refused.
    this.#requireNodeExists(parentNodeId)
    this.requirePermission(parentNodeId, 'write')
    validateNodeId(nodeId)
    if (typeof label !== 'string' || label === '') {
      throw new Error(`A node needs a label, the name people see, and '${slug}' has none`)
    }
    requireNodeGrants(grants)
    if (grants.length > 0) this.#requireMayGrant(parentNodeId)

    const existing = this.#cached.nodes.get(nodeId)
    if (existing) {
      const asAsked = !existing.deleted && existing.slug === slug
        && this.#cached.edges.has(makeEdgeKey(parentNodeId, nodeId))
      return { outcome: asAsked ? 'existing' : 'differs' }
    }

    validateSlug(slug)
    checkSlugUniqueness(this.#view, parentNodeId, slug)

    this.#ctx.storage.transactionSync(() => {
      this.#invalidate()
      this.#ctx.storage.sql.exec(
        'INSERT INTO Nodes (nodeId, slug, label, deleted) VALUES (?, ?, ?, 0)', nodeId, slug, label)
      this.#ctx.storage.sql.exec(
        'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)', parentNodeId, nodeId)
      const granted = new Set<string>()
      for (const { sub, tier } of grants) {
        // A plain insert: a `sub` named twice would otherwise keep whichever tier came last.
        if (granted.has(sub)) throw new Error(`createNode's grants name "${sub}" twice`)
        granted.add(sub)
        this.#ctx.storage.sql.exec(
          'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?)', nodeId, sub, tier)
      }
    })
    this.#onChanged()
    return { outcome: 'created' }
  }

  /** What a caller must hold to write a grant at `nodeId`: one check, for `setPermission` and for
   *  a create that names starting grants, so a rule added here binds both. */
  #requireMayGrant(nodeId: string): void {
    this.requirePermission(nodeId, 'admin')
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

  /**
   * Sets the node's `deleted` flag, which {@link undeleteNode} clears. Nothing else reads the flag:
   * a deleted node still carries its grants and still answers a permission check.
   */
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
    this.#requireMayGrant(nodeId)

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
   * caller) — the per-push read recheck + the query-membership filter
   * use this. Distinct from {@link requirePermission} on three axes:
   *   1. **Non-throwing** — returns `{ allowed, denied }` Sets, never throws (a
   *      lost-read subscriber is skipped, never dropped).
   *   2. **No short-circuit** — every `nodeId` is evaluated so the `denied` set is
   *      COMPLETE (it drives request-access; a query caller already named these
   *      nodes — ADR-008). Do NOT early-return on the first denial.
   *   3. **Explicit `sub` + a `holdsDominion` VERDICT** — at push time we don't hold the
   *      subscriber's live JWT, so `requirePermission`'s scope-admin bypass (any admin whose
   *      dominion reaches this host, a Star's own admin included, none of whom is granted anything
   *      in the DAG by being an admin)
   *      is replicated here from the flag stored on the subscriber row at subscribe time, or from
   *      the one computed live by a one-time read. `holdsDominion: true` ⇒ ALL allowed. Otherwise `resolvePermission` per node, which
   *      honors the DAG grants in the tree.
   *
   * ⚠️ **This method takes no scope and no host name, so it is NOT a confinement point** — do not
   * add one, and do not claim it "inherits confinement from the store." Its operand comes from
   * three places, and only the first two are confined:
   *   - **Push path** (`resources.ts` `#targetsForQuery` / query-push / mutation-broadcast)
   *     passes the stored row's verdict, which IS confined at write time. That is the path that
   *     matters, and the one tasks/archive/nebula-confine-admin-bypass.md closed.
   *   - **One-time query read** (`Resources.doQuery`) computes the verdict live, through
   *     `hasDominionOverHost`, from the caller's own claims.
   *   - **Wire path** — every host's `resources` door is a bare `@mesh()` handing back
   *     `resources.orgTree`, and mesh's "gate once, then chain" checks for `@mesh()` only on a chain's
   *     ENTRY op, so a caller can
   *     reach this method directly with an attacker-chosen `holdsDominion`. **That is harmless for a
   *     separate reason**: this method is read-only, non-throwing, and echoes back only the
   *     caller's OWN `nodeIds` — disclosing nothing the tree itself does not already show anyone
   *     with passage into the host, on a Star or a Galaxy alike (ADR-008's visibility ≠ capability,
   *     carried up the hierarchy for the tree kind in `subscriptions.ts`).
   *     A forged `holdsDominion: true` therefore grants no capability, it only relabels a set the
   *     caller already named. Keep the confined paths' justification and this one distinct; conflating them would assert
   *     an invariant nothing enforces.
   *
   * Unknown / missing nodeIds resolve to `denied` (no grant climbs to them) — no
   * throw, matching the non-throwing contract.
   */
  evaluatePermissions(
    nodeIds: string[],
    tier: PermissionTier,
    sub: string,
    holdsDominion: boolean,
  ): { allowed: Set<string>; denied: Set<string> } {
    const allowed = new Set<string>()
    const denied = new Set<string>()
    for (const nodeId of nodeIds) {
      if (holdsDominion || resolvePermission(this.#view, sub, nodeId, tier)) {
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

  /**
   * The whole tree, as a COPY. `#cached` is what every permission decision reads (`#view` is built
   * over it), and this method is reachable from the wire past the `resources` door, where the walk
   * runs any method the returned value carries — `Map.prototype.set` included. Returned by reference, a member
   * could grant themselves admin at the root inside one chain, then pass `setPermission`'s own check
   * to make it durable. Nothing reachable from a gate may hand back state the node decides with.
   */
  getState(): OrgTreeState {
    this.#requireAuth()
    return structuredClone(this.#cached)
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

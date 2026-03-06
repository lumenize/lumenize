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
  validateSlug,
  checkSlugUniqueness,
  detectCycle,
  resolvePermission,
  getEffectivePermission as getEffectivePermissionPure,
  getNodeAncestors as getNodeAncestorsPure,
  getNodeDescendants as getNodeDescendantsPure,
} from './dag-ops';
import type { PermissionTier, DagTreeState } from './dag-ops';

export class DagTree {
  #ctx: DurableObjectState
  #_cached: DagTreeState | null = null
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
        nodeId INTEGER PRIMARY KEY,
        slug TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        deleted BOOLEAN NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS Edges (
        parentNodeId INTEGER NOT NULL,
        childNodeId INTEGER NOT NULL,
        PRIMARY KEY (parentNodeId, childNodeId),
        FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
        FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Edges_child ON Edges(childNodeId);

      CREATE TABLE IF NOT EXISTS Permissions (
        nodeId INTEGER NOT NULL,
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
    }
    return this.#_cached
  }

  #buildState(): DagTreeState {
    const nodes = new Map<number, { slug: string; label: string; deleted: boolean; parentIds: number[]; childIds: number[] }>()
    const permissions = new Map<number, Map<string, PermissionTier>>()

    // Load all nodes
    const nodeRows = this.#ctx.storage.sql.exec('SELECT nodeId, slug, label, deleted FROM Nodes').toArray()
    for (const row of nodeRows) {
      nodes.set(row.nodeId as number, {
        slug: row.slug as string,
        label: row.label as string,
        deleted: Boolean(row.deleted),
        parentIds: [],
        childIds: [],
      })
    }

    // Load all edges and populate parentIds/childIds
    const edgeRows = this.#ctx.storage.sql.exec('SELECT parentNodeId, childNodeId FROM Edges').toArray()
    for (const row of edgeRows) {
      const parentId = row.parentNodeId as number
      const childId = row.childNodeId as number
      const parent = nodes.get(parentId)
      const child = nodes.get(childId)
      if (parent) parent.childIds.push(childId)
      if (child) child.parentIds.push(parentId)
    }

    // Load all permissions
    const permRows = this.#ctx.storage.sql.exec('SELECT nodeId, sub, permission FROM Permissions').toArray()
    for (const row of permRows) {
      const nodeId = row.nodeId as number
      const sub = row.sub as string
      const tier = row.permission as PermissionTier
      let nodePerms = permissions.get(nodeId)
      if (!nodePerms) {
        nodePerms = new Map()
        permissions.set(nodeId, nodePerms)
      }
      nodePerms.set(sub, tier)
    }

    return { nodes, permissions }
  }

  // ─── Auth Helpers ─────────────────────────────────────────────────

  #requireAuth(): string {
    const cc = this.#getCallContext()
    const sub = cc.originAuth?.sub
    if (!sub) throw new Error('Authentication required')
    return sub
  }

  #requirePermission(nodeId: number, tier: PermissionTier): string {
    const cc = this.#getCallContext()
    const sub = cc.originAuth?.sub
    if (!sub) throw new Error('Authentication required')
    const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined
    if (claims?.access?.admin) return sub // Star admin bypass
    if (!resolvePermission(this.#cached, sub, nodeId, tier)) {
      throw new Error(`${tier} permission required on node ${nodeId}`)
    }
    return sub
  }

  #requireNodeExists(nodeId: number): void {
    if (!this.#cached.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} not found`)
    }
  }

  // ─── Tree Structure Mutations ─────────────────────────────────────

  createNode(parentNodeId: number, slug: string, label: string): number {
    this.#requireNodeExists(parentNodeId)
    this.#requirePermission(parentNodeId, 'write')
    validateSlug(slug)
    checkSlugUniqueness(this.#cached, parentNodeId, slug)

    let newNodeId!: number
    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'INSERT INTO Nodes (slug, label, deleted) VALUES (?, ?, 0)',
        slug, label,
      )
      // SQLite last_insert_rowid() gives us the auto-assigned nodeId
      const result = this.#ctx.storage.sql.exec('SELECT last_insert_rowid() as id').toArray()
      newNodeId = result[0].id as number
      this.#ctx.storage.sql.exec(
        'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        parentNodeId, newNodeId,
      )
      this.#_cached = null
    })
    this.#onChanged()
    return newNodeId
  }

  addEdge(parentNodeId: number, childNodeId: number): void {
    this.#requireNodeExists(parentNodeId)
    this.#requireNodeExists(childNodeId)

    // Idempotent: if edge already exists, no-op (skip permission check)
    const parent = this.#cached.nodes.get(parentNodeId)!
    if (parent.childIds.includes(childNodeId)) return

    this.#requirePermission(parentNodeId, 'write')
    detectCycle(this.#cached, parentNodeId, childNodeId)
    const child = this.#cached.nodes.get(childNodeId)!
    checkSlugUniqueness(this.#cached, parentNodeId, child.slug)

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        parentNodeId, childNodeId,
      )
      this.#_cached = null
    })
    this.#onChanged()
  }

  removeEdge(parentNodeId: number, childNodeId: number): void {
    this.#requireNodeExists(parentNodeId)
    this.#requireNodeExists(childNodeId)

    // Idempotent: if edge doesn't exist, no-op (skip permission check)
    const parent = this.#cached.nodes.get(parentNodeId)!
    if (!parent.childIds.includes(childNodeId)) return

    this.#requirePermission(parentNodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Edges WHERE parentNodeId = ? AND childNodeId = ?',
        parentNodeId, childNodeId,
      )
      this.#_cached = null
    })
    this.#onChanged()
  }

  reparentNode(childNodeId: number, oldParentId: number, newParentId: number): void {
    this.#requireNodeExists(childNodeId)
    this.#requireNodeExists(oldParentId)
    this.#requireNodeExists(newParentId)

    // Verify old edge exists
    const oldParent = this.#cached.nodes.get(oldParentId)!
    if (!oldParent.childIds.includes(childNodeId)) {
      throw new Error(`Edge from ${oldParentId} to ${childNodeId} does not exist`)
    }

    this.#requirePermission(oldParentId, 'write')
    this.#requirePermission(newParentId, 'write')

    // Cycle detection: would newParent→child create a cycle?
    detectCycle(this.#cached, newParentId, childNodeId)

    // Slug uniqueness under new parent
    const child = this.#cached.nodes.get(childNodeId)!
    checkSlugUniqueness(this.#cached, newParentId, child.slug)

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Edges WHERE parentNodeId = ? AND childNodeId = ?',
        oldParentId, childNodeId,
      )
      this.#ctx.storage.sql.exec(
        'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        newParentId, childNodeId,
      )
      this.#_cached = null
    })
    this.#onChanged()
  }

  deleteNode(nodeId: number): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot delete root node')

    // Idempotent: if already deleted, no-op (skip permission check)
    const node = this.#cached.nodes.get(nodeId)!
    if (node.deleted) return

    this.#requirePermission(nodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET deleted = 1 WHERE nodeId = ?', nodeId)
      this.#_cached = null
    })
    this.#onChanged()
  }

  undeleteNode(nodeId: number): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot undelete root node')

    // Idempotent: if not deleted, no-op (skip permission check)
    const node = this.#cached.nodes.get(nodeId)!
    if (!node.deleted) return

    this.#requirePermission(nodeId, 'write')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET deleted = 0 WHERE nodeId = ?', nodeId)
      this.#_cached = null
    })
    this.#onChanged()
  }

  renameNode(nodeId: number, newSlug: string): void {
    this.#requireNodeExists(nodeId)
    if (nodeId === ROOT_NODE_ID) throw new Error('Cannot rename root node')
    this.#requirePermission(nodeId, 'write')
    validateSlug(newSlug)

    // Check uniqueness under every parent of this node
    const node = this.#cached.nodes.get(nodeId)!
    for (const parentId of node.parentIds) {
      checkSlugUniqueness(this.#cached, parentId, newSlug, nodeId)
    }

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET slug = ? WHERE nodeId = ?', newSlug, nodeId)
      this.#_cached = null
    })
    this.#onChanged()
  }

  relabelNode(nodeId: number, newLabel: string): void {
    this.#requireNodeExists(nodeId)
    this.#requirePermission(nodeId, 'write')
    if (!newLabel) throw new Error('Label must not be empty')
    if (newLabel.length > 500) throw new Error('Label must be 500 characters or fewer')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec('UPDATE Nodes SET label = ? WHERE nodeId = ?', newLabel, nodeId)
      this.#_cached = null
    })
    this.#onChanged()
  }

  // ─── Permission Management ────────────────────────────────────────

  setPermission(nodeId: number, targetSub: string, level: PermissionTier): void {
    this.#requireNodeExists(nodeId)
    this.#requirePermission(nodeId, 'admin')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?) ON CONFLICT(nodeId, sub) DO UPDATE SET permission = excluded.permission',
        nodeId, targetSub, level,
      )
      this.#_cached = null
    })
    this.#onChanged()
  }

  revokePermission(nodeId: number, targetSub: string): void {
    this.#requireNodeExists(nodeId)

    // Idempotent: if no grant exists, no-op (skip permission check)
    const nodePerms = this.#cached.permissions.get(nodeId)
    if (!nodePerms || !nodePerms.has(targetSub)) return

    this.#requirePermission(nodeId, 'admin')

    this.#ctx.storage.transactionSync(() => {
      this.#ctx.storage.sql.exec(
        'DELETE FROM Permissions WHERE nodeId = ? AND sub = ?',
        nodeId, targetSub,
      )
      this.#_cached = null
    })
    this.#onChanged()
  }

  // ─── Permission Queries ───────────────────────────────────────────

  checkPermission(nodeId: number, requiredTier: PermissionTier, targetSub?: string): boolean {
    this.#requireNodeExists(nodeId)
    const sub = targetSub ?? this.#requireAuth()
    return resolvePermission(this.#cached, sub, nodeId, requiredTier)
  }

  getEffectivePermission(nodeId: number, targetSub?: string): PermissionTier | null {
    this.#requireNodeExists(nodeId)
    const sub = targetSub ?? this.#requireAuth()
    return getEffectivePermissionPure(this.#cached, sub, nodeId)
  }

  // ─── State & Traversal Queries ────────────────────────────────────

  getState(): DagTreeState {
    this.#requireAuth()
    return this.#cached
  }

  getNodeAncestors(nodeId: number): Set<number> {
    this.#requireAuth()
    this.#requireNodeExists(nodeId)
    return getNodeAncestorsPure(this.#cached, nodeId)
  }

  getNodeDescendants(nodeId: number): Set<number> {
    this.#requireAuth()
    this.#requireNodeExists(nodeId)
    return getNodeDescendantsPure(this.#cached, nodeId)
  }
}

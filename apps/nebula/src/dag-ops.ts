/**
 * dag-ops — Pure functions on DagTreeState
 *
 * Shared between server (DagTree class) and client (pre-validation, permission checks, traversal).
 * No storage, no CallContext dependency — operates entirely on the in-memory DagTreeState.
 */

export const ROOT_NODE_ID = 1

export type PermissionTier = 'admin' | 'write' | 'read'

/** Canonical edge key form for `DagTreeState.edges`. */
export type EdgeKey = `${number}:${number}`

export function makeEdgeKey(parentNodeId: number, childNodeId: number): EdgeKey {
  return `${parentNodeId}:${childNodeId}` as EdgeKey
}

export interface DagTreeNodeData {
  slug: string;
  label: string;
  deleted: boolean;
}

export interface DagTreeState {
  nodes: Map<number, DagTreeNodeData>;
  edges: Set<EdgeKey>;
  permissions: Map<number, Map<string, PermissionTier>>; // nodeId → { sub → tier }
}

/**
 * Read-only adjacency-indexed view of a `DagTreeState`.
 *
 * `state` is the canonical, wire-shippable form. `parentsByChild` and
 * `childrenByParent` are O(1) lookup indexes derived from `state.edges`,
 * built once per state rebuild so traversal/permission/cycle queries stay
 * fast.
 *
 * Build a fresh view from a state via `buildDagTreeView(state)`; consumers
 * that mutate state must rebuild the view (or invalidate it) afterward.
 */
export interface DagTreeView {
  readonly state: DagTreeState;
  readonly parentsByChild: ReadonlyMap<number, ReadonlySet<number>>;
  readonly childrenByParent: ReadonlyMap<number, ReadonlySet<number>>;
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>()

/** Build a `DagTreeView` from a `DagTreeState`. O(E) over edges. */
export function buildDagTreeView(state: DagTreeState): DagTreeView {
  const parentsByChild = new Map<number, Set<number>>()
  const childrenByParent = new Map<number, Set<number>>()
  for (const edge of state.edges) {
    const colon = edge.indexOf(':')
    const parentId = Number(edge.slice(0, colon))
    const childId = Number(edge.slice(colon + 1))
    let kids = childrenByParent.get(parentId)
    if (!kids) { kids = new Set(); childrenByParent.set(parentId, kids) }
    kids.add(childId)
    let pars = parentsByChild.get(childId)
    if (!pars) { pars = new Set(); parentsByChild.set(childId, pars) }
    pars.add(parentId)
  }
  return { state, parentsByChild, childrenByParent }
}

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

const TIER_RANK: Record<PermissionTier, number> = { read: 1, write: 2, admin: 3 }

// ─── Validation ────────────────────────────────────────────────────

export function validateSlug(slug: string): void {
  if (!slug) throw new Error('Slug must not be empty')
  if (slug.length > 100) throw new Error('Slug must be 100 characters or fewer')
  if (!SLUG_REGEX.test(slug)) {
    throw new Error('Slug must contain only lowercase letters, numbers, and hyphens, with no leading or trailing hyphens')
  }
}

export function checkSlugUniqueness(view: DagTreeView, parentNodeId: number, slug: string, excludeNodeId?: number): void {
  const parent = view.state.nodes.get(parentNodeId)
  if (!parent) throw new Error(`Node ${parentNodeId} not found`)
  const children = view.childrenByParent.get(parentNodeId) ?? EMPTY_SET
  for (const childId of children) {
    if (excludeNodeId !== undefined && childId === excludeNodeId) continue
    const child = view.state.nodes.get(childId)
    if (child && child.slug === slug) {
      throw new Error(`Slug '${slug}' already exists under parent ${parentNodeId}`)
    }
  }
}

export function detectCycle(view: DagTreeView, parentNodeId: number, childNodeId: number): void {
  // If adding parent→child would create a cycle, parent must be a descendant of child.
  // Walk up from parent via parentsByChild; if we find child, it's a cycle.
  const visited = new Set<number>()
  const queue = [parentNodeId]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (current === childNodeId) {
      throw new Error('Adding this edge would create a cycle')
    }
    if (visited.has(current)) continue
    visited.add(current)
    const parents = view.parentsByChild.get(current) ?? EMPTY_SET
    for (const pid of parents) {
      if (!visited.has(pid)) queue.push(pid)
    }
  }
}

// ─── Permission Resolution ─────────────────────────────────────────

/**
 * Check if `sub` has at least `requiredTier` on `nodeId` via ancestor rolldown.
 * Climbs all ancestor paths; returns true if any path grants sufficient permission.
 * Deleted nodes are climbed through and their grants are considered normally.
 */
export function resolvePermission(
  view: DagTreeView,
  sub: string,
  nodeId: number,
  requiredTier: PermissionTier,
): boolean {
  const effective = getEffectivePermission(view, sub, nodeId)
  if (!effective) return false
  return TIER_RANK[effective] >= TIER_RANK[requiredTier]
}

/**
 * Get the highest effective permission for `sub` on `nodeId` by climbing all ancestor paths.
 * Returns null if no grant found on any ancestor.
 */
export function getEffectivePermission(
  view: DagTreeView,
  sub: string,
  nodeId: number,
): PermissionTier | null {
  let best: PermissionTier | null = null
  const visited = new Set<number>()
  const queue = [nodeId]

  while (queue.length > 0) {
    const current = queue.pop()!
    if (visited.has(current)) continue
    visited.add(current)

    // Check direct grant on this node
    const nodePerms = view.state.permissions.get(current)
    if (nodePerms) {
      const grant = nodePerms.get(sub)
      if (grant) {
        if (!best || TIER_RANK[grant] > TIER_RANK[best]) {
          best = grant
        }
        // If we already found admin, no need to keep searching
        if (best === 'admin') return best
      }
    }

    // Climb to parents
    const parents = view.parentsByChild.get(current) ?? EMPTY_SET
    for (const pid of parents) {
      if (!visited.has(pid)) queue.push(pid)
    }
  }

  return best
}

// ─── Traversal ──────────────────────────────────────────────────────

/** Get all ancestor nodeIds (excludes the starting node). */
export function getNodeAncestors(view: DagTreeView, nodeId: number): Set<number> {
  const ancestors = new Set<number>()
  const queue: number[] = []
  for (const pid of view.parentsByChild.get(nodeId) ?? EMPTY_SET) queue.push(pid)
  while (queue.length > 0) {
    const current = queue.pop()!
    if (ancestors.has(current)) continue
    ancestors.add(current)
    for (const pid of view.parentsByChild.get(current) ?? EMPTY_SET) {
      if (!ancestors.has(pid)) queue.push(pid)
    }
  }
  return ancestors
}

/** Get all descendant nodeIds (excludes the starting node). */
export function getNodeDescendants(view: DagTreeView, nodeId: number): Set<number> {
  const descendants = new Set<number>()
  const queue: number[] = []
  for (const cid of view.childrenByParent.get(nodeId) ?? EMPTY_SET) queue.push(cid)
  while (queue.length > 0) {
    const current = queue.pop()!
    if (descendants.has(current)) continue
    descendants.add(current)
    for (const cid of view.childrenByParent.get(current) ?? EMPTY_SET) {
      if (!descendants.has(cid)) queue.push(cid)
    }
  }
  return descendants
}

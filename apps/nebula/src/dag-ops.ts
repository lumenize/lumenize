/**
 * dag-ops — Pure functions on DagTreeState
 *
 * Shared between server (DagTree class) and client (pre-validation, permission checks, traversal).
 * No storage, no CallContext dependency — operates entirely on the in-memory DagTreeState.
 */

export const ROOT_NODE_ID = 1

export type PermissionTier = 'admin' | 'write' | 'read'

export interface DagTreeState {
  nodes: Map<number, {
    slug: string;
    label: string;
    deleted: boolean;
    parentIds: number[];
    childIds: number[];
  }>;
  permissions: Map<number, Map<string, PermissionTier>>; // nodeId → { sub → tier }
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

export function checkSlugUniqueness(state: DagTreeState, parentNodeId: number, slug: string, excludeNodeId?: number): void {
  const parent = state.nodes.get(parentNodeId)
  if (!parent) throw new Error(`Node ${parentNodeId} not found`)
  for (const childId of parent.childIds) {
    if (excludeNodeId !== undefined && childId === excludeNodeId) continue
    const child = state.nodes.get(childId)
    if (child && child.slug === slug) {
      throw new Error(`Slug '${slug}' already exists under parent ${parentNodeId}`)
    }
  }
}

export function detectCycle(state: DagTreeState, parentNodeId: number, childNodeId: number): void {
  // If adding parent→child would create a cycle, parent must be a descendant of child.
  // Walk up from parent via parentIds; if we find child, it's a cycle.
  const visited = new Set<number>()
  const queue = [parentNodeId]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (current === childNodeId) {
      throw new Error('Adding this edge would create a cycle')
    }
    if (visited.has(current)) continue
    visited.add(current)
    const node = state.nodes.get(current)
    if (node) {
      for (const pid of node.parentIds) {
        if (!visited.has(pid)) queue.push(pid)
      }
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
  state: DagTreeState,
  sub: string,
  nodeId: number,
  requiredTier: PermissionTier,
): boolean {
  const effective = getEffectivePermission(state, sub, nodeId)
  if (!effective) return false
  return TIER_RANK[effective] >= TIER_RANK[requiredTier]
}

/**
 * Get the highest effective permission for `sub` on `nodeId` by climbing all ancestor paths.
 * Returns null if no grant found on any ancestor.
 */
export function getEffectivePermission(
  state: DagTreeState,
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
    const nodePerms = state.permissions.get(current)
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
    const node = state.nodes.get(current)
    if (node) {
      for (const pid of node.parentIds) {
        if (!visited.has(pid)) queue.push(pid)
      }
    }
  }

  return best
}

// ─── Traversal ──────────────────────────────────────────────────────

/** Get all ancestor nodeIds (excludes the starting node). */
export function getNodeAncestors(state: DagTreeState, nodeId: number): Set<number> {
  const ancestors = new Set<number>()
  const queue: number[] = []
  const node = state.nodes.get(nodeId)
  if (node) {
    for (const pid of node.parentIds) queue.push(pid)
  }
  while (queue.length > 0) {
    const current = queue.pop()!
    if (ancestors.has(current)) continue
    ancestors.add(current)
    const n = state.nodes.get(current)
    if (n) {
      for (const pid of n.parentIds) {
        if (!ancestors.has(pid)) queue.push(pid)
      }
    }
  }
  return ancestors
}

/** Get all descendant nodeIds (excludes the starting node). */
export function getNodeDescendants(state: DagTreeState, nodeId: number): Set<number> {
  const descendants = new Set<number>()
  const queue: number[] = []
  const node = state.nodes.get(nodeId)
  if (node) {
    for (const cid of node.childIds) queue.push(cid)
  }
  while (queue.length > 0) {
    const current = queue.pop()!
    if (descendants.has(current)) continue
    descendants.add(current)
    const n = state.nodes.get(current)
    if (n) {
      for (const cid of n.childIds) {
        if (!descendants.has(cid)) queue.push(cid)
      }
    }
  }
  return descendants
}

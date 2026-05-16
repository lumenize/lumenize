/**
 * Synthetic DAG state model for the wire-format experiment.
 *
 * Mirrors the in-memory shape proposed in tasks/structured-clone-object-based-wire-format.md
 * § D1 (normalized): `{ nodes, edges, permissions }` with no inline adjacency lists.
 *
 * Edges are encoded as strings `${parentId}:${childId}` so that the `edges` set
 * has stable wire representation under any of the candidate formats and is
 * naturally amenable to JSON Merge Patch (each edge becomes a single keyed slot).
 */

export type NodeId = string;
export type Subject = string;
export type PermissionTier = 'admin' | 'write' | 'read';

export interface NodeData {
  slug: string;
  label: string;
  deleted: boolean;
}

/**
 * Canonical, in-memory DAG state. This is the shape `preprocess()` would see.
 * Indexes (`childrenByParent`, `parentsByChild`) are local to the consuming DO
 * per § D1 and are NOT part of this shape — they'd be rebuilt from `edges`.
 */
export interface DagTreeState {
  nodes: Record<NodeId, NodeData>;
  /** Set of "parentId:childId" strings — encoded as a plain object for wire stability. */
  edges: Record<string, true>;
  /** node id → subject → tier */
  permissions: Record<NodeId, Record<Subject, PermissionTier>>;
}

export type MutationKind =
  | 'add-leaf'
  | 'rename-label'
  | 'move-single'
  | 'move-subtree-50'
  | 'grant-permission';

export interface Mutation {
  kind: MutationKind;
  description: string;
  before: DagTreeState;
  after: DagTreeState;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so fixtures are reproducible.
// ---------------------------------------------------------------------------
export function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS_POOL = [
  'alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'heidi',
  'ivan', 'judy', 'kyle', 'laura', 'mallory', 'nick', 'oscar', 'peggy',
];

/**
 * Build a synthetic DAG with realistic fanout distribution:
 *   - 80% leaves (one parent, no children)
 *   - 15% mid-tier branches (a few children)
 *   - 5% wide root-ish branches (many children)
 *
 * Permissions are sparse — about 10% of nodes carry per-node ACL grants,
 * each with 1–3 random subjects. This mirrors the "most nodes inherit; a
 * minority are individually shared" pattern seen in Nebula.
 */
export function buildSyntheticDag(N: number, seed = 1): DagTreeState {
  const rnd = rngFrom(seed);
  const nodes: Record<NodeId, NodeData> = {};
  const edges: Record<string, true> = {};
  const permissions: Record<NodeId, Record<Subject, PermissionTier>> = {};

  // Root
  nodes['n0'] = { slug: 'root', label: 'Root', deleted: false };

  // Categorize nodes by role
  const roleOf: ('wide' | 'mid' | 'leaf')[] = [];
  for (let i = 1; i < N; i++) {
    const r = rnd();
    if (r < 0.05) roleOf.push('wide');
    else if (r < 0.20) roleOf.push('mid');
    else roleOf.push('leaf');
  }

  // Track parents available for new connections by role.
  // `wide` nodes can hold 20+ children, `mid` 3–8, `leaf` 0.
  const cap = (role: 'wide' | 'mid' | 'leaf'): number =>
    role === 'wide' ? 20 + Math.floor(rnd() * 20)
      : role === 'mid' ? 3 + Math.floor(rnd() * 6)
        : 0;

  const remaining: Record<NodeId, number> = { n0: cap('wide') };
  const parentRoles: Record<NodeId, 'wide' | 'mid' | 'leaf'> = { n0: 'wide' };

  for (let i = 1; i < N; i++) {
    const id = `n${i}`;
    const role = roleOf[i - 1]!;
    // Pick a parent — prefer parents with remaining capacity. Bias toward wide/mid.
    const candidates = Object.keys(remaining).filter((p) => remaining[p]! > 0);
    const parent = candidates.length > 0
      ? candidates[Math.floor(rnd() * candidates.length)]!
      : 'n0';
    nodes[id] = { slug: `node-${i}`, label: `Node ${i}`, deleted: false };
    edges[`${parent}:${id}`] = true;
    remaining[parent] = (remaining[parent] ?? 0) - 1;
    if (remaining[parent]! <= 0) delete remaining[parent];
    remaining[id] = cap(role);
    parentRoles[id] = role;
    if (remaining[id]! <= 0) delete remaining[id];

    // Sparse permissions
    if (rnd() < 0.10) {
      const grantCount = 1 + Math.floor(rnd() * 3);
      const grants: Record<Subject, PermissionTier> = {};
      for (let g = 0; g < grantCount; g++) {
        const subj = SUBJECTS_POOL[Math.floor(rnd() * SUBJECTS_POOL.length)]!;
        const tier: PermissionTier =
          rnd() < 0.1 ? 'admin' : rnd() < 0.6 ? 'write' : 'read';
        grants[subj] = tier;
      }
      permissions[id] = grants;
    }
  }

  return { nodes, edges, permissions };
}

// ---------------------------------------------------------------------------
// Mutations (pure — return new state)
// ---------------------------------------------------------------------------

export function cloneState(s: DagTreeState): DagTreeState {
  return JSON.parse(JSON.stringify(s)) as DagTreeState;
}

/** Add a single leaf node + edge under a randomly chosen non-leaf parent. */
export function mutateAddLeaf(state: DagTreeState, seed = 42): Mutation {
  const rnd = rngFrom(seed);
  const after = cloneState(state);
  // Pick a parent that exists
  const parents = Object.keys(after.nodes);
  const parent = parents[Math.floor(rnd() * parents.length)]!;
  const newId = `n${Object.keys(after.nodes).length}_new`;
  after.nodes[newId] = {
    slug: `node-${newId}`,
    label: `Added ${newId}`,
    deleted: false,
  };
  after.edges[`${parent}:${newId}`] = true;
  return {
    kind: 'add-leaf',
    description: `add leaf ${newId} under ${parent}`,
    before: state,
    after,
  };
}

/** Rename a single node's `label` (no structural change). */
export function mutateRenameLabel(state: DagTreeState, seed = 42): Mutation {
  const rnd = rngFrom(seed);
  const after = cloneState(state);
  const ids = Object.keys(after.nodes);
  const target = ids[Math.floor(rnd() * ids.length)]!;
  after.nodes[target]!.label = `Renamed ${target}`;
  return {
    kind: 'rename-label',
    description: `rename label of ${target}`,
    before: state,
    after,
  };
}

/** Move a single node by removing its incoming edge and adding a new one. */
export function mutateMoveSingle(state: DagTreeState, seed = 42): Mutation {
  const rnd = rngFrom(seed);
  const after = cloneState(state);
  // Find a non-root node (has an incoming edge)
  const incomingByChild: Record<string, string> = {};
  for (const e of Object.keys(after.edges)) {
    const [p, c] = e.split(':') as [string, string];
    incomingByChild[c] = p;
  }
  const movableIds = Object.keys(incomingByChild);
  const target = movableIds[Math.floor(rnd() * movableIds.length)]!;
  const oldParent = incomingByChild[target]!;
  // Pick a different parent
  const candidates = Object.keys(after.nodes).filter(
    (id) => id !== target && id !== oldParent,
  );
  if (candidates.length === 0) {
    return { kind: 'move-single', description: 'no-op', before: state, after };
  }
  const newParent = candidates[Math.floor(rnd() * candidates.length)]!;
  delete after.edges[`${oldParent}:${target}`];
  after.edges[`${newParent}:${target}`] = true;
  return {
    kind: 'move-single',
    description: `move ${target} from ${oldParent} to ${newParent}`,
    before: state,
    after,
  };
}

/**
 * Move a subtree of ~50 nodes: change one edge whose subtree-size is closest
 * to 50. The subtree itself doesn't move — only the parent pointer flips —
 * which is the whole reason normalized edges win this mutation.
 */
export function mutateMoveSubtree50(state: DagTreeState, seed = 42): Mutation {
  const rnd = rngFrom(seed);
  const after = cloneState(state);
  // Build child index
  const childrenByParent: Record<string, string[]> = {};
  for (const e of Object.keys(after.edges)) {
    const [p, c] = e.split(':') as [string, string];
    (childrenByParent[p] ??= []).push(c);
  }
  // Compute subtree sizes (no-cycle DAG, but to be safe walk with seen)
  const subtreeSize = (root: string): number => {
    const seen = new Set<string>();
    const stack = [root];
    let size = 0;
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      size++;
      for (const c of childrenByParent[n] ?? []) stack.push(c);
    }
    return size;
  };
  // Find an edge whose child has subtree size closest to 50
  let bestEdge: string | null = null;
  let bestDiff = Infinity;
  for (const e of Object.keys(after.edges)) {
    const child = e.split(':')[1]!;
    const sz = subtreeSize(child);
    const d = Math.abs(sz - 50);
    if (d < bestDiff) {
      bestDiff = d;
      bestEdge = e;
    }
  }
  if (!bestEdge) {
    return { kind: 'move-subtree-50', description: 'no-op', before: state, after };
  }
  const [oldParent, child] = bestEdge.split(':') as [string, string];
  // Pick a new parent not in the subtree
  const subtreeSet = new Set<string>();
  {
    const stack = [child];
    while (stack.length) {
      const n = stack.pop()!;
      if (subtreeSet.has(n)) continue;
      subtreeSet.add(n);
      for (const c of childrenByParent[n] ?? []) stack.push(c);
    }
  }
  const candidates = Object.keys(after.nodes).filter(
    (id) => !subtreeSet.has(id) && id !== oldParent,
  );
  if (candidates.length === 0) {
    return { kind: 'move-subtree-50', description: 'no-op', before: state, after };
  }
  const newParent = candidates[Math.floor(rnd() * candidates.length)]!;
  delete after.edges[bestEdge];
  after.edges[`${newParent}:${child}`] = true;
  return {
    kind: 'move-subtree-50',
    description: `move subtree rooted at ${child} (size~${subtreeSize(child)}) from ${oldParent} to ${newParent}`,
    before: state,
    after,
  };
}

/** Grant a single new permission on a single node — exercises nested-object diff. */
export function mutateGrantPermission(state: DagTreeState, seed = 42): Mutation {
  const rnd = rngFrom(seed);
  const after = cloneState(state);
  const ids = Object.keys(after.nodes);
  const target = ids[Math.floor(rnd() * ids.length)]!;
  const subj = SUBJECTS_POOL[Math.floor(rnd() * SUBJECTS_POOL.length)]!;
  (after.permissions[target] ??= {})[subj] = 'admin';
  return {
    kind: 'grant-permission',
    description: `grant admin to ${subj} on ${target}`,
    before: state,
    after,
  };
}

export const MUTATIONS: ReadonlyArray<
  (state: DagTreeState, seed?: number) => Mutation
> = [
  mutateAddLeaf,
  mutateRenameLabel,
  mutateMoveSingle,
  mutateMoveSubtree50,
  mutateGrantPermission,
];

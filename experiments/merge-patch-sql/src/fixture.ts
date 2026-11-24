/**
 * A synthetic org tree in the shape `#buildState` in `packages/resources/src/org-tree.ts` returns,
 * encoded with the real `@lumenize/structured-clone`, plus the mutations the experiment patches.
 *
 * Shape: `{ nodes: Map<nodeId, {slug, label, deleted}>, edges: Set<"parent:child">,
 * permissions: Map<nodeId, Map<sub, tier>> }`. nodeIds and subs are UUIDs, as in the product, so
 * the encoded size per node is what a real tree's would be (about 200 bytes at 10,000 nodes).
 *
 * Seeded, so every object built for one (n, mutation) holds byte-identical text.
 */
import { stringify } from '@lumenize/structured-clone';

export type PermissionTier = 'admin' | 'write' | 'read';

export interface OrgTreeNodeData {
  slug: string;
  label: string;
  deleted: boolean;
}

export interface OrgTreeState {
  nodes: Map<string, OrgTreeNodeData>;
  edges: Set<string>;
  permissions: Map<string, Map<string, PermissionTier>>;
}

export const MUTATIONS = ['move', 'rename', 'add', 'relabel-1pct', 'relabel-10pct', 'relabel-100pct'] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** mulberry32: small, fast and reproducible. */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(rnd: () => number): string {
  const hex = (len: number) => {
    let out = '';
    for (let i = 0; i < len; i++) out += Math.floor(rnd() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rnd() * 4)]}${hex(3)}-${hex(12)}`;
}

const ADJECTIVES = ['Northern', 'Central', 'Applied', 'Global', 'Customer', 'Platform', 'Field', 'Strategic',
  'Regional', 'Product', 'Revenue', 'Partner', 'Core', 'Growth', 'Digital', 'Clinical'];
const NOUNS = ['Operations', 'Engineering', 'Research', 'Sales', 'Support', 'Design', 'Finance', 'Marketing',
  'Security', 'Analytics', 'Logistics', 'Quality', 'Training', 'Compliance', 'Success', 'Infrastructure'];
const TIERS: PermissionTier[] = ['admin', 'write', 'read'];

function labelFrom(rnd: () => number, i: number): string {
  return `${ADJECTIVES[Math.floor(rnd() * ADJECTIVES.length)]} ${NOUNS[Math.floor(rnd() * NOUNS.length)]} ${i}`;
}

const slugOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * A random recursive tree of n nodes (each node's parent drawn uniformly from the nodes before
 * it, so depth grows like ln n), about 2% extra edges making it a DAG, and grants on about 10% of
 * nodes from a pool of 50 subs.
 */
export function buildOrgTree(n: number, seed = 1): OrgTreeState {
  const rnd = rngFrom(seed);
  const ids: string[] = [];
  const nodes = new Map<string, OrgTreeNodeData>();
  const edges = new Set<string>();
  const permissions = new Map<string, Map<string, PermissionTier>>();
  const subs = Array.from({ length: 50 }, () => uuidFrom(rnd));
  for (let i = 0; i < n; i++) {
    const id = uuidFrom(rnd);
    ids.push(id);
    const label = i === 0 ? 'Root' : labelFrom(rnd, i);
    nodes.set(id, { slug: slugOf(label), label, deleted: false });
    if (i > 0) edges.add(`${ids[Math.floor(rnd() * i)]}:${id}`);
    if (i > 1 && rnd() < 0.02) edges.add(`${ids[Math.floor(rnd() * i)]}:${id}`);
    if (rnd() < 0.1) {
      const grants = new Map<string, PermissionTier>();
      const count = 1 + Math.floor(rnd() * 3);
      for (let g = 0; g < count; g++) grants.set(subs[Math.floor(rnd() * subs.length)], TIERS[Math.floor(rnd() * 3)]);
      permissions.set(id, grants);
    }
  }
  return { nodes, edges, permissions };
}

/** `before` changed by one mutation, on a deep copy. */
export function mutate(before: OrgTreeState, mutation: Mutation, seed = 2): OrgTreeState {
  const rnd = rngFrom(seed);
  const after = structuredClone(before);
  const ids = [...after.nodes.keys()];
  const pick = () => ids[1 + Math.floor(rnd() * (ids.length - 1))];
  const relabel = (fraction: number) => {
    const count = Math.max(1, Math.round(ids.length * fraction));
    const chosen = fraction >= 1 ? ids : [...new Set(Array.from({ length: count * 2 }, pick))].slice(0, count);
    for (const id of chosen) {
      const node = after.nodes.get(id)!;
      node.label = `${node.label} (renamed)`;
    }
  };
  switch (mutation) {
    case 'move': {
      // A node with exactly one parent moves under a node outside its own subtree.
      const parentsOf = new Map<string, string[]>();
      const childrenOf = new Map<string, string[]>();
      for (const edge of after.edges) {
        const [p, c] = edge.split(':');
        parentsOf.set(c, [...(parentsOf.get(c) ?? []), p]);
        childrenOf.set(p, [...(childrenOf.get(p) ?? []), c]);
      }
      let child = pick();
      while ((parentsOf.get(child) ?? []).length !== 1) child = pick();
      const subtree = new Set<string>([child]);
      for (const stack = [child]; stack.length;) {
        for (const c of childrenOf.get(stack.pop()!) ?? []) if (!subtree.has(c)) subtree.add(c), stack.push(c);
      }
      const oldParent = parentsOf.get(child)![0];
      let newParent = ids[Math.floor(rnd() * ids.length)];
      while (subtree.has(newParent) || newParent === oldParent) newParent = ids[Math.floor(rnd() * ids.length)];
      after.edges.delete(`${oldParent}:${child}`);
      after.edges.add(`${newParent}:${child}`);
      break;
    }
    case 'rename':
      relabel(1 / ids.length);
      break;
    case 'add': {
      const id = uuidFrom(rnd);
      after.nodes.set(id, { slug: 'new-team', label: 'New Team', deleted: false });
      after.edges.add(`${ids[Math.floor(rnd() * ids.length)]}:${id}`);
      break;
    }
    case 'relabel-1pct':
      relabel(0.01);
      break;
    case 'relabel-10pct':
      relabel(0.1);
      break;
    case 'relabel-100pct':
      relabel(1);
      break;
  }
  return after;
}

/** The stored text of `before` and `after`: what `Snapshots.value` would hold for each. */
export function fixtureTexts(n: number, mutation: Mutation): { before: string; after: string } {
  const before = buildOrgTree(n);
  return { before: stringify(before), after: stringify(mutate(before, mutation)) };
}

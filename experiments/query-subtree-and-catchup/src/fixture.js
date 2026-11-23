/**
 * The data every object of this experiment holds, as a pure function of an index, so the Worker
 * that seeds it and the Node driver that queries it agree without talking.
 *
 * - **The tree** has 4,111 nodes: a root, 10 children, 10 under each (100), 10 under each (1,000)
 *   and 3 under each of those (3,000). A subtree is therefore 1, 4, 41, 411 or 4,111 nodes. Twenty
 *   level-3 nodes have a second parent, so the tree is a DAG, as an orgTree is.
 * - **Write `i`** happens at moment `BASE + i` ms, one moment per write, as the mint puts each
 *   transaction 1 ms past the host's latest. Every fourth write creates resource `i / 4`, and the
 *   rest update a resource picked at random among those that exist, so `WRITES` writes leave
 *   `WRITES / 4` resources with about four versions each.
 * - **Resource `r`** has a type by `r % 10` (Deal 40%, Contact 30%, Task 20%, Note 10%) and sits
 *   at one node, picked at random over the whole tree and never moved.
 */

export const END_OF_TIME = '9999-01-01T00:00:00.000Z';
export const WRITES = 120_000;
export const BASE_MS = Date.parse('2026-11-01T00:00:00.000Z');
export const STAGES = ['open', 'qualified', 'proposal', 'won', 'lost'];
export const OWNERS = 300;
export const COMPANIES = 500;

/** A 32-bit hash of two integers (murmur3's finalizer over a mix of both). */
export function hash(a, b = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const hex8 = (n) => n.toString(16).padStart(8, '0');
/** A UUID-shaped id, random-looking and fixed for (kind, n). */
export function uuid(kind, n) {
  const s = hex8(hash(n, kind)) + hex8(hash(n, kind + 101)) + hex8(hash(n, kind + 202)) + hex8(hash(n, kind + 303));
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

export const momentOf = (i) => new Date(BASE_MS + i).toISOString();

// ─── The tree ───────────────────────────────────────────────────────

export const NODE_COUNT = 1 + 10 + 100 + 1000 + 3000;
export const nodeId = (n) => uuid(1, n);

/** First node index of each level, and the level's fan-out from the one above. */
const LEVELS = [{ start: 0, size: 1 }, { start: 1, size: 10 }, { start: 11, size: 100 }, { start: 111, size: 1000 }, { start: 1111, size: 3000 }];

/** Every edge, as [parent index, child index]. */
export function edges() {
  const out = [];
  for (let l = 1; l < LEVELS.length; l++) {
    const fan = LEVELS[l].size / LEVELS[l - 1].size;
    for (let k = 0; k < LEVELS[l].size; k++) out.push([LEVELS[l - 1].start + Math.floor(k / fan), LEVELS[l].start + k]);
  }
  // Diamonds: twenty level-3 nodes also sit under another level-2 node.
  for (let d = 0; d < 20; d++) out.push([11 + ((d * 7 + 50) % 100), 111 + d * 37]);
  return out;
}

/** The node indexes at `root` or beneath it, by every path, each once. */
export function subtree(root) {
  const children = new Map();
  for (const [p, c] of edges()) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) for (const c of children.get(stack.pop()) ?? []) if (!seen.has(c)) seen.add(c), stack.push(c);
  return [...seen];
}

/** The subtrees the measurements name: a leaf, and one node of each level above it. */
export const SUBTREES = { n1: 1111 + 1234, n4: 111 + 500, n41: 11 + 42, n411: 1 + 6, n4111: 0 };

// ─── Resources and writes ───────────────────────────────────────────

export const TYPES = ['Deal', 'Contact', 'Task', 'Note'];
export const typeOf = (r) => { const m = r % 10; return m < 4 ? 'Deal' : m < 7 ? 'Contact' : m < 9 ? 'Task' : 'Note'; };
export const resourceId = (r) => uuid(2, r);
export const nodeOf = (r) => hash(r, 7) % NODE_COUNT;
export const ownerOf = (r) => `u${String(hash(r, 9) % OWNERS).padStart(4, '0')}`;

/** Which resource write `i` touches, and whether it creates it. */
export function writeOf(i) {
  if (i % 4 === 0) return { r: i / 4, create: true };
  return { r: hash(i, 3) % (Math.floor(i / 4) + 1), create: false };
}

const FILLER = 'Spoke with the buyer about renewal terms and the rollout plan for the next two quarters. ';

/** The stored text of resource `r` as write `i` leaves it: structured-clone's JSON, a Date wrapped. */
export function valueOf(r, i) {
  const type = typeOf(r);
  const h = hash(r, i);
  const common = { notes: FILLER.repeat(1 + (h % 4)).trimEnd(), updated: { $type: 'date', iso: momentOf(i) } };
  if (type === 'Deal') return JSON.stringify({ title: `Deal ${r}`, stage: STAGES[h % 5], owner: ownerOf(r), amount: 500 + (h % 20000), ...common });
  if (type === 'Contact') return JSON.stringify({ name: `Contact ${r}`, company: `c${hash(r, 11) % COMPANIES}`, email: `p${r}@example.com`, ...common });
  if (type === 'Task') return JSON.stringify({ title: `Task ${r}`, done: h % 2 === 0, assignee: ownerOf(r), ...common });
  return JSON.stringify({ title: `Note ${r}`, body: FILLER.repeat(2 + (h % 6)).trimEnd(), ...common });
}

/** The claims a write is recorded under (ADR-016), about the size of a real projection. */
export function claimsOf(r) {
  const sub = uuid(3, hash(r, 13) % 200);
  return JSON.stringify({ sub, profileId: uuid(4, hash(r, 13) % 200), aud: 'acme.crm.tenant1', access: { authScope: 'acme.crm.tenant1', admin: false }, act: null });
}

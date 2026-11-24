/**
 * The data every table of this experiment holds, as a pure function of an index, so the Worker
 * that seeds it and the Node driver that queries it agree without talking.
 *
 * - **Resource `r`** has a type by `r % 10`: Deal 50%, Contact 30%, Task 20%.
 * - **Write `i`** happens at moment `BASE + i` ms, one moment per write. The first `RESOURCES`
 *   writes create every resource, and each later one updates a resource picked at random. An
 *   object of depth D takes `RESOURCES * D` writes, so each resource has about D versions.
 * - **A Deal's `stage`** is one of five, picked anew by every write, so a filter on one stage
 *   matches about a fifth of the type at any moment, and a fifth of every version ever written.
 */

export const END_OF_TIME = '9999-01-01T00:00:00.000Z';
export const RESOURCES = 4000;
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

export const typeOf = (r) => { const m = r % 10; return m < 5 ? 'Deal' : m < 8 ? 'Contact' : 'Task'; };
export const resourceId = (r) => uuid(2, r);
export const nodeId = (r) => uuid(1, hash(r, 7) % 400);
export const ownerOf = (r) => `u${String(hash(r, 9) % OWNERS).padStart(4, '0')}`;

/** Which resource write `i` touches, and whether it creates it. */
export function writeOf(i) {
  if (i < RESOURCES) return { r: i, create: true };
  return { r: hash(i, 3) % RESOURCES, create: false };
}

const FILLER = 'Spoke with the buyer about renewal terms and the rollout plan for the next two quarters. ';

/** The stored text of resource `r` as write `i` leaves it: structured-clone's JSON, a Date wrapped. */
export function valueOf(r, i) {
  const type = typeOf(r);
  const h = hash(r, i);
  const common = { notes: FILLER.repeat(1 + (h % 2)).trimEnd(), updated: { $type: 'date', iso: momentOf(i) } };
  if (type === 'Deal') return JSON.stringify({ title: `Deal ${r}`, stage: STAGES[h % 5], owner: ownerOf(r), amount: 500 + (h % 20000), ...common });
  if (type === 'Contact') return JSON.stringify({ name: `Contact ${r}`, company: `c${hash(r, 11) % COMPANIES}`, email: `p${r}@example.com`, ...common });
  return JSON.stringify({ title: `Task ${r}`, done: h % 2 === 0, assignee: ownerOf(r), ...common });
}

/** The claims a write is recorded under (ADR-016), about the size of a real projection. */
export function claimsOf(r) {
  const sub = uuid(3, hash(r, 13) % 200);
  return JSON.stringify({ sub, profileId: uuid(4, hash(r, 13) % 200), aud: 'acme.crm.tenant1', access: { authScope: 'acme.crm.tenant1', admin: false }, act: null });
}

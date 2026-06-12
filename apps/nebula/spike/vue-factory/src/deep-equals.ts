/**
 * Structural deep equality. Handles plain objects, arrays, primitives,
 * Dates, null — and cyclic/aliased graphs (ADR-002: the full structured-clone
 * value space includes cycles; without the pair-memo, comparing two
 * structurally-equal cyclic values recurses forever). Not intended for Maps,
 * Sets, TypedArrays, or class instances — collection mutations dedup
 * semantically in the factory's mutator interception instead (see
 * create-nebula-client.ts), and a Map/Set here compares by reference only
 * (never a false "equal", only a skipped dedup). v3 port note: the production
 * helper should cover the full structured-clone space.
 *
 * Copied from `@lumenize/state`'s helper (which we're deleting in 5.3.7),
 * plus the cycle guard. Reproduced here so the spike doesn't depend on
 * `@lumenize/state`.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  return deepEqualsInner(a, b, new WeakMap());
}

function deepEqualsInner(a: unknown, b: unknown, seen: WeakMap<object, WeakSet<object>>): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();

  // Cycle/alias guard: if this exact pair is already on the comparison stack,
  // assume equal — a difference elsewhere in the graph will still be found.
  let pairs = seen.get(a);
  if (pairs?.has(b)) return true;
  if (!pairs) {
    pairs = new WeakSet();
    seen.set(a, pairs);
  }
  pairs.add(b);

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualsInner(a[i], b[i], seen)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // Maps/Sets compare by reference only (handled above by `a === b`).
  if (a instanceof Map || a instanceof Set || b instanceof Map || b instanceof Set) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualsInner((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen)) return false;
  }
  return true;
}

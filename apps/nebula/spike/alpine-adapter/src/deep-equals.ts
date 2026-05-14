/**
 * Structural deep equality. Handles plain objects, arrays, primitives,
 * Dates, and null. Not intended for Maps, Sets, TypedArrays, or class instances —
 * Lumenize state values are plain JSON-shaped data.
 *
 * Copied verbatim semantics from `@lumenize/state`'s helper (which we're deleting
 * in 5.3.7). Reproduced here so the spike doesn't depend on `@lumenize/state`.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

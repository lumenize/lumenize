/**
 * RFC 7396 JSON Merge Patch — hand-rolled implementation.
 *
 * Hand-rolled (no library dep) because:
 *  - Apply is ~30 LOC; diff is ~50 LOC; surface area is tiny.
 *  - `@lumenize/structured-clone` aggressively minimizes its dependency
 *    footprint — every consumer inherits our deps.
 *  - Behavior is fully predictable; no surprises from upstream maintenance.
 *
 * Conformance: verified against all 15 test vectors from RFC 7396 Appendix A.
 * See `test/merge-patch-rfc7396.test.ts` for the canonical spec compliance
 * suite (vectors copied verbatim from the public RFC). Round-trip
 * (`apply(before, diff(before, after)) === after`) is also covered there.
 *
 * Contract (RFC 7396):
 *  - `null` in a patch means "delete this key from target".
 *  - Arrays are atomic — any change replaces the whole array.
 *  - Plain objects are merged recursively.
 *  - Other primitives are replaced.
 *
 * Sentinel: we represent the "no-op patch" as `undefined` (return value of
 * `diff(a, a)` for identical inputs) rather than `{}`, since `{}` could be
 * a legitimate full replacement of a target.
 *
 * Phase 1 (experiments/structured-clone-object-format) showed this is the
 * right diff primitive for the new wire format (W4: nested JSON + sparse
 * meta sidecar). See experiments/structured-clone-object-format/RESULTS.md.
 *
 * @packageDocumentation
 */

/** JSON-compatible value type. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/** RFC 7396 merge patch. `undefined` represents the no-op patch. */
export type MergePatch = JsonValue | undefined;

type JsonObject = { [k: string]: JsonValue };

/**
 * Apply an RFC 7396 merge patch to a target. Returns the new value (does
 * not mutate `target`).
 *
 * @param target - The value to patch.
 * @param patch - The merge patch. `undefined` returns a deep clone of `target`.
 * @returns The patched value.
 */
export function applyMergePatch(target: JsonValue, patch: MergePatch): JsonValue {
  if (patch === undefined) return deepClone(target);
  if (!isPlainObject(patch)) return deepClone(patch);
  const base: JsonObject = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const pv = (patch as JsonObject)[key];
    if (pv === null) {
      delete base[key];
    } else if (isPlainObject(pv)) {
      base[key] = applyMergePatch(base[key] ?? {}, pv) as JsonValue;
    } else {
      base[key] = deepClone(pv);
    }
  }
  return base;
}

/**
 * Compute an RFC 7396 merge patch that, when applied to `before`, produces
 * `after`. Returns `undefined` for identical inputs (no-op patch).
 *
 * Arrays are atomic — any change at any depth produces a wholesale array
 * replacement. Plain objects are diffed recursively. Removed keys appear
 * as `null` in the patch.
 */
export function diff(before: JsonValue, after: JsonValue): MergePatch {
  if (jsonEqual(before, after)) return undefined;
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return deepClone(after);
  }
  const patch: JsonObject = {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) patch[key] = null;
  }
  for (const key of Object.keys(after)) {
    const bv = before[key];
    const av = after[key];
    if (bv === undefined) {
      patch[key] = deepClone(av);
      continue;
    }
    if (jsonEqual(bv, av)) continue;
    if (isPlainObject(bv) && isPlainObject(av)) {
      const sub = diff(bv, av);
      patch[key] = sub as JsonValue;
    } else {
      patch[key] = deepClone(av);
    }
  }
  return patch;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i] as JsonValue, b[i] as JsonValue)) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in (b as JsonObject))) return false;
      if (!jsonEqual((a as JsonObject)[k] as JsonValue, (b as JsonObject)[k] as JsonValue)) return false;
    }
    return true;
  }
  return false;
}

function deepClone<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x as JsonValue)) as unknown as T;
  const out: JsonObject = {};
  for (const k of Object.keys(v)) {
    out[k] = deepClone((v as JsonObject)[k] as JsonValue);
  }
  return out as unknown as T;
}

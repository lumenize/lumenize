/**
 * Validate a state path string.
 *
 * Empty strings, whitespace, and paths containing consecutive dots (`..`) are rejected.
 * The framework only constructs paths from `resourceType` / `resourceId` (which are
 * restricted to `[A-Za-z0-9_-]`), so `..` and other malformed forms only show up
 * from user code; reject them at the boundary.
 */
export const isValidPath = (path: unknown): path is string =>
  typeof path === 'string' && path.trim().length > 0 && !path.includes('..');

/**
 * Split a path on `.`, dropping empty segments.
 *
 * `getPathParts('a.b.c') === ['a', 'b', 'c']`.
 */
export const getPathParts = (path: string): string[] => path.split('.').filter(Boolean);

/**
 * Structural equality for values stored at state paths.
 *
 * Handles primitives, plain objects, arrays, `Map`, `Set`, `Date`, `RegExp`,
 * typed arrays, `ArrayBuffer`, and cyclic references. Used by the notify
 * pipeline to skip no-op writes (and to gate per-path subscriber re-fires
 * during hierarchical fanout).
 *
 * Not a full structured-clone equality — but covers every type Lumenize
 * stores at a path.
 */
export const deepEquals = (a: unknown, b: unknown): boolean => {
  return equalsWithSeen(a, b, new WeakMap());
};

const equalsWithSeen = (a: unknown, b: unknown, seen: WeakMap<object, object>): boolean => {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  // Cycle guard: if we've seen `a` before, it must have been paired with `b`.
  const prior = seen.get(a as object);
  if (prior !== undefined) return prior === b;
  seen.set(a as object, b as object);

  // Distinguish types by their prototype/tag rather than just shape.
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;

  if (a instanceof Map) {
    const bMap = b as Map<unknown, unknown>;
    if (a.size !== bMap.size) return false;
    for (const [k, v] of a) {
      if (!bMap.has(k)) return false;
      if (!equalsWithSeen(v, bMap.get(k), seen)) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    const bSet = b as Set<unknown>;
    if (a.size !== bSet.size) return false;
    for (const v of a) {
      if (!bSet.has(v)) return false;
    }
    return true;
  }

  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    const aArr = a as unknown as ArrayLike<number> & { length: number };
    const bArr = b as unknown as ArrayLike<number> & { length: number };
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (aArr[i] !== bArr[i]) return false;
    }
    return true;
  }

  if (a instanceof ArrayBuffer) {
    const bBuf = b as ArrayBuffer;
    if (a.byteLength !== bBuf.byteLength) return false;
    const aView = new Uint8Array(a);
    const bView = new Uint8Array(bBuf);
    for (let i = 0; i < aView.length; i++) {
      if (aView[i] !== bView[i]) return false;
    }
    return true;
  }

  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalsWithSeen(a[i], bArr[i], seen)) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keysA = Object.keys(aObj);
  const keysB = Object.keys(bObj);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!equalsWithSeen(aObj[key], bObj[key], seen)) return false;
  }
  return true;
};

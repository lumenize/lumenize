/**
 * RFC 7396 JSON Merge Patch over the codec's encoding — hand-rolled, no deps.
 *
 * Conformance: verified against all 15 test vectors from RFC 7396 Appendix A
 * (`test/merge-patch-rfc7396.test.ts`).
 *
 * Contract (RFC 7396):
 *  - `null` in a patch means "delete this key from target".
 *  - Arrays are atomic — any change replaces the whole array.
 *  - Plain objects are merged recursively.
 *  - Other primitives are replaced.
 *
 * A patch can move no key, so `diff` keeps order only where the codec does:
 * a Map's, Set's or object-form array's members, through the `object` member
 * of its tag. A plain object's key order is not kept.
 *
 * Every key is data: reads are own-property reads and writes define own
 * properties, so a key named `__proto__` or `constructor` patches like any
 * other and touches no prototype.
 *
 * @packageDocumentation
 */

import { setOwn } from './preprocess';

/** JSON-compatible value type. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/** One RFC 7396 merge patch. */
export type MergePatch = JsonValue;

type JsonObject = { [k: string]: JsonValue };

/** `before` and `after` are the same encoding, every kept order included. */
export interface DiffSame {
  kind: 'same';
}

/**
 * Applying `patches` to `before` in order gives `after`, with
 * `applyMergePatch` or with SQLite's `json_patch` nested once per patch.
 * There are two when a Map, Set or object-form array under a plain object
 * changed order: the first deletes it and the second sets it again.
 */
export interface DiffPatches {
  kind: 'patches';
  patches: MergePatch[];
}

/**
 * No patch keeps `after`'s order: a Map, Set or object-form array at the
 * root, or inside a Map, changed order. Send `after` whole.
 */
export interface DiffFull {
  kind: 'full';
}

export type Diff = DiffSame | DiffPatches | DiffFull;

/**
 * Applies one RFC 7396 merge patch to a target, without mutating it.
 *
 * @throws TypeError for a value JSON cannot hold: an object whose prototype is
 *   neither `Object.prototype` nor `null`, such as a decoded `Date` or `Map`,
 *   or a function, bigint, symbol or `undefined`.
 */
export function applyMergePatch(target: JsonValue, patch: MergePatch): JsonValue {
  if (!isJsonObject(patch)) return deepClone(patch);
  const base: JsonObject = isJsonObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === null) {
      delete base[key];
    } else if (isJsonObject(pv)) {
      setOwn(base, key, applyMergePatch(Object.hasOwn(base, key) ? base[key] : {}, pv));
    } else {
      setOwn(base, key, deepClone(pv));
    }
  }
  return base;
}

/**
 * The patches that turn one encoding into another.
 *
 * Inside a Map's, Set's or object-form array's members, a patch keeps
 * `before`'s surviving members in place and adds new ones last. When `after`
 * orders them any other way, the collection is set again whole: under a plain
 * object by two patches, and at the root or inside a Map by `{ kind: 'full' }`.
 *
 * @throws TypeError for a value JSON cannot hold: an object whose prototype is
 *   neither `Object.prototype` nor `null`, such as a decoded `Date` or `Map`,
 *   or a function, bigint, symbol or `undefined`.
 */
export function diff(before: JsonValue, after: JsonValue): Diff {
  if (jsonEqual(before, after, false)) return { kind: 'same' };
  const step = diffAt(before, after);
  if (step === FULL || step === REORDERED) return { kind: 'full' };
  return { kind: 'patches', patches: step.second === undefined ? [step.first] : [step.first, step.second] };
}

// The first patch's value for one position, and the second patch's, which
// sets again each collection the first deleted.
interface Step {
  first: JsonValue;
  second: JsonObject | undefined;
}

// A collection at this position changed order, so its parent decides: a
// plain object deletes and sets it again, anything else answers FULL.
const REORDERED = Symbol('reordered');
const FULL = Symbol('full');

// The patch for one position whose values differ.
function diffAt(b: JsonValue, a: JsonValue): Step | typeof REORDERED | typeof FULL {
  if (!isJsonObject(b) || !isJsonObject(a)) return { first: deepClone(a), second: undefined };
  if (isObjectForm(a) && orderChanged(b, a)) return REORDERED;
  return diffObjects(b, a, false);
}

// `members` is true for a collection's `object`, whose keys keep their order.
function diffObjects(b: JsonObject, a: JsonObject, members: boolean): Step | typeof FULL {
  const first: JsonObject = {};
  let second: JsonObject | undefined;
  for (const key of Object.keys(b)) {
    if (!Object.hasOwn(a, key)) setOwn(first, key, null);
  }
  for (const key of Object.keys(a)) {
    const av = a[key];
    if (!Object.hasOwn(b, key)) {
      setOwn(first, key, deepClone(av));
      continue;
    }
    const bv = b[key];
    const holdsMembers = key === 'object' && isObjectForm(a);
    if (jsonEqual(bv, av, holdsMembers)) continue;
    const sub = holdsMembers && isJsonObject(bv) ? diffObjects(bv, av as JsonObject, true) : diffAt(bv, av);
    if (sub === FULL) return FULL;
    if (sub === REORDERED) {
      if (members) return FULL;
      setOwn(first, key, null);
      setOwn((second ??= {}), key, deepClone(av));
      continue;
    }
    setOwn(first, key, sub.first);
    if (sub.second !== undefined) setOwn((second ??= {}), key, sub.second);
  }
  return { first, second };
}

// Whether applying a patch would order `a`'s members differently from `a`:
// it keeps `b`'s surviving members in place and adds new ones last.
function orderChanged(b: JsonObject, a: JsonObject): boolean {
  const after = a.object as JsonObject;
  const before = Object.hasOwn(b, 'object') && isJsonObject(b.object) ? b.object : {};
  const kept = Object.keys(before).filter((k) => Object.hasOwn(after, k));
  const added = Object.keys(after).filter((k) => !Object.hasOwn(before, k));
  const order = Object.keys(after);
  return [...kept, ...added].some((k, i) => k !== order[i]);
}

// A Map's, Set's or array's object form: `{ $type, object }`.
function isObjectForm(v: JsonObject): boolean {
  const type = Object.hasOwn(v, '$type') ? v.$type : undefined;
  return (type === 'map' || type === 'set' || type === 'array')
    && Object.hasOwn(v, 'object') && isJsonObject(v.object);
}

function isJsonObject(v: unknown): v is JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`Not JSON: an object whose prototype is ${proto?.constructor?.name ?? 'not Object.prototype'}`);
  }
  return true;
}

// Refuses a value JSON cannot hold: a function, bigint, symbol or undefined.
function checkScalar(v: unknown): void {
  const type = typeof v;
  if (type === 'function' || type === 'bigint' || type === 'symbol' || type === 'undefined') {
    throw new TypeError(`Not JSON: a ${type}`);
  }
}

// `ordered` is true for a collection's members, whose key order counts.
function jsonEqual(x: JsonValue, y: JsonValue, ordered: boolean): boolean {
  checkScalar(x);
  checkScalar(y);
  if (x === y) return true;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!jsonEqual(x[i], y[i], false)) return false;
    }
    return true;
  }
  if (!isJsonObject(x) || !isJsonObject(y)) return false;
  const xKeys = Object.keys(x);
  const yKeys = Object.keys(y);
  if (xKeys.length !== yKeys.length) return false;
  const holdsMembers = isObjectForm(x);
  for (let i = 0; i < xKeys.length; i++) {
    const k = xKeys[i];
    if (ordered ? yKeys[i] !== k : !Object.hasOwn(y, k)) return false;
    if (!jsonEqual(x[k], y[k], holdsMembers && k === 'object')) return false;
  }
  return true;
}

function deepClone<T extends JsonValue>(v: T): T {
  checkScalar(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as T;
  if (!isJsonObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v)) setOwn(out, k, deepClone(v[k]));
  return out as T;
}

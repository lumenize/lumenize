/**
 * Helpers for the merge-patch suites: encode two values, diff them, apply
 * the answer, and compare what decodes with every order a patch keeps.
 */

import { preprocess, postprocess, diff, applyMergePatch, type Diff, type JsonValue } from '../src/index.js';

/** Applies a `diff` answer to `before`; `full` is answered with `after`. */
export function applyDiff(before: JsonValue, answer: Diff, after: JsonValue): JsonValue {
  if (answer.kind === 'same') return before;
  if (answer.kind === 'full') return after;
  return answer.patches.reduce((target, patch) => applyMergePatch(target, patch), before);
}

/** Bytes the patches take as JSON; `Infinity` unless the answer is patches. */
export function patchBytes(answer: Diff): number {
  if (answer.kind !== 'patches') return Infinity;
  return answer.patches.reduce<number>((n, patch) => n + JSON.stringify(patch).length, 0);
}

/** Encodes both values and diffs them; `restore()` applies and decodes. */
export function patchThrough(beforeValue: unknown, afterValue: unknown) {
  const before = preprocess(beforeValue);
  const after = preprocess(afterValue);
  const answer = diff(before, after);
  return {
    before,
    after,
    answer,
    bytes: patchBytes(answer),
    restore: () => postprocess(applyDiff(before, answer, after)),
  };
}

/**
 * A comparable form of a decoded value that keeps every Map's, Set's and
 * array's order and ignores a plain object's, the one order a patch drops.
 * A second visit to an object is written as the index of its first.
 */
export function shape(value: unknown, seen = new Map<object, number>()): unknown {
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return ['seen', seen.get(value)];
  seen.set(value, seen.size);
  if (value instanceof Map) return ['Map', [...value].map(([k, v]) => [shape(k, seen), shape(v, seen)])];
  if (value instanceof Set) return ['Set', [...value].map((m) => shape(m, seen))];
  if (Array.isArray(value)) return ['Array', value.length, Object.keys(value).map((i) => [i, shape(value[Number(i)], seen)])];
  if (value instanceof Date) return ['Date', value.toISOString()];
  if (ArrayBuffer.isView(value)) {
    return [Object.prototype.toString.call(value), Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
  }
  const keys = Object.keys(value).sort();
  return ['Object', keys.map((k) => [k, shape(Object.getOwnPropertyDescriptor(value, k)!.value, seen)])];
}

/**
 * @lumenize/structured-clone
 *
 * Structured cloning to JSON, with cycles, shared objects and every special
 * type preserved, in an encoding an RFC 7396 merge patch addresses one change
 * at a time.
 *
 * The encoding:
 *   - An object, array, string, number or boolean is written as itself.
 *   - Every other type is an inline `{ $type, ...payload }` tag, and a user
 *     key starting with `$` gets one more `$`.
 *   - A Map or Set whose keys are all strings, or all numbers (marked
 *     `keyType: "number"`), is `{ $type, object }` with its keys in order, a
 *     key that starts with `$` or is an array index taking one more `$`. So
 *     is an array of distinct strings over 256 bytes; anything else keeps a
 *     list.
 *   - `null` and a sparse array's hole are tags, so no JSON `null` appears.
 *   - Binary is base64 of the view's own bytes.
 *   - An object reached a second time is `{ $ref: "#/…" }`, a JSON Reference
 *     to where it was first written.
 *
 * Supported types:
 *   - Primitives: string, number, boolean, null, undefined, bigint
 *   - Special numbers: NaN, Infinity, -Infinity, -0
 *   - Objects: Object, Array (holes included), Date, RegExp, Map, Set, Error
 *   - TypedArrays + ArrayBuffer + DataView
 *   - Web API: RequestSync, ResponseSync, Headers, URL
 *   - Cycles and shared objects, with identity, through `$ref` pointers
 *
 * Class instances arrive as plain objects, as with native structuredClone().
 * Any other object without an encoder (CryptoKey, Blob, streams, WeakMap, …)
 * throws a `DataCloneError` rather than arriving as an empty impostor.
 *
 * Inspired by:
 *   - SuperJSON (one nested JSON document rather than a flat table of objects)
 *   - Cap'n Web (inline-tagged special types)
 *   - @ungap/structured-clone (cycle detection algorithm)
 */

import { preprocess } from './preprocess';
import { postprocess } from './postprocess';

/**
 * Convert a value to a JSON string with full structured-clone semantics.
 *
 * Handles cycles, aliases, Date, RegExp, Map, Set, Error, BigInt, TypedArrays,
 * and synchronous Web API wrappers (RequestSync, ResponseSync).
 *
 * Convenience wrapper around `preprocess()` + `JSON.stringify()`.
 *
 * @param value - Any serializable value.
 * @throws TypeError if value contains symbols.
 * @throws DOMException named `DataCloneError` for an object with no encoder
 *   that isn't a plain object or class instance (CryptoKey, Blob, streams, …),
 *   naming its type and path.
 */
export function stringify(value: any): string {
  return JSON.stringify(preprocess(value));
}

/**
 * Restore a value from a JSON string. Inverse of `stringify()`.
 *
 * Convenience wrapper around `JSON.parse()` + `postprocess()`.
 */
export function parse(value: string): any {
  return postprocess(JSON.parse(value));
}

// Intermediate-format API
export { preprocess } from './preprocess';
export { postprocess } from './postprocess';

// RFC 7396 JSON Merge Patch over the encoding — hand-rolled, no deps.
export { applyMergePatch, diff } from './merge-patch';
export type { JsonValue, MergePatch, Diff, DiffSame, DiffPatches, DiffFull } from './merge-patch';

// Synchronous Request/Response wrappers
export { RequestSync } from './request-sync';
export { ResponseSync } from './response-sync';

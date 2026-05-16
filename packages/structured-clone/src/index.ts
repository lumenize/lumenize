/**
 * @lumenize/structured-clone
 *
 * Object-based $lmz format for structured cloning with full cycle / alias /
 * special-type preservation and RFC 7396 JSON Merge Patch support.
 *
 * Wire shape (W4):
 *   - `{ json, meta }` — `json` is the encoded document, mostly native JSON
 *     for cycle-free common-case data. `meta.aliases` holds shared/cyclic
 *     subgraphs when they exist.
 *   - Special types (Date, Map, Set, Error, RegExp, Headers, URL, etc.)
 *     are encoded as inline `{ $type, ...payload }` tags.
 *   - Patches over this shape are typically <100 bytes for single-field
 *     mutations on documents of 10k+ nodes; see
 *     `experiments/structured-clone-object-format/RESULTS.md` for the
 *     benchmark-driven rationale.
 *
 * Supported types:
 *   - Primitives: string, number, boolean, null, undefined, bigint
 *   - Special numbers: NaN, Infinity, -Infinity
 *   - Objects: Object, Array, Date, RegExp, Map, Set, Error
 *   - TypedArrays + ArrayBuffer + DataView
 *   - Web API: RequestSync, ResponseSync, Headers, URL
 *   - Cycles and aliases fully preserved via `meta.aliases`
 *
 * Inspired by:
 *   - SuperJSON (nested-document + meta sidecar shape)
 *   - Cap'n Web (inline-tagged special types)
 *   - @ungap/structured-clone (cycle detection algorithm)
 */

import { preprocess, type PreprocessOptions } from './preprocess';
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
 * @param options - Optional preprocessing options.
 * @returns JSON string in `{ json, meta }` form.
 * @throws TypeError if value contains symbols.
 */
export function stringify(value: any, options?: PreprocessOptions): string {
  return JSON.stringify(preprocess(value, options));
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
export { preprocess, TRANSFORM_SKIP } from './preprocess';
export { postprocess } from './postprocess';

// RFC 7396 JSON Merge Patch — primitives for per-mutation sync over the
// object-based wire format. Hand-rolled (~120 LOC, no deps).
export { applyMergePatch, diff } from './merge-patch';
export type { JsonValue, MergePatch } from './merge-patch';

// Synchronous Request/Response wrappers
export { RequestSync } from './request-sync';
export { ResponseSync } from './response-sync';

// Type exports
export type {
  LmzIntermediate,
  PreprocessTransform,
  PathElement,
  PreprocessOptions,
} from './preprocess';

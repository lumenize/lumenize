/**
 * @lumenize/structured-clone
 * 
 * Tuple-based $lmz format for structured cloning with cycle and alias support.
 * Combines Cap'n Web's human-readable tuple format with full cycle/alias preservation.
 * 
 * Supported types:
 * - Primitives: string, number, boolean, null, undefined, bigint
 * - Special numbers: NaN, Infinity, -Infinity  
 * - Objects: Object, Array, Date, RegExp, Map, Set, Error
 * - TypedArrays: Uint8Array, etc.
 * - Web API: Request, Response, Headers, URL
 * - Cycles and aliases fully preserved
 * 
 * Format: ["type", data] tuples with ["$lmz", index] references
 * 
 * Inspired by:
 * - Cap'n Web (tuple format): https://github.com/cloudflare/capnweb
 * - @ungap/structured-clone (cycle detection): https://github.com/ungap/structured-clone
 */

import { preprocess, type PreprocessOptions } from './preprocess';
import { postprocess } from './postprocess';

/**
 * Convert value to JSON string with full type support.
 * 
 * Handles cycles, aliases, Date, RegExp, Map, Set, Error, BigInt, TypedArrays.
 * Web API objects (Request, Response, Headers, URL) are serialized with full fidelity.
 * 
 * This is a convenience wrapper around `preprocess()` + `JSON.stringify()`.
 * 
 * Note: Async for Request/Response body reading.
 * 
 * @param value - Any serializable value
 * @param options - Optional preprocessing options including custom transform hooks
 * @returns JSON string in tuple $lmz format
 * @throws TypeError if value contains symbols
 * 
 * @example
 * ```typescript
 * const obj = { name: "John", age: 30 };
 * obj.self = obj;  // Cycle
 * 
 * const json = await stringify(obj);
 * const restored = parse(json);
 * console.log(restored.self === restored);  // true
 * ```
 */
export async function stringify(value: any, options?: PreprocessOptions): Promise<string> {
  return JSON.stringify(await preprocess(value, options));
}

/**
 * Restore value from JSON string.
 * 
 * Inverse of stringify(). Reconstructs all types including cycles and aliases.
 * 
 * This is a convenience wrapper around `JSON.parse()` + `postprocess()`.
 * 
 * All reconstruction operations are synchronous.
 * 
 * @param value - JSON string in tuple $lmz format
 * @returns Restored value with all types and references preserved
 * 
 * @example
 * ```typescript
 * const json = await stringify({ name: "Alice", tags: ["dev", "js"] });
 * const restored = parse(json);
 * console.log(restored.tags[0]);  // "dev"
 * ```
 */
export function parse(value: string): any {
  return postprocess(JSON.parse(value));
}

// Intermediate format API - see preprocess.ts and postprocess.ts for full JSDoc
export { preprocess, TRANSFORM_SKIP } from './preprocess';
export { postprocess } from './postprocess';

// Low-level encoding utilities - see web-api-encoding.ts for full JSDoc
export {
  encodeRequest,
  encodeResponse,
  decodeRequest,
  decodeResponse,
  encodeRequestSync,
  encodeResponseSync,
  decodeRequestSync,
  decodeResponseSync
} from './web-api-encoding';

// Synchronous Request/Response wrappers - see request-sync.ts and response-sync.ts for full JSDoc
export { RequestSync } from './request-sync';
export { ResponseSync } from './response-sync';

// Type exports
export type { LmzIntermediate, PreprocessOptions, PreprocessTransform, PreprocessContext, PathElement } from './preprocess';
export type { SerializableBody, RequestSyncInit } from './request-sync';
export type { SerializableBody as ResponseSerializableBody } from './response-sync';

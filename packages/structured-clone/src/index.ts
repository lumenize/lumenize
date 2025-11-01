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

import { preprocess } from './preprocess.js';
import { postprocess } from './postprocess.js';

/**
 * Convert value to JSON string with full type support.
 * 
 * Uses tuple-based $lmz format: ["type", data] for values, ["$lmz", index] for references.
 * Handles cycles, aliases, Date, RegExp, Map, Set, Error, BigInt, TypedArrays.
 * Web API objects (Request, Response, Headers, URL) are serialized with full fidelity.
 * 
 * This is a convenience wrapper around `preprocess()` + `JSON.stringify()`.
 * 
 * Performance: 75x faster serialization than previous indexed format.
 * 
 * Note: Async for Request/Response body reading.
 * 
 * @param value - Any serializable value
 * @returns JSON string in tuple $lmz format
 * @throws TypeError if value contains symbols
 * 
 * @example
 * ```typescript
 * const obj = { name: "John", age: 30 };
 * obj.self = obj;  // Cycle
 * 
 * const json = await stringify(obj);
 * const restored = await parse(json);
 * console.log(restored.self === restored);  // true
 * ```
 */
export async function stringify(value: any): Promise<string> {
  return JSON.stringify(await preprocess(value));
}

/**
 * Restore value from JSON string.
 * 
 * Inverse of stringify(). Reconstructs all types including cycles and aliases.
 * 
 * This is a convenience wrapper around `JSON.parse()` + `postprocess()`.
 * 
 * @param value - JSON string in tuple $lmz format
 * @returns Restored value with all types and references preserved
 * 
 * @example
 * ```typescript
 * const json = await stringify({ name: "Alice", tags: ["dev", "js"] });
 * const restored = await parse(json);
 * console.log(restored.tags[0]);  // "dev"
 * ```
 */
export async function parse(value: string): Promise<any> {
  return await postprocess(JSON.parse(value));
}

// Intermediate format API - see preprocess.ts and postprocess.ts for full JSDoc
export { preprocess, postprocess };

// Low-level encoding utilities - see web-api-encoding.ts for full JSDoc
export {
  encodeRequest,
  encodeResponse,
  decodeRequest,
  decodeResponse,
  isWebApiObject
} from './web-api-encoding.js';

// Note: Internal types and utilities are NOT exported from this package.
// If other packages need them, import directly from the source files.
// 
// Type exports for tuple format:
export type { } from './preprocess.js';  // No types exported yet
export type { } from './postprocess.js';  // No types exported yet


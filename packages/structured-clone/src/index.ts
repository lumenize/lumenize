/**
 * @lumenize/structured-clone
 * 
 * A fork of @ungap/structured-clone with extensions for Cloudflare Workers:
 * - Async API for Request/Response bodies (Phase 4)
 * - Error objects with full fidelity (Phase 3)
 * - Web API objects (Request, Response, Headers, URL) (Phase 4)
 * - Special numbers (NaN, ±Infinity) (Phase 2)
 * 
 * Original work: https://github.com/ungap/structured-clone
 * License: ISC
 */

import { serialize, type OperationChain } from './serialize.js';
import { deserialize } from './deserialize.js';

const { parse: $parse, stringify: $stringify } = JSON;

/**
 * Convert value to JSON string with full type support.
 * Handles cycles, Date, RegExp, Map, Set, Error, BigInt, TypedArrays.
 * Functions are converted to internal markers (structure preserved, not executable).
 * Web API objects (Request, Response, Headers, URL) are serialized with full fidelity.
 * Throws TypeError for symbols.
 * 
 * Note: Async for Request/Response body reading.
 * 
 * @param value - Any serializable value
 * @returns JSON string representation
 * @throws TypeError if value contains symbols
 */
export async function stringify(value: any): Promise<string> {
  return $stringify(await serialize(value));
}

/**
 * Restore value from JSON string.
 * Inverse of stringify().
 * Functions are restored as marker objects (structure preserved, not executable).
 * 
 * @param value - JSON string to parse
 * @returns Restored value with all types
 */
export async function parse(value: string): Promise<any> {
  return deserialize($parse(value));
}

/**
 * Preprocess value for serialization without converting to string.
 * Returns processed object ready for JSON.stringify().
 * Use when you need control between processing and stringification.
 * Functions are converted to internal markers (structure preserved, not executable).
 * Web API objects (Request, Response, Headers, URL) are serialized with full fidelity.
 * Throws TypeError for symbols.
 * 
 * Note: Async for Request/Response body reading.
 * 
 * @param value - Any serializable value
 * @returns Processed object (not stringified)
 * @throws TypeError if value contains symbols
 */
export async function preprocess(value: any): Promise<any> {
  return await serialize(value);
}

/**
 * Restore value from preprocessed object.
 * Inverse of preprocess().
 * Functions are restored as marker objects (structure preserved, not executable).
 * 
 * @param value - Preprocessed object
 * @returns Restored value with all types
 */
export async function postprocess(value: any): Promise<any> {
  return deserialize(value);
}

/**
 * Low-level serialization utilities for explicit control
 * 
 * Most users should use `stringify()`/`parse()` which handle all types automatically.
 * These marker-based utilities are for specific use cases:
 * - Protocol-level errors (RPC response.error field) - use serializeError/deserializeError
 * - Queue storage where you control timing - use serializeWebApiObject/deserializeWebApiObject
 * - DO storage where you need the marker flag
 */
export {
  serializeError,
  deserializeError,
  isSerializedError
} from './error-serialization.js';

export {
  serializeWebApiObject,
  deserializeWebApiObject,
  isSerializedWebApiObject,
  isWebApiObject
} from './web-api-serialization.js';

// Note: Internal types and utilities are NOT exported from this package.
// If the RPC layer needs them, import directly from the source files:
// - import type { OperationChain } from '@lumenize/structured-clone/src/serialize.js'
// - import { isWebApiObject as isWebApiObjectNative } from '@lumenize/structured-clone/src/web-api-objects.js'


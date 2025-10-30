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
 * Functions are converted to markers with operation chains.
 * Throws TypeError for symbols.
 * 
 * Note: Currently synchronous. Will become async in Phase 4 for Request/Response support.
 * 
 * @param value - Any serializable value
 * @param baseOperationChain - Base operation chain for building function markers (default: [])
 * @returns JSON string representation
 * @throws TypeError if value contains symbols
 */
export async function stringify(value: any, baseOperationChain: OperationChain = []): Promise<string> {
  return $stringify(serialize(value, baseOperationChain));
}

/**
 * Restore value from JSON string.
 * Inverse of stringify().
 * Function markers are restored as marker objects.
 * 
 * @param value - JSON string to parse
 * @returns Restored value with all types (function markers as objects)
 */
export async function parse(value: string): Promise<any> {
  return deserialize($parse(value));
}

/**
 * Preprocess value for serialization without converting to string.
 * Returns processed object ready for JSON.stringify().
 * Use when you need control between processing and stringification.
 * Functions are converted to markers with operation chains.
 * Throws TypeError for symbols.
 * 
 * Note: Currently synchronous. Will become async in Phase 4 for Request/Response support.
 * 
 * @param value - Any serializable value
 * @param baseOperationChain - Base operation chain for building function markers (default: [])
 * @returns Processed object (not stringified)
 * @throws TypeError if value contains symbols
 */
export async function preprocess(value: any, baseOperationChain: OperationChain = []): Promise<any> {
  return serialize(value, baseOperationChain);
}

/**
 * Restore value from preprocessed object.
 * Inverse of preprocess().
 * Function markers are restored as marker objects.
 * 
 * @param value - Preprocessed object
 * @returns Restored value with all types (function markers as objects)
 */
export async function postprocess(value: any): Promise<any> {
  return deserialize(value);
}

// Re-export types for users
export type { Record, OperationChain, Operation } from './serialize.js';
export type { SpecialNumberMarker, NaNMarker, InfinityMarker, NegInfinityMarker } from './special-numbers.js';

// Re-export utility functions for special numbers (useful for RPC layer)
export { 
  isSpecialNumber, 
  serializeSpecialNumber, 
  isSerializedSpecialNumber, 
  deserializeSpecialNumber 
} from './special-numbers.js';


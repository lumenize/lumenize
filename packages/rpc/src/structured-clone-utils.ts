/**
 * Utilities for working with structured-clone serialization.
 */

/**
 * Types that @lumenize/structured-clone preserves perfectly without any custom serialization.
 * 
 * These types should not be recursed into when walking object graphs, and can be
 * passed through to @lumenize/structured-clone as-is.
 * 
 * @lumenize/structured-clone handles all these types natively, including:
 * - Built-in types: Date, RegExp, Map, Set, ArrayBuffer, TypedArrays
 * - Web API objects: Request, Response, Headers, URL, URLSearchParams, Blob, File, FormData
 * - Special numbers: Infinity, -Infinity, NaN
 * 
 * TODO: Error objects should be handled by @lumenize/structured-clone but currently don't
 * preserve all properties (name, custom fields). This needs to be fixed in structured-clone.
 * 
 * @param value - The value to check
 * @returns true if the value needs no preprocessing and should not be recursed into
 */
export function isStructuredCloneNativeType(value: any): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) || // TypedArrays (Uint8Array, etc.)
    // Web API objects
    value instanceof Request ||
    value instanceof Response ||
    value instanceof Headers ||
    value instanceof URL ||
    (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File) ||
    (typeof FormData !== 'undefined' && value instanceof FormData)
  );
}

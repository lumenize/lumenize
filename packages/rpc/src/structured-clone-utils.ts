/**
 * Utilities for working with structured-clone serialization.
 */

/**
 * Types that are handled natively by structured-clone and should not be recursed into
 * when walking object graphs.
 * 
 * These types can be passed through structured-clone as-is without custom serialization.
 * 
 * Note: Web API types like Request, Response, Headers, and URL are NOT in this list
 * because they require custom serialization before structured-clone.
 * 
 * @param value - The value to check
 * @returns true if the value is a type that structured-clone handles natively
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
    value instanceof Error
  );
}

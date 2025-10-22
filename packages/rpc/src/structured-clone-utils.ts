/**
 * Utilities for working with structured-clone serialization.
 */

/**
 * Types that structured-clone preserves perfectly without any custom serialization.
 * 
 * These types should not be recursed into when walking object graphs, and can be
 * passed through to structured-clone as-is.
 * 
 * Note: Error is NOT in this list because it needs custom serialization to preserve
 * all properties (name, stack, custom properties). Web API types like Request, Response,
 * Headers, and URL also require custom serialization before structured-clone.
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
    ArrayBuffer.isView(value) // TypedArrays (Uint8Array, etc.)
  );
}

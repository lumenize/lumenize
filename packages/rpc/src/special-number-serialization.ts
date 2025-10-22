/**
 * Serialization utilities for special JavaScript numbers
 * 
 * Handles Infinity, -Infinity, and NaN which JSON.stringify converts to null.
 * Since we use @ungap/structured-clone/json (JSON-based transport), we need
 * custom serialization for these values.
 */

/**
 * Type guard to check if an object is a serialized special number
 * 
 * @param obj - The object to check
 * @returns true if the object has the __isSpecialNumber marker
 */
export function isSerializedSpecialNumber(obj: any): boolean {
  return obj && typeof obj === 'object' && obj.__isSpecialNumber === true;
}

/**
 * Serializes special numbers (Infinity, -Infinity, NaN) to a marked object
 * 
 * JSON.stringify converts Infinity/-Infinity/NaN to null, losing the actual value.
 * This function detects these special numbers and wraps them in an object with
 * a marker so they can be properly reconstructed on the other side.
 */
export function serializeSpecialNumber(value: any): any {
  if (typeof value !== 'number') {
    return value;
  }
  
  if (value === Infinity) {
    return { __isSpecialNumber: true, value: 'Infinity' };
  }
  
  if (value === -Infinity) {
    return { __isSpecialNumber: true, value: '-Infinity' };
  }
  
  if (Number.isNaN(value)) {
    return { __isSpecialNumber: true, value: 'NaN' };
  }
  
  // Regular number, return as-is
  return value;
}

/**
 * Deserializes special numbers back to their JavaScript values
 * 
 * Converts the marked objects created by serializeSpecialNumber back to
 * actual Infinity, -Infinity, or NaN values.
 */
export function deserializeSpecialNumber(value: any): any {
  if (!value || typeof value !== 'object' || !value.__isSpecialNumber) {
    return value;
  }
  
  switch (value.value) {
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    case 'NaN':
      return NaN;
    default:
      return value; // Unknown special number, return as-is
  }
}

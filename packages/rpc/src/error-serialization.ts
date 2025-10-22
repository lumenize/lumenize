/**
 * Custom serialization utilities for RPC system
 * 
 * Handles cases where @ungap/structured-clone doesn't preserve all data,
 * particularly Error objects with custom properties.
 */

/**
 * Type guard to check if an object is a serialized Error
 * 
 * @param obj - The object to check
 * @returns true if the object has the __isSerializedError marker
 */
export function isSerializedError(obj: any): boolean {
  return obj && typeof obj === 'object' && obj.__isSerializedError === true;
}

/**
 * Serializes Error objects preserving all custom properties
 * 
 * @ungap/structured-clone only preserves `message` and `stack` from Error objects,
 * losing important custom properties like `code`, `statusCode`, `details`, etc.
 * This function manually extracts all enumerable properties for complete error context.
 */
export function serializeError(error: any): any {
  if (!(error instanceof Error)) {
    return error;
  }
  
  const serialized: any = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    __isSerializedError: true, // Marker for client-side reconstruction
  };
  
  // Copy all enumerable properties not already handled
  for (const key of Object.getOwnPropertyNames(error)) {
    if (!['name', 'message', 'stack'].includes(key)) {
      try {
        serialized[key] = (error as any)[key];
      } catch {
        // Skip properties that can't be accessed
      }
    }
  }
  
  return serialized;
}

/**
 * Deserializes Error objects back to proper Error instances for throwing
 * 
 * Plain objects cannot be thrown properly as Errors - they lack the right prototype chain
 * and don't integrate well with error handling, debuggers, etc. This function reconstructs
 * proper Error instances from our custom serialized format.
 */
export function deserializeError(serializedError: any): Error {
  if (!serializedError?.__isSerializedError) {
    return serializedError; // Not a serialized error, return as-is
  }
  
  // Try to reconstruct with the correct Error type, fallback to base Error
  const ErrorConstructor = (globalThis as any)[serializedError.name] || Error;
  const error = new ErrorConstructor(serializedError.message);
  
  // Set the name explicitly (important for custom error names)
  error.name = serializedError.name;
  
  // Copy all custom properties back
  for (const [key, value] of Object.entries(serializedError)) {
    if (!['name', 'message', 'stack', '__isSerializedError'].includes(key)) {
      try {
        (error as any)[key] = value;
      } catch {
        // Skip properties that can't be set
      }
    }
  }
  
  // Preserve the original stack trace if available
  if (serializedError.stack) {
    error.stack = serializedError.stack;
  }
  
  return error;
}
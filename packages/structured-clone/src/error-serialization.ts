/**
 * Marker-based Error serialization utilities
 * 
 * These are LOW-LEVEL utilities for when you need explicit control over Error serialization.
 * Most users should use stringify()/parse() which handle Errors automatically via native serialization.
 * 
 * Use cases for marker-based approach:
 * - Protocol-level errors in RPC (response.error field)
 * - Storing errors alongside other data where you need the marker flag
 * - Manual control over serialization timing
 * 
 * Important limitations:
 * - Custom error subclasses lose their prototype chain across serialization (structured cloning limitation)
 * - The `name` property is preserved, but `instanceof CustomError` will be false after deserialization
 * - All custom properties (code, statusCode, details, etc.) are preserved
 * 
 * Note: Unlike native Error serialization which preserves full Error instances,
 * this marker-based approach converts to plain objects with __isSerializedError flag.
 */

/**
 * Type guard to check if an object is a marker-based serialized Error
 * 
 * @param obj - The object to check
 * @returns true if the object has the __isSerializedError marker
 */
export function isSerializedError(obj: any): boolean {
  return obj && typeof obj === 'object' && obj.__isSerializedError === true;
}

/**
 * Serializes Error objects to plain objects with marker flag
 * 
 * Preserves all custom properties (code, statusCode, details, etc.) in addition
 * to standard Error properties (name, message, stack).
 * 
 * Use this for protocol-level errors where you need the `__isSerializedError` marker flag.
 * For general Error serialization, use `stringify()` which preserves Error instances.
 * 
 * @example
 * ```typescript
 * // Protocol-level error (e.g., RPC response.error field)
 * const error = new Error('Not found');
 * error.statusCode = 404;
 * const serialized = serializeError(error);
 * // Store in protocol: { success: false, error: serialized }
 * const restored = deserializeError(serialized); // Back to Error instance
 * ```
 */
export function serializeError(error: any): any {
  if (!(error instanceof Error)) {
    return error;
  }
  
  // Use constructor name as fallback if error.name is 'Error' but constructor has a custom name
  const errorName = error.name !== 'Error' || error.constructor.name === 'Error'
    ? error.name
    : error.constructor.name;
  
  const serialized: any = {
    name: errorName,
    message: error.message,
    stack: error.stack,
    __isSerializedError: true, // Marker for reconstruction
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
 * Deserializes marker-based Error objects back to Error instances
 * 
 * Reconstructs proper Error instances from the plain objects created by serializeError().
 * Plain objects cannot be thrown properly as Errors - they lack the right prototype chain
 * and don't integrate well with error handling, debuggers, etc.
 * 
 * Note: This is for protocol-level errors. For general Error deserialization,
 * use parse() which handles Errors via native serialization.
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


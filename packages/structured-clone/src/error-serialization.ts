/**
 * Error serialization utilities for indexed format
 * 
 * Used by main stringify()/parse() API.
 * 
 * Important limitations:
 * - Custom error subclasses lose their prototype chain across serialization (structured cloning limitation)
 * - The `name` property is preserved, but `instanceof CustomError` will be false after deserialization
 * - All custom properties (code, statusCode, details, etc.) are preserved
 */

import { ERROR } from './types.js';
import type { OperationChain } from './serialize.js';

/**
 * Serialize Error object using indexed format (for use in serialize.ts)
 * 
 * Enhanced Error serialization with full fidelity:
 * - Captures name, message, stack, cause (recursive), and custom properties
 * - Adds Error record FIRST, then recursively serializes nested values
 * - This matches Map/Set pattern for proper index handling in deserialization
 * 
 * @param error - Error instance to serialize
 * @param pair - Serializer's pair function for recursive serialization
 * @param as - Serializer's as function for storing records
 * @param currentChain - Current operation chain for nested serialization
 * @returns Index of serialized Error record
 */
export async function serializeErrorInIndexedFormat(
  error: Error,
  pair: (value: any, chain: OperationChain) => Promise<number>,
  as: (out: any, value: any) => number,
  currentChain: OperationChain
): Promise<number> {
  // Use error.name for the actual error type (TypeError, RangeError, etc.)
  // not the toString type which is always "Error"
  const errorData: any = {
    name: error.name || 'Error',
    message: error.message || ''
  };
  
  // Preserve stack trace if available
  if (error.stack !== undefined) {
    errorData.stack = error.stack;
  }
  
  // Prepare customProps object (will be filled after)
  const customProps: Record<string, number> = {};
  errorData.customProps = customProps;
  
  // Add Error record FIRST
  const index = as([ERROR, errorData], error);
  
  // NOW recursively serialize cause and custom properties
  // Preserve cause (recursive - cause can be another Error)
  if (error.cause !== undefined) {
    errorData.cause = await pair(error.cause, [...currentChain, { type: 'get' as const, key: 'cause' }]);
  }
  
  // Capture custom properties (best effort)
  // Use getOwnPropertyNames to capture both enumerable and non-enumerable properties
  // Standard Error properties: name, message, stack, cause
  const allProps = Object.getOwnPropertyNames(error);
  for (const key of allProps) {
    if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause') {
      try {
        customProps[key] = await pair((error as any)[key], [...currentChain, { type: 'get' as const, key }]);
      } catch (e) {
        // Skip properties that can't be accessed or serialized
      }
    }
  }
  
  // Remove customProps if empty (cleaner serialization)
  if (Object.keys(customProps).length === 0) {
    delete errorData.customProps;
  }
  
  return index;
}

/**
 * Deserialize Error object from indexed format (for use in deserialize.ts)
 * 
 * Enhanced Error deserialization with full fidelity:
 * - Reconstructs proper Error subclass types
 * - Preserves stack traces
 * - Recursively deserializes cause and custom properties
 * 
 * @param value - Error data object from serialized record
 * @param index - Index of the error record
 * @param unpair - Deserializer's unpair function for recursive deserialization
 * @param as - Deserializer's as function for storing deserialized values
 * @param env - Environment object (self or globalThis) for accessing Error constructors
 * @returns Deserialized Error instance
 */
export function deserializeErrorFromIndexedFormat(
  value: { name: string; message: string; stack?: string; cause?: number; customProps?: Record<string, number> },
  index: number,
  unpair: (index: number) => any,
  as: (out: any, index: number) => any,
  env: typeof globalThis
): Error {
  const { name, message, stack, cause, customProps } = value;
  
  // Create Error with proper subclass type
  const ErrorConstructor = (env as any)[name] || Error;
  const error = new ErrorConstructor(message || '');
  
  // CRITICAL: Explicitly set the name property
  // Built-in Error constructors (TypeError, RangeError) set this automatically,
  // but for custom error names (CustomError, ValidationError), we must set it manually
  error.name = name;
  
  // Capture the error early to handle circular references
  as(error, index);
  
  // Restore stack trace if explicitly provided
  // Note: Constructor auto-generates stack, so only override if we saved one
  if (stack !== undefined) {
    error.stack = stack;
  } else {
    // If no stack was saved, delete the auto-generated one
    delete error.stack;
  }
  
  // Restore cause recursively (might be another Error)
  if (cause !== undefined) {
    error.cause = unpair(cause);
  }
  
  // Restore custom properties
  if (customProps) {
    for (const key in customProps) {
      (error as any)[key] = unpair(customProps[key]);
    }
  }
  
  return error;
}


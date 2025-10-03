/**
 * Converts remote function markers to readable "[Function]" strings for __asObject() display.
 * Adapted from @lumenize/testing package.
 * 
 * This function recursively processes an object that contains RemoteFunctionMarker objects
 * and converts them to human-readable strings for debugging and testing purposes.
 * 
 * @param obj - Object to process (may contain RemoteFunctionMarker objects)
 * @param seen - WeakMap to track circular references
 * @returns Processed object with functions as readable strings
 * 
 * @example
 * ```typescript
 * const result = {
 *   increment: { __isRemoteFunction: true, __functionName: 'increment', __operationChain: [...] },
 *   ctx: {
 *     storage: {
 *       get: { __isRemoteFunction: true, __functionName: 'get', __operationChain: [...] }
 *     }
 *   }
 * };
 * 
 * const readable = convertRemoteFunctionsToStrings(result);
 * // {
 * //   increment: "increment [Function]",
 * //   ctx: {
 * //     storage: {
 * //       get: "get [Function]"
 * //     }
 * //   }
 * // }
 * ```
 */
export function convertRemoteFunctionsToStrings(obj: any, seen = new WeakMap()): any {
  // Handle primitive types and null/undefined - return as-is
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  
  // Handle circular references by returning the already-processed object
  if (seen.has(obj)) {
    return seen.get(obj);
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    const result: any[] = [];
    seen.set(obj, result); // Set early to handle circular refs
    result.push(...obj.map(item => convertRemoteFunctionsToStrings(item, seen)));
    return result;
  }
  
  // Handle built-in types - return as-is
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map || 
      obj instanceof Set || obj instanceof ArrayBuffer || 
      ArrayBuffer.isView(obj) || obj instanceof Error) {
    return obj;
  }
  
  // Check if this is a remote function marker (object with special properties)
  // Note: @lumenize/rpc uses __operationChain instead of __remotePath, but both work
  if (obj && typeof obj === 'object' && obj.__isRemoteFunction && obj.__functionName) {
    // Convert to readable string instead of proxy
    return `${obj.__functionName} [Function]`;
  }
  
  // Handle plain objects - recursively process but preserve structure
  const result: any = {};
  seen.set(obj, result); // Set early to handle circular refs
  for (const [key, value] of Object.entries(obj)) {
    result[key] = convertRemoteFunctionsToStrings(value, seen);
  }
  
  return result;
}

/**
 * Types that are handled natively by structured-clone and should not be recursed into.
 * These types can be passed through structured-clone as-is without custom serialization.
 * 
 * Note: Web API types like Request, Response, Headers, and URL are NOT in this list
 * because they require custom serialization before structured-clone.
 */
function isStructuredCloneNativeType(value: any): boolean {
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

/**
 * Higher-order function for walking object graphs with circular reference handling
 * and prototype chain traversal.
 * 
 * This utility handles the mechanical work of traversing objects while letting
 * the transformer callback decide what transformations to apply.
 * 
 * IMPORTANT: This function will NOT recurse into built-in types that are handled
 * natively by structured-clone (Date, Map, Set, etc.). The transformer is still
 * called for these types, but if it returns them unchanged, they won't be walked.
 * 
 * @param obj - The object to walk
 * @param transformer - Callback that transforms each value. Receives (value, key, parent).
 *                      Return the transformed value, or the original to keep it unchanged.
 * @param seen - WeakMap for tracking circular references (auto-created on first call)
 * @returns The walked and transformed object
 * 
 * @example
 * ```typescript
 * // Serialize Web API objects
 * const result = await walkObject(myObj, async (value, key, parent) => {
 *   if (value instanceof Request) {
 *     return await serializeWebApiObject(value);
 *   }
 *   return value; // no transformation
 * });
 * ```
 */
export async function walkObject(
  obj: any,
  transformer: (value: any, key: string | number, parent: any) => Promise<any> | any,
  seen = new WeakMap<object, any>()
): Promise<any> {
  // Handle primitives - return as-is
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  
  // Handle circular references - return the already-processed object
  if (seen.has(obj)) {
    return seen.get(obj);
  }
  
  // Handle arrays - recursively process items
  if (Array.isArray(obj)) {
    // Create the processed array FIRST and add to seen map BEFORE processing children
    // This is crucial for handling circular references correctly
    const processedArray: any[] = [];
    seen.set(obj, processedArray);
    
    for (let index = 0; index < obj.length; index++) {
      const item = obj[index];
      
      // Apply transformer to the item
      const transformedItem = await transformer(item, index, obj);
      
      // If transformer didn't change the item, recursively walk it
      // BUT: Don't recurse into built-in types that structured-clone handles natively
      if (transformedItem === item && typeof item === 'object' && item !== null && !isStructuredCloneNativeType(item)) {
        processedArray[index] = await walkObject(item, transformer, seen);
      } else {
        processedArray[index] = transformedItem;
      }
    }
    
    return processedArray;
  }
  
  // Handle plain objects - walk enumerable properties and prototype chain
  // Create the processed object FIRST and add to seen map BEFORE processing children
  const processedObject: any = {};
  seen.set(obj, processedObject);
  
  // Process enumerable properties
  for (const [key, value] of Object.entries(obj)) {
    // Apply transformer to the value
    const transformedValue = await transformer(value, key, obj);
    
    // If transformer didn't change the value, recursively walk it
    // BUT: Don't recurse into built-in types that structured-clone handles natively
    if (transformedValue === value && typeof value === 'object' && value !== null && !isStructuredCloneNativeType(value)) {
      processedObject[key] = await walkObject(value, transformer, seen);
    } else {
      processedObject[key] = transformedValue;
    }
  }
  
  // Walk prototype chain
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype && proto !== null) {
    // For prototypes, we need to get ALL properties including non-enumerable ones (like methods)
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    
    for (const [key, descriptor] of Object.entries(descriptors)) {
      // Skip constructor and don't overwrite instance properties
      if (key === 'constructor' || processedObject.hasOwnProperty(key)) {
        continue;
      }
      
      // Get the value from the descriptor
      let value: any;
      if ('value' in descriptor) {
        value = descriptor.value;
      } else if ('get' in descriptor && descriptor.get) {
        // Skip getters - they could have side effects
        continue;
      } else {
        continue;
      }
      
      // Apply transformer to the value
      const transformedValue = await transformer(value, key, proto);
      
      // If transformer didn't change the value, recursively walk it
      if (transformedValue === value && typeof value === 'object' && value !== null) {
        processedObject[key] = await walkObject(value, transformer, seen);
      } else {
        processedObject[key] = transformedValue;
      }
    }
    
    proto = Object.getPrototypeOf(proto);
  }
  
  return processedObject;
}

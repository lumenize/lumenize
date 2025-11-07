/**
 * Higher-order function for walking object graphs with circular reference handling
 * and prototype chain traversal.
 * 
 * This utility handles the mechanical work of traversing objects while letting
 * the transformer callback decide what transformations to apply.
 * 
 * @param obj - The object to walk
 * @param transformer - Callback that transforms each value. Receives (value, key, parent).
 *                      Return the transformed value, or the original to keep it unchanged.
 * @param options - Optional configuration
 * @param options.seen - WeakMap for tracking circular references (auto-created on first call)
 * @param options.shouldSkipRecursion - Optional predicate to determine if recursion should be skipped
 *                                       for a value even if the transformer returns it unchanged.
 *                                       Useful for types that shouldn't be walked (e.g., Date, Map, Set).
 * @returns The walked and transformed object
 * 
 * @example
 * ```typescript
 * // Serialize Web API objects, skip recursing into built-in types
 * const result = await walkObject(myObj, {
 *   transformer: async (value, key, parent) => {
 *     if (value instanceof Request) {
 *       return await serializeWebApiObject(value);
 *     }
 *     return value; // no transformation
 *   },
 *   shouldSkipRecursion: (value) => value instanceof Date || value instanceof Map
 * });
 * ```
 */
export async function walkObject(
  obj: any,
  transformer: (value: any, key: string | number, parent: any) => Promise<any> | any,
  options: {
    seen?: WeakMap<object, any>;
    shouldSkipRecursion?: (value: any) => boolean;
  } = {}
): Promise<any> {
  const { seen = new WeakMap<object, any>(), shouldSkipRecursion } = options;
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
    let hasChanges = false;
    const processedArray: any[] = [];
    seen.set(obj, processedArray); // Track for circular references
    
    for (let index = 0; index < obj.length; index++) {
      const item = obj[index];
      
      // Apply transformer to the item
      const transformedItem = await transformer(item, index, obj);
      
      // If transformer didn't change the item, recursively walk it
      // BUT: Skip recursion if shouldSkipRecursion predicate says so
      const shouldSkip = shouldSkipRecursion ? shouldSkipRecursion(item) : false;
      if (transformedItem === item && typeof item === 'object' && item !== null && !shouldSkip) {
        const walked = await walkObject(item, transformer, { seen, shouldSkipRecursion });
        processedArray[index] = walked;
        if (walked !== item) {
          hasChanges = true;
        }
      } else {
        processedArray[index] = transformedItem;
        if (transformedItem !== item) {
          hasChanges = true;
        }
      }
    }
    
    // Only return new array if we made changes - preserves identity!
    if (!hasChanges) {
      seen.set(obj, obj); // Update seen to point to original
      return obj;
    }
    return processedArray;
  }
  
  // Handle plain objects - walk enumerable properties and prototype chain
  let hasChanges = false;
  const processedObject: any = {};
  seen.set(obj, processedObject); // Track for circular references
  
  // Process enumerable properties
  for (const [key, value] of Object.entries(obj)) {
    // Apply transformer to the value
    const transformedValue = await transformer(value, key, obj);
    
    // If transformer didn't change the value, recursively walk it
    // BUT: Skip recursion if shouldSkipRecursion predicate says so
    const shouldSkip = shouldSkipRecursion ? shouldSkipRecursion(value) : false;
    if (transformedValue === value && typeof value === 'object' && value !== null && !shouldSkip) {
      const walked = await walkObject(value, transformer, { seen, shouldSkipRecursion });
      processedObject[key] = walked;
      if (walked !== value) {
        hasChanges = true;
      }
    } else {
      processedObject[key] = transformedValue;
      if (transformedValue !== value) {
        hasChanges = true;
      }
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
        const walked = await walkObject(value, transformer, { seen, shouldSkipRecursion });
        processedObject[key] = walked;
        if (walked !== value) {
          hasChanges = true;
        }
      } else {
        processedObject[key] = transformedValue;
        if (transformedValue !== value) {
          hasChanges = true; // Prototype method was transformed
        }
      }
      
      // Even if not transformed, adding a prototype property is a change
      // (We're making it an own property instead of prototype property)
      if (value !== undefined) {
        hasChanges = true;
      }
    }
    
    proto = Object.getPrototypeOf(proto);
  }
  
  // Only return new object if we made changes - preserves identity!
  if (!hasChanges) {
    seen.set(obj, obj); // Update seen to point to original
    return obj;
  }
  return processedObject;
}

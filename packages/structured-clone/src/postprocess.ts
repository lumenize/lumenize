/**
 * Tuple-based $lmz format postprocessing
 * 
 * Reconstructs JavaScript values from tuple $lmz format.
 * Uses a two-pass algorithm:
 * 1. First pass: Create all complex objects (arrays, objects, errors, etc.)
 * 2. Second pass: Fill in properties and resolve ["$lmz", index] references
 * 
 * @packageDocumentation
 */

import { decodeRequest, decodeResponse } from './web-api-encoding';
import type { LmzIntermediate } from './preprocess';

/**
 * Postprocesses a value from intermediate to complex reconstructed values
 * 
 * Reconstructs complex JavaScript values (including cycles/aliases) from the intermediate
 * format (`LmzIntermediate`) created by `preprocess()`.
 * 
 * This allows cycles and aliases to be properly reconstructed.
 * 
 * @param data - Intermediate format from preprocess()
 * @returns Reconstructed value with cycles and aliases preserved
 */
export async function postprocess(data: LmzIntermediate): Promise<any> {
  const objects = new Map<number, any>();
  
  // First pass: Create all complex objects
  // This allows us to establish references before filling in properties
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      
      const [type, value] = tuple;
      
      // Create empty containers for each type
      if (type === 'array') {
        objects.set(i, []);
      } else if (type === 'map') {
        objects.set(i, new Map());
      } else if (type === 'set') {
        objects.set(i, new Set());
      } else if (type === 'error') {
        // Create Error with correct type if available
        const ErrorConstructor = (globalThis as any)[value.name] || Error;
        const error = new ErrorConstructor(value.message || '');
        error.name = value.name;
        
        // Set or delete stack property to match encoded state
        if (value.stack !== undefined) {
          error.stack = value.stack;
        } else {
          delete error.stack;
        }
        objects.set(i, error);
      } else if (type === 'headers') {
        // Create Headers immediately (value is already the entries array)
        objects.set(i, new Headers(value));
      } else if (type === 'url') {
        // Create URL immediately (value has href property)
        objects.set(i, new URL(value.href));
      } else if (type === 'arraybuffer') {
        // Create ArrayBuffer/TypedArray/DataView immediately
        if (value.type === 'ArrayBuffer') {
          objects.set(i, new Uint8Array(value.data).buffer);
        } else if (value.type === 'DataView') {
          const buffer = new Uint8Array(value.data).buffer;
          objects.set(i, new DataView(buffer, value.byteOffset, value.byteLength));
        } else {
          // TypedArray - use correct constructor
          const TypedArrayConstructor = (globalThis as any)[value.type];
          if (TypedArrayConstructor) {
            objects.set(i, new TypedArrayConstructor(value.data));
          }
        }
      } else if (type === 'function') {
        // Function markers are just plain objects, create empty object
        objects.set(i, {});
      } else if (type === 'request' || type === 'response') {
        // Request/Response will be reconstructed in second pass
        // Store placeholder for now
        objects.set(i, null);
      } else if (type === 'object') {
        objects.set(i, {});
      }
    }
  }
  
  // Second pass: Fill structures and resolve references
  // Sub-pass 2a: Reconstruct Request/Response first (they don't have circular refs to other objects)
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      
      const [type, value] = tuple;
      
      if (type === 'request') {
        // Decode Request, resolving header and body references
        // Headers and bodies are already created in first pass, so we can resolve synchronously
        const reconstructed = decodeRequest(
          value,
          (headerRef) => {
            // headerRef is ["$lmz", index], look it up directly
            if (Array.isArray(headerRef) && headerRef[0] === '$lmz') {
              return objects.get(headerRef[1]) as Headers;
            }
            return headerRef;
          },
          (bodyRef) => {
            // bodyRef is ["$lmz", index] for ArrayBuffer, look it up directly
            if (Array.isArray(bodyRef) && bodyRef[0] === '$lmz') {
              return objects.get(bodyRef[1]) as ArrayBuffer;
            }
            return bodyRef;
          }
        );
        objects.set(i, reconstructed);
      } else if (type === 'response') {
        // Decode Response, resolving header and body references
        const reconstructed = decodeResponse(
          value,
          (headerRef) => {
            // headerRef is ["$lmz", index], look it up directly
            if (Array.isArray(headerRef) && headerRef[0] === '$lmz') {
              return objects.get(headerRef[1]) as Headers;
            }
            return headerRef;
          },
          (bodyRef) => {
            // bodyRef is ["$lmz", index] for ArrayBuffer, look it up directly
            if (Array.isArray(bodyRef) && bodyRef[0] === '$lmz') {
              return objects.get(bodyRef[1]) as ArrayBuffer;
            }
            return bodyRef;
          }
        );
        objects.set(i, reconstructed);
      }
    }
  }
  
  // Sub-pass 2b: Fill other structures (can now reference Request/Response)
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      
      const [type, value] = tuple;
      const obj = objects.get(i)!;
      
      if (type === 'array') {
        // Fill array with resolved values
        for (const item of value) {
          obj.push(await resolveValue(item, objects));
        }
      } else if (type === 'map') {
        // Fill Map with resolved key-value pairs
        for (const [key, val] of value) {
          obj.set(
            await resolveValue(key, objects),
            await resolveValue(val, objects)
          );
        }
      } else if (type === 'set') {
        // Fill Set with resolved values
        for (const item of value) {
          obj.add(await resolveValue(item, objects));
        }
      } else if (type === 'error') {
        // Error already created in first pass, now fill cause and custom properties
        if (value.cause !== undefined) {
          obj.cause = await resolveValue(value.cause, objects);
        }
        
        // Restore custom properties
        for (const key in value) {
          if (!['name', 'message', 'stack', 'cause'].includes(key)) {
            obj[key] = await resolveValue(value[key], objects);
          }
        }
      } else if (type === 'headers' || type === 'url') {
        // Headers and URL already created in first pass, no fill needed
      } else if (type === 'function') {
        // Function markers are plain objects - copy all properties from value
        const funcMarker = objects.get(i)!;
        for (const key in value) {
          funcMarker[key] = value[key];
        }
      } else if (type === 'request' || type === 'response') {
        // Already handled in sub-pass 2a above
      } else if (type === 'object') {
        // Fill plain object with resolved properties
        for (const key in value) {
          obj[key] = await resolveValue(value[key], objects);
        }
      }
    }
  }
  
  // Resolve and return root value
  return await resolveValue(data.root, objects);
}

/**
 * Resolves a value, handling primitives, tuples, and references
 * 
 * @param value - Value to resolve (could be tuple, reference, or raw value)
 * @param objects - Map of reconstructed objects by index
 * @returns Resolved JavaScript value
 */
async function resolveValue(value: any, objects: Map<number, any>): Promise<any> {
  // Non-tuple values pass through
  if (!value || !Array.isArray(value)) return value;
  
  const [type, data] = value;
  
  // Handle references to previously created objects
  if (type === '$lmz') {
    return objects.get(data);
  }
  
  // Handle inline primitive tuples
  if (type === 'null') return null;
  if (type === 'undefined') return undefined;
  if (type === 'string') return data;
  if (type === 'number') {
    if (data === 'NaN') return NaN;
    if (data === 'Infinity') return Infinity;
    if (data === '-Infinity') return -Infinity;
    return data;
  }
  if (type === 'boolean') return data;
  if (type === 'bigint') return BigInt(data);
  
  // Handle wrapper types
  if (type === 'boolean-object') return new Boolean(data);
  if (type === 'number-object') {
    if (data === 'NaN') return new Number(NaN);
    if (data === 'Infinity') return new Number(Infinity);
    if (data === '-Infinity') return new Number(-Infinity);
    return new Number(data);
  }
  if (type === 'string-object') return new String(data);
  if (type === 'bigint-object') return Object(BigInt(data));
  
  // Handle inline object tuples
  if (type === 'date') return new Date(data);
  if (type === 'regexp') return new RegExp(data.source, data.flags);
  
  // Note: ArrayBuffer/TypedArray/DataView, URL, and Headers are always in objects array for alias support
  
  // Nested tuples or unknown types - shouldn't reach here in normal flow
  return value;
}


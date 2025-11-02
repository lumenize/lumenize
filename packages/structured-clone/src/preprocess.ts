/**
 * Tuple-based $lmz format preprocessing
 * 
 * Combines Cap'n Web's human-readable tuple format ["type", data] with cycle and alias support
 * via ["$lmz", index] references.
 * 
 * @packageDocumentation
 */

import { 
  encodeRequest,
  encodeResponse
} from './web-api-encoding';

/**
 * Intermediate format structure returned by preprocess() and consumed by postprocess()
 * 
 * @property root - The preprocessed root value or reference
 * @property objects - Array of encoded complex objects
 */
export interface LmzIntermediate {
  root: any;
  objects: any[];
}

/**
 * Preprocesses complex values to a format that can be stringified to JSON
 * 
 * Converts complex JavaScript values (including cycles/aliases) to an intermediate format
 * (`LmzIntermediate`) that can be:
 * - Stringified via JSON.stringify() for transport over the wire
 * - Sent over MessagePort/BroadcastChannel (supports objects but not all Web API types)
 * - Stored in IndexedDB or other object-based storage
 * - Inspected or manipulated before stringification
 * 
 * Primitives are encoded inline as tuples: ["string", "hello"], ["number", 42]
 * Complex objects are stored in the objects array and referenced by index: ["$lmz", 0]
 * 
 * Preserves cycles and aliases by tracking seen objects with WeakMap.
 * 
 * @param data - Value to preprocess
 * @returns Intermediate format with root value and objects array
 */
export async function preprocess(data: any): Promise<LmzIntermediate> {
  const seen = new WeakMap<any, number>();
  const objects: any[] = [];
  let nextId = 0;
  
  /**
   * Recursively preprocesses a value to tuple format
   */
  async function preprocessValue(value: any): Promise<any> {
    // Check for symbols first - these cannot be encoded
    if (typeof value === 'symbol') {
      throw new TypeError('unable to serialize symbol');
    }
    
    // Primitives - encode inline as tuples
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === 'string') return ["string", value];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ["number", "NaN"];
      if (value === Infinity) return ["number", "Infinity"];
      if (value === -Infinity) return ["number", "-Infinity"];
      return ["number", value];
    }
    if (typeof value === 'boolean') return ["boolean", value];
    if (typeof value === 'bigint') return ["bigint", value.toString()];
    
    // Functions - convert to simple markers (structure preserved, not executable)
    if (typeof value === 'function') {
      // Assign ID and track
      const id = nextId++;
      seen.set(value, id);
      
      // Clean tuple format - no verbose markers needed
      const tuple: any = ["function", {
        name: value.name || 'anonymous'
      }];
      objects[id] = tuple;
      return ["$lmz", id];
    }
    
    // Objects - check for cycles/aliases first
    if (typeof value === 'object') {
      // Check if we've seen this object before (cycle or alias)
      if (seen.has(value)) {
        return ["$lmz", seen.get(value)!];
      }
      
      // Assign ID and track this object
      const id = nextId++;
      seen.set(value, id);
      
      // Preprocess based on type
      if (Array.isArray(value)) {
        const items: any[] = [];
        for (const item of value) {
          items.push(await preprocessValue(item));
        }
        const tuple: any = ["array", items];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Map) {
        const entries: any[] = [];
        for (const [key, val] of value) {
          entries.push([await preprocessValue(key), await preprocessValue(val)]);
        }
        const tuple: any = ["map", entries];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Set) {
        const values: any[] = [];
        for (const item of value) {
          values.push(await preprocessValue(item));
        }
        const tuple: any = ["set", values];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Date) {
        // Date encodes inline (no references needed)
        return ["date", value.toISOString()];
      } else if (value instanceof RegExp) {
        // RegExp encodes inline (no references needed)
        return ["regexp", { source: value.source, flags: value.flags }];
      } else if (value instanceof Error) {
        // Error object - preserve name, message, stack, cause, custom properties
        const errorData: any = {
          name: value.name || 'Error',
          message: value.message || ''
        };
        if (value.stack) errorData.stack = value.stack;
        if (value.cause !== undefined) errorData.cause = await preprocessValue(value.cause);
        
        // Custom properties (skip standard Error properties)
        const allProps = Object.getOwnPropertyNames(value);
        for (const key of allProps) {
          if (!['name', 'message', 'stack', 'cause'].includes(key)) {
            try {
              errorData[key] = await preprocessValue((value as any)[key]);
            } catch {
              // Skip properties that can't be preprocessed
            }
          }
        }
        
        const tuple: any = ["error", errorData];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Headers) {
        // Headers - encode as array of [key, value] pairs
        const entries: [string, string][] = [];
        value.forEach((val: string, key: string) => {
          entries.push([key, val]);
        });
        const tuple: any = ["headers", entries];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof URL) {
        // URL - encode as object with href
        const tuple: any = ["url", { href: value.href }];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Request) {
        // Request - encode with headers and body references
        const data = await encodeRequest(
          value,
          async (headers) => await preprocessValue(headers),
          async (body) => await preprocessValue(body)
        );
        const tuple: any = ["request", data];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Response) {
        // Response - encode with headers and body references
        const data = await encodeResponse(
          value,
          async (headers) => await preprocessValue(headers),
          async (body) => await preprocessValue(body)
        );
        const tuple: any = ["response", data];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Boolean) {
        // Boolean wrapper object
        return ["boolean-object", value.valueOf()];
      } else if (value instanceof Number) {
        // Number wrapper object
        const num = value.valueOf();
        if (Number.isNaN(num)) return ["number-object", "NaN"];
        if (num === Infinity) return ["number-object", "Infinity"];
        if (num === -Infinity) return ["number-object", "-Infinity"];
        return ["number-object", num];
      } else if (value instanceof String) {
        // String wrapper object
        return ["string-object", value.valueOf()];
      } else if (typeof BigInt !== 'undefined' && value instanceof Object && value.constructor.name === 'BigInt') {
        // BigInt wrapper object (created via Object(BigInt(n)))
        return ["bigint-object", value.valueOf().toString()];
      } else if (typeof (value as any).constructor === 'function') {
        // Check for TypedArrays and ArrayBuffer/DataView
        const constructorName = value.constructor.name;
        if (constructorName === 'ArrayBuffer') {
          // ArrayBuffer - store in objects array so it can be referenced
          const id = nextId++;
          seen.set(value, id);
          const arr = Array.from(new Uint8Array(value));
          const tuple: any = ["arraybuffer", { type: 'ArrayBuffer', data: arr }];
          objects[id] = tuple;
          return ["$lmz", id];
        } else if (constructorName === 'DataView') {
          // DataView - store in objects array so it can be referenced
          const id = nextId++;
          seen.set(value, id);
          const buffer = Array.from(new Uint8Array(value.buffer));
          const tuple: any = ["arraybuffer", {
            type: 'DataView',
            data: buffer,
            byteOffset: value.byteOffset,
            byteLength: value.byteLength
          }];
          objects[id] = tuple;
          return ["$lmz", id];
        } else if (constructorName.includes('Array') && value.buffer) {
          // TypedArray - store in objects array so it can be referenced
          const id = nextId++;
          seen.set(value, id);
          const arr = Array.from(value as any);
          const tuple: any = ["arraybuffer", { type: constructorName, data: arr }];
          objects[id] = tuple;
          return ["$lmz", id];
        }
      }
      
      // Plain object
      const obj: any = {};
      for (const key in value) {
        obj[key] = await preprocessValue(value[key]);
      }
      const tuple: any = ["object", obj];
      objects[id] = tuple;
      return ["$lmz", id];
    }
    
    // Fallback for any unhandled primitives
    return value;
  }
  
  const root = await preprocessValue(data);
  return { root, objects };
}


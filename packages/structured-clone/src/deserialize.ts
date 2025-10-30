/**
 * Deserializer for structured clone algorithm
 * Ported from @ungap/structured-clone
 */

import {
  VOID, PRIMITIVE,
  ARRAY, OBJECT,
  DATE, REGEXP, MAP, SET,
  ERROR, BIGINT, FUNCTION
} from './types.js';
import type { Record } from './serialize.js';
import { isSerializedSpecialNumber, deserializeSpecialNumber } from './special-numbers.js';
import { isSerializedWebApiObject, deserializeWebApiObject } from './web-api-objects.js';

const env = typeof self === 'object' ? self : globalThis;

const deserializer = ($: Map<number, any>, _: Record[]) => {
  const as = (out: any, index: number): any => {
    $.set(index, out);
    return out;
  };

  const unpair = (index: number): any => {
    if ($.has(index))
      return $.get(index);

    const [type, value] = _[index];
    switch (type) {
      case PRIMITIVE:
        // Check if this is a special number marker
        if (isSerializedSpecialNumber(value)) {
          return as(deserializeSpecialNumber(value), index);
        }
        return as(value, index);
      case VOID:
        return as(value, index);
      case ARRAY: {
        const arr: any[] = as([], index);
        for (const idx of value)
          arr.push(unpair(idx));
        return arr;
      }
      case OBJECT: {
        // Check if this is a Web API object marker (stored as plain object)
        if (isSerializedWebApiObject(value)) {
          return as(deserializeWebApiObject(value), index);
        }
        
        // Regular object deserialization (value is array of [key, value] pairs)
        const object: any = as({}, index);
        for (const [key, idx] of value)
          object[unpair(key)] = unpair(idx);
        return object;
      }
      case DATE:
        return as(new Date(value), index);
      case REGEXP: {
        const { source, flags } = value;
        return as(new RegExp(source, flags), index);
      }
      case MAP: {
        const map = as(new Map, index);
        for (const [key, idx] of value)
          map.set(unpair(key), unpair(idx));
        return map;
      }
      case SET: {
        const set = as(new Set, index);
        for (const idx of value)
          set.add(unpair(idx));
        return set;
      }
      case ERROR: {
        // Enhanced Error deserialization with full fidelity
        const { name, message, stack, cause, customProps } = value;
        
        // Create Error with proper subclass type
        const ErrorConstructor = (env as any)[name] || Error;
        const error = new ErrorConstructor(message || '');
        
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
            error[key] = unpair(customProps[key]);
          }
        }
        
        return error;
      }
      case BIGINT:
        return as(BigInt(value), index);
      case FUNCTION:
        // Return the function marker as-is (RPC layer will convert to proxy)
        return as(value, index);
      case 'BigInt':
        return as(Object(BigInt(value)), index);
      case 'ArrayBuffer':
        return as(new Uint8Array(value).buffer, index);
      case 'DataView': {
        const { buffer } = new Uint8Array(value);
        return as(new DataView(buffer), index);
      }
    }
    return as(new (env as any)[type as string](value), index);
  };

  return unpair;
};

/**
 * Returns a deserialized value from a serialized array of Records.
 * @param serialized - A previously serialized value
 * @returns The deserialized value
 */
export const deserialize = (serialized: Record[]): any => {
  return deserializer(new Map, serialized)(0);
};


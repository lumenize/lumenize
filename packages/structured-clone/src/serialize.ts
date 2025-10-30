/**
 * Serializer for structured clone algorithm
 * Ported from @ungap/structured-clone
 */

import {
  VOID, PRIMITIVE,
  ARRAY, OBJECT,
  DATE, REGEXP, MAP, SET,
  ERROR, BIGINT, FUNCTION
} from './types.js';
import { isSpecialNumber, serializeSpecialNumber } from './special-numbers.js';
import { 
  isWebApiObject, 
  getWebApiType,
  serializeRequest,
  serializeResponse,
  serializeHeaders,
  serializeURL
} from './web-api-objects.js';

/**
 * Operation type for building operation chains
 */
export type Operation = 
  | { type: 'get', key: string | number | symbol }
  | { type: 'apply', args: any[] };

/**
 * Chain of operations for function markers
 */
export type OperationChain = Operation[];

const EMPTY = '';

const { toString } = {};
const { keys } = Object;

const typeOf = (value: any): [number, string] => {
  const type = typeof value;
  if (type !== 'object' || !value)
    return [PRIMITIVE, type];

  const asString = toString.call(value).slice(8, -1);
  switch (asString) {
    case 'Array':
      return [ARRAY, EMPTY];
    case 'Object':
      return [OBJECT, EMPTY];
    case 'Date':
      return [DATE, EMPTY];
    case 'RegExp':
      return [REGEXP, EMPTY];
    case 'Map':
      return [MAP, EMPTY];
    case 'Set':
      return [SET, EMPTY];
    case 'DataView':
      return [ARRAY, asString];
  }

  if (asString.includes('Array'))
    return [ARRAY, asString];

  if (asString.includes('Error'))
    return [ERROR, asString];

  return [OBJECT, asString];
};

const serializer = ($: Map<any, number>, _: any[], baseOperationChain: OperationChain) => {

  const as = (out: any, value: any): number => {
    const index = _.push(out) - 1;
    $.set(value, index);
    return index;
  };

  const pair = async (value: any, currentChain: OperationChain): Promise<number> => {
    if ($.has(value))
      return $.get(value)!;

    // Handle special numbers (NaN, Infinity, -Infinity) before typeOf
    // These are typeof 'number' but need special serialization for JSON
    if (isSpecialNumber(value)) {
      return as([PRIMITIVE, serializeSpecialNumber(value)], value);
    }

    // Handle Web API objects (Request, Response, Headers, URL) before typeOf
    // These need async serialization for body reading
    if (isWebApiObject(value)) {
      const webApiType = getWebApiType(value);
      let marker: any;
      
      switch (webApiType) {
        case 'Request':
          marker = await serializeRequest(value);
          break;
        case 'Response':
          marker = await serializeResponse(value);
          break;
        case 'Headers':
          marker = serializeHeaders(value);
          break;
        case 'URL':
          marker = serializeURL(value);
          break;
        default:
          throw new Error(`Unknown Web API type: ${webApiType}`);
      }
      
      return as([OBJECT, marker], value);
    }

    let [TYPE, type] = typeOf(value);
    switch (TYPE) {
      case PRIMITIVE: {
        let entry = value;
        switch (type) {
          case 'bigint':
            TYPE = BIGINT;
            entry = value.toString();
            break;
          case 'function':
            // Convert function to marker with operation chain
            return as([FUNCTION, {
              __lmz_Function: true,
              __operationChain: currentChain,
              __functionName: currentChain.length > 0 
                ? String((currentChain[currentChain.length - 1] as any).key || 'anonymous')
                : 'anonymous'
            }], value);
          case 'symbol':
            throw new TypeError('unable to serialize symbol');
          case 'undefined':
            return as([VOID], value);
        }
        return as([TYPE, entry], value);
      }
      case ARRAY: {
        if (type) {
          let spread: any = value;
          if (type === 'DataView') {
            spread = new Uint8Array(value.buffer);
          }
          else if (type === 'ArrayBuffer') {
            spread = new Uint8Array(value);
          }
          return as([type, [...spread]], value);
        }

        const arr: number[] = [];
        const index = as([TYPE, arr], value);
        for (let i = 0; i < value.length; i++) {
          const itemChain = [...currentChain, { type: 'get' as const, key: i }];
          arr.push(await pair(value[i], itemChain));
        }
        return index;
      }
      case OBJECT: {
        if (type) {
          switch (type) {
            case 'BigInt':
              return as([type, value.toString()], value);
            case 'Boolean':
            case 'Number':
            case 'String':
              return as([type, value.valueOf()], value);
          }
        }

        const entries: [number, number][] = [];
        const index = as([TYPE, entries], value);
        for (const key of keys(value)) {
          const keyChain = [...currentChain, { type: 'get' as const, key }];
          entries.push([await pair(key, currentChain), await pair(value[key], keyChain)]);
        }
        return index;
      }
      case DATE:
        return as([TYPE, value.toISOString()], value);
      case REGEXP: {
        const { source, flags } = value;
        return as([TYPE, { source, flags }], value);
      }
      case MAP: {
        const entries: [number, number][] = [];
        const index = as([TYPE, entries], value);
        let mapIndex = 0;
        for (const [key, entry] of value) {
          const entryChain = [...currentChain, { type: 'get' as const, key: mapIndex++ }];
          entries.push([await pair(key, entryChain), await pair(entry, entryChain)]);
        }
        return index;
      }
      case SET: {
        const entries: number[] = [];
        const index = as([TYPE, entries], value);
        let setIndex = 0;
        for (const entry of value) {
          const entryChain = [...currentChain, { type: 'get' as const, key: setIndex++ }];
          entries.push(await pair(entry, entryChain));
        }
        return index;
      }
    }

    // Enhanced Error serialization with full fidelity
    // Capture: name, message, stack, cause (recursive), and custom properties
    // Important: Add Error record FIRST, then recursively serialize nested values
    // (like Map/Set do) so the Error is at the correct index for deserialization
    
    // Use error.name for the actual error type (TypeError, RangeError, etc.)
    // not the toString type which is always "Error"
    const errorData: any = {
      name: value.name || 'Error',
      message: value.message || ''
    };
    
    // Preserve stack trace if available
    if (value.stack !== undefined) {
      errorData.stack = value.stack;
    }
    
    // Prepare customProps object (will be filled after)
    const customProps: Record<string, number> = {};
    errorData.customProps = customProps;
    
    // Add Error record FIRST
    const index = as([TYPE, errorData], value);
    
    // NOW recursively serialize cause and custom properties
    // Preserve cause (recursive - cause can be another Error)
    if (value.cause !== undefined) {
      errorData.cause = await pair(value.cause, [...currentChain, { type: 'get' as const, key: 'cause' }]);
    }
    
    // Capture custom properties (best effort)
    // Use getOwnPropertyNames to capture both enumerable and non-enumerable properties
    // Standard Error properties: name, message, stack, cause
    const allProps = Object.getOwnPropertyNames(value);
    for (const key of allProps) {
      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause') {
        try {
          customProps[key] = await pair(value[key], [...currentChain, { type: 'get' as const, key }]);
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
  };

  return pair;
};

/**
 * Record type: [type, value]
 */
export type Record = [string | number, any];

/**
 * Returns an array of serialized Records.
 * Functions are converted to markers with operation chains.
 * Web API objects (Request/Response) are serialized asynchronously.
 * Throws TypeError for symbols.
 * 
 * @param value - A serializable value
 * @param baseOperationChain - Base operation chain for building function markers (default: [])
 * @returns Array of serialized records
 */
export const serialize = async (value: any, baseOperationChain: OperationChain = []): Promise<Record[]> => {
  const _: Record[] = [];
  await serializer(new Map, _, baseOperationChain)(value, baseOperationChain);
  return _;
};


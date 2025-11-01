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
  serializeWebApiObject,
} from './web-api-serialization.js';
import { serializeErrorInIndexedFormat } from './error-serialization.js';

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
      const marker = await serializeWebApiObject(value, false); // No clone for indexed format
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
    return await serializeErrorInIndexedFormat(value, pair, as, currentChain);
  };

  return pair;
};

/**
 * SerializedRecord type: [type, value]
 */
export type SerializedRecord = [string | number, any];

/**
 * Returns an array of serialized records.
 * Functions are converted to internal markers (structure preserved, not executable).
 * Web API objects (Request/Response) are serialized asynchronously.
 * Throws TypeError for symbols.
 * 
 * @param value - A serializable value
 * @returns Array of serialized records
 * @internal
 */
export const serialize = async (value: any): Promise<SerializedRecord[]> => {
  const _: SerializedRecord[] = [];
  const baseOperationChain: OperationChain = [];
  await serializer(new Map, _, baseOperationChain)(value, baseOperationChain);
  return _;
};


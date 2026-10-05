/**
 * W4 object-based $lmz format postprocessing.
 *
 * Inverse of `preprocess()`. Walks the `{ json, meta }` shape, reconstructing
 * complex types from inline `{ $type, ...payload }` tags and resolving
 * `{ $ref: id }` placeholders against `meta.aliases`.
 *
 * Reference resolution is multi-pass to support cycles:
 *   1. For every alias slot, instantiate an empty container (`{}`, `[]`,
 *      `new Map()`, etc.).
 *   2. Rebuild Request/Response sync wrappers (they need all fields at
 *      construction time, so they can't be filled in-place).
 *   3. Fill in containers — at this point all aliases are populated, so
 *      cycles resolve correctly.
 *
 * @packageDocumentation
 */

import {
  decodeRequestSync,
  decodeResponseSync,
} from './web-api-encoding';
import { setOwn, type LmzIntermediate } from './preprocess';

// User-key un-escape: any wire key starting with '$$' becomes the original
// user key (one `$` removed). Wire-internal keys like `$type` / `$ref` never
// start with `$$` so this is unambiguous.
function unescapeKey(k: string): string {
  return k.startsWith('$$') ? k.slice(1) : k;
}

// The decoder constructs only what the encoder emits. A payload names a global
// in an error's `name` and a typed array's `subtype`, and constructing that
// global unchecked would let any sender build a DOM element in a browser, or
// open an outbound WebSocket from a Durable Object, with arguments it chose.

// The global an error's `name` names, but only when it is an Error class:
// `Error`, a built-in subclass, or a custom one registered on `globalThis` to
// keep `instanceof` across the wire. Otherwise the name stays data, on an Error.
function errorClassNamed(name: unknown): ErrorConstructor {
  const Ctor = (globalThis as any)[name as string];
  return typeof Ctor === 'function' && (Ctor === Error || Ctor.prototype instanceof Error)
    ? Ctor
    : Error;
}

function newError(v: any): Error & Record<string, any> {
  const err = new (errorClassNamed(v.name))(v.message ?? '');
  // A class whose constructor takes something else first — AggregateError's
  // errors, SuppressedError's error — leaves the message unset, so it is
  // written here the way a native error holds it.
  if (typeof v.message === 'string' && err.message !== v.message) {
    Object.defineProperty(err, 'message', { value: v.message, writable: true, enumerable: false, configurable: true });
  }
  if (typeof v.name === 'string') err.name = v.name;
  if (typeof v.stack === 'string') err.stack = v.stack;
  else delete err.stack;
  return err;
}

function fillError(err: Error & Record<string, any>, encoded: any, aliases: Map<number, any>): void {
  if (encoded.cause !== undefined) err.cause = decodeValue(encoded.cause, aliases);
  for (const k of Object.keys(encoded)) {
    if (['$type', 'name', 'message', 'stack', 'cause'].includes(k)) continue;
    setOwn(err, unescapeKey(k), decodeValue(encoded[k], aliases));
  }
}

// Every built-in typed-array constructor has %TypedArray% as its prototype,
// and a class extending %TypedArray% directly cannot be constructed, so this
// admits exactly the built-ins — Float16Array included where the runtime has it.
const TypedArray = Object.getPrototypeOf(Uint8Array);

/**
 * Postprocesses a value from intermediate to fully reconstructed values.
 *
 * @param data - Intermediate `{ json, meta }` from `preprocess()`.
 * @returns Fully reconstructed value with all types, cycles, and aliases preserved.
 */
export function postprocess(data: LmzIntermediate): any {
  const aliasesIn = data.meta?.aliases ?? {};
  const aliases = new Map<number, any>();

  // Pass 1 — create empty containers for every alias slot.
  for (const key of Object.keys(aliasesIn)) {
    aliases.set(Number(key), allocContainer(aliasesIn[key], aliases));
  }

  // Pass 2 — rebuild request-sync/response-sync wrappers. Headers may
  // themselves be alias slots; these were filled-as-Headers in pass 1.
  for (const key of Object.keys(aliasesIn)) {
    const v = aliasesIn[key];
    const id = Number(key);
    if (isTagged(v, 'request-sync')) {
      aliases.set(id, decodeRequestSync(v.data, (h: any) => decodeValue(h, aliases)));
    } else if (isTagged(v, 'response-sync')) {
      aliases.set(id, decodeResponseSync(v.data, (h: any) => decodeValue(h, aliases)));
    }
  }

  // Pass 3 — fill in containers.
  for (const key of Object.keys(aliasesIn)) {
    const id = Number(key);
    const v = aliasesIn[key];
    if (isTagged(v, 'request-sync') || isTagged(v, 'response-sync')) continue;
    fillContainer(aliases.get(id), v, aliases);
  }

  return decodeValue(data.json, aliases);
}

function isTagged(v: any, tag?: string): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (!('$type' in v)) return false;
  return tag === undefined || v.$type === tag;
}

function allocContainer(v: any, aliases: Map<number, any>): any {
  if (Array.isArray(v)) return [];
  if (!v || typeof v !== 'object') return v;
  if ('$type' in v) {
    switch (v.$type as string) {
      case 'map':
        return new Map();
      case 'set':
        return new Set();
      case 'date':
        return new Date(v.iso);
      case 'regexp':
        return new RegExp(v.source, v.flags);
      case 'url':
        return new URL(v.href);
      case 'headers':
        return new Headers(v.entries);
      case 'error':
        return newError(v);
      case 'boolean-object':
        return new Boolean(v.value);
      case 'number-object': {
        const raw = v.value;
        if (raw === 'NaN') return new Number(NaN);
        if (raw === 'Infinity') return new Number(Infinity);
        if (raw === '-Infinity') return new Number(-Infinity);
        return new Number(raw);
      }
      case 'string-object':
        return new String(v.value);
      case 'bigint-object':
        return Object(BigInt(v.value));
      case 'arraybuffer':
        return allocArrayBuffer(v, aliases);
      case 'function':
        return {};
      case 'request-sync':
      case 'response-sync':
        return null; // filled in pass 2
      default:
        return {};
    }
  }
  return {}; // plain object body
}

function allocArrayBuffer(v: any, aliases: Map<number, any>): any {
  // Built from the bytes the payload carries, never from a length it names:
  // `new Float64Array(1e8)` would let a 30-byte message allocate 800 MB.
  if (!Array.isArray(v.data)) {
    throw new DOMException('Could not deserialize arraybuffer: data is not an array', 'DataCloneError');
  }
  if (v.subtype === 'ArrayBuffer') {
    return new Uint8Array(v.data).buffer;
  }
  if (v.subtype === 'DataView') {
    const buffer = new Uint8Array(v.data).buffer;
    return new DataView(buffer, v.byteOffset, v.byteLength);
  }
  const Ctor = (globalThis as any)[v.subtype];
  if (typeof Ctor === 'function' && Object.getPrototypeOf(Ctor) === TypedArray) {
    return new Ctor(v.data.map((el: unknown) => decodeValue(el, aliases)));
  }
  return new Uint8Array(v.data); // fallback
}

function fillContainer(container: any, encoded: any, aliases: Map<number, any>): void {
  if (encoded === null || typeof encoded !== 'object') return;
  if (Array.isArray(encoded)) {
    for (const item of encoded) (container as any[]).push(decodeValue(item, aliases));
    return;
  }
  if ('$type' in encoded) {
    switch (encoded.$type as string) {
      case 'map': {
        const m = container as Map<any, any>;
        for (const [k, v] of encoded.entries) {
          m.set(decodeValue(k, aliases), decodeValue(v, aliases));
        }
        return;
      }
      case 'set': {
        const s = container as Set<any>;
        for (const v of encoded.values) s.add(decodeValue(v, aliases));
        return;
      }
      case 'error':
        fillError(container, encoded, aliases);
        return;
      case 'function': {
        const marker = container as Record<string, any>;
        for (const k of Object.keys(encoded)) {
          if (k === '$type' || k === 'name') continue;
          setOwn(marker, unescapeKey(k), decodeValue((encoded as any)[k], aliases));
        }
        marker.name = encoded.name;
        return;
      }
      // Atomic types — fully reconstructed in pass 1.
      case 'date':
      case 'regexp':
      case 'url':
      case 'headers':
      case 'boolean-object':
      case 'number-object':
      case 'string-object':
      case 'bigint-object':
      case 'arraybuffer':
      case 'request-sync':
      case 'response-sync':
        return;
      default:
        // Plain object with arbitrary $type — copy keys.
        for (const k of Object.keys(encoded)) {
          if (k === '$type') continue;
          setOwn(container, unescapeKey(k), decodeValue((encoded as any)[k], aliases));
        }
        (container as any).$type = encoded.$type;
        return;
    }
  }
  // Plain object body
  for (const k of Object.keys(encoded)) {
    setOwn(container, unescapeKey(k), decodeValue((encoded as any)[k], aliases));
  }
}

function decodeValue(value: any, aliases: Map<number, any>): any {
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeValue(v, aliases));

  if ('$ref' in value && Object.keys(value).length === 1) {
    return aliases.get(value.$ref);
  }

  if ('$type' in value) {
    const tag = value.$type as string;
    switch (tag) {
      case 'undefined':
        return undefined;
      case 'bigint':
        return BigInt(value.value);
      case 'number-special': {
        const v = value.value;
        if (v === 'NaN') return NaN;
        if (v === 'Infinity') return Infinity;
        if (v === '-Infinity') return -Infinity;
        return Number(v);
      }
      case 'function': {
        const marker: Record<string, any> = { name: value.name };
        for (const k of Object.keys(value)) {
          if (k === '$type' || k === 'name') continue;
          setOwn(marker, unescapeKey(k), decodeValue((value as any)[k], aliases));
        }
        return marker;
      }
      case 'date':
        return new Date(value.iso);
      case 'regexp':
        return new RegExp(value.source, value.flags);
      case 'url':
        return new URL(value.href);
      case 'headers':
        return new Headers(value.entries);
      case 'map': {
        const m = new Map();
        for (const [k, v] of value.entries) m.set(decodeValue(k, aliases), decodeValue(v, aliases));
        return m;
      }
      case 'set': {
        const s = new Set();
        for (const v of value.values) s.add(decodeValue(v, aliases));
        return s;
      }
      case 'error': {
        const err = newError(value);
        fillError(err, value, aliases);
        return err;
      }
      case 'boolean-object':
        return new Boolean(value.value);
      case 'number-object': {
        const v = value.value;
        if (v === 'NaN') return new Number(NaN);
        if (v === 'Infinity') return new Number(Infinity);
        if (v === '-Infinity') return new Number(-Infinity);
        return new Number(v);
      }
      case 'string-object':
        return new String(value.value);
      case 'bigint-object':
        return Object(BigInt(value.value));
      case 'arraybuffer':
        return allocArrayBuffer(value, aliases);
      case 'request-sync':
        return decodeRequestSync(value.data, (h: any) => decodeValue(h, aliases));
      case 'response-sync':
        return decodeResponseSync(value.data, (h: any) => decodeValue(h, aliases));
      default: {
        const out: Record<string, any> = { $type: tag };
        for (const k of Object.keys(value)) {
          if (k === '$type') continue;
          setOwn(out, unescapeKey(k), decodeValue((value as any)[k], aliases));
        }
        return out;
      }
    }
  }

  const out: Record<string, any> = {};
  for (const k of Object.keys(value)) {
    setOwn(out, unescapeKey(k), decodeValue((value as any)[k], aliases));
  }
  return out;
}

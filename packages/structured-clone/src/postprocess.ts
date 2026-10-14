/**
 * Inverse of `preprocess()`. Reconstructs complex types from inline
 * `{ $type, ...payload }` tags, and resolves each `{ $ref: "#/…" }` against
 * the place in the document its pointer names.
 *
 * A document holding a `$ref` is decoded in two passes, so a `$ref` may come
 * before its target, as it does once a patch has reordered an object's keys:
 *   1. Index the document's value positions, allocating an empty container
 *      (`{}`, `[]`, `new Map()`, …) at each one. A `$ref` resolves to one of
 *      these by lookup, never by decoding its target, so a chain of forward
 *      references never recurses.
 *   2. Fill every container. Cycles resolve because each container exists
 *      before its children are decoded.
 *
 * @packageDocumentation
 */

import {
  decodeRequestSync,
  decodeResponseSync,
} from './web-api-encoding';
import { setOwn, escapePointerSegment } from './preprocess';
import type { JsonValue } from './merge-patch';

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

function fillError(err: Error & Record<string, any>, encoded: any, d: Decoding): void {
  if (encoded.cause !== undefined) err.cause = decodeAt(encoded.cause, d);
  for (const k of Object.keys(encoded)) {
    if (['$type', 'name', 'message', 'stack', 'cause'].includes(k)) continue;
    setOwn(err, unescapeKey(k), decodeAt(encoded[k], d));
  }
}

// Every built-in typed-array constructor has %TypedArray% as its prototype,
// and a class extending %TypedArray% directly cannot be constructed, so this
// admits exactly the built-ins — Float16Array included where the runtime has it.
const TypedArray = Object.getPrototypeOf(Uint8Array);

function refused(reason: string): DOMException {
  return new DOMException(`Could not deserialize: ${reason}`, 'DataCloneError');
}

// A container at one value position of a document holding a `$ref`: the
// object allocated for it, and the containers below it, each keyed by the
// pointer segments that reach it from here. `step` is how many segments one
// step down takes: one for an object, array or error property, two for a
// Set's `values/i` or a request's `data/headers`, three for a Map's
// `entries/i/0`, and zero where nothing below is a value position.
interface Slot {
  value: any;
  step: number;
  children: Map<string, Slot> | null;
}

// Marks a request or response slot whose object is built after the index
// pass, from headers that must exist first.
const PENDING = Symbol('pending');

interface Decoding {
  // The slot allocated for each container, keyed by its JSON object; null
  // when the document holds no `$ref` and is decoded in one recursive pass.
  slots: Map<object, Slot> | null;
  root: Slot | null;
}

/**
 * Decodes a value `preprocess()` encoded, with every type, cycle and shared
 * object restored.
 *
 * @throws DOMException named `DataCloneError` for a `$ref` that names no
 *   value position in the document, or that names another `$ref`.
 */
export function postprocess(data: JsonValue): any {
  if (!holdsRef(data)) return decodeAt(data, { slots: null, root: null });

  const d: Decoding = { slots: new Map(), root: null };
  const order: [Slot, any][] = [];
  d.root = indexAt(data, d, order);
  for (const [slot, encoded] of order) {
    if (slot.value !== PENDING) continue;
    slot.value = encoded.$type === 'request-sync'
      ? decodeRequestSync(encoded.data, (h: any) => decodeAt(h, d))
      : decodeResponseSync(encoded.data, (h: any) => decodeAt(h, d));
  }
  for (const [slot, encoded] of order) fill(slot.value, encoded, d);
  return decodeAt(data, d);
}

// Whether any object in the document has an own `$ref`. Iterative, so a deep
// document costs no stack here.
function holdsRef(data: unknown): boolean {
  const stack: unknown[] = [data];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
      continue;
    }
    if (Object.hasOwn(v, '$ref')) return true;
    for (const k in v) if (Object.hasOwn(v, k)) stack.push((v as any)[k]);
  }
  return false;
}

function isTagged(v: any): boolean {
  return Object.hasOwn(v, '$type');
}

// A `$ref` must stand alone, holding a pointer into this document.
function isRef(v: any): boolean {
  if (Array.isArray(v) || !Object.hasOwn(v, '$ref')) return false;
  if (Object.keys(v).length !== 1) throw refused('a $ref has sibling keys');
  return true;
}

// The tags that decode to a primitive, so never to a slot.
function isPrimitiveTag(v: any): boolean {
  if (!isTagged(v)) return false;
  return v.$type === 'undefined' || v.$type === 'bigint' || v.$type === 'number-special';
}

function addChild(slot: Slot, key: string, child: Slot | null): void {
  if (child === null) return;
  (slot.children ??= new Map()).set(key, child);
}

// The index pass: allocates a slot for the container at this value position
// and every one below it, in document order.
function indexAt(v: any, d: Decoding, order: [Slot, any][]): Slot | null {
  if (v === null || typeof v !== 'object' || isRef(v) || isPrimitiveTag(v)) return null;
  const slot: Slot = { value: alloc(v, d, true), step: 0, children: null };
  d.slots!.set(v, slot);
  order.push([slot, v]);

  if (Array.isArray(v)) {
    slot.step = 1;
    for (let i = 0; i < v.length; i++) addChild(slot, String(i), indexAt(v[i], d, order));
    return slot;
  }
  if (!isTagged(v)) {
    slot.step = 1;
    for (const k of Object.keys(v)) addChild(slot, escapePointerSegment(k), indexAt(v[k], d, order));
    return slot;
  }
  switch (v.$type) {
    case 'map':
      slot.step = 3;
      if (Array.isArray(v.entries)) {
        v.entries.forEach((pair: any, i: number) => {
          if (!Array.isArray(pair)) return;
          addChild(slot, `entries/${i}/0`, indexAt(pair[0], d, order));
          addChild(slot, `entries/${i}/1`, indexAt(pair[1], d, order));
        });
      }
      break;
    case 'set':
      slot.step = 2;
      if (Array.isArray(v.values)) {
        v.values.forEach((member: any, i: number) => addChild(slot, `values/${i}`, indexAt(member, d, order)));
      }
      break;
    case 'error':
      slot.step = 1;
      for (const k of Object.keys(v)) {
        if (k === '$type' || k === 'name' || k === 'message' || k === 'stack') continue;
        addChild(slot, escapePointerSegment(k), indexAt(v[k], d, order));
      }
      break;
    case 'request-sync':
    case 'response-sync':
      slot.step = 2;
      if (v.data && typeof v.data === 'object') {
        addChild(slot, 'data/headers', indexAt(v.data.headers, d, order));
      }
      break;
  }
  return slot;
}

// Finds the slot a `$ref`'s pointer names. Each segment is matched as
// written, so `#/__proto__` reaches only an own `__proto__` key.
function resolve(ref: any, d: Decoding): any {
  const pointer = ref.$ref;
  if (typeof pointer !== 'string' || (pointer !== '#' && !pointer.startsWith('#/'))) {
    throw refused('a $ref holds no JSON Pointer');
  }
  let slot = d.root;
  if (slot !== null && pointer !== '#') {
    const segments = pointer.slice(2).split('/');
    for (let i = 0; slot !== null && i < segments.length; ) {
      const step: number = slot.step;
      if (step === 0 || i + step > segments.length) {
        slot = null;
        break;
      }
      const key = step === 1 ? segments[i] : segments.slice(i, i + step).join('/');
      slot = slot.children?.get(key) ?? null;
      i += step;
    }
  }
  if (slot === null) throw refused(`$ref "${pointer}" names no value in the document`);
  if (slot.value === PENDING) throw refused(`$ref "${pointer}" names a request or response being built`);
  return slot.value;
}

// The value at one position: a primitive as it is, a `$ref` resolved, an
// indexed container as allocated (the fill pass fills it), and anything
// else decoded here.
function decodeAt(v: any, d: Decoding): any {
  if (v === null || typeof v !== 'object') return v;
  if (isRef(v)) {
    if (d.slots === null) throw refused('a $ref in a document indexed without one');
    return resolve(v, d);
  }
  const slot = d.slots?.get(v);
  if (slot !== undefined) return slot.value;
  if (isPrimitiveTag(v)) return decodePrimitiveTag(v);
  const value = alloc(v, d, false);
  fill(value, v, d);
  return value;
}

function decodePrimitiveTag(v: any): any {
  switch (v.$type) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(v.value);
    default: {
      const n = v.value;
      if (n === 'NaN') return NaN;
      if (n === 'Infinity') return Infinity;
      if (n === '-Infinity') return -Infinity;
      return Number(n);
    }
  }
}

// An empty container for a value, or the whole value for a type with no
// children. A request or response, which needs its headers to exist, is
// built here only outside the index pass.
function alloc(v: any, d: Decoding, indexing: boolean): any {
  if (Array.isArray(v)) return [];
  if (!isTagged(v)) return {};
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
      return allocArrayBuffer(v, d);
    case 'function':
      return { name: v.name };
    case 'request-sync':
      return indexing ? PENDING : decodeRequestSync(v.data, (h: any) => decodeAt(h, d));
    case 'response-sync':
      return indexing ? PENDING : decodeResponseSync(v.data, (h: any) => decodeAt(h, d));
    default:
      return { $type: v.$type };
  }
}

function allocArrayBuffer(v: any, d: Decoding): any {
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
    return new Ctor(v.data.map((el: unknown) => decodeAt(el, d)));
  }
  return new Uint8Array(v.data); // fallback
}

// Fills a container allocated for `encoded` with its decoded children.
function fill(container: any, encoded: any, d: Decoding): void {
  if (Array.isArray(encoded)) {
    container.length = encoded.length;
    for (let i = 0; i < encoded.length; i++) {
      if (Object.hasOwn(encoded, i)) container[i] = decodeAt(encoded[i], d);
    }
    return;
  }
  if (!isTagged(encoded)) {
    for (const k of Object.keys(encoded)) setOwn(container, unescapeKey(k), decodeAt(encoded[k], d));
    return;
  }
  switch (encoded.$type as string) {
    case 'map':
      for (const [k, v] of encoded.entries) container.set(decodeAt(k, d), decodeAt(v, d));
      return;
    case 'set':
      for (const v of encoded.values) container.add(decodeAt(v, d));
      return;
    case 'error':
      fillError(container, encoded, d);
      return;
    case 'function':
      for (const k of Object.keys(encoded)) {
        if (k === '$type' || k === 'name') continue;
        setOwn(container, unescapeKey(k), decodeAt(encoded[k], d));
      }
      container.name = encoded.name;
      return;
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
      return; // whole from `alloc`
    default:
      // An unknown tag decodes as a plain object that keeps its `$type`.
      for (const k of Object.keys(encoded)) {
        if (k === '$type') continue;
        setOwn(container, unescapeKey(k), decodeAt(encoded[k], d));
      }
      return;
  }
}

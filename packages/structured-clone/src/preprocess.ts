/**
 * W4 object-based $lmz format preprocessing.
 *
 * Replaces the prior tuple-based `{ root, objects[] }` format with a
 * SuperJSON-style `{ json, meta }` shape that's amenable to RFC 7396
 * (JSON Merge Patch) diffs. See experiments/structured-clone-object-format/RESULTS.md
 * for the benchmark-driven rationale and per-mutation patch sizes.
 *
 * Wire shape (cycle-free common case):
 *   - Plain JSON values (string, number, boolean, null, arrays of those,
 *     objects with string keys) sit natively in `json` with no wrapper.
 *   - Special types are encoded inline as `{ $type: "<tag>", ...payload }`.
 *   - User keys that start with `$` are escaped to `$<key>` on the wire and
 *     un-escaped on decode.
 *   - `meta` is `{}` for cycle-free graphs with no special-type-by-path
 *     tracking needed.
 *
 * Cycles and aliases:
 *   - An object is written in full where the walk first reaches it, and
 *     every later occurrence becomes `{ $ref: "#/owner" }`, a JSON Reference
 *     to that first place in the encoding.
 *
 * Special-type tags emitted:
 *   undefined, bigint, number-special (NaN/Infinity/-Infinity/-0),
 *   date, regexp, map, set, error, headers, url, arraybuffer (covers
 *   ArrayBuffer/DataView/TypedArray), boolean-object, number-object,
 *   string-object, bigint-object, request-sync, response-sync, function.
 *
 * @packageDocumentation
 */

import {
  encodeRequestSync,
  encodeResponseSync,
} from './web-api-encoding';
import type { RequestSync } from './request-sync';
import type { ResponseSync } from './response-sync';
import type { JsonValue } from './merge-patch';

// A step from the value's root, for naming where an unencodable object sits
// in a DataCloneError's message.
interface PathStep {
  type: 'get' | 'index';
  key: string | number;
}

// ---------------------------------------------------------------------------
// User-key escape: any user key starting with '$' is escaped with another '$'.
// This guarantees no collision with our reserved `$type` / `$ref` keys.
// ---------------------------------------------------------------------------
function escapeKey(k: string): string {
  return k.startsWith('$') ? '$' + k : k;
}

// A JSON Pointer segment (RFC 6901): `~` becomes `~0` before `/` becomes `~1`,
// so `a/b` and `a~1b` stay distinct.
export function escapePointerSegment(segment: string): string {
  if (segment.indexOf('~') === -1 && segment.indexOf('/') === -1) return segment;
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Writes an own data property. Assigning `__proto__` calls Object.prototype's
// setter, which replaces the target's prototype instead, so that one key is
// defined: it travels as the own key native structuredClone() keeps, and a
// payload naming it cannot hand the decoded object a prototype.
export function setOwn(target: Record<string, any>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

// Renders a path as `session.keys[0]` for error messages.
function formatPath(path: PathStep[]): string {
  let out = '';
  for (const step of path) {
    if (step.type === 'index') out += `[${step.key}]`;
    else out += out ? `.${step.key}` : String(step.key);
  }
  return out;
}

/**
 * Encodes a value as JSON that `postprocess` turns back into it, preserving
 * cycles, shared objects and every special type.
 *
 * An object reached a second time is written as `{"$ref":"#/owner"}`, a JSON
 * Reference whose pointer names where the object was first written, through
 * the encoding rather than the value: a value inside a Map's `entries` is
 * `#/m/entries/0/1`, and a cycle through the root is `#`.
 *
 * @throws TypeError if value contains symbols.
 * @throws DOMException named `DataCloneError` for an object with no encoder
 *   that isn't a plain object or class instance (CryptoKey, Blob, streams, …),
 *   naming its type and path.
 */
export function preprocess(data: any): JsonValue {
  // Every object written so far, with the object it was written inside and
  // the pointer suffix from that object to it. A pointer is rendered from
  // these only when a `$ref` is written.
  const placed = new Map<object, { owner: object | null; suffix: string }>();
  // Placement order, so a failed Error property can take back what it placed.
  const placedOrder: object[] = [];

  function pointerTo(obj: object): string {
    const suffixes: string[] = [];
    for (let at = placed.get(obj)!; at.owner !== null; at = placed.get(at.owner)!) {
      suffixes.push(at.suffix);
    }
    return '#' + suffixes.reverse().join('');
  }

  // Encodes the value at one position. `owner` is the object whose encoding
  // holds the position and `suffix` is the pointer from it, `/` included.
  function encode(value: any, owner: object | null, suffix: string, path: PathStep[]): any {
    if (value === null) return null;
    if (value === undefined) return { $type: 'undefined' };
    if (typeof value === 'symbol') throw new TypeError('unable to serialize symbol');
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return encodeNumber(value);
    if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
    if (typeof value === 'function') {
      // Custom props on the function aren't preserved.
      return { $type: 'function', name: (value as Function).name || 'anonymous' };
    }
    if (placed.has(value)) return { $ref: pointerTo(value) };
    placed.set(value, { owner, suffix });
    placedOrder.push(value);
    return encodeObject(value, path);
  }

  function encodeObject(value: any, path: PathStep[]): any {
    // Order matters: check most-specific subclasses before plain object.
    if (Array.isArray(value)) {
      return value.map((item, i) => encode(item, value, `/${i}`, [...path, { type: 'index', key: i }]));
    }
    if (value instanceof Map) {
      return {
        $type: 'map',
        entries: Array.from(value.entries(), ([k, v], i) => [
          encode(k, value, `/entries/${i}/0`, path),
          encode(v, value, `/entries/${i}/1`, path),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        $type: 'set',
        values: Array.from(value, (v, i) => encode(v, value, `/values/${i}`, path)),
      };
    }
    if (value instanceof Date) {
      return { $type: 'date', iso: value.toISOString() };
    }
    if (value instanceof RegExp) {
      return { $type: 'regexp', source: value.source, flags: value.flags };
    }
    if (value instanceof Error) {
      const errorData: any = {
        $type: 'error',
        name: value.name || 'Error',
        message: value.message || '',
      };
      if (value.stack) errorData.stack = value.stack;
      if (value.cause !== undefined) {
        errorData.cause = encode(value.cause, value, '/cause', [...path, { type: 'get', key: 'cause' }]);
      }
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!['name', 'message', 'stack', 'cause'].includes(key)) {
          const wireKey = escapeKey(key);
          const mark = placedOrder.length;
          try {
            setOwn(errorData, wireKey, encode(
              (value as any)[key],
              value,
              '/' + escapePointerSegment(wireKey),
              [...path, { type: 'get', key }],
            ));
          } catch {
            // Skip an un-encodable prop, and forget what it placed, so no
            // later `$ref` points into the encoding that was dropped.
            for (const dropped of placedOrder.splice(mark)) placed.delete(dropped);
          }
        }
      }
      return errorData;
    }
    if (value instanceof Headers) {
      const entries: [string, string][] = [];
      (value as Headers).forEach((v, k) => entries.push([k, v]));
      return { $type: 'headers', entries };
    }
    if (value instanceof URL) {
      return { $type: 'url', href: value.href };
    }
    if ((value as any).constructor?.name === 'RequestSync') {
      const data = encodeRequestSync(value as RequestSync, (h) => encode(h, value, '/data/headers', path));
      return { $type: 'request-sync', data };
    }
    if ((value as any).constructor?.name === 'ResponseSync') {
      const data = encodeResponseSync(value as ResponseSync, (h) => encode(h, value, '/data/headers', path));
      return { $type: 'response-sync', data };
    }
    if (value instanceof Request) {
      throw new Error('Cannot serialize native Request object. Use RequestSync instead.');
    }
    if (value instanceof Response) {
      throw new Error('Cannot serialize native Response object. Use ResponseSync instead.');
    }
    if (value instanceof Boolean) {
      return { $type: 'boolean-object', value: (value as Boolean).valueOf() };
    }
    if (value instanceof Number) {
      const num = (value as Number).valueOf();
      let v: any = num;
      if (Number.isNaN(num)) v = 'NaN';
      else if (num === Infinity) v = 'Infinity';
      else if (num === -Infinity) v = '-Infinity';
      else if (Object.is(num, -0)) v = '-0';
      return { $type: 'number-object', value: v };
    }
    if (value instanceof String) {
      return { $type: 'string-object', value: (value as String).valueOf() };
    }
    // bigint-object (boxed BigInt)
    if (
      typeof BigInt !== 'undefined'
      && value instanceof Object
      && (value as any).constructor?.name === 'BigInt'
    ) {
      return { $type: 'bigint-object', value: (value as any).valueOf().toString() };
    }
    // ArrayBuffer / TypedArray / DataView
    if ((value as any).constructor?.name === 'ArrayBuffer') {
      return {
        $type: 'arraybuffer',
        subtype: 'ArrayBuffer',
        data: Array.from(new Uint8Array(value as ArrayBuffer)),
      };
    }
    if (ArrayBuffer.isView(value)) {
      // The tag names the built-in view even for a subclass, so Node's Buffer
      // travels as the Uint8Array it is rather than under a constructor name
      // that exists nowhere else.
      const subtype = Object.prototype.toString.call(value).slice(8, -1);
      if (subtype === 'DataView') {
        return {
          $type: 'arraybuffer',
          subtype,
          data: Array.from(new Uint8Array((value as DataView).buffer)),
          byteOffset: (value as DataView).byteOffset,
          byteLength: (value as DataView).byteLength,
        };
      }
      // Each element takes the primitive encoding, so NaN, ±Infinity and a
      // BigInt64Array's bigints carry their tags: JSON would write the first
      // three as `null` and throw on the last.
      return {
        $type: 'arraybuffer',
        subtype,
        data: Array.from(value as unknown as ArrayLike<number | bigint>, (el) =>
          typeof el === 'bigint' ? { $type: 'bigint', value: el.toString() } : encodeNumber(el)),
      };
    }
    // Copying own keys is right only for a plain object or a class instance.
    // Anything else reaching here is a host object (CryptoKey, Blob,
    // ReadableStream, WeakMap, …) whose state lives in internal slots, so the
    // copy would arrive as an impostor. Refuse it with the DataCloneError that
    // native structuredClone() throws for what it can't clone.
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object Object]') {
      const where = path.length > 0 ? ` at ${formatPath(path)}` : '';
      throw new DOMException(
        `Could not serialize object of type "${tag.slice(8, -1)}"${where}. `
          + 'Convert it to a plain value first.',
        'DataCloneError',
      );
    }
    // Plain object
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      const wireKey = escapeKey(key);
      setOwn(out, wireKey, encode(
        (value as any)[key],
        value,
        '/' + escapePointerSegment(wireKey),
        [...path, { type: 'get', key }],
      ));
    }
    return out;
  }

  return encode(data, null, '', []);
}

function encodeNumber(value: number): any {
  if (Number.isNaN(value)) return { $type: 'number-special', value: 'NaN' };
  if (value === Infinity) return { $type: 'number-special', value: 'Infinity' };
  if (value === -Infinity) return { $type: 'number-special', value: '-Infinity' };
  // JSON writes -0 as 0. The decoder's `Number(value)` fallback already
  // reads the tag back, so a receiver that predates it gets -0 too.
  if (Object.is(value, -0)) return { $type: 'number-special', value: '-0' };
  return value;
}

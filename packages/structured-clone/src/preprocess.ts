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
 *   - When a complex value is referenced more than once (including cycles),
 *     it is hoisted into `meta.aliases` keyed by stringified id, and every
 *     occurrence in `json` becomes `{ $ref: id }`. The first walk counts
 *     references (`refCount`); the second walk emits the wire form.
 *
 * Special-type tags emitted:
 *   undefined, bigint, number-special (NaN/Infinity/-Infinity),
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

/**
 * Intermediate format returned by `preprocess()` and consumed by `postprocess()`.
 *
 * @property json - The encoded document. Plain JSON for the cycle-free case;
 *   contains `{ $ref: id }` placeholders for any shared/cyclic subgraphs.
 * @property meta - Sparse sidecar. Currently only `aliases` is populated.
 *   May grow to include `paths` for special-type tracking in a future revision.
 */
export interface LmzIntermediate {
  json: any;
  meta: {
    aliases?: Record<string, any>;
  };
}

/**
 * Symbol returned from transform hook to indicate value should be skipped
 * and processed normally by structured-clone.
 * @internal
 */
export const TRANSFORM_SKIP = Symbol('TRANSFORM_SKIP');

/**
 * Path element in the object tree - represents a step in the traversal.
 * @internal
 */
export interface PathElement {
  type: 'get' | 'index';
  key: string | number;
}

/**
 * Context provided to transform hooks during preprocessing.
 * @internal
 */
export interface PreprocessContext {
  /** Current path from root to this value. */
  path: PathElement[];
}

/**
 * Transform hook called for each value during preprocessing.
 *
 * Return `TRANSFORM_SKIP` to use the default encoding for this value, or
 * return the encoded form directly. The returned value is placed into `json`
 * (or into an alias slot if it ends up being referenced multiply).
 *
 * Special form: if the returned value is a plain object with a `$type`
 * property, it is treated as an inline-tagged special type — `postprocess`
 * users can register a custom decoder for that `$type` (decoder API TBD;
 * for now the standard tags are emitted by this module).
 *
 * @internal
 */
export type PreprocessTransform = (
  value: any,
  context: PreprocessContext,
) => any | typeof TRANSFORM_SKIP;

/** Options for `preprocess()`. @internal */
export interface PreprocessOptions {
  /** Custom transform hook called for each value before default encoding. */
  transform?: PreprocessTransform;
}

// ---------------------------------------------------------------------------
// User-key escape: any user key starting with '$' is escaped with another '$'.
// This guarantees no collision with our reserved `$type` / `$ref` keys.
// ---------------------------------------------------------------------------
function escapeKey(k: string): string {
  return k.startsWith('$') ? '$' + k : k;
}

/**
 * Preprocesses complex values to a format that can be stringified to JSON.
 *
 * The output is the W4 object-based format (`LmzIntermediate`) that can be:
 *  - Stringified via `JSON.stringify()` for transport.
 *  - Sent over `MessagePort` / `BroadcastChannel`.
 *  - Stored in IndexedDB.
 *  - **Diffed with RFC 7396 JSON Merge Patch** for per-mutation
 *    synchronization (see `./merge-patch.ts`).
 *
 * Preserves cycles and aliases by hoisting shared subgraphs into
 * `meta.aliases`. The hot common-case (no shared objects) produces pure
 * nested JSON in `json` with an empty `meta`.
 *
 * @param data - Value to preprocess.
 * @param options - Optional preprocessing options including custom transform hooks.
 * @returns Intermediate format `{ json, meta }`.
 * @throws TypeError if value contains symbols.
 */
export function preprocess(data: any, options?: PreprocessOptions): LmzIntermediate {
  const transform = options?.transform;

  // ---- Pass 1: count references to identify multiply-referenced objects ----
  const refCount = new WeakMap<object, number>();
  // Track in-progress to break cycle recursion.
  const visiting = new WeakSet<object>();

  function countRefs(value: any): void {
    if (value === null || typeof value !== 'object') return;
    // Skip values that the transform hook handles directly — the hook
    // returns its own shape, so we can't recurse it as a normal object.
    // BUT: we DO need to track its identity so the transform's shared
    // outputs are correctly aliased. For simplicity Pass 1 ignores the
    // transform; transform return values are treated as opaque scalars in
    // Pass 2 (they don't get cycle-tracked). This is the same semantics
    // the tuple format had.
    const prev = refCount.get(value);
    refCount.set(value, (prev ?? 0) + 1);
    if (prev !== undefined) return; // already counted; skip recursion
    if (visiting.has(value)) return; // cycle guard (shouldn't fire given the prev check)
    visiting.add(value);
    if (Array.isArray(value)) {
      for (const item of value) countRefs(item);
    } else if (value instanceof Map) {
      for (const [k, v] of value) {
        countRefs(k);
        countRefs(v);
      }
    } else if (value instanceof Set) {
      for (const item of value) countRefs(item);
    } else if (value instanceof Date || value instanceof RegExp || value instanceof URL || value instanceof Headers) {
      // Atomic — no inner refs.
    } else if (value instanceof Error) {
      if (value.cause !== undefined) countRefs(value.cause);
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!['name', 'message', 'stack', 'cause'].includes(key)) {
          countRefs((value as any)[key]);
        }
      }
    } else if (
      value.constructor?.name === 'ArrayBuffer' ||
      value.constructor?.name === 'DataView' ||
      (value.constructor && /Array$/.test(value.constructor.name) && (value as any).buffer)
    ) {
      // Atomic.
    } else if (
      value.constructor?.name === 'RequestSync' ||
      value.constructor?.name === 'ResponseSync'
    ) {
      // Will encode atomically; headers tracking happens during pass 2.
      if ((value as any).headers) countRefs((value as any).headers);
    } else if (
      value instanceof Boolean || value instanceof Number || value instanceof String
    ) {
      // Atomic boxed primitives.
    } else if (typeof value === 'object') {
      for (const k of Object.keys(value)) countRefs((value as any)[k]);
    }
    visiting.delete(value);
  }

  countRefs(data);

  // ---- Pass 2: emit wire form ----
  const aliases: Record<string, any> = {};
  // For objects that are referenced multiply: assign an id, hoist to aliases,
  // emit `{ $ref: id }` at every occurrence (including the first).
  const aliasId = new WeakMap<object, number>();
  let nextAliasId = 0;

  function getAliasId(v: object): number {
    let id = aliasId.get(v);
    if (id === undefined) {
      id = nextAliasId++;
      aliasId.set(v, id);
    }
    return id;
  }

  function isShared(v: any): boolean {
    if (v === null || typeof v !== 'object') return false;
    return (refCount.get(v) ?? 0) > 1;
  }

  function refOf(v: object): { $ref: number } {
    return { $ref: getAliasId(v) };
  }

  function encodeBody(value: any, path: PathElement[]): any {
    // 1. Primitives
    if (value === null) return null;
    if (value === undefined) return { $type: 'undefined' };
    if (typeof value === 'symbol') throw new TypeError('unable to serialize symbol');
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return { $type: 'number-special', value: 'NaN' };
      if (value === Infinity) return { $type: 'number-special', value: 'Infinity' };
      if (value === -Infinity) return { $type: 'number-special', value: '-Infinity' };
      return value;
    }
    if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
    if (typeof value === 'function') {
      // Functions encoded as a marker. Custom props on the function aren't
      // currently preserved (matches the old tuple format).
      return { $type: 'function', name: (value as Function).name || 'anonymous' };
    }

    // 2. Complex objects — check if shared/aliased
    if (typeof value === 'object') {
      const obj = value as object;
      if (isShared(obj)) {
        const id = getAliasId(obj);
        const key = String(id);
        if (!(key in aliases)) {
          // Placeholder so cycles terminate
          aliases[key] = null;
          aliases[key] = encodeComplex(value, path);
        }
        return refOf(obj);
      }
      // Unique — inline directly.
      return encodeComplex(value, path);
    }

    return value;
  }

  function encodeComplex(value: any, path: PathElement[]): any {
    // Order matters: check most-specific subclasses before plain object.
    if (Array.isArray(value)) {
      return value.map((item, i) => encodeRoot(item, [...path, { type: 'index', key: i }]));
    }
    if (value instanceof Map) {
      return {
        $type: 'map',
        entries: Array.from(value.entries(), ([k, v]) => [
          encodeRoot(k, path),
          encodeRoot(v, path),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        $type: 'set',
        values: Array.from(value, (v) => encodeRoot(v, path)),
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
        errorData.cause = encodeRoot(value.cause, [...path, { type: 'get', key: 'cause' }]);
      }
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!['name', 'message', 'stack', 'cause'].includes(key)) {
          try {
            errorData[escapeKey(key)] = encodeRoot(
              (value as any)[key],
              [...path, { type: 'get', key }],
            );
          } catch {
            // skip un-encodable props
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
      const data = encodeRequestSync(value as RequestSync, (h) => encodeRoot(h, path));
      return { $type: 'request-sync', data };
    }
    if ((value as any).constructor?.name === 'ResponseSync') {
      const data = encodeResponseSync(value as ResponseSync, (h) => encodeRoot(h, path));
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
    if ((value as any).constructor) {
      const ctorName = (value as any).constructor.name;
      if (ctorName === 'ArrayBuffer') {
        return {
          $type: 'arraybuffer',
          subtype: 'ArrayBuffer',
          data: Array.from(new Uint8Array(value as ArrayBuffer)),
        };
      }
      if (ctorName === 'DataView') {
        return {
          $type: 'arraybuffer',
          subtype: 'DataView',
          data: Array.from(new Uint8Array((value as DataView).buffer)),
          byteOffset: (value as DataView).byteOffset,
          byteLength: (value as DataView).byteLength,
        };
      }
      if (ctorName.includes('Array') && (value as any).buffer) {
        return {
          $type: 'arraybuffer',
          subtype: ctorName,
          data: Array.from(value as ArrayLike<number>),
        };
      }
    }
    // Plain object
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      out[escapeKey(key)] = encodeRoot(
        (value as any)[key],
        [...path, { type: 'get', key }],
      );
    }
    return out;
  }

  function encodeRoot(value: any, path: PathElement[]): any {
    // Apply transform hook first
    if (transform) {
      const transformed = transform(value, { path });
      if (transformed !== TRANSFORM_SKIP) {
        // The hook handled this value — treat its return as opaque.
        // Note: returned value passes through JSON.stringify as-is and is
        // NOT alias-tracked. To get alias semantics, the hook should call
        // back into structured-clone if/when needed.
        return transformed;
      }
    }
    return encodeBody(value, path);
  }

  const json = encodeRoot(data, []);
  const meta: LmzIntermediate['meta'] = {};
  if (Object.keys(aliases).length > 0) meta.aliases = aliases;
  return { json, meta };
}

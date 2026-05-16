/**
 * Converts JavaScript values to TypeScript programs for type-checking with tsc.
 *
 * Uses `preprocess()` from `@lumenize/structured-clone` to get the tagged-tuple
 * intermediate representation, then walks those tuples to emit TypeScript.
 *
 * @see tasks/nebula-5.2.1-structured-clone-to-typescript.md for full design
 */

import { preprocess } from '@lumenize/structured-clone';

/**
 * Local tuple-format adapter.
 *
 * The structured-clone package now emits the W4 `{ json, meta }` format
 * (see `experiments/structured-clone-object-format/RESULTS.md`). This file's
 * walker is heavily coupled to the legacy `{ root, objects[] }` tuple shape
 * — rewriting it is tracked as Phase 2 follow-up in
 * `tasks/structured-clone-object-based-wire-format.md`.
 *
 * As a stopgap, we convert W4 → legacy tuples in-process. Behavior is
 * identical because the conversion preserves cycles via the same `$lmz`
 * indirection.
 */
interface LegacyTuple {
  root: any;
  objects: any[];
}

function w4ToLegacyTuple(intermediate: { json: any; meta: { aliases?: Record<string, any> } }): LegacyTuple {
  const objects: any[] = [];
  const aliasIdToSlot = new Map<number, number>();
  // Pre-allocate alias slots so cycles can resolve back-refs.
  const aliasesIn = intermediate.meta?.aliases ?? {};
  for (const key of Object.keys(aliasesIn)) {
    aliasIdToSlot.set(Number(key), objects.length);
    objects.push(null);
  }
  // Fill alias slots.
  for (const key of Object.keys(aliasesIn)) {
    const aliasId = Number(key);
    const slotIdx = aliasIdToSlot.get(aliasId)!;
    objects[slotIdx] = w4EncodeAsTuple(aliasesIn[key], objects, aliasIdToSlot);
  }
  const root = w4EncodeInline(intermediate.json, objects, aliasIdToSlot);
  return { root, objects };
}

function w4UnescapeKey(k: string): string {
  return k.startsWith('$$') ? k.slice(1) : k;
}

/** Convert a W4 value to either an inline tuple (for primitives) or a `["$lmz", id]` ref (for complex). */
function w4EncodeInline(v: any, objects: any[], aliasIdx: Map<number, number>): any {
  if (v === null) return ['null'];
  if (typeof v === 'string') return ['string', v];
  if (typeof v === 'number') return ['number', v];
  if (typeof v === 'boolean') return ['boolean', v];
  if (typeof v === 'object' && v !== null) {
    if ('$ref' in v && Object.keys(v).length === 1) {
      return ['$lmz', aliasIdx.get(v.$ref)!];
    }
    if ('$type' in v) {
      // Inline-only tags (primitives in legacy format)
      const t = v.$type;
      if (t === 'undefined') return ['undefined'];
      if (t === 'bigint') return ['bigint', v.value];
      if (t === 'number-special') return ['number', v.value];
      // Other $type values are complex — slot them.
    }
    const slotIdx = objects.length;
    objects.push(null);
    objects[slotIdx] = w4EncodeAsTuple(v, objects, aliasIdx);
    return ['$lmz', slotIdx];
  }
  // Defensive fallback (shouldn't reach here for valid W4 input)
  return v;
}

/** Convert a W4 complex value into the legacy slot tuple form (e.g. `["object", {...}]`). */
function w4EncodeAsTuple(v: any, objects: any[], aliasIdx: Map<number, number>): any {
  if (Array.isArray(v)) {
    return ['array', v.map((x) => w4EncodeInline(x, objects, aliasIdx))];
  }
  if (v && typeof v === 'object' && '$type' in v) {
    const t = v.$type as string;
    switch (t) {
      case 'date':
        return ['date', v.iso];
      case 'regexp':
        return ['regexp', { source: v.source, flags: v.flags }];
      case 'url':
        return ['url', { href: v.href }];
      case 'headers':
        return ['headers', v.entries];
      case 'map':
        return [
          'map',
          v.entries.map(([k, val]: [any, any]) => [
            w4EncodeInline(k, objects, aliasIdx),
            w4EncodeInline(val, objects, aliasIdx),
          ]),
        ];
      case 'set':
        return ['set', v.values.map((x: any) => w4EncodeInline(x, objects, aliasIdx))];
      case 'function':
        return ['function', { name: v.name }];
      case 'error': {
        const out: any = { name: v.name, message: v.message };
        if (v.stack !== undefined) out.stack = v.stack;
        if (v.cause !== undefined) out.cause = w4EncodeInline(v.cause, objects, aliasIdx);
        for (const k of Object.keys(v)) {
          if (['$type', 'name', 'message', 'stack', 'cause'].includes(k)) continue;
          out[w4UnescapeKey(k)] = w4EncodeInline(v[k], objects, aliasIdx);
        }
        return ['error', out];
      }
      case 'request-sync':
        // Headers field is already an encoded W4 value — re-encode to inline form.
        return ['request-sync', { ...v.data, headers: w4EncodeInline(v.data.headers, objects, aliasIdx) }];
      case 'response-sync':
        return ['response-sync', { ...v.data, headers: w4EncodeInline(v.data.headers, objects, aliasIdx) }];
      case 'boolean-object':
        return ['boolean-object', v.value];
      case 'number-object':
        return ['number-object', v.value];
      case 'string-object':
        return ['string-object', v.value];
      case 'bigint-object':
        return ['bigint-object', v.value];
      case 'arraybuffer':
        return ['arraybuffer', {
          type: v.subtype,
          data: v.data,
          ...(v.byteOffset !== undefined ? { byteOffset: v.byteOffset } : {}),
          ...(v.byteLength !== undefined ? { byteLength: v.byteLength } : {}),
        }];
      // 'undefined', 'bigint', 'number-special' handled in w4EncodeInline
      default:
        // Unknown tag — emit a plain object with the $type preserved.
        const objOut: any = {};
        for (const k of Object.keys(v)) objOut[w4UnescapeKey(k)] = w4EncodeInline(v[k], objects, aliasIdx);
        return ['object', objOut];
    }
  }
  // Plain object
  const out: any = {};
  for (const k of Object.keys(v)) out[w4UnescapeKey(k)] = w4EncodeInline(v[k], objects, aliasIdx);
  return ['object', out];
}

type LmzIntermediate = LegacyTuple; // local alias — file's walker still expects this shape

/** Valid JS identifier pattern — keys matching this can be unquoted in object literals */
const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** Emit a property key for an object literal — unquoted if a valid identifier, quoted otherwise */
function emitKey(key: string): string {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
}

/** Standard Error constructor names available in tsc's global scope */
const STANDARD_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'URIError', 'EvalError',
]);

/** TypedArray constructor names */
const TYPED_ARRAY_NAMES = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

/**
 * Path segment for constructing fixup statements.
 * Captures both the key and the container type.
 */
type PathSegment =
  | { container: 'object'; key: string }
  | { container: 'array'; index: number }
  | { container: 'map-value'; keyExpr: string | null }
  | { container: 'map-key'; varName: string }
  | { container: 'set' };

/** Recorded cycle back-edge for fixup statements */
interface CycleFixup {
  targetPath: PathSegment[];
  backEdgePath: PathSegment[];
}

/**
 * Render a path as bracket-notation TypeScript expression.
 * e.g., [{ container: 'object', key: 'children' }, { container: 'array', index: 0 }]
 * → `__validate["children"][0]`
 */
function renderPath(path: PathSegment[]): string {
  let result = '__validate';
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (seg.container === 'object') {
      result += `[${JSON.stringify(seg.key)}]`;
    } else if (seg.container === 'array') {
      result += `[${seg.index}]`;
    } else if (seg.container === 'map-value') {
      // Should not appear in the middle of a path — only as last segment
      // for Map value fixups. If it does appear mid-path, render as generic access.
      result += `.get(${seg.keyExpr})`;
    } else if (seg.container === 'map-key') {
      // Restart the path from the extracted key variable
      result = seg.varName;
    }
    // 'set' segments don't have addressable paths in bracket notation
  }
  return result;
}

/**
 * Build fixup statements from a recorded cycle back-edge.
 */
function buildFixup(fixup: CycleFixup): string {
  const targetExpr = fixup.targetPath.length === 0
    ? '__validate'
    : renderPath(fixup.targetPath);

  const lastSeg = fixup.backEdgePath[fixup.backEdgePath.length - 1];
  const parentPath = fixup.backEdgePath.slice(0, -1);
  const parentExpr = parentPath.length === 0
    ? '__validate'
    : renderPath(parentPath);

  if (lastSeg.container === 'object') {
    return `${parentExpr}[${JSON.stringify(lastSeg.key)}] = ${targetExpr};`;
  }
  if (lastSeg.container === 'array') {
    return `${parentExpr}[${lastSeg.index}] = ${targetExpr};`;
  }
  if (lastSeg.container === 'map-value') {
    return `${parentExpr}.set(${lastSeg.keyExpr}, ${targetExpr});`;
  }
  if (lastSeg.container === 'map-key') {
    // The extracted key variable itself is the back-edge — emit Object.assign
    // to patch it in place (can't reassign a const).
    return `Object.assign(${lastSeg.varName}, ${targetExpr});`;
  }
  if (lastSeg.container === 'set') {
    return `${parentExpr}.delete(null);\n${parentExpr}.add(${targetExpr});`;
  }
  return '';
}

/**
 * Convert a primitive Map key value to its TypeScript literal expression.
 * Returns null for non-primitive keys.
 */
function primitiveKeyExpr(keyTuple: any[]): string | null {
  const tag = keyTuple[0];
  if (tag === 'string') return JSON.stringify(keyTuple[1]);
  if (tag === 'number') {
    const v = keyTuple[1];
    if (v === 'NaN') return 'NaN';
    if (v === 'Infinity') return 'Infinity';
    if (v === '-Infinity') return '-Infinity';
    return String(v);
  }
  if (tag === 'boolean') return String(keyTuple[1]);
  if (tag === 'null') return 'null';
  if (tag === 'undefined') return 'undefined';
  if (tag === 'bigint') return `BigInt(${JSON.stringify(keyTuple[1])})`;
  // Non-primitive (object key via $lmz reference)
  return null;
}

/**
 * Convert any JavaScript value to a TypeScript program string suitable for
 * type-checking with `tsc`.
 *
 * @param value - The value to serialize
 * @param typeName - The TypeScript type name to check against
 * @param typeParams - Optional map of property paths → generic type param strings
 *   (e.g., `{ "data": "<string, string | number>" }`) for Map/Set emission
 * @returns A valid TypeScript program string
 * @throws TypeError if the value contains functions or object-keyed Map value cycles
 */
export function toTypeScript(
  value: unknown,
  typeName: string,
  typeParams?: Record<string, string>,
): string {
  // Pass 1: preprocess() returns W4 format; convert to legacy tuple shape
  // for this file's walker (Phase 2 follow-up: rewrite walker to consume W4 directly).
  const w4 = preprocess(value);
  const intermediate: LmzIntermediate = w4ToLegacyTuple(w4 as { json: any; meta: { aliases?: Record<string, any> } });

  // Pass 2: Walk intermediate.root to emit TypeScript
  const visiting = new Set<number>();
  const path: PathSegment[] = [];
  const fixups: CycleFixup[] = [];
  const extractedKeys: { varName: string; expr: string }[] = [];
  let extractedKeyCounter = 0;

  // Map from object ID to the path snapshot when first visited (for cycle fixup targets)
  const idToPath = new Map<number, PathSegment[]>();

  /** Compute dot-joined property path for typeParams lookup */
  function currentPropertyPath(): string {
    return path
      .filter(seg => seg.container === 'object')
      .map(seg => (seg as { container: 'object'; key: string }).key)
      .join('.');
  }

  function walk(node: any, inMapKey: boolean): string {
    // Dispatch on tuple tag
    const tag = node[0];

    // References — dereference via objects[id]
    if (tag === '$lmz') {
      const id = node[1];

      // Cycle back-edge?
      if (visiting.has(id)) {
        const lastSeg = path[path.length - 1];
        // Degenerate: the Map key IS the cycle target (e.g., m.set(m, 'self'))
        if (inMapKey && lastSeg && lastSeg.container === 'map-key') {
          throw new TypeError('cycle in Map key not supported');
        }
        // Check if the path contains a map-value segment with null keyExpr
        if (!inMapKey && lastSeg && lastSeg.container === 'map-value' && lastSeg.keyExpr === null) {
          throw new TypeError(
            'cycle fixup not supported for Map entries with non-primitive keys'
          );
        }
        // Record fixup
        fixups.push({
          targetPath: [...(idToPath.get(id) ?? [])],
          backEdgePath: [...path],
        });
        return 'null as any';
      }

      // First visit or alias — inline
      visiting.add(id);
      idToPath.set(id, [...path]);
      const obj = intermediate.objects[id];
      const result = walkTuple(obj, inMapKey);
      visiting.delete(id);
      return result;
    }

    // Inline primitives
    return walkTuple(node, inMapKey);
  }

  function walkTuple(tuple: any, inMapKey: boolean): string {
    const tag = tuple[0];

    // Primitives
    if (tag === 'string') return JSON.stringify(tuple[1]);
    if (tag === 'number') {
      const v = tuple[1];
      if (v === 'NaN') return 'NaN';
      if (v === 'Infinity') return 'Infinity';
      if (v === '-Infinity') return '-Infinity';
      return String(v);
    }
    if (tag === 'boolean') return String(tuple[1]);
    if (tag === 'null') return 'null';
    if (tag === 'undefined') return 'undefined';
    if (tag === 'bigint') return `BigInt(${JSON.stringify(tuple[1])})`;

    // Function marker — throw
    if (tag === 'function') {
      throw new TypeError('unable to serialize function');
    }

    // Date
    if (tag === 'date') return `new Date(${JSON.stringify(tuple[1])})`;

    // RegExp
    if (tag === 'regexp') {
      const { source, flags } = tuple[1];
      return `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`;
    }

    // URL
    if (tag === 'url') return `new URL(${JSON.stringify(tuple[1].href)})`;

    // Headers
    if (tag === 'headers') {
      const entries = tuple[1] as [string, string][];
      const pairs = entries.map(
        ([k, v]) => `[${JSON.stringify(k)}, ${JSON.stringify(v)}]`
      );
      return `new Headers([${pairs.join(', ')}])`;
    }

    // Wrapper objects
    if (tag === 'boolean-object') return `new Boolean(${tuple[1]})`;
    if (tag === 'number-object') {
      const v = tuple[1];
      if (v === 'NaN') return 'new Number(NaN)';
      if (v === 'Infinity') return 'new Number(Infinity)';
      if (v === '-Infinity') return 'new Number(-Infinity)';
      return `new Number(${v})`;
    }
    if (tag === 'string-object') return `new String(${JSON.stringify(tuple[1])})`;
    if (tag === 'bigint-object') return `Object(BigInt(${JSON.stringify(tuple[1])}))`;

    // Object — one property per line for better tsc diagnostic context
    if (tag === 'object') {
      const obj = tuple[1];
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      const props = keys.map(key => {
        path.push({ container: 'object', key });
        const val = walk(obj[key], inMapKey);
        path.pop();
        return `${emitKey(key)}: ${val}`;
      });
      return '{\n' + props.map(p => `  ${p},`).join('\n') + '\n}';
    }

    // Array
    if (tag === 'array') {
      const items = tuple[1] as any[];
      const elements = items.map((item, i) => {
        path.push({ container: 'array', index: i });
        const val = walk(item, inMapKey);
        path.pop();
        return val;
      });
      return `[${elements.join(', ')}]`;
    }

    // Map — emit explicit type params when available to avoid tsc inference issues
    if (tag === 'map') {
      const entries = tuple[1] as [any, any][];
      const tp = typeParams?.[currentPropertyPath()] ?? '';
      if (entries.length === 0) return `new Map${tp}()`;
      const fixupCountBefore = fixups.length;
      const pairs = entries.map(([keyTuple, valTuple]) => {
        // Walk the key — track path for potential cycle fixups
        const varName = `__key_${extractedKeyCounter}`;
        path.push({ container: 'map-key', varName });
        const keyStr = walk(keyTuple, true);
        path.pop();
        // Determine keyExpr for potential value fixup
        const keyExpr = primitiveKeyExpr(keyTuple);
        // Check if walking this key produced any new fixups (cycle detected)
        const hasCycleInKey = fixups.length > fixupCountBefore &&
          fixups.slice(fixupCountBefore).some(f =>
            f.backEdgePath.some(s => s.container === 'map-key' && s.varName === varName));
        let keyRef: string;
        if (hasCycleInKey) {
          // Extract cyclic key to a separate variable
          extractedKeys.push({ varName, expr: keyStr });
          extractedKeyCounter++;
          keyRef = varName;
        } else {
          keyRef = keyStr;
        }
        // Walk the value
        path.push({ container: 'map-value', keyExpr: keyExpr ?? (hasCycleInKey ? varName : null) });
        const valStr = walk(valTuple, inMapKey);
        path.pop();
        return `[${keyRef}, ${valStr}]`;
      });
      return `new Map${tp}([${pairs.join(', ')}])`;
    }

    // Set — emit explicit type params when available
    if (tag === 'set') {
      const items = tuple[1] as any[];
      const tp = typeParams?.[currentPropertyPath()] ?? '';
      if (items.length === 0) return `new Set${tp}()`;
      const elements = items.map(item => {
        path.push({ container: 'set' });
        const val = walk(item, inMapKey);
        path.pop();
        return val;
      });
      return `new Set${tp}([${elements.join(', ')}])`;
    }

    // Binary types (ArrayBuffer, DataView, TypedArrays)
    if (tag === 'arraybuffer') {
      const { type, data, byteOffset, byteLength } = tuple[1];
      if (type === 'ArrayBuffer') {
        return `new ArrayBuffer(${data.length})`;
      }
      if (type === 'DataView') {
        const bufSize = data.length;
        if (byteOffset && byteOffset > 0) {
          return `new DataView(new ArrayBuffer(${bufSize}), ${byteOffset})`;
        }
        return `new DataView(new ArrayBuffer(${bufSize}))`;
      }
      if (TYPED_ARRAY_NAMES.has(type)) {
        const isBigInt = type === 'BigInt64Array' || type === 'BigUint64Array';
        const elems = isBigInt
          ? data.map((n: number | string) => `BigInt(${JSON.stringify(String(n))})`)
          : data.map((n: number) => String(n));
        return `new ${type}([${elems.join(', ')}])`;
      }
      // Fallback — shouldn't happen but be defensive
      return `new ArrayBuffer(${data.length})`;
    }

    // Error
    if (tag === 'error') {
      return emitError(tuple[1], inMapKey);
    }

    // RequestSync
    if (tag === 'request-sync') {
      return emitRequestSync(tuple[1], inMapKey);
    }

    // ResponseSync
    if (tag === 'response-sync') {
      return emitResponseSync(tuple[1], inMapKey);
    }

    // Unknown tag — defensive fallback
    throw new TypeError(`unknown tuple tag: ${tag}`);
  }

  function emitError(errorData: any, inMapKey: boolean): string {
    const { name, message, stack: _stack, cause, ...customProps } = errorData;
    const isStandard = STANDARD_ERROR_NAMES.has(name);
    const ctorName = isStandard ? name : 'Error';

    // Collect assign props
    const assignProps: string[] = [];
    if (!isStandard) {
      assignProps.push(`name: ${JSON.stringify(name)}`);
    }
    if (cause !== undefined) {
      path.push({ container: 'object', key: 'cause' });
      assignProps.push(`cause: ${walk(cause, inMapKey)}`);
      path.pop();
    }
    for (const key of Object.keys(customProps)) {
      path.push({ container: 'object', key });
      assignProps.push(`${emitKey(key)}: ${walk(customProps[key], inMapKey)}`);
      path.pop();
    }

    const ctorExpr = `new ${ctorName}(${JSON.stringify(message)})`;
    if (assignProps.length === 0) {
      return ctorExpr;
    }
    return `Object.assign(${ctorExpr}, {${assignProps.join(', ')}})`;
  }

  function emitRequestSync(data: any, inMapKey: boolean): string {
    const parts: string[] = [];

    if (data.method && data.method !== 'GET') {
      parts.push(`"method": ${JSON.stringify(data.method)}`);
    }

    // Headers is a $lmz reference
    path.push({ container: 'object', key: 'headers' });
    parts.push(`"headers": ${walk(data.headers, inMapKey)}`);
    path.pop();

    if (data.body !== null && data.body !== undefined) {
      path.push({ container: 'object', key: 'body' });
      const bodyStr = typeof data.body === 'string'
        ? JSON.stringify(data.body)
        : typeof data.body === 'object' && data.body !== null
          ? emitInlineObject(data.body)
          : 'null';
      parts.push(`"body": ${bodyStr}`);
      path.pop();
    }

    const opts = parts.length > 0 ? `, {${parts.join(', ')}}` : '';
    return `new RequestSync(${JSON.stringify(data.url)}${opts})`;
  }

  function emitResponseSync(data: any, inMapKey: boolean): string {
    const parts: string[] = [];

    parts.push(`"status": ${data.status}`);
    if (data.statusText) {
      parts.push(`"statusText": ${JSON.stringify(data.statusText)}`);
    }

    // Headers is a $lmz reference
    path.push({ container: 'object', key: 'headers' });
    parts.push(`"headers": ${walk(data.headers, inMapKey)}`);
    path.pop();

    const bodyStr = data.body === null
      ? 'null'
      : typeof data.body === 'string'
        ? JSON.stringify(data.body)
        : typeof data.body === 'object'
          ? emitInlineObject(data.body)
          : 'null';

    return `new ResponseSync(${bodyStr}, {${parts.join(', ')}})`;
  }

  /** Emit a plain JS object as a TS object literal (for RequestSync/ResponseSync body) */
  function emitInlineObject(obj: Record<string, any>): string {
    const pairs = Object.keys(obj).map(
      key => `${emitKey(key)}: ${JSON.stringify(obj[key])}`
    );
    return `{${pairs.join(', ')}}`;
  }

  // Walk the root
  const literal = walk(intermediate.root, false);

  // Assemble output
  const lines: string[] = [];
  for (const ek of extractedKeys) {
    lines.push(`const ${ek.varName} = ${ek.expr};`);
  }
  lines.push(`const __validate: ${typeName} = ${literal};`);
  for (const fixup of fixups) {
    lines.push(buildFixup(fixup));
  }

  return lines.join('\n');
}

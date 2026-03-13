/**
 * Converts JavaScript values to TypeScript programs for type-checking with tsc.
 *
 * Uses `preprocess()` from `@lumenize/structured-clone` to get the tagged-tuple
 * intermediate representation, then walks those tuples to emit TypeScript.
 *
 * @see tasks/nebula-5.2.1-structured-clone-to-typescript.md for full design
 */

import { preprocess, type LmzIntermediate } from '@lumenize/structured-clone';

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
  for (const seg of path) {
    if (seg.container === 'object') {
      result += `[${JSON.stringify(seg.key)}]`;
    } else if (seg.container === 'array') {
      result += `[${seg.index}]`;
    } else if (seg.container === 'map-value') {
      // Should not appear in the middle of a path — only as last segment
      // for Map value fixups. If it does appear mid-path, render as generic access.
      result += `.get(${seg.keyExpr})`;
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
 * @returns A valid TypeScript program string
 * @throws TypeError if the value contains functions, cyclic Map keys, or
 *         object-keyed Map value cycles
 */
export function toTypeScript(value: unknown, typeName: string): string {
  // Pass 1: preprocess() → LmzIntermediate
  const intermediate: LmzIntermediate = preprocess(value);

  // Pass 2: Walk intermediate.root to emit TypeScript
  const visiting = new Set<number>();
  const path: PathSegment[] = [];
  const fixups: CycleFixup[] = [];

  // Map from object ID to the path snapshot when first visited (for cycle fixup targets)
  const idToPath = new Map<number, PathSegment[]>();

  function walk(node: any, inMapKey: boolean): string {
    // Dispatch on tuple tag
    const tag = node[0];

    // References — dereference via objects[id]
    if (tag === '$lmz') {
      const id = node[1];

      // Cycle back-edge?
      if (visiting.has(id)) {
        if (inMapKey) {
          throw new TypeError('cycle in Map key not supported');
        }
        // Check if the path contains a map-value segment with null keyExpr
        const lastSeg = path[path.length - 1];
        if (lastSeg && lastSeg.container === 'map-value' && lastSeg.keyExpr === null) {
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

    // Object
    if (tag === 'object') {
      const obj = tuple[1];
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      const props = keys.map(key => {
        path.push({ container: 'object', key });
        const val = walk(obj[key], inMapKey);
        path.pop();
        return `${JSON.stringify(key)}: ${val}`;
      });
      return `{${props.join(', ')}}`;
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

    // Map
    if (tag === 'map') {
      const entries = tuple[1] as [any, any][];
      if (entries.length === 0) return 'new Map()';
      const pairs = entries.map(([keyTuple, valTuple]) => {
        // Walk the key — detect cyclic Map keys
        const keyStr = walk(keyTuple, true);
        // Determine keyExpr for potential fixup
        const keyExpr = primitiveKeyExpr(keyTuple);
        // Walk the value
        path.push({ container: 'map-value', keyExpr });
        const valStr = walk(valTuple, inMapKey);
        path.pop();
        return `[${keyStr}, ${valStr}]`;
      });
      return `new Map([${pairs.join(', ')}])`;
    }

    // Set
    if (tag === 'set') {
      const items = tuple[1] as any[];
      if (items.length === 0) return 'new Set()';
      const elements = items.map(item => {
        path.push({ container: 'set' });
        const val = walk(item, inMapKey);
        path.pop();
        return val;
      });
      return `new Set([${elements.join(', ')}])`;
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
      assignProps.push(`${JSON.stringify('name')}: ${JSON.stringify(name)}`);
    }
    if (cause !== undefined) {
      path.push({ container: 'object', key: 'cause' });
      assignProps.push(`${JSON.stringify('cause')}: ${walk(cause, inMapKey)}`);
      path.pop();
    }
    for (const key of Object.keys(customProps)) {
      path.push({ container: 'object', key });
      assignProps.push(`${JSON.stringify(key)}: ${walk(customProps[key], inMapKey)}`);
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
      key => `${JSON.stringify(key)}: ${JSON.stringify(obj[key])}`
    );
    return `{${pairs.join(', ')}}`;
  }

  // Walk the root
  const literal = walk(intermediate.root, false);

  // Assemble output
  const lines: string[] = [];
  lines.push(`const __validate: ${typeName} = ${literal};`);
  for (const fixup of fixups) {
    lines.push(buildFixup(fixup));
  }

  return lines.join('\n');
}

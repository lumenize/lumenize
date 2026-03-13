/**
 * Echo round-trip tests for toTypeScript()
 *
 * Pattern: toTypeScript(value) → tsc compile → vm.runInNewContext() → deepEqual
 * This catches bugs where the TypeScript output compiles but doesn't faithfully
 * reconstruct the value.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as vm from 'node:vm';
import { toTypeScript } from '../src/to-typescript';
import { RequestSync, ResponseSync } from '@lumenize/structured-clone';

// ============================================================================
// Test helpers
// ============================================================================

/** Compile TypeScript to JavaScript using tsc */
function compileTs(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: false,
    },
  });
  return result.outputText;
}

/**
 * Echo round-trip: toTypeScript → compile → eval → return value.
 * The sandbox includes constructors needed by the emitted TypeScript.
 */
function echoRoundTrip(value: unknown, typeName: string = 'any'): any {
  const tsCode = toTypeScript(value, typeName);
  const jsCode = compileTs(tsCode);
  const sandbox: Record<string, any> = {
    URL,
    Headers,
    RequestSync,
    ResponseSync,
    BigInt,
    Object,
    Map,
    Set,
    NaN,
    Infinity,
    Date,
    RegExp,
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
    ArrayBuffer,
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    Boolean,
    Number,
    String,
  };
  const ctx = vm.createContext(sandbox);
  // Append __validate as the final expression so runInContext returns it
  // (const declarations don't attach to the context object)
  return vm.runInContext(jsCode + '\n__validate;', ctx);
}

// ============================================================================
// Single-type tests
// ============================================================================

describe('toTypeScript — single types', () => {
  it('string', () => {
    expect(echoRoundTrip('hello')).toBe('hello');
  });

  it('string with special chars', () => {
    expect(echoRoundTrip('line1\nline2\t"quoted"')).toBe('line1\nline2\t"quoted"');
  });

  it('empty string', () => {
    expect(echoRoundTrip('')).toBe('');
  });

  it('number', () => {
    expect(echoRoundTrip(42)).toBe(42);
  });

  it('number zero', () => {
    expect(echoRoundTrip(0)).toBe(0);
  });

  it('number float', () => {
    expect(echoRoundTrip(3.14)).toBeCloseTo(3.14);
  });

  it('NaN', () => {
    expect(echoRoundTrip(NaN)).toBeNaN();
  });

  it('Infinity', () => {
    expect(echoRoundTrip(Infinity)).toBe(Infinity);
  });

  it('-Infinity', () => {
    expect(echoRoundTrip(-Infinity)).toBe(-Infinity);
  });

  it('boolean true', () => {
    expect(echoRoundTrip(true)).toBe(true);
  });

  it('boolean false', () => {
    expect(echoRoundTrip(false)).toBe(false);
  });

  it('null', () => {
    expect(echoRoundTrip(null)).toBe(null);
  });

  it('undefined', () => {
    expect(echoRoundTrip(undefined)).toBe(undefined);
  });

  it('bigint', () => {
    const result = echoRoundTrip(BigInt('12345678901234567890'));
    expect(result).toBe(BigInt('12345678901234567890'));
  });

  it('Date', () => {
    const d = new Date('2026-01-15T12:30:00.000Z');
    const result = echoRoundTrip(d);
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2026-01-15T12:30:00.000Z');
  });

  it('RegExp', () => {
    const re = /test\d+/gi;
    const result = echoRoundTrip(re);
    expect(result).toBeInstanceOf(RegExp);
    expect(result.source).toBe('test\\d+');
    expect(result.flags).toBe('gi');
  });

  it('RegExp with no flags', () => {
    const re = /^hello$/;
    const result = echoRoundTrip(re);
    expect(result.source).toBe('^hello$');
    expect(result.flags).toBe('');
  });

  it('URL', () => {
    const url = new URL('https://example.com/path?q=1#hash');
    const result = echoRoundTrip(url);
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe('https://example.com/path?q=1#hash');
  });

  it('Map with primitive keys', () => {
    const m = new Map<string, number>([['a', 1], ['b', 2]]);
    const result = echoRoundTrip(m);
    expect(result).toBeInstanceOf(Map);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
    expect(result.size).toBe(2);
  });

  it('Map with number keys', () => {
    const m = new Map<number, string>([[1, 'one'], [42, 'forty-two']]);
    const result = echoRoundTrip(m);
    expect(result).toBeInstanceOf(Map);
    expect(result.get(1)).toBe('one');
    expect(result.get(42)).toBe('forty-two');
  });

  it('Map with boolean key', () => {
    const m = new Map<boolean, string>([[true, 'yes']]);
    const result = echoRoundTrip(m);
    expect(result.get(true)).toBe('yes');
  });

  it('empty Map', () => {
    const result = echoRoundTrip(new Map());
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('Set', () => {
    const s = new Set([1, 'two', true]);
    const result = echoRoundTrip(s);
    expect(result).toBeInstanceOf(Set);
    expect(result.has(1)).toBe(true);
    expect(result.has('two')).toBe(true);
    expect(result.has(true)).toBe(true);
    expect(result.size).toBe(3);
  });

  it('empty Set', () => {
    const result = echoRoundTrip(new Set());
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('Headers', () => {
    const h = new Headers([['content-type', 'application/json'], ['x-custom', 'foo']]);
    const result = echoRoundTrip(h);
    expect(result).toBeInstanceOf(Headers);
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-custom')).toBe('foo');
  });
});

// ============================================================================
// Binary types
// ============================================================================

describe('toTypeScript — binary types', () => {
  it('Uint8Array', () => {
    const arr = new Uint8Array([1, 2, 3, 4]);
    const result = echoRoundTrip(arr);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it('Int16Array', () => {
    const arr = new Int16Array([-1, 0, 32767]);
    const result = echoRoundTrip(arr);
    expect(result).toBeInstanceOf(Int16Array);
    expect(Array.from(result)).toEqual([-1, 0, 32767]);
  });

  it('Float64Array', () => {
    const arr = new Float64Array([1.5, 2.5, 3.5]);
    const result = echoRoundTrip(arr);
    expect(result).toBeInstanceOf(Float64Array);
    expect(Array.from(result)).toEqual([1.5, 2.5, 3.5]);
  });

  it('BigInt64Array', () => {
    const arr = new BigInt64Array([BigInt(1), BigInt(-9223372036854775808n)]);
    const result = echoRoundTrip(arr);
    expect(result).toBeInstanceOf(BigInt64Array);
    expect(result[0]).toBe(1n);
    expect(result[1]).toBe(-9223372036854775808n);
  });

  it('ArrayBuffer — type-only (content not preserved)', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const result = echoRoundTrip(buf);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(16);
    // Content not preserved — just verifying type and size
  });

  it('DataView — type-only', () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    const result = echoRoundTrip(dv);
    expect(result).toBeInstanceOf(DataView);
    expect(result.byteLength).toBe(8);
  });

  it('DataView with offset', () => {
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf, 4);
    const result = echoRoundTrip(dv);
    expect(result).toBeInstanceOf(DataView);
    expect(result.byteOffset).toBe(4);
  });
});

// ============================================================================
// Error types
// ============================================================================

describe('toTypeScript — errors', () => {
  it('simple Error', () => {
    const err = new Error('something went wrong');
    const result = echoRoundTrip(err);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('something went wrong');
  });

  it('TypeError', () => {
    const err = new TypeError('invalid type');
    const result = echoRoundTrip(err);
    expect(result).toBeInstanceOf(TypeError);
    expect(result.message).toBe('invalid type');
  });

  it('RangeError', () => {
    const err = new RangeError('out of bounds');
    const result = echoRoundTrip(err);
    expect(result).toBeInstanceOf(RangeError);
    expect(result.message).toBe('out of bounds');
  });

  it('Error with custom properties', () => {
    const err = Object.assign(new TypeError('network failure'), {
      code: 500,
      retryable: true,
    });
    const result = echoRoundTrip(err);
    expect(result).toBeInstanceOf(TypeError);
    expect(result.message).toBe('network failure');
    expect(result.code).toBe(500);
    expect(result.retryable).toBe(true);
  });

  it('Error with cause', () => {
    const cause = new Error('root cause');
    const err = new Error('wrapper', { cause });
    const result = echoRoundTrip(err);
    expect(result.message).toBe('wrapper');
    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause.message).toBe('root cause');
  });

  it('non-standard error name', () => {
    const err = new Error('validation failed');
    err.name = 'AppError';
    const result = echoRoundTrip(err);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('validation failed');
    expect(result.name).toBe('AppError');
  });

  it('non-standard error with custom props', () => {
    const err = Object.assign(new Error('bad request'), {
      name: 'ValidationError',
      code: 422,
    });
    const result = echoRoundTrip(err);
    expect(result.message).toBe('bad request');
    expect(result.name).toBe('ValidationError');
    expect(result.code).toBe(422);
  });
});

// ============================================================================
// Wrapper objects
// ============================================================================

describe('toTypeScript — wrapper objects', () => {
  it('Boolean wrapper', () => {
    const b = new Boolean(true);
    const result = echoRoundTrip(b);
    expect(result).toBeInstanceOf(Boolean);
    expect(result.valueOf()).toBe(true);
  });

  it('Number wrapper', () => {
    const n = new Number(42);
    const result = echoRoundTrip(n);
    expect(result).toBeInstanceOf(Number);
    expect(result.valueOf()).toBe(42);
  });

  it('Number wrapper NaN', () => {
    const n = new Number(NaN);
    const result = echoRoundTrip(n);
    expect(result).toBeInstanceOf(Number);
    expect(Number.isNaN(result.valueOf())).toBe(true);
  });

  it('String wrapper', () => {
    const s = new String('hello');
    const result = echoRoundTrip(s);
    expect(result).toBeInstanceOf(String);
    expect(result.valueOf()).toBe('hello');
  });

  it('BigInt wrapper', () => {
    const b = Object(BigInt('999'));
    const result = echoRoundTrip(b);
    expect(typeof result === 'object').toBe(true);
    expect(result.valueOf()).toBe(BigInt('999'));
  });
});

// ============================================================================
// RequestSync and ResponseSync
// ============================================================================

describe('toTypeScript — RequestSync and ResponseSync', () => {
  it('RequestSync GET', () => {
    const req = new RequestSync('https://api.example.com/users');
    const result = echoRoundTrip(req);
    expect(result).toBeInstanceOf(RequestSync);
    expect(result.url).toBe('https://api.example.com/users');
    expect(result.method).toBe('GET');
  });

  it('RequestSync POST with body', () => {
    const req = new RequestSync('https://api.example.com/users', {
      method: 'POST',
      body: { name: 'Alice' },
      headers: { 'content-type': 'application/json' },
    });
    const result = echoRoundTrip(req);
    expect(result).toBeInstanceOf(RequestSync);
    expect(result.method).toBe('POST');
    expect(result.json()).toEqual({ name: 'Alice' });
    expect(result.headers.get('content-type')).toBe('application/json');
  });

  it('ResponseSync', () => {
    const res = new ResponseSync('OK', {
      status: 200,
      statusText: 'OK',
      headers: { 'x-custom': 'test' },
    });
    const result = echoRoundTrip(res);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.status).toBe(200);
    expect(result.text()).toBe('OK');
    expect(result.headers.get('x-custom')).toBe('test');
  });

  it('ResponseSync with null body', () => {
    const res = new ResponseSync(null, { status: 204 });
    const result = echoRoundTrip(res);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.status).toBe(204);
    expect(result.body).toBe(null);
  });
});

// ============================================================================
// Plain objects and arrays
// ============================================================================

describe('toTypeScript — objects and arrays', () => {
  it('simple object', () => {
    const result = echoRoundTrip({ title: 'Fix bug', done: false });
    expect(result).toEqual({ title: 'Fix bug', done: false });
  });

  it('empty object', () => {
    expect(echoRoundTrip({})).toEqual({});
  });

  it('nested object', () => {
    const obj = {
      user: { name: 'Alice', age: 30 },
      tags: ['admin', 'user'],
    };
    const result = echoRoundTrip(obj);
    expect(result).toEqual(obj);
  });

  it('array of primitives', () => {
    expect(echoRoundTrip([1, 'two', true, null])).toEqual([1, 'two', true, null]);
  });

  it('empty array', () => {
    expect(echoRoundTrip([])).toEqual([]);
  });

  it('array of objects', () => {
    const arr = [{ id: 1 }, { id: 2 }];
    expect(echoRoundTrip(arr)).toEqual(arr);
  });

  it('mixed deep object', () => {
    const obj = {
      name: 'test',
      count: 42,
      active: true,
      metadata: null,
      tags: ['a', 'b'],
      nested: {
        deep: {
          value: 'found',
        },
      },
    };
    expect(echoRoundTrip(obj)).toEqual(obj);
  });

  it('object with undefined value', () => {
    const result = echoRoundTrip({ a: 1, b: undefined });
    expect(result.a).toBe(1);
    expect(result.b).toBe(undefined);
    expect('b' in result).toBe(true);
  });
});

// ============================================================================
// Aliases
// ============================================================================

describe('toTypeScript — aliases', () => {
  it('shared object aliased at two sites', () => {
    const shared = { city: 'Portland' };
    const company = { shipping: shared, billing: shared };
    const result = echoRoundTrip(company);
    // Deep equality preserved, but not reference identity
    expect(result.shipping).toEqual({ city: 'Portland' });
    expect(result.billing).toEqual({ city: 'Portland' });
  });

  it('aliased array', () => {
    const shared = [1, 2, 3];
    const obj = { a: shared, b: shared };
    const result = echoRoundTrip(obj);
    expect(result.a).toEqual([1, 2, 3]);
    expect(result.b).toEqual([1, 2, 3]);
  });

  it('aliased Date', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const obj = { created: d, updated: d };
    const result = echoRoundTrip(obj);
    expect(result.created.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.updated.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('output has no __refN variables (aliases inlined)', () => {
    const shared = { city: 'Portland' };
    const company = { shipping: shared, billing: shared };
    const tsCode = toTypeScript(company, 'Company');
    expect(tsCode).not.toMatch(/__ref\d/);
    expect(tsCode).toContain('const __validate: Company =');
  });
});

// ============================================================================
// Cycles
// ============================================================================

describe('toTypeScript — cycles', () => {
  it('self-referencing object', () => {
    const obj: any = { id: 1 };
    obj.self = obj;
    const result = echoRoundTrip(obj);
    expect(result.id).toBe(1);
    expect(result.self).toBe(result); // Reference identity preserved for cycles
  });

  it('parent → child → parent cycle', () => {
    const parent: any = { value: 'root', children: [] };
    const child: any = { value: 'child', children: [parent] };
    parent.children.push(child);
    const result = echoRoundTrip(parent);
    expect(result.value).toBe('root');
    expect(result.children[0].value).toBe('child');
    expect(result.children[0].children[0]).toBe(result);
  });

  it('non-root cycle (B → C → B)', () => {
    const a: any = { child: { child: {} } };
    a.child.child.child = a.child;
    const result = echoRoundTrip(a);
    expect(result.child.child.child).toBe(result.child);
  });

  it('cycle produces null as any placeholder + fixup', () => {
    const obj: any = { id: 1 };
    obj.self = obj;
    const tsCode = toTypeScript(obj, 'Circular');
    expect(tsCode).toContain('null as any');
    expect(tsCode).toContain('__validate');
  });

  it('cycle in array', () => {
    const arr: any[] = [1, 2];
    arr.push(arr);
    const result = echoRoundTrip(arr);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(result);
  });

  it('Map value cycle', () => {
    const obj: any = { myMap: new Map() };
    obj.myMap.set('self', obj);
    const result = echoRoundTrip(obj);
    expect(result.myMap.get('self')).toBe(result);
  });

  it('Map value cycle with number key', () => {
    const obj: any = { myMap: new Map() };
    obj.myMap.set(42, obj);
    const result = echoRoundTrip(obj);
    expect(result.myMap.get(42)).toBe(result);
  });

  it('Map value cycle fixup uses .set()', () => {
    const obj: any = { myMap: new Map() };
    obj.myMap.set('self', obj);
    const tsCode = toTypeScript(obj, 'WithMap');
    expect(tsCode).toContain('.set(');
  });

  it('Set cycle', () => {
    const obj: any = { mySet: new Set() };
    obj.mySet.add(obj);
    const result = echoRoundTrip(obj);
    expect(result.mySet.has(result)).toBe(true);
    expect(result.mySet.size).toBe(1);
  });

  it('Set cycle fixup uses .delete(null) + .add()', () => {
    const obj: any = { mySet: new Set() };
    obj.mySet.add(obj);
    const tsCode = toTypeScript(obj, 'WithSet');
    expect(tsCode).toContain('.delete(null)');
    expect(tsCode).toContain('.add(');
  });
});

// ============================================================================
// Output format verification
// ============================================================================

describe('toTypeScript — output format', () => {
  it('acyclic produces single const assignment', () => {
    const tsCode = toTypeScript({ title: 'Fix bug', done: false }, 'Todo');
    expect(tsCode).toBe(
      'const __validate: Todo = {"title": "Fix bug", "done": false};'
    );
  });

  it('uses JSON-style quoted keys', () => {
    const tsCode = toTypeScript({ 'foo-bar': 1 }, 'T');
    expect(tsCode).toContain('"foo-bar"');
  });

  it('cyclic produces fixup mutation with bracket notation', () => {
    const obj: any = { id: 1 };
    obj.self = obj;
    const tsCode = toTypeScript(obj, 'T');
    expect(tsCode).toMatch(/__validate\["self"\] = __validate;/);
  });

  it('Map with object keys (acyclic) works fine', () => {
    const key = { id: 1 };
    const m = new Map([[key, 'value']]);
    const result = echoRoundTrip({ m });
    expect(result.m).toBeInstanceOf(Map);
    // Can't check by reference, but size should be correct
    expect(result.m.size).toBe(1);
  });
});

// ============================================================================
// Negative tests
// ============================================================================

describe('toTypeScript — negative tests', () => {
  it('symbol throws TypeError from preprocess()', () => {
    expect(() => toTypeScript(Symbol('x'), 'T')).toThrow(TypeError);
    expect(() => toTypeScript(Symbol('x'), 'T')).toThrow('unable to serialize symbol');
  });

  it('function throws TypeError', () => {
    expect(() => toTypeScript({ fn: () => {} }, 'T')).toThrow(TypeError);
    expect(() => toTypeScript({ fn: () => {} }, 'T')).toThrow(
      'unable to serialize function'
    );
  });

  it('cyclic Map key throws TypeError', () => {
    const m = new Map<any, string>();
    m.set(m, 'self');
    expect(() => toTypeScript({ m }, 'T')).toThrow(TypeError);
    expect(() => toTypeScript({ m }, 'T')).toThrow('cycle in Map key not supported');
  });

  it('object-keyed Map value cycle throws TypeError', () => {
    const obj: any = { myMap: new Map() };
    const objKey = { id: 1 };
    obj.myMap.set(objKey, obj);
    expect(() => toTypeScript(obj, 'T')).toThrow(TypeError);
    expect(() => toTypeScript(obj, 'T')).toThrow(
      'cycle fixup not supported for Map entries with non-primitive keys'
    );
  });

  it('native Request throws Error', () => {
    expect(() => toTypeScript(new Request('https://example.com'), 'T')).toThrow(
      'Cannot serialize native Request object'
    );
  });

  it('native Response throws Error', () => {
    expect(() => toTypeScript(new Response('body'), 'T')).toThrow(
      'Cannot serialize native Response object'
    );
  });
});

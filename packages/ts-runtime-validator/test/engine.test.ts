/**
 * Engine unit tests — CompilerHost, lib.d.ts, diagnostics.
 */

import { describe, it, expect } from 'vitest';
import { checkFiles } from '../src/engine';

describe('checkFiles', () => {
  it('returns empty diagnostics for valid program', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const x: number = 42;');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('returns diagnostics for type mismatch', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const x: number = "hello";');
    const result = checkFiles(files, ['test.ts']);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].message).toContain("Type 'string' is not assignable to type 'number'");
    expect(result[0].code).toBe(2322);
    expect(result[0].fileName).toBe('test.ts');
    expect(result[0].line).toBe(1);
  });

  it('returns diagnostics with line numbers', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const a: number = 1;\nconst b: string = 42;');
    const result = checkFiles(files, ['test.ts']);
    expect(result.length).toBe(1);
    expect(result[0].line).toBe(2);
  });

  it('supports two-file global scope (script mode)', () => {
    const files = new Map<string, string>();
    files.set('schema.ts', 'interface Todo { title: string; done: boolean; }');
    files.set('validate.ts', 'const __validate: Todo = {"title": "Fix bug", "done": false};');
    const result = checkFiles(files, ['schema.ts', 'validate.ts']);
    expect(result).toEqual([]);
  });

  it('reports errors from both files', () => {
    const files = new Map<string, string>();
    files.set('schema.ts', 'interface Todo { title: string }');
    files.set('validate.ts', 'const __validate: Todo = {"title": 42};');
    const result = checkFiles(files, ['schema.ts', 'validate.ts']);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].fileName).toBe('validate.ts');
  });

  it('lib.d.ts supports Map constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const m: Map<string, number> = new Map([["a", 1]]);');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports Set constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const s: Set<number> = new Set([1, 2, 3]);');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports Date constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const d: Date = new Date("2026-01-01");');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports RegExp constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const r: RegExp = new RegExp("test", "gi");');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports Error and subtypes', () => {
    const files = new Map<string, string>();
    files.set('test.ts', `
const e: Error = new Error("msg");
const te: TypeError = new TypeError("msg");
const re: RangeError = new RangeError("msg");
`);
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports Object.assign', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const e = Object.assign(new Error("msg"), {"code": 42});');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports URL constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const u: URL = new URL("https://example.com");');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports Headers constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const h: Headers = new Headers([["content-type", "text/plain"]]);');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports ArrayBuffer constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const ab: ArrayBuffer = new ArrayBuffer(16);');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports DataView constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const dv: DataView = new DataView(new ArrayBuffer(8));');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports TypedArray constructors', () => {
    const files = new Map<string, string>();
    files.set('test.ts', `
const u8: Uint8Array = new Uint8Array([1, 2, 3]);
const i32: Int32Array = new Int32Array([1, 2, 3]);
const f64: Float64Array = new Float64Array([1.5, 2.5]);
`);
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports BigInt64Array constructor', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const ba: BigInt64Array = new BigInt64Array([BigInt("1")]);');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports BigInt function', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const b: bigint = BigInt("123");');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports NaN and Infinity', () => {
    const files = new Map<string, string>();
    files.set('test.ts', 'const n: number = NaN;\nconst i: number = Infinity;');
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('lib.d.ts supports utility types', () => {
    const files = new Map<string, string>();
    files.set('test.ts', `
interface Foo { a: string; b: number; }
const p: Partial<Foo> = {};
const r: Required<Foo> = { a: "x", b: 1 };
const pk: Pick<Foo, "a"> = { a: "x" };
const rec: Record<string, number> = { x: 1 };
const o: Omit<Foo, "a"> = { b: 1 };
`);
    const result = checkFiles(files, ['test.ts']);
    expect(result).toEqual([]);
  });

  it('caches lib.d.ts SourceFile across calls', () => {
    // Two separate calls should both succeed — verifying the singleton works
    const files1 = new Map([['t.ts', 'const a: number = 1;']]);
    const files2 = new Map([['t.ts', 'const b: string = "hi";']]);
    expect(checkFiles(files1, ['t.ts'])).toEqual([]);
    expect(checkFiles(files2, ['t.ts'])).toEqual([]);
  });

  it('detects syntax errors', () => {
    const files = new Map([['test.ts', 'const x: number = ;']]);
    const result = checkFiles(files, ['test.ts']);
    expect(result.length).toBeGreaterThan(0);
  });
});

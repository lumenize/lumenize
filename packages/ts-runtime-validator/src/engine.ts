/**
 * tsc engine — virtual CompilerHost, embedded lib.d.ts, compilation + diagnostics.
 *
 * Runs the real TypeScript compiler against in-memory virtual files.
 * Platform-agnostic: works in Node.js, Bun, browsers, and Cloudflare Workers.
 *
 * @see tasks/nebula-5.2.2-validate.md for full design
 */

import ts from 'typescript';

// ---------------------------------------------------------------------------
// Embedded minimal lib.d.ts
// ---------------------------------------------------------------------------

const LIB_DTS = `\
// Minimal lib.d.ts for schema validation
// Provides global types that TypeScript's checker requires internally,
// plus constructors for all types emitted by toTypeScript().

// --- Internal compiler requirements ---
interface Array<T> { length: number; [n: number]: T; push(...items: T[]): number; indexOf(item: T): number; map<U>(fn: (item: T, index: number, array: T[]) => U): U[]; filter(fn: (item: T, index: number, array: T[]) => boolean): T[]; }
interface ReadonlyArray<T> { readonly length: number; readonly [n: number]: T; }
interface Boolean { valueOf(): boolean; }
interface CallableFunction extends Function {}
interface Function { apply(thisArg: any, argArray?: any): any; call(thisArg: any, ...argArray: any[]): any; bind(thisArg: any, ...argArray: any[]): any; }
interface IArguments { [index: number]: any; length: number; }
interface NewableFunction extends Function {}
interface Number { valueOf(): number; toFixed(fractionDigits?: number): string; }
interface Object { constructor: Function; toString(): string; valueOf(): Object; }
interface RegExp { test(string: string): boolean; exec(string: string): RegExpExecArray | null; source: string; flags: string; }
interface RegExpExecArray extends Array<string> { index: number; input: string; }
interface String { length: number; charAt(pos: number): string; indexOf(searchString: string): number; slice(start?: number, end?: number): string; }
interface Symbol {}
interface SymbolConstructor { readonly iterator: unique symbol; }
declare var Symbol: SymbolConstructor;

// Primitive type constructors (needed for type narrowing)
interface NumberConstructor { new(value?: any): Number; (value?: any): number; }
interface StringConstructor { new(value?: any): String; (value?: any): string; }
interface BooleanConstructor { new(value?: any): Boolean; (value?: any): boolean; }
declare var Number: NumberConstructor;
declare var String: StringConstructor;
declare var Boolean: BooleanConstructor;

// Template literal support
interface TemplateStringsArray extends ReadonlyArray<string> { readonly raw: readonly string[]; }

// --- Schema utility types ---
type Partial<T> = { [P in keyof T]?: T[P]; };
type Required<T> = { [P in keyof T]-?: T[P]; };
type Readonly<T> = { readonly [P in keyof T]: T[P]; };
type Pick<T, K extends keyof T> = { [P in K]: T[P]; };
type Record<K extends keyof any, T> = { [P in K]: T; };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};

// --- Iterator protocol ---
interface IteratorYieldResult<TYield> { done?: false; value: TYield; }
interface IteratorReturnResult<TReturn> { done: true; value: TReturn; }
type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;
interface Iterator<T, TReturn = any, TNext = any> { next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>; }
interface Iterable<T, TReturn = any, TNext = any> { [Symbol.iterator](): Iterator<T, TReturn, TNext>; }
interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> { [Symbol.iterator](): IterableIterator<T, TReturn, TNext>; }
interface ArrayLike<T> { readonly length: number; readonly [n: number]: T; }

// --- Map and Set (interfaces + constructors) ---
interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; readonly size: number; }
interface MapConstructor { new(): Map<any, any>; new<K, V>(entries?: readonly (readonly [K, V])[]): Map<K, V>; }
declare var Map: MapConstructor;

interface Set<T> { add(value: T): this; has(value: T): boolean; delete(value: T): boolean; readonly size: number; }
interface SetConstructor { new(): Set<any>; new<T>(values?: readonly T[]): Set<T>; }
declare var Set: SetConstructor;

interface WeakMap<K extends object, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; }
interface WeakSet<T extends object> { add(value: T): this; has(value: T): boolean; }

// --- Promise ---
interface Promise<T> { then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1) | null, onrejected?: ((reason: any) => TResult2) | null): Promise<TResult1 | TResult2>; }
interface PromiseLike<T> { then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1) | null, onrejected?: ((reason: any) => TResult2) | null): PromiseLike<TResult1 | TResult2>; }

// --- Date (interface + constructor) ---
interface Date { getTime(): number; toISOString(): string; toJSON(): string; }
interface DateConstructor { new(value: string | number): Date; new(): Date; }
declare var Date: DateConstructor;

// --- RegExp constructor ---
interface RegExpConstructor { new(pattern: string, flags?: string): RegExp; (pattern: string, flags?: string): RegExp; }
declare var RegExp: RegExpConstructor;

// --- Error types (interfaces + constructors) ---
interface Error { name: string; message: string; stack?: string; cause?: unknown; }
interface ErrorConstructor { new(message?: string, options?: { cause?: unknown }): Error; (message?: string): Error; }
declare var Error: ErrorConstructor;

interface TypeError extends Error {}
interface TypeErrorConstructor { new(message?: string, options?: { cause?: unknown }): TypeError; (message?: string): TypeError; }
declare var TypeError: TypeErrorConstructor;

interface RangeError extends Error {}
interface RangeErrorConstructor { new(message?: string, options?: { cause?: unknown }): RangeError; (message?: string): RangeError; }
declare var RangeError: RangeErrorConstructor;

interface ReferenceError extends Error {}
interface ReferenceErrorConstructor { new(message?: string, options?: { cause?: unknown }): ReferenceError; (message?: string): ReferenceError; }
declare var ReferenceError: ReferenceErrorConstructor;

interface SyntaxError extends Error {}
interface SyntaxErrorConstructor { new(message?: string, options?: { cause?: unknown }): SyntaxError; (message?: string): SyntaxError; }
declare var SyntaxError: SyntaxErrorConstructor;

interface URIError extends Error {}
interface URIErrorConstructor { new(message?: string, options?: { cause?: unknown }): URIError; (message?: string): URIError; }
declare var URIError: URIErrorConstructor;

interface EvalError extends Error {}
interface EvalErrorConstructor { new(message?: string, options?: { cause?: unknown }): EvalError; (message?: string): EvalError; }
declare var EvalError: EvalErrorConstructor;

// --- ObjectConstructor (for Object.assign in error custom properties) ---
interface ObjectConstructor {
  assign<T, U>(target: T, source: U): T & U;
  assign<T, U, V>(target: T, source1: U, source2: V): T & U & V;
}
declare var Object: ObjectConstructor;

// --- URL ---
interface URL { href: string; hostname: string; pathname: string; protocol: string; search: string; hash: string; port: string; origin: string; username: string; password: string; searchParams: any; toString(): string; toJSON(): string; }
interface URLConstructor { new(url: string, base?: string): URL; }
declare var URL: URLConstructor;

// --- Headers ---
interface Headers { get(name: string): string | null; set(name: string, value: string): void; has(name: string): boolean; delete(name: string): void; entries(): IterableIterator<[string, string]>; }
interface HeadersConstructor { new(init?: [string, string][]): Headers; }
declare var Headers: HeadersConstructor;

// --- ArrayBuffer ---
interface ArrayBuffer { readonly byteLength: number; slice(begin: number, end?: number): ArrayBuffer; }
interface ArrayBufferConstructor { new(byteLength: number): ArrayBuffer; }
declare var ArrayBuffer: ArrayBufferConstructor;
type ArrayBufferLike = ArrayBuffer;

// --- DataView ---
interface DataView { readonly buffer: ArrayBuffer; readonly byteLength: number; readonly byteOffset: number; }
interface DataViewConstructor { new(buffer: ArrayBuffer, byteOffset?: number, byteLength?: number): DataView; }
declare var DataView: DataViewConstructor;

// --- TypedArrays ---
interface Uint8Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Uint8ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Uint8Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array; new(length: number): Uint8Array; }
declare var Uint8Array: Uint8ArrayConstructor;

interface Uint8ClampedArray { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Uint8ClampedArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Uint8ClampedArray; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8ClampedArray; new(length: number): Uint8ClampedArray; }
declare var Uint8ClampedArray: Uint8ClampedArrayConstructor;

interface Int8Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Int8ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Int8Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Int8Array; new(length: number): Int8Array; }
declare var Int8Array: Int8ArrayConstructor;

interface Uint16Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Uint16ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Uint16Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint16Array; new(length: number): Uint16Array; }
declare var Uint16Array: Uint16ArrayConstructor;

interface Int16Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Int16ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Int16Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Int16Array; new(length: number): Int16Array; }
declare var Int16Array: Int16ArrayConstructor;

interface Uint32Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Uint32ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Uint32Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint32Array; new(length: number): Uint32Array; }
declare var Uint32Array: Uint32ArrayConstructor;

interface Int32Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Int32ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Int32Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Int32Array; new(length: number): Int32Array; }
declare var Int32Array: Int32ArrayConstructor;

interface Float32Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Float32ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Float32Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Float32Array; new(length: number): Float32Array; }
declare var Float32Array: Float32ArrayConstructor;

interface Float64Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: number; }
interface Float64ArrayConstructor { new(array: ArrayLike<number> | ArrayBufferLike): Float64Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Float64Array; new(length: number): Float64Array; }
declare var Float64Array: Float64ArrayConstructor;

interface BigInt64Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: bigint; }
interface BigInt64ArrayConstructor { new(array: ArrayLike<bigint> | ArrayBufferLike): BigInt64Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): BigInt64Array; new(length: number): BigInt64Array; }
declare var BigInt64Array: BigInt64ArrayConstructor;

interface BigUint64Array { readonly length: number; readonly byteLength: number; readonly byteOffset: number; readonly buffer: ArrayBufferLike; [index: number]: bigint; }
interface BigUint64ArrayConstructor { new(array: ArrayLike<bigint> | ArrayBufferLike): BigUint64Array; new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): BigUint64Array; new(length: number): BigUint64Array; }
declare var BigUint64Array: BigUint64ArrayConstructor;

// --- BigInt ---
declare type bigint = bigint;
declare function BigInt(value: string | number | bigint): bigint;

// --- NaN, Infinity ---
declare var NaN: number;
declare var Infinity: number;
`;

// ---------------------------------------------------------------------------
// Compiler options
// ---------------------------------------------------------------------------

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.None,
  skipLibCheck: true,
};

// ---------------------------------------------------------------------------
// Cached singletons
// ---------------------------------------------------------------------------

/** Cached lib.d.ts SourceFile — immutable, created once */
let cachedLibSourceFile: ts.SourceFile | undefined;

function getLibSourceFile(): ts.SourceFile {
  if (!cachedLibSourceFile) {
    cachedLibSourceFile = ts.createSourceFile(
      'lib.d.ts',
      LIB_DTS,
      ts.ScriptTarget.ESNext,
      true,
    );
  }
  return cachedLibSourceFile;
}

/** Cached base CompilerHost — immutable methods, files map swapped per call */
let cachedHost: ts.CompilerHost | undefined;
let hostFiles: Map<string, string> | undefined;

function createHost(files: Map<string, string>): ts.CompilerHost {
  hostFiles = files;
  if (!cachedHost) {
    cachedHost = {
      getSourceFile(fileName: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
        if (fileName === 'lib.d.ts') {
          return getLibSourceFile();
        }
        const content = hostFiles!.get(fileName);
        if (content !== undefined) {
          return ts.createSourceFile(fileName, content, languageVersion, true);
        }
        return undefined;
      },
      writeFile() {},
      getDefaultLibFileName: () => 'lib.d.ts',
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (f: string) => f,
      getCurrentDirectory: () => '/',
      getNewLine: () => '\n',
      fileExists: (f: string) => f === 'lib.d.ts' || hostFiles!.has(f),
      readFile: (f: string) => f === 'lib.d.ts' ? LIB_DTS : hostFiles!.get(f),
      directoryExists: () => true,
      getDirectories: () => [],
    };
  }
  return cachedHost;
}

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

export interface DiagnosticInfo {
  message: string;
  code: number;
  fileName?: string;
  line?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run tsc type-checking on virtual files and return diagnostics.
 *
 * @param files - Map of virtual file names to their content (e.g., 'schema.ts' → type defs, 'validate.ts' → generated program)
 * @param rootNames - Which files to compile (e.g., ['schema.ts', 'validate.ts'])
 * @returns Array of diagnostic info objects (empty if no errors)
 */
export function checkFiles(
  files: Map<string, string>,
  rootNames: string[],
): DiagnosticInfo[] {
  const host = createHost(files);
  const program = ts.createProgram(rootNames, COMPILER_OPTIONS, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const info: DiagnosticInfo = { message, code: d.code };

    if (d.file) {
      info.fileName = d.file.fileName;
      if (d.start !== undefined) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        info.line = pos.line + 1; // 1-based
      }
    }

    return info;
  });
}

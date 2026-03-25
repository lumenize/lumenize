# Phase 5.2.2: `validate()` — TypeScript Runtime Validation

**Status**: Complete (commit 817e8a8)
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`) — same package created in Phase 5.2.1
**Depends on**: Phase 5.2.1 (`toTypeScript()` in the same package)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**ADR**: `docs/adr/001-typescript-as-schema.md` — this task document takes precedence over the ADR until after implementation. The ADR is a permanent record and will be updated to reflect final decisions after Phase 5.2.2 is complete (see Post-Implementation below).

## Goal

A pure function that validates a JavaScript value against TypeScript type definitions at runtime by running the real TypeScript compiler. Value in, type name in, type definitions in, result out.

```typescript
import { validate } from '@lumenize/ts-runtime-validator';

const result = validate(
  { title: "Fix bug", done: false },
  'Todo',
  `interface Todo { title: string; done: boolean; }`
);
// { valid: true }

const bad = validate(
  { title: 42, done: false },
  'Todo',
  `interface Todo { title: string; done: boolean; }`
);
// { valid: false, errors: [{ message: "Type 'number' is not assignable to type 'string'", ... }] }
```

No class, no config, no opinions about versioning or storage. Consumers (the Ontology class in Phase 5.2.3, or anyone else) call it with everything it needs.

## Package Context

`validate()` lives in `@lumenize/ts-runtime-validator` alongside `toTypeScript()` (Phase 5.2.1). They're always used together: `toTypeScript()` produces the TypeScript program, `validate()` feeds it to tsc. This phase adds `validate()` and the tsc engine to the package created in 5.2.1. Publishing is deferred until the API stabilizes through real-world usage in Phase 5.2.3 (Ontology integration).

## Prerequisites

- [ ] **Move `typescript` from `devDependencies` to `dependencies`** in `packages/ts-runtime-validator/package.json`. It's currently a devDependency (used only by 5.2.1's echo test compilation), but `engine.ts` imports it at runtime. Do this first to avoid confusing import failures.

## Design

### `validate()` Signature

```typescript
function validate(
  value: unknown,
  typeName: string,
  typeDefinitions: string,
): ValidationResult
```

- **`value`** — any JavaScript value (objects, arrays, primitives, Maps, Sets, cycles, aliases — anything `@lumenize/structured-clone` handles)
- **`typeName`** — the name of the interface/type to validate against. `validate()` does NOT pre-check that `typeName` exists in `typeDefinitions` — if it's missing, tsc naturally reports "Cannot find name 'Foo'" as a diagnostic error.
- **`typeDefinitions`** — one or more TypeScript interface/type definitions as a string. **Must not be empty** — `validate()` throws `TypeError('typeDefinitions must not be empty')` if the string is empty or whitespace-only, since this is almost certainly a caller bug (the caller should check before calling). Syntax errors in non-empty `typeDefinitions` surface as normal tsc diagnostics — the caller is responsible for providing valid TypeScript.

### What Happens Inside

1. Throws `TypeError` if `typeDefinitions` is empty/whitespace-only
2. Throws `RangeError` if combined program size exceeds 256 KB (see Deferred Decisions)
3. Calls `toTypeScript(value, typeName)` (same package) to produce a TypeScript program body
4. Strips `export`/`import` from `typeDefinitions` (see Export/Import Stripping below)
5. Loads three virtual files into the CompilerHost:
   - `lib.d.ts` — the embedded minimal standard library (cached singleton, see lib.d.ts Expansion below)
   - `schema.ts` — the caller's `typeDefinitions` string (after export/import stripping)
   - `validate.ts` — the output of `toTypeScript()` (e.g., `const __validate: Todo = {...};`)
6. Runs `ts.createProgram(['schema.ts', 'validate.ts'], compilerOptions, host)` — because export/import stripping ensures neither file contains `export` or `import` keywords, TypeScript classifies both as scripts (not modules). Scripts share a single global declaration space — types declared in `schema.ts` are visible in `validate.ts` without imports, the same way multiple `<script>` tags share globals in a browser. No explicit imports between virtual files are needed. See Engine section below for compiler options.
7. Calls `ts.getPreEmitDiagnostics(program)` **without** a sourceFile filter — this returns diagnostics from both files, so syntax errors in type definitions (`schema.ts`) and validation failures (`validate.ts`) are all captured
8. Converts diagnostics using `ts.flattenDiagnosticMessageText(d.messageText, '\n')` to flatten tsc's `DiagnosticMessageChain` into a single string
9. Returns diagnostics (if any) as structured error objects

Both files are `.ts` (not `.d.ts`) so they are fully type-checked. The built-in `lib.d.ts` is the only `.d.ts` file, and `skipLibCheck: true` skips it (preventing spurious diagnostics from our minimal lib). This separation also gives meaningful per-file error locations — errors in `schema.ts` indicate invalid type definitions, errors in `validate.ts` indicate validation failures.

### Export/Import Stripping

The two-file design relies on global (script) scope — types in `schema.ts` are visible to `validate.ts` without imports. But if the caller's `typeDefinitions` contain `export` keywords (common when copying types from a codebase), TypeScript treats `schema.ts` as an ES module, hiding its types from `validate.ts`.

**Why not `.d.ts`?** `skipLibCheck: true` skips ALL `.d.ts` files (not just the default lib). Using `schema.d.ts` would mean the caller's type definitions aren't type-checked at all — syntax errors would be silently ignored. There's a `skipDefaultLibCheck` option that only skips the default lib, but `.d.ts` files with `export` are still treated as modules (types hidden), so it doesn't solve the problem either.

**Decision: strip `export`/`import` before feeding to tsc.** `validate()` preprocesses `typeDefinitions` by splitting into lines and applying regex patterns per-line before loading into the virtual FS:

1. **Strip `export` before declarations**: `/^\s*export\s+(interface|type|enum|class|const|let|var|function|async\s+function|declare|abstract)\b/` → replace `export ` with empty string. Safe for declaration-style code — these patterns are unambiguous at line boundaries. Includes `let`/`var` (less common in type definitions but possible in ambient declarations) and `async function`.
2. **Remove `export default` lines**: `/^\s*export\s+default\b/` → remove entire line.
3. **Remove re-export lines**: `/^\s*export\s*\{[^}]*\}\s*(from\s*['"][^'"]*['"])?\s*;?\s*$/` → remove entire line.
4. **Remove `import` lines**: `/^\s*import\b.*$/` → remove entire line. Imports can't resolve in the virtual FS anyway — the caller must provide self-contained type definitions.

This handles the realistic cases: vibe coders copying `export interface Foo { ... }` from their codebase, or types generated by tooling with `export` prefixes. The stripping is simple, line-based, and doesn't require an AST. Edge cases (e.g., `export` inside a string literal in a type definition) are pathological — type definitions rarely contain string literals with `export` at the start of a line.

**Test cases for stripping**:
- `export interface Foo { ... }` → `interface Foo { ... }` (type visible globally)
- `export type Bar = string` → `type Bar = string`
- `export const MAX_RETRIES = 3` → `const MAX_RETRIES = 3`
- `export let counter: number` → `let counter: number`
- `export var legacy: string` → `var legacy: string`
- `export async function fetch()` → `async function fetch()`
- `import { Baz } from './other'` → removed (self-contained requirement)
- `export { Foo, Bar }` → removed (re-export)
- `export default class MyClass { ... }` → removed
- Plain `interface Foo { ... }` (no export) → unchanged

This is a **synchronous** call — `ts.createProgram()` + `getPreEmitDiagnostics()` are synchronous APIs. No async, no DWL, no input gates. The spike confirmed ~1ms per call.

**Why not DWL?** The ADR (001-typescript-as-schema.md) originally proposed running tsc inside a DWL isolate. That's unnecessary for validation — tsc parses type definitions as data, it doesn't execute user code, so there's no sandboxing benefit. Running synchronously in the main isolate avoids wall-clock billing, input gate concerns, and async complexity. DWL is reserved for Phase 5.5/6 schema migrations, which *do* run vibe-coder-provided transform code.

### Error Format

```typescript
type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

interface ValidationError {
  message: string;      // tsc's error message, e.g., "Type 'number' is not assignable to type 'string'"
  code: number;         // tsc diagnostic code, e.g., 2322
  source: 'type-definitions' | 'value';  // Where the error originated (see below)
  line?: number;        // Line number within the source (type definitions or generated program)
  property?: string;    // Best-effort property name extracted from tsc diagnostic message (see below)
}
```

The `source` field maps the internal virtual file name to a semantic label meaningful to both vibe coders and their end users:
- **`'type-definitions'`** — error is in the caller's type definitions (e.g., syntax error, invalid TypeScript). Maps from internal `schema.ts`.
- **`'value'`** — the value doesn't conform to the type (e.g., wrong type, missing property, extra property). Maps from internal `validate.ts`.

This lets callers (the Ontology class, or end-user-facing APIs) surface actionable messages: `source: 'type-definitions'` means "the schema is broken" (vibe coder's problem); `source: 'value'` means "the data doesn't match the schema" (end user's problem). The `line` field is relative to the source — for `'type-definitions'` it's the line in the caller's type definitions string, for `'value'` it's the line in the generated program (useful for debugging but not typically surfaced to end users).

### tsc Engine (`engine.ts`)

Encapsulates the spike code from `experiments/tsc-dwl-spike/`:

- **tsc import**: `import ts from 'typescript'` — direct dependency, bundled by wrangler at deployment (see Resolved Design Decisions)
- **Virtual CompilerHost**: In-memory `Map<string, string>`, custom `getSourceFile()`, `fileExists()`, `readFile()`
- **Minimal lib.d.ts**: Custom lib expanded from the spike's 4 KB base (see lib.d.ts Expansion below)
- **Compiler options**: `strict: true`, `noEmit: true`, `target: ESNext`, `module: ts.ModuleKind.None`, `skipLibCheck: true`. `skipLibCheck` skips type-checking all `.d.ts` files — the only `.d.ts` is our minimal `lib.d.ts`, so this prevents spurious diagnostics from incomplete built-in declarations while the user's type definitions in `schema.ts` and the generated program in `validate.ts` are both fully checked. **Note on `module: None`**: This setting controls the module *emit* format, not whether TypeScript classifies a file as a module. TypeScript always treats files containing `export` or `import` keywords as modules regardless of the `module` setting — which is why export/import stripping (see above) is the real mechanism that keeps both virtual files in script (global) scope. `module: None` is a belt-and-suspenders safeguard for emit behavior, not the primary defense.

The engine is platform-agnostic — runs in Node.js, Bun, browsers, and Cloudflare Workers.

### lib.d.ts Expansion

The spike's lib.d.ts (~4 KB) was designed for simple object literal type-checking. `toTypeScript()` emits constructors and globals that need additional declarations. The lib must be expanded to cover everything `toTypeScript()` can emit:

**Already in spike lib** (keep as-is):
- `Array<T>`, `ReadonlyArray<T>`, `Boolean`/`BooleanConstructor`, `Number`/`NumberConstructor`, `String`/`StringConstructor`, `Object`, `RegExp`, `Function`, `Symbol`/`SymbolConstructor`
- `Map<K,V>` interface, `Set<T>` interface, `WeakMap`, `WeakSet`
- `Date` interface, `Promise`, `PromiseLike`
- Iterator protocol, `ArrayLike<T>`, template literal support
- Utility types: `Partial`, `Required`, `Readonly`, `Pick`, `Record`, `Exclude`, `Extract`, `Omit`, `NonNullable`

**Must add — constructors for types emitted by `toTypeScript()`:**
- `MapConstructor` — `new <K,V>(entries?: readonly (readonly [K,V])[]): Map<K,V>` (for `new Map([...])`)
- `SetConstructor` — `new <T>(values?: readonly T[]): Set<T>` (for `new Set([...])`)
- `DateConstructor` — `new (value: string | number): Date` (for `new Date("...")`)
- `RegExpConstructor` — `new (pattern: string, flags?: string): RegExp` (for `new RegExp("...", "...")`)
- `ErrorConstructor` + subtypes — `Error`, `TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError` (interfaces with `name`, `message`, `stack?`, `cause?` + constructors)
- `ObjectConstructor.assign` — `assign<T, U>(target: T, source: U): T & U` (for error custom properties)

**Must add — types not in spike lib at all:**
- `URL` — interface (`href`, `hostname`, `pathname`, etc.) + constructor `new (url: string): URL`
- `Headers` — interface (`get`, `set`, `has`, `entries`) + constructor `new (init?: [string, string][]): Headers`
- `ArrayBuffer` — interface (`byteLength`) + constructor `new (byteLength: number): ArrayBuffer`
- `ArrayBufferLike` — type needed by TypedArray constructors
- `DataView` — interface + constructor `new (buffer: ArrayBuffer, byteOffset?: number, byteLength?: number): DataView`
- TypedArray constructors — `Uint8Array`, `Uint8ClampedArray`, `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array`, `Int32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`
- `BigInt` — `declare function BigInt(value: string | number | bigint): bigint` + type declaration
- `NaN`, `Infinity` — `declare var NaN: number; declare var Infinity: number;`

**Note on `Headers`**: `Headers` is a web standard (Fetch API), not Lumenize-specific. It's included in the built-in lib alongside other web platform types like `URL`. In contrast, `RequestSync` and `ResponseSync` are Lumenize-specific types NOT included in the built-in lib — they're provided by the caller via the `typeDefinitions` parameter. The built-in lib covers standard JS/TS globals and web platform types. If `toTypeScript()` emits `new RequestSync(...)` and the caller's `typeDefinitions` don't declare `RequestSync`, tsc reports an error — which is correct behavior (the caller is responsible for declaring all non-standard types they use).

**Embedded as string constant**: The lib.d.ts content is inlined as a `const LIB_DTS: string` in `engine.ts` (~6-8 KB estimated after expansion). Small enough to inline; no filesystem access needed (critical for Workers compatibility).

### File Structure

```
packages/ts-runtime-validator/
├── src/
│   ├── index.ts             # Re-exports toTypeScript() and validate()
│   ├── to-typescript.ts     # toTypeScript() (Phase 5.2.1)
│   ├── validate.ts          # Pure validate() function + ValidationResult/ValidationError types
│   └── engine.ts            # tsc engine (virtual host, compilation, diagnostics, embedded lib.d.ts)
├── test/
│   ├── to-typescript.test.ts  # Phase 5.2.1 echo tests (existing)
│   ├── validate.test.ts       # validate() positive + negative + performance tests
│   ├── engine.test.ts         # Engine unit tests (CompilerHost caching, lib.d.ts, diagnostics)
│   └── stripping.test.ts     # Export/import stripping edge cases
├── vitest.config.ts           # Node.js vitest config (existing)
├── package.json
├── README.md
└── LICENSE
```

## Error Type Behavior (for docs)

`toTypeScript()` emits errors with full structural fidelity (Phase 5.2.1 design). Key behaviors for documentation:

- **Base `Error` type**: If the user's type says `{ error: Error }`, validation passes for any error instance. `new TypeError("message")` is structurally assignable to `Error`. This is the common case.
- **Standard subtypes**: `TypeError`, `RangeError`, etc. are structurally identical to `Error` in tsc (all have `name`, `message`, `stack`). Typing a property as `TypeError` vs `Error` makes no difference for validation.
- **Custom error classes**: `toTypeScript()` emits custom properties and `cause` via `Object.assign`: `Object.assign(new TypeError("msg"), {"code": 42})`. This enables type checking against interfaces like `interface ApiError extends Error { code: number }`. The custom class definition itself isn't needed — tsc checks structural shape, not class identity.
- **Excess property limitation**: `Object.assign` does not trigger tsc's excess property checking on errors. Extra properties won't be caught, but required properties with wrong types will be.
- **`stack` is skipped**: Runtime-specific, never meaningful for schema validation. Typed as `string | undefined` on `Error`.

Document in "Type Support" section. Key user guidance: **define error shapes as interfaces** (e.g., `interface ApiError extends Error { code: number }`), not classes — tsc checks structural assignability either way, and `toTypeScript()` emits the structural shape.

The broader validation boundaries (structural-only, no `instanceof`, no generics inference, no conditional/mapped types) are documented in Phase 5.2.1's Non-Goals section (`tasks/nebula-5.2.1-structured-clone-to-typescript.md` § Non-Goals). The docs for this package should reference those boundaries in a "What's Checked / What's Not" section.

### Set `null` Collision with Cycle Placeholders

See Phase 5.2.1 Known Limitations (`tasks/nebula-5.2.1-structured-clone-to-typescript.md` § Known Limitations → Echo Test Fidelity). Pathological edge case with no known real-world occurrence — does not affect type-checking correctness.

## Testing Strategy

### Test Organization

Tests live in `test/` alongside the existing `to-typescript.test.ts` (see File Structure above for the full listing). All tests run in Node.js via vitest (existing `vitest.config.ts` — not vitest-pool-workers). This is critical for performance measurement — Node.js doesn't stop the clock like Workers isolates do.

### Engine vs 5.2.1 Test Helpers

The 5.2.1 echo tests use `ts.transpileModule()` (quick transpile, no type checking) to compile TypeScript to JS for value reconstruction. `engine.ts` uses `ts.createProgram()` + `getPreEmitDiagnostics()` (full type checking with diagnostics). These serve different purposes — the engine is NOT an extraction of the echo test helpers. The echo tests remain as-is for `toTypeScript()` regression coverage.

### Positive Validation Tests

These verify `validate()` returns `{ valid: true }` for conforming values. Cover all types from the 5.2.1 type mapping table:

- **Primitives**: string, number, boolean, null, undefined, bigint
- **Built-in objects**: Date, RegExp, URL
- **Collections**: Array, Object (nested), Map, Set
- **Binary data**: ArrayBuffer, TypedArrays (Uint8Array, etc.), DataView
- **Errors**: Error (simple), TypeError, Error with custom properties, Error with cause
- **Wrapper objects**: `new Boolean()`, `new Number()`, `new String()`, `Object(BigInt())`
- **Web standard types**: Headers (declared in the built-in lib.d.ts)
- **Lumenize types**: RequestSync, ResponseSync (declared by the caller's `typeDefinitions`)
- **Complex graphs**: cyclic objects, aliased objects, mixed-type nested structures

Each test pairs a value with a matching type definition and asserts `{ valid: true }`.

### Performance Tests

Warm validation latency must be <5ms (spike measured 1ms). Measure using `performance.now()` in Node.js:

```typescript
// Warm up
validate(value, 'Todo', typeDefs);

const start = performance.now();
for (let i = 0; i < 100; i++) {
  validate(value, 'Todo', typeDefs);
}
const elapsed = (performance.now() - start) / 100;
expect(elapsed).toBeLessThan(5); // ms per call
```

This works because tests run in Node.js (vitest, not vitest-pool-workers), where the real-time clock advances normally during synchronous execution.

## Type-Checking Negative Tests

These tests verify that `validate()` returns `{ valid: false, errors: [...] }` with appropriate tsc diagnostics when values don't conform to types. Moved here from Phase 5.2.1 because they exercise the full `validate()` pipeline (type definitions + tsc diagnostics), not just `toTypeScript()` serialization.

- **`typeName` not in `typeDefinitions`**: `validate({}, 'Foo', 'interface Bar {}')` — tsc reports "Cannot find name 'Foo'" (usage error surfaces as a normal tsc diagnostic)
- **Wrong primitive type**: `{ title: 42 }` against `interface Todo { title: string }` — tsc error on type mismatch
- **Extra properties**: `{ title: "x", typo: true }` against `interface Todo { title: string }` — tsc excess property error
- **Missing required properties**: `{}` against `interface Todo { title: string }` — tsc missing property error
- **Wrong nested type**: `{ items: ["not a number"] }` against `interface List { items: number[] }` — tsc error in array element
- **Wrong Map value type**: `new Map([["k", 42]])` against type `Map<string, string>` — tsc assignability error
- **Wrong Error custom property**: An `Error` with `code: "str"` (string) validated against `interface ApiError extends Error { code: number }` — tsc error on `code` type mismatch. The JS input is `(() => { const e = new Error("x"); (e as any).code = "str"; return e; })()`, and `toTypeScript()` emits `Object.assign(new Error("x"), {"code": "str"})` which tsc checks against `ApiError`.

## Resolved Design Decisions

### tsc Bundle Delivery

`@lumenize/ts-runtime-validator` depends on the `typescript` npm package directly (`import ts from 'typescript'`). No pre-bundling step in this package. Moving `typescript` to `dependencies` is handled in Prerequisites above.

- **In Node.js tests**: Resolves to `node_modules/typescript` — works as-is.
- **In Workers deployment**: Wrangler's esbuild bundles `typescript` into the Worker script. The spike confirmed esbuild with `--platform=browser --minify` produces a ~3.4 MB bundle (from 23 MB unpacked). Wrangler applies equivalent settings for Workers targets.
- **Bundle size**: ~3.4 MB minified (uncompressed), ~1 MB gzipped. The Workers paid plan limit is 10 MB *compressed* — at ~1 MB gzipped, well within limits. The total Worker bundle size should be verified during integration (Phase 5.2.3) when the consuming Star Worker is assembled.
- **Unknown: wrangler bundling of `typescript`**: The spike used a manual `esbuild --platform=browser --minify` step. Wrangler also uses esbuild internally but may apply different settings (e.g., `platform`, `external`, `define`). If wrangler bundles `typescript` correctly out of the box, no action needed. If not, options are: (a) add `[build]` config to `wrangler.jsonc` with explicit esbuild settings, (b) pre-bundle `typescript` as a build step and import the bundle, or (c) use `node_compat` mode. **Action**: Test early in implementation by adding a trivial `import ts from 'typescript'` to a Worker and deploying via `wrangler dev`. This is a Node.js-only concern for Phase 5.2.2 (tests run in Node.js), but must be resolved before Phase 5.2.3 Workers integration.

### Property Path Extraction

Best-effort extraction from tsc diagnostic message text. tsc's most common error messages name the property directly in patterns like:
- `"Property 'title' is missing in type '{ done: boolean; }'"` → `property: "title"`
- `"Object literal may only specify known properties, and 'typo' does not exist in type..."` → `property: "typo"`
- `"Type 'number' is not assignable to type 'string'"` → `property: undefined` (no property named in message)

Implementation: regex patterns on `message` in `validate()`. No changes to `toTypeScript()`. The `property` field is optional (`string | undefined`) — missing extractions are expected for complex type errors. False extractions from unrelated diagnostics are acceptable since this is strictly best-effort convenience. Covers the most valuable cases: missing properties, extra properties, wrong-type properties where tsc names the field.

**Regex patterns** (applied in order, first match wins):

```typescript
// Missing property: "Property 'title' is missing in type '{ done: boolean; }'"
/Property '([^']+)' is missing/

// Excess property: "Object literal may only specify known properties, and 'typo' does not exist in type"
/and '([^']+)' does not exist in type/

// Property doesn't exist: "Property 'foo' does not exist on type 'Bar'"
/Property '([^']+)' does not exist on type/

// Note: Messages like "Type 'number' is not assignable to type 'string'" don't name a property.
// If none of the above regexes match, `property` is `undefined`. This is expected — not all
// tsc diagnostics reference a specific property.
```

Capture group 1 in each regex is the `property` value. If no regex matches, `property` is `undefined`.

### Program and Host Caching

The spike showed fresh Program creation is also ~1ms, so Program reuse is unnecessary. However, the CompilerHost and the lib.d.ts SourceFile should be cached as module-scoped singletons — they're immutable and recreating them on every call is wasteful even if cheap.

## Deferred Decisions

- **Input size limit tuning**: `validate()` includes a cheap safety guard — if the combined program text (`typeDefinitions` + `toTypeScript()` output, excluding the fixed-size embedded `lib.d.ts`) exceeds 256 KB, throw `RangeError('Combined program size exceeds 256 KB limit')` early rather than letting tsc block the event loop or OOM. `RangeError` is the standard JS error for out-of-bounds values. These are small JSON-like documents roughly equivalent to a single database row — 256 KB is generous. Sensible per-field defaults (maximum type definition size, maximum value size) are deferred to Phase 5.2.3 integration where real-world usage patterns inform the thresholds.

## Success Criteria

- [ ] `validate()`, `ValidationResult`, and `ValidationError` exported from `src/index.ts`
- [ ] `validate()` throws `TypeError` if `typeDefinitions` is empty or whitespace-only
- [ ] `validate(value, typeName, typeDefinitions)` returns `{ valid: true }` for conforming values
- [ ] `validate()` returns `{ valid: false, errors: [...] }` with clear tsc error messages for non-conforming values
- [ ] Handles all types supported by `@lumenize/structured-clone` (including cycles, aliases, Maps, Sets, etc.)
- [ ] Pure function — no class, no state, no side effects
- [ ] Synchronous — no async, no DWL, no input gates
- [ ] Warm validation latency <5ms (matching spike results)
- [ ] Works in Node.js (Cloudflare Workers verified during Phase 5.2.3 integration)
- [ ] Best-effort `property` extraction works for common single-property tsc errors (missing, extra, wrong type)
- [ ] lib.d.ts expanded with constructors for all types emitted by `toTypeScript()` (Map, Set, Date, RegExp, URL, Headers, ArrayBuffer, TypedArrays, Error subtypes, BigInt, Object.assign, NaN/Infinity)
- [ ] Export/import stripping: `typeDefinitions` with `export interface`, `import`, re-exports all handled correctly (types remain globally visible)
- [ ] Two-file virtual FS: `schema.ts` (type definitions) + `validate.ts` (generated program) — both fully type-checked; only `lib.d.ts` skipped by `skipLibCheck`
- [ ] CompilerHost and lib.d.ts SourceFile cached as module-scoped singletons
- [ ] Combined program size guard (throw if >256 KB)
- [ ] Negative type-checking tests: `typeName` not in `typeDefinitions`, wrong primitive type, extra properties, missing properties, wrong nested type, wrong Map value type, wrong Error custom property — all produce tsc diagnostics with `{ valid: false }`
- [ ] Positive validation tests: all types from 5.2.1 type mapping table return `{ valid: true }` with matching type definitions
- [ ] Performance test: warm `validate()` call <5ms measured via `performance.now()` in Node.js
- [ ] Size guard: combined program >256 KB throws `RangeError`
- [ ] Test coverage: >80% branch, >90% statement
- [ ] Documentation deferred to Phase 5.2.4 (after real-world usage in Ontology integration may surface API changes)

## Post-Implementation

- [ ] **Update ADR** (`docs/adr/001-typescript-as-schema.md`): Reconcile with final implementation decisions — two-file virtual FS design, synchronous-only (no DWL for validation), export/import stripping, `module: None`, and any other deviations from the original ADR. The ADR is the permanent record; this task doc takes precedence only during implementation.

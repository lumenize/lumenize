# ADR-001: TypeScript as Schema Validator via tsc in DWL

**Date**: 2026-03-08
**Status**: Accepted
**Deciders**: Larry
**Feeds into**: Phase 5 (Resources), Phase 6 (Schema Migration)
**Spike code**: `experiments/tsc-dwl-spike/` (gitignored)

## Context

Nebula needs runtime data validation for resource schemas. Every existing approach requires developers to learn a second type language (Zod, JSON Schema, TypeBox). We wanted to use real TypeScript `interface` and `type` definitions as the schema language — developers write types they already know, and those same types validate data at runtime.

The challenge: no production tool converts a TypeScript type string into a runtime validator without the TypeScript compiler. We evaluated four approaches.

## Decision

**Run the TypeScript compiler (`tsc`) directly inside a DWL isolate.**

> **Update (2026-03-13):** During implementation, we determined that DWL isolation is unnecessary for **validation** — tsc parses type definitions as data, it doesn't execute user code, so there's no sandboxing benefit. Validation runs **synchronously in the main isolate** (`ts.createProgram()` + `getPreEmitDiagnostics()`) — no async, no input gates, no wall-clock billing. DWL is reserved for Phase 5.5/6 **schema migrations**, which *do* run vibe-coder-provided transform code. See `tasks/nebula-5.2.2-validate.md` for details.

The `typescript` npm package (v5.9.3), bundled with `esbuild --platform=browser --format=esm --minify`, produces a 3.4 MB bundle that loads and runs inside Cloudflare's Dynamic Worker Loader (DWL). A virtual `CompilerHost` backed by an in-memory `Map<string, string>` replaces filesystem access. A minimal 4 KB `lib.d.ts` provides the global types and utility types that schema validation needs.

To validate data, construct a virtual `.ts` file:
```
interface Todo { title: string; done: boolean; }
const __validate: Todo = { title: "Fix bug", done: false };
```
Then call `ts.createProgram()` + `getPreEmitDiagnostics()`. If diagnostics are non-empty, validation failed — with real TypeScript error messages.

## Spike Results

| Metric | Result |
|--------|--------|
| **Per-call latency (warm)** | **1 ms median**, 3-5 ms p95 (n=100) |
| **Cold start (new isolate)** | 123 ms median, 148 ms p95 |
| **Bundle size** | 3,478 KB (3.4 MB minified) |
| **Program reuse** | Works but unnecessary — fresh also 1 ms |
| **Complex types** | 1 ms median for 4 interfaces + union + Record + array |

All standard TypeScript type errors detected correctly:
- Wrong field types, missing required fields, extra properties
- Invalid union members (`"superadmin"` not assignable to `Role`)
- Nested structure mismatches (missing `Address` fields)

## Alternatives Considered

| Approach | Why rejected |
|----------|-------------|
| **Ezno-WASM in DWL** | Pre-release (v0.0.23), single maintainer, Schema TypeScript subset constraint. tsc's 1ms latency eliminates the speed argument for native WASM. |
| **tsgo in Container** | Additional infrastructure (long-lived container, JSON-RPC protocol, subprocess management). Per-call latency would also be low with a warm process, but adds operational complexity that DWL avoids entirely. |
| **Compile once, validate many** | Introduces intermediate representation (Zod, JSON Schema, or generated validator). Breaks the "TypeScript IS the validator" principle. Only justified if per-call latency were >50ms. |

## Consequences

### Positive
- **TypeScript IS the schema language.** No Zod, no JSON Schema, no parallel definitions.
- **Sub-millisecond validation** on warm path. Suitable for per-request use.
- **No Container needed.** Avoids the operational complexity of a long-lived container process, JSON-RPC protocol, and container billing.
- **Full TypeScript support.** No Schema TypeScript subset. Generics, conditional types, mapped types, utility types — all work.
- **Developer-friendly errors.** `Type 'number' is not assignable to type 'string'` — every TypeScript developer knows these.
- **Zero maintenance burden.** Uses the official TypeScript compiler. No fork, no WASM build, no single-maintainer risk.

### Negative
- **~120ms cold start per isolate.** First request to a new isolate pays this. Amortized over the isolate's lifetime.
- **3.4 MB bundle** per DWL isolate instance. Within free tier limits (3 MB compressed) but not negligible.
- **Memory ceiling.** ~40-50 MB per isolate. Each call replaces the cached `Program` (old one is GC'd), so memory doesn't grow across calls. The risk is a single adversarially complex schema — mitigated by input size limits on type definitions.

### Neutral
- **`toTypeScript()` needed.** Must convert runtime JS objects to small TypeScript programs that tsc type-checks. For acyclic data this is a single `const __validate: T = { ... }` literal. For cyclic data (which Nebula supports via `@lumenize/structured-clone`), emit multi-statement programs: declare each referenced node as a `const`, then wire cycles via mutation. See "Cycle handling" below.

## Implementation Notes

### How to bundle tsc for DWL
```bash
esbuild node_modules/typescript/lib/typescript.js \
  --bundle --platform=browser --format=esm --minify \
  --outfile=dist/typescript.min.bundle
```
`--platform=browser` makes `isNodeLikeSystem()` return false, so `sys` is `undefined`. Provide a custom virtual `CompilerHost` instead.

### DWL module loading
```typescript
const worker = this.env.LOADER.get(id, () => ({
  compatibilityDate: '2025-09-12',
  mainModule: 'checker.js',
  modules: {
    'checker.js': checkerCode,           // WorkerEntrypoint with check() method
    'typescript.min.js': tscBundleCode,  // 3.4 MB bundle (text module import)
    'lib-text.js': `export default ${JSON.stringify(libDts)};`,  // 4 KB minimal lib
  },
  globalOutbound: null,
}));
```

Module names in DWL `modules` dict must end with `.js` or `.py`. For text data, wrap as a JS module that exports the string.

### Minimal lib.d.ts (~7 KB)
Custom lib declaring only what schema validation needs:
- Internal compiler requirements: `Array`, `Boolean`, `Function`, `Number`, `Object`, `RegExp`, `String`, etc.
- Schema utility types: `Partial`, `Required`, `Readonly`, `Pick`, `Record`, `Exclude`, `Omit`, `NonNullable`
- Data types: `Map`, `Set`, `Date`, `Promise`
- **Added in Phase 5.2.2**: Constructors for all types emitted by `toTypeScript()` — `MapConstructor`, `SetConstructor`, `DateConstructor`, `RegExpConstructor`, `ErrorConstructor` + subtypes (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`), `ObjectConstructor.assign`, `URL`/`URLConstructor`, `Headers`/`HeadersConstructor`, `ArrayBuffer`/`DataView`, all TypedArray constructors (`Uint8Array` through `BigUint64Array`), `BigInt` function, `NaN`/`Infinity` globals

Full `lib.es5.d.ts` (218 KB) is unnecessary.

### Virtual CompilerHost pattern
```typescript
function createVirtualHost(files: Map<string, string>) {
  return {
    getSourceFile(fileName, languageVersion) {
      const content = files.get(fileName);
      if (content !== undefined)
        return ts.createSourceFile(fileName, content, languageVersion, true);
      return undefined;
    },
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
    // ... other required methods
  };
}
```

### Cycle and alias handling

> **Update (2026-03-13):** The implementation in Phase 5.2.1 adopted an **inline-first strategy** instead of the `__refN` multi-statement approach described below. The inline-first strategy emits one big object literal whenever possible — this preserves tsc's excess property checking (which the `__refN` approach loses, since `{} as T` suppresses it). Aliases are duplicated inline; cycles use `null as any` placeholders with typed fixup mutations. See `tasks/nebula-5.2.1-structured-clone-to-typescript.md` for the full design.

The key reframe: we're not generating "object literal strings" — we're generating **tiny TypeScript programs** that construct values. tsc type-checks every statement.

**Acyclic (common case)** — single literal:
```typescript
const __validate: Todo = { title: "Fix bug", done: false };
```

**Cyclic** — inline literal with `null as any` placeholder + fixup:
```typescript
const __validate: TreeNode = {value: "root", children: [{value: "child", children: [null as any]}]};
__validate["children"][0]["children"][0] = __validate;
```

**Aliased** — duplicated inline for excess property checking:
```typescript
const __validate: Company = {shipping: {city: "Portland"}, billing: {city: "Portland"}};
```

### Two-file virtual FS (Phase 5.2.2)

> **Added 2026-03-16.** The `validate()` function uses a two-file virtual FS instead of the single-file approach shown in the spike:
>
> - **`schema.ts`** — the caller's type definitions (after export/import stripping)
> - **`validate.ts`** — the output of `toTypeScript()` (e.g., `const __validate: Todo = {title: "Fix bug", done: false};`)
>
> Both are `.ts` files (not `.d.ts`) so they are fully type-checked. The built-in `lib.d.ts` is the only `.d.ts` file, and `skipLibCheck: true` skips it. This gives meaningful per-file error locations — errors in `schema.ts` indicate invalid type definitions, errors in `validate.ts` indicate validation failures.
>
> Because neither file contains `export` or `import` keywords (stripped before loading), TypeScript classifies both as scripts sharing a single global declaration space — types in `schema.ts` are visible in `validate.ts` without imports.

### Export/import stripping (Phase 5.2.2)

> **Added 2026-03-16.** `validate()` preprocesses `typeDefinitions` by stripping `export`/`import` keywords line-by-line before loading into the virtual FS. This ensures TypeScript treats `schema.ts` as a script (global scope) rather than an ES module (which would hide types from `validate.ts`). Handles `export interface`, `export type`, `export const`, `import` lines, re-exports, and `export default`.

### Compiler options (Phase 5.2.2)

> **Added 2026-03-16.** `strict: true`, `noEmit: true`, `target: ESNext`, `module: ts.ModuleKind.None`, `skipLibCheck: true`. The `module: None` setting is a belt-and-suspenders safeguard — export/import stripping is the primary mechanism keeping both virtual files in script (global) scope.

### Unquoted object keys (Phase 5.2.2)

> **Added 2026-03-16.** `toTypeScript()` emits unquoted object keys when they are valid JavaScript identifiers (e.g., `{title: "Fix bug"}` instead of `{"title": "Fix bug"}`). Keys with special characters are still quoted (e.g., `{"foo-bar": 1}`). This produces cleaner tsc diagnostic messages — e.g., `'typo' does not exist in type` instead of `'"typo"' does not exist in type`.

## Open Questions for Phase 5

- ~~`toTypeScript()` scope — how much of `structured-clone`'s `preprocess()` is reusable for generating TypeScript programs?~~ Resolved: custom walk in `@lumenize/ts-runtime-validator`, same `WeakMap` pattern but own traversal. See Phase 5.2.1 task.
- ~~Input size limits and timeout guards for adversarial schemas~~ Resolved: `validate()` throws `RangeError` if combined program text exceeds 256 KB. Per-field defaults deferred to Phase 5.2.3 integration.
- Deployed Workers performance vs local wrangler dev

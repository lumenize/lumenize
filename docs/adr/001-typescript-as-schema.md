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

### Minimal lib.d.ts (4 KB)
Custom lib declaring only what schema validation needs:
- Internal compiler requirements: `Array`, `Boolean`, `Function`, `Number`, `Object`, `RegExp`, `String`, etc.
- Schema utility types: `Partial`, `Required`, `Readonly`, `Pick`, `Record`, `Exclude`, `Omit`, `NonNullable`
- Data types: `Map`, `Set`, `Date`, `Promise`

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

### Cycle handling via multi-statement programs

The key reframe: we're not generating "object literal strings" — we're generating **tiny TypeScript programs** that construct values. tsc type-checks every statement.

**Acyclic (common case)** — single literal:
```typescript
const __validate: Todo = { title: "Fix bug", done: false };
```

**Cyclic** — a tree where parent references a child array of the same type:
```typescript
interface TreeNode {
  value: string;
  children: TreeNode[];
}
```
```
root = {
  value: "root",
  children: [
    {
      value: "child",
      children: [ → root ]   // circular reference back to root
    }
  ]
}
```

Multi-statement program with declaration + mutation:
```typescript
const __ref0 = {} as TreeNode;
const __ref1 = {} as TreeNode;
__ref0.value = "root";
__ref0.children = [__ref1];
__ref1.value = "child";
__ref1.children = [__ref0];  // cycle — tsc checks this assignment
```

**Aliased** — shipping and billing point to the same `Address` object:
```typescript
interface Address {
  city: string;
}
interface Company {
  shipping: Address;
  billing: Address;
}
```
```
shared = { city: "Portland" }

company = {
  shipping: → shared,
  billing:  → shared    // same object, not a copy
}
```

Shared references use the same `__refN` variable:
```typescript
const __ref0 = {} as Address;
__ref0.city = "Portland";
const __validate: Company = {"shipping": __ref0, "billing": __ref0};
```

The `as T` on the empty object is safe because every field is immediately assigned — and tsc checks each property assignment against the type. This maps directly to `@lumenize/structured-clone`'s existing `preprocess()` infrastructure, which already tracks reference IDs and identifies back-reference edges. The serialization format just changes from tagged tuples to TypeScript statements:

1. **First pass**: Emit `const __refN = {} as T;` for every aliased/cycled node
2. **Second pass**: Emit `__refN.field = value;` for each property, where `value` is either a literal or another `__refN` reference

## Open Questions for Phase 5

- ~~`toTypeScript()` scope — how much of `structured-clone`'s `preprocess()` is reusable for generating TypeScript programs?~~ Resolved: custom walk in `@lumenize/ts-runtime-validator`, same `WeakMap` pattern but own traversal. See Phase 5.2.1 task.
- Input size limits and timeout guards for adversarial schemas
- Deployed Workers performance vs local wrangler dev

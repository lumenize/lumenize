# Phase 5.2.2: `validate()` — TypeScript Runtime Validation

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`) — same package created in Phase 5.2.1
**Depends on**: Phase 5.2.1 (`toTypeScript()` in the same package)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**ADR**: `docs/adr/001-typescript-as-schema.md`

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

`validate()` lives in `@lumenize/ts-runtime-validator` alongside `toTypeScript()` (Phase 5.2.1). They're always used together: `toTypeScript()` produces the TypeScript program, `validate()` feeds it to tsc. This phase adds `validate()` and the tsc engine to the package created in 5.2.1, then publishes the package to npm.

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
- **`typeName`** — the name of the interface/type to validate against (must exist in `typeDefinitions`)
- **`typeDefinitions`** — one or more TypeScript interface/type definitions as a string

### What Happens Inside

1. Calls `toTypeScript(value, typeName)` (same package) to produce a TypeScript program body
2. Prepends the `typeDefinitions` string
3. Feeds the combined program to tsc via virtual CompilerHost
4. Returns diagnostics (if any) as structured error objects

This is a **synchronous** call — `ts.createProgram()` + `getPreEmitDiagnostics()` are synchronous APIs. No async, no DWL, no input gates. The spike confirmed ~1ms per call.

### Error Format

```typescript
interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

interface ValidationError {
  message: string;      // tsc's error message, e.g., "Type 'number' is not assignable to type 'string'"
  code: number;         // tsc diagnostic code, e.g., 2322
  line?: number;        // Line in the generated program (for debugging)
  property?: string;    // Extracted property path if determinable from the diagnostic
}
```

### tsc Engine (`engine.ts`)

Encapsulates the spike code from `experiments/tsc-dwl-spike/`:

- **Bundle**: `esbuild --platform=browser --format=esm --minify` → 3.4 MB
- **Virtual CompilerHost**: In-memory `Map<string, string>`, custom `getSourceFile()`, `fileExists()`, `readFile()`
- **Minimal lib.d.ts**: 4 KB custom lib with primitives, Array, Record, Partial, Pick, Omit, etc.
- **Compiler options**: `strict: true`, `noEmit: true`, `target: ESNext`

The engine is platform-agnostic — runs in Node.js, Bun, browsers, and Cloudflare Workers.

### File Structure

```
packages/ts-runtime-validator/
├── src/
│   ├── index.ts             # Re-exports toTypeScript() and validate()
│   ├── to-typescript.ts     # toTypeScript() (Phase 5.2.1)
│   ├── validate.ts          # Pure validate() function
│   ├── engine.ts            # tsc engine (virtual host, compilation, diagnostics)
│   ├── types/
│   │   └── validation.ts    # ValidationResult, ValidationError types
│   └── lib/
│       └── lib.d.ts         # Minimal 4 KB lib for tsc
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

## Open Questions

### Engine

- **tsc bundle delivery**: The 3.4 MB tsc bundle needs to get into the app. Options: (a) pre-built and checked in, (b) built during `npm run build` via esbuild, (c) built during postinstall. Option (b) is cleanest — the bundle is a build artifact, not source.
- **Program caching**: The spike showed Program reuse is unnecessary (fresh also 1ms). But should the engine cache the CompilerHost or lib.d.ts SourceFile across calls? Probably yes for the lib — it never changes.
- **Input size limits**: What's the maximum type definition size? Maximum value size? Need guards against adversarial inputs that blow up tsc memory or time.
- **Error property extraction**: tsc diagnostics reference line/column in the generated program. Can we map these back to property paths in the original value? This would make errors like `"todo.assigneeId: Type 'number' is not assignable to type 'string'"` instead of just the tsc message.

### Bundle Size

- The tsc bundle (3.4 MB) is now part of the Star's Worker bundle. Workers paid plan allows 10 MB compressed. Need to verify the total bundle stays under the limit.
- For context, `typescript` itself is 23 MB unpacked. 3.4 MB minified is reasonable.

## Success Criteria

- [ ] `validate(value, typeName, typeDefinitions)` returns `{ valid: true }` for conforming values
- [ ] `validate()` returns `{ valid: false, errors: [...] }` with clear tsc error messages for non-conforming values
- [ ] Handles all types supported by `@lumenize/structured-clone` (including cycles, aliases, Maps, Sets, etc.)
- [ ] Pure function — no class, no state, no side effects
- [ ] Synchronous — no async, no DWL, no input gates
- [ ] Warm validation latency <5ms (matching spike results)
- [ ] Works in Node.js and Cloudflare Workers
- [ ] `@lumenize/ts-runtime-validator` published to npm
- [ ] Documentation at `website/docs/ts-runtime-validator/`
- [ ] Test coverage: >80% branch, >90% statement

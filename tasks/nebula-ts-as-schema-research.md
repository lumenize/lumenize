# TypeScript as Schema — Research

**Phase**: 4.1
**Status**: Pending
**Depends on**: Phase 4.0 (hands-on experience with DWL and Containers)
**Master task file**: `tasks/nebula.md`
**Deliverable**: Spike results and architecture decision for TypeScript-as-schema validation in Phase 5/6
**Audience**: Internal — informs Phase 5 (Resources) and Phase 6 (Schema Migration)

## The Core Vision

**Nebula's goal**: TypeScript itself IS the schema language. Not Zod, not JSON Schema, not TypeBox — real TypeScript `interface` and `type` definitions. Developers write types they already know, and those types cross the network as plain strings to do three jobs:

1. **Runtime data validation** — does this object conform to this TypeScript type?
2. **LLM prompt engineering** — the TypeScript types ARE the ideal prompt format (no conversion needed)
3. **IDE type-checking** — LLM writes TypeScript code against the types, `tsgo` validates it compiles

This would make Nebula the first system to use real TypeScript as the schema input. We will only give up this goal after exhausting every avenue.

### Why This Matters

Every other schema system requires developers to learn a second type language:
- Zod: `z.object({ name: z.string() })` — parallel to TypeScript, but not TypeScript
- JSON Schema: `{ "type": "object", "properties": { "name": { "type": "string" } } }` — verbose, foreign
- TypeBox: `Type.Object({ name: Type.String() })` — closer, but still not TypeScript

With TypeScript-as-schema, developers write `interface Todo { title: string; done: boolean; }` and that string IS the schema. It crosses the network as plain text. No conversion, no parallel definition, no getting out of sync.

For LLM prompts, this is especially powerful: codemode's `generateTypes()` converts Zod/JSON Schema → TypeScript strings. We skip that entirely — the types are already TypeScript. The LLM sees the real types, writes real TypeScript, and `tsgo` validates the result.

### The Fundamental Challenge

**No production tool takes a TypeScript type string and produces a runtime validator without the TypeScript compiler.** TypeScript's type system is Turing-complete — fully evaluating a type requires a full type checker. The landscape:

| Tool | Takes type strings? | At runtime? | No build step? | Real TS syntax? |
|------|-------------------|-------------|----------------|-----------------|
| **typia** | No (generic params) | No (AOT) | No | Yes |
| **ts-runtime-checks** | No (transformer) | No (AOT) | No | Yes |
| **ArkType** | Yes (DSL strings) | Yes | Yes | No (look-alike DSL) |
| **ts-json-schema-generator + ajv** | No (file paths) | Slow init | Yes-ish | Yes |
| **TypeScript compiler API** | Yes (virtual files) | Yes | Yes | Yes |
| **tsgo** | Yes (virtual FS + `--api` JSON-RPC) | Yes (subprocess) | Yes | Yes |

Only the TypeScript compiler itself (heavy, ~23.6 MB) and tsgo (Go binary, subprocess/JSON-RPC) can validate actual TypeScript type strings at runtime. Both are impractical for hot-path per-request validation but viable for "compile once, cache the result" patterns.

**ArkType** accepts string definitions at runtime (`type("{ name: string, age: number }")`) but it's a TypeScript look-alike DSL, not real TypeScript. No `interface`, `type` aliases, generics, conditional types, mapped types, or utility types.

## Three Candidate Architectures

There are three fundamentally different approaches. They differ on two axes: (1) is TypeScript the validator itself, or just the source that generates a validator? (2) where does the compiler run?

### Approach A1: "TypeScript IS the Validator — in DWL" (Most Exciting)

**The dream scenario.** The JS-based TypeScript compiler (`typescript` npm package) runs directly inside a DWL isolate. No Container needed at all.

**How it works**:
1. Developer writes TypeScript types as plain strings
2. Runtime data arrives. `@lumenize/structured-clone`'s `toLiteralString()` converts it to a TypeScript literal string
3. Construct a virtual `.ts` file: type definition + `const x: TaskType = <literal>`
4. Inside a DWL isolate, run `ts.createProgram` with a custom `CompilerHost` serving virtual files, then `getSemanticDiagnostics()`
5. If diagnostics are non-empty → validation failed, with real TypeScript error messages

**Why this might work**: The `typescript` npm package is pure JavaScript — no native bindings, no filesystem requirement when using a custom `CompilerHost`. `zod-to-ts` (used by codemode) already proves that parts of the TypeScript package can be bundled and run in Workers. The question is whether the full compiler — including the type-checker — can run in a DWL isolate.

**What needs to be spiked**:
- [ ] **Bundle size**: `typescript` is ~23.6 MB. Can DWL load a module this large? (DWL modules are code strings in memory — test the actual limit)
- [ ] **Memory**: Does `ts.createProgram` + `getSemanticDiagnostics` on a single virtual file fit within the 128MB Worker memory limit?
- [ ] **Cold start**: How long to initialize the TS compiler in a DWL isolate? (First invocation vs. cached isolate)
- [ ] **Per-validation latency**: `createProgram` + `getSemanticDiagnostics` on a single file with ~10 types + 1 literal
- [ ] **Compiler reuse**: Can we keep a `ts.Program` instance alive across calls (DWL isolate caching) or must we recreate per-request?
- [ ] **Tree-shaking**: Can we bundle only the type-checker and strip the emitter, transpiler, etc.? What's the minimum viable subset of `typescript` for `getSemanticDiagnostics`?

**If this works**: Eliminates the Container entirely for type validation. No 2-3s cold start, no Container billing, no JSON-RPC subprocess communication, no long-lived service management. Type-checking runs in the same V8 isolate tier as guard dispatch. The DWL isolate already exists for resource guards — we just add the TS compiler to its module dictionary.

**Why `tsc` (not `tsgo`) is fine here**: `tsgo` is 10x faster than `tsc`, but that's for large projects. For a single virtual file with a handful of types, `tsc` should be single-digit milliseconds. And `tsc` is pure JS — it runs in V8 natively. `tsgo` is a Go binary that can't run in V8.

### Approach A2: "TypeScript IS the Validator — in Container"

The pure approach with `tsgo`. Falls back here if A1's DWL constraints are too tight.

**How it works**:
1. Developer writes TypeScript types as plain strings
2. Runtime data arrives. `@lumenize/structured-clone`'s `toLiteralString()` converts it to a TypeScript literal string
3. Construct a virtual `.ts` file: type definition + `const x: TaskType = <literal>`
4. Feed to `tsgo --noEmit` (or `tsgo --api` JSON-RPC) in a Cloudflare Container
5. If tsgo reports errors → validation failed, with real TypeScript error messages

**When to prefer A2 over A1**:
- If A1's bundle size or memory limits are hit (e.g., complex type sets exceeding 128MB)
- If per-validation latency of `tsc` in DWL is too slow but `tsgo` (10x faster) is acceptable
- If we need `tsgo`-specific features (faster, lower memory, Go-native performance)

**Trade-off vs A1**: Requires Container infrastructure (cold start, billing, long-lived service management) but gets 10x better performance and higher memory limits (up to 12GB).

### `toLiteralString()` — Shared by Both A1 and A2

**Why `toLiteralString()` is practical**: `@lumenize/structured-clone` already has a `preprocess()` function that walks arbitrary objects and handles every type (Map, Set, Date, Error, cycles, aliases, TypedArrays). The case-statement structure for each type already exists. A `toLiteralString()` mode just changes the output format:

| Type | Current `preprocess()` output | `toLiteralString()` output |
|------|-------------------------------|---------------------------|
| `Date` | `["date", "2025-01-15T..."]` | `new Date("2025-01-15T...")` |
| `Map` | `["map", [["k","v"]]]` | `new Map([["k","v"]])` |
| `Set` | `["set", ["a","b"]]` | `new Set(["a","b"])` |
| Object | `["object", {...}]` | `{ title: "Fix bug", done: false }` |
| Array | `["array", [...]]` | `["item1", "item2"]` |
| `RegExp` | `["regexp", {source, flags}]` | `/pattern/flags` |

**Open question — cycles**: TypeScript can't express circular references in literals. Options: (a) reject cyclic data in validation (validator only, not serializer), (b) use `let` + mutation in the constructed file, (c) separate cycle-containing objects into their own validation pass.

**Why both A approaches are preferred**: The TypeScript type definition IS the validator — no Zod, no JSON Schema, no generated code, no intermediate format. The error messages are real TypeScript errors ("Type 'number' is not assignable to type 'string'"). The vibe coder never learns a second type language. And the validator automatically supports the full TypeScript type system — generics, unions, intersections, mapped types, conditional types, utility types — anything the compiler supports.

### Approach B: "Compile Once, Validate Many"

The pragmatic fallback. TypeScript is the source, but a generated validator runs at runtime.

**How it works**:
1. Developer writes TypeScript types as plain strings
2. At deploy time (or when types change), types are sent to a compilation service (Container with tsgo, or DWL with tsc)
3. Compiler emits a validator — could be:
   - (a) A typia-style optimized validation function (generated JS code)
   - (b) JSON Schema output (via ts-json-schema-generator) + ajv compilation
   - (c) Custom validator descriptor format
4. Validator is cached in KV and served to DWL for hot-path validation (microsecond execution)
5. When types change, recompile and update the cached validator

**Trade-offs**: Much faster per-validation (microseconds vs milliseconds). But introduces an intermediate representation — you're back to "TypeScript generates something else that actually validates." The "something else" could drift from the types. And you can only support the subset of TypeScript that the compiler-to-validator pipeline handles (typia doesn't support all TS features).

**When this wins**: If both A1 and A2 per-validation latency is too high (>50ms), or for extremely high-frequency validation (millions of ops/sec).

### Decision Framework

**Spike priority order** (try A1 first — if it works, we're done):

1. **Spike A1**: Bundle `typescript` into a DWL isolate, run `ts.createProgram` + `getSemanticDiagnostics` on a virtual file. Measure bundle size, memory, cold start, and per-validation latency.
   - If < 10ms and fits in DWL: **A1 wins. No Container needed. Stop here.**
2. **Spike A2** (only if A1 fails): Run `tsgo --api` in a Container, feed it the same virtual file. Measure cold start, per-validation latency.
   - If < 10ms warm: A2 for all validation.
   - If 10-50ms warm: A2 for writes (already paying for DWL round-trip), consider Approach B for reads.
3. **Spike B** (only if both A fail): Evaluate typia/ts-json-schema-generator as compilation service.

## Research Questions

### By Approach

**Approach A1 — `tsc` in DWL (highest priority)**:
- [ ] Can DWL load a ~23.6 MB `typescript` module? What's the DWL module size limit?
- [ ] Can we tree-shake `typescript` to just the type-checker? (Strip emitter, transpiler, language service, etc.)
- [ ] Memory footprint of `ts.createProgram` + `getSemanticDiagnostics` on a single virtual file
- [ ] Per-validation latency with ~10 type definitions + 1 literal
- [ ] Cold start: first `createProgram` call vs subsequent calls in same isolate
- [ ] Can `CompilerHost` be set up to serve only virtual files (no `fs` module needed)?
- [ ] Does the `typescript` package import Node.js modules that aren't available in Workers? (May need shims)

**Approach A2 — `tsgo` in Container (fallback)**:
- [ ] `tsgo --noEmit` latency on a warm Container for a single virtual file with ~10 type definitions + 1 literal
- [ ] Same benchmark at ~100 types, ~1000 types (how does type complexity affect check time?)
- [ ] Can `tsgo --api` JSON-RPC accept virtual files without disk I/O?
- [ ] Can we keep a tsgo process warm in a Container and call it repeatedly via JSON-RPC?
- [ ] Error message quality — are tsgo's errors useful for vibe coders, or too compiler-speak?

**Shared A1/A2 questions**:
- [ ] `toLiteralString()` implementation complexity — how much of `preprocess()` can be reused?
- [ ] Cycle handling strategy — what does tsc/tsgo do with `let x: T = ...; x.self = x;`?

**Approach B — Compile once (last resort)**:
- [ ] Can typia run as a compilation service (feed it type strings, get back validator JS)?
- [ ] Can `ts-json-schema-generator` run with virtual files (not disk)?
- [ ] What subset of TypeScript does each pipeline support? (generics? mapped types? conditional types?)

### Crosscutting

- [ ] Does tsgo's `@typescript/api` npm package support virtual file systems? (Docs mention `createVirtualFileSystem`)
- [ ] Could we write a restricted-subset TS type parser for the common 80% of cases (objects, primitives, unions, arrays, optional) and run it in DWL without the full compiler? Fall back to tsc/tsgo for the other 20%?

### Nebula-Specific

- [ ] Can we use codemode's `Executor` interface for our DWL executor? (It's minimal enough — `execute(code, fns) → ExecuteResult`)
- [ ] Can we adapt codemode's `ToolDispatcher extends RpcTarget` pattern for Nebula's DWL → DO communication?
- [ ] For Nebula IDE: what's the feedback loop? TS types → LLM writes TypeScript → `tsgo --noEmit` validates → type errors back to LLM → retry
- [ ] Can we run `tsgo --api` as a long-lived JSON-RPC service in a Container and call it from DOs via the paired DO's fetch proxy?
- [ ] Does Sandbox SDK's `exec()` + `writeFile()` API simplify the tsgo workflow vs raw Containers?
- [ ] What's the best "compile once, validate many" pipeline? TS types → tsgo → (typia validator JS | JSON Schema + ajv | custom) → cached in KV/DWL
- [ ] Could a restricted-subset TS type parser (handling 80% of cases: objects, primitives, unions, arrays, optional) run in DWL without the full compiler?

## tsgo (TypeScript 7) — The Key Enabler

**Status**: Stable, released January 15, 2026. `@typescript/native-preview` on npm.

| Project | tsc | tsgo | Speedup |
|---------|-----|------|---------|
| VS Code (1.5M lines) | 89s | 8.74s | 10.2x |
| Sentry codebase | 60s+ | <7s | ~10x |
| Small projects (<100K) | varies | varies | 2-5x |
| Memory usage | 68,645 KB | 23,733 KB | 2.9x less |

**Binary**: ~27MB standalone Go binary. `tsgo --noEmit` is a drop-in for `tsc --noEmit`. Runs in a Cloudflare Container.

**`--api` mode**: JSON-RPC interface for programmatic access. Could be a long-lived service in a Container.

**`@typescript/api`**: npm wrapper providing `createCompilerHost`, `createProgram`, `createVirtualFileSystem`. This is the programmatic interface for the "TypeScript string in, diagnostics/artifacts out" pattern.

**Limitations**: JS emit only supports ES2021+; Strada API not supported; WASM story weaker than Rust's (relevant for browser playgrounds).

### Rust-Based Alternatives — None Viable

| Project | Status | Notes |
|---------|--------|-------|
| **STC** (Speedy TypeScript Checker) | Abandoned Jan 2024 | 1:1 tsc parity proved impossible for solo dev |
| **Ezno** | Experimental | Intentionally NOT tsc-compatible; missing inference, narrowing, async, collections |
| **Oxc/tsgolint** | Alpha (linting only) | Rust frontend delegates to tsgo for type info — even the Rust ecosystem chose tsgo |

**Bottom line**: `tsgo` is the only viable fast alternative. Every other effort has been abandoned, is years from production, or chose to build on top of tsgo rather than compete.

## How This Connects to the Nebula IDE

For the Nebula IDE (Claude Code-like interface), the TypeScript-as-schema approach creates a unified pipeline where one set of types does everything:

1. **Schema authoring**: Developer writes TypeScript types in the IDE. These are the "API surface" for their Nebula resources.
2. **LLM context**: The TypeScript types go directly into the LLM prompt — no `generateTypes()` conversion. The LLM sees `interface Todo { title: string; done: boolean; }` and writes code against it.
3. **LLM output validation**: The LLM writes TypeScript (not JavaScript like codemode). `tsgo --noEmit` validates the code compiles against the types. Type errors feed back to the LLM for self-correction.
4. **Runtime data validation**: When data arrives at the resource layer, `toLiteralString()` converts it to a TypeScript literal and tsgo validates it against the same types the LLM coded against. Same compiler, same types, same error messages.

This is a unified type story: one set of TypeScript types serves schema definition, LLM prompting, code validation, and runtime data validation. No Zod, no JSON Schema, no parallel definitions. The TypeScript compiler is the single source of truth for "does this data/code conform to these types?"

If Approach A1 works (tsc in DWL), steps 3 and 4 both run in V8 isolates — no Container needed for either. If A1 doesn't fit, A2 uses the same tsgo Container service for both. Either way, one infrastructure investment, two use cases.

## Known Gotchas

- **No "TS string → validator" tool exists** — the ecosystem gap. Every approach requires either the full TS compiler or a restricted subset parser. This is the key technical risk for TypeScript-as-schema.
- **tsgo WASM story is weak** — Go's WASM output is large and slow. Running tsgo in-browser (for IDE type-checking) would need the Container service, not client-side WASM.
- **codemode instructs LLMs to write JavaScript only** — no TypeScript syntax. Nebula IDE will need LLMs to write TypeScript instead.

## Feed-Forward to Phase 5/6 (Resources)

Document findings here that affect downstream phases:

- [ ] vitest-pool-workers DWL support status — if not working, Resources tests need alternative harness
- [ ] Mesh bundle size (~100KB) — acceptable for DWL module loading? Performance impact?
- [ ] DWL isolate caching behavior — does Resources need its own caching/warmup strategy?
- [ ] Error propagation patterns — how do DWL errors surface in DO stack traces? Affects error handling design.
- [ ] tsgo Container architecture — long-lived `--api` service vs on-demand CLI? Affects billing and latency for schema validation.
- [ ] codemode `Executor` interface — worth implementing for Resources, or overkill?
- [ ] TypeScript-as-schema pipeline — Approach A1 (tsc in DWL) vs A2 (tsgo in Container) vs B (compile once). A1 spike is the deciding factor.
- [ ] `toLiteralString()` implementation scope for `@lumenize/structured-clone` — how much of `preprocess()` is reusable? Cycle handling strategy?
- [ ] Restricted-subset TS parser feasibility — if viable, Resources validation could run entirely in DWL without Container dependency for common types.

## Success Criteria

- [ ] **Critical spike**: `tsc` (`typescript` npm) in DWL — bundle size, memory, per-validation latency. If this works, Container not needed for type validation.
- [ ] **Fallback benchmark**: `tsgo --noEmit` per-validation latency (single virtual file, warm Container) — only if DWL spike fails
- [ ] `tsgo --api` JSON-RPC mode evaluated as a long-lived compilation service
- [ ] `toLiteralString()` mode prototyped in `@lumenize/structured-clone` (output TS literal strings from runtime data)
- [ ] Architecture decision documented: A1, A2, or B — with benchmark data
- [ ] Feed-forward findings documented and actionable for Phase 5/6

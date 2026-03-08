# TypeScript as Schema — Research

**Phase**: 4.1
**Status**: **COMPLETE** — Spike A1 confirmed tsc in DWL at 1ms/call. Decision captured in `docs/adr/001-typescript-as-schema.md`. Wire format idea explored and dropped (AST reconstruction = second deserializer with no advantage).
**Depends on**: Phase 4.0 (complete — DWL benchmarks, tsgo benchmarks, codemode evaluation)
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

## Phase 4.0 Benchmark Learnings

These findings from the DWL and tsgo benchmarks (phase 4.0) directly inform spike priorities:

### DWL Performance Profile (wrangler 4.71.0, local)

| Metric | Result | Implication |
|--------|--------|-------------|
| **Isolate cold start** | 1 ms median, 2 ms p95 | Cold start is negligible — even first-load latency is acceptable |
| **Isolate warm (cached)** | &lt;1 ms | **Critical finding**: DWL reuses isolates for the same `id`. If we load a type checker once and keep calling it with different inputs, per-validation overhead is sub-millisecond |
| **RPC simple** | &lt;1 ms | DO↔DWL communication is essentially free |
| **RPC complex (100 users)** | &lt;1 ms median, 1 ms p95 | Even complex payloads don't affect RPC latency |
| **Module loading 1 KB** | 1 ms | Baseline module load time |
| **Module loading 100 KB** | 2 ms | Near-linear scaling |
| **Module loading 500 KB** | 8 ms | **Bundle size is the biggest cold-start determinant** |
| **globalOutbound: null** | 0 ms overhead | Security isolation is free |
| **codemode-equivalent** | 1 ms | Wrapping pattern adds zero measurable overhead |

### Key Insight: Checker Reuse Changes Everything

The gate question for every spike: **can we keep the type checker initialized in a warm DWL isolate and just feed it new object literal strings per call?**

If **yes** (checker reuse works): Cold start becomes a one-time cost amortized across the isolate's lifetime. Bundle size stops mattering for steady-state performance. The focus shifts entirely to **per-call execution time** — how fast does an already-warm checker validate `const x: MyType = { ... }` against types it already has loaded? Even tsc's 23.6 MB bundle (estimated 300+ ms cold) becomes viable if it only loads once.

If **no** (every call reinitializes): Then cold start IS per-call cost, bundle size IS the performance determinant, and the approach ranking is dominated by module size. This makes A1 (tsc, 23.6 MB) impractical and A1.5 (Ezno-WASM, ~2-5 MB) the only DWL option.

**This must be the first thing each spike answers.** Everything else — bundle size, memory, tree-shaking — is secondary until we know whether checker reuse works. The DWL isolate caching (confirmed: sub-ms warm calls for same `id`) is necessary but not sufficient — we also need the checker's own state to survive across calls within that isolate.

Module loading cold-start estimates (for context, but secondary to reuse):
- **Ezno-WASM (~2-5 MB)**: Estimated 30-80 ms cold
- **tsc JS (~23.6 MB)**: Estimated 300+ ms cold
- **tsgo (Go binary)**: Can't run in DWL — requires Container

### tsgo Local Benchmarks (native Go binary, Mac)

| Schema Size | Median | Per-Type Cost | Notes |
|------------|--------|---------------|-------|
| 10 types | 82 ms | ~0.2 ms | Startup-dominated |
| 100 types | 91 ms | ~0.1 ms | Per-type cost negligible |
| 1000 types | 283 ms | ~0.2 ms | Linear scaling |

Each "type" = 3 interfaces (Resource, Metadata, Config) + discriminated union event type + type guard function. The ~80 ms startup is the dominant cost.

**Reframing for our use case**: We validate **one input object at a time**, not N types at once. The per-object validation cost (after startup) is sub-millisecond. The question is whether we can amortize that startup cost by keeping the checker warm.

### codemode Import Gotcha

`@cloudflare/codemode` v0.1.2 **cannot be imported in Workers** — `zod-to-ts` pulls in the TypeScript compiler which uses `__filename` (CJS global unavailable in ESM Workers). The `DynamicWorkerExecutor` wrapping pattern itself works fine when replicated directly — zero overhead over raw DWL cold start.

### Feed-Forward for Spikes

1. **Gate question for every spike**: Does checker reuse work? Can we initialize the checker once and call it repeatedly with different object literal strings? This determines whether cold start is a one-time cost or a per-call cost, which fundamentally changes what matters.
2. **Spike A1.5 (Ezno-WASM)**: Build WASM, load in DWL, test reuse. If reuse works: 30-80 ms one-time cold, then per-call execution time is the metric. If reuse fails: 30-80 ms per call — still possibly viable.
3. **Spike A1 (tsc in DWL)**: Only viable if `ts.Program` reuse works (swap virtual file content, re-run `getSemanticDiagnostics`). Without reuse, 300+ ms per call is a non-starter.
4. **tsgo startup (~80 ms)**: Workable in a Container if process stays warm. Container cold start adds 2-3 seconds on top.
5. **DWL isolate caching + checker reuse are different things**: Isolate caching (confirmed) means the module stays loaded. Checker reuse means the checker's internal state (parsed types, compiler instances) also survives. Both are needed.

## Spike A1 Results (2026-03-08) — tsc in DWL CONFIRMED

### Summary: A1 Wins. No need for A1.5, A2, or B.

The TypeScript compiler (v5.9.3) runs inside a DWL isolate with **sub-millisecond per-call validation** after warmup. Every gate question is answered affirmatively. This is dramatically better than research predicted (~35ms per call in Node.js → actual **1ms median** in DWL).

### Benchmark Results (local wrangler 4.71.0)

| Metric | Result | Notes |
|--------|--------|-------|
| **Bundle size** | 3,478 KB (3.4 MB) | esbuild `--platform=browser --format=esm --minify` |
| **Cold start (unique isolate)** | 123 ms median, 148 ms p95 | Includes tsc module load + first createProgram + diagnostics |
| **Warm first call** | 150 ms | One-time cost per isolate — includes tsc module evaluation |
| **Warm steady-state (simple)** | **1 ms median**, 3 ms p95 | n=100. `Todo { title: string; done: boolean; priority?: number }` |
| **Warm steady-state (complex)** | **1 ms median**, 4 ms p95 | n=100. `User` with 4 interfaces + union + Record + array |
| **Program reuse vs fresh** | **No measurable difference** | Both ~1ms median. tsc is fast enough that reuse savings are in the noise |
| **createProgram (warm)** | 0-2 ms | With or without oldProgram |
| **getPreEmitDiagnostics (warm)** | 0-2 ms | Per-file, single assignment check |

### Gate Questions — All Answered

1. **Can the 3.4 MB tsc bundle load in a DWL `{js}` module?** — **YES.** Loads successfully. Module evaluation (tsc import) takes ~120ms on first load, then isolate is cached.

2. **Does ts.Program reuse work across RPC calls?** — **YES, but unnecessary.** Module-scoped `cachedProgram` persists in the warm isolate. However, fresh `createProgram` is also 0-2ms — reuse provides no measurable benefit at this scale.

3. **What's the per-call validation latency?** — **1 ms median (simple), 1 ms median (complex).** Far better than the ~35ms predicted from Node.js benchmarks. DWL V8 isolates appear to benefit from JIT warmth.

4. **End-to-end: type string + object literal → diagnostics?** — **Works perfectly.** All standard TypeScript type errors detected correctly. Error messages are developer-friendly.

### Validation Correctness Confirmed

All test cases produce correct results with clean error messages:

| Test Case | Errors | Error Messages |
|-----------|--------|----------------|
| Valid `Todo` | 0 | — |
| Invalid `Todo` (wrong types) | 2 | `Type 'number' is not assignable to type 'string'`, `Type 'string' is not assignable to type 'boolean'` |
| Valid `User` (4 interfaces + union + Record) | 0 | — |
| Invalid `User` | 4 | Wrong id type, invalid role literal, missing address fields, string instead of array |
| Missing required field | 1 | `Property 'done' is missing in type '{ title: string; }' but required in type 'Todo'` |
| Extra field (excess property check) | 1 | `Object literal may only specify known properties, and 'extra' does not exist in type 'Todo'` |

### Architecture Decisions

1. **Minimal `lib.d.ts` (4 KB)** — Custom lib with only what schema validation needs: primitives, Array, Record, Partial, Pick, Omit, Exclude, Map, Set, etc. Full `lib.es5.d.ts` (218 KB) is unnecessary.

2. **`esbuild --platform=browser`** — Shims Node builtins so `sys` is undefined. Custom virtual `CompilerHost` with in-memory `Map<string, string>` replaces filesystem access.

3. **Text module loading** — tsc bundle imported as wrangler text module (`.bundle` extension), passed to DWL as string in `modules` dict. Lib.d.ts passed as JS module (`export default JSON.stringify(content)`).

4. **`globalOutbound: null`** — Zero overhead (confirmed in Phase 4.0 benchmarks). Security isolation is free.

### Why This Is Better Than Expected

The research predicted ~35ms per call based on Node.js benchmarks. Actual DWL results show ~1ms. Three factors likely explain this:
1. **V8 JIT optimization** — After first call, the type checker code path is JIT-compiled. Subsequent calls with similar-shaped inputs hit optimized paths.
2. **Tiny input** — A single `const x: T = { ... }` assignment is trivial for the checker. The 35ms Node.js measurement likely included program creation overhead that the warm isolate avoids.
3. **DWL isolate caching** — Module evaluation (parsing/compiling the 3.4 MB bundle) happens once. All state persists across calls.

### What This Means for Nebula

- **No Container needed** for type validation. Eliminates 2-3s container cold start, container billing, JSON-RPC complexity.
- **No Ezno dependency** — Full TypeScript support, not a Schema TypeScript subset. No single-maintainer risk.
- **No intermediate representation** — TypeScript IS the validator. No Zod, no JSON Schema, no generated code.
- **Sub-millisecond validation** on warm path. Suitable for per-request validation.
- **~120ms cold start** per isolate. Amortized over the isolate's lifetime. Acceptable for first request.
- **Error messages are real TypeScript errors** — Developer-friendly, familiar to any TypeScript user.

### Remaining Work for Production

- [ ] `toLiteralString()` in `@lumenize/structured-clone` — convert runtime data to TypeScript literal strings
- [ ] Cycle handling strategy (TypeScript can't express circular references in literals)
- [ ] Memory pressure testing with complex generic types (exponential growth possible)
- [ ] Input size limits and timeout guards for adversarial schemas
- [ ] Integration with Resource layer (Phase 5)
- [ ] Test on deployed Workers (not just local wrangler dev)

### Spike Code Location

`experiments/tsc-dwl-spike/` — fully working spike with benchmark endpoints.

---

## Research Findings (2026-03-08)

### tsc in DWL — Fully Viable (Spike A1, Now Highest Priority)

Research confirmed that the original assumption ("tsc is 23.6 MB, too big for DWL") was wrong. The actual bundle size after minification is **3.4 MB / 1.0 MB gzip** — well within Worker limits.

| Question | Answer |
|----------|--------|
| **Bundle size** | 3.4 MB minified, 1.0 MB gzip (fits free tier 3 MB compressed limit) |
| **Tree-shaking** | Not feasible (monolithic IIFE), but not needed at 3.4 MB |
| **Workers ESM compat** | Needs workaround: `esbuild --platform=browser` shims out Node builtins; `__filename` issue same as codemode's `zod-to-ts` bug |
| **Virtual CompilerHost** | Works — custom host with in-memory `Map<string, string>`, no filesystem needed |
| **Program reuse** | Yes — `ts.createProgram(roots, opts, host, oldProgram)` gives ~40% speedup. `structureIsReused=2` (fully reused) confirmed |
| **Memory** | ~40-50 MB total (30 MB import + 7-13 MB per Program). Fits 128 MB with 78+ MB headroom |
| **Per-call latency** | First: ~57 ms (35 ms createProgram + 22 ms diagnostics). Reuse: ~35 ms (27 ms + 8 ms) |
| **lib.d.ts** | ES2022 subset = ~459 KB across 56 files; or use `noLib: true` for schema-only validation |

**Workaround for `__filename`**: Bundle with `esbuild --platform=browser --minify`. This makes `isNodeLikeSystem()` return false → `sys` is `undefined` → provide custom virtual CompilerHost. Cleanest approach, no patching needed.

**Why A1 is now first**: Full TypeScript support (no Schema TypeScript subset constraint), no Rust toolchain, no WASM build artifacts to maintain, no single-maintainer risk. The bundle size advantage that motivated Ezno-first (2-5 MB vs "23.6 MB") evaporated — tsc minified (3.4 MB) is actually comparable to Ezno WASM (4.6 MB).

### Ezno WASM — Already Built, Viable Fallback (Spike A1.5)

Ezno already ships a working WASM build on npm. No build work needed.

| Question | Answer |
|----------|--------|
| **WASM build** | Already exists — `wasm-pack build --target web`, first-class build target |
| **npm package** | `ezno@0.0.23` ships `dist/shared/ezno_lib_bg.wasm` |
| **WASM size** | 4.6 MB uncompressed, 1.2 MB gzip |
| **API** | `check(entryPath, fsResolver, options?) → { diagnostics, get_type_at_position, ... }` — exactly what we need |
| **fsResolver** | Callback `(path: string) => string | undefined` — perfect for virtual files |
| **Dependencies** | All WASM-compatible; `path-absolutize` has `use_unix_paths_on_wasm` feature |
| **Crate structure** | `ezno-checker` (standalone) + `ezno-parser` — clean separation |
| **Playground** | Working browser playground in `src/playground/` confirms WASM works client-side |

**Gotcha corrections from research**:
- ~~"Ezno doesn't ship WASM artifacts"~~ — **Wrong.** It ships them in the npm package.
- ~~"We'd need to build and maintain the WASM binary"~~ — **Wrong.** `npm install ezno` gives us the WASM.
- The `check()` API with callback-based file resolution is ideal for DWL — no filesystem needed.

**Remaining Ezno risk**: Pre-release quality (v0.0.23), single maintainer, feature gaps for non-Schema TypeScript. But as a fallback if tsc per-call latency is too high, it's ready to test immediately.

### Revised Spike Priority

The original ordering (A1.5 → A1 → A2 → B) assumed tsc was too large for DWL. Research disproves this. **New ordering: A1 → A1.5 → A2 → B.**

| Priority | Spike | Rationale |
|----------|-------|-----------|
| **1st (recommended)** | A1: tsc in DWL | Full TS support, no maintenance burden, 3.4 MB bundle, program reuse confirmed |
| **2nd (if tsc too slow)** | A1.5: Ezno-WASM in DWL | Faster per-call (native WASM vs interpreted JS), but pre-release + Schema TS subset constraint |
| **3rd (if DWL fails)** | A2: tsgo in Container | Full TS support, 10x faster, but 2-3s container cold start |
| **4th (last resort)** | B: Compile once | Microsecond validation, but introduces intermediate representation |

**Why A1 before A1.5**: tsc wins on every axis except raw speed — and we don't know if speed is a problem yet. If tsc per-call is <50 ms (research suggests ~35 ms with reuse), there's no reason to take on Ezno's pre-release risk. If tsc is too slow, Ezno is ready to test immediately as fallback.

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

**What needs to be spiked** (ordered — answer reuse first, it determines what else matters):
- [ ] **⓪ Compiler reuse (GATE QUESTION)**: Can we call `ts.createProgram` once, keep the `Program`/`CompilerHost` alive in the DWL isolate, swap only the virtual file content (the object literal), and re-run `getSemanticDiagnostics`? If yes, per-call cost is just the checker's execution time. If no, every call pays the full `createProgram` cost and bundle size becomes critical.
- [ ] **① Per-object validation latency**: With reuse working, how fast is `getSemanticDiagnostics` on a single `const x: MyType = <literal>` assignment? This is the number that matters for production.
- [ ] **② Bundle size**: `typescript` is ~23.6 MB. Can DWL load a module this large? (Estimated 300+ ms cold — acceptable as one-time cost if reuse works, deal-breaker if not)
- [ ] **③ Memory**: Does `ts.createProgram` + `getSemanticDiagnostics` on a single virtual file fit within the 128MB Worker memory limit?
- [ ] **④ Tree-shaking**: Can we bundle only the type-checker and strip the emitter, transpiler, etc.? What's the minimum viable subset of `typescript` for `getSemanticDiagnostics`? (Only matters if bundle size is a problem after reuse is confirmed)

**If this works**: Eliminates the Container entirely for type validation. No 2-3s cold start, no Container billing, no JSON-RPC subprocess communication, no long-lived service management. Type-checking runs in the same V8 isolate tier as guard dispatch. The DWL isolate already exists for resource guards — we just add the TS compiler to its module dictionary.

**Why `tsc` (not `tsgo`) is fine here**: `tsgo` is 10x faster than `tsc`, but that's for large projects. For a single virtual file with a handful of types, `tsc` should be single-digit milliseconds. And `tsc` is pure JS — it runs in V8 natively. `tsgo` is a Go binary that can't run in V8.

### Approach A1.5: "Ezno-WASM in DWL" (Most Promising)

**The sweet spot.** Ezno is a Rust-based TypeScript type checker that compiles to WASM. DWL supports `{wasm}` modules (since Nov 2025, workerd #5462). This combines the speed of a native implementation with the flexibility of running inside a DWL isolate — no Container needed.

**How it works**:
1. Developer writes TypeScript types as plain strings (constrained to "Schema TypeScript" subset — see below)
2. Runtime data arrives. `toLiteralString()` converts it to a TypeScript literal string
3. Construct a virtual `.ts` file: type definition + `const x: TaskType = <literal>`
4. Inside a DWL isolate, Ezno-WASM validates the file
5. If Ezno reports errors → validation failed, with real TypeScript error messages

**Why Ezno fits our use case**:
- **WASM target**: Ezno compiles to WASM via standard Rust `wasm32` target. WASM runs in DWL isolates.
- **We control the type subset**: Nebula schemas don't need the full TypeScript type system. We define a "Schema TypeScript" subset (see below) constrained to what Ezno supports. This turns Ezno's "doesn't support all TS features" from a weakness into a non-issue.
- **Small binary**: Ezno-WASM should be significantly smaller than bundling the full `typescript` npm package (~23.6 MB). Rust→WASM binaries for type checkers are typically 2-5 MB.
- **Fast**: Native Rust performance via WASM, not interpreted JavaScript. Should be faster than `tsc` for single-file validation.
- **No lib.d.ts needed**: Ezno uses its own `overrides.d.ts` (489 lines). For schema validation, we only need the types the developer defined — no standard library.

**"Schema TypeScript" subset** — what we allow in schema definitions:

| Feature | Status in Ezno | Needed for schemas? |
|---------|---------------|-------------------|
| `interface` / `type` aliases | ✅ Working | Essential |
| Primitives (`string`, `number`, `boolean`, `null`) | ✅ Working | Essential |
| Object types | ✅ Working | Essential |
| Arrays (`T[]`, `Array<T>`) | ✅ Working | Essential |
| Optional properties (`?`) | ✅ Working | Essential |
| Union types (`A \| B`) | ✅ Working | Essential |
| Intersection types (`A & B`) | ✅ Working | Common |
| Literal types (`"active" \| "archived"`) | ✅ Working | Common |
| Generics | ✅ Working | Nice to have |
| Mapped types (`{ [P in K]: T }`) | ✅ Working (v0.0.22) | For utility types |
| `Record<K, T>` | ✅ Working | Common |
| `Pick<T, K>` | ✅ Working | Occasional |
| `Partial<T>` | ✅ Working | Occasional |
| `Required<T>` | ✅ Working | Rare |
| `Readonly<T>` | ✅ Working | Rare |
| `Omit<T, K>` | ⚠️ Marked done, untested | Occasional — contribute tests |
| `Exclude<T, U>` | ⚠️ Likely works (conditional types have basic support) | For `Omit` |
| Template literal types | ✅ Working | Rare |
| Conditional types (basic) | ✅ Working | For utility types |
| `async`/`Promise` | ❌ Incomplete | Not needed for schemas |
| Class hierarchies | ❌ Limited | Not needed for schemas |
| Module system (`import`/`export`) | ⚠️ Partial | Single-file validation only |

**Key insight**: Schema definitions don't need `async`, `Promise`, `ReturnType`, `Parameters`, `InstanceType`, or any of the function-oriented utility types. They need data-shape types: objects, arrays, unions, optionals, and a few utility types for composition (`Partial`, `Pick`, `Omit`, `Record`). Ezno already supports all of these except `Omit` (which depends on `Exclude` — both likely work but need testing/contribution).

**Contribution opportunity**: If `Omit` or `Exclude` don't work, the fix is adding ~5 lines to Ezno's `overrides.d.ts` + specification tests. The conditional type machinery is already implemented. We could contribute these and become early adopters/supporters of the project.

**What needs to be spiked** (`experiments/ezno-wasm-spike/`) — ordered by dependency:
- [ ] **⓪ Build Ezno to WASM**: Clone `kaleidawave/ezno`, compile checker to `wasm32-wasi` or `wasm32-unknown-unknown` target. (Prerequisite for everything else)
- [ ] **① API surface + WASM glue**: What's the JS↔WASM interface? Does Ezno expose a "check this string, return diagnostics" entry point? Does it need `wasm-bindgen`?
- [ ] **② Checker reuse (GATE QUESTION)**: Can we instantiate the Ezno checker once in a DWL isolate and call it repeatedly with different object literal strings — without re-instantiating WASM or re-parsing the schema types? If yes, cold start is amortized and per-call execution time is the metric. If no, every call pays WASM instantiation + parse cost.
- [ ] **③ Per-object validation latency**: With reuse working, validate ONE input object against ~10 type definitions. This is the hot-path metric.
- [ ] **④ DWL isolate caching confirmation**: 1 cold load + 50 rapid warm calls. Verify that isolate caching + checker reuse together deliver sub-millisecond steady-state. (Isolate caching is confirmed for simple modules — need to verify it holds for WASM)
- [ ] **⑤ WASM binary size**: How large is the compiled Ezno checker? (Target: <5 MB. Only matters for one-time cold start if reuse works)
- [ ] **⑥ Memory**: WASM linear memory usage for single-file type checking — fits in 128 MB Worker limit?
- [ ] **⑦ Utility type coverage**: Test `Partial`, `Pick`, `Omit`, `Record`, `Exclude` with schema-representative types
- [ ] **⑧ Error message quality**: Are Ezno's type errors understandable for vibe coders?

**Risks**:
- **Pre-release quality**: Ezno is v0.0.23 (Nov 2024), single maintainer (kaleidawave). "Breaks on simple real world code" per author. But our constrained subset may avoid the broken paths.
- **WASM build complexity**: Rust→WASM toolchain for a project this size may have friction (missing `wasm-bindgen` setup, unsupported Rust crates in WASM target, etc.)
- **No existing WASM distribution**: We'd need to build and maintain the WASM artifact ourselves until Ezno officially ships one.
- **Bus factor**: Single maintainer. If Ezno is abandoned, we'd need to maintain our fork or switch approaches.

**If this works**: Same benefits as A1 (no Container, no cold start, DWL-native) but with a much smaller binary (~2-5 MB WASM vs ~23.6 MB TypeScript compiler), faster execution (native via WASM vs interpreted JS), and a type checker purpose-built for performance. The constrained "Schema TypeScript" subset means we don't need full tsc compatibility — just the data-shape features Ezno already handles well.

### Approach A2: "TypeScript IS the Validator — in Container"

The pure approach with `tsgo`. Falls back here if A1 and A1.5's DWL constraints are too tight.

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

**The gate question**: Does checker reuse work? Can the type checker be initialized once in a DWL isolate and called repeatedly with different object literal strings? **This answer fundamentally changes what matters:**

| | Reuse works | Reuse fails |
|---|---|---|
| **What determines perf** | Per-call checker execution time | Cold start (= bundle size) |
| **Bundle size matters?** | No (one-time cost, amortized) | Yes (paid every call) |
| **tsc (23.6 MB) viable?** | Yes, if per-call is fast | No (300+ ms per call) |
| **Ezno advantage** | Speed (native WASM vs JS) | Size (2-5 MB vs 23.6 MB) |
| **Tree-shaking priority** | Low | High |

**Per-object validation is the metric**: We validate one input object at a time against a TypeScript schema. The benchmark is "time to check `const x: MyType = <literal>`" — not "time to check N types."

**Spike protocol** — revised based on 2026-03-08 research:

1. **Spike A1** (recommended first): Bundle `typescript` with `esbuild --platform=browser --minify` (3.4 MB) → load in DWL `{js}` module → test `ts.Program` reuse (swap virtual file, re-run diagnostics).
   - If reuse works and per-call &lt; 50ms: **A1 wins. Stop here.** Full TS support, zero maintenance burden.
   - If per-call too slow (>50ms): move to A1.5 for native WASM speed.
   - If DWL can't load the bundle: move to A1.5 (smaller binary).
2. **Spike A1.5** (if tsc too slow): `npm install ezno` → load WASM in DWL `{wasm}` module → test `check()` API with virtual files.
   - If per-call &lt; 10ms: **A1.5 wins.** Accept Schema TypeScript subset constraint.
   - If Ezno's feature coverage is insufficient: back to A1 with higher latency tolerance, or A2.
3. **Spike A2** (if both DWL approaches fail): tsgo in Container with warm process. Measure per-object latency.
   - tsgo has natural reuse (long-lived process). Question is Container cold start (2-3s) + per-call latency.
4. **Spike B** (only if all A approaches fail): Compile-once fallback.

**Why A1 before A1.5 (revised from original)**: Research showed tsc minified (3.4 MB) is comparable to Ezno WASM (4.6 MB) — the bundle size advantage that motivated Ezno-first evaporated. tsc provides full TypeScript support with no Schema TypeScript subset constraint, no single-maintainer risk, no pre-release quality concerns. Speed is the only axis where Ezno might win, and we don't know if tsc's ~35ms per-call (measured in Node.js) is a problem until we measure it in DWL.

**Why reuse is likely passive**: The DWL isolate caching means the module's top-level state persists. If the checker is initialized at module scope (or on first call and stored in a module-scoped variable), subsequent calls to the same isolate will find it already initialized. The object literal string is passed as a function argument — it doesn't require re-loading the module. The `ts.createProgram` API confirmed to support `oldProgram` parameter for incremental reuse (~40% speedup).

## Research Questions

### By Approach

**Approach A1 — `tsc` in DWL (highest priority — research answered most questions)**:
- [x] Can DWL load the `typescript` module? → Yes. 3.4 MB minified / 1.0 MB gzip. Well within limits.
- [x] Can we tree-shake `typescript`? → No (monolithic IIFE), but not needed at 3.4 MB.
- [x] Memory footprint? → ~40-50 MB total. Fits 128 MB with 78+ MB headroom.
- [x] Per-validation latency? → ~~~57 ms first call, ~35 ms with reuse~~ **SPIKE RESULT: 1 ms median** (both simple and complex types). DWL is dramatically faster than Node.js benchmarks predicted.
- [x] Cold start? → **SPIKE RESULT: 123 ms median** (unique isolate). One-time cost, amortized over isolate lifetime.
- [x] Virtual CompilerHost? → Yes. Custom host with in-memory `Map<string, string>`, no filesystem. **SPIKE CONFIRMED.**
- [x] Node.js dependencies? → `esbuild --platform=browser` shims them. `sys` becomes `undefined`, use custom host. **SPIKE CONFIRMED.**
- [x] **SPIKE DONE**: Actual per-call latency in DWL isolate → **1 ms median, 3-5 ms p95** (n=100, both simple and complex types)
- [x] **SPIKE DONE**: Program reuse across DWL RPC calls → **YES, works. But unnecessary** — fresh createProgram is also 0-2ms. Reuse provides no measurable benefit.
- [x] **SPIKE DONE**: `esbuild --platform=browser` bundle actually loads in DWL `{js}` module → **YES.** 3,478 KB bundle loads successfully.
- [x] **SPIKE DONE**: End-to-end: type string + object literal → diagnostics in DWL → **YES.** All TypeScript errors detected correctly with developer-friendly messages.

**Approach A1.5 — Ezno-WASM in DWL (fallback — research answered most questions)**:
- [x] Can Ezno be compiled to WASM? → Already done. Ships on npm as `ezno@0.0.23`.
- [x] WASM binary size? → 4.6 MB uncompressed, 1.2 MB gzip. Within paid plan limits.
- [x] JS↔WASM API surface? → `check(path, fsResolver, options?) → WASMCheckOutput` with diagnostics, types, AST.
- [x] `wasm-bindgen`/`wasm-pack`? → Yes, first-class. `wasm-pack build --target web`.
- [x] All dependencies WASM-compatible? → Yes. No OS-specific deps. `std::time::Instant` maps to `performance.now()`.
- [ ] Can DWL load `{wasm}` modules of this size? (DWL WASM support added Nov 2025, workerd #5462)
- [ ] Per-validation latency: single file with ~10 Schema TypeScript types + 1 literal assignment
- [ ] Cold start: WASM instantiation time in DWL isolate (first call vs cached)
- [ ] Memory: WASM linear memory for single-file checking — fits in 128 MB Worker limit?
- [ ] `Omit<T, K>` and `Exclude<T, U>` — do they work? If not, what's needed to contribute them?
- [ ] Error message quality for schema validation failures — are they vibe-coder-friendly?
- [ ] Can we ship a pre-built WASM artifact in our npm package and load it as a DWL `{wasm}` module?

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

### Rust-Based Alternatives

| Project | Status | Notes |
|---------|--------|-------|
| **STC** (Speedy TypeScript Checker) | Abandoned Jan 2024 | 1:1 tsc parity proved impossible for solo dev |
| **Ezno** | Experimental (v0.0.23) | Not tsc-compatible by design, but supports our Schema TypeScript subset. WASM target. See Approach A1.5. |
| **Oxc/tsgolint** | Alpha (linting only) | Rust frontend delegates to tsgo for type info — even the Rust ecosystem chose tsgo |

**Ezno details** (updated from research):
- **v0.0.22** (Aug 2024) added mapped types — the foundation for `Partial`, `Pick`, `Required`, `Readonly`, `Record`
- **v0.0.23** (Nov 2024) latest release, 356 specification test cases
- Single maintainer (kaleidawave/Ben). "Last big feature" (type narrowing) landed. Pre-1.0.
- Does NOT load `lib.d.ts` — uses its own `overrides.d.ts` (489 lines). For Schema TypeScript this is fine.
- Conditional types have basic support; `Exclude`/`Extract` should work but need testing.
- String intrinsics (`Uppercase`, `Lowercase`, etc.) implemented in Rust — fast.
- Blog: "does not currently support enough features to check existing projects" — but our constrained subset avoids the gaps.

**Bottom line for full tsc compatibility**: `tsgo` remains the only viable option. But for our constrained Schema TypeScript subset, Ezno-WASM in DWL (A1.5) is worth spiking first — smaller, faster, no Container needed.

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
- **tsc `__filename` issue in Workers** — same root cause as codemode's `zod-to-ts` bug. Workaround: `esbuild --platform=browser` shims Node builtins → `sys` is `undefined` → use custom virtual CompilerHost. Clean solution, no patching.
- **tsc is monolithic** — can't tree-shake to just the checker. But at 3.4 MB minified / 1.0 MB gzip, this doesn't matter.
- **tsc memory usage (~40-50 MB)** — leaves 78+ MB headroom in 128 MB isolate, but complex generic types can cause exponential growth. Need guards: input size limits, `skipLibCheck: true`, timeout.
- **Ezno is pre-release (v0.0.23)** — single maintainer, "breaks on simple real world code." Constraining to Schema TypeScript subset mitigates but doesn't eliminate risk. Bus factor of 1 means we may need to maintain a fork.
- ~~**Ezno doesn't ship WASM artifacts**~~ — **Corrected**: Ezno ships WASM on npm. `npm install ezno` provides the 4.6 MB WASM binary.
- **Ezno doesn't load `lib.d.ts`** — uses its own `overrides.d.ts`. Missing utility types (`Omit`, `Exclude`, `Extract`, `NonNullable`, etc.) need to be contributed or defined inline. The mapped type machinery exists; the definitions just aren't shipped.
- **`Omit<T, K>` depends on `Exclude`** — which depends on conditional type distribution over unions. Distribution appears to work in Ezno (tested with `ElementOf`) but hasn't been tested with standard utility type patterns specifically.
- **tsgo WASM story is weak** — Go's WASM output is large and slow. Running tsgo in-browser (for IDE type-checking) would need the Container service, not client-side WASM.
- **codemode instructs LLMs to write JavaScript only** — no TypeScript syntax. Nebula IDE will need LLMs to write TypeScript instead.

## Feed-Forward to Phase 5/6 (Resources)

### Already Answered (from Phase 4.0)

- [x] **Mesh bundle size (~100KB) — acceptable?** Yes. DWL loads 100 KB modules in ~2 ms cold. Negligible.
- [x] **DWL isolate caching behavior**: Confirmed. Same `id` → same isolate → sub-millisecond warm calls. Resources should use stable `id` values to keep isolates warm.
- [x] **codemode `Executor` interface**: The wrapping pattern is sound (zero overhead) but codemode itself can't be imported (v0.1.2 `zod-to-ts` → `__filename` bug). Replicate the pattern directly.
- [x] **globalOutbound: null**: Zero overhead. Use it for all sandboxed DWL isolates — security is free.

### Still Open

- [ ] vitest-pool-workers DWL support status — if not working, Resources tests need alternative harness
- [ ] Error propagation patterns — how do DWL errors surface in DO stack traces? Affects error handling design.
- [x] ~~tsgo Container architecture~~ — **Not needed.** A1 (tsc in DWL) wins. No Container required.
- [x] **TypeScript-as-schema pipeline** — **A1 spike complete.** tsc in DWL validated. 1ms median per-call, 120ms cold start.
- [ ] `toLiteralString()` implementation scope for `@lumenize/structured-clone` — how much of `preprocess()` is reusable? Cycle handling strategy?
- [x] ~~Schema TypeScript subset definition~~ — **Not needed.** A1 gives full TypeScript support.
- [x] ~~Ezno upstream relationship~~ — **Not needed.** A1 wins, no Ezno dependency.
- [x] **Bundle size budget**: tsc minified = 3.4 MB / 1.0 MB gzip. Ezno WASM = 4.6 MB / 1.2 MB gzip. Both fit within Worker limits. Bundle size is not a differentiator.

## Success Criteria

- [x] **Gate question answered**: Checker reuse works. Module-scoped state persists in warm DWL isolate. Per-call is 1ms median.
- [x] **Priority spike (A1)**: tsc in DWL — esbuild browser bundle loads, virtual CompilerHost works, Program reuse works (but unnecessary — fresh is also 1ms), per-call 1ms median
- [x] ~~**Fallback spike (A1.5)**~~: Not needed. A1 per-call latency (1ms) is far below the 50ms threshold that would trigger fallback.
- [ ] **Last resort (A2)**: `tsgo --noEmit` per-object validation latency in warm Container — only if both DWL spikes fail
- [ ] `tsgo --api` JSON-RPC mode evaluated as a long-lived compilation service (for A2 and IDE use cases)
- [ ] `toLiteralString()` mode prototyped in `@lumenize/structured-clone` (output TS literal strings from runtime data)
- [ ] Schema TypeScript subset defined and documented — which TS features are allowed in Nebula schema definitions
- [ ] Ezno utility type gaps identified and (if needed) contributed upstream
- [ ] Architecture decision documented: A1, A1.5, A2, or B — with reuse answer and per-call execution time as the deciding data
- [ ] Feed-forward findings documented and actionable for Phase 5/6

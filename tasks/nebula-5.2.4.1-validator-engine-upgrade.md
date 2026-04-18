# Phase 5.2.4.1: Parse-Validate Package

**Status**: Not started
**Depends on**: 5.2.4 (docs shipped)
**Precedes**: 5.2.4.2 (Galaxy integration)
**Package**: `packages/ts-runtime-parser-validator/` (new)

## Objective

Create `@lumenize/ts-runtime-parser-validator` — a new package built around typia and the "parse, don't validate" paradigm. Unlike the existing `@lumenize/ts-runtime-validator` (tsc-based, validate-only, ~15ms per call), this package separates compilation from execution: `createValidator()` generates a pre-compiled JS module (typically once per ontology version, cached), and that module exports its own `parse()` function. Warm `parse()` calls are expected to be sub-millisecond. Cold-start and cross-isolate costs (Service Binding or DO facet RPC) are measured in Phase 6 and are not zero — caching amortizes them. The generated `parse()` fills defaults (`@default`) and validates in one call, returning typed data or errors.

The existing `@lumenize/ts-runtime-validator` stays published but gets deprecated in favor of this package. The tsc engine served its purpose as a proof-of-concept (Phases 5.2.1–5.2.3).

**What carries over from the `ts-runtime-validator` design:**
- `extractTypeMetadata()` — AST parsing for relationships, write-shape generation, defaults discovery. Same code, uses `ts.createSourceFile()` (engine-independent)
- Tag vocabulary — aligned to typia conventions (Phase 3)
- `typescript` dependency and bundling approach

**What's new:**
- `createValidator(typeDefinitions: string): string` — calls typia transformer, returns a JS module source string. The module bakes in: typia-generated validators for each resource type, the `typeMetadata` (defaults + relationships), the inlined runtime helpers, and an exported `parse(value, typeName): { data, errors }` function that ties them together.
- Runtime call site: load the module string once (via `new Function()` in Node.js, via Dynamic Worker in Workers), then `module.parse(value, typeName)`. Two params at the hot path; no separate `validatorSource` or `typeMetadata` arguments to pass each call.
- Inlined helpers (~300 LOC: format validators, type guards, `TypeGuardError`) — the generated module calls these at execution time. Inlining them means the generated module is self-contained (zero imports from `typia/lib/internal/`). Note: this is separate from where `@typia/transform` itself comes from when `createValidator()` runs — see Spike A (dep) vs Spike B (inlined source).

**What gets left behind (stays in the old package, not ported):**
- `toTypeScript()` — serializes a JS value as a TypeScript expression with inlined constructors (e.g., `new Date(...)`, `new Map(...)`). The old `validate()` used this to type-check values as TypeScript code. Typia works differently: the generated validator is a JS function that takes a JS value directly — no serialization to TS source needed. Not used anywhere outside the old `validate()` flow (verified: zero references from `@lumenize/structured-clone`, `apps/nebula`, or anywhere else).
- `validate()` — the tsc-based type-check function. Superseded by the generated module's `parse()`. The old package retains it for any existing consumers; new consumers use the new package.
- `checkFiles()` — internal tsc engine entry point in `engine.ts`. Superseded by the typia transformer invocation in `createValidator()`.

**Value serialization across the facet boundary** (related to "what gets left behind"): The old flow serialized values to TS strings for type-checking. The new flow passes JS values directly to the facet via Workers RPC, which handles cross-isolate serialization itself. See design decision #8 for the trust/fallback discussion.
## Design Decisions (from design conversation 2026-04-17)

1. **New package, clean slate.** `@lumenize/ts-runtime-parser-validator` in `packages/ts-runtime-parser-validator/`. Not a retrofit of the tsc-based package. The old package gets `npm deprecate` pointing here.

2. **Parse, don't validate.** The only runtime entry point is `parse()` — fills defaults then validates in one call, returning `{ data, errors }`. Callers who want validate-only semantics ignore `data`. Mirrors Zod's API (parse/safeParse only, no standalone validate). Makes `@default` a first-class package-level concern without requiring Nebula.

3. **`parse()` is an export of the generated module, not a package-level export.** `createValidator()` returns a JS module source string that contains typia-generated validators, the `typeMetadata` (baked in at compile time), the inlined runtime helpers, and an exported `parse(value, typeName): { data, errors }`. Callers load the module once, then call `module.parse(value, typeName)`. This eliminates the need to pass `validatorSource` / `typeMetadata` on every call and keeps the hot path down to two arguments. In Node.js, callers can use `new Function()` to load the module. In Workers, it must be loaded via Dynamic Worker (no `eval`/`new Function`). This constraint is fundamental to how typia works in Cloudflare's security model.

4. **Same `typescript` package, same bundling approach.** Both the typia transformer and `extractTypeMetadata()` use the bundled `typescript` npm package. The transformer uses `ts.createProgram()` + `program.emit()` with a transformer factory. `extractTypeMetadata()` uses `ts.createSourceFile()` for AST parsing.

5. **Tag vocabulary = public API.** JSDoc tag names aligned to typia conventions. This is the long-lived contract users write in their interfaces.

6. **`@default` semantics in the generated `parse()`:**
  - Filler runs pre-validation; validator sees already-filled objects
  - Fields with `@default` must be declared optional (`age?: number`)
  - `typeMetadata` (including default values) is baked into the generated module at `createValidator()` time, not passed at call time
  - Depth behavior (nested objects/array elements) decided and pinned during Phase 4

7. **Inlined helpers for generated validators.** The ~300 LOC of helpers (format validators, type guards, `TypeGuardError`) that typia-generated validators call at execution time are inlined in the package. Generated modules import from our inlined helpers, not from `typia/lib/internal/`. This makes the generated module self-contained — when it runs (either in Node.js via `new Function()` or in a Worker/facet via DW loading), it needs nothing from the typia npm package. Separately, `createValidator()` itself depends on `@typia/transform` + deps; that's a different question answered by Spike A (bundled dep) vs Spike B (inlined source).

8. **Trust Workers RPC for cross-isolate value passing (with documented fallback).** When `parse()` is called across an isolate boundary (Star → facet or Star → DW), Workers RPC handles serialization of the input value. Its type support is very close to `@lumenize/structured-clone` — close enough for resource values that users would reasonably store. Known gaps (Request/Response, full Error cause chains) don't apply to typical resource data.

   **The real risk**: Kenton Varda has publicly said he wants to remove cycle and alias support from Workers RPC. If Cloudflare does this, any resource with cyclic or aliased references would fail to cross the boundary.

   **Decision**: Trust Workers RPC for now. Serializing through `@lumenize/structured-clone` on every call would add overhead we don't need to pay unless/until Cloudflare actually removes cycle support. If they do, the fix is localized: wrap the RPC payload in a `@lumenize/structured-clone` encode/decode step at the Star↔facet boundary. No public API change to the package; the serialization wrapper would live in Nebula's Star code (5.2.4.2).

   **Watch for**: Cloudflare announcements about Workers RPC serialization changes. Re-check this risk periodically.

## Phase 1: Spike A — Bundling Feasibility

**Goal**: Determine whether typia can be bundled as a dependency alongside `typescript` and run in a Worker. This is the biggest technical risk in the whole task; run it first so the design work in later phases isn't wasted if the approach is infeasible.

**Work**:
- `npm install --save-dev @typia/transform` at latest (dev dep — pulls in `@typia/core`, `@typia/utils`, `@typia/interface`). Record the resolved version in this file once installed; re-pin only if an upgrade becomes necessary.
- Create `scripts/bundle-typia.mjs` — single-pass esbuild bundle of `@typia/transform` + deps + `typescript` (ensures one `typescript` instance, catches all Node builtins)
- Write a minimal `createValidator()` that calls the transformer factory via `program.emit(..., { before: [factory] })` using a virtual `CompilerHost`
- Test in Node.js first (fast feedback)
- Test in a Worker via vitest-pool-workers or a minimal DW
- Record: what broke? How many stubs needed beyond `node:os` and `node:inspector`? How painful was the `typescript` dedupe?

**Known risks**:
- `strictNullChecks` must be enabled on the `ts.Program`, otherwise the transformer bails
- The transformer does `instanceof` checks against TS node types — two `typescript` instances means silent `false`. The single-pass bundle should solve this, but verify
- Typia's transformer may hit Node builtins beyond what our current stubs cover
- No public precedent for running this transformer in a Worker — we'd be first

**Decision gate**: If bundling works cleanly → skip Phase 2, go to Phase 3. If painful → Phase 2.

**Success Criteria**:
- [ ] Transformer runs and produces valid JS in Node.js
- [ ] Transformer runs in a Worker environment
- [ ] Bundle size measured and documented
- [ ] Typia version recorded in this file
- [ ] Decision recorded: dependency (skip to Phase 3) or evaluate inline (Phase 2)

## Phase 2: Spike B — Inline Feasibility (only if Spike A fails or is painful)

**Goal**: Determine whether inlining typia's transformer source is practical.

**Background**: We inline dependencies <10,000 LOC per project convention. Typia's full ecosystem is ~8.2 MB / ~500-670 TS source files, but we only need the assert/validate path.

**Typia anatomy (from analysis 2026-04-16)**:

| Component | Est. source files | Est. LOC | Need it? |
| --- | --- | --- | --- |
| Transformer core (assert/validate features) | ~50-80 | TBD | Yes |
| Core "programmers" (type walkers, code emitters) | ~150-200 | TBD | Yes (subset) |
| Runtime helpers (format validators, type guards, TypeGuardError) | ~28 | ~300 | Yes — always inline |
| JSON/protobuf/random/http/LLM/misc/notations/reflect | ~260+ | TBD | No |
| CLI + plugin infra | N/A | N/A | No |
| OpenAPI schema converters (`@typia/utils`) | ~100-150 | TBD | No |

**Work**:
- Clone `@typia/transform` source into `experiments/typia-inline-spike/`
- Strip non-assert/validate features
- Measure: how many files remain? Total LOC?
- Change `import ts from 'typescript'` to import our bundled version
- Run the same test from Spike A
- Assess: how well do we understand the remaining code? TS version compatibility maintenance burden?

**Key risk — TypeScript version compatibility**: Every major TS release can break transformer internals. Samchon patches quickly; if we inline, we own it.

**Decision gate**: Record trimmed LOC, comprehension level, TS-compat risk. Make the call.

**Success Criteria**:
- [ ] Trimmed source file count and LOC measured
- [ ] Trimmed transformer runs against the Spike A test
- [ ] TS version compatibility risk assessed
- [ ] Decision recorded: inline or dependency

## Phase 3: Tag Vocabulary Alignment

**Goal**: Nail down the JSDoc tag contract for the new package.

**Work**:
- Pull typia's full JSDoc tag list — record the typia version already pinned from Phase 1
- Diff against every tag currently recognized by `extractTypeMetadata()` in the old package
- Decide tag names for the new package (follow typia conventions: `@minimum`, `@maximum`, `@pattern`, etc.)
- Pin value-format conventions: bare numeric values (`@minimum 13`), JSON-literal form for `@default`
- Document the tag vocabulary as the public API surface

**Success Criteria**:
- [ ] Complete tag table documented
- [ ] Any divergences from typia's tag names decided and recorded

## Phase 4: `@default` and `parse()` Semantics

**Goal**: Pin the `@default` behavior so implementation has no ambiguity.

**Decisions to record:**
- **Fill semantics**: the generated `parse()` fills missing optional fields before validation; validator sees complete objects
- **Required vs optional**: fields with `@default` must be declared optional. Warn (or error) if `@default` appears on a required field
- **Return shape**: `parse(value, typeName): { data, errors }`, exported from the generated module. `data` is the filled+validated object; `errors` is the structured error list (empty on success)
- **Depth**: decide whether `@default` recurses into nested objects/array elements. Write test cases pinning the chosen semantic

**Success Criteria**:
- [ ] Design decisions documented in this file
- [ ] Test cases cover fill semantics, required/optional, depth
- [ ] API signature finalized

## Phase 5: Package Implementation

**Goal**: Working `@lumenize/ts-runtime-parser-validator` package. Approach (dependency vs inline) determined by Phase 1/2 spikes.

**Work**:
- Create `packages/ts-runtime-parser-validator/` with standard package structure
- Inline the ~300 LOC runtime helpers (format validators, type guards, `TypeGuardError`)
- Port `extractTypeMetadata()` from old package (same code, same `ts.createSourceFile()` approach)
- Implement `createValidator(typeDefinitions: string): string` — runs the typia transformer, then emits a JS module string that bakes in: typia-generated validators, the `typeMetadata` from `extractTypeMetadata()`, the inlined runtime helpers, and an exported `parse(value, typeName): { data, errors }` that fills defaults then dispatches to the right validator by name
- Modify generated module to call inlined runtime helpers instead of `typia/lib/internal/`
- Test suite covering: tag vocabulary, `@default` filling, error messages, edge cases

**Success Criteria**:
- [ ] `createValidator()` returns valid JS module source string
- [ ] Loaded module's `parse(value, typeName)` fills defaults and validates, returns `{ data, errors }`
- [ ] `extractTypeMetadata()` works unchanged
- [ ] Generated modules have zero runtime imports (all helpers and metadata inlined)
- [ ] Error messages are legible and reference correct property paths

## Phase 6: Benchmark

**Goal**: Validate performance characteristics and document them.

**Metrics**:
- **Bundle size**: new package vs old tsc-based package
- **`createValidator()` compilation time**: for representative type definitions
- **`parse()` latency**: cold start and warm (mean, p50, p99)
- **Memory footprint**: peak during validation

**Work**:
- Benchmark suite with representative types (flat, nested, arrays with constraints, relationships)
- Run in Node.js (`new Function()` to load the generated module) and Workers (Dynamic Worker)
- Compare against tsc baseline (~15ms) for reference
- Document results in this file

**Success Criteria**:
- [ ] Benchmark results documented with methodology
- [ ] Performance meets expectations (sub-millisecond warm validation)

## Phase 7: Deprecation and Documentation

**Work**:
- `npm deprecate @lumenize/ts-runtime-validator` pointing to `@lumenize/ts-runtime-parser-validator`
- New docs in `/website/docs/ts-runtime-parser-validator/`
- Tag vocabulary reference page
- Migration guide from old package
- Blog post

Nebula integration (updating `Resources.transaction()`, wiring Galaxy/Star) belongs to 5.2.4.2, not this task.

**Success Criteria**:
- [ ] Old package deprecated on npm with migration pointer
- [ ] New package docs published

## Open Questions

Grouped by the phase that resolves them. None block starting Phase 1 — each is answered naturally during the phase listed. **Pause and confirm with the human when each phase is reached before committing to the answer.**

**Resolved by Phase 1 (Spike A — Bundling Feasibility):**
- Does the typia transformer need all types inlined in one virtual file, or does it resolve references across multiple virtual files?
- Bundle size of generated modules — how large is the JS output for typical type definitions?
- Do any runtime helpers we actually need do dynamic evaluation (which would break Worker compatibility)?

**Resolved by Phase 2 (Spike B — Inline Feasibility, only if Spike A fails):**
- Actual trimmed LOC after stripping unused typia features
- TypeScript version compatibility maintenance burden — how often does typia need TS-compat fixes, how complex are they?

**Resolved by Phase 4 (`@default` and `parse()` Semantics):**
- Does `@default` recurse into nested objects and array elements, or only fill top-level optional fields? Pin the semantic with test cases.

**Resolved by Phase 5 (Implementation) — answer via targeted test case:**
- Does typia handle `Map<string, string | number>` correctly? (heterogeneous Map limitation in the tsc engine — want to confirm typia doesn't have the same issue)

## Resolved Concerns

- **Dynamic Workers forbid `new Function` / `eval` — does typia use them?** No. Pure AST-to-AST transformer; emits static JS. Verify during Phase 1 that no runtime helper does dynamic evaluation.

- **Can we run the transformer in a Worker?** Yes. Standard `ts.TransformerFactory<ts.SourceFile>`, invoked via `program.emit()` with a virtual `CompilerHost`. Same pattern as the tsc engine. The transform package imports only `typescript` and its own core/utils — no `fs`/`path`/`process`/`child_process`.

- **Does `extractTypeMetadata()` need rewriting?** No. It uses `ts.createSourceFile()` for AST parsing — completely engine-independent. Ports as-is to the new package.

# Phase 5.2.4.1: Parse-Validate Package

**Status**: Not started
**Depends on**: 5.2.4 (docs shipped)
**Precedes**: 5.2.4.2 (Galaxy integration)
**Package**: `packages/ts-runtime-``parser-validator/` (new)

## Objective

Create `@lumenize/ts-runtime-parser-validator` — a new package built around typia and the "parse, don't validate" paradigm. Unlike the existing `@lumenize/ts-runtime-validator` (tsc-based, validate-only, ~15ms per call), this package separates compilation from execution: `createValidator()` generates a pre-compiled JS validator (typically once per ontology version, cached), and `parse()` runs that validator. Warm `parse()` calls are expected to be sub-millisecond. Cold-start and cross-isolate costs (Service Binding or DO facet RPC) are measured in Phase 6 and are not zero — caching amortizes them. `parse()` fills defaults (`@default`) and validates in one call, returning typed data or errors.

The existing `@lumenize/ts-runtime-validator` stays published but gets deprecated in favor of this package. The tsc engine served its purpose as a proof-of-concept (Phases 5.2.1–5.2.3).

**What carries over from \****`ts-runtime-validator`**\*\*:**
- `extractTypeMetadata()` — AST parsing for relationships, write-shape generation, defaults discovery. Same code, uses `ts.createSourceFile()` (engine-independent)
- Tag vocabulary — aligned to typia conventions (Phase 1)
- `toTypeScript()` — moved over since `@lumenize/structured-clone` depends on it; not on the parse critical path

**What's new:**
- `createValidator(typeDefinitions: string): string` — calls typia transformer, returns JS source string
- `parse(value, options): { data, errors }` — fills defaults from metadata, runs pre-compiled validator, returns typed data or structured errors
- `validate(value, options): { valid, errors }` — pure validation without filling (thin wrapper over parse, discards filled data)
- Inlined runtime helpers (~300 LOC) — no runtime dependency on typia

## Design Decisions (from design conversation 2026-04-17)

1. **New package, clean slate.** `@lumenize/ts-runtime-parser-validator` in `packages/ts-runtime-parser-validator/`. Not a retrofit of the tsc-based package. The old package gets `npm deprecate` pointing here.

2. **Parse, don't validate.** Primary API is `parse()` — fills defaults then validates in one call. `validate()` exists as a convenience for callers who don't need filling. This makes `@default` a first-class package-level concern without requiring Nebula.

3. **`createValidator()`**** returns a string.** The generated validator is JS source code. In Node.js, callers can use `new Function()` to load it. In Workers, it must be loaded via Dynamic Worker (no `eval`/`new Function`). This constraint is fundamental to how typia works in Cloudflare's security model.

4. **Same \****`typescript`**\*\* package, same bundling approach.** Both the typia transformer and `extractTypeMetadata()` use the bundled `typescript` npm package. The transformer uses `ts.createProgram()` + `program.emit()` with a transformer factory. `extractTypeMetadata()` uses `ts.createSourceFile()` for AST parsing.

5. **Tag vocabulary = public API.** JSDoc tag names aligned to typia conventions. This is the long-lived contract users write in their interfaces.

6. **`@default`**** semantics in \****`parse()`**\*\*:**
7. **Tag vocabulary = public API.** The JSDoc tag names users write are the long-lived contract. Align with the second engine's conventions now (see Phase 1).
  - Filler runs pre-validation; validator sees already-filled objects
  - Fields with `@default` must be declared optional (`age?: number`)
  - `parse()` fills on the write path; `validate()` never fills
  - Depth behavior (nested objects/array elements) decided and pinned during Phase 2

6. **Inlined runtime helpers.** The ~300 LOC of typia runtime helpers (format validators, type guards, `TypeGuardError`) are inlined in the package. Generated validators call our inlined helpers, not `typia/lib/internal/`. Zero runtime dependency on the typia npm package.

## Phase 1: Tag Vocabulary Alignment

**Goal**: Nail down the JSDoc tag contract for the new package.

**Work**:
- Pull typia's full JSDoc tag list — pin to a specific typia version and record it here
- Diff against every tag currently recognized by `extractTypeMetadata()` in the old package
- Decide tag names for the new package (follow typia conventions: `@minimum`, `@maximum`, `@pattern`, etc.)
- Pin value-format conventions: bare numeric values (`@minimum 13`), JSON-literal form for `@default`
- Document the tag vocabulary as the public API surface

**Success Criteria**:
- [ ] Complete tag table documented
- [ ] Typia version pinned in this task file
- [ ] Any divergences from typia's tag names decided and recorded

## Phase 2: `@default` and `parse()` Semantics

**Goal**: Pin the `@default` behavior so implementation has no ambiguity.

**Decisions to record:**
- **Fill semantics**: `parse()` fills missing optional fields before validation; validator sees complete objects
- **Required vs optional**: fields with `@default` must be declared optional. Warn (or error) if `@default` appears on a required field
- **`parse()`**** vs \****`validate()`**: `parse()` fills + validates → `{ data, errors }`. `validate()` validates only → `{ valid, errors }`. Both accept a pre-compiled `validatorSource` string
- **Depth**: decide whether `@default` recurses into nested objects/array elements. Write test cases pinning the chosen semantic

**Success Criteria**:
- [ ] Design decisions documented in this file
- [ ] Test cases cover fill semantics, required/optional, parse vs validate, depth
- [ ] API signatures finalized

## Phase 3: Spike A — Bundling Feasibility

**Goal**: Determine whether typia can be bundled as a dependency alongside `typescript` and run in a Worker.

**Work**:
- `npm install --save-dev @typia/transform` (dev dep — pulls in `@typia/core`, `@typia/utils`, `@typia/interface`)
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

**Decision gate**: If bundling works cleanly → Phase 5. If painful → Phase 4.

**Success Criteria**:
- [ ] Transformer runs and produces valid JS in Node.js
- [ ] Transformer runs in a Worker environment
- [ ] Bundle size measured and documented
- [ ] Decision recorded: dependency (Phase 5) or evaluate inline (Phase 4)

## Phase 4: Spike B — Inline Feasibility (only if Spike A fails or is painful)

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

## Phase 5: Package Implementation

**Goal**: Working `@lumenize/ts-runtime-parser-validator` package. Approach (dependency vs inline) determined by Phase 3/4 spikes.

**Work**:
- Create `packages/ts-runtime-parser-validator/` with standard package structure
- Inline the ~300 LOC runtime helpers (format validators, type guards, `TypeGuardError`)
- Port `extractTypeMetadata()` from old package (same code, same `ts.createSourceFile()` approach)
- Port `toTypeScript()` from old package
- Implement `createValidator(typeDefinitions: string): string` — typia transformer → JS source
- Implement `parse(value, { validatorSource, typeMetadata }): { data, errors }` — fill defaults → run validator → return
- Implement `validate(value, { validatorSource }): { valid, errors }` — validate without filling
- Modify generated validator code to call inlined runtime helpers instead of `typia/lib/internal/`
- Test suite covering: tag vocabulary, `@default` filling, parse vs validate, error messages, edge cases

**Success Criteria**:
- [ ] `createValidator()` returns valid JS source string
- [ ] `parse()` fills defaults and validates, returns `{ data, errors }`
- [ ] `validate()` validates without filling
- [ ] `extractTypeMetadata()` works unchanged
- [ ] Generated validators have zero runtime imports (all helpers inlined)
- [ ] Error messages are legible and reference correct property paths

## Phase 6: Benchmark

**Goal**: Validate performance characteristics and document them.

**Metrics**:
- **Bundle size**: new package vs old tsc-based package
- **`createValidator()`**** compilation time**: for representative type definitions
- **`parse()`**** / \****`validate()`**\*\* latency**: cold start and warm (mean, p50, p99)
- **Memory footprint**: peak during validation

**Work**:
- Benchmark suite with representative types (flat, nested, arrays with constraints, relationships)
- Run in Node.js (`new Function()` to load validator) and Workers (Dynamic Worker)
- Compare against tsc baseline (~15ms) for reference
- Document results in this file

**Success Criteria**:
- [ ] Benchmark results documented with methodology
- [ ] Performance meets expectations (sub-millisecond warm validation)

## Phase 7: Deprecation and Documentation

**Work**:
- `npm deprecate @lumenize/ts-runtime-validator` pointing to `@lumenize/ts-runtime-parser-validator`
- Update Nebula's `Resources.transaction()` to use new package (may coordinate with 5.2.4.2)
- New docs in `/website/docs/ts-runtime-parser-validator/`
- Tag vocabulary reference page
- Migration guide from old package
- Blog post

**Success Criteria**:
- [ ] Old package deprecated on npm with migration pointer
- [ ] New package docs published
- [ ] Nebula integration updated or coordinated with 5.2.4.2

## Open Questions

- Does the typia transformer need all types inlined, or does it resolve references across virtual files?
- Does typia handle `Map<string, string | number>` correctly? (heterogeneous Map limitation in tsc engine)
- Bundle size of generated validators — how large is the JS output for typical type definitions?
- If we inline: actual trimmed LOC and TS-compat maintenance burden (Phase 4 answers this)

## Resolved Concerns

- **Dynamic Workers forbid \****`new Function`***\*/****`eval`**\*\* — does typia use them?** No. Pure AST-to-AST transformer; emits static JS. Verify during Phase 3 that no runtime helper does dynamic evaluation.

- **Can we run the transformer in a Worker?** Yes. Standard `ts.TransformerFactory<ts.SourceFile>`, invoked via `program.emit()` with a virtual `CompilerHost`. Same pattern as the tsc engine. The transform package imports only `typescript` and its own core/utils — no `fs`/`path`/`process`/`child_process`.

- **Does \****`extractTypeMetadata()`**\*\* need rewriting?** No. It uses `ts.createSourceFile()` for AST parsing — completely engine-independent. Ports as-is to the new package.

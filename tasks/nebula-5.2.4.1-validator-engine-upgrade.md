# Phase 5.2.4.1: Parse-Validate Package

**Status**: Phase 1 in progress — **paused** pending monorepo vitest 3→4 upgrade (see `tasks/monorepo-vitest-4-upgrade.md`)
**Depends on**: 5.2.4 (docs shipped — see `tasks/archive/nebula-5.2.4-docs.md`); monorepo vitest 4 upgrade (blocker for Suite 1 facet tests)
**Precedes**: 5.2.4.2 (Galaxy integration)
**Package**: `packages/ts-runtime-parser-validator/` (new)

## Current State (paused 2026-04-19)

Phase 1 scaffold and bundling work is done. Phase 1 is paused because `@cloudflare/vitest-pool-workers` versions that ship a miniflare/workerd new enough to support DO facets (≥ `miniflare@4.20260413.0`, post-2026-04-13 announcement) peer-require `vitest@^4.1.0`, and the monorepo is pinned to `vitest@3.2.4`. Upgrade is tracked in `tasks/monorepo-vitest-4-upgrade.md`. After the upgrade lands, bump this package to `@cloudflare/vitest-pool-workers@^0.14.7` (or latest) and resume from the "Resume checklist" below.

**What's done:**
- Package skeleton at `packages/ts-runtime-parser-validator/`: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `wrangler.jsonc` (compatibility_date `"2026-04-01"`, Worker Loader binding `LOADER`, DO binding `PRIMARY_DO` for class `PrimaryDO`), `vitest.config.js`, `README.md` (marked experimental), MIT `LICENSE`, `src/index.ts`, `src/compile-types-to-parse-module.ts` (hand-written stub for now), `test/test-worker-and-dos.ts`, `test/facet-roundtrip.test.ts`, `.dev.vars` and `cloudflare-test-env.d.ts` symlinks (via postinstall), `worker-configuration.d.ts` (via `npm run types` — confirms `LOADER: WorkerLoader` and `PRIMARY_DO` bindings resolve).
- `@typia/transform@12.0.2` installed and pinned (with transitive `@typia/core`, `@typia/interface`, `@typia/utils` all at `12.0.2`).
- `scripts/bundle-dependencies.mjs` written (single-pass esbuild bundle of `@typia/transform` + `typescript` via a generated `_barrel.mjs` entry, aliasing `os` / `node:os` / `inspector` / `node:inspector` to stubs copied verbatim from `packages/ts-runtime-validator/scripts/stubs/`). Produces `dist/deps.bundle.mjs` at **3.90 MB** (minified ESM, Workers-targetable).
- Primary DO wiring written in `test/test-worker-and-dos.ts`: `/parse` POST handler compiles module, loads facet via `this.ctx.facets.get(bundleId, async () => ({ class: worker.getDurableObjectClass('ParserValidator') }))`, forwards to `facet.parse(value, typeName)`. Uses the exact topology Nebula's Star DO will use.
- Two functional tests drafted in `test/facet-roundtrip.test.ts` (one valid, one invalid case) — both currently fail on the blocker.

**Decisions locked in Phase 1 (do not reopen):**
- **Facet bundle shape = class-extends-DurableObject.** Resolved by Cloudflare docs (`https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/`): the facet callback must call `worker.getDurableObjectClass("ClassName")`, which requires the loaded module to export a named class extending `DurableObject`. Plain exported functions are not accepted. The generated module's `ParserValidator` class exposes `parse(value, typeName)` as an RPC method — this is the final shape for `compileTypesToParseModule()`'s output. Update Design Decision #3 and Phase 5's emitter target accordingly.
- **`compatibility_date = "2026-04-01"`** in `packages/ts-runtime-parser-validator/wrangler.jsonc`. Matches Cloudflare's own facet example and is new enough for Worker Loader + `ctx.facets`. Do not lower.
- **Bundled dep versions pinned:** `@typia/transform@12.0.2` (and its `@typia/core` / `@typia/interface` / `@typia/utils` peers all at `12.0.2`). Re-pin only if a future upgrade is forced.

**Blocker discovered (2026-04-19):**
Running `npm test` in the new package shows `this.ctx.facets` is `undefined`, i.e., DO facets are not yet wired through the miniflare + workerd that ships with `@cloudflare/vitest-pool-workers@0.12.21` (miniflare `4.20260310.0`, workerd `1.20260310.1` — pre-dates the 2026-04-13 facet announcement). The fix requires vpw `0.13.x` or newer, which peer-requires `vitest@^4.1.0`. Monorepo-wide vitest 3→4 upgrade is filed as `tasks/monorepo-vitest-4-upgrade.md`.

**Resume checklist (after the vitest-4 upgrade lands):**
1. In `packages/ts-runtime-parser-validator/package.json`, bump `@cloudflare/vitest-pool-workers` to `^0.14.7` (or whatever the monorepo sweep settled on) and `wrangler` to `^4.83.0`. Both peer-require `vitest@^4.x`.
2. Re-run `npm install` at the monorepo root. The `postinstall` refreshes the `.dev.vars` and `cloudflare-test-env.d.ts` symlinks.
3. Run `npm run test` in `packages/ts-runtime-parser-validator/`. The two tests in `test/facet-roundtrip.test.ts` should now pass against the hand-written stub (stub returns `valid: true` for any value with a string `title`, else `valid: false`).
4. Continue Phase 1 from here:
   - Wire the real typia transformer into `compileTypesToParseModule()`. Strategy: synthesize source that `import typia from 'typia'`, declares user's interfaces, and exports `{ [TypeName]: typia.createValidate<TypeName>() }` for each interface in the input. Run `ts.createProgram()` with `strict: true` + a virtual `CompilerHost`, invoke `program.emit()` with the typia transformer factory (`transform(program, undefined, extras)`) in the `before` transformers list, capture the emitted JS, and wrap it in the `ParserValidator extends DurableObject` class. Both `extractTypeMetadata()` and this function must import `ts` from the *same* bundle output (`dist/deps.bundle.mjs`) — typia's internal `instanceof ts.Node` checks rely on a single `ts` instance.
   - Add a functional test that exercises the real typia path end-to-end (valid Todo + invalid Todo against typia-generated validators).
   - Copy `experiments/dw-bundler-spike/` to `experiments/ts-runtime-parser-validator-spike/` as the Suite 2 skeleton (latency measurement deferred to Phase 6 per task plan).
   - Record Phase 1 measurements in this file (bundle size: 3.90 MB ✓; generated-module size: TBD; required compatibility_date: `"2026-04-01"` ✓; typia version: 12.0.2 ✓).

---


## Objective

Create `@lumenize/ts-runtime-parser-validator` — a new package built around typia and the "parse, don't validate" paradigm. Unlike the existing `@lumenize/ts-runtime-validator` (tsc-based, validate-only, expected to be ~an order of magnitude slower than the typia path — re-measured in Phase 6 alongside the new numbers), this package separates compilation from execution: `compileTypesToParseModule()` generates a pre-compiled JS module (typically once per ontology version, cached), and that module exports its own `parse()` function. Warm `parse()` calls are expected to be sub-millisecond. Cold-start and cross-isolate costs (DO facet same-isolate RPC) are measured in Phase 6 and are not zero — caching amortizes them. The generated `parse()` fills defaults (`@default`) and validates in one call, returning typed data or errors.

**On `parse()` — fill + validate is a custom wrapper, not a typia primitive.** Typia's generated validators (`createAssert`, `createValidate`, etc.) check values but do not fill `@default` values (typia uses `@default` for `random`/`llm.*` generators, not for validator input-filling). The generated module's exported `parse(value, typeName)` is our own function that: (1) fills missing optional fields from `typeMetadata.defaults`, (2) calls the typia-generated validator for `typeName`, (3) returns the `{ valid, data } | { valid, errors }` shape. Typia supplies the validator; we supply the filler and the dispatcher.

**On where default values come from — `@default` JSDoc tags, extracted via the TS AST.** Today Nebula passes defaults through a separate config object (`OntologyVersionConfig.defaults` in `apps/nebula/src/ontology.ts`). This package moves that source-of-truth into `@default` JSDoc annotations on the interface fields themselves. `extractTypeMetadata()` is **extended** (not ported as-is — see correction in "What carries over" below) to walk each property's JSDoc via `ts.getJSDocTags()` and collect `@default <json-literal>` into `typeMetadata.defaults: Record<typeName, Record<fieldName, value>>`. Typia has its own annotation/metadata mode for `@default` (used by its `random`/`llm.*` generators) that walks the same TS AST — reference their extraction as a sanity check but we own ours since we're already in that code. The eventual consumer-facing consequence: Nebula's `OntologyVersionConfig.defaults` field, `Ontology.getDefaults()`, and the manual defaults-spread in `Resources.transaction()` all go away in 5.2.4.2.

The existing `@lumenize/ts-runtime-validator` stays published but gets deprecated in favor of this package. The tsc engine served its purpose as a proof-of-concept (Phases 5.2.1–5.2.3).

**What carries over from the `ts-runtime-validator` design:**
- `extractTypeMetadata()` — AST parsing approach (uses `ts.createSourceFile()`, engine-independent). **Extended**, not ported as-is: relationship discovery and write-shape generation are the same code; a new pass collects `@default` JSDoc tags into `typeMetadata.defaults`. Current `TypeMetadata` shape is `{ relationships, writeShapeTypeDefinitions }`; the extended shape adds `defaults: Record<typeName, Record<fieldName, value>>`. **Internal only** in the new package — not exported; its output is consumed by `compileTypesToParseModule()` and baked into the generated module.
- Tag vocabulary — aligned to typia conventions (Phase 3)
- `typescript` dependency and bundling approach

**What's new:**
- `compileTypesToParseModule(typeDefinitions: string): string` — calls typia transformer, returns a JS module source string. The module bakes in: typia-generated validators for each resource type, the `typeMetadata` (defaults + relationships), the inlined runtime helpers, and an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }` function (our custom wrapper: fills defaults from `typeMetadata`, then dispatches to the right typia-generated validator by name).
- Runtime call site: load the module once as a DO facet (see Design Decision #3), then `facet.parse(value, typeName)`. Two params at the hot path; no separate `validatorSource` or `typeMetadata` arguments to pass each call.
- Inlined helpers (~300 LOC: format validators, type guards, `TypeGuardError`) — the generated module calls these at execution time. Inlining them means the generated module is self-contained (zero imports from `typia/lib/internal/`). Note: this is separate from where `@typia/transform` itself comes from when `compileTypesToParseModule()` runs — see Spike A (dep) vs Spike B (inlined source).

**What gets left behind (stays in the old package, not ported):**
- `toTypeScript()` — serializes a JS value as a TypeScript expression with inlined constructors (e.g., `new Date(...)`, `new Map(...)`). The old `validate()` used this to type-check values as TypeScript code. Typia works differently: the generated validator is a JS function that takes a JS value directly — no serialization to TS source needed. Verified that nothing outside `@lumenize/ts-runtime-validator` imports `toTypeScript` (no references in `apps/nebula/`, `packages/`, or `tooling/`).
- `validate()` — the tsc-based type-check function. Superseded by the generated module's `parse()`. Nebula currently imports it from `@lumenize/ts-runtime-validator` (in `apps/nebula/src/ontology.ts` and `apps/nebula/src/resources.ts`); those call sites migrate to `parse()` in 5.2.4.2 Phase 5. The old package remains published on npm — no new versions ship and `npm deprecate` in 5.2.4.2 Phase 5 directs users to the new package.
- `@lumenize/structured-clone` dependency (used only by `toTypeScript()`). The new package must have **no dependency on `@lumenize/structured-clone` in either direction** — the old dep is vestigial from when `toTypeScript()` was forked from structured-clone's tree-walking code. Going forward, structured-clone and the parse-validator are independent.

**Value serialization across the facet boundary** (related to "what gets left behind"): The old flow serialized values to TS strings for type-checking. The new flow passes JS values directly to the facet via Workers RPC, which handles cross-isolate serialization itself. See design decision #8 for the trust/fallback discussion.

## Design Decisions (from design conversation 2026-04-17)

1. **New package, clean slate.** `@lumenize/ts-runtime-parser-validator` in `packages/ts-runtime-parser-validator/`. Not a retrofit of the tsc-based package. The old package gets `npm deprecate` pointing here.

2. **Parse, don't validate.** The only runtime entry point is `parse()` — fills defaults then validates in one call, returning `{ valid: true, data } | { valid: false, errors }`. Callers who want validate-only semantics can ignore `data` on success. Mirrors Zod's API (parse/safeParse only, no standalone validate). Makes `@default` a first-class package-level concern without requiring Nebula.

3. **`parse()` is an export of the generated module, not a package-level export.** `compileTypesToParseModule()` returns a JS module source string that contains typia-generated validators, the `typeMetadata` (baked in at compile time), the inlined runtime helpers, and an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }`. Callers load the module once, then call `facet.parse(value, typeName)`. This eliminates the need to pass `validatorSource` / `typeMetadata` on every call and keeps the hot path down to two arguments. The only supported loader is a **DO facet** (5.2.4.2 consumes this package from the Star DO); tests run via `vitest-pool-workers` using the same facet-loading mechanism. Plain Dynamic Worker deployment without a facet parent is a future enhancement, out of scope for 5.2.4.1 and 5.2.4.2. One open sub-question resolved in Phase 1 below: does the facet loader accept a module with exported functions as-is, or does it require the bundle to expose a class? Either is achievable from the transformer output; the answer shapes the final form of `compileTypesToParseModule()`'s return value.

4. **Same `typescript` package, same bundling approach.** Both the typia transformer and `extractTypeMetadata()` use the bundled `typescript` npm package. The transformer uses `ts.createProgram()` + `program.emit()` with a transformer factory. `extractTypeMetadata()` uses `ts.createSourceFile()` for AST parsing.

5. **Tag vocabulary = public API.** JSDoc tag names aligned to typia conventions. This is the long-lived contract users write in their interfaces.

6. **`@default` semantics in the generated `parse()`:**
  - Source of default values: `@default <value>` JSDoc tags on interface fields, collected during AST parsing by the extended `extractTypeMetadata()` into `typeMetadata.defaults`. This replaces Nebula's current separate-config approach (`OntologyVersionConfig.defaults`). **Accepted grammar matches typia's `@default` grammar** — whatever value forms typia parses (JSON literals at minimum, possibly richer expressions), we parse identically, so users writing interfaces can rely on the single typia-aligned reference. Exact grammar inventoried in Phase 3 by reading typia's extraction code.
  - Filler runs pre-validation; validator sees already-filled objects
  - Fields with `@default` must be declared optional (`age?: number`)
  - `typeMetadata` (including default values) is baked into the generated module at `compileTypesToParseModule()` time, not passed at call time
  - Depth: full recursion into nested objects and array elements — practical guidance and tests finalized in Phase 4

7. **Inlined helpers for generated validators.** The ~300 LOC of helpers (format validators, type guards, `TypeGuardError`) that typia-generated validators call at execution time are inlined in the package. Generated modules import from our inlined helpers, not from `typia/lib/internal/`. This makes the generated module self-contained — once loaded into a DO facet, it needs nothing from the typia npm package. Separately, `compileTypesToParseModule()` itself depends on `@typia/transform` + deps; that's a different question answered by Spike A (bundled dep) vs Spike B (inlined source).

8. **Trust Workers RPC for cross-isolate value passing (with documented fallback).** When `parse()` is called across the isolate boundary (Star → facet), Workers RPC handles serialization of the input value. Its type support is very close to `@lumenize/structured-clone` — close enough for resource values that users would reasonably store. Known gaps (Request/Response, full Error cause chains) don't apply to typical resource data.

   **The real risk**: Kenton Varda has publicly said he wants to remove cycle and alias support from Workers RPC. If Cloudflare does this, any resource with cyclic or aliased references would fail to cross the boundary.

   **Decision**: Trust Workers RPC for now. Serializing through `@lumenize/structured-clone` on every call would add overhead we don't need to pay unless/until Cloudflare actually removes cycle support. If they do, the fix is localized: wrap the RPC payload in a `@lumenize/structured-clone` encode/decode step at the Star↔facet boundary.

## Phase 1: Spike A — Bundling Feasibility

**Goal**: Determine whether typia can be bundled as a dependency alongside `typescript` and run in a Worker. This is the biggest technical risk in the whole task; run it first so the design work in later phases isn't wasted if the approach is infeasible.

**Location**: Do this work directly in `packages/ts-runtime-parser-validator/` (the final package) as a prototype that becomes real. If the spike fails, we tear down the package dir; if it succeeds, the bundling script and harness stay.

**Work**:
- **Bootstrap the package skeleton** (copy pattern from a vitest-pool-workers package — `packages/rpc/` is the closest template, since it has the same `wrangler.jsonc` + `vitest.config.js` + `cloudflare-test-env.d.ts` layout we need; `packages/ts-runtime-validator/` is *not* a good template for this work because it uses plain vitest in Node.js, no Workers runtime). Produce: `package.json` (name `@lumenize/ts-runtime-parser-validator`, `"type": "module"`, `main`/`types` → `src/index.ts`, `files` array), `src/index.ts` stub, `README.md` (minimal — name, tagline, link to docs; mark the package **experimental** in the same pattern as the entry that will appear in `website/docs/introduction.mdx`), `LICENSE` (MIT — matches the old package this replaces), `tsconfig.json` (extends root), `tsconfig.build.json` (declaration + sourcemaps, excludes tests), `vitest.config.js`, `wrangler.jsonc`. No workspace entry needed — `packages/*` glob in root `package.json` picks it up. Run `npm install` once the skeleton exists: `postinstall` creates the `.dev.vars` symlink and the `cloudflare-test-env.d.ts` symlink (both keyed off the presence of `wrangler.jsonc`). Run `npm run types` from the repo root to generate `worker-configuration.d.ts`. Non-obvious pre-publish items (release scripts, `prepack`/`dist`-swap hooks, `README` badges) don't matter in Phase 1 — revisit during Phase 7.
- `npm install --save-dev @typia/transform` (as of 2026-04-17: `@typia/transform@12.0.2` on npm pulls `@typia/core@^12.0.2`, `@typia/interface@^12.0.2`, `@typia/utils@^12.0.2`). Re-check these versions on npm when Phase 1 actually starts — npm versions can change between task-authoring and task-execution. Pin the exact resolved version here once installed: `TBD`. Re-pin only if an upgrade becomes necessary.
- Create `scripts/bundle-dependencies.mjs` — single-pass esbuild bundle of `@typia/transform` + deps + `typescript` (ensures one `typescript` instance, catches all Node builtins). Name is intentionally transformer-agnostic: if we ever fork or replace typia, this script's purpose (bundling the transformer-side dependencies for Worker compatibility) remains the same. Both `extract-type-metadata.ts` and `compile-types-to-parse-module.ts` must import `ts` from this same bundle output — sharing the bundle is what keeps typia's internal `instanceof ts.Node` checks working. **Prior art to copy from**: `packages/ts-runtime-validator/scripts/bundle-tsc.mjs` has the working recipe (esbuild with `--platform=node --format=esm --minify`, aliasing `os`/`node:os` and `inspector`/`node:inspector` to local stubs). Copy `scripts/stubs/os.mjs` and `scripts/stubs/inspector.mjs` from there verbatim — those are the two Node builtins typescript imports that don't exist in Workers. Additional copies of the same script exist in `experiments/dw-bundler-spike/scripts/bundle-tsc.mjs` and `experiments/tsc-dwl-spike/scripts/bundle-tsc.mjs`; all three are equivalent
- Write a minimal `compileTypesToParseModule()` that calls the transformer factory via `program.emit(..., { before: [factory] })` using a virtual `CompilerHost` with `strict: true` in the compiler options (typia's official guidance is full strict mode, not just `strictNullChecks`)
- Set up the **functional test suite** (Suite 1 of two — see "Test harness" subsection below): `vitest-pool-workers` with wrangler at a recent-enough version to support DO facets (upgrade `@cloudflare/vitest-pool-workers` and `wrangler` as needed — facets are beta as of 2026-04-13). **Verify the minimum `compatibility_date` required for facets**; if newer than the project's current `"2026-03-12"`, record the required date here and update the package's `wrangler.jsonc` accordingly. **Upgrade scope is package-local for this task** — bump `wrangler` / `@cloudflare/vitest-pool-workers` / `compatibility_date` only in `packages/ts-runtime-parser-validator/`, not monorepo-wide. A monorepo-wide sweep (updating all `packages/*` and `apps/*` + the CLAUDE.md baseline) is a separate cleanup task filed afterward, and is only necessary if something forces it — versions historically have not introduced breaking changes, so a sweep when convenient is fine.
- Functional test structure (validates both compile and parse paths run in Workers; no latency claims — see Phase 6 for that): tests POST a type-definitions string and a value to an endpoint on a primary DO via a one-line `routeDORequest()` router in the test Worker. The primary DO's endpoint (a) calls `compileTypesToParseModule()` to produce the validator bundle, (b) loads the bundle into its DO facet, (c) invokes `facet.parse(value, typeName)` via same-isolate RPC, (d) returns the result. This proves both halves of the risk in one shape: the *compile* step runs in a Workers isolate (the primary DO) using the bundled `@typia/transform` + `typescript`, and the *generated-module load + parse* step runs in the facet — matching the production topology where Galaxy compiles and Star's facet parses. Must also resolve the facet-bundle-shape sub-question from Design Decision #3 (module-with-exports vs class-wrapped) — whichever shape the facet loader accepts becomes the emitter target for Phase 5.
- Record: what broke? How many stubs needed beyond `node:os` and `node:inspector`? How painful was the `typescript` dedupe?

**Test harness — two suites, different purposes** (this is important: latency numbers and functional correctness need different tooling):

*Suite 1 — Functional (in this package, runs on `npm run test`)*: `vitest-pool-workers` as described above. No server to start; the test harness is self-contained and validates end-to-end correctness inside the simulated Workers runtime. Canonical template: `packages/rpc/` (wrangler.jsonc + vitest.config.js + test/ layout). This suite **cannot** measure wall-clock latency — inside simulated Cloudflare environments (and on deployed DOs), the clock is frozen during synchronous execution windows; two `Date.now()` / `performance.now()` calls inside the same turn return identical values regardless of how much work happened between them.

*Suite 2 — Latency (in `experiments/`, run manually)*: A mini-app with a Worker + DO(s) deployed to Cloudflare, plus a Node.js client that runs locally on the developer machine. The Node.js client measures wall-clock latency using `performance.now()` around each `fetch()` call — this is the only way to get real numbers, because the clock in Node.js advances normally. The mini-app is developed locally against `wrangler dev` first to confirm it's wired up, then deployed to Cloudflare for the actual latency numbers. Template to copy: `experiments/dw-bundler-spike/` — this was built before the original tsc-based validator to verify Dynamic Workers behavior and has exactly the right shape (`scripts/bench.mjs` runs from the developer's machine via `node scripts/bench.mjs <deployed-url>`, hitting the Worker with timed `fetch()` calls). Phase 1 can stub latency measurement with a placeholder — the actual benchmark numbers belong to Phase 6.

**Known risks**:
- `strict: true` must be enabled on the `ts.Program`, otherwise the transformer bails (`strictNullChecks` alone has been reported to be insufficient in typia issues)
- The transformer does `instanceof` checks against TS node types — two `typescript` instances means silent `false`. The single-pass bundle should solve this, but verify
- Typia's transformer may hit Node builtins beyond what our current stubs cover
- No public precedent for running this transformer in a Worker — we'd be first

**Decision gate**: If bundling works cleanly → skip Phase 2, go to Phase 3. If painful → Phase 2.

**Success Criteria**:
- [ ] Transformer runs under a `ts.Program` configured with `strict: true` and produces valid JS **inside a Workers isolate** (compile step runs in the primary DO, not on the Node.js side of the test harness)
- [ ] Primary DO → facet wiring verified end-to-end: primary DO calls `compileTypesToParseModule()`, loads the bundle into its facet, and `facet.parse(value, typeName)` returns a correct result for a minimal fill-then-validate case. Facet bundle shape (module-with-exports vs class — see Design Decision #3) decided and recorded
- [ ] **Transformer dependency bundle size** (output of `scripts/bundle-dependencies.mjs`) measured and documented
- [ ] **Generated-module size** (typical output of `compileTypesToParseModule()` for a representative ontology) measured and documented
- [ ] Exact typia version pinned in the `**Work**` section above
- [ ] Required `compatibility_date` for DO facets recorded in the `**Work**` section; package's `wrangler.jsonc` set to that date
- [ ] Suite 2 skeleton (`experiments/` mini-app, copied from `experiments/dw-bundler-spike/`) exists and `wrangler dev` smoke-test runs the compile + parse path end-to-end. Actual latency numbers are Phase 6's job
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
- Continue in `packages/ts-runtime-parser-validator/` — same directory as Phase 1. Clone `@typia/transform` source into a subdirectory (e.g., `vendor/typia-transform/`) so the inlined source lives alongside the final package code
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

**Goal**: Decide the JSDoc tag contract for the new package. **Decision-only** — the user-facing documentation of the tag vocabulary is written in Phase 7.

**Work**:
- Pull typia's full JSDoc tag list — record the typia version already pinned from Phase 1
- Diff against every tag currently recognized by `extractTypeMetadata()` in the old package
- Decide tag names for the new package (follow typia conventions: `@minimum`, `@maximum`, `@pattern`, etc.)
- Pin value-format conventions: bare numeric values (`@minimum 13`). For `@default`, inventory the exact value grammar typia accepts (read typia's `@default` extraction code). **Preferred outcome: adopt typia's grammar verbatim** — users get one reference (typia's docs), not two, and our extractor mirrors typia's behavior. **Fallback** (only if typia's grammar proves unacceptable — e.g., it accepts forms we can't safely evaluate in a Worker, requires `eval`/`Function`, or produces surprising coercions users would reasonably trip over): ship v1 with a JSON-literals-only subset (numbers, strings, booleans, `null`, arrays of JSON, plain object literals of JSON) and file a follow-up to revisit as a feature addition, not a breaking change. Record which path was taken and why in this file so Phase 5 has a checklist and Phase 7 can turn it into docs
- Record the decisions in this file (tag table + any divergences from typia with reasons) so Phase 7 has a source to turn into docs

**Success Criteria**:
- [ ] Complete tag table recorded in this file
- [ ] Any divergences from typia's tag names decided and recorded with reasons

## Phase 4: `@default` and `parse()` Semantics

**Goal**: Pin the `@default` behavior so implementation has no ambiguity. This phase is **specification-only** — decisions get recorded in this file and test *specifications* get drafted (either as prose or as pending/skipped test stubs), but running tests that actually exercise `parse()` land in Phase 5 alongside the implementation they verify.

**Decisions to record:**
- **Fill semantics**: the generated `parse()` fills missing optional fields before validation; validator sees complete objects
- **Required vs optional**: fields with `@default` must be declared optional. `@default` on a required field is a Phase-4 decision that *must* be pinned before Phase 5 starts — pick one of: (a) hard error at `extractTypeMetadata()` time (preferred — catches the mistake at ontology registration, not at first transaction), (b) silent warning emitted from the extractor, (c) silently ignore the `@default` tag. Record the choice here so Phase 5's success criterion (line re: "`@default` on required field warns/errors") has exactly one behavior to test.
- **Return shape**: `parse(value, typeName): { valid: true, data } | { valid: false, errors }`, exported from the generated module. On success, `data` is the filled+validated object. On failure, `errors` is the structured error list and no `data` is returned. The `valid` discriminant gives callers a clean narrowing check
- **Error shape: adopt typia's error shape as-is.** Decided: the `errors` field uses typia's native error shape (path + expected + value). Wrapping or translating to match the old `ValidationError[]` shape adds drag with no upside; typia's shape is well-documented, and callers (currently only Nebula's `Resources.transaction()`) are updated in 5.2.4.2 to consume it directly. `TransactionError.errors` changes type accordingly in 5.2.4.2 — a breaking change for Nebula consumers. The new package ships under a new name, so existing users of `@lumenize/ts-runtime-validator` are unaffected until they opt in to migrate.
- **Depth: `@default` recurses fully into nested objects and array elements.** Any optional field at any depth with a `@default` tag gets filled pre-validation. Practical guidance (goes into the docs, not enforced): don't stack deep nested defaults — if an interface has `@default` fields five levels deep, lift that nested structure into its own named interface instead. Same recursion, more readable. Draft test specifications pinning this semantic — they become executable tests in Phase 5

**Success Criteria**:
- [ ] Design decisions documented in this file
- [ ] Test specifications drafted covering fill semantics, required/optional, depth (prose or pending test stubs — not yet executable)
- [ ] API signature finalized

## Phase 5: Package Implementation

**Goal**: Working `@lumenize/ts-runtime-parser-validator` package. Approach (dependency vs inline) determined by Phase 1/2 spikes.

**Work**:
- Continue in the `packages/ts-runtime-parser-validator/` directory created in Phase 1 — fill out standard package structure around the spike code
- Inline the ~300 LOC runtime helpers (format validators, type guards, `TypeGuardError`). Add a header comment at the top of each inlined file naming the typia source file and version it was copied from (e.g., `// Copied from typia@12.0.2 lib/internal/format/is_email.js`), and note any modifications. Full `ATTRIBUTIONS.md` entries are **not** required for Spike A's inlined-helpers path — `@typia/transform` remains a declared npm dependency, which is a stronger form of attribution than an ATTRIBUTIONS entry. If Phase 2 (Spike B) runs and we end up inlining the transformer itself, Phase 5 work in that branch must add a full `ATTRIBUTIONS.md` entry.
- Port + **extend** `extractTypeMetadata()` from old package — internal, not exported. Relationship discovery and write-shape generation port as-is; add a new pass that calls `ts.getJSDocTags()` on each property signature, collects `@default <value>` tags (accepting the full grammar inventoried in Phase 3), and surfaces them as `typeMetadata.defaults: Record<typeName, Record<fieldName, value>>`. **Read typia's own `@default` extraction code** as a reference for *how* it walks JSDoc tags and parses the value grammar, then mimic that approach in our extractor — we're not calling typia's extraction at runtime, just learning from it to keep our grammar aligned with theirs. This is Lumenize-custom logic (relationship discovery, write-shape generation, defaults extraction), not a TypeScript API. The old package is deprecated once this package ships, so the copies won't drift.
- Implement `compileTypesToParseModule(typeDefinitions: string): string` — runs the typia transformer, then emits a JS module string (or class-wrapped module, per Phase 1's facet-shape decision) that bakes in: typia-generated validators, the `typeMetadata` (including `defaults`) from `extractTypeMetadata()`, the inlined runtime helpers, and an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }` that fills defaults then dispatches to the right validator by name
- Modify generated module to call inlined runtime helpers instead of `typia/lib/internal/`
- Test suite covering: tag vocabulary, `@default` extraction from JSDoc, `@default` filling behavior (including depth decisions from Phase 4), error messages, edge cases (e.g., `@default` on required field warns/errors per Phase 4 decision)

**Success Criteria**:
- [ ] `compileTypesToParseModule()` returns valid JS module source string in the shape decided in Phase 1
- [ ] Loaded module's `parse(value, typeName)` fills defaults and validates, returns `{ valid: true, data } | { valid: false, errors }`
- [ ] Extended `extractTypeMetadata()` returns `{ relationships, writeShapeTypeDefinitions, defaults }`; `defaults` populated from `@default` JSDoc tags on optional fields; used internally and baked into the generated module
- [ ] Generated modules have zero external runtime imports — no `typia/lib/internal/` references; all format validators, type guards, `TypeGuardError`, and `typeMetadata` are inlined in the module itself
- [ ] Error messages are legible and reference correct property paths
- [ ] `Map<string, string | number>` targeted test written and passing. Workers RPC supports heterogeneous `Map` value types, the existing tsc-based validator supports them (see `packages/ts-runtime-validator/test/map-*.test.ts`), and Nebula test code already relies on them — so the required semantic is that `parse()` matches Workers RPC (heterogeneous union values must pass). **Decision gate**: if typia handles this case — continue. If typia doesn't support it out of the box, this is a blocker for shipping; resolve by one of: (i) a wrapper around the typia-generated validator that widens the specific union-value call sites before delegating (must be implemented, not just documented), or (ii) file a typia issue *and* ship the wrapper as a bridge. "Document the gap" is not acceptable — Nebula tests must pass on Day 1 of 5.2.4.2.
- [ ] Coverage meets project standards: branch >80%, statement >90% (per `CLAUDE.md`)

## Phase 6: Benchmark

**Goal**: Validate performance characteristics and document them.

**Metrics**:
- **Transformer dependency bundle size** (output of `scripts/bundle-dependencies.mjs`) vs old tsc-based package's typescript bundle
- **Generated-module size** (`compileTypesToParseModule()` output for a representative ontology) — this is also our memory-footprint proxy. Peak RSS during validation isn't measurable from `vitest-pool-workers` or a deployed Worker; reason about memory from bundle + generated-module size instead
- **`compileTypesToParseModule()` compilation time**: for representative type definitions
- **`parse()` latency**: cold start and warm (mean, p50, p99)

**Work**:
- Benchmark suite with representative types (flat, nested, arrays with constraints, relationships)
- Run in a Worker via a DO facet using `vitest-pool-workers` — matches 5.2.4.2's production path. No Node.js path.
- Re-measure the old tsc-based validator (`@lumenize/ts-runtime-validator`'s `validate()`) as a baseline in the same harness for apples-to-apples comparison. Record the actual number here — prior estimates of "~15ms" are carried over from older notes and should not be trusted without fresh measurement.
- Document results in this file

**Success Criteria**:
- [ ] Benchmark results documented with methodology
- [ ] Performance meets expectations (sub-millisecond warm validation)

**Decision gate**: Expected outcome is sub-millisecond warm `parse()`. **Fail threshold is the re-measured tsc baseline from this phase's work** — if warm `parse()` is slower than the old engine, we'd be shipping a regression, so stop and investigate (likely a bundling or facet-loading issue, not typia itself). If warm `parse()` is faster than the tsc baseline but not yet sub-millisecond, document the number and continue — it's still a win, and not worth blocking on.

## Phase 7: Documentation

Write all docs before the package is published to npm — tag vocabulary, API reference, and migration guide all land here, not in earlier phases. This is the consolidated "docs before publish" phase for this task.

**Work**:
- New docs in `/website/docs/ts-runtime-parser-validator/` — overview, getting started, API reference. Update `website/sidebars.ts` to include the new section (Docusaurus does not auto-populate) and add an entry to the package table in `website/docs/introduction.mdx` marked **experimental**, alongside the existing `@lumenize/ts-runtime-validator` entry which should be marked **deprecated** with a pointer to the new package.
- Tag vocabulary reference page (the decisions recorded in Phase 3 written up as user-facing docs)
- Migration guide from `@lumenize/ts-runtime-validator` to `@lumenize/ts-runtime-parser-validator`
- `@default` semantics page including the practical "don't stack deep nested defaults" guidance from Phase 4

Nebula integration (updating `Resources.transaction()`, wiring Galaxy/Star) belongs to 5.2.4.2, not this task. The `npm deprecate` of `@lumenize/ts-runtime-validator` also moves to 5.2.4.2 — keeping it paired with Nebula's removal of the old dependency provides a hedge: if integration hits problems we can postpone the deprecation without having to un-deprecate. The **blog post also moves to the end of 5.2.4.2**: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring) in one post, and avoids announcing something that might still hit integration snags.

**Success Criteria**:
- [ ] Overview and getting-started pages published
- [ ] API reference page published (`compileTypesToParseModule()`, exported `parse()` from generated module)
- [ ] Tag vocabulary reference page published, covering every tag decided in Phase 3
- [ ] Migration guide published with before/after examples and a pointer from the old package's README
- [ ] `@default` page covers fill semantics, required/optional rule, full recursion, and the "lift deep nested defaults into their own interface" guidance
- [ ] Every executable code block in the new docs has an `@check-example('path/to/test')` annotation pointing at a passing `test/for-docs/` test — zero remaining `@skip-check` annotations. `npm run check-examples` passes. Note: `@skip-check-approved` may only be added by a human reviewer, never by Claude.

## Open Questions

Grouped by the phase that resolves them. None block starting Phase 1 — each is answered naturally during the phase listed. **Pause and confirm with the human when each phase is reached before committing to the answer.**

**Resolved by Phase 1 (Spike A — Bundling Feasibility):**
- Does the typia transformer need all types inlined in one virtual file, or does it resolve references across multiple virtual files?
- Bundle size of generated modules — how large is the JS output for typical type definitions?
- Do any runtime helpers we actually need do dynamic evaluation (which would break Worker compatibility)?
- **Facet bundle shape**: does the DO facet loader accept a module with exported functions as-is, or does it require the emitted bundle to expose a class? Answer constrains the form of `compileTypesToParseModule()`'s output in Phase 5.

**Resolved by Phase 2 (Spike B — Inline Feasibility, only if Spike A fails):**
- Actual trimmed LOC after stripping unused typia features
- TypeScript version compatibility maintenance burden — how often does typia need TS-compat fixes, how complex are they?

**Resolved by Phase 5 (Implementation) — answer via targeted test case:**
- Does typia handle `Map<string, string | number>` correctly? Desired semantic matches Workers RPC (heterogeneous `Map` value types supported). Targeted test in Phase 5; if typia differs, Phase 5's success criterion requires a working bridge (wrapper or equivalent) — documenting the gap alone is not acceptable, because Nebula's existing tests depend on this working.

## Resolved Concerns

- **Dynamic Workers / DO facets forbid `new Function` / `eval` — does typia use them?** No. Pure AST-to-AST transformer; emits static JS. Verify during Phase 1 that no runtime helper does dynamic evaluation. The DO facet is the only loader — no Node.js `new Function()` path exists.

- **Can we run the transformer in a Worker?** Yes. Standard `ts.TransformerFactory<ts.SourceFile>`, invoked via `program.emit()` with a virtual `CompilerHost`. Same pattern as the tsc engine. The transform package imports only `typescript` and its own core/utils — no `fs`/`path`/`process`/`child_process`.

- **Does `extractTypeMetadata()` need rewriting?** Partially. The AST approach (`ts.createSourceFile()`) is engine-independent and the relationship/write-shape logic ports as-is. But the function is **extended** with a new JSDoc pass (`ts.getJSDocTags()` per property) to collect `@default` values into `typeMetadata.defaults`. This replaces Nebula's current separate-config approach for defaults. Typia walks the same AST for its own `@default` extraction — useful as a cross-check. The extended `extractTypeMetadata()` is internal (non-exported); its output is consumed by `compileTypesToParseModule()` and baked into the generated module.

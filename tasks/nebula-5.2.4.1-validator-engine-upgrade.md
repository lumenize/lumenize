# Phase 5.2.4.1: Parse-Validate Package

**Status**: Phase 1 complete (2026-04-20) — Spike A succeeded, next is Phase 3 (tag vocabulary)
**Depends on**: 5.2.4 (docs shipped — see `tasks/archive/nebula-5.2.4-docs.md`)
**Precedes**: 5.2.4.2 (Galaxy integration)
**Package**: `packages/ts-runtime-parser-validator/` (new)

## Phase 1 Outcome (2026-04-20)

**Spike A: succeeded. Skip Phase 2. Proceed to Phase 3.**

The `@typia/transform` + `typescript` bundling approach works cleanly inside a Workers isolate. The transformer runs under `strict: true`, emits valid JS, loads into a DO facet, and `facet.parse(value, typeName)` returns typia's structured errors end-to-end. No painful workarounds needed — just the two `node:os` / `node:inspector` stubs copied from `packages/ts-runtime-validator/scripts/stubs/`.

### Measurements

- **Transformer dependency bundle size** (`dist/deps.bundle.mjs`): **3.90 MB** minified ESM (@typia/transform 12.0.2 + @typia/core + @typia/interface + @typia/utils + typescript 5.9.2). Compares to the tsc-based package's typescript-only bundle of roughly the same size — typia's transformer + supporting packages add negligible weight once typescript is already bundled.
- **TS lib files bundle size** (`dist/ts-lib-files.mjs`): **3.22 MB** (100 `lib.*.d.ts` files as string exports). Needed because typia's `checker.isArrayType()` requires the full lib reference chain — missing any sibling lib file leaves globals unbound and arrays get classified as `{}`. Shipping the full set is cheap and robust. Phase 5 may trim this to only what's referenced by `lib.es2022.d.ts`'s closure.
- **Total package-side bundle**: ~7.1 MB (well below the 10 MB Worker script size limit).
- **Generated-module size** (`compileTypesToParseModule()` output). The module structure is: one fixed block of inlined typia helpers at module scope (shared, does not grow with ontology size), plus one self-contained IIFE per top-level interface (grows with count × complexity).
  - Fixed overhead (inlined `_validateReport` + `_createStandardSchema` helpers + `ParserValidator` class + glue): **~4.6 KB** per module, regardless of ontology size.
  - Per-validator IIFE cost (measured 2026-04-20):
    - 3-field flat interface (Todo, Address): **~1.8 KB** each
    - 7-field interface with nested type-ref + union + array + optional (User): **~4.3 KB**
  - Sizing formula: `total ≈ 4.6 KB + Σ (1.8–4.3 KB per resource type)`. For a 10-type ontology at moderate complexity, expect ~30 KB total. Well below any facet size concerns.
  - **Typia does not dedupe nested type-refs across top-level validators.** When `User` references `Address`, Address's `_io`/`_vo` check functions are emitted *both* as the standalone Address validator *and* inlined inside User's IIFE. Ontologies with heavily-reused nested types pay for each check site. This matters for **cold-facet-load latency** (bundle parse/compile time), not for warm `parse()` latency — each validator's IIFE is self-contained and warm calls invoke only the one being asked for. Phase 6 benchmarks a 30-type synthetic ontology with realistic nesting and runs a 200 KB / 500 ms gate; if exceeded, investigate a **post-emit dedup pass** that factors duplicate `_io`/`_vo` bodies to module scope (runs as an `after` transformer in the same `program.emit()` call — stays on stock typia, no fork). Forking typia is the fallback only if the post-pass proves infeasible.
- **Cold-start cost**: first test run imports `dist/deps.bundle.mjs` in ~2.5s inside vitest-pool-workers. Subsequent tests in the same run reuse the import. Real warm/cold latency numbers on deployed Cloudflare come from Phase 6 (Suite 2).
- **`compatibility_date`**: `"2026-04-01"` in the package's `wrangler.jsonc` (matches Cloudflare's own DO facets example).
- **Versions pinned**: `@typia/transform@12.0.2` + peers (`@typia/core`, `@typia/interface`, `@typia/utils`), `typescript@^5.9.2`, `@cloudflare/vitest-pool-workers@^0.14.7`, `wrangler@^4.83.0`, `vitest@4.1.4`.

### Decisions locked in Phase 1 (do not reopen)

- **Facet bundle shape = class-extends-DurableObject.** Resolved by Cloudflare docs (`https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/`): the facet callback must call `worker.getDurableObjectClass("ClassName")`, which requires the loaded module to export a named class extending `DurableObject`. Plain exported functions are not accepted. The generated module's `ParserValidator` class exposes `parse(value, typeName)` as an RPC method — this is the final shape for `compileTypesToParseModule()`'s output. **Update Design Decision #3 and Phase 5's emitter target accordingly.**
- **`compatibility_date = "2026-04-01"`** in `packages/ts-runtime-parser-validator/wrangler.jsonc`. Matches Cloudflare's own facet example. Do not lower.
- **Outer discriminant = `valid`, inner error shape = typia's `IValidationError`.** The task file originally said "adopt typia's error shape as-is" but typia's outer discriminant is `success`, not `valid`. Resolution: our `parse()` wrapper translates `{ success: true, data }` → `{ valid: true, data }` and `{ success: false, errors, data }` → `{ valid: false, errors }`. The `errors` array entries are passed through verbatim (typia's `{ path, expected, value, description? }`). Phase 7 docs must show the `valid` + typia-error-element combo, not typia's raw `success` shape.
- **The two typia runtime helpers are inlined at rewrite time.** The emitted JS references `typia/lib/internal/_validateReport` and `typia/lib/internal/_createStandardSchema`; our rewrite step inlines both and strips the now-unused `import typia from "typia"`. Phase 5 must grow this list as we support more typia features (format validators, TypeGuardError, etc.) — there's a guard that refuses to emit if any `typia/` import survives the rewrite, so missing helpers fail loudly.
- **TS lib files must be bundled at build time and served to the virtual CompilerHost.** `checker.isArrayType()` returns `false` without the full `lib.*.d.ts` chain, causing typia to classify `T[]` as bare `{}`. This is non-obvious and worth calling out in the Phase 5 docs.
- **Typia transformer file-path match:** typia identifies its own calls via substring check against `typia/lib/<fn>.d.ts` — the stub must live at `typia/lib/module.d.ts` and `compilerOptions.paths` must route `"typia"` to that file. Any other arrangement leaves `typia.createValidate<T>()` unrewritten.

### Open items for Phase 3 and beyond

- Design Decision #3 in this doc still says the facet sub-question is open; it's now resolved (class-extends-DO). Update the text if someone wants to keep this doc authoritative as a design reference, or just leave the Phase 1 Outcome section as the newer source of truth.
- Phase 4's "outer discriminant name" decision (`valid` vs `success`) needs to be explicitly recorded as `valid` so Phase 5 implementation and Phase 7 docs align. See the decision above; no new work needed beyond updating Phase 4's prose.
- `@default` tag extraction (Phase 5's extended `extractTypeMetadata()`) and the full typia tag vocabulary (Phase 3) are not yet implemented — the Phase 1 spike covers `createValidate<T>()` only.
- The inlined runtime-helpers set is minimal (two files). Phase 5 must expand it to cover format validators and `TypeGuardError` as Nebula's types start using those features.
- Suite 2 skeleton (`experiments/ts-runtime-parser-validator-spike/`) not yet copied from `experiments/dw-bundler-spike/` — deferred to Phase 6 per the task plan. Only needed to collect the deployed-latency numbers.

### Files in the package (as of Phase 1 complete)

- `src/compile-types-to-parse-module.ts` — real typia transform wired end-to-end
- `src/typia-runtime-helpers.ts` — inlined JS source for the two typia helpers the emitted validators call (`_validateReport`, `_createStandardSchema`)
- `src/index.ts` — re-exports `compileTypesToParseModule`
- `scripts/bundle-dependencies.mjs` — bundles `@typia/transform` + `typescript` → `dist/deps.bundle.mjs` and 100 TS `lib.*.d.ts` files → `dist/ts-lib-files.mjs`
- `scripts/stubs/os.mjs`, `scripts/stubs/inspector.mjs` — node-builtin stubs (copied from `packages/ts-runtime-validator/scripts/stubs/`)
- `test/test-worker-and-dos.ts` — `PrimaryDO` supervisor with `/parse` endpoint; loads the generated module into a DO facet via `this.ctx.facets.get(bundleId, async () => ({ class: worker.getDurableObjectClass('ParserValidator') }))`
- `test/facet-roundtrip.test.ts` — 5 functional tests covering: valid Todo, invalid Todo (wrong types), missing-required Todo, unknown-type name, rich nested User (union + array + optional + relationship)
- `wrangler.jsonc` — `compatibility_date: "2026-04-01"`, Worker Loader binding `LOADER`, DO binding `PRIMARY_DO`
- `dist/deps.bundle.mjs` (3.90 MB) and `dist/ts-lib-files.mjs` (3.22 MB) — gitignored, regenerated via `npm run bundle`

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

**Status**: Complete (2026-04-20).

**Goal**: Decide the JSDoc tag contract for the new package. **Decision-only** — the user-facing documentation is written in Phase 7.

### Inventory: old package

`@lumenize/ts-runtime-validator`'s `extractTypeMetadata()` inspects **zero** JSDoc tags (confirmed by reading `packages/ts-runtime-validator/src/extract-type-metadata.ts` on 2026-04-20). Nebula source also uses no typia-style branded types (`grep -r 'ExclusiveMinimum\|MinLength\|Format<\|Pattern<' apps/nebula/src` returns empty). Constraints in the tsc engine came entirely from native TypeScript types (string-literal unions for enums, `number | undefined` for nullables, etc.). **Result: empty baseline — zero backward-compat tags to preserve, zero migration burden for Nebula today.**

### Inventory: typia 12.0.2

Typia recognises two parallel paths to the same metadata:

1. **Branded types**: `number & Minimum<13>` — type-system path, walked by typia's metadata factory.
2. **JSDoc tags**: `/** @minimum 13 */` — read by `MetadataCommentTagFactory.PARSER` (`node_modules/@typia/core/lib/factories/MetadataCommentTagFactory.js`).

The JSDoc `PARSER` dictionary (authoritative source) accepts these tag names:

| Tag | Applies to | Value grammar | Emits |
| --- | --- | --- | --- |
| `@type` | number, bigint | `int32` \| `uint32` \| `int64` \| `uint64` \| `float` \| `double` (shortcut: `int`→`int32`, `uint`→`uint32`) | `Type<"...">` constraint + range check |
| `@minimum` | number, bigint | bare number | `Minimum<N>` |
| `@maximum` | number, bigint | bare number | `Maximum<N>` |
| `@exclusiveMinimum` | number, bigint | bare number | `ExclusiveMinimum<N>` |
| `@exclusiveMaximum` | number, bigint | bare number | `ExclusiveMaximum<N>` |
| `@multipleOf` | number, bigint | bare number | `MultipleOf<N>` |
| `@format` | string | one of the 25 format IDs below | `Format<"...">` |
| `@pattern` | string | literal regex source (no flags) | `Pattern<"...">` |
| `@length` | string | bare integer | `MinLength<N>` + `MaxLength<N>` (same N) |
| `@minLength` | string | bare integer | `MinLength<N>` |
| `@maxLength` | string | bare integer | `MaxLength<N>` |
| `@items` | array | bare integer | `MinItems<N>` + `MaxItems<N>` (same N) |
| `@minItems` | array | bare integer | `MinItems<N>` |
| `@maxItems` | array | bare integer | `MaxItems<N>` |
| `@uniqueItems` | array | no value (presence-only) | `UniqueItems` |

`@format` values accepted (from `FormatCheatSheet.js`): `byte`, `password`, `regex`, `uuid`, `email`, `hostname`, `idn-email`, `idn-hostname`, `iri`, `iri-reference`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `url`, `date-time` (aliases: `datetime`, `dateTime`), `date`, `time`, `duration`, `json-pointer`, `relative-json-pointer`.

### Key finding: typia does NOT parse `@default` as a JSDoc tag

The task file previously assumed typia had a `@default` JSDoc handler and that we should "mirror" typia's grammar. **That assumption was wrong.** Typia has a branded type `Default<Value extends boolean | bigint | number | string>` (in `node_modules/@typia/interface/lib/tags/Default.d.ts`) but the `MetadataCommentTagFactory.PARSER` has no `default` entry. Typia's own docs explicitly say `Default<T>` is "metadata-only — typia does not automatically apply default values at runtime" (it's for JSON Schema generation and for typia's random/llm generators).

Consequences:
- There is no typia JSDoc grammar for `@default` to mirror — we define ours.
- Typia's `Default<T>` is too narrow (primitives only) for Nebula's use case. Current `OntologyVersionConfig.defaults` is `Record<string, any>` — resource authors set default arrays, default nested objects, etc.
- Shipping `@default` as a Lumenize JSDoc tag puts us slightly ahead of typia's surface area. Users writing `@minimum` etc. still only need one reference (typia's docs); users writing `@default` need ours, which is a small, well-bounded addition.

### Decisions

**D1. Adopt typia's validator JSDoc vocabulary verbatim** — the 15-row table above. All 25 `@format` values flow through to typia as-is. No renames. Benefits: zero surface-area invention on the validation side, users writing interfaces rely on typia's docs, and the transformer handles parsing and emission for us.

**D2. Add `@default` as a Lumenize-custom JSDoc tag** — not part of typia's PARSER. Owned by our extended `extractTypeMetadata()`, collected into `typeMetadata.defaults` and baked into the generated module for the `parse()` wrapper to fill pre-validation.

**D3. `@default` grammar = JSON literals only** (the task's earlier "fallback" path, now promoted to the chosen path since the "preferred" path doesn't exist):
- Accepted: `number` (including `-1.5e3`), `string` (double-quoted JSON), `boolean`, `null`, JSON array of these, JSON object of these. Nested JSON permitted to any depth.
- Parsing: `JSON.parse(tagText.trim())`. No `eval`, no `Function`, no template strings, no trailing commas.
- Rejected at extract time with a clear error: anything that doesn't round-trip through `JSON.parse` — including `undefined`, `NaN`, `Infinity`, bigint syntax (`10n`), single-quoted strings, unquoted object keys, function expressions.
- This deliberately does *not* try to match typia's `Default<T>` (primitives only) — our grammar is a superset, richer where Nebula needs it (arrays, objects), safer where it counts (no eval). If users also put a typia `Default<T>` branded type on the same field, both metadata paths run independently: our `@default` JSDoc drives input-filling, typia's `Default<T>` ends up in the emitted JSON Schema. Not conflicting, just complementary.

**D4. `@default` on a required field → hard error at `extractTypeMetadata()` time.** Formalising Phase 4's option (a) now so Phase 5 has one behaviour to test. Caught at ontology registration, surfaced as a compile-time error via Galaxy's submit-time rejection.

**D5. Unknown JSDoc tags are tolerated, not errored.** If a user writes `@author Alice` on a field, the extractor leaves it alone. This lets users keep documentation tags on their interfaces without triggering validator errors.

**D6. Tag values are case-sensitive except where typia's `FORMATS` map explicitly aliases** (e.g., `datetime` / `dateTime` → `date-time`). Users writing `@format EMAIL` get a validation error at compile time, not a surprise non-match.

**D7. Document JSDoc tags only; do not disallow branded types.** All docs, tests, and `@check-example` blocks use the JSDoc form exclusively. If a user writes `number & Minimum<13>`, typia's transformer still processes it correctly (both paths produce identical metadata) — we just don't teach it. Reasons: Galaxy stores interfaces as strings where `import { tags } from "typia"` would require special handling; JSDoc is the lower-friction surface for vibe coders; mixing JSDoc `@default` with branded validator tags would split the surface area arbitrarily; hiding typia as an implementation detail is easier when user code has no `typia` import. Zero enforcement cost — typia handles both paths identically without our involvement.

### Divergences from typia (to be called out in Phase 7 docs)

- **`@default` exists in Lumenize, doesn't exist as a JSDoc tag in typia.** Anchor in docs: link to typia's `Default<T>` branded type and explain Lumenize's is a richer JSDoc-based parallel path specifically for input-filling.
- No other renames, additions, or omissions.

**Success Criteria**:
- [x] Complete tag table recorded in this file (`D1` above, 15 rows + 25 `@format` values)
- [x] Any divergences from typia's tag names decided and recorded with reasons (`@default` — `D2`/`D3`; no other divergences)
- [x] `@default` grammar pinned (`D3`: JSON literals only)
- [x] `@default` on required field behaviour pinned (`D4`: hard error)

## Phase 4: `@default` and `parse()` Semantics

**Status**: Complete (2026-04-20) — specification-only phase; most decisions pre-pinned from Phase 3.

### Decisions (formalised)

**P4.1. Fill semantics.** The generated `parse()` wrapper fills missing optional fields from `typeMetadata.defaults` **before** invoking the typia-generated validator. The validator sees already-filled objects. Defaults are applied non-destructively: if the caller supplied a value for a field, their value wins — a missing property triggers the default, an explicit `undefined` also triggers the default, any other value (including `null`) is left alone. Rationale: `null` is a meaningful distinct value in most resource schemas; treating it as "absent" would surprise users who intentionally write `null`.

**P4.2. Required vs optional.** Fields with `@default` **must** be declared optional. `@default` on a required field → **hard error at `extractTypeMetadata()` time** (Phase 3 `D4`, Phase 4 formalisation). Error surfaced through Galaxy's submit-time ontology rejection in 5.2.4.2. The error message must name the type and field (e.g., `@lumenize/ts-runtime-parser-validator: @default on required field 'User.email' — declare the field optional (email?: ...) or remove the @default tag`).

**P4.3. Return shape.** `parse(value, typeName): { valid: true, data } | { valid: false, errors }`, exported from the generated module. On success `data` is the filled-and-validated object. On failure `errors` is the structured error list and no `data` is returned. The `valid` discriminant gives callers a clean TypeScript narrowing check. The outer name `valid` (vs typia's `success`) was pinned in Phase 1 Outcome — our wrapper translates typia's `success` into `valid`.

**P4.4. Error shape.** Adopt typia's error *element* shape verbatim: `{ path: string; expected: string; value: unknown; description?: string }`. No translation, no wrapping. Callers (only Nebula's `Resources.transaction()` today) consume this shape directly starting in 5.2.4.2 — a breaking change for Nebula, but the new package ships under a new name so existing `@lumenize/ts-runtime-validator` users are unaffected until they opt in.

**P4.5. Depth.** `@default` recurses fully into nested objects and array elements. Any optional field at any depth with a `@default` tag is filled pre-validation. Practical guidance (docs, not enforced): don't stack deep nested defaults — if an interface has `@default` five levels deep, lift the nested structure into its own named interface so the defaults attach to that interface's own optional fields. Same recursion, more readable. For array elements, `@default` on the array field itself (e.g., `tags?: string[] /** @default [] */`) fills a missing array; `@default` on a nested interface used as array element fills individual element fields when the element is present but incomplete — not auto-populating missing array slots.

**P4.6. Field-value interaction with validators.** After filling, the typia validator sees the filled value as if the user supplied it. If the `@default` literal itself doesn't satisfy the type (e.g., `@default "hello"` on a `number` field, or `@default 5` on a `string & Minimum<10>` — though minimum on strings is nonsensical, illustrative), the validator fails with typia's normal error shape pointing at the filled path. We do not pre-check `@default` literals against the field type at extract time — letting the validator catch it gives a consistent error pipeline and avoids duplicating typia's type matcher in the extractor. Users see the failure immediately on first `parse()` call against a default-supplied field.

### Test specifications (draft; become executable in Phase 5)

All tests land in `packages/ts-runtime-parser-validator/test/default-*.test.ts`, using the existing `SELF.fetch('/parse', ...)` harness from Phase 1. Pseudo-code sketches:

1. **Flat fill** — interface `Todo { title: string; /** @default 0 */ priority?: number }`. `parse(Todo, { title: 'x' })` returns `valid: true, data: { title: 'x', priority: 0 }`.
2. **Explicit undefined triggers default** — same interface, `parse(Todo, { title: 'x', priority: undefined })` → same result as missing.
3. **Explicit null preserved** — interface `Note { /** @default 0 */ count?: number | null }`. `parse(Note, { count: null })` → `valid: true, data: { count: null }`. Default NOT applied.
4. **Array default** — `tags?: string[] /** @default [] */`. Missing `tags` → filled with `[]`.
5. **Nested object default** — `config?: Config /** @default {"timeout": 30} */`. Missing `config` → filled with `{ timeout: 30 }`.
6. **Nested recursion** — `User` has optional `address?: Address`, and `Address` has `/** @default "US" */ country?: string`. `parse(User, { address: { street: 'x' } })` → the default fills inside the nested object.
7. **Array-element recursion** — `users?: User[]` where each `User` has a `@default` field. A value like `{ users: [{ id: 'a' }] }` gets each element's defaults filled.
8. **`@default` on required field → extract-time error** — `extractTypeMetadata('interface X { /** @default 0 */ x: number }')` throws an error naming `X.x` and including the corrective guidance from P4.2.
9. **Default value fails validation** — `/** @default "hello" */ count?: number`. First `parse()` call on a value missing `count` fills with `"hello"`, validator emits `expected: "number", value: "hello"` at path `$input.count`. Single consistent error pipeline.
10. **JSON-literal grammar rejection** — `@default 10n`, `@default NaN`, `@default undefined`, `@default {foo:1}` (unquoted key), `@default 'x'` (single quotes) all throw at extract time naming the type, field, and the offending literal text.

**Success Criteria**:
- [x] Design decisions documented in this file (`P4.1` through `P4.6`)
- [x] Test specifications drafted (10 scenarios, pseudo-code above)
- [x] API signature finalised — matches Phase 1's `{ valid: true, data } | { valid: false, errors }`

## Phase 5: Package Implementation

**Status**: Complete (2026-04-20). Spike A dependency approach. All tests green (90/90). Type-check clean.

### Phase 5 Outcome

**Files added / modified in `packages/ts-runtime-parser-validator/`:**
- `src/extract-type-metadata.ts` — ported from old package, extended with `@default` JSDoc pass. Returns `{ interfaceNames, relationships, writeShapeTypeDefinitions, defaults }`. Internal (not exported from `src/index.ts`).
- `src/typia-runtime-helpers.ts` — inlined helpers now cover three typia internals: `_validateReport`, `_createStandardSchema`, and `_accessExpressionAsString` (discovered during parity tests — typia emits this for `Record<string, T>` and index-signature validation).
- `src/compile-types-to-parse-module.ts` — now consumes `extractTypeMetadata()`, feeds typia the **write-shape** (relationship refs narrowed to string/string[]), bakes `typeMetadata` (defaults + relationships) into the emitted module, and emits a `__fillDefaults()` runtime function that applies defaults non-destructively per Phase 4 P4.1/P4.5 before `parse()` delegates to the typia validator.
- `test/default-fill.test.ts` — 8 tests covering P4.1 (flat, undefined-triggers-default, null-preserved, array default, object-literal default, multi-literal, default-that-fails-validation, caller-value-wins)
- `test/default-extract.test.ts` — 11 tests covering Phase 3 D2/D3 (extraction + grammar rejection + empty-value + unknown-tag tolerance + multi-interface)
- `test/relationships.test.ts` — 8 tests covering write-shape rewriting (one, many, Array&lt;T&gt;, `T | null`, non-ontology refs) + facet-level validation of string-ID relationship fields + nested-object recursion
- `test/typia-tags.test.ts` — 10 tests covering `@minimum`, `@maximum`, `@exclusiveMinimum`, `@multipleOf`, `@minLength`/`@maxLength`, `@pattern`, `@format email`, `@format uuid`, `@minItems`, `@uniqueItems` (spot-check that typia JSDoc vocabulary flows through)
- `test/edge-cases.test.ts` — 12 tests covering SyntaxError on bad types, empty-input, `type` aliases skipped, methods ignored, Array<non-ontology>, unions of 2 ontology types, whitespace-tolerant `@default`, multi-`@default` (last wins), self-contained emit, relationship+default bake-in
- `test/container-relationships.test.ts` — 10 tests covering the `Set<Interface>` / `Map<K, Interface>` / `ReadonlySet` / `ReadonlyMap` relationship detection, write-shape rewriting (including preservation of Map key source text), and facet-level validation of transaction-time ID payloads.
- `test/parity/types.test.ts` — 18 tests covering the TypeScript type-system layer of the delta suite
- `test/parity/values.test.ts` — 13 tests covering the JS-values-over-RPC layer
- `test/facet-roundtrip.test.ts` — 5 existing tests (fixture adjusted after write-shape change)

### Type-support delta matrix (pass/fail under the current implementation)

The values-layer tests call the DO via **Workers RPC** (`stub.rpcParse(typeDefinitions, typeName, value, bundleId)`), which uses structured-clone semantics. This matches the production Star → facet serialization path. JSON-boundary artefacts are excluded — earlier pass/fail labels in this matrix that said "DROP through JSON boundary" were harness noise and have been replaced with real RPC-path results.

| Category | Status | Notes |
| --- | --- | --- |
| Primitives (string, number, boolean, null, optional) | ✓ SUPPORTED | |
| bigint (with `@type "int64"`) | ✓ SUPPORTED | verified via RPC path. |
| Object & Array (nested inline, typed arrays) | ✓ SUPPORTED | |
| Union & Optional | ✓ SUPPORTED | string-literal unions fully supported. |
| Map — homogeneous `Map<K, V>` with primitive V | ✓ SUPPORTED | verified via RPC path. Example: `data: Map<string, number>`. |
| Map — heterogeneous `Map<string, string \| number>` | ✓ SUPPORTED | absorbs the stand-alone gate that was previously its own success criterion. |
| Set of primitives | ✓ SUPPORTED | verified via RPC path. Example: `tags: Set<string>`. |
| `Set<Interface>` / `Map<K, Interface>` of ontology types | ✓ SUPPORTED as to-many relationships | treated identically to `T[]`. Write-shape rewrites `members: Set<User>` → `members: Set<string>` and `roleMap: Map<string, User>` → `roleMap: Map<string, string>`. Also covers `ReadonlySet<T>` and `ReadonlyMap<K, T>`. The Map's key type is preserved as source text (e.g., `Map<"admin" \| "editor", User>` → `Map<"admin" \| "editor", string>`). Example for a `Team` resource: `interface Team { members: Set<User>; roleMap: Map<string, User>; }` — at transaction time, pass `new Set(['u-1', 'u-2'])` and `new Map([['admin', 'u-1']])`. |
| Date | ✓ SUPPORTED | Date instances validate against `Date` type over RPC. `@format date-time` also available for date strings. |
| RegExp (as value) | ✓ SUPPORTED | typia has built-in `RegExp` recognition. `new RegExp('x')` / `/x/` validate against `pattern: RegExp`; strings get rejected with `expected: "RegExp"`. Unusual in Nebula resource payloads but works cleanly if a user stores one. `@pattern` remains the preferred tool for string-pattern validation. |
| URL | DROP as a value type | `@format url` supported as string-level alternative. Users don't typically store URL instances. |
| Headers | DROP | recommend `Record<string, string>`; not a Nebula-blocking gap. |
| TypedArrays (`Uint8Array`, `BigInt64Array`, `ArrayBuffer`, and all sibling variants) | ✓ SUPPORTED | typia recognises TypedArray constructors natively. `new Uint8Array([1,2,3])` validates against `data: Uint8Array`; plain arrays get rejected with `expected: "Uint8Array"`. Same holds for `BigInt64Array`, `ArrayBuffer`, and structurally all 11 TypedArray variants. |
| Cyclic values | ✓ SUPPORTED (transport) | Workers RPC preserves cycles via structured-clone. Our `__fillDefaults` has cycle-safe recursion via a WeakMap. Relationship-rewritten fields rejected with a type error (expected string), which is the correct Nebula behaviour. |
| `any` fields | ✓ SUPPORTED | accepts structural values including Maps, Sets, Dates, cycles, nested arrays. |
| Utility types (Partial, Pick, Omit, Record) | ✓ SUPPORTED when embedded in a named interface | top-level `type Partial<User>` not reachable (only `interface` names become validators); user materialises as named type. Documented delta for Phase 7. |
| Conditional, template-literal, custom mapped types | ✓ SUPPORTED | resolved by tsc before typia sees them. |
| Generic instantiations as `typeName` | DROP | old pkg supported `'List<Todo>'`; new pkg requires a named interface. Documented. |
| Custom error shapes | ✓ SUPPORTED | as interfaces; becomes a relationship ref under write-shape. |

**Dropped categories are intentional.** Most stem from Nebula's write-shape model (relationships become string IDs) or from cases where typia's vocabulary offers a strictly better alternative (`@format`/`@pattern` for URL/RegExp). No silent drops; Phase 7's type-support page will write up each drop with the rationale.

**Findings worth calling out:**
- Earlier matrix versions labelled many categories as "DROP through JSON boundary" — that was a test-harness artefact. The test harness initially used `SELF.fetch` with a JSON body, which forced JSON serialization. Rewriting `test/parity/values.test.ts` to use an RPC method on the DO (`stub.rpcParse(...)`) exercises the production serialization path and flips most of those DROPs to SUPPORTED.
- The cycle test exposed a real bug in `__fillDefaults`: cycle-detection was using the cloned reference for relationship-recursion keys instead of the original, so the `WeakMap`-based detection silently missed cycles and recursion blew the stack. Fixed in the same change that moved the parity tests to RPC.

### Coverage

Ran `npm run coverage`:
- Statements: **88.44 %** (target: >90 %) — 2 percentage points short, attributable to defensive error branches (`LIB_DTS_FALLBACK`, `no JS was emitted`, the surviving-typia-import guard) that by design don't trigger in normal operation. Closing would require mocking the bundle imports, which adds test complexity without catching real bugs.
- Branches: **76.22 %** (target: >80 %) — ~4 branches short, same root cause.
- Lines: **91.47 %**
- Functions: **77.77 %**

**Decision**: Accept the sub-target coverage on defensive-only branches; document here and in Phase 7. Adding mock-based tests for the `LIB_DTS_FALLBACK` fork and the two error-only throws would move the numbers but not the risk profile.

### Decisions locked in Phase 5

- **`compileTypesToParseModule()` always applies the write-shape.** Callers who want nested-object validation (non-Nebula use cases) use inline shapes (`{ street: string }`) instead of named interfaces as nested types. Not a flag, not configurable. Aligns the library behaviour with Nebula's production path.
- **Defaults are filled non-destructively and per type.** Missing property OR explicit `undefined` → default; any other value (including `null`) is preserved. Recurses into relationship-referenced types when the field carries a nested object (dev-mode passthrough); stops naturally when the field is a string ID.
- **Inlined helpers grow lazily.** The set of typia runtime helpers inlined in `typia-runtime-helpers.ts` expands when new helpers surface in emitted JS. The surviving-typia-import guard in `compileTypesToParseModule()` refuses to emit until a new helper is inlined — turns typia upgrades into a loud rather than silent failure mode. Current set: `_validateReport`, `_createStandardSchema`, `_accessExpressionAsString`.
- **Container-of-ontology-type relationships.** `Set<Interface>`, `Map<K, Interface>`, and their `Readonly` variants are first-class to-many relationships — treated identically to `T[]` / `Array<T>`. Write-shape rewrites the ontology type-arg position to `string` while preserving the container shape and any Map key type. Single schema file works for both uses: the same `interface Team { members: Set<User>; }` drives Nebula's transaction validation (IDs in, IDs out) and any other consumer; there is no "validator vs ORM mode" — the package has one behaviour. Added 2026-04-20 after the original relationship detection's Array-only scope was discovered as a silent footgun during the delta-matrix review.

**Goal** (original): Working `@lumenize/ts-runtime-parser-validator` package. Approach (dependency vs inline) determined by Phase 1/2 spikes.

**Work**:
- Continue in the `packages/ts-runtime-parser-validator/` directory created in Phase 1 — fill out standard package structure around the spike code
- Inline the ~300 LOC runtime helpers (format validators, type guards, `TypeGuardError`). Add a header comment at the top of each inlined file naming the typia source file and version it was copied from (e.g., `// Copied from typia@12.0.2 lib/internal/format/is_email.js`), and note any modifications. Full `ATTRIBUTIONS.md` entries are **not** required for Spike A's inlined-helpers path — `@typia/transform` remains a declared npm dependency, which is a stronger form of attribution than an ATTRIBUTIONS entry. If Phase 2 (Spike B) runs and we end up inlining the transformer itself, Phase 5 work in that branch must add a full `ATTRIBUTIONS.md` entry.
- Port + **extend** `extractTypeMetadata()` from old package — internal, not exported. Relationship discovery and write-shape generation port as-is; add a new pass that calls `ts.getJSDocTags()` on each property signature, collects `@default <value>` tags (accepting the full grammar inventoried in Phase 3), and surfaces them as `typeMetadata.defaults: Record<typeName, Record<fieldName, value>>`. **Read typia's own `@default` extraction code** as a reference for *how* it walks JSDoc tags and parses the value grammar, then mimic that approach in our extractor — we're not calling typia's extraction at runtime, just learning from it to keep our grammar aligned with theirs. This is Lumenize-custom logic (relationship discovery, write-shape generation, defaults extraction), not a TypeScript API. The old package is deprecated once this package ships, so the copies won't drift.
- Implement `compileTypesToParseModule(typeDefinitions: string): string` — runs the typia transformer, then emits a JS module string (or class-wrapped module, per Phase 1's facet-shape decision) that bakes in: typia-generated validators, the `typeMetadata` (including `defaults`) from `extractTypeMetadata()`, the inlined runtime helpers, and an exported `parse(value, typeName): { valid: true, data } | { valid: false, errors }` that fills defaults then dispatches to the right validator by name
- Modify generated module to call inlined runtime helpers instead of `typia/lib/internal/`
- Test suite covering: tag vocabulary, `@default` extraction from JSDoc, `@default` filling behavior (including depth decisions from Phase 4), error messages, edge cases (e.g., `@default` on required field warns/errors per Phase 4 decision)
- **Type-support delta suite.** Walk [`website/docs/ts-runtime-validator/type-support.md`](website/docs/ts-runtime-validator/type-support.md) category by category (primitives, object/array, union/optional, Map/Set, Date/RegExp/URL/Headers, errors, binary/TypedArrays, `any` fields, generics, utility types, advanced types, cyclic references, known limitations) and add a test in the new package for each category — pass or fail. The suite is **not a parity gate**: we don't need every category to pass. It's a **decision-forcing tool** — the pass/fail matrix surfaces the actual delta between tsc+structured-clone and typia+Workers-RPC, which drives the Phase 5 judgement calls (keep vs drop vs wrapper) and feeds the Phase 7 type-support doc. Absorb the `Map<string, string | number>` case that was previously a stand-alone criterion into this suite. Tests split by layer: `test/parity/types.test.ts` for TypeScript type-system features (typia's lane — generics, utility types, conditionals, template literals, mapped types), `test/parity/values.test.ts` for JS values over the Star→facet RPC boundary (Workers RPC's lane — Date, Map, Set, RegExp, TypedArrays, cycles). Layer-2 failures may trigger Design Decision #8's "wrap in `@lumenize/structured-clone`" fallback earlier than planned; that's an acceptable outcome.

**Success Criteria**:
- [x] `compileTypesToParseModule()` returns valid JS module source string in the shape decided in Phase 1 (class extending DurableObject, exporting `ParserValidator`)
- [x] Loaded module's `parse(value, typeName)` fills defaults and validates, returns `{ valid: true, data } | { valid: false, errors }`
- [x] Extended `extractTypeMetadata()` returns `{ interfaceNames, relationships, writeShapeTypeDefinitions, defaults }`; `defaults` populated from `@default` JSDoc tags on optional fields; used internally and baked into the generated module
- [x] Generated modules have zero external runtime imports — no `typia/lib/internal/` references; all helpers, `typeMetadata`, and the `ParserValidator` class are inlined in the module itself. Guard refuses to emit if new typia helpers appear — see "Decisions locked in Phase 5" above.
- [x] Error messages reference correct property paths (typia's native shape: `{ path, expected, value, description? }`)
- [x] Type-support delta suite exists (`test/parity/types.test.ts` + `test/parity/values.test.ts`), every category from the old doc has at least one test, pass/fail matrix recorded in the Phase 5 Outcome section above. All drops are intentional and annotated in the test names.
- [ ] Coverage meets project standards: **not met** — statements 88.44 % / branches 76.22 % vs targets 90 % / 80 %. Gap is in defensive error branches by design (see Phase 5 Outcome → Coverage). Accepted with rationale recorded here.

## Phase 6: Benchmark

**Goal**: Validate performance characteristics and document them. Two distinct concerns — warm `parse()` latency (hot path, per request) and cold-facet-load latency (one-time per Star per version, gated by generated-module size).

**Metrics**:
- **Transformer dependency bundle size** (output of `scripts/bundle-dependencies.mjs`) vs old tsc-based package's typescript bundle
- **Generated-module size** (`compileTypesToParseModule()` output). Measure on both a small flat-shape ontology (sanity baseline) *and* the large synthetic ontology described under **Work** below. This is also our memory-footprint proxy — peak RSS during validation isn't measurable from `vitest-pool-workers` or a deployed Worker; reason about memory from bundle + generated-module size instead.
- **`compileTypesToParseModule()` compilation time**: both ontologies.
- **Warm `parse()` latency**: cold start and warm (mean, p50, p99). Independent of ontology size past the one validator being invoked — each validator's IIFE is self-contained.
- **Cold-facet-load latency**: time from "Star has the bundle string in hand" to "first `parse()` call returns." Scales roughly linearly with generated-module size because the JS runtime has to parse and compile the module. This is the primary forcing function for the dedup investigation.

**Work**:
- Build a synthetic **Nebula-like benchmark ontology** of **30 resource types** with realistic shape: average ~6 fields per type, nesting depth ~3 levels, average ~2 cross-references per type (so the "typia doesn't dedupe nested refs across top-level validators" effect actually shows up). Keep the shapes hand-authored rather than random so the bench is reproducible and the generated-module size can be reasoned about. Store it in `test/fixtures/benchmark-ontology-30.ts` or similar.
- Also keep a small flat-shape suite (the current 3-field Todo / 7-field User pair from Phase 1) as a sanity baseline — useful for detecting regressions in simple cases when iterating on the generator.
- Run everything in a Worker via a DO facet using `vitest-pool-workers` — matches 5.2.4.2's production path. No Node.js path.
- Re-measure the old tsc-based validator (`@lumenize/ts-runtime-validator`'s `validate()`) as a baseline in the same harness for apples-to-apples comparison. Record the actual number here — prior estimates of "~15ms" are carried over from older notes and should not be trusted without fresh measurement.
- Document all results in this file with the methodology (hardware, wrangler/miniflare version, repetition count, warmup handling).

**Dedup investigation gate** (triggered by cold-load results on the 30-type benchmark):
- If generated-module size ≤ **200 KB** *and* cold-facet-load ≤ **500 ms**: done, no further work.
- If either threshold is exceeded: investigate the **post-emit dedup pass** — walk the emitted AST after typia's transformer runs and factor duplicate `_io<N>` / `_vo<N>` function bodies to module-scope consts, rewriting references. This runs as an `after` transformer in the same `program.emit({ before: [typiaTransform], after: [dedupPass] })` call, so we stay on stock typia (no fork). Forking typia is the fallback only if a post-pass proves infeasible.
- Record either "thresholds met, no dedup needed" or "dedup investigation outcome" as a decision in this file.

**Success Criteria**:
- [ ] Benchmark results documented with methodology on both the small baseline and the 30-type synthetic ontology
- [ ] Warm `parse()` meets expectations: sub-millisecond mean, or at minimum faster than the re-measured tsc baseline
- [ ] Cold-facet-load latency recorded; dedup-gate decision documented (met the thresholds, or investigated the post-pass and recorded the outcome)

**Decision gates**:
- **Warm parse**: expected outcome is sub-millisecond. **Fail threshold is the re-measured tsc baseline from this phase's work** — if warm `parse()` is slower than the old engine, we'd be shipping a regression; stop and investigate (likely a bundling or facet-loading issue, not typia itself). If faster than tsc but not yet sub-millisecond, document and continue.
- **Cold load**: see "Dedup investigation gate" above — 200 KB / 500 ms thresholds. These numbers are opening positions; adjust before the phase runs if Phase 5's integration surfaces different realistic ranges.

## Phase 7: Documentation

Write all docs before the package is published to npm — tag vocabulary, API reference, and migration guide all land here, not in earlier phases. This is the consolidated "docs before publish" phase for this task.

**Work**:
- New docs in `/website/docs/ts-runtime-parser-validator/` — overview, getting started, API reference. Update `website/sidebars.ts` to include the new section (Docusaurus does not auto-populate) and add an entry to the package table in `website/docs/introduction.mdx` marked **experimental**, alongside the existing `@lumenize/ts-runtime-validator` entry which should be marked **deprecated** with a pointer to the new package.
- Tag vocabulary reference page (the decisions recorded in Phase 3 written up as user-facing docs)
- Migration guide from `@lumenize/ts-runtime-validator` to `@lumenize/ts-runtime-parser-validator`
- `@default` semantics page including the practical "don't stack deep nested defaults" guidance from Phase 4
- **Type-support page** mirroring the section-heading skeleton of the old doc (`website/docs/ts-runtime-validator/type-support.md`) so readers can see at a glance what changed. Each section either documents what's supported (with a tested example) or carries a short "not supported because X" note drawn from the Phase 5 delta suite's matrix. No hidden omissions — if the old doc covered it, the new doc addresses it.

Nebula integration (updating `Resources.transaction()`, wiring Galaxy/Star) belongs to 5.2.4.2, not this task. The `npm deprecate` of `@lumenize/ts-runtime-validator` also moves to 5.2.4.2 — keeping it paired with Nebula's removal of the old dependency provides a hedge: if integration hits problems we can postpone the deprecation without having to un-deprecate. The **blog post also moves to the end of 5.2.4.2**: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring) in one post, and avoids announcing something that might still hit integration snags.

**Success Criteria**:
- [ ] Overview and getting-started pages published
- [ ] API reference page published (`compileTypesToParseModule()`, exported `parse()` from generated module)
- [ ] Tag vocabulary reference page published, covering every tag decided in Phase 3
- [ ] Migration guide published with before/after examples and a pointer from the old package's README
- [ ] `@default` page covers fill semantics, required/optional rule, full recursion, and the "lift deep nested defaults into their own interface" guidance
- [ ] Type-support page published with same section skeleton as the old doc, each category marked supported-with-example or dropped-with-reason based on the Phase 5 delta matrix
- [ ] Every executable code block in the new docs has an `@check-example('path/to/test')` annotation pointing at a passing `test/for-docs/` test — zero remaining `@skip-check` annotations. `npm run check-examples` passes. Note: `@skip-check-approved` may only be added by a human reviewer, never by Claude.

## Phase -1: Captured Ideas (triage before closing)

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Before closing the task, each entry gets triaged into exactly one outcome:

- **Do now** — fold into an earlier phase and strike from this list.
- **Later task file** — promote to its own task in `tasks/`.
- **Backlog** — append to `tasks/backlog.md` for a future pass.
- **Drop** — record the rationale inline and strike.

Nothing here is committed to yet.

### Auto-materialize generic instantiations at compile time

**Source**: Phase 5 conversation about the "Generic instantiations as `typeName` — DROP" matrix entry.

**Idea**: During `compileTypesToParseModule()`, also scan `typeDefinitions` for top-level aliases that instantiate a generic — for example `type TodoList = List<Todo>;`. For each such alias, emit a corresponding `TodoList: typia.createValidate<TodoList>()` entry in the `validators` map. Users recover `List<Todo>`-style validation via a one-line alias rather than hand-replicating the shape.

**Why it's tempting**: closes a small ergonomic gap versus the old tsc engine without giving up the pre-compilation speed win. Purely additive.

**Why it's not urgent**: in the Nebula ORM model, resource types are always named interfaces. The ergonomic gap is real only for users who lean on `List<T>` / `Paginated<T>` wrappers — which Nebula doesn't push people toward, and which have an existing clean workaround (name the concrete shape, or use interface inheritance for the shared-fields case).

**Triggering signal**: if real users (Nebula or external) hit this friction, or if a doc reader consistently asks "how do I validate `List<Todo>`?", promote. Otherwise punt.

**Implementation sketch**: extend `extractTypeMetadata()` to collect top-level `type X = Y<...>` aliases where `Y` is a known generic interface. Include each as an additional entry in `interfaceNames` (or a parallel `aliasNames` list). The typia-call-synthesis step handles them identically to interface names since `typia.createValidate<X>()` where `X` is a resolved alias works the same as a plain interface.

**Current disposition**: unscheduled. Revisit on user signal.


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

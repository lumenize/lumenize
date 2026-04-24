# Typia Visit-Tracking: Copy In + Modify

**Status**: Not started. Pre-release blocker for `@lumenize/ts-runtime-parser-validator` (5.2.4.1). Surfaced 2026-04-23 during 5.2.4.1 Phase 6.7 pre-implementation review.

**Depends on**: None (typia 12.0.2 is pinned).
**Precedes**: `tasks/nebula-5.2.4.1-validator-engine-upgrade.md` Phase 6.7 (wire-in).
**Artifact**: `packages/ts-runtime-parser-validator/forks/typia/` — copied TypeScript source from `samchon/typia@v12.0.2`, modified in-place.

## Objective

Copy typia's four runtime packages (`@typia/transform`, `@typia/core`, `@typia/interface`, `@typia/utils`) into `@lumenize/ts-runtime-parser-validator` and add visit-tracking to generated validators so:
- **Cycles** validate natively (no stack overflow on `node.parent = node` against `parent: Node | null`).
- **Aliased subtrees** validate once, not per-alias.

**Framing: copy in + modify, not a GitHub fork.** We pull typia source files we need into our tree and own them from there. The `forks/typia/` folder name uses the common vendoring convention, but there's no upstream-tracking branch, no submodule, no clone of `samchon/typia` — just source files checked in alongside our own. Phase 0 posts a GitHub issue to gauge Samchon's interest in upstreaming; a positive signal unlocks Phase 4 (reconstitute as a real GitHub fork + PR), negative or silent means we skip Phase 4 and carry our copy indefinitely.

## Motivation

Every other Lumenize transport (Workers RPC, `@lumenize/structured-clone`, Mesh `call()`) preserves cyclic and aliased references end-to-end. Typia's generated validator is the only hop that doesn't — it has no visit tracking, so cycles stack-overflow and DAG aliases get re-walked. Shipping the parser-validator without a fix means documenting "everything else handles cycles, this one doesn't" at release time.

The wrap alternative (acyclify pre-pass + null substitution + restore + error-path remapping inside `__fillDefaults`) was weighed during the 2026-04-23 review and rejected. Duplicate effort relative to the modification itself, can't dedup non-nullable aliases, ships two release-risk surfaces. Full rationale under "Alternatives Considered and Rejected" below.

## Design Decisions

**D1. Scope: all four typia runtime packages — `@typia/transform`, `@typia/core`, `@typia/interface`, `@typia/utils`.** Drop `@typia/transform` from `package.json` dependencies (the only direct dep; the other three are transitive and fall out with it). typia's other surfaces (random, json, clone, protobuf) live inside `@typia/core` and come along automatically — we don't strip them in Phase 1 (Phase -1 captures "narrow the copied surface further" as a follow-on). Copying all four is cleaner than the two-copied-plus-two-npm middle ground because the bundle already inlines all four via esbuild; listing two as npm deps just keeps them in the SCA-scanning footprint without reducing runtime content.

**D2. Location: `packages/ts-runtime-parser-validator/forks/typia/`.** Not a workspace package — just files the existing `scripts/bundle-dependencies.mjs` pulls from.

**D3. Copy the TypeScript source (`src/`), not compiled `lib/`.** Modifying TS source matches what an upstream PR would touch if Phase 4 runs, and keeps the visit-tracking diff readable. We own the build step that produces JS for `bundle-dependencies.mjs` to consume.

**D4. Base version pin: typia 12.0.2.** Source comes from the `v12.0.2` tag on `samchon/typia`. No rebasing during the life of this task.

**D5. Visit-tracking is unconditional in our copy.** Allocate one `WeakMap` per top-level validator call; check + record on entry to cycle-risk positions; no-op on re-entry (see D6). No parameter threading, no toggle. If Phase 4 runs, the upstream PR introduces the opt-in parameter then — a non-breaking default matters for Samchon's existing users, not for us. Keeping our copy unconditional shrinks the Phase 1–3 diff.

**D6. Re-entry is a no-op.** The visit-tracking check short-circuits re-entry without emitting errors and without recursing further. Errors collected during the first visit stay in typia's accumulating report; skipping re-entry just avoids infinite recursion on cycles and duplicate-error emission on aliased subtrees. The top-level validation result is driven by the full report either way, so a cycle at `parent: Node` (non-nullable) validates the same way as a cycle at `parent: Node | null`. The declared-optionality-matters framing the wrap alternative needed (where the placeholder had to satisfy the field type) doesn't apply to in-validator visit tracking.

**D7. Visit-tracking is the anchor change; other pulls are case-by-case.** If pre/post work currently done in our wrapper would pay for itself in reduced wrapper complexity or better UX by moving inside the emitter, consider pulling it in. Default stance is still "no" — don't pull just because we can. The Phase-4 upstream PR ships visit-tracking only regardless; other pulls stay in our copy.

**D8. Port a curated subset of typia's upstream test suite as regression signal.** Upstream tests live at typia's repo root (`tests/test-typia-automated/` + `tests/template/` fixture library), not co-located with package `src/`. Port scope: keep `validate*` / `is*` / `assert*` categories; drop `protobuf_*`, `misc_*` (clone/prune), `random`, `notation`, `functionalAsync` — surfaces we don't use. Replace typia's ts-patch + ts-node + tgrid `WorkerConnector` harness with an in-process vitest runner in our package. Tests asserting pre-visit-tracking behavior (cycles throw, aliases re-walked) get rewritten in place. New visit-tracking tests land alongside the ported subset, portable to a Phase-4 upstream PR. This work is **Phase 3** — Phase 1 stays focused on the no-op source swap.

## Phases

### Phase 0: Post the GitHub issue and wait

Before any implementation, open an issue on `samchon/typia` proposing visit-tracking as an opt-in validator feature. Goal: gauge whether an upstream PR has any chance of landing before committing to Phase 4 polish work.

- [x] Draft the issue: problem statement (cycles stack-overflow regardless of declared type, aliases re-walked), proposed opt-in API (threaded `WeakMap` parameter), non-goals (no default behavior change, no perf regression for acyclic callers).
- [x] Post to `github.com/samchon/typia/issues`. _Posted 2026-04-24._
- [ ] Wait up to two weeks for a reaction (deadline: 2026-05-08).

**Exit criteria:**
- **Positive** (Samchon engages, says "open a PR" or gives design feedback): Phase 4 is on. Proceed through 1–3 with upstream-PR readiness in mind (clean commits, no Lumenize-specific naming in the touched files).
- **Negative** (declined, out-of-scope, "won't merge"): skip Phase 4. Proceed through 1–3 freed from upstream conventions.
- **Silence past two weeks**: treat as negative. Skip Phase 4.

Phases 1–3 are unaffected either way — release needs them. Phase 0 only decides whether we also do Phase 4.

### Phase 1: Copy in + no-op swap ✅ COMPLETE (2026-04-24)

- [x] Pull `samchon/typia@v12.0.2` source. Extract `packages/{core,transform,interface,utils}/src/` into `packages/ts-runtime-parser-validator/forks/typia/{core,transform,interface,utils}/src/`.
- [x] Include each copied package's `package.json` and `tsconfig.json`. Upstream `package.json` replaced with a minimal fork-shim (name, `main: "src/index.ts"`, deps on sibling workspaces at `*`). Upstream `tsconfig.json` rewritten to extend `../tsconfig.base.json` (a copy of typia's root `config/tsconfig.json`). No need to rewrite cross-package imports — npm workspaces resolve bare `@typia/*` specifiers through the symlinked `node_modules/@typia/*` tree.
- [x] ~~Add a build step that compiles the copied TS to JS~~ — **not needed**. esbuild (via `bundle-dependencies.mjs`) handles TypeScript natively, consuming `src/index.ts` directly. Dropped the tsc step as unnecessary overhead.
- [x] ~~Update `scripts/bundle-dependencies.mjs` to pull from the local `lib/` trees~~ — **not needed**. The script's existing `import ... from '@typia/transform'` resolves to our fork automatically via npm workspace symlinks. No script change required.
- [x] Register the four forks as npm workspaces in the root `package.json` (local only, `private: true`, no publishing).
- [x] Replace `@typia/transform: 12.0.2` pin with `@typia/transform: *` in `packages/ts-runtime-parser-validator/package.json` so npm routes to the workspace fork.
- [x] Copy typia's `LICENSE` file into `packages/ts-runtime-parser-validator/forks/typia/LICENSE`.
- [x] Add `ATTRIBUTIONS.md` entry.
- [x] Add `forks/typia/README.md` explaining the copy's purpose, workspace wiring, and Phase-2-onwards modification-log placeholder.
- [x] Run the existing 114 parser-validator tests — all 114 pass. Bundle builds at 3.91 MB. Cycle tests still stack-overflow as expected (that's what Phase 2 fixes).
- [ ] Run the parser-validator benchmark locally — numbers match the Phase 6 baseline (119 KB generated module, ~0.25 ms warm parse). _Deferred — no emitter changes, should match trivially; confirm before Phase 2 kickoff._

**Success criteria**: our copy is a behavioral no-op. Tests green, bundle size and warm-parse latency match Phase 6 baselines.

### Phase 2: Visit-tracking implementation ✅ COMPLETE (2026-04-24)

- [x] Read the copied `typia/core/src/programmers/` and identify validator-emission points — object-typed named helpers are emitted by `FeatureProgrammer.write_object_functions` as arrow functions named `${prefix}o${index}`. Cycle-risk positions are exactly these recursive helper boundaries.
- [x] Emit `$visited` as a per-call `WeakMap<object, Set<string>>` and wrap each object helper body with a per-helper-name guard. Implementation in [forks/typia/core/src/programmers/internal/FeatureProgrammer.ts](packages/ts-runtime-parser-validator/forks/typia/core/src/programmers/internal/FeatureProgrammer.ts) (search for `Lumenize modification: visit-tracking`).
  - Declared via `visited_declaration()` in the outer IIFE (`writeDecomposed`) and at the top of the per-call arrow (`write`).
  - Reset via `wrap_arrow_with_visited_reset` at the start of each user-facing call on the `writeDecomposed` path — required because helpers live in IIFE scope shared across calls.
  - Wrapped via `wrap_with_visit_guard` inside `write_object_functions`. On entry for an object, check `$visited.get(input)?.has("<helper-name>")` → return `true` if seen, else record.
  - **Keyed by `(object, helper-name)`** rather than just `object`. This keeps separate validation passes independent — within `ValidateProgrammer`, `__is` helpers (prefix `_i*`) and validate helpers (prefix `_v*`) share `$visited` in closure but don't collide because their names differ. Without per-helper keying, `__is` marking an invalid object as "visited" would cause the follow-on validate pass to short-circuit without enumerating errors.
- [x] ~~Update `typia-runtime-helpers.ts` if emission introduces new helper imports~~ — no new helpers needed. The change is a self-contained code transformation on typia's emitter output.

**Success criteria**: ✅ generated validators accept cycles at any field position (nullable or non-nullable), skip re-walking aliased subtrees. Verified by 5 new tests in [test/cycles.test.ts](packages/ts-runtime-parser-validator/test/cycles.test.ts) (self-cycle nullable, self-cycle non-nullable, DAG alias, invalid-node cycle reports errors, mutual A↔B recursion) — all pass. All existing 114 parser-validator tests continue to pass (total 119).

### Phase 3: Test coverage ⚠️ PARTIALLY COMPLETE — upstream port deferred to Phase 4 prep

**Status** (2026-04-24): parser-validator-side regression coverage landed, upstream-port deferred.

**What shipped**:
- [x] Parser-validator-side cycle + alias tests in [test/cycles.test.ts](packages/ts-runtime-parser-validator/test/cycles.test.ts) — 5 tests covering self-cycle at nullable and non-nullable positions, DAG aliasing, invalid-node cycles (errors still reported), and mutual A↔B recursion. All 119 parser-validator tests (114 existing + 5 new) pass against the modified typia copy.

**What's deferred** (was originally Phase 3 scope — pulling in typia's upstream test suite):
- [ ] Copy `@typia/template` fixture library into `forks/typia/template/`.
- [ ] Copy the curated subset of `tests/test-typia-automated/src/` composite tests (`validate*` / `is*` / `assert*` / `*Parse`; drop `protobuf_*`, `misc_*`, `random`, `notation`, `functionalAsync`) + the `internal/_test_*.ts` helpers they call.
- [ ] Build a vitest harness that runs those tests in-process against the modified typia copy.
- [ ] Rewrite upstream tests asserting pre-visit-tracking behavior (cycles throw, aliases re-walked) directly in the copied source.

**Why deferred**: the upstream test harness brings significant infrastructure load that doesn't pay off under current conditions.

- **Heavy dependencies**: `@typia/template` imports `randexp`, `tstl`, `chalk`, `uuid`, `@nestia/e2e`, `tgrid`, and several `typia/lib/internal/*` internals. Porting requires adding these to our package or hand-replacing their uses (`TestRandomGenerator`, `Spoiler`, `TestServant`). Roughly 6 npm deps or ~400 lines of replacement code.
- **Build-time transform**: upstream tests assume ts-patch + ts-node runs typia's transformer before execution. Our pipeline uses a runtime Cloudflare-Worker transform via `bundle-dependencies.mjs` — the two approaches don't compose cleanly with vitest. We'd need to set up ts-patch alongside vitest or adapt the parser-validator's runtime pipeline for unit-level testing.
- **Low marginal coverage**: the 119 parser-validator tests already exercise typia's validate/is/assert paths end-to-end through our actual use case, including cycles and aliases. The upstream suite adds coverage for type-shape combinations we don't use (and it covers `random`, `protobuf`, `clone`, `prune` surfaces we'd need to strip anyway).
- **Phase-4 conditionality**: the primary motivation for typia-copy-level tests was Phase-4 upstream PR portability. If Phase 4 doesn't run (negative/silent response from Samchon by 2026-05-08), this infrastructure yields no external value.

**When to revisit**: if Phase 0 returns positive (Samchon engages), bring this work back as part of Phase 4 PR prep — the upstream PR should include upstream-format tests alongside the visit-tracking change. At that point, ts-patch + test port is on the critical path for PR acceptance, and the effort is justified. If Phase 0 returns negative/silent, this deferred work stays deferred indefinitely; our 119 parser-validator tests remain the regression signal.

### Phase 4: Upstream PR (conditional on Phase 0 outcome)

**Only run if Phase 0 got a positive signal.** Skip entirely on negative or silent.

- [ ] Fork `samchon/typia` on GitHub under your user.
- [ ] Clone the fork locally, outside the lumenize repo.
- [ ] Port the visit-tracking change from our local copy to the clean fork — file-for-file copy of the touched files, no Lumenize-specific naming.
- [ ] Rebase against current upstream `main`.
- [ ] Write PR description: problem statement, opt-in API, test coverage, perf analysis on acyclic inputs, link back to the Phase 0 issue.
- [ ] File PR; monitor; respond to feedback.

**Sunset condition**: if Samchon merges the PR and releases it in typia ≥ 12.x.y, bump `@lumenize/ts-runtime-parser-validator`'s typia deps to that version, swap `bundle-dependencies.mjs` back to `node_modules`, delete `packages/ts-runtime-parser-validator/forks/typia/`, archive this task.

**Hold condition**: PR stalls past two months from filing. Our local copy stays as the permanent runtime. Archive this task; no further action needed.

**Closure on negative/silent Phase 0**: Phase 4 is skipped entirely. This task closes when Phases 1–3 ship and the parent task's 6.7 wire-in merges. The local copy becomes the permanent runtime.

## Phase -1: Captured Ideas

- **Narrow the copied surface further** — strip unused parts of `@typia/core` (random, clone, protobuf, JSON Schema emit) if bundle size ever becomes a concern. Current 7.1 MB distributable has comfortable headroom against the 10 MB Worker ceiling.
- **`Default<T>` as a branded type** — extract-side extension, doesn't touch typia. Parent task's Phase -1 has the full analysis.

## Alternatives Considered and Rejected

- **Wrap-based cycle support** — acyclify pre-pass + null substitution at cycle closure + restore + error-path remapping, fused into `__fillDefaults`. *Rejected because* (a) implementation effort is roughly equal to the visit-tracking modification itself, so "wrap now and modify later" is duplicate work; (b) wrap can only dedup aliases at nullable positions (placeholder must satisfy the declared type), in-validator modification dedups everywhere; (c) wrap ships two release-risk surfaces, copy-in ships one.
- **Submodule pointing at a GitHub fork of typia** — clean upstream-PR story (commits go straight to the fork). *Rejected because* submodules add contributor friction (clone with `--recurse-submodules`, post-install needs `git submodule update --init`, pnpm workspaces inside the submodule interact awkwardly with our npm workspaces). Copy-then-maybe-port preserves the single-repo simplicity.
- **Sibling-clone + `npm link`** for dev. *Rejected because* linking breaks when another contributor pulls; automating via postinstall is a new surface to maintain.
- **Published fork under a Lumenize npm scope** (e.g., `@lumenize/typia-transform`). *Rejected because* nothing else in the monorepo needs typia; publishing is pure overhead.
- **Do nothing; document cycles as not supported.** *Rejected because* every other Lumenize transport preserves cycles; the validator being the odd one out undermines the cycle-preserving story across the stack.
- **Bake in `Default<T>` changes now alongside visit-tracking.** *Rejected because* per the parent task's Phase -1, `Default<T>` is an extract-side feature (branded type on the parser-validator extractor + new `Parsed<T>` utility) and doesn't touch typia's emitters. If that analysis changes during Phase 1–2 and typia-side work does surface, D7's case-by-case stance covers it — the files are already in our copy per D1.

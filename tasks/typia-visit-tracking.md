# Typia Visit-Tracking: Copy In + Modify

**Status**: Not started. Pre-release blocker for `@lumenize/ts-runtime-parser-validator` (5.2.4.1). Surfaced 2026-04-23 during 5.2.4.1 Phase 6.7 pre-implementation review.

**Depends on**: None (typia 12.0.2 is pinned).
**Precedes**: `tasks/nebula-5.2.4.1-validator-engine-upgrade.md` Phase 6.7 (wire-in).
**Artifact**: `packages/ts-runtime-parser-validator/forks/typia/` — copied TypeScript source from `samchon/typia@v12.0.2`, modified in-place.

## Objective

Copy typia's four runtime packages (`@typia/transform`, `@typia/core`, `@typia/interface`, `@typia/utils`) into `@lumenize/ts-runtime-parser-validator` and add visit-tracking to generated validators so:
- **Cycles** validate natively (no stack overflow on `node.parent = node` against `parent: Node | null`).
- **Aliased subtrees** validate once, not per-alias.

**Framing: copy in + modify, not fork.** We pull typia source files we need into our tree and own them from there. Phase 0 posts a GitHub issue to gauge Samchon's interest in upstreaming; a positive signal unlocks Phase 4 (reconstitute as a real GitHub fork + PR), negative or silent means we skip Phase 4 and carry our copy indefinitely.

## Motivation

Every other Lumenize transport (Workers RPC, `@lumenize/structured-clone`, Mesh `call()`) preserves cyclic and aliased references end-to-end. Typia's generated validator is the only hop that doesn't — it has no visit tracking, so cycles stack-overflow and DAG aliases get re-walked. Shipping the parser-validator without a fix means documenting "everything else handles cycles, this one doesn't" at release time.

The wrap alternative (acyclify pre-pass + null substitution + restore + error-path remapping inside `__fillDefaults`) was weighed during the 2026-04-23 review and rejected. Duplicate effort relative to the modification itself, can't dedup non-nullable aliases, ships two release-risk surfaces. Full rationale under "Alternatives Considered and Rejected" below.

## Design Decisions

**D1. Scope: all four typia runtime packages — `@typia/transform`, `@typia/core`, `@typia/interface`, `@typia/utils`.** Drop all four from `package.json` dependencies. typia's other surfaces (random, json, clone, protobuf) live inside `@typia/core` and come along automatically — we don't strip them in Phase 1 (Phase -1 captures "narrow the copied surface further" as a follow-on). Copying all four is cleaner than the two-copied-plus-two-npm middle ground because the bundle already inlines all four via esbuild; listing two as npm deps just keeps them in the SCA-scanning footprint without reducing runtime content.

**D2. Location: `packages/ts-runtime-parser-validator/forks/typia/`.** Not a workspace package — just files the existing `scripts/bundle-dependencies.mjs` pulls from.

**D3. Copy the TypeScript source (`src/`), not compiled `lib/`.** Modifying TS source matches what an upstream PR would touch if Phase 4 runs, and keeps the visit-tracking diff readable. We own the build step that produces JS for `bundle-dependencies.mjs` to consume.

**D4. Base version pin: typia 12.0.2.** Source comes from the `v12.0.2` tag on `samchon/typia`. No rebasing during the life of this task.

**D5. Visit-tracking is unconditional in our copy.** Allocate one `WeakMap` per top-level validator call; check + record on entry to cycle-risk positions; no-op on re-entry (see D6). No parameter threading, no toggle. If Phase 4 runs, the upstream PR introduces the opt-in parameter then — a non-breaking default matters for Samchon's existing users, not for us. Keeping our copy unconditional shrinks the Phase 1–3 diff.

**D6. Re-entry is a no-op.** The visit-tracking check short-circuits re-entry without emitting errors and without recursing further. Errors collected during the first visit stay in typia's accumulating report; skipping re-entry just avoids infinite recursion on cycles and duplicate-error emission on aliased subtrees. The top-level validation result is driven by the full report either way, so a cycle at `parent: Node` (non-nullable) validates the same way as a cycle at `parent: Node | null`. The declared-optionality-matters framing the wrap alternative needed (where the placeholder had to satisfy the field type) doesn't apply to in-validator visit tracking.

**D7. Visit-tracking is the anchor change; other pulls are case-by-case.** If pre/post work currently done in our wrapper would pay for itself in reduced wrapper complexity or better UX by moving inside the emitter, consider pulling it in. Default stance is still "no" — don't pull just because we can. The Phase-4 upstream PR ships visit-tracking only regardless; other pulls stay in our copy.

**D8. CI runs typia's own test suite against our copy, modified in place.** Upstream tests asserting pre-visit-tracking behavior (cycles throw, aliases re-walked) get rewritten directly in the copied source; tests unrelated to our changes stay as-is for regression signal. New visit-tracking tests land inside the typia copy, co-located with the source change, so they're portable to the Phase-4 upstream PR. End-to-end cycle/alias tests from the parser-validator user's perspective stay in parser-validator (Phase 3).

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

### Phase 1: Copy in + no-op swap

- [ ] Pull `samchon/typia@v12.0.2` source. Extract `packages/core/src/`, `packages/transform/src/`, `packages/interface/src/`, `packages/utils/src/` into `packages/ts-runtime-parser-validator/forks/typia/{core,transform,interface,utils}/src/`.
- [ ] Include each copied package's `package.json` and `tsconfig.json` (or minimal equivalents) so the sources compile in isolation. Rewrite cross-package imports (e.g. `@typia/interface`) to resolve to the sibling `forks/typia/interface/` rather than `node_modules`.
- [ ] Add a build step that compiles the copied TS to JS (into `forks/typia/{core,transform,interface,utils}/lib/`). Wire into the package's existing `npm run bundle` flow.
- [ ] Update `scripts/bundle-dependencies.mjs` to pull from the local `lib/` trees instead of `node_modules/@typia/*`.
- [ ] Remove `@typia/transform` from `packages/ts-runtime-parser-validator/package.json` dependencies (it's the only direct dep today; the other three are transitive).
- [ ] Copy typia's `LICENSE` file into `packages/ts-runtime-parser-validator/forks/typia/LICENSE` (MIT attribution requirement).
- [ ] Add `ATTRIBUTIONS.md` entry following the Alarms package pattern: origin (`samchon/typia@v12.0.2`), license (MIT), files copied (all four runtime packages), and a note listing the modifications (unconditional visit-tracking, re-entry is a no-op). Split to `forks/typia/MODIFICATIONS.md` later if the fork grows beyond visit-tracking.
- [ ] Run the existing 114 parser-validator tests — all pass as a byte-for-byte behavioral no-op.
- [ ] Run the parser-validator benchmark locally — numbers match the Phase 6 baseline (119 KB generated module, ~0.25 ms warm parse).

**Success criteria**: our copy is a behavioral no-op. Tests green, bundle size and warm-parse latency match Phase 6 baselines.

### Phase 2: Visit-tracking implementation

- [ ] Read the copied `typia/core/src/programmers/` and identify the validator-emission points for cycle-risk positions (self-referential and mutually-referential named types).
- [ ] Emit an unconditional `WeakMap` allocation at the top of each generated validator and a visited-set check around each cycle-risk position. On entry for a named-interface value, check + record; on re-entry, skip the recursion without emitting errors. The top-level result is driven by typia's accumulated report independent of what the re-entry branch does. No parameter threading — the map is a local inside the generated validator.
- [ ] Update `packages/ts-runtime-parser-validator/src/typia-runtime-helpers.ts` if emission introduces new helper imports. The surviving-typia-import guard in `generate-parse-module.ts:328` will surface any newcomers loudly.

**Success criteria**: generated validators accept cycles at any field position (nullable or non-nullable), skip re-walking aliased subtrees.

### Phase 3: Test coverage

- [ ] Wire typia's own test suite (from the copied source's tests, or port selectively) into this package's CI. Document any deltas against upstream at commit time.
- [ ] Parser-validator-side cycle + alias tests land in the parent task's Phase 6.7 (`packages/ts-runtime-parser-validator/test/cycles.test.ts`) — see that task's work items.

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

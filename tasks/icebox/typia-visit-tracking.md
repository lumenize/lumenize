# Typia Visit-Tracking: Copy In + Modify

**Status**: **Iceboxed 2026-05-16** — track 4c selected (defer pending typia-go migration). See "Why this is iceboxed" below.

Phases 1–2 shipped 2026-04-24 alongside `@lumenize/ts-runtime-parser-validator` (5.2.4.1, archived at [`tasks/archive/nebula-5.2.4.1-validator-engine-upgrade.md`](../archive/nebula-5.2.4.1-validator-engine-upgrade.md)). Phase 3 shipped the parser-validator-side regression tests; the upstream-port portion stays deferred per that phase's rationale. Phase 0 returned positive 2026-04-28 with API design fully settled across a three-comment exchange on [issue #1820](https://github.com/samchon/typia/issues/1820): no new method, no new parameter, recursion-gated WeakSet allocation via `MetadataSchema` traversal. Samchon also noted he'll add cycle support himself during the typescript-go migration he's actively working on. Phase 4 was a decision between 4a (upstream PR) and 4c (defer pending typia-go) — 4c selected on 2026-05-16. Originally surfaced 2026-04-23 during 5.2.4.1's Phase 6.7 pre-implementation review.

## Why this is iceboxed

Our fork is **strictly more capable** than what would land upstream. The settled PR design (Samchon's recursion-gated approach) drops case-3 coverage — non-recursive types with runtime DAG aliases get re-walked. Our universal-wrap design handles it. See "Coverage tradeoff: our fork covers more cases than the PR design" section below for the full 3-case table.

Three reinforcing reasons not to do the PR work right now:

1. **PR-ing means trading capability for code we'd delete anyway.** Replacing our fork with the upstream variant is a one-way perf regression we can't easily unship.
2. **Samchon has committed to adding cycle support in his typescript-go migration**, which he's actively working on. Our fork's lifespan likely ends with that cutover regardless of what we do upstream against current TS typia.
3. **The Cloudflare Workers compatibility question for typia-go (Containers vs WASM) is a much bigger conversation** than visit-tracking. Handling both together at the typia-go cutover is the natural decision point — and we'll have concrete data on whether the case-3 regression matters for our workload by then.

Promote out of icebox if any of these become true:

- typia-go cutover is imminent and we need to make a fresh decision on cycle support in the new runtime (Containers vs WASM question gets answered, or Samchon's typia-go cycle-support design diverges from our needs).
- We hit a concrete production case where the case-3 coverage matters — non-recursive type with shared subtree references at runtime, and re-walking causes observable pain. Today's workload is overwhelmingly case-1/case-2 (recursive types), so this is unlikely.
- 5.2.4.1's wire-in needs a typia bump that incorporates Samchon's typescript-go cycle work, forcing the fork-deletion question.
- Samchon's typescript-go migration stalls long enough that our fork becomes a long-term maintenance burden — at which point 4b (helper consolidation in the fork) is the path forward.

## Discovered/refined during

Originally surfaced 2026-04-23 during 5.2.4.1's Phase 6.7 pre-implementation review. Phases 1–3 shipped with 5.2.4.1 on 2026-04-24. Phase 0 (upstream issue #1820) posted same day; settled across three Samchon comments on 2026-04-28. The case-3 coverage tradeoff surfaced during a session review on 2026-05-16, inverting the usual upstream-PR calculus and confirming 4c as the right path — leading to this iceboxing.

**Depends on**: None (typia 12.0.2 is pinned).
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
- [x] Wait up to two weeks for a reaction (deadline: 2026-05-08). _Resolved 2026-04-28: positive._

**Outcome (2026-04-28): positive, API design fully settled.**

Three-comment exchange on the issue thread:

**Samchon (1)**:
> Very good idea. Welcome your PR. In typescript-go migration, I'll do that. It would be the best the `WeakMap` created only when recursive relation exists.

**Samchon (2), responding to a clarifying question**:
> Wanna option A. User doesn't need to be know whether the tracking (`WeakSet`?) is required or not. You can detect whether the recursive/cyclic relationship exist or not by traversing `MetadataSchema`.

**Samchon (3), final clarification**:
> 1. No new function, no new parameter required
> 2. You can determine whether WeakSet is required or not by logic level
> 3. Traverse MetadataSchema, then you can determine it

**Settled design**:

- **Public API unchanged.** No companion function (`createValidateWithCycles<T>()` rejected), no opt-in parameter on `createValidate<T>()`. The existing `createValidate`, `createIs`, `createAssert` and siblings just gain cycle support transparently.
- **Static recursion gating via `MetadataSchema`.** typia's `MetadataObjectType.recursive: boolean` flag (computed by [forks/typia/core/src/factories/internal/metadata/iterate_metadata_collection.ts:42-54](packages/ts-runtime-parser-validator/forks/typia/core/src/factories/internal/metadata/iterate_metadata_collection.ts#L42-L54), not from tsc) gates emission. When no recursive relationships exist in the type, output is byte-identical to current typia.
- **`WeakSet` not `WeakMap`.** Once threading per pass is in place, only "have we seen this object" matters — no associated value lookup — so `WeakSet` is the right data structure.
- **Threading through internal helper signatures is fine** — what's banned is changes to the *public* `createValidate<T>()` API surface. Internal threading is an implementation detail.

**Implications worth noting:**

1. **PR welcome** — track 4a (upstream PR) is unblocked, and the API is settled enough to start the refactor.
2. **typescript-go migration is active** — Samchon is currently porting typia to typescript-go and intends to add cycle support there himself. Our fork's lifespan likely ends with that cutover regardless of what we do upstream against current TS typia. (The Cloudflare Workers compatibility question for typia-go — Containers vs WASM — is a separate, larger conversation for later.) This gives a clean "out" for deferring the PR work entirely (track 4c).
3. **Non-recursive DAG-alias-dedup is sacrificed.** Recursion-gated emission means non-recursive types with shared subtree references at runtime (e.g., `[shared, shared]` in a non-recursive container) get re-walked. This is a perf tradeoff, not a correctness regression — and it's Samchon's explicit preference.

**Original exit criteria** (kept as historical context; superseded by the actual outcome above):
- **Positive** (Samchon engages, says "open a PR" or gives design feedback): Phase 4 is on. Proceed through 1–3 with upstream-PR readiness in mind (clean commits, no Lumenize-specific naming in the touched files).
- **Negative** (declined, out-of-scope, "won't merge"): skip Phase 4. Proceed through 1–3 freed from upstream conventions.
- **Silence past two weeks**: treat as negative. Skip Phase 4.

Phases 1–3 already shipped; Phase 0 unblocks Phase 4 but the active sub-track is now a three-way choice (4a / 4b / 4c) — see Phase 4 for details.

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

**Success criteria**: ✅ generated validators accept cycles at any field position (optional, nullable, or non-nullable), skip re-walking aliased subtrees. Verified by tests in [test/cycles.test.ts](packages/ts-runtime-parser-validator/test/cycles.test.ts) covering self-cycle at optional/nullable/non-nullable positions, DAG alias (with instrumented counter), invalid-node cycle reports errors, and mutual A↔B recursion — all pass alongside the existing 114 parser-validator tests (total 121).

### Phase 3: Test coverage ⚠️ PARTIALLY COMPLETE — upstream port deferred to Phase 4 prep

**Status** (2026-04-24): parser-validator-side regression coverage landed, upstream-port deferred.

**What shipped**:
- [x] Parser-validator-side cycle + alias tests in [test/cycles.test.ts](packages/ts-runtime-parser-validator/test/cycles.test.ts) — 7 tests covering self-cycle at optional, nullable, and non-nullable positions, DAG aliasing (with instrumented getter-counter confirming single walk), invalid-node cycles (errors still reported), and mutual A↔B recursion. All 121 parser-validator tests (114 existing + 7 new) pass against the modified typia copy.

**What's deferred** (was originally Phase 3 scope — pulling in typia's upstream test suite):
- [ ] Copy `@typia/template` fixture library into `forks/typia/template/`.
- [ ] Copy the curated subset of `tests/test-typia-automated/src/` composite tests (`validate*` / `is*` / `assert*` / `*Parse`; drop `protobuf_*`, `misc_*`, `random`, `notation`, `functionalAsync`) + the `internal/_test_*.ts` helpers they call.
- [ ] Build a vitest harness that runs those tests in-process against the modified typia copy.
- [ ] Rewrite upstream tests asserting pre-visit-tracking behavior (cycles throw, aliases re-walked) directly in the copied source.

**Why deferred**: the upstream test harness brings significant infrastructure load that doesn't pay off under current conditions.

- **Heavy dependencies**: `@typia/template` imports `randexp`, `tstl`, `chalk`, `uuid`, `@nestia/e2e`, `tgrid`, and several `typia/lib/internal/*` internals. Porting requires adding these to our package or hand-replacing their uses (`TestRandomGenerator`, `Spoiler`, `TestServant`). Roughly 6 npm deps or ~400 lines of replacement code.
- **Build-time transform**: upstream tests assume ts-patch + ts-node runs typia's transformer before execution. Our pipeline uses a runtime Cloudflare-Worker transform via `bundle-dependencies.mjs` — the two approaches don't compose cleanly with vitest. We'd need to set up ts-patch alongside vitest or adapt the parser-validator's runtime pipeline for unit-level testing.
- **Low marginal coverage**: the parser-validator tests (176 and growing as doc conversions landed) already exercise typia's validate/is/assert paths end-to-end through our actual use case, including cycles and aliases. The upstream suite adds coverage for type-shape combinations we don't use (and it covers `random`, `protobuf`, `clone`, `prune` surfaces we'd need to strip anyway).
- **Phase-4 conditionality**: the primary motivation for typia-copy-level tests was Phase-4 upstream PR portability. If Phase 4 doesn't run (negative/silent response from Samchon by 2026-05-08), this infrastructure yields no external value.

**When to revisit**: if Phase 0 returns positive, bring this work back as part of Phase 4a (upstream PR prep) — the PR should include upstream-format tests alongside the visit-tracking change, and ts-patch + harness is on the critical path for acceptance at that point. If Phase 0 returns negative/silent, this port stays deferred indefinitely (Phase 4b does the helper-consolidation instead); the parser-validator test suite remains the regression signal.

## Implementation discoveries vs. PR-friendliness

The post-Phase-2 implementation in [forks/typia/core/src/programmers/internal/FeatureProgrammer.ts](packages/ts-runtime-parser-validator/forks/typia/core/src/programmers/internal/FeatureProgrammer.ts) (Lumenize-modification regions at lines 277–805) diverges from Samchon's settled PR design in three coupled ways. None were a deliberate design pivot away from PR-friendliness — D5 always said "unconditional, no threading, no toggle" with the assumption that the PR refactor would add the opt-in shape. What changed is the cost estimate: the refactor isn't "add a flag," it's three coupled changes plus the deferred Phase 3 upstream test port.

**1. Closure-scoped `$visited` vs. parameter threading through internal helpers.** `$visited` is declared once in the IIFE (`writeDecomposed`) or once in the per-call arrow (`write`), and helpers close over it. The fork's [README:29](packages/ts-runtime-parser-validator/forks/typia/README.md#L29) is explicit: *"public typia API, parameter signatures, helper call sites — not touched. The map is closure-scoped; no threading."* The settled PR design keeps the public API untouched but threads `$visited` through internal helper signatures so each pass gets its own — touching every emitted helper signature and every call site. Closure scope needed ~3 hooks total; threading is a much wider edit.

**2. Universal wrap vs. recursion-gated wrap.** Every object helper gets the visit guard regardless of whether the type is recursive. Samchon's settled position — emit only when `MetadataSchema` traversal shows recursion — calls for static gating on `MetadataObjectType.recursive`. The flag is already computed by typia (in [iterate_metadata_collection.ts:42-54](packages/ts-runtime-parser-validator/forks/typia/core/src/factories/internal/metadata/iterate_metadata_collection.ts#L42-L54)), so the gate is a read at the emission point. Universal wrapping additionally delivers alias-dedup for non-recursive shared subtrees, which a recursion-gated version loses — Samchon's preference is to accept that perf regression in exchange for zero overhead on non-recursive types.

**3. `WeakMap<object, Set<string>>` with per-helper-name keying vs. plain `WeakSet<object>`.** `ValidateProgrammer` runs `__is` first; on failure it runs the full validate pass via the same outer IIFE (see [ValidateProgrammer.ts:135-200](packages/ts-runtime-parser-validator/forks/typia/core/src/programmers/ValidateProgrammer.ts#L135-L200)). Both passes share `$visited` via IIFE closure in our implementation. Without per-helper-name keying, `__is` marking an invalid object as visited would short-circuit the follow-on validate pass, hiding errors. The `Set<string>` of helper names — `_io0` for is-helpers, `_vo0` for validate-helpers — keeps the passes independent. **This wrinkle is downstream of (1):** with parameter threading, each pass receives its own `WeakSet` allocated at top-level entry, so per-helper-name keying becomes unnecessary and the data structure simplifies to a plain `WeakSet`. Refactor (3) falls out of doing (1).

**Net: porting to a PR is three coupled refactors plus the deferred Phase 3 upstream test port.** The pre/post-wrapper alternative (acyclify pre-pass + null substitution + restore + error-path remapping) was rejected at task drafting (see "Alternatives Considered and Rejected") and remains rejected — non-nullable alias dedup is impossible in that approach, and ruling it out is the user's explicit position now.

**Why we can't patch just `WeakSet` into our fork without doing the full refactor**: the closure-scoped sharing in our IIFE makes plain `WeakSet` incorrect (refactor 3's bug). `WeakSet` only works once threading is in place. The data-layout change is not a separable patch; it's the tail end of the same refactor.

## Coverage tradeoff: our fork covers more cases than the PR design

Surfacing this explicitly because it inverts the usual upstream-PR calculus: our fork is **strictly more capable** than what would land upstream. Three runtime cases:

| Case | Type structure | Runtime input | Our fork | Samchon's PR design |
|------|---------------|---------------|----------|---------------------|
| 1 | Recursive (e.g. `Node.parent: Node`) | Cycle (`a.parent = a`) | ✅ short-circuits | ✅ short-circuits |
| 2 | Recursive (e.g. `Tree.children: Tree[]`) | DAG aliases (`[shared, shared]`) | ✅ deduped | ✅ deduped |
| 3 | Non-recursive (e.g. `Container.items: Item[]`) | DAG aliases (`[shared, shared]`) | ✅ deduped | ❌ re-walked |

Case 3 is the regression. Our fork wraps every object helper (universal), so any runtime alias to any object short-circuits. Samchon's design wraps only helpers for types flagged `MetadataObjectType.recursive === true`, so non-recursive shared subtrees re-walk on every reference.

**Why this matters for the 4a vs. 4c choice.** Track 4a isn't "port what we have" — it's "port a less-capable variant and replace what we have with it." The case-3 dedup is one-way: once we PR and switch, we can't easily unship the gate. For Lumenize specifically the regression is probably small (most aliased nodes in our ontology graph are themselves recursive types — entities can reference entities), but it's nonzero and the workload could change.

**Why we can't have both.** The static signal needed to handle case 3 is *runtime structure*, not type structure — there's no `MetadataSchema` flag typia could read in advance to know a non-recursive type will receive a DAG at runtime. Universal-but-cheap (e.g. allocate WeakSet only when input is large) would need runtime heuristics, which Samchon explicitly rejected with "no new function, no new parameter required."

A wider gate that catches non-recursive *DAG-typed shapes* (e.g. `interface Page { header: SharedHeader; footer: SharedHeader }`) is conceivable — emit when any helper is referenced from multiple sites in the type graph, not just self-recursive — but it's a meaningfully different proposal than Samchon settled on. Not worth opening unless we hit a real regression.

### Phase 4: Decision pending — leaning 4c

Phase 0 returned positive and the API design is fully settled. The active sub-track is undecided: **4a (upstream PR)** or **4c (defer pending typia-go migration)**. **4b** stays on the doc as a follow-on if 4a is attempted and stalls, but isn't a primary path. Decision deferred to at least 2026-05-02 (mirroring Samchon's ~4-day response window on the issue).

**Current lean: 4c.** Once the case-3 coverage tradeoff (above) surfaced, the calculus shifted: our fork is strictly more capable than what would land upstream, so 4a means doing more work in exchange for less capability. 4c keeps our case-3 coverage and lets typia-go be the natural sunset point. Not yet a final call — see 4c's rationale and reversibility note.

#### 4a. Upstream PR

Active if we decide the cycle-support port to current TS typia is worth doing on its own merits, even with typia-go on the horizon. **Cost worth flagging up-front**: porting means accepting the case-3 regression in our own runtime — the PR design loses non-recursive DAG-alias dedup (see "Coverage tradeoff" above). One-way: we can't easily unship the gate after the PR lands and we delete the fork.

API design is settled (see Phase 0 outcome). No new public API surface; threading + recursion gating + WeakSet are all internal. Work items:

- [ ] Refactor (1): convert closure-scoped `$visited` to a `WeakSet` parameter threaded through every emitted helper signature and call site. Each top-level emitted function (`__is`, validate body, etc.) allocates its own WeakSet at entry.
- [ ] Refactor (2): gate emission of (1) on `MetadataObjectType.recursive`. Non-recursive object helpers stay byte-identical to current typia output. Use the existing `MetadataObjectType.recursive: boolean` (computed in [iterate_metadata_collection.ts:42-54](packages/ts-runtime-parser-validator/forks/typia/core/src/factories/internal/metadata/iterate_metadata_collection.ts#L42-L54)) — don't add a new traversal pass.
- [ ] Refactor (3): drop the `WeakMap<object, Set<string>>` per-helper-name keying — with threaded WeakSet per pass, the keying is dead weight.
- [ ] Apply the same gate to top-level WeakSet allocation: collection-level traversal of `MetadataSchema` decides whether to allocate at all. If no recursive types in the collection, no allocation, no overhead.
- [ ] Fork `samchon/typia` on GitHub under your user. Clone the fork outside the lumenize repo.
- [ ] Port the refactored visit-tracking change to the clean fork — file-for-file, no Lumenize-specific naming.
- [ ] Port the curated test subset deferred from Phase 3 (see that section) as part of PR-ready test coverage. ts-patch + harness is on the critical path here, so the infrastructure cost is justified.
- [ ] Rebase against current upstream `main`.
- [ ] Write PR description: problem statement, internal threading + recursion-gating design (citing Samchon's confirmation on issue #1820), test coverage, perf analysis (zero overhead on non-recursive types, lost DAG-alias-dedup tradeoff), link back to issue #1820.
- [ ] File PR; monitor; respond to feedback.

**Sunset condition (4a)**: if Samchon merges the PR and releases it in typia ≥ 12.x.y, bump `@lumenize/ts-runtime-parser-validator`'s typia deps to that version, swap `bundle-dependencies.mjs` back to `node_modules`, delete `packages/ts-runtime-parser-validator/forks/typia/`, archive this task.

**Hold condition (4a)**: PR stalls past two months from filing or is declined after filing. Switch to track 4b to recoup value from the local copy; archive this task once 4b completes. (Caveat: if typia-go cutover is imminent at that point, prefer 4c — don't invest in 4b for a fork that's about to sunset.)

#### 4b. Consolidate runtime helpers into the fork

Triggered when 4a is attempted and stalls/is declined, AND typia-go cutover isn't imminent enough to make the consolidation a wasted investment. Not a primary path on its own — only a follow-on to 4a's hold condition.

Context: [src/typia-runtime-helpers.ts](packages/ts-runtime-parser-validator/src/typia-runtime-helpers.ts) hand-copies three typia internal helpers (`_validateReport`, `_accessExpressionAsString`, `_createStandardSchema`) as escaped JS source strings, and [src/generate-parse-module.ts:313-322](packages/ts-runtime-parser-validator/src/generate-parse-module.ts) regex-substitutes them into the emitted output. The file explicitly flags expansion pressure: "Phase 5 will expand this set to cover every helper typia can reference (format validators, type guards, TypeGuardError, etc.)." Each new internal helper adds copy-paste-escape + regex-substitution maintenance.

These helpers live in `packages/typia/src/internal/*.ts` in the upstream monorepo — the 5th typia package, not one of the four we copied in Phase 1.

- [ ] Decide copy-scope: (a) copy just the `_*.ts` files we currently inline into `forks/typia/core/src/internal/`, or (b) add the full `typia` package as a 5th fork sub-directory. Default to (a); widen if more helpers surface later.
- [ ] Rewrite the copied helpers as normal TS exports (drop the IIFE-wrapped string form).
- [ ] Update `generate-parse-module.ts` to emit normal `import` statements for these helpers; bundler resolves them through the fork's workspace wiring. Delete the regex-substitution logic.
- [ ] Delete `src/typia-runtime-helpers.ts`.
- [ ] Verify all parser-validator tests still pass.

**Sunset condition (4b)**: consolidation ships. The local copy becomes the permanent runtime with less hand-maintained surface area. Archive this task.

#### 4c. Defer pending typia-go migration

Carry the fork as-is until typia-go forces a decision. Three reinforcing reasons:

1. **Our fork is more capable than what would land upstream.** Our universal-wrap design covers case 3 (non-recursive DAG dedup) that Samchon's recursion-gated PR design explicitly drops. PR-ing means trading capability for code we'd delete anyway. (See "Coverage tradeoff" above.)
2. **Samchon has committed to adding cycle support in the typescript-go migration** he's actively working on, so the fork's lifespan likely ends with that cutover regardless of what we do upstream against current TS typia.
3. **The Cloudflare Workers compatibility question for typia-go (Containers vs WASM) is a much bigger conversation** than visit-tracking. Handling cycle-support and the runtime question together at typia-go cutover avoids paying the PR-refactor cost on a fork that's about to sunset, and lets us evaluate the case-3 regression with concrete data at that point (does Samchon's typia-go variant ship the same recursion gate? does it matter for our workload?).

- [ ] No active work. Revisit when typia-go ships, or when 5.2.4.1's wire-in needs a typia bump that incorporates Samchon's typescript-go cycle work.
- [ ] If Samchon's typescript-go branch lands cycle support before our typia-go cutover, evaluate whether to bump typia and delete the fork early (accepting the case-3 regression then), or hold the fork until the typia-go cutover handles both at once.

**Sunset condition (4c)**: typia-go cutover (with or without Samchon-authored cycle support landed first) replaces this fork. At that point, evaluate whether the case-3 regression in the new runtime is acceptable for our workload — if so, archive this task; if not, the wider-gate variant mentioned in "Coverage tradeoff" becomes a fresh upstream conversation.

**Reversibility**: 4c is not a one-way door. If typia-go slips significantly or the Cloudflare-runtime question turns out to block typia-go indefinitely, switching to 4a (or 4b) is still possible — the fork is already in place and working. The cost of waiting is the maintenance burden of carrying the fork in the meantime, which is currently low (no upstream churn we'd want to absorb, since we don't rebase per D4).

## Phase -1: Captured Ideas

- **Narrow the copied surface further** — strip unused parts of `@typia/core` (random, clone, protobuf, JSON Schema emit) if bundle size ever becomes a concern. Current 7.1 MB distributable has comfortable headroom against the 10 MB Worker ceiling.
- **`Default<T>` as a branded type** — extract-side extension, doesn't touch typia. Parent task's Phase -1 has the full analysis.
- **Fuse `@default` filling into typia's validator tree walk** — currently the parser-validator runs `__fillDefaults` as a separate post-typia pass with its own `WeakMap` for cycle/alias handling. The alternative: modify typia's emitter to lazy-fill defaults at each node as validation walks it, eliminating the second pass. Performance upside is likely modest (one walk vs. two over the same shape, GC-pressure trade-off) — the real motivation is simpler architecture: one visitor owning cycle/alias tracking instead of two coordinating WeakMaps. Natural **Phase 4b** candidate per D7: the "pull into the fork" check only pays off if upstream is closed, since bundling this into an upstream PR would dilute the visit-tracking diff and add out-of-scope complexity for Samchon to evaluate.

## Alternatives Considered and Rejected

- **Wrap-based cycle support** — acyclify pre-pass + null substitution at cycle closure + restore + error-path remapping, fused into `__fillDefaults`. *Rejected because* (a) implementation effort is roughly equal to the visit-tracking modification itself, so "wrap now and modify later" is duplicate work; (b) wrap can only dedup aliases at nullable positions (placeholder must satisfy the declared type), in-validator modification dedups everywhere; (c) wrap ships two release-risk surfaces, copy-in ships one.
- **Submodule pointing at a GitHub fork of typia** — clean upstream-PR story (commits go straight to the fork). *Rejected because* submodules add contributor friction (clone with `--recurse-submodules`, post-install needs `git submodule update --init`, pnpm workspaces inside the submodule interact awkwardly with our npm workspaces). Copy-then-maybe-port preserves the single-repo simplicity.
- **Sibling-clone + `npm link`** for dev. *Rejected because* linking breaks when another contributor pulls; automating via postinstall is a new surface to maintain.
- **Published fork under a Lumenize npm scope** (e.g., `@lumenize/typia-transform`). *Rejected because* nothing else in the monorepo needs typia; publishing is pure overhead.
- **Do nothing; document cycles as not supported.** *Rejected because* every other Lumenize transport preserves cycles; the validator being the odd one out undermines the cycle-preserving story across the stack.
- **Bake in `Default<T>` changes now alongside visit-tracking.** *Rejected because* per the parent task's Phase -1, `Default<T>` is an extract-side feature (branded type on the parser-validator extractor + new `Parsed<T>` utility) and doesn't touch typia's emitters. If that analysis changes during Phase 1–2 and typia-side work does surface, D7's case-by-case stance covers it — the files are already in our copy per D1.

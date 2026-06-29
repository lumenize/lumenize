# textMerge — 3-way text merge helper (v3 isolation detour)
> **ARCHIVED 2026-06-15 — COMPLETE (frozen).** v3 spike + production port both shipped (ported to `apps/nebula/src/frontend/`); the `apps/nebula/spike/vue-factory/` source this referenced was removed in 5.3.7/P11, and 5.3.7 (v1–v5) merged to `main` (`87c66c1`). Any unchecked `[ ]` boxes below are the port/D2 tasks — done in v3. Kept as the design+test record cited by ADR-004/005 + the factory source.

**Status**: spec'd 2026-06-11; **implemented + tested in spike 2026-06-12**. Pre-v3 isolation detour for [nebula-frontend.md](nebula-frontend.md) Phase 5.3.7-v3. Lives at `apps/nebula/spike/vue-factory/src/text-merge.ts` (impl + `@longform` resolver shape) and `test/text-merge.test.ts` (28 property tests, phase-0a vitest project); the sibling pure helper `deepEquals` (same detour) got its pinning suite at `test/deep-equals.test.ts`. Tagged `new-in-v3` in [api-reference.md § textMerge](../website/docs/nebula/api-reference.md#textmerge). Remaining work: the v3 port (below).

## Signature

```ts
function textMerge(server: string, local: string, base: string): string;
```

3-way merge: `base` is the common ancestor; `local` and `server` each diverged from it. Returns a merge preserving both sides' non-overlapping edits. `base` is **required and load-bearing** (deep-review B4): with `base === server` the server→base diff is empty and the result collapses to `local` (server's edit silently dropped) — that degeneration is the regression these tests must catch. This function is agnostic to *where* `base` comes from — its three client-side re-anchor sites (first-divergence, commit-boundary, use-this) are owned by [factory-conflict-outcome.md](factory-conflict-outcome.md) invariant 5; `textMerge` just consumes whatever common ancestor it's handed.

## Build vs borrow — DECIDED: hand-rolled

Hand-rolled (~190 LOC including the resolver shape), no `diff-match-patch` dependency. Mechanism: word-level tokenization (alternating whitespace / non-whitespace runs, so `tokens.join('') === input` exactly) → two LCS passes (base↔local, base↔server; common prefix/suffix trim + O(n·m) DP on the divergent middle) → diff3-style chunking on base tokens matched on both sides. A divergent middle past 4M DP cells degrades to "whole middle is one conflict span" (deterministic, never a crash).

**Documented overlap behavior** (the known limitation that motivates CRDT being out of scope): a conflicting span resolves to the **local side wholesale**, except a pure local *deletion* (empty local side) never erases a non-empty server *edit* — the server side wins that span. Same-point concurrent insertions count as overlap (local's insertion wins). Net guarantee: result is `''` only when `local === server === ''` or an identity rule mandates it.

## Property tests — ALL IMPLEMENTED (test/text-merge.test.ts)

- [x] **Identity / degeneration (the B4 trap):** `server === base` ⇒ result `=== local` (only local changed). `local === base` ⇒ result `=== server` (only server changed). `local === server` ⇒ that value. Plus a permanent trap-demonstration test: a `base=server`-anchored impl returns `local` and drops the server edit.
- [x] **Both edits preserved (non-overlapping):** base `"the cat sat"`; local edits the start, server edits the end → `"a cat stood"`; plus insert+append, delete+edit, and longer-sentence variants.
- [x] **Overlap is bounded, not silent:** same-word double-replace → local side; same-point double-insert → local side; local-deletes-span-server-edited → server edit survives; local-deleted-everything-server-edited → full server text (never empty); server-deleted-everything-local-edited → local survives.
- [x] **Empty/edge:** empty base (both typed / one typed), all-identical, single-char (one-side + both-sides), both-deleted ⇒ `''`, local-deleted-server-unchanged ⇒ `''`, whitespace-only edits, multi-line.
- [x] **No-PII / determinism:** pure function of its three args; fixed case battery re-run after interleaved calls ⇒ identical outputs.
- [x] **Round-trip in a resolver:** `makeLongformResolver('body')` on a `'conflict-pending'` resolution returns `{ kind: 'use-this', value: { ...server.value, body: textMerge(server, local, base) } }`; non-`conflict-pending` kinds fall through as `undefined` (M9); never-set optional field merges as `''`.

**Capable-of-failing verified 2026-06-12**: gutting the impl with `base = server` (the B4 trap) failed 14/28 tests — every degeneration, both-edits-preserved, and resolver round-trip property — then restored to green (70/70 across phase-0a).

## Auto-registration (the `@longform` hook)

A field annotated `@longform` auto-registers a per-type resolver that, on `'conflict-pending'`, returns `{ kind: 'use-this', value: { ...server.value, [field]: textMerge(server.value[field], local.value[field], base.value[field]) } }`. The annotation→resolver compile pass lives in the ontology pipeline; this detour owns only the merge function + the resolver *shape* — shipped as `makeLongformResolver(field)` in the same spike file (v3 `ConflictResolverVerdict` shape with the `kind:` discriminant, NOT the spike client's old `ConflictResolution`/`resolution:` shape). Test: a `@longform` field with concurrent non-overlapping edits → both survive (a `base=server` impl drops the server edit — capable-of-failing, verified above).

## Port — DONE 2026-06-14 (nebula-frontend v3 Phase 2)

`textMerge` + `makeLongformResolver` exported from `@lumenize/nebula/frontend` top level (`apps/nebula/src/frontend/text-merge.ts`); `deepEquals` ported to `src/deep-equals.ts` (internal). Both test suites moved to `apps/nebula/test/frontend/{text-merge,deep-equals}.test.ts` (50 tests; unit project 52/52, `tsc` clean). The local `ConflictResolverVerdict`/`ConflictPendingResolution` slice in `text-merge.ts` reconciles with the canonical conflict-outcome engine types when that detour ports. Spike source (`apps/nebula/spike/vue-factory/`) stays until the remaining detours port (deleted in the 5.3.7 post-merge cleanup). This detour file can be archived once the spike dir is removed.

# textMerge — 3-way text merge helper (v3 isolation detour)

**Status**: spec'd 2026-06-11, not started. Pre-v3 isolation detour for [nebula-frontend.md](nebula-frontend.md) Phase 5.3.7-v3. A **pure function** — the cleanest possible thing to build and property-test in isolation, with zero factory/mesh/Vue deps. Build first (the conflict/outcome state machine's `@longform` auto-resolver depends on it). Tagged `new-in-v3` in [api-reference.md § textMerge](../website/docs/nebula/api-reference.md#textmerge).

## Signature

```ts
function textMerge(server: string, local: string, base: string): string;
```

3-way merge: `base` is the common ancestor; `local` and `server` each diverged from it. Returns a merge preserving both sides' non-overlapping edits. `base` is **required and load-bearing** (deep-review B4): with `base === server` the server→base diff is empty and the result collapses to `local` (server's edit silently dropped) — that degeneration is the regression these tests must catch. This function is agnostic to *where* `base` comes from — its three client-side re-anchor sites (first-divergence, commit-boundary, use-this) are owned by [factory-conflict-outcome.md](factory-conflict-outcome.md) invariant 5; `textMerge` just consumes whatever common ancestor it's handed.

## Build vs borrow

LCS-based 3-way merge, ~100–300 LOC hand-rolled, OR pull in `diff-match-patch` (Apache-2.0 — permissive, allowed per CLAUDE.md; add to ATTRIBUTIONS.md). Decide in D0; if borrowing, wrap it so the exported signature + degeneration semantics are ours and stable.

## Property tests (the whole point of isolating this)

- [ ] **Identity / degeneration (the B4 trap):** `server === base` ⇒ result `=== local` (only local changed). `local === base` ⇒ result `=== server` (only server changed). `local === server` ⇒ that value.
- [ ] **Both edits preserved (non-overlapping):** base `"the cat sat"`; local edits the start, server edits the end → result contains both edits.
- [ ] **Overlap is bounded, not silent:** when local and server edit the *same* span, the result is one side or a documented garble — never a crash; never an empty string when at least one side's post-edit text is non-empty (both-sides-deleted-everything legitimately yields `''` — see Empty/edge). (Document the exact overlap behavior; it's the known limitation that motivates CRDT being out of scope.)
- [ ] **Empty/edge:** empty base, empty local, empty server, all-identical, single-char; both sides deleted everything (`local === server === ''`, base non-empty) ⇒ `''` per the identity rule.
- [ ] **No-PII / determinism:** pure function of its three args; same inputs ⇒ same output (no clock/random).
- [ ] **Round-trip in a resolver:** wired into a `'use-this'` handler shape (`textMerge(server.value.body, local.value.body, base.value.body)`), the merged value is what gets re-submitted.

## Auto-registration (the `@longform` hook)

A field annotated `@longform` auto-registers a per-type resolver that, on `'conflict-pending'`, returns `{ kind: 'use-this', value: { ...server.value, [field]: textMerge(server.value[field], local.value[field], base.value[field]) } }`. The annotation→resolver compile pass lives in the ontology pipeline; this detour owns only the merge function + the resolver *shape*. Test: a `@longform` field with concurrent non-overlapping edits → both survive (a `base=server` impl drops the server edit — capable-of-failing).

## Port

Export from `@lumenize/nebula-frontend` top level during v3. Delete this detour after the port.

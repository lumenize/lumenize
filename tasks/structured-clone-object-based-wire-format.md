# Structured-Clone: Object-Based Wire Format for RFC 7396 Diffs

**Status**: Design Complete, Implementation Not Started
**Branch**: `feat/structured-clone-object-based-wire-format` (off `feat/nebula-resources`)
**Created**: 2026-05-16

## Objective

Replace the tuple-based intermediate format produced by `preprocess()` in `@lumenize/structured-clone` with an object-based format that is amenable to RFC 7396 (JSON Merge Patch) diffs. The primary motivating use case is syncing the per-Star DAG ontology (typically 1k nodes, occasionally 10k) to every connected client on every mutation — full-snapshot resends do not scale; per-mutation patches do.

A secondary use case (read-delta synchronization on Resources) is **out of scope** for this PR; only the format change and the DAG-tree fanout integration are in scope.

## Why This Is Worth Doing

The current tuple format fights merge-patch on three axes:

1. `objects` is an **array** indexed by integer id — slot insertion forces array replacement under merge-patch.
2. Every slot is a **tuple `["type", payload]`** — even single-field mutations resend type tag + entire payload.
3. Container payloads are themselves **arrays** (`["array", [...]]`, `["map", [[k,v]...]]`) — no per-element diff possible.

For a 1k-node DAG, a single `label` change today resends the full encoded tree. Under an object-keyed format, it should resend a handful of bytes.

Prior work in [tasks/decisions/structured-clone-format-experiments-results.md](decisions/structured-clone-format-experiments-results.md) compared three formats but optimized for **size and parse perf**, not **patchability**. This task adds patchability as the headline metric and uses the DAG mutation patterns (add / move / rename) as the benchmark workload.

## Design Decisions (Resolved)

### D1: Normalize the in-memory DAG model (`apps/nebula`)
Switch `DagTreeState` from inline-adjacency `nodes: Map<id, { ..., parentIds[], childIds[] }>` to normalized `{ nodes: Map<id, { slug, label, deleted }>, edges, permissions }`. Maintain `#childrenByParent` / `#parentsByChild` as **private DO fields** (not part of `state`), rebuilt from `state.edges` on construction and updated in lockstep with edge mutations. ACL walks are unchanged in big-O.

**Why:** Wire diffs for add/move become 1–2 key flips instead of 3 array replacements. Aligns with Palantir Ontology Framework (edges as first-class). Storage is already normalized — only in-memory needs to change. Edge metadata (typed edges, link properties) becomes possible without future refactor.

**How to apply:** State carries only the canonical, shippable structure. Indexes are local to the DO class and never serialized.

### D2: Permissions stay nested in-memory
Keep `Map<nodeId, Map<sub, PermissionTier>>`. When encoded as nested objects on the wire (not as Maps-as-tuples), merge-patch addresses inner grants natively (`{ permissions: { "42": { "alice": "admin" } } }`). No flattening to composite keys.

### D3: Wire shape mirrors in-memory shape
`preprocess(state)` produces the wire form directly. No projection layer between in-memory and wire. Derived adjacency indexes live next to `state`, not inside it, and are therefore never serialized.

### D4: Format replaces the tuple format wholesale
This is a **breaking change** to `@lumenize/structured-clone`. All internal consumers (`@lumenize/mesh`, `@lumenize/resources`, `apps/nebula`) migrate. No parallel-mode dual maintenance.

### D5: DAG operations to benchmark
- **Add leaf node** (one new node, one new edge)
- **Move node** (delete one edge, add one edge; affects 0–N descendants depending on subtree size — pick "single node" and "subtree of 50" as separate sub-cases)
- **Rename `label`** (single field change on one node)

These are the three Nebula calls out as hot path.

## Co-work Environment Notes

Co-work runs without `.dev.vars` (gitignored secrets: JWT keys, NEBULA_AUTH_BOOTSTRAP_EMAIL, Resend API key, etc.). This determines what work can happen in the cloud versus locally.

**Runs in Co-work:**
- `experiments/structured-clone-object-format/` — fully self-contained, no Nebula imports, no DO runtime needed
- `packages/structured-clone/` — package test suite is pure (no auth, no real DOs)

**Requires local execution (cannot run in Co-work):**
- `apps/nebula/test/test-apps/baseline/*` — needs `.dev.vars` for JWT keys + admin bootstrap; uses `@lumenize/testing` Browser with auth flow
- Any integration touching `Star`, `NebulaClient`, or `NebulaAuth` end-to-end

**Implication for phasing:** Phases 1–2 (design + structured-clone refactor) are Co-work-friendly. Phases 3–4 (in-memory DAG migration + subscription-pipeline integration) must be done locally.

## Phase 1: Wire-Format Experiment (Co-work)

**Goal:** Pick the winning wire format by benchmarking candidates against the DAG mutation workload. Output: a decision recorded in `experiments/structured-clone-object-format/RESULTS.md` plus a reference implementation of the winner.

**Location:** `experiments/structured-clone-object-format/` (per CLAUDE.md experiments convention — own `package.json`, add as individual entry to root workspaces, run `npm install` at repo root). Add a one-line entry in this task file when the experiment dir is created.

**Experiment status (2026-05-16):** ✅ Complete. Winner is **W4** (SuperJSON-style nested document + sparse meta sidecar). See [experiments/structured-clone-object-format/RESULTS.md](../experiments/structured-clone-object-format/RESULTS.md) for the full breakdown — W4 dominates on both snapshot size (21% smaller gzipped than current tuple at N=10k) AND patch size (rename/move/grant under 100 bytes gzipped, vs 165KB for tuple's full-snapshot-on-any-change). Patch library decision: hand-rolled (~120 LOC, no deps) at [experiments/structured-clone-object-format/src/merge-patch.ts](../experiments/structured-clone-object-format/src/merge-patch.ts) — moves into the package in Phase 2.

**What to build:**

1. **Synthetic DAG state generator** — produces a deterministic `{ nodes, edges, permissions }` object of N nodes with realistic fanout distribution (e.g., 80% leaves, 15% mid-tier branches, 5% root-ish wide branches). Generate fixtures at N=100, N=1000, N=10000.
2. **Mutation harness** — pure functions implementing the three D5 operations. Each returns `{ before, after, mutationDescription }`.
3. **Candidate wire formats** — implement at minimum:
   - **W1 (minimal change):** `objects` becomes an object keyed by stringified id; tuples preserved inside slots. Smallest deviation from current.
   - **W2 (`$type`-tagged slots):** each slot is `{ $type: "object", ...props }` — per-field diffs work for plain objects, per-slot for other types.
   - **W3 (key-as-discriminator + unwrap):** plain objects stored natively (`{ "0": { label: "Alice" } }`); other types wrapped via a single reserved-key (`{ $date: "..." }`, `{ $map: [...] }`). Requires user-key escape rule.
   - **W4 (SuperJSON-style meta-table):** `{ json, meta: { paths: { "objects.42.label": "string" } } }`. Beautiful for the cycle-free DAG; falls back to id-table for cycle cases.
4. **Patch generator** — for each format, produce an RFC 7396 patch from `(before, after)`. Use [rfc6902 / json-merge-patch npm library] — pick one in Phase 1, document why.
5. **Patch applier** — reconstruct `after` from `before + patch`; verify byte-for-byte equality (via re-encoding).
6. **Benchmarks** (vitest `bench` or simple loop with `performance.now()`):
   - **Include the current tuple format as a comparison baseline.** Every candidate is measured against it on every metric, not just against each other.
   - **Full-snapshot bytes (raw, JSON-stringified)** for current tuple + each candidate, at each fixture size. This catches per-slot wrapper overhead — e.g., `{"$type":"object","key":...}` is meaningfully longer than `["object",{...}]`, and a 10k-node tree pays that overhead in full on every cold-connect or patch-miss snapshot resend.
   - **Full-snapshot bytes (gzipped, `node:zlib.gzipSync`)** — gzip collapses repeated key strings effectively, so this is the more realistic transport size, but raw matters for in-memory and non-compressed paths.
   - **Patch bytes (raw and gzipped)** for each `(format × operation)` — the headline diff-friendliness metric.
   - **Encode time, patch-generate time, patch-apply time, decode time** — perf must not regress meaningfully from current.
7. **Results** — table in `RESULTS.md` covering each `(format × operation × size)` combination, **with the current tuple format as the first row in every comparison.** Include a recommendation paragraph that explicitly addresses the snapshot-vs-patch tradeoff (see below).

**The snapshot-vs-patch tradeoff:**
A candidate format that produces 10× smaller patches but 1.5× larger snapshots is still a net win for long-lived WebSocket sessions where many mutations are applied per connection — but a net loss for short sessions dominated by the initial snapshot. The recommendation in `RESULTS.md` must compute the breakeven N (number of mutations per session at which the patch savings amortize the snapshot bloat) and call out whether realistic Nebula session profiles sit comfortably above that N. If a candidate's snapshot bloat is so large that breakeven N is implausible, it's disqualified regardless of patch-size win.

**Wire compression assumption (verified 2026-05-16):**
Cloudflare Workers WebSocket connections **are compressed by default via `permessage-deflate`** when `compatibility_date >= 2023-08-15`. Lumenize is at `2026-03-12`, so compression is on. **Gzipped bytes are therefore the primary metric — they approximate the actual wire size.** Raw bytes remain a secondary metric for: (a) in-memory state size, (b) any future non-WebSocket transport (e.g., HTTP responses where Cloudflare's `accept-encoding` negotiation applies separately), (c) storage of snapshots/patches if we ever persist them. Application-level pre-compression (`gzipSync` → binary frame) stays available as a deterministic fallback but is not load-bearing for this experiment. Source: [workerd#4091 thread](https://github.com/cloudflare/workerd/issues/4091) — original report was a stale-compat-date misdiagnosis, confirmed working by Cloudflare engineer (Kenton Varda) and an independent tester.

**Success Criteria:**
- Four candidate formats implemented and unit-tested for round-trip correctness on a representative DAG.
- Benchmark numbers for all `(format × operation × size)` combinations, **with current tuple format as the comparison baseline.**
- **Full-snapshot size delta** (winning format vs current tuple format, raw + gzipped) reported at all three fixture sizes. If the winner's gzipped snapshot exceeds the current's by more than ~25% at N=10k, this gets called out and the breakeven-N analysis must show the tradeoff is clearly worth it.
- A clear winner identified, or an explicit "two formats are close; flip a coin" finding documented.
- Reference implementation of the winner is the seed for Phase 2's package refactor.

**Out of scope for Phase 1:**
- Touching `packages/structured-clone/` itself
- Touching `apps/nebula`
- Cycles / aliases — DAG fixtures have no JS-level cycles. Add cycle support during Phase 2 when migrating the real preprocess/postprocess.

## Phase 2: Structured-Clone Package Refactor (Co-work)

**Goal:** Replace the tuple format in `packages/structured-clone/` with the Phase 1 winner. All package-level tests pass.

**What to do:**

1. **Update `preprocess.ts`** to emit the new format. Preserve cycle/alias detection via the existing `seen` WeakMap; the new format expresses them differently but the detection logic doesn't change.
2. **Update `postprocess.ts`** to consume the new format.
3. **Update `web-api-encoding.ts`** if RequestSync/ResponseSync encoders need shape changes (likely yes — they currently emit objects nested inside tuples).
4. **Update transform-hook contract** — `PreprocessTransform` and `__lmzId` semantics. Currently a hook returning `{ __lmzId, ...payload }` gets the payload installed at `objects[id]`. The replacement contract should be documented in `preprocess.ts` JSDoc + the website docs.
5. **Update existing tests** — `core.test.ts`, `aliases.test.ts`, `errors.test.ts`, `special-numbers.test.ts`, `request-sync.test.ts`, `response-sync.test.ts`, `web-api-objects.test.ts`. Most will need fixture updates; behavior shouldn't change.
6. **Add patch tests** — round-trip `(state, mutation) → patch → apply → state'` for at least one representative case per supported type (object, array, Map, Set, Date, Error, cycle-bearing graph).
7. **Update `website/docs/structured-clone/`** — format-shape documentation. Use `@check-example` linked to the new tests.

**Success Criteria:**
- `npx vitest run` in `packages/structured-clone/` green.
- `npx vitest run` in `packages/mesh/` and `packages/resources/` green (these consume preprocess/postprocess via the mesh framing).
- `npm run check-examples` in `website/` green (modulo any docs awaiting Phase 4 content).
- Patch-generate + patch-apply utilities exported from package's public API.

**Open question — patch library:**
Two options for the patch generate/apply primitives:
- (a) Use a library (`rfc6902`, `json-merge-patch`, `fast-json-patch`) — picks up edge cases for free.
- (b) Hand-roll — apply is ~50 LOC, diff is ~150 LOC, no transitive dependencies.
Decide during Phase 1 with library survey; record in `RESULTS.md`.

## Phase 3: Nebula DAG In-Memory Normalization (LOCAL)

**Goal:** Apply D1 to `apps/nebula`. Baseline test-app green.

**Files in scope (verified via grep):**
- `apps/nebula/src/dag-ops.ts` — pure-logic adjacency walks + cycle detection
- `apps/nebula/src/dag-tree.ts` — DO methods that mutate state and rebuild it from storage
- `apps/nebula/test/test-apps/baseline/dag-tree.test.ts` — integration coverage

Nothing in `star.ts`, `nebula-client.ts`, `resources.ts`, `subscriptions.ts`, or `galaxy.ts` reads `parentIds` / `childIds` directly. The blast radius is just the three files above.

**What to do:**

1. **Change `DagTreeState`** type to `{ nodes: Map<id, NodeData>, edges: Set<\`${parentId}:${childId}\`>, permissions: Map<id, Map<sub, tier>> }`. `NodeData` loses `parentIds` and `childIds`.
2. **Add `#childrenByParent` and `#parentsByChild`** as private DO fields on the `DagTree` class. Build them from `state.edges` in `#buildState()`.
3. **Add an index-maintenance helper** (e.g., `#addEdge(parent, child)` / `#removeEdge(parent, child)`) that mutates `state.edges` and both indexes atomically.
4. **Refactor `dag-ops.ts`** — `detectCycle`, ancestor walks, descendant walks now take the indexes (or a state-with-indexes view) rather than reading `node.parentIds` / `node.childIds`. Update signatures.
5. **Update `dag-tree.ts` mutation methods** — `addChild`, `removeChild`, `move` (whatever they are called) now go through `#addEdge` / `#removeEdge`.
6. **Update `dag-tree.test.ts`** — assertions over `state.parentIds` / `state.childIds` become assertions over `state.edges` (or via helper methods on the test client). Test scope unchanged.

**Success Criteria:**
- `npx vitest run` in `apps/nebula/` baseline test-app green at the same count as the pre-refactor baseline (158/158 per memory or whatever the current number is).
- `npm run type-check` clean across `apps/nebula`.
- `getState()` returns the new shape; no consumers are broken (the only external consumer per memory is the integration test).

**Pre-flight:** before starting Phase 3, confirm `getState()` is not relied upon by anything published in `@lumenize/nebula`'s exported API beyond `apps/nebula/`. If it is, that's a separate breaking-change conversation.

## Phase 4: Wire-Format Integration (LOCAL)

**Goal:** Use the new wire format and merge-patch primitives to ship per-mutation DAG-tree updates to subscribed clients, replacing the current "send full snapshot on every change."

**What to do:**

1. **Client tracks last-known DAG snapshot** by content-derived ETag (or version number — pick during this phase; ETags are already in flight per the user's read-delta plan).
2. **Server-side fanout in `Star`** — when DAG mutates, compute `patch = diff(prevSnapshot, newSnapshot)` once, send `{ patch, fromETag, toETag }` to every subscriber. Fall back to full snapshot if subscriber's `fromETag` is unknown / too old (no patch history kept).
3. **Client-side apply** — on receipt, `state = applyPatch(currentState, patch)`, verify resulting ETag matches `toETag`; on mismatch, request full snapshot resync.
4. **Failure modes:**
   - Missed patch (subscriber's `fromETag` doesn't match server's most recent prev) → fall back to full snapshot
   - Apply-then-ETag-mismatch → fall back to full snapshot, log telemetry
   - Subscriber not yet sent first snapshot → full snapshot is the first send (no patch attempt)
5. **Tests** — extend `dag-tree.test.ts` (or add `dag-tree-sync.test.ts`) covering: subscribe-and-get-snapshot, mutate-and-get-patch, missed-patch-recovers-via-snapshot, multi-mutation-coalescing (if implemented).

**Success Criteria:**
- Bench: synthetic 1k-node tree, single `label` change produces a patch under ~100 bytes gzipped (subject to refinement based on Phase 1 numbers).
- Baseline test-app green.
- Client and server agree on state after sequences of all three D5 operations interleaved.

**Out of scope for this PR:**
- Per-Resource read-delta synchronization (the user's mentioned secondary use case). Same plumbing applies but is a separate feature.

## Open Design Questions (Surface, Don't Block)

These will surface during Phase 1 benchmarking and Phase 4 integration. Capture in the experiment's RESULTS.md as they're resolved.

- **Patch-history retention on the server.** Zero (always full snapshot on miss), N-deep ring buffer, or per-subscriber dirty-tracking? Trade-off: memory vs. snapshot-resend bandwidth. Most-likely answer: zero — keep it simple, full-snapshot path must work anyway.
- **Coalescing** — if 10 mutations happen in 50 ms, do we send 10 patches or 1 coalesced patch? Likely coalesce per fanout invocation but defer until Phase 4 perf shows it matters.
- **Patch sequence numbers.** If WebSocket guarantees ordering, ETag chaining (each patch announces `fromETag → toETag`) is sufficient. If not, need monotonic seqno alongside.
- **JSON Merge Patch library choice.** Survey in Phase 1; record decision.
- **Should `@lumenize/structured-clone` expose `diff` and `applyPatch` as public API, or only `preprocess` / `postprocess`?** Lean toward yes — Resources phase will want them — but confirm before exposing.
- **Permissions-only changes** — granting `alice` admin on node 42 should produce a tiny patch. Verify in Phase 1 benchmarks (add as a 4th operation if it shakes out differently).
- **Snapshot-bloat acceptance threshold.** Phase 1 currently flags >~25% gzipped snapshot growth at N=10k as the "call this out and justify" line. Refine this once we see real numbers — the actual threshold depends on Nebula's expected session-length distribution (long-lived WS sessions tolerate more bloat than short ones).

## References

- **Current tuple format**: `packages/structured-clone/src/preprocess.ts`
- **Prior format experiments**: [tasks/decisions/structured-clone-format-experiments-results.md](decisions/structured-clone-format-experiments-results.md), [tasks/decisions/structured-clone-format-analysis.md](decisions/structured-clone-format-analysis.md) — these compared three formats on size/parse-perf only; this task adds patchability as the primary metric.
- **Current DAG model**: `apps/nebula/src/dag-tree.ts:40-128` (schema + `#buildState()`), `apps/nebula/src/dag-ops.ts:12-21` (state type + walks)
- **RFC 7396**: https://datatracker.ietf.org/doc/html/rfc7396

## Phasing Summary

| Phase | Where | Co-work? | Output |
|---|---|---|---|
| 1 | `experiments/structured-clone-object-format/` | ✅ Yes | Benchmark results + chosen format + reference impl |
| 2 | `packages/structured-clone/` | ✅ Yes | New format shipped in package, all tests green |
| 3 | `apps/nebula/src/{dag-tree,dag-ops}.ts` | ❌ Local only | Normalized in-memory DAG, baseline test-app green |
| 4 | `apps/nebula/src/{star,nebula-client}.ts` | ❌ Local only | Per-mutation patches over the wire, sync verified |

**Sequencing rule:** Phase 1 must complete (with a chosen winner) before Phase 2 begins. Phases 3 and 4 can be interleaved or sequenced — Phase 3 has no dependency on Phase 2, so Phase 3 is the natural first local-only chunk.

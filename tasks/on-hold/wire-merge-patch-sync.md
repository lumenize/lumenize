# Wire Merge-Patch Synchronization (DAG + Resources)

**Status**: On hold — post-demo
**Depends on**:
- W4 wire format + `diff` / `applyMergePatch` utilities — shipped in [PR #11](https://github.com/lumenize/lumenize/pull/11) (merge commit `260c242`)
- DAG normalization (originally Phase 3 of the wire-format task) — ✅ shipped 2026-05-16, archived at [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md)
**Related**: [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md) "DAG-binding update strategies" Options C and D — both became cheaper after W4 shipped.

## Goal

Use the W4 wire format + RFC 7396 (JSON Merge Patch) primitives to send per-mutation deltas over the wire, replacing full-snapshot sends. Two use cases:

1. **DAG-tree fanout sync** — every Star pushes its DAG to every connected client on every mutation. With 1k typical (10k worst-case) nodes per Star and many connected clients per Star, full-snapshot resends don't scale. Was the original motivating use case (Phase 4 of the wire-format task).
2. **Per-resource read sync** — when a client `read`s a resource it already has a snapshot for, server sends a patch from the last-known ETag instead of a full snapshot. Secondary use case but the plumbing largely overlaps.

Most plumbing is common; the DAG path adds a few specifics (per-Star fanout, snapshot ETag chain) that don't apply to the per-resource path.

## Why on hold (post-demo)

- The demo ships with **Option 0** for DAG (eTag-bump-and-pull per [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md)) and full-snapshot reads — both functional, just not bandwidth-optimal.
- W4 + `diff` + `applyMergePatch` are already in place — the foundation is done. This task is purely the integration into Nebula's fanout / read paths.
- Worth picking up once a real workload exposes the scale concern: 1k-node DAG full-resends saturating bandwidth, or large resources read often where most reads return "unchanged."

## Foundation (already shipped)

From [PR #11](https://github.com/lumenize/lumenize/pull/11):

- W4 object-based wire format produced by `preprocess()`, consumed by `postprocess()` — `{ json, meta }` shape, RFC 7396-compatible (object-keyed, no tuple arrays for Map entries).
- `diff(beforeW4, afterW4)` → RFC 7396 patch.
- `applyMergePatch(beforeW4, patch)` → afterW4.
- Both exported from `@lumenize/structured-clone`.
- RFC 7396 Appendix A conformance suite passes.

## Common architecture (DAG + Resources)

### ETag as the correlation key

Both use cases use an **ETag chain**: `{ patch, fromETag, toETag }`. Receiver applies patch iff `currentETag === fromETag`. On any mismatch (or apply failure, or postprocess-produces-wrong-ETag), receiver requests a full snapshot.

### Patch-history retention on the server

The server has to decide what's in `fromETag` when patching. Three strategies:

1. **Zero retention.** Always full snapshot when subscriber's `fromETag` doesn't match `most-recent-prev`. Simplest. Works well for fanout (subscribers usually have current state). Weak for reads (clients often have stale views).
2. **N-deep ring buffer.** Server keeps the last N versions. Diffs against the oldest version it can find that matches `fromETag`. Memory cost: N × (snapshot size).
3. **Per-subscriber dirty-tracking.** Server tracks per-client `lastSentETag`, computes patch on demand. Memory cost: O(clients), but enables coalescing.

Likely starting point: **(1)** for DAG fanout, **(2)** with small N (e.g., 5) for per-resource reads. Per-subscriber tracking is overkill for the demo scale.

### Patch sequence numbers

If WebSocket guarantees ordering, ETag chaining is sufficient. If not (e.g., HTTP poll, future transports), need monotonic seqno alongside ETags.

### Coalescing

If 10 mutations happen in 50 ms, do we send 10 patches or 1 coalesced patch? Likely coalesce per fanout invocation. Defer until perf shows it matters.

### Where the previous state lives (diff source-of-truth)

To compute `diff(prev, new)` for fanout, the server needs the *immediately previous* W4 snapshot. The DAG normalization that landed pre-demo solved the *in-memory* shape but didn't decide *where* the previous state lives. Three options, in order of recommendation:

**C — In-memory snapshot reference (recommended, simplest).** Keep current row-level storage. Maintain a `#lastFanoutSnapshot: W4 | null` reference on the DagTree class (or in Star). Flow:
1. Mutation happens → invalidate state cache (current behavior).
2. Next access rebuilds state from rows (current behavior).
3. On fanout: compute `newSnapshot = preprocess(state)` (needed anyway to send), `patch = diff(lastFanoutSnapshot, newSnapshot)`, fan out.
4. `lastFanoutSnapshot = newSnapshot`.

No storage changes, no new abstractions. Drift-proof. The "previous snapshot" is a single in-memory reference, refreshed on every fanout. Eviction → `lastFanoutSnapshot` is null → first fanout after wake sends full snapshot (acceptable; rare event).

**A — Whole DAG as a single Resource row (also strong).** Serialize the entire `DagTreeState` to one row; let Resources' built-in `validFrom`/`validTo` give us versioning for free. On fanout, the "previous version" is a storage read.

Pros vs C:
- Cold-load reads collapse from `O(N + E + P)` row-reads (full table scans) to **1 row-read**. For 1k-node trees that's ~2.5k rows → 1.
- Per-mutation write count is equal or better than current: 1 row vs 1–2 rows for multi-row mutations (add-node, move-node). Per CLAUDE.md, writes are 1000× reads — this favors A.
- Previous-version retrieval is a storage read, not a memory invariant — DO eviction doesn't lose history.

Cons / unknowns:
- **Storage growth**: every version retained as a full blob. At ~30–50 KB serialized per 1k-node DAG, mutation rate × retention determines GB-month cost. Probably noise at typical ontology mutation rates.
- **Per-row size cap**: DO SQL row size limit isn't documented as a specific number that I've verified. SQLite supports up to 1 GB rows; Cloudflare may cap lower. A 10k-node W4 blob could plausibly hit a real cap. If it does, multi-row chunking erodes the "1 read" benefit.
- Writes are 1 row but the row is *large* — billing is per-row not per-byte, so this is mostly fine, but worth confirming nothing in the pricing model penalizes large rows.

**B — `validFrom`/`validTo` per node/edge/permission row (most "Resources-like" but most complex).** Each mutation closes an old row and opens a new one. Reconstructing state at time T means three AS-OF queries across `Nodes`/`Edges`/`Permissions`. Storage growth comparable to A but in many small rows. Beautiful for temporal queries; expensive for cross-table coherence on every read.

**Tentative landing**: start with **C** when this work is picked up — it's the smallest change and solves the specific motivation. If cold-load read costs prove painful (workload-dependent — depends on DO eviction frequency), revisit **A**. **B** stays a long-tail option for if/when temporal queries become a first-class capability beyond DAG sync.

**Verify before committing to A** (when/if we go there): (1) confirm the DO SQL per-row size cap; (2) bench actual mutation rate against expected storage growth; (3) confirm CF billing model is purely per-row, not per-byte, for SQL writes.

## DAG-specific sub-plan

### Server-side (Star)

1. Star tracks the W4-encoded snapshot of `DagTreeState` per ontology version (or computes lazily from the current normalized state). Snapshot ETag = content hash.
2. On every mutation: recompute the W4 snapshot, compute `patch = diff(prev, new)` once.
3. Fanout: send `{ patch, fromETag, toETag }` to every subscribed client.
4. If a subscriber's known ETag doesn't match `prev`'s ETag → send a full snapshot instead.

**DAG normalization (shipped 2026-05-16, archive: [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md))** was the hard prerequisite for this work. Without it, the inline `parentIds[]` / `childIds[]` arrays would have forced whole-array replacement under merge-patch on every edge change — defeating the diff. With normalized `{ nodes, edges, permissions }`, adding a node is two key flips (one new node entry + one new edge entry).

### Client-side (NebulaClient)

1. Track `currentDagETag` per Star.
2. On receipt of `{ patch, fromETag, toETag }`: if `currentDagETag === fromETag`, apply, update.
3. Mismatch / apply error → request full snapshot resync.

### DAG failure modes

- **Missed patch** (subscriber's `fromETag` not matching server's most recent prev) → full snapshot.
- **Apply succeeds but ETag mismatch** → full snapshot, log telemetry (indicates a bug somewhere).
- **New subscription** → full snapshot is the first send.

### DAG test coverage

Extend `dag-tree.test.ts` (or add `dag-tree-sync.test.ts`):
- subscribe-and-get-snapshot
- mutate-and-get-patch
- missed-patch-recovers-via-snapshot
- multi-mutation coalescing (if implemented)

### DAG success criterion (target from original Phase 4)

- 1k-node tree, single `label` change → patch under ~100 bytes gzipped.
- Add/move/rename operations all produce sub-snapshot patches.

## Per-resource sub-plan

### Server-side

1. On `read(rt, rid, knownETag)`: if current ETag matches `knownETag`, return `{ status: 'unchanged', eTag }` — zero-cost path.
2. If ETags differ: try to compute `patch = diff(versionAt(knownETag), current)`. Return `{ patch, fromETag, toETag }`.
3. If `versionAt(knownETag)` isn't materializable (beyond retention window) → return full snapshot.

### Client-side

1. On `client.resources.read(rt, rid)`: send `last-known-ETag` header / arg if a snapshot exists locally.
2. Receive `unchanged` → no-op, snapshot stays.
3. Receive `{ patch, fromETag, toETag }` → apply, update.
4. Receive full snapshot → replace.
5. Apply failure → request full snapshot.

### What's different from DAG

- **Per-resource ETag tracking** instead of per-DAG-tree.
- **Read-driven** instead of mutation-fanout-driven.
- **Patch-history retention matters more** — clients have stale views routinely (not just immediately after a fanout). Hence the ring-buffer choice above.

### Per-resource test coverage

- read-with-current-ETag → `unchanged`
- read-with-stale-ETag → patch
- read-with-too-stale-ETag → full snapshot
- patch-apply-failure → full-snapshot retry

## Adjacent DAG optimization: lazy access-control reads

Independent of the patch-sync work but landing in the same cost-efficiency theme. Worth capturing here because the implementation reshapes the DagTree class's read paths and conflicts conceptually with the diff-source-of-truth design — they should be decided together.

### Motivation

After Phase 3 (DAG normalization), every cold-path access to `DagTree.requirePermission(...)` triggers `#buildState()`, which is a full-table scan of `Nodes`, `Edges`, and `Permissions` (~`N + E + P` row reads — ~2.5k rows for a 1k-node DAG). Under DO hibernation (10s idle → eviction), every wake-up pays this cost on the very first request.

But 99% of requests aren't DAG mutations — they're permission checks for normal resource operations. A permission check only needs to know "does `sub` have at least `tier` on `nodeId`?" — which is bounded by tree depth × upward fanout. For typical org trees (depth 3–6, fanout 1–2), that's 3–12 row reads — and usually fewer because the check short-circuits on a direct grant near the leaf.

**100–1000× fewer reads per cold-path permission check.** At scale (e.g., 10k Stars × 10 wake-ups/day × 2.5k reads each = 250M row-reads/day just from cold loads), this is real money.

### The proposal

Add a "cold mode" path that reads adjacency and grants from SQL on demand, used when `#_view` is null:

1. `DagTree.requirePermission(nodeId, tier)`: if `#_view` exists, use the in-memory walk (current behavior). Otherwise, walk via per-node SQL.
2. SQL walk for permission check on `(sub, nodeId, tier)`:
   - `SELECT permission FROM Permissions WHERE nodeId = ? AND sub = ?` (uses PK index)
   - If grant >= tier → return true
   - Else: `SELECT parentNodeId FROM Edges WHERE childNodeId = ?` (uses `idx_Edges_child`)
   - For each parent, repeat (BFS with visited set)
3. Mutations still trigger the rebuild (cycle detection + slug uniqueness need the full view). After a mutation, the cache stays warm under sustained activity; eviction returns the DO to cold mode.

### Graceful degradation

- **Lightly loaded Star (rare access, mostly hibernated)**: every wake stays in cold mode → permission checks cost ~depth reads, never pays the 2.5k rebuild. Wins big.
- **Heavily loaded Star (sustained activity)**: first mutation rebuilds the cache → cache stays warm under continuous use → in-memory path serves all subsequent permission checks → no SQL pollution. No regression.
- **Mid case (occasional bursts)**: each burst's first request uses SQL (cheap); mutations within the burst warm the cache.

### Implementation outline

Cleanest design: a thin adapter interface so the walks themselves live once.

```ts
interface DagTreeReader {
  getDirectGrants(nodeId: number, sub: string): PermissionTier | null;
  getParents(nodeId: number): Iterable<number>;
}
```

- `InMemoryReader` wraps a `DagTreeView`
- `SqlReader` wraps `DurableObjectState['storage']`

`resolvePermission(reader, sub, nodeId, tier)` and `getEffectivePermission(reader, sub, nodeId)` accept a `DagTreeReader` instead of (or in addition to) `DagTreeView`. The walking logic stays in one place.

`DagTree.requirePermission()` picks: `reader = this.#_view ? new InMemoryReader(this.#_view) : new SqlReader(this.#ctx.storage)`.

Cycle detection, slug uniqueness, `getNodeAncestors`, `getNodeDescendants`: leave on the view path; mutations rebuild it anyway.

### Risks

1. **Test coverage drift**: in-memory path gets heavily tested because mutations are common in test setup. SQL path can go untested. Mitigation: a test fixture that constructs a DO with seed data via direct SQL, then runs permission-check assertions BEFORE any mutation (so the view stays null).
2. **Two paths for the same logic** if the adapter abstraction isn't strong enough. Mitigation: keep the adapter narrow (the two methods above), so divergence is impossible by construction.
3. **Worst-case deep tree**: a 20-deep tree with grants only at the root means 20 SQL reads per permission check. Still microseconds (in-process SQLite), but worth bounding in monitoring once we have real workloads.

### Interaction with diff-source-of-truth options

- **Option C (in-memory snapshot reference, recommended above)**: orthogonal — Option C tracks `lastFanoutSnapshot` for patch generation; this proposal optimizes a different read path (permission checks). Both can land together.
- **Option A (whole DAG as Resource row)**: somewhat redundant — A's cold-load cost is already 1 row read, so the "lazy" optimization buys little. Decide A first; if A wins, this section becomes moot.
- **Option B (validFrom/validTo per row)**: complementary — the SQL walks here would query `Nodes`/`Edges`/`Permissions` as-of `now`, slightly more complex but tractable.

### When to do this

Estimated effort: ~150–300 LOC + tests. Phase-3-adjacent; Phase 3 code is fresh and the abstractions are still local. Could ship pre-demo as a cost optimization, or wait until the patch-sync work picks up and bundle it.

## Open design questions (defer until pickup)

- **Patch-history retention concrete N for resources.** Memory budget vs. cache hit rate.
- **Subscriptions on resources** — do they use the same patch fanout as DAG, or stay read-only? If subscriptions land, the DAG and Resource paths converge.
- **Permissions-only DAG changes** — should produce a tiny patch (`{ permissions: { "42": { "alice": "admin" } } }`). Verify in benchmarks.
- **Patch generation cost** — `diff` is O(snapshot size). Acceptable for 1k-10k node DAGs. Watch for surprises at the high end.
- **Compression interaction** — WS `permessage-deflate` is on by default for `compatibility_date >= 2023-08-15` (verified via the workerd#4091 thread; Lumenize is at `2026-03-12`). Patches compress less aggressively than uniform snapshots; raw bytes matter slightly more here than for snapshots.

## Phasing when picked up

| Phase | Scope | Where |
|---|---|---|
| A | DAG-tree sync — server fanout + client apply + tests | `apps/nebula/src/{star,nebula-client}.ts`, baseline tests |
| B | Per-resource read sync — same primitives, different drivers | `apps/nebula/src/resources.ts`, NebulaClient resources API |
| C | Perf verification — synthetic benchmarks for both paths | `apps/nebula/test/browser/` or a new bench dir |

Phase A depends on `tasks/archive/nebula-dag-normalize.md` shipping first. Phase B is independent of A and can ship in either order; co-shipping makes the most sense since the plumbing overlaps.

## References

- [tasks/archive/structured-clone-object-based-wire-format.md](../archive/structured-clone-object-based-wire-format.md) — design context for Phases 1+2 (the W4 wire format itself), shipped
- [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md) — Phase 3, prerequisite for the DAG half of this work
- [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md) — DAG-binding update strategies (Options 0–D); see Option D for the strategy this task implements
- [RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) — JSON Merge Patch
- [PR #11](https://github.com/lumenize/lumenize/pull/11) — W4 wire format ship

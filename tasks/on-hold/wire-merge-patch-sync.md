# Wire Merge-Patch Synchronization (DAG + Resources)

**Status**: On hold — picked up as [nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 14*, after pre-alpha
**Depends on**:
- W4 wire format + `diff` / `applyMergePatch` utilities — shipped in [PR #11](https://github.com/lumenize/lumenize/pull/11) (merge commit `260c242`)
- DAG normalization (originally Phase 3 of the wire-format task) — ✅ shipped 2026-05-16, archived at [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md)
- **A format a merge patch can address — ✅ built 2026-10-14** by [archive/structured-clone-patches-small-and-exact.md](../archive/structured-clone-patches-small-and-exact.md), ahead of the wipe. A Map, Set or long id list patches one entry at a time, a shared object is a `$ref` pointer, and a patch keeps a `null`, a `__proto__` key, and every Map's, Set's and array's order.
**Related**: [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md) "DAG-binding update strategies" Options C and D — both became cheaper after W4 shipped.

## Goal

Use the structured-clone encoding + RFC 7396 (JSON Merge Patch) primitives to send per-mutation deltas over the wire, replacing full-snapshot sends. Two use cases:

1. **DAG-tree fanout sync** — every Star pushes its DAG to every connected client on every mutation. With 1k typical (10k worst-case) nodes per Star and many connected clients per Star, full-snapshot resends don't scale. Was the original motivating use case (Phase 4 of the wire-format task).
2. **Per-resource read sync** — when a client `read`s a resource it already has a snapshot for, server sends a patch from the last-known version, its `validFrom` ([ADR-005](../../docs/adr/005-optimistic-concurrency.md)), instead of a full snapshot. Secondary use case but the plumbing largely overlaps.

Most plumbing is common; the DAG path adds a few specifics (per-Star fanout, snapshot ETag chain) that don't apply to the per-resource path.

## Why on hold (post-demo)

- The demo ships with **Option 0** for DAG (eTag-bump-and-pull per [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md)) and full-snapshot reads — both functional, just not bandwidth-optimal.
- The encoding, `diff` and `applyMergePatch` are in place, so this task is purely the integration into Nebula's fanout / read paths.
- Worth picking up once a real workload exposes the scale concern: 1k-node DAG full-resends saturating bandwidth, or large resources read often where most reads return "unchanged."

## Foundation (already shipped)

From [PR #11](https://github.com/lumenize/lumenize/pull/11):

- The encoding `preprocess()` writes and `postprocess()` reads, made patchable by [archive/structured-clone-patches-small-and-exact.md](../archive/structured-clone-patches-small-and-exact.md): a Map is `{"$type":"map","object":{…}}` and a Set likewise, a shared object is `{"$ref":"#/…"}`, and `null` is a tag. Its § *Build notes* records the measured patch sizes.
- `diff(before, after)` → `{ kind: 'same' }`, `{ kind: 'patches', patches }` (one, or two when a collection under a plain object changed order) or `{ kind: 'full' }`.
- `applyMergePatch(before, patch)` → the next encoding, one patch at a time; SQLite's `json_patch` gives the same result.
- Both exported from `@lumenize/structured-clone`.
- RFC 7396 Appendix A conformance suite passes.

## Common architecture (DAG + Resources)

### ETag as the correlation key

For a resource, the ETag in this chain is its `validFrom`; the org tree's stays a content hash.

Both use cases use an **ETag chain**: `{ patch, fromETag, toETag }`. ⚠️ `diff` now answers `same`, a list of patches, or `full`, so the envelope carries a list, or the full value ([nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 14* designs it). Receiver applies patch iff `currentETag === fromETag`. On any mismatch (or apply failure, or postprocess-produces-wrong-ETag), receiver requests a full snapshot.

**Decided 2026-10-14 (Larry): a subscription push is the same for every subscriber.** A client whose version does not match the push's base sends a read with its last version and gets a patch bridging the versions it missed. For a resource, ADR-004 keeps every version, so the base is still stored while it is in hot storage. The retention strategies below are for the org tree, whose state keeps no history.

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

To compute `diff(prev, new)` for fanout, the server needs the *immediately previous* encoded snapshot. The DAG normalization that landed pre-demo solved the *in-memory* shape but didn't decide *where* the previous state lives. The options, in order of recommendation:

**C — In-memory snapshot reference (recommended, simplest).** Keep current row-level storage. Maintain a `#lastFanoutSnapshot: JsonValue | null` reference on the OrgTree class (or in Star). Flow:
1. Mutation happens → invalidate state cache (current behavior).
2. Next access rebuilds state from rows (current behavior).
3. On fanout: compute `newSnapshot = preprocess(state)` (needed anyway to send), `diff(lastFanoutSnapshot, newSnapshot)`, fan out.
4. `lastFanoutSnapshot = newSnapshot`.

No storage changes, no new abstractions. Drift-proof. The "previous snapshot" is a single in-memory reference, refreshed on every fanout. Eviction → `lastFanoutSnapshot` is null → first fanout after wake sends full snapshot (acceptable; rare event).

**A — Whole DAG as a single Resource row (also strong).** Serialize the entire `OrgTreeState` to one row; let Resources' built-in `validFrom`/`validTo` give us versioning for free. On fanout, the "previous version" is a storage read.

Pros vs C:
- Cold-load reads collapse from `O(N + E + P)` row-reads (full table scans) to **1 row-read**. For 1k-node trees that's ~2.5k rows → 1.
- Per-mutation write count is equal or better than current: 1 row vs 1–2 rows for multi-row mutations (add-node, move-node). Per CLAUDE.md, writes are 1000× reads — this favors A.
- Previous-version retrieval is a storage read, not a memory invariant — DO eviction doesn't lose history.

Cons / unknowns:
- **Storage growth**: every version retained as a full blob. With UUID ids the tree encodes to about 216 bytes a node, 214 KB at 1,000 nodes and 2.16 MB at 10,000 (measured 2026-11-15, § *Applying and building a patch*), so every mutation of a 10,000-node tree stores another 2 MB. Mutation rate × retention determines GB-month cost.
- **Per-row size cap — answered 2026-11-16.** A SQLite-backed Durable Object stores a string or row of up to 8 MB ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)), and `experiments/merge-patch-sql` stored and patched the 2.16 MB tree deployed. One row holds about 37,000 nodes at that density, so chunking is not a near-term concern.
- Writes are 1 row but the row is *large* — billing is per-row not per-byte, so this is mostly fine, but worth confirming nothing in the pricing model penalizes large rows.

**B — `validFrom`/`validTo` per node/edge/permission row (most "Resources-like" but most complex).** Each mutation closes an old row and opens a new one. Reconstructing state at time T means three AS-OF queries across `Nodes`/`Edges`/`Permissions`. Storage growth comparable to A but in many small rows. Beautiful for temporal queries; expensive for cross-table coherence on every read. § *Option B with the tree's rows as resources* reworks it into one table, and § *Does the tree want history?* asks whether the tree should keep history at all.

**Tentative landing**: start with **C** when this work is picked up — it's the smallest change and solves the specific motivation. If cold-load read costs prove painful (workload-dependent — depends on DO eviction frequency), revisit **A**. **B** stays a long-tail option for if/when temporal queries become a first-class capability beyond DAG sync.

**Verify before committing to A** (when/if we go there): bench actual mutation rate against expected storage growth, and confirm CF billing model is purely per-row, not per-byte, for SQL writes. The row cap is answered above.

### Applying and building a patch

`experiments/merge-patch-sql` answers [nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 14*'s question, whether SQLite's `json_patch` beats `applyMergePatch` where the server applies a patch. It ran deployed only, on 2026-11-15, on org trees from 10 to 10,000 nodes encoded as Resources would store them. Its [RESULTS.md](../../experiments/merge-patch-sql/RESULTS.md) has the tables.

- **`diff` stays in JavaScript.** SQLite has no diff, and both diffs built from JSON1 lost in every condition: by 1.2× at best, and by over a second on a change spread across a hundred nodes.
- **`json_patch` applies a narrow patch about twice as cheaply as JavaScript, 3.5× with the value stored as JSONB.** Moving one node in the 10,000-node tree cost 15 ms of CPU in SQL against 28 ms in JavaScript.
- **That lead is gone once the write needs the merged value back in JavaScript**, which validating or broadcasting it does. Reading it back with `RETURNING` and parsing it costs about what the JavaScript round trip does.
- **A wide patch is far slower in SQLite.** `json_patch` scans the target object once per patch key and moves the rest of the value in memory on each edit, so relabelling every node of the 10,000-node tree took 637 ms against JavaScript's 31 ms.
- **`diff` on a big tree is not free.** On the 10,000-node tree it costs about 36 ms of CPU, which Option C pays on every fanout of a tree that size.

### Does the tree want history?

Undecided (Larry, 2026-11-16), and not to be settled before this task is picked up.

- **What history would buy:** rolling back the clock, and one model for the whole system. Seeing the entire system as it was at a moment is easier to explain than a tree that is only ever current while everything under it keeps every version.
- **What people asked for in practice.** Larry built this twice before, as pure trees rather than a DAG, and users wanted to look at the past *through the window of now*, not through the window of the past. When a business unit was reparented to another division, the division's chart included the unit's history from before the move. A chart like that reads the current tree, so history would serve rollback and explanation, not aggregation.

### Option B with the tree's rows as resources

If the tree does keep history, Larry's refinement of Option B (2026-11-16) makes each node, edge and grant a resource of its own in `Snapshots`, instead of giving `Nodes`, `Edges` and `Permissions` their own `validFrom`/`validTo` columns. Checked against the code, it holds up for storage:

- **What it gets:** one history and one as-of read for the whole Star, the query engine over grants (every current `_OrgGrant` for a `sub`), ADR-016's one recorded-claims projection, and no divergence from Resources for a reader to ask about.
- **The types already have a home.** `PLATFORM_RESOURCE_TYPES` in `apps/nebula/src/ontology-compile.ts` adds `_`-prefixed types to every ontology version and already holds `_OrgNode`. `_OrgEdge` and `_OrgGrant` would join it.
- **A patch can come from the rows that changed.** For a client at moment t0 and a tree at t1, select the rows written in (t0, t1] and assemble them with `json_group_object`, so the cost follows the change rather than the tree. The tree's version becomes a moment, as a resource's is. A partial index on `validFrom` limited to the `_Org*` types costs other resources' writes nothing.
- **OrgTree's own synchronous methods write the rows, not `transaction()`.** `reparentNode` checks for a cycle and a duplicate sibling slug against the in-memory tree and writes in the same synchronous step. `transaction()` awaits the app's validator (`facet.parseBatch`) between its checks and its commit. Through it, with A and B both under root, one admin moves A under B while another moves B under A: each passes the cycle check before the await, both commit, and A and B form a loop cut off from root. The moves write different edge rows, so `ifValidFromMatches` sees no conflict. `#ensureRoot` already writes the tree's root row outside `transaction()`, and staying outside it keeps tree writes working on a host with no ontology installed, where `transaction()` fails closed.
- **SQLite can enforce some of the tree's rules on JSON fields, not all** (checked in SQLite 3.54, 2026-11-16):
  - A `UNIQUE` index on `(json_extract(value,'$.parent'), json_extract(value,'$.slug'))`, limited to current `_OrgEdge` rows, refused a second current edge with the same parent and slug. That makes sibling slugs unique by schema, but only if an edge row carries a copy of its child's slug, which today lives on the node.
  - No index can refuse a cycle.
  - A foreign key can't point at a JSON field or a partial index. It can point at `(resourceId, validFrom)`, but then a resource names one version of its node, and since no version is ever deleted, the key only checks that the version once existed.
- **So `Snapshots.nodeId`'s foreign key to `Nodes` goes.** Today's key only says a node was once created, since nodes are only soft-deleted, and `#requireNodeExists` already checks on every write that the node exists and isn't deleted. What is actually wanted is Snodgrass's temporal referential integrity, a resource valid only while its node is, which no SQL foreign key expresses. It is a check at write time.
- **What it still costs:**
  - Tree rows need a value in `ontologyVersion`, which is `NOT NULL`, even on a host with no ontology. A fixed platform value works, and a migration passes those rows through.
  - Rebuilding the permission cache on wake parses a stored value per row instead of reading columns. Unmeasured; measure it deployed at 10,000 nodes before choosing this.
  - The tree keeps its own push. A query subscription pushes only the ordered list of matching ids and fetches each row separately (`packages/resources/src/client-resources.ts`), which doesn't scale to a 10,000-row tree.

## DAG-specific sub-plan

### Server-side (Star)

1. Star tracks the encoded snapshot of `OrgTreeState` per ontology version (or computes lazily from the current normalized state). Snapshot ETag = content hash.
2. On every mutation: recompute the encoded snapshot, compute `diff(prev, new)` once.
3. Fanout: send `{ patch, fromETag, toETag }` to every subscribed client.
4. If a subscriber's known ETag doesn't match `prev`'s ETag → send a full snapshot instead.

**DAG normalization (shipped 2026-05-16, archive: [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md))** was the hard prerequisite for this work. Without it, the inline `parentIds[]` / `childIds[]` arrays would have forced whole-array replacement under merge-patch on every edge change — defeating the diff. With normalized `{ nodes, edges, permissions }`, adding a node is two key flips (one new node entry + one new edge entry), now that the encoding writes `OrgTreeState`'s Map and Set as objects.

### Client-side (NebulaClient)

1. Track `currentDagETag` per Star.
2. On receipt of `{ patch, fromETag, toETag }`: if `currentDagETag === fromETag`, apply, update.
3. Mismatch / apply error → request full snapshot resync.

### DAG failure modes

- **Missed patch** (subscriber's `fromETag` not matching server's most recent prev) → full snapshot.
- **Apply succeeds but ETag mismatch** → full snapshot, log telemetry (indicates a bug somewhere).
- **New subscription** → full snapshot is the first send.

### DAG test coverage

Extend `org-tree.test.ts` (or add `org-tree-sync.test.ts`):
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
2. If ETags differ: try to compute `diff(versionAt(knownETag), current)`. Return `{ patch, fromETag, toETag }`.
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

Independent of the patch-sync work but landing in the same cost-efficiency theme. Worth capturing here because the implementation reshapes the OrgTree class's read paths and conflicts conceptually with the diff-source-of-truth design — they should be decided together.

### Motivation

After Phase 3 (DAG normalization), every cold-path access to `OrgTree.requirePermission(...)` triggers `#buildState()`, which is a full-table scan of `Nodes`, `Edges`, and `Permissions` (~`N + E + P` row reads — ~2.5k rows for a 1k-node DAG). Under DO hibernation (10s idle → eviction), every wake-up pays this cost on the very first request.

But 99% of requests aren't DAG mutations — they're permission checks for normal resource operations. A permission check only needs to know "does `sub` have at least `tier` on `nodeId`?" — which is bounded by tree depth × upward fanout. For typical org trees (depth 3–6, fanout 1–2), that's 3–12 row reads — and usually fewer because the check short-circuits on a direct grant near the leaf.

**100–1000× fewer reads per cold-path permission check.** At scale (e.g., 10k Stars × 10 wake-ups/day × 2.5k reads each = 250M row-reads/day just from cold loads), this is real money.

### The proposal

Add a "cold mode" path that reads adjacency and grants from SQL on demand, used when `#_view` is null:

1. `OrgTree.requirePermission(nodeId, tier)`: if `#_view` exists, use the in-memory walk (current behavior). Otherwise, walk via per-node SQL.
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
interface OrgTreeReader {
  getDirectGrants(nodeId: number, sub: string): PermissionTier | null;
  getParents(nodeId: number): Iterable<number>;
}
```

- `InMemoryReader` wraps an `OrgTreeView`
- `SqlReader` wraps `DurableObjectState['storage']`

`resolvePermission(reader, sub, nodeId, tier)` and `getEffectivePermission(reader, sub, nodeId)` accept an `OrgTreeReader` instead of (or in addition to) `OrgTreeView`. The walking logic stays in one place.

`OrgTree.requirePermission()` picks: `reader = this.#_view ? new InMemoryReader(this.#_view) : new SqlReader(this.#ctx.storage)`.

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
- **Permissions-only DAG changes** — produce a tiny patch, `{"permissions":{"object":{"<nodeId>":{"object":{"<sub>":"admin"}}}}}`. [archive/structured-clone-patches-small-and-exact.md](../archive/structured-clone-patches-small-and-exact.md) § *Build notes* records the measured size.
- **Patch generation cost** — measured: `diff` costs about 36 ms of CPU on a 10,000-node tree (§ *Applying and building a patch*). A push could skip `diff` by writing its patch from the mutation itself, since a moved node is one edge key removed and one added, at the price of OrgTree knowing the encoding's shape. Raised while writing up 2026-11-16, not yet discussed.
- **Compression interaction** — WS `permessage-deflate` is on by default for `compatibility_date >= 2023-08-15` (verified via the workerd#4091 thread; Lumenize is at `2026-03-12`). Patches compress less aggressively than uniform snapshots; raw bytes matter slightly more here than for snapshots.

## Phasing when picked up

| Phase | Scope | Where |
|---|---|---|
| A | DAG-tree sync — server fanout + client apply + tests | `apps/nebula/src/{star,nebula-client}.ts`, baseline tests |
| B | Per-resource read sync — same primitives, different drivers | `packages/resources/src/snapshots.ts`, NebulaClient resources API |
| C | Perf verification — synthetic benchmarks for both paths | `apps/nebula/test/browser/` or a new bench dir |

Phase A depends on `tasks/archive/nebula-dag-normalize.md` shipping first. Phase B is independent of A and can ship in either order; co-shipping makes the most sense since the plumbing overlaps.

## References

- [tasks/archive/structured-clone-object-based-wire-format.md](../archive/structured-clone-object-based-wire-format.md) — design context for Phases 1+2 (the W4 wire format itself), shipped
- [tasks/archive/nebula-dag-normalize.md](../archive/nebula-dag-normalize.md) — Phase 3, prerequisite for the DAG half of this work
- [tasks/archive/nebula-frontend.md](../archive/nebula-frontend.md) — DAG-binding update strategies (Options 0–D); see Option D for the strategy this task implements
- [RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) — JSON Merge Patch
- [PR #11](https://github.com/lumenize/lumenize/pull/11) — W4 wire format ship

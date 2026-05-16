# Wire Merge-Patch Synchronization (DAG + Resources)

**Status**: On hold — post-demo
**Depends on**:
- W4 wire format + `diff` / `applyMergePatch` utilities — shipped in [PR #11](https://github.com/lumenize/lumenize/pull/11) (merge commit `260c242`)
- DAG normalization in [tasks/nebula-dag-normalize.md](../nebula-dag-normalize.md) (Phase 3 of the original wire-format task) — required for the DAG-tree half of this work, not for the per-resource half
**Related**: [tasks/nebula-frontend.md](../nebula-frontend.md) "DAG-binding update strategies" Options C and D — both became cheaper after W4 shipped.

## Goal

Use the W4 wire format + RFC 7396 (JSON Merge Patch) primitives to send per-mutation deltas over the wire, replacing full-snapshot sends. Two use cases:

1. **DAG-tree fanout sync** — every Star pushes its DAG to every connected client on every mutation. With 1k typical (10k worst-case) nodes per Star and many connected clients per Star, full-snapshot resends don't scale. Was the original motivating use case (Phase 4 of the wire-format task).
2. **Per-resource read sync** — when a client `read`s a resource it already has a snapshot for, server sends a patch from the last-known ETag instead of a full snapshot. Secondary use case but the plumbing largely overlaps.

Most plumbing is common; the DAG path adds a few specifics (per-Star fanout, snapshot ETag chain) that don't apply to the per-resource path.

## Why on hold (post-demo)

- The demo ships with **Option 0** for DAG (eTag-bump-and-pull per [tasks/nebula-frontend.md](../nebula-frontend.md)) and full-snapshot reads — both functional, just not bandwidth-optimal.
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

## DAG-specific sub-plan

### Server-side (Star)

1. Star tracks the W4-encoded snapshot of `DagTreeState` per ontology version (or computes lazily from the current normalized state). Snapshot ETag = content hash.
2. On every mutation: recompute the W4 snapshot, compute `patch = diff(prev, new)` once.
3. Fanout: send `{ patch, fromETag, toETag }` to every subscribed client.
4. If a subscriber's known ETag doesn't match `prev`'s ETag → send a full snapshot instead.

**Why DAG normalization (Phase 3) is a hard prerequisite**: without it, the in-memory state's inline `parentIds[]` / `childIds[]` arrays would force whole-array replacement under merge-patch on every edge change — defeating the diff. With normalized `{ nodes, edges, permissions }`, adding a node is two key flips (one new node entry + one new edge entry).

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

Phase A depends on `tasks/nebula-dag-normalize.md` shipping first. Phase B is independent of A and can ship in either order; co-shipping makes the most sense since the plumbing overlaps.

## References

- [tasks/archive/structured-clone-object-based-wire-format.md](../archive/structured-clone-object-based-wire-format.md) — design context for Phases 1+2 (the W4 wire format itself), shipped
- [tasks/nebula-dag-normalize.md](../nebula-dag-normalize.md) — Phase 3, prerequisite for the DAG half of this work
- [tasks/nebula-frontend.md](../nebula-frontend.md) — DAG-binding update strategies (Options 0–D); see Option D for the strategy this task implements
- [RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) — JSON Merge Patch
- [PR #11](https://github.com/lumenize/lumenize/pull/11) — W4 wire format ship

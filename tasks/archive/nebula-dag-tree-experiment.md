# DAG Tree SQL Performance Experiment (Phase 3.0)

**Status**: Complete (PASS)
**Location**: `experiments/dag-sql-perf/`
**Parent task**: `tasks/nebula-dag-tree.md` (Phase 3.1 uses conclusions from this experiment)

---

## Goal

Measure real-world latency of DAG operations using SQLite inside a Durable Object. If all operations complete in a few ms, use the simple SQL approach (Nodes + Edges tables with N+1 iterative queries) and skip CTE and in-memory alternatives.

**Why N+1 first**: For the hot path (permission resolution via ancestor climbing), N+1 has a nice property — the caller passes the required tier (`read`, `write`, or `admin`), and the BFS can early-exit as soon as it finds that tier or higher on any ancestor. With CTE you compute the full ancestor set first, then join. N+1 may be faster for the common case where a sufficient grant is found near the target node. Cloudflare's own SQLite docs say N+1 is efficient in DOs — same thread, no network hop. Additionally, DO SQLite has an in-memory write-through cache, so recently accessed rows (which Edges and Permissions will be on the hot path) won't even hit disk. And when they do, it's local SSD.

## Experiment Design

**Tree shape**: ~500 nodes, depth 0–7, handful of DAG edges (diamonds). Realistic for a mid-size organization. Branching factor ~3-4 at upper levels, tapering to 1-2. 3-5 diamond edges between mid-tree nodes (a child with 2+ parents) to exercise DAG ancestor climbing.

**Schema** (tentative — same tables we'd use in production):

```sql
-- INTEGER PRIMARY KEY = rowid alias. SQLite's most optimized storage path.
-- No WITHOUT ROWID needed — the integer PK *is* the rowid.
-- SQLite auto-assigns nodeId on INSERT (no counter needed).
CREATE TABLE Nodes (
  nodeId INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT 0
);

-- Edges is the single source of truth for all parent-child relationships.
-- No "primary parent" concept — in a DAG, there is no canonical path.
-- The client determines the normalized path based on navigation context.
CREATE TABLE Edges (
  parentNodeId INTEGER NOT NULL,
  childNodeId INTEGER NOT NULL,
  PRIMARY KEY (parentNodeId, childNodeId),
  FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
  FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- Reverse lookups: "who are my parents?" for ancestor climbing
CREATE INDEX idx_Edges_child ON Edges(childNodeId);

CREATE TABLE Permissions (
  nodeId INTEGER NOT NULL,
  sub TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('admin', 'write', 'read')),
  PRIMARY KEY (nodeId, sub),
  FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- "What nodes does this subject have permissions on?"
CREATE INDEX idx_Permissions_sub ON Permissions(sub);
```

**Foreign key enforcement**: D1 enables `PRAGMA foreign_keys = ON` by default. DO SQLite may or may not — the experiment should verify this. If not on by default, run `PRAGMA foreign_keys = ON` at schema creation time. Note: FK constraints have cascade implications (e.g., `ON DELETE CASCADE` for Edges/Permissions when a Node is deleted) that Phase 3.1 will need to resolve. For the Phase 3.0 experiment, the FK declarations above are sufficient — no deletes are measured.

**Operations to measure** (all via N+1 iterative JS loops with simple SQL queries):

| Operation | Description | Expected hot/cold |
|-----------|-------------|-------------------|
| `resolvePermission(sub, nodeId, requiredTier)` | Climb ancestors, check Permissions at each level, early-exit when required tier (or higher) is found | **Hot path** — every guarded call |
| `findAncestors(nodeId)` | Full ancestor set (BFS up via Edges) | Warm — used by cycle detection |
| `findDescendants(nodeId)` | Full descendant set (BFS down via Edges) | Warm — aggregations |
| `detectCycle(parentId, childId)` | Would adding this edge create a cycle? (climb from parent checking for child) | Cold — write path only |
| No-op baseline | WebSocket round-trip with no SQL | Baseline to subtract |

**Measurement methodology** (adapted from `experiments/call-delay/`):

1. Standalone experiment in `experiments/dag-sql-perf/`
2. Worker + DO that seeds the tree on setup, then accepts WebSocket commands for each measured operation
3. Run locally: `wrangler dev` in one terminal (starts local workerd/miniflare runtime with DO SQLite), Node.js test script in another terminal connects via WebSocket and measures wall-clock round-trip time (DO clock doesn't advance during synchronous execution)
4. Run each operation N times (e.g., 100) with interleaved noop pairing — each measured op is immediately preceded by a noop, and the paired difference isolates SQL processing time from moment-to-moment WebSocket variance. Report avg/p50/p95/max of the paired-adjusted timings.
5. Test against nodes at various depths (leaf at depth 7, mid-tree at depth 4)

**Decision gate**: If `resolvePermission` p95 < 5ms (after baseline subtraction), ship with N+1 SQL. Otherwise, consider CTE or in-memory alternatives.

**Why not measure CTE for comparison?** N+1 with early-exit reads fewer rows on average for the hot-path permission check — it stops as soon as a sufficient grant is found on any ancestor. A CTE computes the full ancestor set first, then joins against Permissions. Cloudflare bills per rows read and written, so N+1 is likely cheaper even if CTE is faster in wall-clock time. If N+1 is fast enough, we ship it. CTE remains available as an optimization if performance degrades at scale.

## Deliverables

- [x] `experiments/dag-sql-perf/` with working experiment
- [x] Results table in this file (fill in after running)
- [x] Go/no-go decision on SQL approach

## Results

**Decision gate: PASS** — ship with N+1 SQL.

Worst-case `resolvePermission` p95 is **0.19ms** (adjusted), **26x under** the 5ms threshold. Run locally with miniflare, 500 nodes, 100 iterations per operation, interleaved noop baseline subtraction.

| Operation | Adjusted p95 | Adjusted avg | Notes |
|-----------|-------------|-------------|-------|
| resolvePermission (direct grant) | 0.19ms | 0.05ms | 0 hops — grant on target node |
| resolvePermission (diamond DAG) | 0.08ms | 0.04ms | Grant at depth 3 via DAG edge |
| resolvePermission (depth 7→2) | 0.18ms | 0.05ms | Full climb (no requiredTier early-exit) |
| resolvePermission (depth 7→root) | 0.17ms | 0.05ms | Admin on root, climb all 7 levels |
| resolvePermission (no access) | 0.08ms | 0.05ms | No grant anywhere, full climb |
| findAncestors (depth 4) | 0.06ms | 0.02ms | |
| findAncestors (depth 7) | 0.10ms | 0.03ms | |
| findDescendants (depth 2 subtree) | 0.27ms | 0.15ms | |
| findDescendants (root, all 499) | 2.15ms | 1.20ms | Full tree walk — see caching note below |
| detectCycle (safe edge) | 0.08ms | 0.01ms | |
| detectCycle (would create cycle) | 0.11ms | 0.03ms | Full ancestor climb |
| noop (baseline) | — | 0.18ms | WebSocket round-trip, no SQL |

**FK pragma**: DO SQLite defaults to `PRAGMA foreign_keys = ON`. Enforcement verified — invalid FK INSERT is rejected.

**Note on the experiment implementation**: The experiment's `resolvePermission` uses a 2-argument signature (no `requiredTier` parameter) that only early-exits on `admin`. For `write` or `read` grants it walks the full ancestor set. This makes the measured latencies an upper bound — production code with `requiredTier` early-exit will be equal or faster.

**In-memory `DagTreeState` cache**: The primary motivation is **subscription fan-out** — every connected user subscribes to the Star's state (at minimum every 15 minutes due to access token TTL). Without a cache, every `getState()` call would run 3 SQL queries (all Nodes, all Edges, all Permissions). With the cache, `getState()` returns a shared in-memory reference and serialization creates per-subscriber copies — zero SQL, zero row-read billing per subscriber.

**Note on Phase 3.0 N+1 results**: The N+1 query measurements above (`resolvePermission`, `findAncestors`, etc.) confirmed the schema and data model work, but they're largely moot in practice — with the cache in place, all read-path operations come from in-memory Maps, not SQL. The write path uses simple single-row INSERT/UPDATE/DELETE (not N+1 ancestor climbing). The cache idea originally surfaced from the `findDescendants(root)` result, but the real justification is subscription fan-out, not speeding up individual queries.

Solution: cache the full tree structure **with permissions** in a **lazily-populated instance variable**. This is a safe exception to the "no mutable instance variables" rule because:
- **Subscription fan-out is the hot path**: Every subscriber gets `DagTreeState` from the cache. No per-subscriber SQL.
- On heavily loaded systems, the DO stays warm and the cache survives across requests — the common case is a cache hit.
- On lightly loaded systems that hibernate frequently, recalculating on wake is infrequent and acceptable. (The cache is actually more expensive here — it rebuilds on wake even if no subscribers are connected yet — but lazily, so only on first access.)
- When the DAG tree is modified (node/edge add/remove), invalidate the cache, recalculate, and notify all subscribers of the updated state.
- As a secondary benefit, permission lookups and traversal also use the cache — since it's there for subscription, we may as well use it for everything.

**Cache memory cost** (measured with `--expose-gc`, 500 nodes, 5 permission grants):

| Metric | Value |
|--------|-------|
| JSON wire size | 20.7 KB |
| V8 heap delta | 44.4 KB |
| % of 128 MB DO limit | 0.034% |

At this scale, the cache is negligible. Even a 50,000-node tree (100x) would use ~4.4 MB (~3.4% of the 128 MB limit), leaving ample room for other DO state.

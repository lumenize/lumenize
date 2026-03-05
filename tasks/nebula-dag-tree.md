# DAG Tree Access Control

**Phases**: 3.0 (experiment), 3.1 (implementation), 3.x (follow-on)
**Status**: Phase 3.0 complete (PASS) — ready for Phase 3.1
**Location**: `apps/nebula/` (Star DO)
**Depends on**: Phase 2.1 (Test Structure Refactor)
**Master task file**: `tasks/nebula.md`

## Goal

Add a DAG tree inside each Star DO. The nebula-auth hierarchy (`universe.galaxy.star`) goes **up** from Star. The DAG tree goes **down** from Star's root node to organize resources and control access. Every resource attaches to exactly one node. Permissions (admin, write, read) roll down through the tree — a node is accessible if **any** ancestor path grants the required permission.

Resource paths take the form:
```
universe.galaxy.star/resources/level-1-slug/.../level-n-slug
```

Replace Phase 2's dummy methods and simple guards with DAG-aware access control.

## Architecture

```
nebula-auth hierarchy (UP)          Star DO (pivot)              DAG tree (DOWN)
                                    ┌──────────────────┐
  Universe                          │ Star             │          root
    └─ Galaxy                       │                  │         /    \
         └─ Star  ─────────────────▶│  SQLite tables:  │        A      B
                                    │  Nodes, Edges,   │         \    /
  Identity layer:                   │  Permissions     │           C
  JWT sub, email, aud,              │                  │          / \
  access.authScopePattern           │  Guards check    │         D   E
                                    │  DAG permissions │
                                    └──────────────────┘
```

- **Star is the pivot**: It owns the DAG tree in its SQLite storage. Each Star instance has exactly one tree.
- **Nodes have slugs**: URL-safe short names used in resource paths.
- **Root node**: Created automatically when the Star is first accessed. All other nodes descend from it.

## Prior Art

### Blueprint repo (`transformation-dev/blueprint`)

The real DAG tree implementation. Saved locally in `tasks/reference/blueprint/`.

**Server-side** (`tasks/reference/blueprint/`):
- **`tree.js`** (~560 lines): Full DAG tree DO with nodes, edges, cycle detection, temporal versioning.
  - Data model: `nodes` object (incrementing integer IDs → `{ label, nodeIDString }`), `edges` adjacency list (parent → children array), derived `reverseEdges` (child → parents array).
  - `node.label` values are the slugs — URL-safe short names used in paths.
  - `deriveTree()` calls `separateTreeAndDeleted()` server-side to produce the nested `{ id, label, children }` tree. Derived tree is cached in `this.tree`, invalidated on every structural mutation. Full re-derivation on each change (no incremental).
  - Cycle detection: `recurseThrowIfIDInAncestry()` walks up via reverse edges, throws 409 if path forms a cycle. ~20 lines of code.
  - Operations: `addNode`, `addBranch` (idempotent), `deleteBranch` (idempotent), `moveBranch` (delete + add with cycle check).
  - Uses Cloudflare KV storage with temporal snapshots — we'll use SQLite instead.
  - **No permissions** — that's entirely new for Phase 3.
- **`tree.test.js`**: 14 tests covering tree creation, node addition, cycle rejection, diamond DAGs, branch operations, idempotency, conditional requests. Several TODOs (move-cycle, deleted nodes, orphaned nodes).
- **`temporal-entity.js`**: Snodgrass-style temporal versioning base class. **Primary reference for Phase 5 (Resources)**. See `tasks/nebula.md` Phase 5 notes.
- **`temporal-mixin.js`**: Shared temporal utilities (validFrom calculation, If-Modified-Since).

**Client-side UI** (`tasks/reference/blueprint/ui/`):
- **`SearchableTreePanel.svelte`**: Main tree navigator. Receives derived tree from server, clones it, manages expand/collapse/search state. Calls `stitchParents(tree, null)` to add `node.parents` arrays (plural — DAG-aware) for upward traversal during search highlighting.
- **`TreeNode.svelte`**: Recursive tree node renderer. Builds the breadcrumbs path by accumulating `parentBreadcrumbsArray` as a prop through each recursive level. In a DAG, the same node appears in multiple visual positions — clicking it in different positions yields different breadcrumb paths. The **navigation path determines the normalized path**, not a canonical primary parent.
- **`BreadcrumbsPanel.svelte`**: Renders breadcrumb trail. "Go up one level" is `breadcrumbsArray.slice(0, indexOf(node) + 1)`. The parent's `children` array gives siblings — this is the foundation for **peer comparisons** (go up, find siblings = comparison set for analysis).
- **`stores.js`**: `authorizedTreeStore` (writable), demo tree data.
- **Key insight**: Blueprint used numeric IDs for internal lookups and `node.label` (slugs) for display/search. No slug-based URL routing was implemented — tree selection was stored in a Svelte writable store. Normalized paths and peer comparisons were implicit in the breadcrumb/children structure but not explicitly coded as features.

## Access Control Model

### Permission Tiers

Three tiers, each subsumes the one below:

| Tier | Can Do |
|-------|--------|
| **admin** | Grant/revoke permissions, plus everything write can do |
| **write** | Create/update/delete resources, plus everything read can do |
| **read** | Read resources and subscribe to updates |

### DAG Tree Properties

- Every resource attaches to **exactly one** node in the tree
- The tree is a **DAG** (directed acyclic graph) — a node may have multiple parents, so the same node can be reached via multiple paths
- Permissions are granted **per-node, per-subject**
- Permissions **roll down**: granting `write` on a node grants `write` on all descendants
- **Any-path grant**: If a subject can reach a node via any path where an ancestor grants the required permission, access is granted. (The subject doesn't need permission on all paths — just one.)
- Higher permissions subsume lower: `admin` implies `write` implies `read`

### How It Bridges Auth and Resources

```
nebula-auth (identity)               DAG tree (authorization)         Resources (data)
┌───────────────────────┐           ┌───────────────────┐             ┌───────────────┐
│ Who is this?          │           │ What can they do? │             │ Can they do   │
│ JWT: sub, email,      │──────────▶│ Node permissions  │────────────▶│ this specific │
│ role, authScopePattern│           │ Ancestor rolldown │             │ operation?    │
└───────────────────────┘           └───────────────────┘             └───────────────┘
```

- **Phase 2** established: JWT identity → `onBeforeCall` → `callContext.originAuth` (sub, claims including email, authScopePattern, etc.)
- **Phase 3** adds: guard queries DAG tables directly using `sub` from `callContext.originAuth` — no permission caching, always fresh from SQLite
- **Phase 5** will add: guard decision → resource operation (upsert/delete/read/subscribe)

### Permission Resolution Algorithm

Given a subject and a target node, determine the effective permission:

1. Find all ancestor paths from the target node to any root
2. For each node along any path, check if the subject has a direct permission grant
3. The effective permission is the **highest** permission found on any ancestor (including the node itself)
4. If no permission is found on any path, access is denied

```
Example tree:
    root
   /    \
  A      B
   \    /
     C       ← resource attached here
     |
     D

Subject has: write on A, read on B

Accessing C:
  Path 1: root → A → C → subject has "write" on A → effective: write
  Path 2: root → B → C → subject has "read" on B → effective: read
  Result: write (highest from any path)

Accessing D:
  Path 1: root → A → C → D → subject has "write" on A → rolls down → effective: write
  Result: write
```

---

## Phase 3.0: SQL Performance Experiment

**Goal**: Measure real-world latency of DAG operations using SQLite inside a Durable Object. If all operations complete in a few ms, use the simple SQL approach (Nodes + Edges tables with N+1 iterative queries) and skip CTE and in-memory alternatives.

**Why N+1 first**: For the hot path (permission resolution via ancestor climbing), N+1 has a nice property — the caller passes the required tier (`read`, `write`, or `admin`), and the BFS can early-exit as soon as it finds that tier or higher on any ancestor. With CTE you compute the full ancestor set first, then join. N+1 may be faster for the common case where a sufficient grant is found near the target node. Cloudflare's own SQLite docs say N+1 is efficient in DOs — same thread, no network hop. Additionally, DO SQLite has an in-memory write-through cache, so recently accessed rows (which Edges and Permissions will be on the hot path) won't even hit disk. And when they do, it's local SSD.

### Experiment Design

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

### Deliverables

- [x] `experiments/dag-sql-perf/` with working experiment
- [x] Results table in this file (fill in after running)
- [x] Go/no-go decision on SQL approach

### Results

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

**In-memory tree+permissions cache**: `findDescendants(root)` at ~2ms p95 is the slowest operation, and it's not just for aggregations — every user connection triggers a full-tree subscription (at least every 15 minutes due to access token TTL). Additionally, Cloudflare bills per row read, so avoiding repeated full-table scans is worth doing when it's easy. Solution: cache the full tree structure **with permissions** in a **lazily-populated instance variable**. This is a safe exception to the "no mutable instance variables" rule because:
- On heavily loaded systems, the DO stays warm and the cache survives across requests — the common case is a cache hit.
- On lightly loaded systems that hibernate frequently, recalculating on wake is infrequent and ~2ms is acceptable.
- When the DAG tree is modified (node/edge add/remove), invalidate the cache, recalculate, and notify all subscribers (active WebSocket connections) of the updated tree structure.
- Permission lookups can use the in-memory cache instead of N+1 SQL queries, eliminating row-read billing on the hot path entirely.
- When sending the tree to subscribers, strip permissions via an in-memory recursive pass with visited-set detection (fast for DAGs).

**Cache memory cost** (measured with `--expose-gc`, 500 nodes, 5 permission grants):

| Metric | Value |
|--------|-------|
| JSON wire size | 20.7 KB |
| V8 heap delta | 44.4 KB |
| % of 128 MB DO limit | 0.034% |

At this scale, the cache is negligible. Even a 50,000-node tree (100x) would use ~4.4 MB (~3.4% of the 128 MB limit), leaving ample room for other DO state. The cache structure holds the nested tree (`{ nodeId, slug, children[] }`) plus per-node permission maps (`nodeId → { sub → tier }`).

---

## Phase 3.1: Implementation

**Depends on**: Phase 3.0 results (confirming SQL approach)

### `DagTree` Class

Encapsulates all DAG tree operations in a standalone class at `apps/nebula/src/dag-tree.ts`.

**Instantiation**: Star creates `DagTree` in its `onStart` lifecycle hook (wrapped in `blockConcurrencyWhile` by the mesh framework). No DO subclass should define its own constructor — `onStart` is the initialization point.

```typescript
class DagTree {
  #sql: SqlStorage
  #cache: TreeCache | null = null
  #getCallContext: () => CallContext
  #onTreeChanged: () => void

  constructor(sql: SqlStorage, getCallContext: () => CallContext, onTreeChanged: () => void) {
    this.#sql = sql
    this.#getCallContext = getCallContext
    this.#onTreeChanged = onTreeChanged
    this.#createSchema()   // CREATE TABLE IF NOT EXISTS
    this.#ensureRoot()     // INSERT OR IGNORE root node
  }
}
```

- `SqlStorage` is the real `ctx.storage.sql` — no mocks, no abstractions
- Constructor creates tables and ensures root node exists (all synchronous SQL)
- `getCallContext` is a getter function that returns the current `CallContext` — Star passes `() => this.lmz.callContext`. Evaluated lazily at call time (not construction time), so the ALS-backed context is always fresh. Also makes unit testing trivial — pass a mock getter instead.
- `onTreeChanged` callback lets Star manage subscriber notification (placeholder in Phase 3.1, full fan-out in Phase 5)

**Caller identity via `getCallContext`**: DagTree calls the injected getter to read `sub` and `claims.access.admin` (Star-level admin flag). No direct dependency on mesh internals — the getter is the only coupling point.

```typescript
#callerInfo(): { sub: string; isStarAdmin: boolean } {
  const ctx = this.#getCallContext();
  const claims = ctx.originAuth?.claims as NebulaJwtPayload;
  return {
    sub: ctx.originAuth!.sub,
    isStarAdmin: !!claims?.access?.admin,
  };
}
```

**Lazy cache**: A private getter builds the cache on first access. All reads go through the cache. All mutations write to SQL, then set `#cache = null`, then call `#onTreeChanged()`.

```typescript
get #tree(): TreeCache {
  if (!this.#cache) {
    this.#cache = this.#buildCache()  // 3 SQL queries: all Nodes, all Edges, all Permissions
  }
  return this.#cache
}
```

**Cache structure** (from Phase 3.0 experiment — 44 KB for 500 nodes, 0.034% of 128 MB limit):
- Nested tree: `{ nodeId, slug, children[] }` with `separateTreeAndDeleted` applied — deleted nodes in a phantom "Deleted" branch, orphaned nodes in a phantom "Orphaned" branch (following blueprint's pattern)
- Flat node map: `Map<nodeId, { slug, deleted, parentIds[], childIds[] }>` — for ancestor/descendant traversal
- Per-node permissions: `Map<nodeId, Map<sub, tier>>` — for `resolvePermission` lookups

**Read path**: `resolvePermission`, `getTree`, `getEffectivePermission`, `getNodeAncestors`, `getNodeDescendants` all operate on the in-memory cache. Zero SQL queries, zero row-read billing.

**Write path**: `createNode`, `addEdge`, `removeEdge`, `reparentNode`, `grantPermission`, `revokePermission`, etc. write to SQL (source of truth), then invalidate cache + call `onTreeChanged`. Cycle detection runs against the cache (fast in-memory BFS).

### SQL Schema

Owned by `DagTree` — tables are created in the constructor via `CREATE TABLE IF NOT EXISTS`. Same schema validated in Phase 3.0 experiment. Confirmed: FK enforcement is ON by default in DO SQLite.

**Root node**: Inserted via `INSERT OR IGNORE` after schema creation. Gets `nodeId = 1` (first INSERT into empty table), `slug = 'root'`. The root slug is never shown in URLs or UI — resource paths start at root's children: `universe.galaxy.star/resources/level-1-slug/.../level-n-slug`.

### Slug Uniqueness

Slugs are properties of nodes. Uniqueness is enforced **per-parent** — no two children of the same parent may share a slug. In a DAG, a node can appear under multiple parents, so slug uniqueness must be checked in all relevant parent contexts.

Enforcement points (all in DagTree code, not SQL constraints, since the check spans Nodes + Edges):

| Operation | Check |
|-----------|-------|
| `createNode(parentNodeId, slug)` | No existing child of `parentNodeId` has this slug |
| `addEdge(parentNodeId, childNodeId)` | No existing child of `parentNodeId` has the same slug as `childNodeId` |
| `reparentNode(childNodeId, oldParentId, newParentId)` | No existing child of `newParentId` has the same slug as `childNodeId` |
| `renameNode(nodeId, newSlug)` | For *every* parent of `nodeId`, no other child of that parent has `newSlug` |

### Soft Delete

Following blueprint's `separateTreeAndDeleted` pattern:

- `deleteNode(nodeId)` sets `deleted = 1` — does NOT remove edges or permissions
- Deleted nodes are excluded from permission resolution (ancestor climbing skips deleted nodes)
- `getTree()` places deleted nodes in a phantom "Deleted" branch under root, orphaned nodes (unreachable from root via non-deleted ancestors) in a phantom "Orphaned" branch
- `undeleteNode(nodeId)` sets `deleted = 0` — node reappears with edges and permissions intact

### Cycle Detection

Port from blueprint's `tree.js` (lines 128–146). The algorithm:

1. On `addEdge(parent, child)` or `reparentNode`: verify that `parent` is not a descendant of `child`
2. Walk the in-memory cache (flat node map's `parentIds`) — BFS up from `parent`
3. If `child` is found in the ancestry, throw — adding this edge would create a cycle
4. Write-time check only — reads don't need it

Blueprint's implementation is ~20 lines of recursive JS. Our version uses the in-memory cache instead of querying SQL, making it even faster.

### Authorization Model

**Two independent layers** — Phase 2's `requireAdmin` and Phase 3.1's DAG permissions operate at different scopes:

| Layer | Question | Mechanism | Scope |
|-------|----------|-----------|-------|
| Scope binding | Is this call for the right Star? | `NebulaDO.onBeforeCall()` (Phase 2) | DO instance |
| Star admin | Is this person a Star-level admin? | `@mesh(requireAdmin)` via JWT `claims.access.admin` (Phase 2) | Entire Star |
| DAG permissions | Can this person do X on this node? | DagTree checks + throws (Phase 3.1) | Per-node |

**Star admin bypasses DAG checks**: If the caller's JWT has `claims.access.admin = true` (Star-level admin, possibly via `authScopePattern` rolldown from universe/galaxy), all DAG permission checks are skipped. This is the bootstrap mechanism — Star admins can build the tree and delegate without needing explicit DAG grants.

**DagTree checks and throws**: No `@mesh(guard)` decorators for DAG authorization. Star methods are thin `@mesh()` wrappers that delegate to DagTree. DagTree reads caller identity via the injected `getCallContext` getter, checks permissions internally, and throws if denied. Errors propagate back to the caller via mesh's error transport (`{ $error: ... }` envelope).

### `DagTree` Public API

DagTree reads caller identity via the injected `getCallContext` getter — Star methods are thin `@mesh()` wrappers that delegate to DagTree without passing caller info.

**Tree structure mutations** (require `write` on the relevant node, or Star admin):

| Method | Signature | Permission check |
|--------|-----------|-----------------|
| `createNode` | `(parentNodeId, slug)` | write on `parentNodeId` |
| `addEdge` | `(parentNodeId, childNodeId)` | write on `parentNodeId` |
| `removeEdge` | `(parentNodeId, childNodeId)` | write on `parentNodeId` |
| `reparentNode` | `(childNodeId, oldParentId, newParentId)` | write on `childNodeId`, `oldParentId`, AND `newParentId` |
| `deleteNode` | `(nodeId)` | write on `nodeId` |
| `undeleteNode` | `(nodeId)` | write on `nodeId` |
| `renameNode` | `(nodeId, newSlug)` | write on `nodeId` |

**Permission management** (require `admin` on the target node, or Star admin):

| Method | Signature | Permission check |
|--------|-----------|-----------------|
| `grantPermission` | `(nodeId, targetSub, level)` | admin on `nodeId` |
| `revokePermission` | `(nodeId, targetSub)` | admin on `nodeId` |

**Read-only queries** (from in-memory cache, no authorization):

| Method | Signature | Notes |
|--------|-----------|-------|
| `resolvePermission` | `(sub, nodeId, requiredTier)` → `boolean` | Hot path — used by Star to guard resource operations in Phase 5 |
| `getEffectivePermission` | `(sub, nodeId)` → `tier \| null` | For UI — called when user expands a node to show their permission level |
| `getTree` | `()` → nested structure | Same for all callers — no permissions included |
| `getNodeAncestors` | `(nodeId)` → `Set<number>` | |
| `getNodeDescendants` | `(nodeId)` → `Set<number>` | |

### Star DO Integration

```typescript
export class Star extends NebulaDO {
  #dagTree!: DagTree

  async onStart() {
    this.#dagTree = new DagTree(
      this.ctx.storage.sql,
      () => this.lmz.callContext,   // lazy — evaluated at call time, not construction time
      () => this.#onTreeChanged()
    )
  }

  get dagTree(): DagTree { return this.#dagTree }

  // Thin @mesh() wrappers — DagTree reads callContext directly
  @mesh()
  createNode(parentNodeId: number, slug: string) {
    return this.#dagTree.createNode(parentNodeId, slug)
  }

  @mesh()
  grantPermission(nodeId: number, targetSub: string, level: 'admin' | 'write' | 'read') {
    return this.#dagTree.grantPermission(nodeId, targetSub, level)
  }

  @mesh()
  getTree() {
    return this.#dagTree.getTree()
  }

  // ... other thin wrappers for addEdge, removeEdge, reparentNode,
  //     deleteNode, undeleteNode, renameNode, revokePermission,
  //     resolvePermission, getEffectivePermission,
  //     getNodeAncestors, getNodeDescendants

  #onTreeChanged() {
    // Phase 3.1: placeholder — tests verify this callback fires on mutations
    // Phase 5: subscription fan-out via lmz.call() through NebulaClientGateway
    // See tasks/nebula-scratchpad.md for subscription design notes
  }
}
```

### Bootstrap Flow

1. Star's `onStart` creates schema + root node (nodeId 1, slug 'root')
2. First authenticated call comes from a Star admin (JWT `claims.access.admin = true`)
3. Star admin creates nodes, grants permissions — all pass because Star admin bypasses DAG checks
4. Star admin grants `admin` on specific subtrees to delegation subjects via `grantPermission`
5. Delegated admins can grant/revoke permissions within their subtrees
6. Users with `write` can create/modify nodes within their authorized subtrees

No auto-grant on root needed. The JWT Star admin flag *is* the bootstrap mechanism.

### Test Plan

Tests live in the existing `test/test-apps/baseline/` test-app. A new `dag-tree.test.ts` file tests DagTree through `StarTest`, getting real DO SQLite storage via the existing `instrumentDOProject` setup.

**`NebulaClientTest` additions**: New helper methods following the existing pattern (e.g., `callStarCreateNode`, `callStarGrantPermission`, `callStarGetTree`).

**DagTree tests** (`dag-tree.test.ts`):
- Schema creation: tables exist after `onStart`, FK enforcement on
- Root node: exists with nodeId 1, slug 'root'
- Tree construction: create nodes, add edges, verify structure via `getTree()`
- Cycle detection: reject cycles, allow diamonds
- Slug uniqueness: reject duplicate slugs under same parent, allow same slug under different parents
- Soft delete: `deleteNode` sets flag, `undeleteNode` restores, `getTree()` shows deleted/orphaned branches
- Permission CRUD: `grantPermission`, `revokePermission`, verify via `resolvePermission` and `getEffectivePermission`
- Permission rolldown: grant on root → all descendants, grant on middle → descendants only, multiple paths → highest wins
- Permission boundaries: no grant on any ancestor → denied, grant on one path → granted (any-path rule), revoke → descendants lose access
- Authorization enforcement: write on parent → can create child, no write → throws, Star admin → bypasses DAG checks
- Permission management auth: admin on node → can grant/revoke, write on node → cannot grant (throws)
- Cache behavior: mutations invalidate cache, next read rebuilds from SQL, `onTreeChanged` callback fires on mutations

**Star DO integration tests** (in existing `dag-tree.test.ts` or separate `star-dag-integration.test.ts`):
- Layer coexistence: `@mesh(requireAdmin)` (JWT Star admin) and DagTree authorization (DAG write/admin) operate independently
- Auth identity flow: universe admin (wildcard JWT) → Star admin → full DAG access, regular user → only DAG-granted access
- Abuse cases: permission escalation attempt → throws, deleted node mutation → throws

---

## Phase 3.x: Follow-On Work

### Additional Operations

- `getNodeByPath(slugPath)` — resolve `level-1-slug/.../level-n-slug` to a nodeId by walking Edges from root, matching slugs at each level
- `getSubtreePermissions(nodeId, sub)` — summary of what a subject can access in a subtree
- Bulk operations for tree setup (import/export)

### UI Support (Server-Side)

The server needs to support these client-side patterns (see blueprint UI reference in `tasks/reference/blueprint/ui/`):

- **Normalized paths**: The client determines the normalized path based on which visual position the user clicked in the tree (the breadcrumbs array). A DAG node appears in multiple positions; each click yields a different path. The server doesn't need to choose a canonical path — the client handles this.
- **Peer comparisons**: Given a breadcrumbs path, the client goes up one level (`path.slice(0, -1)`) and uses `parent.children` to find siblings. This is the comparison set for analysis/aggregations. The server's `getTree()` response already provides the structure needed.
- **`stitchParents`**: The client adds `node.parents` arrays (plural, DAG-aware) for upward traversal during search highlighting. The server sends only `children` pointers — parent stitching is client-side.

### Subscription Fan-Out (Phase 5)

Tree mutation notifications delivered to subscribers via `lmz.call()` through `NebulaClientGateway`. See `tasks/nebula-scratchpad.md` for design notes on subscription shape and subscriber tracking.

### Additional Tests

- Integration with Resources (Phase 5) — real resource CRUD gated by DAG permissions
- Performance regression tests — ensure permission resolution stays fast as tree grows
- Edge cases: very deep trees (depth 10), wide trees (100+ children), dense DAGs (many diamonds)

### Optimization (if needed)

- **HMAC capability ticket short-circuit** (Phase 5.5): When a user presents a valid HMAC ticket for a resource, skip the DAG walk entirely — the ticket is proof that Star already authorized this sub + resource + tier. First check in the guard chain, zero SQL. Especially valuable for repeated access to the same resource and for subscribe (ticket validates once, WebSocket stays open). See `tasks/nebula.md` Phase 5.5.
- Materialized closure table for ancestor queries (only if in-memory cache proves insufficient at scale)

---

## What Gets Replaced Later

- **Dummy methods from Phase 2**: Fully removed, replaced by real resource methods in Phase 5
- **`#onTreeChanged` placeholder**: Replaced by subscription fan-out in Phase 5
- **Some tests**: Replaced by integrated Resources + DAG tests in Phase 5

**What survives**: The `DagTree` class (schema, cycle detection, permission resolution, in-memory cache), Star DO integration (`onStart`, thin `@mesh()` wrappers), and the core test scenarios for tree construction and permission rolldown.

## Success Criteria

### Phase 3.0
- [x] `experiments/dag-sql-perf/` with working experiment
- [x] Latency results for all operations at various tree depths
- [x] Go/no-go decision documented

### Phase 3.1
- [ ] `DagTree` class at `apps/nebula/src/dag-tree.ts` with lazy in-memory cache
- [ ] DAG tree schema in Star's SQLite (Nodes, Edges, Permissions tables) with root node auto-created
- [ ] Tree mutations: `createNode`, `addEdge`, `removeEdge`, `reparentNode`, `deleteNode`, `undeleteNode`, `renameNode`
- [ ] Cycle detection on `addEdge` and `reparentNode`
- [ ] Slug uniqueness enforced per-parent on all relevant operations
- [ ] Soft delete with phantom Deleted/Orphaned branches in `getTree()`
- [ ] Permission grant/revoke (admin-only on target node via DAG or Star admin)
- [ ] Permission resolution: ancestor rolldown with any-path-grants semantics (from cache)
- [ ] Authorization: DagTree reads caller identity via injected `getCallContext` getter, checks permissions, throws if denied; Star admin bypasses DAG checks
- [ ] Star DO integration: `DagTree` in `onStart`, thin `@mesh()` wrappers, `onTreeChanged` placeholder callback
- [ ] Tests in existing `test/test-apps/baseline/`: DagTree operations, authorization enforcement, abuse cases
- [ ] Bootstrap flow verified: Star admin (JWT) → build tree → delegate via `grantPermission`

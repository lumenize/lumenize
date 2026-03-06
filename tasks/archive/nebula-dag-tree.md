# DAG Tree Access Control

**Phases**: 3.1 (implementation — COMPLETE), 3.2 (cleanup — COMPLETE). Phase 3.0 (experiment) archived at `tasks/archive/nebula-dag-tree-experiment.md`.
**Status**: Phase 3.2 Complete
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

## Phase 3.0: SQL Performance Experiment — COMPLETE

**Full details**: `tasks/archive/nebula-dag-tree-experiment.md`

**Conclusions** (used by Phase 3.1):
- **Schema confirmed**: Nodes (INTEGER PK), Edges (compound PK, WITHOUT ROWID), Permissions (compound PK, WITHOUT ROWID) with indexes on `Edges(childNodeId)` and `Permissions(sub)`. FK enforcement is ON by default in DO SQLite.
- **In-memory cache justified**: The primary motivation is subscription fan-out — every connected user subscribes to `DagTreeState`. The cache avoids per-subscriber SQL (3 queries per `getState()` call). N+1 query performance was measured and is fine (p95 < 0.2ms for 500 nodes), but moot in practice since the cache serves all reads. Cache cost: 44 KB heap for 500 nodes (0.034% of 128 MB DO limit).
- **Cache is a safe exception to "no mutable instance variables"**: Lazily populated, subscription fan-out is the hot path, lightly loaded DOs rebuild infrequently on wake. Permission checks and traversal also use it as a secondary benefit.

---

## Phase 3.1: Implementation

### `DagTree` Class

Encapsulates all DAG tree operations in a standalone class at `apps/nebula/src/dag-tree.ts`.

**Instantiation**: Star creates `DagTree` in its `onStart` lifecycle hook (wrapped in `blockConcurrencyWhile` by the mesh framework). No DO subclass should define its own constructor — `onStart` is the initialization point.

```typescript
class DagTree {
  #ctx: DurableObjectState
  #_cached: DagTreeState | null = null
  #getCallContext: () => CallContext
  #onChanged: () => void

  constructor(ctx: DurableObjectState, getCallContext: () => CallContext, onChanged: () => void) {
    this.#ctx = ctx
    this.#getCallContext = getCallContext
    this.#onChanged = onChanged
    this.#createSchema()   // CREATE TABLE IF NOT EXISTS
    this.#ensureRoot()     // INSERT OR IGNORE root node
  }
}
```

- `ctx` is `DurableObjectState` (i.e., `this.ctx` from the DO) — DagTree accesses `ctx.storage.sql` internally
- Constructor creates tables and ensures root node exists (all synchronous SQL)
- `getCallContext` is a getter function that returns the current `CallContext` — Star passes `() => this.lmz.callContext`. Evaluated lazily at call time (not construction time), so the ALS-backed context is always fresh. Also makes unit testing trivial — pass a mock getter instead.
- `onChanged` callback lets Star manage subscriber notification (placeholder in Phase 3.1, full fan-out in Phase 5)

**`PermissionTier` type**: Exported from `dag-tree.ts` for use by Star and tests:

```typescript
export type PermissionTier = 'admin' | 'write' | 'read'
```

**Authorization helper — `#requirePermission`**: Combines identity extraction, Star admin bypass, DAG permission check, and throw into a single call. Returns `sub` for methods that need it beyond the guard. No direct dependency on mesh internals — `getCallContext` is the only coupling point.

```typescript
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

#requirePermission(nodeId: number, tier: PermissionTier): string {
  const cc = this.#getCallContext();
  const sub = cc.originAuth?.sub;
  if (!sub) throw new Error('Authentication required');
  const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined;
  if (claims?.access?.admin) return sub;  // Star admin bypass
  if (!resolvePermission(this.#cached, sub, nodeId, tier)) {
    throw new Error(`${tier} permission required on node ${nodeId}`);
  }
  return sub;
}
```

Mutations become one-liner guards: `this.#requirePermission(parentNodeId, 'write')`.

**`DagTreeState` — unified cache and wire format**: A single `DagTreeState` structure serves both as the in-memory cache for internal lookups and as the wire format returned by `getState()`. Uses Maps for O(1) lookups both server-side and client-side. Mesh's `@lumenize/structured-clone` handles Map serialization over WebSocket; Workers RPC supports Maps natively.

```typescript
export interface DagTreeState {
  nodes: Map<number, {
    slug: string;
    label: string;
    deleted: boolean;
    parentIds: number[];
    childIds: number[];
  }>;
  permissions: Map<number, Map<string, PermissionTier>>;  // nodeId → { sub → tier }
}
```

No separate `edges` concept — parent/child relationships are embedded on each node entry. The client gets O(1) lookups for node details, traversal, and permission checks (e.g., `state.permissions.get(nodeId)?.get(sub)` to pre-check if an action is possible before attempting it).

(Phase 3.0 experiment measured 44 KB for 500 nodes without labels. Changes since then increases this modestly — well within the 128 MB DO limit even at pessimistic estimates.)

**Lazy init**: A private getter builds the state on first access from 3 SQL queries (all Nodes, all Edges, all Permissions). `getState()` returns `this.#cached` — over the wire, serialization creates a fresh copy; internally, cache invalidation makes old references stale.

```typescript
get #cached(): DagTreeState {
  if (!this.#_cached) {
    this.#_cached = this.#buildState()
  }
  return this.#_cached
}
```

**Read path**: `checkPermission`, `getEffectivePermission`, `getState`, `getNodeAncestors`, `getNodeDescendants` all operate on the in-memory `DagTreeState`. Zero SQL queries, zero row-read billing. The cache exists primarily for subscription fan-out (`getState()` serves every subscriber from a shared reference) — permission checks and traversal benefit as a secondary effect.

**Write path**: Cycle detection and slug validation run against the cached state (fast in-memory lookups). Then each write method wraps its SQL + cache invalidation in `ctx.storage.transactionSync(() => { ... SQL ...; this.#_cached = null })`. Cache invalidation is inside the transaction so that any throw (SQL failure or application bug) rolls back SQL to match the still-valid (or rebuild-safe) cache — no stale-cache risk. `#onChanged()` is called after the transaction — it's a notification side effect, not state, and a notification failure should not roll back a valid mutation. Mutations on deleted nodes are allowed (see Soft Delete section).

**Node-not-found rule**: All public methods that accept a `nodeId` parameter throw `Error('Node {nodeId} not found')` if the node does not exist in the Nodes table (never created, not just deleted). The check uses `this.#cached.nodes.has(nodeId)` — O(1) from the Map, no SQL query. This runs before permission checks or any other logic.

Tree nesting, phantom "Deleted"/"Orphaned" branches, parent stitching, and effective permission computation are all client-side concerns.

### `dag-ops.ts` — Shared Pure Functions

Exported from `apps/nebula/src/dag-ops.ts`. Pure functions on `DagTreeState` — no storage or `CallContext` dependency. Clients import them to pre-validate, check permissions, and traverse the tree locally (zero round trips). DagTree delegates to them internally; the auth layer (`#requirePermission`) stays in DagTree since it combines the pure check with `CallContext` extraction and Star admin bypass.

```typescript
// Constants
export const ROOT_NODE_ID = 1

// Validation
export function validateSlug(slug: string): void
export function checkSlugUniqueness(state: DagTreeState, parentNodeId: number, slug: string): void
export function detectCycle(state: DagTreeState, parentNodeId: number, childNodeId: number): void

// Permission resolution
export function resolvePermission(state: DagTreeState, sub: string, nodeId: number, requiredTier: PermissionTier): boolean
export function getEffectivePermission(state: DagTreeState, sub: string, nodeId: number): PermissionTier | null

// Traversal
export function getNodeAncestors(state: DagTreeState, nodeId: number): Set<number>
export function getNodeDescendants(state: DagTreeState, nodeId: number): Set<number>
```

### SQL Schema

Owned by `DagTree` — tables are created in the constructor via `CREATE TABLE IF NOT EXISTS`. Based on the schema validated in Phase 3.0 experiment, with one addition: the `label` column on Nodes (the experiment only had `slug`; `label` was added for human-readable display names). Confirmed: FK enforcement is ON by default in DO SQLite. No wrangler.jsonc migration entries are needed — the project has never been released to production, and local testing starts fresh each run.

```sql
-- INTEGER PRIMARY KEY = rowid alias. SQLite's most optimized storage path.
-- No WITHOUT ROWID needed — the integer PK *is* the rowid.
-- SQLite auto-assigns nodeId on INSERT (no counter needed).
CREATE TABLE IF NOT EXISTS Nodes (
  nodeId INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  deleted BOOLEAN NOT NULL DEFAULT 0
);

-- Edges is the single source of truth for all parent-child relationships.
-- No "primary parent" concept — in a DAG, there is no canonical path.
-- The client determines the normalized path based on navigation context.
CREATE TABLE IF NOT EXISTS Edges (
  parentNodeId INTEGER NOT NULL,
  childNodeId INTEGER NOT NULL,
  PRIMARY KEY (parentNodeId, childNodeId),
  FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
  FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- Reverse lookups: "who are my parents?" for ancestor climbing
CREATE INDEX IF NOT EXISTS idx_Edges_child ON Edges(childNodeId);

CREATE TABLE IF NOT EXISTS Permissions (
  nodeId INTEGER NOT NULL,
  sub TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('admin', 'write', 'read')),
  PRIMARY KEY (nodeId, sub),
  FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- "What nodes does this subject have permissions on?"
CREATE INDEX IF NOT EXISTS idx_Permissions_sub ON Permissions(sub);
```

**Note**: SQLite stores `BOOLEAN` as `INTEGER` (0/1). `DagTree.#buildState()` must coerce to TypeScript `boolean` when populating `DagTreeState.nodes[].deleted`.

**Root node**: Inserted via `INSERT OR IGNORE` after schema creation. Gets `nodeId = 1` (first INSERT into empty table), `slug = 'root'`, `label = 'Root'`. The root slug is never shown in URLs or UI — resource paths start at root's children: `universe.galaxy.star/resources/level-1-slug/.../level-n-slug`. The root node constant (`ROOT_NODE_ID = 1`) is used for guards — see Soft Delete below.

### Slug Validation and Uniqueness

**Format**: Slugs must match `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$` — lowercase alphanumeric and hyphens, 1–100 characters, no leading/trailing hyphens. Empty strings and slugs exceeding 100 characters are rejected. Validation runs in `validateSlug()` (in `dag-ops.ts`) before any SQL write.

**Uniqueness** is enforced **per-parent** — no two children of the same parent may share a slug. In a DAG, a node can appear under multiple parents, so slug uniqueness must be checked in all relevant parent contexts.

Enforcement points (all in DagTree code, not SQL constraints, since the check spans Nodes + Edges):

| Operation | Check |
|-----------|-------|
| `createNode(parentNodeId, slug, label)` | No existing child of `parentNodeId` has this slug |
| `addEdge(parentNodeId, childNodeId)` | No existing child of `parentNodeId` has the same slug as `childNodeId` |
| `reparentNode(childNodeId, oldParentId, newParentId)` | No existing child of `newParentId` has the same slug as `childNodeId` |
| `renameNode(nodeId, newSlug)` | For *every* parent of `nodeId`, no other child of that parent has `newSlug` |

### Soft Delete

- **Root node cannot be deleted or renamed**: `deleteNode` and `renameNode` throw if `nodeId === ROOT_NODE_ID`. The root is the anchor of the entire tree. The root slug is an internal constant never shown in URLs.
- `deleteNode(nodeId)` sets `deleted = 1` — does NOT remove edges or permissions
- **`deleteNode` is idempotent**: If the node is already deleted (`deleted === 1`), return early as a no-op.
- **`undeleteNode` is idempotent**: If the node is not deleted (`deleted === 0`), return early as a no-op.
- **Deleted nodes in permission resolution**: Ancestor climbing **continues through** deleted nodes and **considers their permission grants normally**. Soft delete controls node/resource visibility, not permissions — to revoke access, use `revokePermission` explicitly. This avoids a footgun where a DAG admin who deletes a node they administer would lose the ability to `undeleteNode` it (since their only grant was on the deleted node). It also keeps `reparentNode` simple — no edge case when `oldParentId` is deleted.
- **Mutations on deleted nodes are allowed**: All operations (`createNode`, `addEdge`, `setPermission`, `revokePermission`, `renameNode`, `relabelNode`, etc.) work normally on deleted nodes. The `deleted` flag is purely a client-side display hint — the permission system is the only access control boundary. This is consistent with grants being considered normally during ancestor climbing, and enables cleanup operations like revoking an unintentional grant on a deleted node without the `undeleteNode` → `revokePermission` → `deleteNode` dance.
- `getState()` includes deleted nodes with `deleted: true` in the nodes Map — the client decides how to display them (e.g., phantom "Deleted" branch, greyed out, hidden)
- `undeleteNode(nodeId)` sets `deleted = 0` — node reappears with edges and permissions intact

### Cycle Detection

Port from blueprint's `tree.js` (lines 128–146). The algorithm:

1. On `addEdge(parent, child)` or `reparentNode`: verify that `parent` is not a descendant of `child`
2. Walk the in-memory cache (flat node map's `parentIds`) — BFS up from `parent`
3. If `child` is found in the ancestry, throw — adding this edge would create a cycle
4. Write-time check only — reads don't need it

Blueprint's implementation is ~20 lines of recursive JS.

### Authorization Model

**Two independent layers** — scope binding and per-operation authorization:

| Layer | Question | Mechanism | Scope |
|-------|----------|-----------|-------|
| Scope binding | Is this call for the right Star? | `NebulaDO.onBeforeCall()` (Phase 2) | DO instance |
| Star admin | Is this person a Star-level admin? | `#requirePermission` checks `claims.access.admin` — bypasses DAG checks | Entire Star |
| DAG permissions | Can this person do X on this node? | `#requirePermission` checks inherited grants + throws (Phase 3.1) | Per-node |

**Star admin bypasses DAG checks**: If the caller's JWT has `claims.access.admin = true` (Star-level admin, possibly via `authScopePattern` rolldown from universe/galaxy), all DAG permission checks are skipped. This is the bootstrap mechanism — Star admins can build the tree and delegate without needing explicit DAG grants.

**Capability trust model**: Star exposes a single `@mesh()` entry point — `dagTree()` — that returns the `DagTree` instance. Clients chain through it via OCAN: `ctn<Star>().dagTree().createNode(parentId, slug, label)`. The OCAN executor checks `@mesh()` only on the first `apply` in the chain (the entry point); subsequent operations in the chain traverse freely on the returned object. DagTree handles per-operation auth internally via `#requirePermission` — no `@mesh(guard)` decorators needed on individual methods. Errors propagate back to the caller via mesh's error transport (`{ $error: ... }` envelope).

### `DagTree` Public API

DagTree reads caller identity via the injected `getCallContext` getter. Clients access DagTree methods via OCAN chain: `ctn<Star>().dagTree().someMethod(args)`. No thin `@mesh()` wrappers needed — Star exposes a single `dagTree()` entry point and DagTree handles its own auth.

**Tree structure mutations** (require `write` on the relevant node(s), or Star admin). Note: `write` allows structural changes including `deleteNode` but does NOT allow granting access to others — that requires `admin`. This asymmetry is intentional: the three tiers (`admin` > `write` > `read`) form a strict hierarchy where only `admin` controls the permission map.

| Method | Signature | Returns | Permission check |
|--------|-----------|---------|-----------------|
| `createNode` | `(parentNodeId, slug, label)` | `number` (new nodeId) | write on `parentNodeId` |
| `addEdge` | `(parentNodeId, childNodeId)` | `void` | write on `parentNodeId`. **Idempotent**: if the edge already exists, return as a no-op (skip permission check, cycle detection, slug uniqueness checks, and SQL write). Uses `INSERT OR IGNORE` for the SQL write — the PK `(parentNodeId, childNodeId)` naturally deduplicates. |
| `removeEdge` | `(parentNodeId, childNodeId)` | `void` | write on `parentNodeId`. **Idempotent**: if the edge doesn't exist, return as a no-op (no permission check needed). Orphans are allowed — removing the last edge to a non-root node leaves it orphaned (unreachable from root). The client handles display via phantom "Orphaned" branch (see blueprint's `separateTreeAndDeleted` pattern). **Mutations on orphaned nodes are intentionally allowed** — orphaning is more likely accidental and soon reverted; only direct grants apply (no ancestors to roll down from). |
| `reparentNode` | `(childNodeId, oldParentId, newParentId)` | `void` | write on `oldParentId` AND `newParentId` (write on `childNodeId` is redundant — the child is a descendant of `oldParentId`, so write on the parent implies write on the child via rolldown). **Throws if `oldParentId→childNodeId` edge does not exist** — the caller has a stale view of the tree. |
| `deleteNode` | `(nodeId)` | `void` | write on `nodeId`. **Throws if `nodeId === ROOT_NODE_ID`** — the root is the anchor of the entire tree. **Idempotent**: if already deleted, return as a no-op (skip permission check). |
| `undeleteNode` | `(nodeId)` | `void` | write on `nodeId`. **Throws if `nodeId === ROOT_NODE_ID`** — the root is never deleted. **Idempotent**: if not deleted, return as a no-op (skip permission check). |
| `renameNode` | `(nodeId, newSlug)` | `void` | write on `nodeId`. **Throws if `nodeId === ROOT_NODE_ID`** — the root slug is an internal constant, never shown in URLs, and renaming it could cause subtle downstream issues. Validates `newSlug` via `validateSlug()` before slug uniqueness checks. |
| `relabelNode` | `(nodeId, newLabel)` | `void` | write on `nodeId`. Updates the human-readable display label. No uniqueness constraint — multiple nodes may share the same label. **Allowed on root** (unlike `renameNode`). Validates non-empty and max 500 characters. |

**Permission management** (require `admin` on the target node, or Star admin):

| Method | Signature | Returns | Permission check |
|--------|-----------|---------|-----------------|
| `setPermission` | `(nodeId, targetSub, level)` | `void` | admin on `nodeId` |
| `revokePermission` | `(nodeId, targetSub)` | `void` | admin on `nodeId`. **Idempotent**: if no grant exists for this subject on this node, return as a no-op (skip permission check). |

`setPermission` uses `INSERT ... ON CONFLICT(nodeId, sub) DO UPDATE SET permission = excluded.permission` — a single SQL upsert with no prior SELECT. If the subject already has a grant on this node, the tier is replaced (upgrade or downgrade). The admin is making an intentional choice; there is no "only allow escalation" guard.

**Permission queries** (from in-memory cache, any authenticated user — permissions are not sensitive since `getState()` already sends the full permissions map to all subscribers):

| Method | Signature | Returns | Auth |
|--------|-----------|---------|------|
| `checkPermission` | `(nodeId, requiredTier, targetSub?)` | `boolean` | Any authenticated user |
| `getEffectivePermission` | `(nodeId, targetSub?)` | `PermissionTier \| null` | Any authenticated user |

- Without `targetSub`: defaults to caller's own sub
- Both methods delegate directly to the pure `dag-ops.ts` functions (`resolvePermission`, `getEffectivePermission`) passing `this.#cached` — no private wrapper methods needed
- `#requirePermission(nodeId, tier)` handles all mutation guards (extracts sub, checks Star admin, delegates to `resolvePermission()`, throws if denied)
- `checkPermission` is the hot path for Phase 5 resource guards (Star calls it internally with the caller's own sub)

**State and traversal queries** (from in-memory cache, any authenticated user):

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `getState` | `()` | `DagTreeState` | Returns cached state directly (see `DagTreeState` interface above) |
| `getNodeAncestors` | `(nodeId)` | `Set<number>` | |
| `getNodeDescendants` | `(nodeId)` | `Set<number>` | |

- All three methods require only authentication (throws if `sub` is falsy) — no DAG permission check. Any user who can reach this Star (passed `onBeforeCall` scope binding) can read the full tree state.
- `getState()` returns the cached `DagTreeState` — **identical for every caller**. No per-subscriber computation. Serialization over mesh creates a fresh copy for each client.
- `permissions` contains all direct grants. The client computes effective (rolled-down) permissions locally — a single topological-order pass propagating `max(direct grant, any parent's effective)` per node.
- **All authenticated users see all direct grants for all subjects within the Star.** The Star is already a trust boundary (same nebula-auth scope). Permission metadata visibility enables collaborative UX (see who has access) and eliminates per-subscriber recomputation for subscription fan-out. The security boundary is data access enforcement (DAG permission checks on every operation), not permission metadata hiding.

### Star DO Integration

NebulaDO does not define `onStart` — it handles scope binding in `onBeforeCall`. Star defines `onStart` directly (no super call needed).

```typescript
export class Star extends NebulaDO {
  #dagTree!: DagTree

  // Synchronous — DagTree constructor is all synchronous SQL (DDL + INSERT OR IGNORE).
  // LumenizeDO.onStart returns `Promise<void> | void`, so sync overrides are fine.
  onStart() {
    this.#dagTree = new DagTree(
      this.ctx,                      // DurableObjectState
      () => this.lmz.callContext,    // lazy — evaluated at call time, not construction time
      () => this.#onChanged()
    )
  }

  // Capability trust model: single @mesh() entry point for the entire DagTree API.
  // OCAN executor checks @mesh() only on the first apply in the chain (this method);
  // subsequent operations (e.g., .createNode(), .getState()) traverse freely.
  // DagTree handles per-operation auth internally via #requirePermission.
  //
  // Client usage:
  //   this.ctn<Star>().dagTree().createNode(parentId, slug, label)
  //   this.ctn<Star>().dagTree().getState()
  //   this.ctn<Star>().dagTree().checkPermission(nodeId, tier, targetSub)
  @mesh()
  dagTree(): DagTree {
    return this.#dagTree
  }

  // Phase 5: resource guards call this.#dagTree.checkPermission(...) internally —
  // #dagTree stays private for internal use, dagTree() is the remote entry point.

  #onChanged() {
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
4. Star admin grants `admin` on specific subtrees to delegation subjects via `setPermission`
5. Delegated admins can grant/revoke permissions within their subtrees
6. Users with `write` can create/modify nodes within their authorized subtrees

No auto-grant on root needed. The JWT Star admin flag *is* the bootstrap mechanism.

### Test Plan

Tests live in the existing `test/test-apps/baseline/` test-app. A new `dag-tree.test.ts` file tests DagTree through `StarTest`, getting real DO SQLite storage via the existing `instrumentDOProject` setup.

**`NebulaClientTest` additions**: New helper methods following the existing fire-and-forget pattern, chaining through `dagTree()`:

```typescript
callStarCreateNode(starName: string, parentId: number, slug: string, label: string) {
  this.resetResults();
  const remote = this.ctn<Star>().dagTree().createNode(parentId, slug, label);
  this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
}

callStarGetState(starName: string) {
  this.resetResults();
  const remote = this.ctn<Star>().dagTree().getState();
  this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
}
// ... same pattern for all DagTree methods:
// callStarGrantPermission, callStarCheckPermission, callStarGetEffectivePermission,
// callStarAddEdge, callStarRemoveEdge, callStarReparentNode,
// callStarDeleteNode, callStarUndeleteNode, callStarRenameNode, callStarRelabelNode,
// callStarRevokePermission, callStarGetNodeAncestors, callStarGetNodeDescendants
```

**DagTree tests** (`dag-tree.test.ts`):
- Schema creation: tables exist after `onStart`, FK enforcement on
- Root node: exists with nodeId 1, slug 'root', label 'Root'
- Root node protection: `deleteNode` and `renameNode` on root throw
- Tree construction: create nodes, add edges, verify structure via `getState()` (`DagTreeState` Maps format)
- `createNode` returns new nodeId, stores slug and label
- `relabelNode`: updates label, allowed on root (unlike `renameNode`), validates non-empty and max 500 chars
- Cycle detection: reject cycles, allow diamonds
- Node-not-found: operations on non-existent nodeId throw `'Node {nodeId} not found'`
- Slug validation: reject empty, too long, uppercase, underscores, leading/trailing hyphens; accept valid slugs
- Slug uniqueness: reject duplicate slugs under same parent, allow same slug under different parents
- `addEdge` idempotency: adding an already-existing edge is a no-op (no permission check, no error)
- `removeEdge` idempotency: removing a non-existent edge is a no-op (no permission check, no error)
- `reparentNode` with missing old edge: throws if `oldParent→child` edge doesn't exist
- Soft delete: `deleteNode` sets flag, `undeleteNode` restores, deleted nodes in `getState()` have `deleted: true`
- `deleteNode` idempotency: deleting an already-deleted node is a no-op (no permission check, no error)
- `undeleteNode` idempotency: undeleting a non-deleted node is a no-op (no permission check, no error)
- Deleted node permission climbing: ancestor climbing continues through deleted nodes and considers their grants normally — soft delete controls visibility, not permissions
- Mutations on deleted nodes succeed: `createNode` under deleted parent, `setPermission`/`revokePermission` on deleted node, `renameNode`/`relabelNode` on deleted node — `deleted` flag is purely a display hint
- Permission CRUD: `setPermission`, `revokePermission`, verify via `checkPermission` and `getEffectivePermission`
- Permission upsert: `setPermission` replaces existing tier (e.g., upgrade read→write, downgrade admin→read)
- `revokePermission` idempotency: revoking a non-existent grant is a no-op (no permission check, no error)
- Permission rolldown: grant on root → all descendants, grant on middle → descendants only, multiple paths → highest wins
- Permission boundaries: no grant on any ancestor → denied, grant on one path → granted (any-path rule), revoke → descendants lose access
- Permission query auth: self-check succeeds for any user, cross-check (`targetSub`) requires admin on node or Star admin, cross-check without admin throws
- `getState` includes `permissions` with all direct grants for all subjects (client computes rolldown)
- Authorization enforcement: write on parent → can create child, no write → throws, Star admin → bypasses DAG checks
- Permission management auth: admin on node → can grant/revoke, write on node → cannot grant (throws)
- Cache behavior: mutations invalidate cache, next read rebuilds from SQL, `onChanged` callback fires on mutations

**Star DO integration tests** (in existing `dag-tree.test.ts` or separate `star-dag-integration.test.ts`):
- Layer coexistence: `@mesh(requireAdmin)` (JWT Star admin) and DagTree authorization (DAG write/admin) operate independently
- Auth identity flow: universe admin (wildcard JWT) → Star admin → full DAG access, regular user → only DAG-granted access
- Abuse cases: permission escalation attempt → throws, cross-sub permission query without admin → throws

---

## Phase 3.2: Remove Phase 2 Placeholders from Star

**Status**: Complete
**Goal**: Remove dummy methods from `Star` that were Phase 2 smoke tests, now superseded by the real `dagTree()` entry point.

### Changes

**Move to `StarTest`** (test subclass in `test/test-apps/baseline/index.ts`):
- `setStarConfig(key, value)` — move the method with its `@mesh(requireAdmin)` decorator
- `getStarConfig()` — move with its `@mesh()` decorator
- `whoAmI()` — move with its `@mesh()` decorator

**Remove from `Star`** (`apps/nebula/src/star.ts`): All three methods above.

**Update existing tests**: `guards.test.ts` and `scope-binding.test.ts` call these methods via `NebulaClientTest` helpers (`callStarSetConfig`, `callStarGetConfig`, `callStarWhoAmI`). These tests exercise the guard/scope-binding infrastructure, not Star's business logic — they still pass because `StarTest` inherits from `Star` and the test wrangler binds `StarTest` as `STAR`.

**Verify**: All 57 existing tests pass unchanged.

### Success Criteria

- [x] `Star` class has only `onStart()`, `dagTree()`, and `#onChanged()` — no leftover placeholder methods
- [x] `StarTest` provides `setStarConfig`, `getStarConfig`, `whoAmI` for tests that need them
- [x] All 57 tests pass unchanged

---

## Follow-On Items (Relocated)

Items from the original Phase 3.x section have been relocated:

| Item | New Location | Rationale |
|------|-------------|-----------|
| `getNodeByPath(slugPath)` | `tasks/nebula-resources.md` (DAG prerequisites) | Needed for resource path resolution in Phase 5 |
| Resource + DAG integration tests | `tasks/nebula-resources.md` (DAG prerequisites) | Phase 5 scope |
| `getSubtreePermissions`, bulk ops | `tasks/nebula-scratchpad.md` (DAG Tree Enhancements) | No phase depends on them yet |
| Client-side display patterns | `tasks/nebula-scratchpad.md` (Client-Side DAG Display Patterns) | Phase 8 (Nebula UI) concern |
| Subscription fan-out | `tasks/nebula-scratchpad.md` (Star Subscription Design) | Already there from Phase 3.1 review |
| Performance/edge-case tests | `tasks/nebula-scratchpad.md` (DAG Tree Enhancements) | Pull in if performance becomes a concern |
| HMAC capability tickets | `tasks/nebula.md` Phase 5.5 | Already has its own task file entry |
| Materialized closure table | `tasks/nebula-scratchpad.md` (DAG Tree Enhancements) | Contingent optimization |

---

## What Gets Replaced Later

- **`#onChanged` placeholder**: Replaced by subscription fan-out in Phase 5
- **Some tests**: Replaced by integrated Resources + DAG tests in Phase 5

**What survives**: The `dag-ops` pure functions (shared with clients), the `DagTree` class (schema, SQL persistence, in-memory cache), Star DO integration (`onStart`, `dagTree()` entry point), and the core test scenarios for tree construction and permission rolldown.

## Success Criteria

### Phase 3.0 — COMPLETE (archived at `tasks/archive/nebula-dag-tree-experiment.md`)

### Phase 3.1 — COMPLETE
- [x] `dag-ops.ts` at `apps/nebula/src/dag-ops.ts` — exported `ROOT_NODE_ID` constant and pure functions (`validateSlug`, `checkSlugUniqueness`, `detectCycle`, `resolvePermission`, `getEffectivePermission`, `getNodeAncestors`, `getNodeDescendants`) operating on `DagTreeState`, usable on both server and client
- [x] `DagTree` class at `apps/nebula/src/dag-tree.ts` with lazy in-memory cache, exported `PermissionTier` type, takes `DurableObjectState`. Internal methods delegate to `dag-ops` functions
- [x] DAG tree schema in Star's SQLite (Nodes, Edges, Permissions tables) with root node auto-created. All write methods wrapped in `ctx.storage.transactionSync()`
- [x] Tree mutations: `createNode` (returns nodeId, accepts slug + label), `addEdge` (idempotent), `removeEdge` (idempotent), `reparentNode` (throws if old edge missing), `deleteNode`, `undeleteNode`, `renameNode`, `relabelNode`
- [x] Root node protection: `deleteNode` and `renameNode` throw on root (nodeId 1)
- [x] Idempotent operations: `deleteNode` on already-deleted is a no-op (skip permission check), `undeleteNode` on non-deleted is a no-op (skip permission check), `addEdge` on existing edge is a no-op (skip permission check), `removeEdge` on non-existent edge is a no-op (skip permission check), `revokePermission` on non-existent grant is a no-op (skip permission check)
- [x] Cycle detection on `addEdge` and `reparentNode`
- [x] Slug validation: `[a-z0-9-]`, max 100, no leading/trailing hyphen, non-empty
- [x] Slug uniqueness enforced per-parent on all relevant operations
- [x] Soft delete: `deleted` flag is a display hint only — mutations on deleted nodes are allowed, `getState()` includes `deleted: true` (client handles phantom branches)
- [x] Permission grant/revoke (admin-only on target node via DAG or Star admin)
- [x] Permission queries: `checkPermission` and `getEffectivePermission` with optional `targetSub` — self-check for any user, cross-check requires admin
- [x] Permission resolution: ancestor rolldown with any-path-grants semantics (from cache)
- [x] `getState()` returns `DagTreeState` (Maps) — nodes with embedded parentIds/childIds, permissions as nested Maps, identical for every caller
- [x] Authorization: DagTree reads caller identity via injected `getCallContext` getter (undefined-safe for future DO-to-DO calls), checks permissions, throws if denied; Star admin bypasses DAG checks
- [x] Star DO integration: `DagTree` in `onStart` (synchronous — no async needed), single `@mesh() dagTree()` entry point (capability trust model — OCAN chains traverse DagTree methods freely after the entry point), `onChanged` placeholder callback
- [x] Tests in existing `test/test-apps/baseline/`: DagTree operations, authorization enforcement, permission query auth, abuse cases
- [x] Bootstrap flow verified: Star admin (JWT) → build tree → delegate via `setPermission`

# Phase 5.1: LumenizeResources Storage Engine

**Status**: Pending
**App**: `apps/nebula/`
**Depends on**: Phase 3.1 (DAG Tree Access Control — complete)
**Prior art**: `tasks/reference/blueprint/temporal-entity.js` (Snodgrass temporal storage for Cloudflare DOs)
**Design reference**: `tasks/nebula-resources.md` (master design doc, sections: "Temporal Storage", "Snapshot Response Shape", "Upsert Response Protocol", "Transaction API and Protocol", "Storage Format")

---

## Goal

Build the temporal storage engine inside `ResourceHistory` DO. This is the foundation that all later phases build on — pure storage with no DWL, no subscriptions, no HTTP transport.

After this phase, a Star can create resources (via DAG tree nodes), and ResourceHistory DOs store versioned snapshots with optimistic concurrency. Access control is handled by the DAG tree — ResourceHistory doesn't need custom guards.

---

## What Exists Today

- **`ResourceHistory` DO** (`apps/nebula/src/resource-history.ts`) — 13-line stub. Extends `NebulaDO`, has a single `@mesh() getHistory()` placeholder. UUID-named, scope-locked via `onBeforeCall()`.
- **`Star` DO** — owns the DAG tree. Each node in the tree will map to a resource type. Star has a `#onChanged()` callback placeholder for future fanout.
- **DAG tree** — fully implemented with `checkPermission(nodeId, requiredTier)`. Handles access control for who can read/write/admin resources.
- **Test infrastructure** — `test/test-apps/baseline/` with `StarTest`, `NebulaClientTest`, helpers (`bootstrapAdmin`, `browserLogin`, `createAuthenticatedClient`), two vitest projects (unit + e2e).
- **`@lumenize/structured-clone`** — `preprocess()` / `postprocess()` for rich types (Map, Set, Date, cycles). Used for storage format.

---

## Design Decisions (from master design doc)

### Temporal Storage (Snodgrass-Style)

Every resource uses snapshot-based temporal storage. Each write creates a snapshot with `validFrom`/`validTo` timestamps.

**Debounce** — rapid updates from the same `sub` within the debounce window overwrite the current snapshot in place (no new timeline entry):

| `debounceMs` | Behavior |
|---|---|
| `3_600_000` (default — 1 hour) | Same sub within 1 hour overwrites current snapshot |
| `0` | Every update creates a new snapshot — full audit trail |
| Custom (e.g., `5_000`) | 5-second debounce window per sub |

**`history: false`** — single-row mode, always overwrites. Same table/queries, no separate code path.

### Snapshot Shape

```typescript
interface Snapshot<T> {
  value: T;
  meta: {
    eTag: string;        // Opaque UUID — changes on every write including debounced
    validFrom: string;   // ISO 8601 — when this snapshot period began
    validTo: string;     // '9999-01-01T00:00:00.000Z' for current
    changedBy: string;   // sub from callContext
    deleted: boolean;
  }
}
```

### Storage Format

Resource values stored as `$lmz` preprocessed format in SQLite (JSONB or TEXT). Rich types (Map, Set, Date, cycles) round-trip through `preprocess()` / `postprocess()`.

### Optimistic Concurrency

Every write requires an eTag. First write to a resource has no eTag requirement (it's a create). Subsequent writes must match the current eTag or get a conflict response.

### Response Protocol

- **Success:** `{ ok: true, snapshot }` — write landed, includes full snapshot with new eTag
- **Conflict:** `{ ok: false, snapshot }` — eTag mismatch, includes current snapshot so caller can retry
- **Not found:** `{ ok: false }` — resource doesn't exist

---

## SQL Schema

ResourceHistory uses synchronous SQL storage (`ctx.storage.sql`).

```sql
CREATE TABLE IF NOT EXISTS Snapshots (
  resourceId TEXT NOT NULL,
  validFrom TEXT NOT NULL,
  validTo TEXT NOT NULL DEFAULT '9999-01-01T00:00:00.000Z',
  eTag TEXT NOT NULL,
  changedBy TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL,          -- $lmz preprocessed JSON
  PRIMARY KEY (resourceId, validFrom)
) WITHOUT ROWID;

-- Fast lookup: current snapshot for a resource
CREATE INDEX IF NOT EXISTS idx_Snapshots_current
  ON Snapshots(resourceId, validTo)
  WHERE validTo = '9999-01-01T00:00:00.000Z';
```

**Design notes:**
- `WITHOUT ROWID` — compound TEXT PK, per CLAUDE.md SQL conventions
- `value` stored as TEXT containing `JSON.stringify(preprocess(value))` — rich types preserved
- `validTo = '9999-01-01T00:00:00.000Z'` marks the current snapshot (same as Blueprint prior art)
- Single table for all resource types within this DO instance — `resourceId` is the discriminator
- Index on `(resourceId, validTo)` with partial filter for current-snapshot lookups

---

## ResourceHistory API

All methods are synchronous (no `async`) — uses `ctx.storage.sql` only. Access control is handled by the DAG tree before calls reach ResourceHistory.

### Core Methods

```typescript
@mesh()
upsert(resourceId: string, value: any, eTag?: string): UpsertResult
// Creates or updates a resource. eTag required for updates (optimistic concurrency).
// Returns { ok: true, snapshot } on success, { ok: false, snapshot } on conflict.

@mesh()
read(resourceId: string): Snapshot | null
// Returns current snapshot or null if not found / deleted.

@mesh()
delete(resourceId: string, eTag: string): UpsertResult
// Soft-delete: creates a new snapshot with deleted=true.
// eTag required (optimistic concurrency).

@mesh()
readHistory(resourceId: string, options?: { from?: string; to?: string }): Snapshot[]
// Returns snapshots within the time range. Defaults to all history.
```

### Internal Methods (not @mesh)

```typescript
#getCurrentSnapshot(resourceId: string): Snapshot | null
// SQL query: WHERE resourceId = ? AND validTo = END_OF_TIME

#writeSnapshot(resourceId: string, value: any, changedBy: string, eTag: string): Snapshot
// Handles debounce logic, timeline management, eTag generation
```

---

## Resource Type Configuration

Resource types are configured on the Star's DAG tree, not in ResourceHistory. The Star node carries config for each resource type:

```typescript
// On Star — stored as node metadata in the DAG tree
interface ResourceTypeConfig {
  debounceMs: number;    // default 3_600_000 (1 hour)
  history: boolean;      // default true
}
```

When Star dispatches to ResourceHistory, it passes the config. ResourceHistory doesn't store config — it receives it per-call. This keeps ResourceHistory stateless regarding configuration (config lives in the DAG tree, single source of truth).

**Open question**: How exactly does Star pass config to ResourceHistory? Options:
1. As a parameter on each `upsert()`/`delete()` call
2. Via callContext state
3. ResourceHistory reads it from Star via RPC on first access (cached)

Decision deferred to implementation — try option 1 (simplest) first.

---

## DAG Tree Integration

The DAG tree from Phase 3 handles access control. The flow for a resource operation:

1. Client calls Star with resource operation (e.g., upsert task)
2. Star resolves resource type → DAG node via `getNodeByPath(slugPath)` (new method, see prerequisites)
3. Star checks `dagTree.checkPermission(nodeId, 'write')` — throws if denied
4. Star forwards to ResourceHistory DO via `lmz.call()`
5. ResourceHistory performs the storage operation (no auth checks — Star already verified)

### Prerequisites from Phase 3

These were identified in `nebula-resources.md` as DAG tree prerequisites:

- **`getNodeByPath(slugPath)`**: Resolve `level-1-slug/.../level-n-slug` to a nodeId by walking the cached node map from root, matching slugs at each level. Add to `DagTree` and `dag-ops.ts`.
- **Node metadata**: Nodes need to carry `ResourceTypeConfig` (debounceMs, history). Add a `metadata` column to the Nodes table or a separate ResourceConfig table.

---

## Testing Strategy

### Test Location

`test/test-apps/baseline/` — extend the existing e2e test infrastructure.

### New Test File

`test/test-apps/baseline/resource-history.test.ts`

### Test Invariant

Every test that stores a resource value must use an object that includes a **Map**, a **Date**, and a **Cycle** to guard against accidental `JSON.stringify()` usage. This ensures `@lumenize/structured-clone` is actually being used.

```typescript
// Standard test value — use this or similar in every resource test
function makeTestValue() {
  const obj: any = {
    title: 'Test Task',
    tags: new Set(['urgent', 'bug']),
    metadata: new Map([['priority', 3], ['retries', 0]]),
    createdAt: new Date('2026-03-08T00:00:00.000Z'),
  };
  obj.self = obj; // cycle
  return obj;
}
```

### Test Cases

**Basic CRUD:**
- Create a resource (first upsert, no eTag)
- Read it back — value deep-equals including Map, Set, Date, cycle
- Update with correct eTag — succeeds
- Update with wrong eTag — conflict response with current snapshot
- Delete with correct eTag — soft delete
- Read deleted resource — returns null
- Read history — returns all snapshots

**Debounce:**
- Same sub within debounce window — overwrites in place (no new timeline entry)
- Different sub within debounce window — creates new snapshot
- Same sub outside debounce window — creates new snapshot
- `history: false` mode — always single snapshot, no timeline

**Temporal storage:**
- Multiple updates create proper timeline with `validFrom`/`validTo` chain
- `validTo` of previous snapshot = `validFrom` of new snapshot
- Current snapshot always has `validTo = '9999-01-01T00:00:00.000Z'`
- History query with time range returns correct subset

**DAG integration:**
- User with `write` permission on node → upsert succeeds
- User with `read` permission on node → upsert rejected, read succeeds
- User with no permission → both rejected
- Admin grants permission → previously rejected user can now write

**Edge cases:**
- Upsert to deleted resource — should this undelete or fail? (decide during implementation)
- Concurrent upserts with same eTag — only one succeeds
- Empty value (null/undefined) — decide if allowed

---

## Success Criteria

- [ ] `ResourceHistory` DO stores snapshots in SQLite with `$lmz` format
- [ ] `upsert()` with optimistic concurrency (eTag)
- [ ] `read()` returns current snapshot with rich types preserved
- [ ] `delete()` soft-deletes with new snapshot
- [ ] `readHistory()` returns timeline
- [ ] Debounce: same sub within window overwrites in place
- [ ] `history: false` mode: single-snapshot, no timeline
- [ ] DAG tree gates access (write permission required for upsert/delete, read for read)
- [ ] `getNodeByPath()` added to DagTree
- [ ] Test values include Map, Date, and Cycle
- [ ] All tests pass in `test/test-apps/baseline/`

---

## Out of Scope

- DWL / tsc validation (Phase 5.2)
- Subscriptions / fanout (Phase 5.3)
- Capability tickets (Phase 5.4)
- Schema evolution (Phase 5.5)
- HTTP transport (Phase 5.6)
- `transaction()` batch API — deferred. Start with single-resource operations. Batch can be added when needed (likely 5.2 or 5.3).

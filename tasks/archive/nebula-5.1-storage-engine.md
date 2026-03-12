# Phase 5.1: Storage Engine (Resources Class)

**Status**: Complete
**App**: `apps/nebula/`
**Depends on**: Phase 3.1 (DAG Tree Access Control — complete)
**Prior art**: `tasks/reference/blueprint/temporal-entity.js` (Snodgrass temporal storage for Cloudflare DOs)
**Scratchpad**: `tasks/nebula-resources.md` — evolving design notes, not always self-consistent and growing further from the latest thinking all the time. This task file takes precedence on any conflicts.

---

## Goal

Build the temporal storage engine inside the **Star** DO, encapsulated in a new **`Resources`** class (mirroring the `DagTree` class pattern). This is the foundation that all later phases build on — pure storage for now. DWL, fanout notifications, subscriptions, ResourceHistory, HTTP transport all come in later phases.

After this phase, Star stores versioned resource snapshots in its SQLite database, attached to DAG tree nodes, with optimistic concurrency and debounce. Moving old snapshots to `ResourceHistory` is a future out-of-band operation — not part of this phase.

---

## What Exists Today

- **`Star` DO** — owns the DAG tree. Every resource attaches to exactly one DagTree node. Star has a `#onChanged()` callback placeholder for future fanout.
- **`ResourceHistory` DO** (`apps/nebula/src/resource-history.ts`) — 13-line stub. Untouched in this phase.
- **DAG tree** — fully implemented in its own class (`DagTree`), instantiated by Star. Tree mutations, permission management, traversal, and permission queries. Key method for this phase: `requirePermission(nodeId, tier)` — throws on failure (Mesh guard pattern) and includes universe/galaxy/star admin override via `claims.access.admin`. **Note:** `requirePermission` is currently private (`#requirePermission`). This phase must make it public so Resources can call it for access control. It is not `@mesh()`-decorated — DagTree is a plain class instantiated by Star, not a separate DO.
- **Test infrastructure** — `test/test-apps/baseline/` with `StarTest`, `NebulaClientTest`, helpers (`bootstrapAdmin`, `browserLogin`, `createAuthenticatedClient`), two vitest projects (unit + e2e). Likely sufficient for this phase, but a new test-app can be created if needed.
- **`@lumenize/structured-clone`** — `preprocess()` / `postprocess()` for rich types (Map, Set, Date, cycles). Used for storage format. Note, it's also used for the wire format to/from the Client but that's transparent to the Star and handled by the `this.lmz.call()` implementation.

---

## Architecture: Resources Class

The `Resources` class follows the same pattern established by `DagTree` — a plain class (not a DO) instantiated by Star via constructor injection, exposed through a single `@mesh()` entry point on Star.

### Why a Separate Class

- **Separation of concerns** — DagTree owns access control hierarchy, Resources owns temporal storage. Star is the orchestrator.
- **Discoverability** — new file (`apps/nebula/src/resources.ts`) makes the storage engine easy to find and evolve.
- **Clean capability model** — single `@mesh()` entry point, then free traversal into any Resources method. Adding/changing methods on Resources is automatically represented — no thin wrapper layer on Star.
- **Proven pattern** — DagTree already demonstrates this architecture works.

### Constructor Injection

```typescript
// apps/nebula/src/resources.ts
export class Resources {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #dagTree: DagTree;
  #onChanged: () => void;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    dagTree: DagTree,
    onChanged: () => void,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#dagTree = dagTree;
    this.#onChanged = onChanged;
    this.#createSchema();
    this.#bootstrapConfig();
  }
}
```

Mirrors DagTree's constructor pattern: `(ctx, getCallContext, onChanged)` plus a `dagTree` handle for permission checks. The `onChanged` callback is a placeholder for future subscription fanout (same as DagTree's — both fire `Star.#onChanged()`).

### Star Integration

```typescript
// apps/nebula/src/star.ts
export class Star extends NebulaDO {
  #dagTree!: DagTree
  #resources!: Resources

  onStart() {
    this.#dagTree = new DagTree(
      this.ctx,
      () => this.lmz.callContext,
      () => this.#onChanged(),
    )
    this.#resources = new Resources(
      this.ctx,
      () => this.lmz.callContext,
      this.#dagTree,
      () => this.#onChanged(),
    )
  }

  @mesh()
  dagTree(): DagTree { return this.#dagTree }

  @mesh()
  resources(): Resources { return this.#resources }

  // Moved from StarTest — matches Universe/Galaxy pattern
  @mesh(requireAdmin)
  setStarConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  #onChanged() {
    // Phase 3.1: placeholder — tests verify this callback fires on mutations
    // Phase 5: subscription fan-out via lmz.call() through NebulaClientGateway
  }
}
```

Both `dagTree()` and `resources()` use bare `@mesh()` — no guard. Auth is handled internally by `dagTree.requirePermission()` (per-node granularity) and at the `onBeforeCall` layer. The `@mesh()` decorator just marks the method as mesh-callable and ensures callContext is set.

### Client Call Pattern

```typescript
// Phase 5.1 test pattern — chained through resources()
// Follows the established lmz.call('BINDING', instanceName, remote, handler) pattern
const txnRemote = client.ctn<Star>().resources().transaction({
  'task-123': { op: 'update', eTag: currentETag, value: newValue },
  'task-456': { op: 'create', nodeId: 7, value: otherValue },
});
client.lmz.call('STAR', starName, txnRemote, client.ctn().handleResult(txnRemote));

const readRemote = client.ctn<Star>().resources().read('task-123');
client.lmz.call('STAR', starName, readRemote, client.ctn().handleResult(readRemote));
```

In a later phase, we will likely wrap these calls into local methods inside NebulaClient to unify NebulaClient's internal resource state management (eTag caching, local value updates) and UI update events based upon return results from the call.

---

## Design Decisions

### Temporal Storage (Snodgrass-Style)

Every resource uses snapshot-based temporal storage. Each write (that is not debounced) creates a snapshot with `validFrom`/`validTo` timestamps. All snapshots live in Star's SQLite — no cross-DO dispatch.

**Debounce** — rapid updates from the same sub chain within the debounce window overwrite the current snapshot in place (no new timeline entry, but a new eTag):

| `debounceMs` | Behavior |
|---|---|
| `3_600_000` (default — 1 hour) | Same sub chain within 1 hour overwrites current snapshot |
| `0` | Every update creates a new snapshot — full audit trail |
| Custom (e.g., `5_000`) | 5-second debounce window per sub chain |

The 1-hour default is intentional. The primary use case for history is reporting (annual, quarterly, monthly), not rollback — sub-hour granularity is almost never needed for reporting. A later phase will add progressive snapshot compression (e.g., 1-year granularity after 18 months, quarterly after 12 months, monthly after 1 month) to bound storage growth while preserving reporting fidelity.

### Soft Delete is Informational

The `deleted` flag is purely informational for the UI — it does **not** restrict storage operations. Updates and moves on deleted resources are allowed. The UI determines what users can and cannot do with deleted resources; the storage engine doesn't enforce it.

This means:
- `read()` returns deleted resources (with `meta.deleted: true`) — it does NOT return null for deleted resources
- `read()` returns null only when the resourceId has never existed
- Update on a deleted resource succeeds (caller provides the deleted snapshot's eTag)
- Move on a deleted resource succeeds
- Delete on an already-deleted resource succeeds (idempotent soft-delete — sets `deleted: true` again, new eTag)

### END_OF_TIME Constant

```typescript
const END_OF_TIME = '9999-01-01T00:00:00.000Z';
```

Used as the `validTo` sentinel for current snapshots, in SQL schema defaults, and partial index filters. Defined once as a named constant to prevent typo bugs.

### Types

```typescript
// ActClaim is already defined in @lumenize/auth and re-exported from @lumenize/nebula-auth.
// It stores the raw JWT actor chain per RFC 8693 — { sub: string; act?: ActClaim }.
// Stored as-is from the JWT — no transformation on write or read.
//
// Direct write:    { sub: "user-123" }
// Delegated write: { sub: "principal-123", act: { sub: "actor-456" } }
import type { ActClaim } from '@lumenize/nebula-auth';

interface SnapshotMeta {
  nodeId: number;         // DAG tree node — temporal: moves create new snapshots
  eTag: string;           // Opaque UUID — changes on every write including debounced
  validFrom: string;      // ISO 8601 — when this snapshot period began
  validTo: string;        // '9999-01-01T00:00:00.000Z' for current
  changedBy: ActClaim;    // Raw JWT actor chain — zero transformation
  deleted: boolean;
}

interface Snapshot {
  value: any;
  meta: SnapshotMeta;
}
```

### Storage Format

Resource values stored as `$lmz` preprocessed format in SQLite TEXT. Rich types (Map, Set, Date, cycles) round-trip through `preprocess()` / `postprocess()`.

### Timestamp Generation (`validFrom`)

**Problem**: In Cloudflare DOs, `Date.now()` returns the time when the current request/message started — the clock does not advance during synchronous execution. Multiple WebSocket messages may also share the same stopped clock. Yet `validFrom` must be strictly greater than the previous `validFrom` for each affected resource, and all resources in a single transaction should share the same `validFrom`.

**Algorithm** (adapted from Blueprint `calculateValidFrom()`):

```typescript
#calculateValidFrom(currentSnapshots: Map<string, Snapshot | null>): string {
  // Start with current wall clock
  let ts = Date.now();

  // Ensure strictly greater than ALL currentValidFroms in the batch
  for (const [, snap] of currentSnapshots) {
    if (snap) {
      const prev = new Date(snap.meta.validFrom).getTime();
      if (ts <= prev) {
        ts = prev + 1;  // +1ms to guarantee strict ordering
      }
    }
  }

  return new Date(ts).toISOString();
}
```

**Key properties:**
- Single `validFrom` for the entire transaction — all affected resources get the same timestamp
- Monotonically increasing per-resource: guaranteed `> previousValidFrom` even when the clock is stopped
- The `+1ms` bump is the same pattern Blueprint uses (line 24 of `temporal-mixin.js`)
- `previousSnapshot.validTo` is set to this `validFrom` (continuous timeline, no gaps)

**Single eTag per transaction**: All operations in a single `transaction()` call share the same `eTag` (a single `crypto.randomUUID()` call). Different resources getting the same eTag is fine — eTags are scoped to a resourceId and only compared within that scope.

### Optimistic Concurrency

Every write requires an eTag except a create. Subsequent writes must match the current eTag or get a conflict response.

### Response Protocol

The transaction is all-or-nothing. The result reflects that at the top level:

```typescript
type TransactionResult =
  | { ok: true;  eTags: Record<string, string> }           // all succeeded — resourceId → new eTag
  | { ok: false; conflicts: Record<string, Snapshot> }      // rolled back — conflicted resourceIds → current snapshots
```

- **Success**: new eTags keyed by resourceId — the only new information the caller needs.
- **Conflict**: full current snapshots for the conflicted items so the caller can merge and retry. Transaction is rolled back — nothing was written.

**Error boundary**: eTag mismatches produce `{ ok: false, conflicts }` — these are expected/recoverable and the caller can merge and retry. All other failures **throw** inside `ctx.storage.transactionSync()`, causing a full rollback. This follows the established Lumenize Mesh pattern where unrecoverable errors propagate as exceptions. Specifically:

- **Permission denied** → throws (caller lacks access — not recoverable by retrying)
- **Resource not found** (update/move/delete on a resourceId that was never created) → throws (programming error — the caller referenced a non-existent resource)
- **Create on existing resourceId** → throws (use update instead — see "Operation Descriptors")
- **Validation failures** (null value, empty resourceId) → throws

### Intentional Information Leak on `read()` for Non-Existent Resources

When `read()` is called with a resourceId that has never existed, it returns `null` without a permission check — there is no `nodeId` to check against. This means any authenticated user with access to the Star can probe whether a resourceId exists. This is an intentional tradeoff:

- ResourceIds are UUIDs — not guessable
- Callers are already authenticated with an activeScope for this Star
- The leak is existence only — no data is exposed
- Throwing would leak the same information (presence vs absence of error)

---

## SQL Schema

Star's SQLite, alongside the existing Nodes/Edges/Permissions tables from the DAG tree. The Snapshots table is created by the `Resources` class in its `#createSchema()` method.

```sql
CREATE TABLE IF NOT EXISTS Snapshots (
  resourceId TEXT NOT NULL,
  nodeId INTEGER NOT NULL,        -- DAG tree node — temporal (moves create new snapshots)
  validFrom TEXT NOT NULL,
  validTo TEXT NOT NULL DEFAULT '9999-01-01T00:00:00.000Z',
  eTag TEXT NOT NULL,
  changedBy TEXT NOT NULL,        -- JSON: raw JWT actor chain { sub, act? }
  deleted BOOLEAN NOT NULL DEFAULT 0,
  value TEXT NOT NULL,            -- $lmz preprocessed JSON
  PRIMARY KEY (resourceId, validFrom),
  FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- Fast lookup: current snapshot for a resource
CREATE INDEX IF NOT EXISTS idx_Snapshots_current
  ON Snapshots(resourceId, validTo)
  WHERE validTo = '9999-01-01T00:00:00.000Z';
```

**Design notes:**
- `WITHOUT ROWID` — compound TEXT PK, per CLAUDE.md SQL conventions
- `nodeId` is temporal — lives in the snapshot, not a separate table. Moving a resource to a different DAG node creates a new snapshot (the node assignment at each point in time matters for queries like CFDs)
- `value` stored as TEXT containing `JSON.stringify(preprocess(value))` — rich types preserved
- `changedBy` stored as JSON text — raw JWT `{ sub, act? }` structure, zero transformation
- `validTo = '9999-01-01T00:00:00.000Z'` marks the current snapshot (same as Blueprint prior art)
- Single `Snapshots` table for all resource types within this Star — no per-type tables. A type discriminator column arrives with the ontology in a later phase.
- Index on `(resourceId, validTo)` with partial filter for current-snapshot lookups

**Foreign key enforcement note:** The `FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)` constraint is declared but enforcement status depends on the Cloudflare DO SQLite runtime. Standard SQLite has foreign keys OFF by default; D1 has them ON. DO SQLite's behavior is undocumented. The existing DagTree tables (Edges, Permissions) declare FKs with the same pattern — no `PRAGMA foreign_keys = ON` anywhere. No CASCADE clauses are needed because Nodes are soft-deleted (never hard-deleted). The real integrity guard is `dagTree.requirePermission()` which validates nodeId existence via the in-memory cache before any write. If FK enforcement is off, the FK declaration serves as documentation. If on, it's a bonus safety net.

---

## Resources Public API

All public methods live on the `Resources` class. They are synchronous (no `async`) — `ctx.storage.sql` only. Access control is handled by calling `dagTree.requirePermission()` internally.

### Operation Descriptors

```typescript
// resourceId is the key in the Record — not repeated inside each descriptor.
// One operation per resource per transaction, enforced by the data structure.
type OperationDescriptor =
  | { op: 'create'; nodeId: number; value: any }  // new resource
  | { op: 'update'; eTag: string; value: any }    // new value, same node
  | { op: 'move';   eTag: string; nodeId: number } // new node, same value
  | { op: 'delete'; eTag: string }                // soft-delete
```

- **Create**: `nodeId` + `value`, no `eTag` — determines where the resource lives. Throws if `resourceId` already exists (even if deleted — use `update` to modify existing resources). Value must not be `null` or `undefined`.
- **Update**: `eTag` + `value`, no `nodeId` — stays in current node. Works on deleted resources (see "Soft Delete is Informational"). Value must not be `null` or `undefined`.
- **Move**: `eTag` + `nodeId`, no `value` — value copied from current snapshot into new snapshot with new nodeId. Works on deleted resources. Move to the same node is an idempotent no-op (returns current eTag, no new snapshot created).
- **Delete**: `eTag` only — soft-delete, `nodeId` read from current snapshot. Idempotent — deleting an already-deleted resource succeeds (sets `deleted: true` again, new eTag).

Extra fields on operation descriptors (e.g., `eTag` on a create) are silently ignored for now. Runtime validation of the full API contract is planned as follow-on work once the API surface stabilizes (see Follow On Work).

For the rare case where a resource needs to move AND update simultaneously, use two separate transactions. The move returns a new eTag; the subsequent update provides that eTag, so if anything changed between the two calls (interleaving from another client), the eTag check catches it.

### Public Methods

```typescript
transaction(ops: Record<string, OperationDescriptor>): TransactionResult
// Accepts mixed create/update/move/delete ops in a single atomic call.
// Keys are resourceIds — one operation per resource, enforced by the data structure.
// See "DAG Tree Integration" section for the full transaction flow.

read(resourceId: string): Snapshot | null
// Returns current snapshot (including deleted resources with meta.deleted: true).
// Returns null only if the resourceId has never existed.
```

These are plain methods on Resources — not `@mesh()` decorated. Auth is handled at two layers: Star's `@mesh() resources()` entry point ensures callContext is set, and `dagTree.requirePermission()` enforces per-node access control inside each method.

### Private Methods

```typescript
#createSchema(): void
// Creates the Snapshots table and partial index (called from constructor)

#bootstrapConfig(): void
// Writes default config values if missing (called from constructor)

#getCurrentSnapshot(resourceId: string): Snapshot | null
// SQL query: WHERE resourceId = ? AND validTo = END_OF_TIME

#calculateValidFrom(currentSnapshots: Map<string, Snapshot | null>): string
// Monotonic timestamp algorithm — see "Timestamp Generation" section

#writeSnapshot(resourceId: string, current: Snapshot | null, op: OperationDescriptor,
               validFrom: string, eTag: string, changedBy: ActClaim): void
// By the time this is called, current has already been read and eTag-checked.
// Handles debounce logic, timeline management, snapshot creation.
```

**`changedBy` construction**: Extracted from the authenticated caller's JWT claims via the callContext getter — never from the client. Not included in operation descriptors. Built once at the top of `transaction()` and passed through to `#writeSnapshot()`.

```typescript
const cc = this.#getCallContext();
const payload = cc.originAuth?.claims as NebulaJwtPayload;
const changedBy: ActClaim = { sub: payload.sub, ...(payload.act && { act: payload.act }) };
```

Note: `dagTree.requirePermission()` returns `sub`, but it's called per-operation inside the transaction (step 8) while `changedBy` is built once before the transaction loop (step 4). Since they're in different scopes and `changedBy` also needs the full `act` chain (which `requirePermission` doesn't return), we read from callContext directly.

**Debounce window check**: A write is debounced (overwrites in place) when both conditions are met:
1. The current snapshot's `validFrom` is within the debounce window: `Date.now() - new Date(current.meta.validFrom).getTime() < debounceMs`
2. The `changedBy` matches: `JSON.stringify(current.meta.changedBy) === JSON.stringify(newChangedBy)`

String equality works because the JWT actor chain is already canonical — no deep equality needed. If either condition fails, a new snapshot is created (closing the current snapshot's `validTo`).

**Non-debounced writes (new timeline entry)**: When the debounce check fails (different sub chain, outside window, or first write), a new snapshot is created. The previous current snapshot is closed by setting its `validTo` to the new `validFrom`, then the new snapshot is INSERTed with `validTo = END_OF_TIME`. Since `validFrom` is part of the PK `(resourceId, validFrom)`, this is always an INSERT — the old row's `validTo` is UPDATEd, then a new row is INSERTed.

**Debounced writes (overwrite in place)**: When both debounce conditions are met, the existing row is UPDATEd in place — new `value`, `eTag`, `changedBy`, but same `validFrom` (same PK). No timeline entry is created.

---

## Storage Configuration

For Phase 5.1, `debounceMs` is a Star-wide default stored in the `'config'` KV key — the same bag used by `getUniverseConfig/setUniverseConfig` and `getGalaxyConfig/setGalaxyConfig`. **Note:** `get/setStarConfig` currently only exists on `StarTest` (test subclass), not on `Star` itself. This phase must add `getStarConfig/setStarConfig` to `Star` (matching the Universe/Galaxy pattern) and remove the duplicates from `StarTest`. Additionally, Universe and Galaxy currently type their config values as `string` — all three must be updated to `unknown` (with `Record<string, unknown>` KV types) so config can store rich types like numbers natively. DO KV storage handles rich types via structured clone — no serialization needed.

| Config Key | Default | Meaning |
|---|---|---|
| `debounceMs` | `3_600_000` (1 hour) | Same sub chain within window overwrites current snapshot in place |

DO's KV storage handles rich types natively via structured clone — no serialization needed. Config values are stored as their native types (numbers, not strings). `debounceMs` is stored and read as a `number`.

**Bootstrap** (in `Resources.#bootstrapConfig()`): Resources writes defaults into the config bag on startup if missing. Tests exercise different modes via `setStarConfig('debounceMs', 0)`.

```typescript
// Phase 5.1: hardcoded defaults. Later phases add per-resource-type overrides via ontology.
// Only write if missing keys — writes are 1,000x more expensive than reads in DOs.
const config = this.#ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
let dirty = false;
if (!('debounceMs' in config)) { config.debounceMs = 3_600_000; dirty = true; }
if (dirty) this.#ctx.storage.kv.put('config', config);
```

When the ontology arrives in a later phase, per-resource-type overrides will layer on top — each resource type can have its own debounce setting, falling back to this Star-wide default.

These are not per-DAG-node settings — the DAG tree defines access control hierarchy, not resource type configuration.

---

## DAG Tree Integration

The DAG tree handles access control. The `nodeId` for each resource lives in the current snapshot — permission checks read it from there. Resources calls `this.#dagTree.requirePermission(nodeId, tier)` which throws on failure.

**Flow for `transaction()`:**

1. Read current snapshots for all resourceIds in the batch (outside `transactionSync` — for `validFrom` calculation)
2. Calculate single `validFrom` via `#calculateValidFrom()` — guaranteed `> max(currentValidFroms)`
3. Generate single `eTag` via `crypto.randomUUID()`
4. Build `changedBy` from callContext JWT claims
5. Start `ctx.storage.transactionSync()` — if any step below fails, it all rolls back:
6. **Re-read current snapshots** inside the transaction (authoritative read for eTag checking)
7. Validate operations — create on existing resourceId throws, update/move/delete on non-existent resourceId throws, null values throw, empty resourceIds throw
8. Permission checks — all ops require `write`:
   - **Create**: `dagTree.requirePermission(nodeId, 'write')` — nodeId from the operation descriptor
   - **Update**: `dagTree.requirePermission(nodeId, 'write')` — nodeId from re-read snapshot
   - **Move**: `dagTree.requirePermission(oldNodeId, 'write')` AND `dagTree.requirePermission(newNodeId, 'write')`
   - **Delete**: `dagTree.requirePermission(nodeId, 'write')` — nodeId from re-read snapshot
9. Check eTags against re-read snapshots, apply debounce logic — eTag mismatches produce `{ ok: false, conflicts }` (returned, not thrown)
10. Write all changes (using pre-calculated `validFrom` and `eTag`)
11. Close `ctx.storage.transactionSync()`

Empty ops Record (`{}`) is a no-op: returns `{ ok: true, eTags: {} }` immediately without starting a transaction.

**`transactionSync` availability**: `ctx.storage.transactionSync()` is required for the synchronous transaction pattern. If this API is not available at the current `compatibility_date`, update wrangler and the compatibility date immediately rather than waiting for Phase 5.2 (which needs a wrangler update for DWL support anyway).

**Why reads happen twice**: The initial read (step 1) is only for `#calculateValidFrom()` — it needs the current `validFrom` values to ensure monotonic timestamps. The authoritative read is inside `transactionSync` (step 6), which provides the eTag values used for conflict detection. Even though Phase 5.1's `transaction()` is fully synchronous (no interleaving possible), the re-read pattern is implemented from the start so the code is correct when Phase 5.2 adds an `await` to the DWL call between steps 4 and 5. At that point, other operations can interleave during the DWL call, and the re-read inside `transactionSync` catches any changes. Both reads hit SQLite's cache, so the cost is negligible.

**Flow for `read()`:**

1. Client calls `resources().read(resourceId)`
2. Resources reads current snapshot — returns null if resourceId has never existed (see "Intentional Information Leak" above)
3. Resources calls `dagTree.requirePermission(nodeId, 'read')` — throws if denied, includes admin override
4. Resources returns the snapshot including deleted resources (permission check is internal — no data leaks before it completes)

---

## Testing Strategy

### Test Location

`test/test-apps/baseline/` — extend the existing e2e test infrastructure.

### New Test File

`test/test-apps/baseline/star-resources.test.ts`

### Test Invariants

Every test that stores a resource value must use an object that includes a **Set**, a **Map**, a **Date**, and a **Cycle** to guard against accidental `JSON.stringify()` usage. This ensures `@lumenize/structured-clone` is actually being used.

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

Also, note that no manual serialization is to be done for going over the wire. Let the `lmz.call()` transport layer handle this serialization.

### NebulaClientTest Additions

```typescript
// Fire-and-forget calls via continuation chain through resources()
// Follows the established lmz.call('BINDING', instanceName, remote, handler) pattern

callStarResourcesTransaction(starName: string, ops: Record<string, OperationDescriptor>): void {
  this.resetResults();
  const remote = this.ctn<Star>().resources().transaction(ops);
  this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
}

callStarResourcesRead(starName: string, resourceId: string): void {
  this.resetResults();
  const remote = this.ctn<Star>().resources().read(resourceId);
  this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
}
```

### Test Cases

**Basic CRUD via transaction():**
- Single create op — returns `{ ok: true, eTags: { [resourceId]: newETag } }`
- Read it back — value deep-equals including Map, Set, Date, cycle
- Single update op (correct eTag) — returns `{ ok: true, eTags }` with new eTag
- Single update op (wrong eTag) — returns `{ ok: false, conflicts }` with current snapshot
- Single delete op (correct eTag) — soft delete, returns `{ ok: true, eTags }` with new eTag
- Read deleted resource — returns snapshot with `meta.deleted: true` (not null)

**Batch transactions:**
- Mixed create/update/move/delete ops in one transaction — all succeed atomically
- One conflict in a batch — entire transaction fails, nothing written
- Multiple creates in one transaction

**Debounce:**
- Same sub chain within debounce window — overwrites in place (no new timeline entry)
- Different sub chain within debounce window — creates new snapshot
- Same sub chain outside debounce window — creates new snapshot
- `debounceMs: 0` — every update creates a new snapshot (full audit trail)

**Temporal storage:**
- Multiple updates create proper timeline with `validFrom`/`validTo` chain
- `validTo` of previous snapshot = `validFrom` of new snapshot
- Current snapshot always has `validTo = '9999-01-01T00:00:00.000Z'`

**DAG integration:**
- User with `write` permission on node → transaction succeeds
- User with `read` permission on node → transaction rejected, read succeeds
- User with no permission → both rejected
- Admin grants permission → previously rejected user can now write

**Resource moves:**
- Move resource to new node — creates new snapshot with new nodeId, value copied from current snapshot
- Move requires `write` on both old and new nodes
- Move with `write` only on source — rejected
- Move with `write` only on destination — rejected

**Resource lifecycle edge cases:**
- Create on already-existing resourceId (including deleted) — throws (use update to modify existing resources)
- Update a deleted resource (correct eTag) — succeeds (deleted is informational, not a gate)
- Move a deleted resource (correct eTag) — succeeds (deleted is informational)
- Delete an already-deleted resource (correct eTag) — succeeds idempotently (new eTag)
- Move to the same node it's already on — idempotent no-op (returns current eTag, no new snapshot)

**eTag abuse:**
- Fabricated eTag (random UUID, never existed) — conflict
- eTag from a historical snapshot (valid UUID but not current) — conflict
- eTag from a different resourceId — conflict (eTags are checked per-resource)
- Concurrent updates from two clients with the same eTag — only one succeeds

**Input validation:**
- Empty ops Record (zero operations) — no-op, returns `{ ok: true, eTags: {} }`
- Create without nodeId / update without eTag / move without nodeId — TypeScript prevents at compile time, but runtime should still validate and throw
- Create with an eTag provided (extra field) — silently ignored
- nodeId that doesn't exist in the DAG tree — fails at `requirePermission` (DAG tree throws)
- Empty string resourceId — throws

**Value edge cases:**
- null or undefined value on create/update — throws (resources must have a value)
- Very large value — should work up to DO storage limits
- Value containing only rich types (Map as root, not nested in an object)

---

## Success Criteria

- [x] `requirePermission` made public on DagTree (remove `#` prefix)
- [x] `Resources` class created in `apps/nebula/src/resources.ts` — constructor injection of `(ctx, getCallContext, dagTree, onChanged)`
- [x] Star instantiates Resources in `onStart()`, exposes via `@mesh() resources()`
- [x] `getStarConfig/setStarConfig` moved from StarTest to Star (matching Universe/Galaxy pattern), value type changed to `unknown`
- [x] Universe and Galaxy config methods updated from `value: string` to `value: unknown` (with `Record<string, unknown>` KV types)
- [x] Resources creates Snapshots table and partial index in `#createSchema()`
- [x] Resources bootstraps `debounceMs` config default (native number) in `#bootstrapConfig()`
- [x] `END_OF_TIME` constant defined and used consistently
- [x] `transaction()` accepts `Record<string, OperationDescriptor>` — one op per resourceId, enforced by data structure
- [x] Success returns `{ ok: true, eTags: Record<string, string> }` — resourceId → new eTag
- [x] Conflict returns `{ ok: false, conflicts }` with current snapshots — entire transaction rolled back
- [x] Permission/validation errors throw (not `ok: false`) — follows Mesh error pattern
- [x] `read()` returns current snapshot with rich types preserved (including deleted resources with `meta.deleted: true`)
- [x] `read()` returns null only for never-created resourceIds (intentional — see design note)
- [x] `changedBy` constructed from JWT claims — raw RFC 8693 actor chain (`ActClaim` from `@lumenize/nebula-auth`)
- [x] Debounce: same sub chain within window overwrites in place
- [x] `nodeId` in Snapshots table — temporal (move ops create new snapshots with value copied from current)
- [x] Move to same node is an idempotent no-op
- [x] DAG tree gates access (write permission required for transaction, read for read)
- [x] Move requires `write` on both source and destination nodes
- [x] Deleted resources allow update, move, and re-delete (deleted is informational)
- [x] Create on existing resourceId throws (even if deleted)
- [x] Re-read inside `transactionSync` for authoritative eTag checking
- [x] Test values include Map, Date, and Cycle
- [x] All tests pass in `test/test-apps/baseline/`

---

## Follow On Work

- Progressive snapshot compression — age-based granularity reduction (e.g., annual after 18 months, quarterly after 12 months, monthly after 1 month). Bounds storage growth while preserving reporting fidelity at each time horizon. Similar to what Blueprint implemented.
- Bulk demo data load — LLM/agent generates full resource timelines (create → updates → moves → deletes) with pre-computed `validFrom` chains, bulk-inserted into Star. Bypasses eTag checking (loading history, not competing with live writers), but still validates timeline consistency (monotonic `validFrom`, continuous `validTo` chains) and permission checks on target nodes. This likely supersedes the Blueprint feature of caller-provided `validFrom` — that was also used for cross-DO synchronized updates, but Blueprint used `validFrom` as its eTag and had finer-grained multi-DO transactions. With our separate eTag + single-DO transaction model, caller-provided `validFrom` may never be needed outside of bulk load.
- `readHistory()` — deferred until ResourceHistory is implemented; writing it now would require rewriting later
- Moving old snapshots to `ResourceHistory` — future out-of-band operation
- DWL guard dispatch in transaction protocol (double eTag check) — added when DWL arrives
- NebulaClient wrapper methods — will unify internal resource state management and UI update events in a later phase
- Runtime validation of the full API contract (operation descriptors, config values, etc.) — once the API surface stabilizes, use the tsc-in-DWL capability from Phase 5.2 to validate inputs against TypeScript types at runtime
- DWL / tsc validation (Phase 5.2)
- Multi-resource queries (Phase 5.2.5) — GraphQL-style nested reads in a single round trip. Server-side relationship resolution using the ontology (e.g., invoice → rows → products without the client knowing intermediate IDs). All in one synchronous call since everything is in Star's SQLite.
- Subscriptions / fanout (Phase 5.3)
- Capability tickets (Phase 5.4)
- Schema evolution (Phase 5.5)
- HTTP transport (Phase 5.6)

---

## Implementation Order

### Step 1: Prerequisites (DagTree + config)
1. Make `#requirePermission` public on DagTree (`requirePermission`) — no `@mesh()` decorator needed since it's called internally by Resources
2. Move `getStarConfig/setStarConfig` from StarTest to Star (matching Universe/Galaxy pattern), change value type from `string` to `unknown`, remove the duplicates from StarTest
3. Update Universe and Galaxy config methods from `value: string` to `value: unknown` (and `Record<string, unknown>` KV types) — brings all three in line
4. Verify existing tests still pass

### Step 2: Resources Class Scaffolding
4. Create `apps/nebula/src/resources.ts` with `Resources` class
5. Constructor injection: `(ctx, getCallContext, dagTree, onChanged)`
6. Implement `#createSchema()` — Snapshots table and partial index
7. Implement `#bootstrapConfig()` — write `debounceMs` default if missing
8. Define `END_OF_TIME` constant
9. Wire up in Star's `onStart()` — instantiate Resources after DagTree, add `@mesh() resources()` entry point

### Step 3: Core Storage Internals
10. Implement `#getCurrentSnapshot(resourceId)` — SQL query for current snapshot, deserialize with `postprocess()`
11. Implement `#calculateValidFrom(currentSnapshots)` — monotonic timestamp algorithm
12. Implement `changedBy` extraction from callContext
13. Implement `#writeSnapshot(resourceId, current, op, validFrom, eTag, changedBy)` — debounce logic, timeline management, `preprocess()` for storage

### Step 4: Public API — `read()`
14. Implement `read(resourceId)` — permission check via `dagTree.requirePermission`, return snapshot or null
15. Add `callStarResourcesRead` method to NebulaClientTest
16. Write basic read tests (not found, permission denied)

### Step 5: Public API — `transaction()` (create first)
17. Implement `transaction()` with create ops only — validation, permission check, write, response
18. Add `callStarResourcesTransaction` method to NebulaClientTest
19. Write create + read-back tests (including rich type round-trip with Map, Date, Set, cycle)

### Step 6: Expand `transaction()` (update, delete, move)
20. Add update op handling — eTag check, debounce logic, write
21. Add delete op handling — soft delete
22. Add move op handling — permission check on both nodes, value copy
23. Write tests for each op type individually

### Step 7: Batch Transactions + Conflicts
24. Implement batch transaction logic — mixed ops, single `validFrom`/`eTag`, all-or-nothing rollback
25. Implement conflict response — eTag mismatch returns `{ ok: false, conflicts }`
26. Write batch tests and conflict tests

### Step 8: Edge Cases
27. Test debounce with different sub chains, window boundaries, `debounceMs: 0`
28. Test all lifecycle edge cases (create-on-existing, update-deleted, move-to-same-node, etc.)
29. Test input validation (empty ops, null values, empty resourceId, nonexistent nodeId)
30. Test eTag abuse (fabricated, historical, cross-resource)

### Step 9: DAG Integration Tests
31. Permission-gated tests — write permission allows transaction, read allows read, no permission denies both
32. Admin override tests
33. Move permission tests — requires write on both source and destination

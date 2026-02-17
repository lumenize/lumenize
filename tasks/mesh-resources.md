# Mesh Resources (DWL Architecture)

**Status**: Phase 0 — Design (all DWL spikes complete, core API decisions made, remaining: full API shape + MDX draft)
**Prior Art**: `tasks/icebox/mesh-resources.md` and `tasks/icebox/resources.mdx` (registration-on-DO approach — temporal storage design, snapshot shape, URI scheme, and response protocol carry forward; registration API and schema strategy are replaced by the DWL approach)

## Goal

Build a resource system for Lumenize Mesh where **user-provided code runs in a Dynamic Worker Loader (DWL) isolate** and **Lumenize provides the storage engine as a Durable Object**. The user's DWL code handles resource configuration, guards, and validation. The storage DO (LumenizeResources) handles temporal storage, subscriptions, fanout, and lifecycle — the same core responsibilities from the icebox design, but now as a service consumed by the user's code rather than configured by it.

This architecture is motivated primarily by **Lumenize Nebula** — a vibe coding platform where the user provides all code over the wire as config strings. DWL makes this possible without deploying separate Workers per user.

## Decisions Summary

Quick reference for all decisions made during Phase 0 design:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **DWL base class name** | `ResourcesWorker` | Parallels `LumenizeDO`/`LumenizeWorker`/`LumenizeClient` naming. Doesn't encode DWL deployment detail. Works for deployed Workers too. |
| **DO-side class** | `LumenizeResources extends LumenizeDO` | Option B — specialized DO with temporal storage + DWL integration. Traditional users can extend without DWL. |
| **Guard dispatch mechanism** | `lmz.call(stub, continuation)` | Uses higher-level Mesh API, not raw `__executeOperation`. CallContext propagates automatically. |
| **`lmz.call()` DWL addressing** | New overload: `lmz.call(stub, continuation)` | DWL stubs come from `LOADER.get()`, not `env`. Overload lives in `LumenizeResources`, not base `LumenizeDO`. |
| **Multiple entrypoints per DWL** | Supported — `stub.getEntrypoint('ClassName')` | Enables future `IntegrationsWorker`, `WorkflowsWorker` alongside `ResourcesWorker` in same DWL module. |
| **Architecture** | Inverted — DO calls OUT to DWL | DWL is callback provider. DO owns storage, subscriptions, fanout. |
| **Plain RPC for guards** | Rejected | Would duplicate callContext propagation logic that `lmz.call()` already handles. |
| **`transaction()` API** | `lmz.transaction([lmz.upsert(...), lmz.delete(...), ...])` | DWL call opens input gates, losing automatic transactional behavior. Single `transaction()` call with mixed ops minimizes RPC round-trips (billing) and enables manual transaction protocol. |
| **Convenience functions** | `lmz.upsert(id, val)`, `lmz.upsert(id, val, eTag)`, `lmz.upsert(snapshot, val)` — same 3 patterns for `delete` | Pure functions returning operation descriptors. eTag resolved from local cache when not explicit. Snapshot overload extracts both resourceId and eTag. |
| **Manual transaction protocol** | Read→eTag check→DWL guards→recheck eTags→write (in `transactionSync`) | Double eTag check: optimistic (pre-DWL, fail fast) + pessimistic (post-DWL, catch races). `transactionSync` for write phase ensures all-or-nothing. |

## Core Architecture (Inverted Model)

The DWL isolate is a **callback provider** — the LumenizeResources DO calls *into* it when it needs guard decisions, resource config, or validation. The DWL code never calls out to storage or Mesh directly.

```
Request arrives (Mesh or HTTP)
  → LumenizeResources DO (has storage, subscriptions, Mesh)
    → Needs guard decision? Calls out to DWL isolate
    → Needs resource config? Calls out to DWL isolate
    → Needs validation? Calls out to DWL isolate
    → Storage, subscriptions, fanout — all on the DO
  ← Response back to caller
```

```
┌─────────────────────────────────────────────────┐
│  LumenizeResources DO (Lumenize-provided)       │
│  - Extends LumenizeDO                           │
│  - Snodgrass temporal storage                   │
│  - Subscription tracking & fanout               │
│  - Optimistic concurrency (eTag)                │
│  - DWL stub management & code versioning        │
│  - HTTP transport                               │
│  - Calls OUT to DWL for guards/config/validation│
│  - Discovery endpoint                           │
└──────────────┬──────────────────────────────────┘
               │ lmz.call() to DWL (DO calls DWL, not reverse)
               ▼
┌─────────────────────────────────────────────────┐
│  User's DWL Worker (dynamic isolate)            │
│  - Extends ResourcesWorker                      │
│    (which extends LumenizeWorker)               │
│  - Resource config (slugs, debounce, history)   │
│  - Guard methods (access control)               │
│  - Validation methods                           │
│  - Has this.lmz.callContext for auth             │
│  - Never touches storage or subscriptions       │
│  - Can export multiple WorkerEntrypoints        │
│    (e.g., ResourcesWorker + IntegrationsWorker) │
└─────────────────────────────────────────────────┘
```

### Why Inverted?

The original task file had the DWL isolate calling *out* to LumenizeResources. The inverted model is better because:

1. **DWL doesn't need DO bindings** — `DurableObjectNamespace` is not structured-clonable (confirmed by spike test 4), so you can't pass it into DWL `env`. The inverted model avoids this entirely.
2. **Simpler DWL code** — the vibe coder writes config and guard methods. No Mesh routing, no storage calls, no subscription management.
3. **LumenizeResources owns the full lifecycle** — storage, subscriptions, fanout, guard dispatch. One place for all the complexity.
4. **Auth propagation is natural** — the DO has the call context from the original request. When it calls the DWL, it propagates context. The DWL guard accesses `this.lmz.callContext.originAuth` exactly like a non-DWL guard would.

### How DWL Fits

Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) spawns lightweight isolates from code strings at runtime. Key properties:

- **`loader.get(id, callback)`** — returns a stub for the dynamic worker. The callback provides `mainModule`, `modules`, `env`, and `globalOutbound`.
- **`stub.getEntrypoint('ClassName')`** — returns an RPC-capable stub for a named `WorkerEntrypoint` class exported by the DWL code. Full structured-clone RPC — objects, arrays, nested data all work.
- **`env` bindings** — supports structured-clonable types and service bindings (including `ctx.exports`). Does NOT support `DurableObjectNamespace` (see spike results).
- **`globalOutbound`** — controls network access. Can be set to `null` (total sandbox) or a service binding (controlled egress). Nebula uses this for security.
- **No Durable Objects in DWL** — DWL isolates cannot export DO classes. The DO must be a separate, pre-deployed binding.
- **Caching** — isolates are cached by ID but no guarantee two requests hit the same isolate. Statelessness is assumed.
- **Closed beta** — DWL requires sign-up for production; local dev available now with wrangler 4.66.0+.

### Why This Split?

The icebox design put everything on the DO — schema, guards, validation, storage, subscriptions. This works for traditional deploy-time development but doesn't work for Nebula where:

1. **User code arrives as strings over the wire** — can't be part of a deployed Worker bundle.
2. **Different users need different schemas/guards on the same infrastructure** — DWL isolates provide per-user sandboxing.
3. **Users want to import their own validation libraries** — DWL `modules` dict supports this.
4. **Security isolation** — `globalOutbound: null` plus controlled `env` bindings means user code can only talk to services we explicitly provide.

For traditional (non-Nebula) Lumenize users who deploy their own Workers, the same architecture still works — they just write a normal Worker that calls LumenizeResources via service binding instead of using DWL. The storage DO API is the same either way.

## DWL Spike Results

**Spike location**: `experiments/dwl-spike/`
**Tested with**: wrangler 4.66.0, `wrangler dev`, manual curl

### Experiments and Results

| Test | Question | Result | Implications |
|------|----------|--------|-------------|
| **Test 1** ✅ | Basic DWL fetch works locally? | Yes — `LOADER.get()` + `getEntrypoint().fetch()` works | wrangler 4.66.0 supports DWL locally |
| **Test 2** ✅ | Can host pass env vars to DWL? | Yes — structured-clonable types pass through, visible in `env` | Can inject tenant config, feature flags |
| **Test 3** ✅ | **Can DO call DWL WorkerEntrypoint methods?** | **Yes — full RPC works.** Called `getResourceConfig()`, `guard()`, `validate()` — all returned structured results | **Confirms inverted architecture is viable** |
| **Test 4** ❌ | Can host pass DO namespace binding to DWL env? | No — `DataCloneError: DurableObjectNamespace does not support serialization` | DWL cannot get DO stubs directly. Inverted model avoids this. |
| **Test 5** ✅ | **Can DWL extend `LumenizeWorker`?** | **Yes — works fully.** DWL imports bundled `@lumenize/mesh`, extends `LumenizeWorker`, custom methods work. `this.lmz` exists (type: "LumenizeWorker"), `this.ctn()` works, `this.lmz.callContext` correctly throws outside a mesh call. | **Confirms DWL code can use full Mesh base class** |
| **Test 6** ✅ | **Does Mesh `callContext` propagate to DWL?** | **Yes — full propagation.** Calling `__executeOperation()` with a proper Mesh envelope makes `this.lmz.callContext` available. Guard methods successfully read `originAuth.claims.role` and make access control decisions. | **Confirms guards in DWL can read auth claims, callChain, etc.** |

### Key Findings

- **`LOADER.get(id, callback)`** returns a stub. Call **`stub.getEntrypoint('ClassName')`** for named entrypoints — `.fetch()` is not directly on the stub.
- **RPC between DO → DWL is full-fidelity** — objects, arrays, nested structures all round-trip cleanly.
- **Wrangler config**: `"worker_loaders": [{ "binding": "LOADER" }]` — wrangler recognizes and lists it as "Worker Loader" binding.
- **vitest-pool-workers**: Not tested yet. DWL support is uncertain. The spike used `wrangler dev` with manual curl.

### Mesh-in-DWL Details (Tests 5 & 6)

**Bundling `@lumenize/mesh` for DWL**: Built with esbuild (`experiments/dwl-spike/build-mesh-module.mjs`). Entry point: `@lumenize/mesh`. Externals: `cloudflare:workers`, `node:async_hooks`. Must include `cron-schedule` and `ulid-workers` in bundle (DWL can't resolve npm modules). Bundle size: ~140KB. Passed to DWL via `modules: { 'mesh-bundle.js': bundledSource }`.

**`@mesh` decorator alternative**: DWL code is plain JS strings — can't use TypeScript decorators. Instead, mark methods as mesh-callable using `Symbol.for('lumenize.mesh.callable')` on prototypes:
```javascript
const MESH_CALLABLE = Symbol.for('lumenize.mesh.callable');
MyApp.prototype.getResourceConfig[MESH_CALLABLE] = true;
MyApp.prototype.runGuardCheck[MESH_CALLABLE] = true;
```

**Mesh envelope format for `__executeOperation()`**:
```typescript
{
  version: 1,
  chain: preprocess([
    { type: 'get', key: 'methodName' },
    { type: 'apply', args: [...] },
  ]),
  callContext: {
    callChain: [{ type: 'LumenizeDO', bindingName: '...', instanceName: '...' }],
    originAuth: { sub: 'user-123', claims: { role: 'editor' } },
    state: {},
  },
  metadata: {
    caller: { type: 'LumenizeDO', bindingName: '...', instanceName: '...' },
    callee: { type: 'LumenizeWorker', bindingName: '...' },
  },
}
```

**Test 6 results in detail**:
- `getCallContextInfo()` → reads `originAuth.sub`, `claims.role`, `callChain` length and entries ✅
- `runGuardCheck('upsert', 'settings')` with `role: 'admin'` → allowed ✅
- `runGuardCheck('upsert', 'settings')` with `role: 'editor'` → rejected ("Admin only for settings upsert") ✅

### What's NOT Yet Validated

- **DWL in vitest** — can `@cloudflare/vitest-pool-workers` handle `worker_loaders` bindings? **[Test later]**
- **Optimized DWL bundle** — tested: `LumenizeWorker`-only entrypoint reduces from 140KB → 102KB unminified (27% smaller), 56KB → 40KB minified (29% smaller). OCAN, lmz-api, structured-clone, and debug are the bulk. LumenizeDO, LumenizeClient, ClientGateway, alarms, SQL, tab-id all shake away. 40KB minified is fine for DWL (loads from memory). Could trim further if the DWL base class doesn't need `call()`/`ctn()`.

## Vibe Coder's DWL Code — Target API

The vibe coder extends `ResourcesWorker` (which extends `LumenizeWorker`). They implement a `resources` property and guard/validation methods. The base class handles dispatch — the DO calls `runGuards()` via `lmz.call()`, the base class looks up the guard array for the given slug and executes each in sequence.

A single DWL module can export multiple `WorkerEntrypoint` classes (e.g., `ResourcesWorker` now, `IntegrationsWorker` later). The DO addresses each independently via `stub.getEntrypoint('ClassName')`.

```typescript
// What the vibe coder writes — uploaded as a string to Nebula
import { ResourcesWorker, ForbiddenError, ValidationError } from '@lumenize/mesh';

export class ProjectResources extends ResourcesWorker {
  resources = {
    settings: {
      history: true,
      guards: [this.requireAdmin],
    },
    task: {
      debounceMs: 5_000,
      history: true,
      guards: [this.requireMember, this.validateTask],
    },
    presence: {
      history: false,
      // No guards — anyone connected can update presence
    },
  };

  requireAdmin(info) {
    if (this.lmz.callContext.originAuth?.claims?.role !== 'admin') {
      throw new ForbiddenError('Admin only');
    }
  }

  requireMember(info) {
    const role = this.lmz.callContext.originAuth?.claims?.role;
    if (!['admin', 'member'].includes(role)) {
      throw new ForbiddenError('Members only');
    }
  }

  validateTask(info) {
    if (info.operation === 'upsert' && !info.incoming.title?.trim()) {
      throw new ValidationError('Task title required');
    }
  }
}
```

### How the DO Calls DWL

```typescript
// Inside LumenizeResources DO — simplified flow
const dwlStub = this.env.LOADER.get(tenantId, () => ({
  compatibilityDate: '2025-09-12',
  mainModule: 'main.js',
  modules: { 'main.js': userCodeString, /* @lumenize/mesh source */ },
  env: { /* tenant config */ },
  globalOutbound: null,  // sandbox
}));
const entrypoint = dwlStub.getEntrypoint('ProjectResources');

// Get resource config (cached after first call per code version)
// Uses lmz.call() with new stub overload — callContext propagates automatically
const config = await this.lmz.call(entrypoint, this.ctn().getResources());
// Returns: { settings: { history: true }, task: { debounceMs: 5000, history: true }, presence: { history: false } }
// Note: guard functions are NOT serialized — only the serializable config is returned

// Run guards for this operation — uses lmz.call() so callContext propagates
// ResourcesWorker base class dispatches to the right guard array
await this.lmz.call(entrypoint, this.ctn().runGuards('task', {
  operation: 'upsert',
  resourceType: 'task',
  resourceId: 'task-42',
  incoming: { title: 'Fix bug', assignee: 'alice' },
  snapshot: currentSnapshot,
}));
// If guards pass: returns void. If rejected: throws ForbiddenError or ValidationError.

// DO handles storage, subscriptions, fanout — DWL is done
```

**Why `lmz.call()` instead of direct RPC?** Guards need `this.lmz.callContext` to read `originAuth.claims`. `lmz.call()` builds the Mesh envelope and propagates callContext automatically — the same mechanism tested in spike test 6. Using plain RPC would require manually passing and hydrating callContext, duplicating what `lmz.call()` already does.

**Why `lmz.call(stub, continuation)` overload?** Current `lmz.call()` takes `(bindingName, instanceName, continuation)` and looks up `env[bindingName]`. A DWL stub comes from `LOADER.get()`, not from `env`. The new overload accepts a stub directly. Implementation lives in `LumenizeResources`, not in base `LumenizeDO`.

### Code Versioning

LumenizeResources tracks the code hash (md5 or similar) of the user's DWL code string. When Nebula updates a tenant's code:
- The DO detects the hash change
- New DWL isolate spins up with the new code (using a version-keyed ID like `${tenantId}-${codeHash}`)
- Resource config is re-read from the new code
- Old isolate is evicted naturally by DWL caching

### `lmz.call()` Addressing for DWL — DECIDED

**Decision: Option 1 — new `lmz.call(stub, continuation)` overload.** LumenizeResources manages the DWL stub and calls Mesh with it directly. Call context propagates naturally through the Mesh envelope. Implementation lives in `LumenizeResources`, not in base `LumenizeDO`.

Option 3 (plain RPC with manual callContext) was rejected — it duplicates what `lmz.call()` already does and guards would need special hydration logic.

### Transaction API and Protocol

**Problem**: When a DO makes an `await` call to a Worker (including Workers RPC to DWL via `lmz.call()`), the DO's input gates open. Other requests and WebSocket messages can interleave. The automatic transactional behavior that Cloudflare provides — where all reads and writes within a single request are atomic, replicated to 3+ replicas, and rolled back on failure — breaks the moment you `await` out.

Additionally, each RPC call (including Workers RPC) incurs billing. Calling guards one resource at a time means N round-trips when the user changes N things — expensive and unnecessary since Nebula shifts more multi-resource operations to the client.

**Solution**: A `transaction()` method that accepts an array of operation descriptors (upserts and deletes mixed freely). Convenience functions build the descriptors — they're pure functions that return plain objects, no async, no side effects.

**Caller-facing API**:

```typescript
// Mix upserts and deletes in a single atomic transaction
await this.lmz.transaction([
  this.lmz.upsert('437x4...', newTaskValue),
  this.lmz.delete('12ade3...'),
  this.lmz.delete('dd780...', 'someETag'),
  this.lmz.delete(currentSnapshot),
]);
```

**Convenience function signatures** — each returns an operation descriptor object:

```typescript
// upsert — three ways to provide resourceId + eTag
this.lmz.upsert(resourceId, newValue)              // eTag from local cache (throws if not cached)
this.lmz.upsert(resourceId, newValue, eTag)         // explicit eTag string
this.lmz.upsert(currentSnapshot, newValue)           // extracts resourceId + eTag from snapshot

// delete — three ways to provide resourceId + eTag
this.lmz.delete(resourceId)                          // eTag from local cache (throws if not cached)
this.lmz.delete(resourceId, eTag)                    // explicit eTag string
this.lmz.delete(currentSnapshot)                     // extracts resourceId + eTag from snapshot

// All return: { op: 'upsert'|'delete', resourceId, eTag, value? }
```

**Local cache for eTag resolution**: When the client has been reading/subscribing to resources, it already has the current eTag in local state. The convenience functions reach into that cache so the vibe coder never has to think about eTags — they just say "upsert this" or "delete that" and the framework handles optimistic concurrency. If the resourceId isn't in the cache, the function throws immediately (you can't upsert or delete something you haven't read).

**Singular `read()` and batch `reads()`**: Read operations don't need the transaction protocol (no writes, no guard dispatch for reads in the common case). Keep `read(resourceType, resourceId)` as a singular convenience and `reads([...])` for batch reads.

**Transaction protocol for `transaction()`**:

```
Phase 1: Optimistic pre-check (synchronous, inside gates)
  - Read all current snapshots from storage for items in the batch
  - Check eTags match for each item
  - FAIL FAST if any eTag mismatch → return conflict response immediately
  - No DWL call needed — saves billing on obvious conflicts

Phase 2: Guard dispatch (async, gates OPEN during this)
  - Single lmz.call() to ResourcesWorker with the full batch
  - ResourcesWorker.runGuards() processes all items
  - Guards can span multiple resource types in one call
    (e.g., "upsert 3 tasks + delete 1 setting" = one DWL round-trip)
  - If any guard throws → return rejected response

Phase 3: Pessimistic recheck + write (synchronous, inside gates)
  - Re-read all snapshots, re-check eTags
  - If any eTag changed during Phase 2 → return conflict response
  - Perform all writes inside ctx.storage.transactionSync()
  - All-or-nothing: if any write fails, all roll back
```

**Why double eTag check?**
- Phase 1 (optimistic): Avoid the DWL call entirely if we already know it'll fail. Saves billing and latency.
- Phase 3 (pessimistic): Catch races from requests that interleaved during the Phase 2 `await`. Between Phases 1 and 3, other requests could have modified the same resources.

**Why `transactionSync()` in Phase 3?**
Steps 3's recheck + write are synchronous (no `await`), so input gates are closed. But without `transactionSync()`, a thrown error mid-write-loop could leave some rows written and others not — individual SQL statements aren't automatically grouped into a transaction. `transactionSync()` gives the explicit rollback boundary: all writes succeed or none do.

**Guard batching on `ResourcesWorker`**:
`runGuards()` accepts the full batch. Each item has its own `resourceType` and the base class routes to the appropriate guard array per item. One DWL round-trip covers guards for the entire transaction.

## Carried Forward from Icebox Design

The following design decisions from `tasks/icebox/mesh-resources.md` carry forward unchanged. They apply to the LumenizeResources storage DO regardless of whether the caller is a DWL isolate or a normal Worker.

### Temporal Storage (Snodgrass-Style)

Every resource uses snapshot-based temporal storage. Each change creates a snapshot with `validFrom`/`validTo` timestamps.

**Debounce** — rapid updates from the same sub chain overwrite the current snapshot in place:

| `debounceMs` | Behavior |
|---|---|
| `3_600_000` (default — 1 hour) | Same sub chain within 1 hour overwrites current snapshot |
| `0` | Every update creates a new snapshot — full audit trail |
| Custom (e.g., `5_000`) | 5-second debounce window per sub chain |

**`history: false`** — single-row mode, always overwrites. Same table/queries, no separate code path.

**`changedBy`** — stored as `SubChain[]` from the start. Single-element array for normal writes. Ready for future granularity-based compaction.

### Snapshot Response Shape

```typescript
interface Snapshot<T> {
  value: T;
  meta: {
    eTag: string;        // Opaque UUID — changes on every write including debounced
    validFrom: string;   // When this snapshot period began
    validTo: string;     // '9999-01-01T00:00:00.000Z' for current
    changedBy: SubChain[];
    deleted: boolean;
  }
}
```

### Upsert Response Protocol

- **Success:** `{ ok: true, meta }` — write landed. No `value` (caller knows it).
- **Conflict:** `{ ok: false, value, meta }` — eTag mismatch. Full current snapshot included.
- **Rejected:** `{ ok: false }` — guard/validation rejected. No data returned.

### URI Template Scheme

`https://{domain}/{bindingName}/{instanceName}/resources/{resourceType}/{resourceId}`

The storage DO registers resource types by slug. The slug becomes `{resourceType}` in the URI. `{resourceId}` identifies the specific instance.

### Storage Format

Resource values support rich types (Date, Map, Set, cycles) via `@lumenize/structured-clone`. Stored as JSONB in SQLite using the `$lmz` preprocessed format.

### Subscription Semantics

- **BroadcastChannel semantics** — own messages not echoed back.
- **Subscribe = read + ongoing** — handler fires immediately with current value, then on each update.
- **Guard-on-subscribe-only** — guards run once at subscription time, not on each fanout.
- **Continuation pattern** — DOs use `this.ctn()` for handlers that survive eviction.

### HTTP Transport

- `GET` → read, `PUT` → upsert, `DELETE` → delete
- `If-Match` header carries eTag on PUT
- Content type: `application/vnd.lumenize.structured-clone+json`
- `GET /discover` returns registered resource types with config

### Testing Invariant

Every resource test must use an object that includes a Map, a Date, and a Cycle to guard against accidental `JSON.stringify()` usage.

## What Changes from the Icebox Design

| Aspect | Icebox (registration-on-DO) | DWL Architecture (inverted) |
|--------|---------------------------|------------------|
| **Flow direction** | User's DO has everything | DO calls OUT to DWL for guards/config/validation |
| **Schema definition** | Resource type classes with static fields on the DO | User code in DWL — `resources` property on `ResourcesWorker` |
| **Validation** | Deferred / none | User's responsibility in DWL — validation methods on their class |
| **Guards** | Middleware arrays registered on the DO | Methods on the DWL class, referenced in `resources` config. DO calls `runGuard()`, base class dispatches. |
| **Registration** | `this.lmz.resources(config)` on the DO | DO reads `getResources()` from DWL, registers types in its own storage |
| **Type safety** | Generic type parameter from class reference | User handles typing in their DWL code |
| **Config (debounce, history)** | Static fields on resource type classes | Properties in the `resources` object on the DWL class |
| **Who extends what** | User extends LumenizeDO | User extends `ResourcesWorker` (which extends `LumenizeWorker`) |
| **afterFanout** | Registration option on the DO | TBD — possibly a method on the DWL class |

## Open Questions

### Resolved

1. ~~**Can a DWL isolate receive a DO namespace binding in its `env`?**~~ **No.** `DurableObjectNamespace` is not structured-clonable. `DataCloneError` on serialization. Irrelevant with the inverted architecture — the DWL doesn't need DO access.

2. ~~**Can a DO call a DWL isolate's WorkerEntrypoint methods?**~~ **Yes.** Full RPC works via `stub.getEntrypoint('ClassName').method()`. Confirmed in spike test 3.

3. ~~**What's the Nebula deployment model?**~~ Per-tenant DO instances. Each tenant gets their own `LumenizeResources` DO with its own SQLite.

4. ~~**Can traditional (non-Nebula) users use this same API directly?**~~ Yes. The storage DO API is the same regardless of caller. Traditional users write guards inline on their DO (icebox pattern); Nebula users write guards in DWL code. The storage engine doesn't care.

5. ~~**`registerType` as mesh call vs constructor config?**~~ The DO reads config from the DWL via `getResources()` and stores it persistently. Registration happens when the DWL code is first loaded (or updated).

6. ~~**Separate params vs URI for CRUD methods?**~~ Dual transport: HTTP uses the URI, Mesh uses explicit `@mesh` methods with separate params. Both resolve to the same unified handler internally.

7. ~~**Can DWL code import and extend `LumenizeWorker`?**~~ **Yes.** Bundle `@lumenize/mesh` with esbuild, pass as a DWL module. DWL class extends `LumenizeWorker`, gets `this.lmz`, `this.ctn()`, and `this.lmz.callContext` (when called via Mesh envelope). Confirmed in spike test 5.

8. ~~**Does Mesh `callContext` propagate to DWL via `__executeOperation`?**~~ **Yes.** Full callContext including `originAuth`, `callChain`, and `state` propagates. Guard methods successfully read `originAuth.claims.role` for access control. Confirmed in spike test 6.

9. ~~**How does the DWL base class dispatch guards?**~~ **Decided.** The DO calls `this.lmz.call(dwlStub, this.ctn().runGuards(slug, info))` — using the higher-level `lmz.call()` (not raw `__executeOperation`) so callContext propagates automatically. The `ResourcesWorker` base class implements `runGuards()`: looks up `this.resources[slug].guards`, executes each in sequence. Each guard reads `this.lmz.callContext` naturally. If any throws, error propagates back to DO. The spike used `__executeOperation` directly only because the spike's `SpikeDO` extended raw `DurableObject` (not `LumenizeDO`), so it didn't have `this.lmz.call()`.

10. **DWL in vitest?** Can `@cloudflare/vitest-pool-workers` handle `worker_loaders` bindings? Determines whether we can write proper integration tests or need `wrangler dev` + curl for DWL-specific tests. **[Test later]**

11. ~~**What should the DWL base class be named?**~~ **`ResourcesWorker`**. Parallels existing naming convention (`LumenizeDO`, `LumenizeWorker`, `LumenizeClient`). Accurately describes what it is — a Worker(Entrypoint) that provides resource behavior. Doesn't encode the DWL deployment detail in the name (works for deployed Workers too). DWL modules can export multiple `WorkerEntrypoint` classes (e.g., `ResourcesWorker` + future `IntegrationsWorker`), each addressed independently via `stub.getEntrypoint('ClassName')`.

12. ~~**Optimized DWL bundle size?**~~ **Tested.** LumenizeWorker-only entrypoint: 102KB unminified / 40KB minified (vs 140KB/56KB full). 27-29% reduction. Acceptable for DWL. Could trim more if base class drops `call()`/`ctn()`.

13. ~~**`LumenizeResources` DO: concrete class or base class?**~~ **Option B — `LumenizeResources` extends `LumenizeDO`.** It's a specialized DO that adds DWL integration, temporal storage, and the resource API on top of the base `LumenizeDO`. Traditional users can also extend it (without DWL) if they want built-in temporal storage. Nebula adds the DWL layer on top. The storage engine, subscription logic, and HTTP transport are the same regardless of whether guards come from DWL or inline code.

14. ~~**How does the DO call DWL — plain RPC or via Mesh?**~~ **Via `lmz.call()`.** Using `lmz.call(stub, continuation)` (new overload accepting a DWL stub directly). This propagates callContext through the Mesh envelope automatically — guards read `this.lmz.callContext.originAuth` naturally. Plain RPC was rejected because it would duplicate callContext propagation logic.

15. ~~**Singular or batch API?**~~ **`transaction()` with mixed operations.** `lmz.transaction([lmz.upsert(...), lmz.delete(...)])` accepts an array of operation descriptors. Convenience functions (`lmz.upsert()`, `lmz.delete()`) are pure — they return descriptor objects, no async. Three overload patterns for each: `(resourceId, ...)` with eTag from cache, `(resourceId, ..., eTag)` explicit, `(snapshot, ...)` extracting resourceId + eTag from snapshot. Singular `read()` and batch `reads([])` remain separate (no writes, no guard dispatch needed). Calling out to DWL opens input gates; `transaction()` minimizes to one RPC round-trip with manual double-eTag-check protocol and `transactionSync()` for the write phase.

### Still Open

- **Q10**: DWL in vitest — untested, deferred

## Implementation Phases

### Phase 0: Design & DWL Validation

**Goal**: Validate DWL assumptions and finalize the API.

**Success Criteria**:
- [x] Basic DWL spike — DO calls DWL WorkerEntrypoint methods (spike test 3)
- [x] Confirm DWL env supports structured-clonable types (spike test 2)
- [x] Confirm DWL env does NOT support DO namespace bindings (spike test 4)
- [x] Wrangler upgraded to 4.66.0 across monorepo, tests pass
- [x] Inverted architecture validated — DO calls out to DWL, not reverse
- [x] LumenizeWorker in DWL — DWL extends LumenizeWorker, `this.lmz` and `this.ctn()` work (spike test 5)
- [x] Mesh call functionality — `__executeOperation()` propagates full callContext to DWL (spike test 6)
- [x] Guards in DWL read `originAuth.claims.role` for access control decisions (spike test 6)
- [x] Base class name decided: `ResourcesWorker` (extends `LumenizeWorker`)
- [x] DO-side class decided: `LumenizeResources` extends `LumenizeDO` (Option B)
- [x] Guard dispatch decided: `lmz.call(stub, continuation)` — Mesh envelope propagates callContext
- [x] `lmz.call()` DWL addressing decided: new `lmz.call(stub, continuation)` overload
- [x] `transaction()` API decided: `lmz.transaction([lmz.upsert(...), lmz.delete(...)])` with convenience functions
- [x] Convenience function overloads decided: `(id, val)`, `(id, val, eTag)`, `(snapshot, val)` — eTag from cache or explicit
- [x] Manual transaction protocol decided: read→eTag check→DWL guards→recheck→transactionSync write
- [ ] Finalize full LumenizeResources DO method surface (transaction, read, reads, subscribe, discover)
- [ ] Finalize ResourcesWorker base class methods (runGuards batch, getResources)
- [ ] Draft MDX documentation (after API is stable)
- [ ] Maintainer sign-off on architecture

### Phase 1: LumenizeResources Storage Engine

**Goal**: Implement the core storage DO with temporal storage and CRUD operations.

**Success Criteria**:
- [ ] `lmz.transaction([...])` accepting mixed upsert/delete operation descriptors
- [ ] `lmz.upsert()` and `lmz.delete()` convenience functions with 3 overload patterns each
- [ ] Local eTag cache — populated by read/subscribe, used by convenience functions
- [ ] Snodgrass temporal storage with debounce and history modes
- [ ] Optimistic concurrency via eTag (double-check protocol)
- [ ] Manual transaction protocol: pre-check → DWL guards → recheck → `transactionSync` write
- [ ] Snapshot response shape with meta
- [ ] Transaction response protocol (success/conflict/rejected) — per-item results
- [ ] Callable via `lmz.call()` from any Mesh node
- [ ] Test objects include Map, Date, and Cycle

### Phase 2: Subscriptions & Fanout

**Goal**: Add subscribe, fanout, and lifecycle management.

**Success Criteria**:
- [ ] `subscribe` returns initial value + ongoing updates
- [ ] BroadcastChannel semantics (own messages not echoed)
- [ ] Subscriber cleanup on disconnect
- [ ] Continuation pattern for DO subscribers
- [ ] Auto-resubscribe on reconnect for Clients

### Phase 3: HTTP Transport

**Goal**: Expose LumenizeResources over HTTP.

**Success Criteria**:
- [ ] `GET` → read, `PUT` → upsert, `DELETE` → delete
- [ ] `If-Match` header for optimistic concurrency
- [ ] `GET /discover` endpoint
- [ ] Content type: `application/vnd.lumenize.structured-clone+json`

### Phase 4: DWL Integration

**Goal**: Full DWL workflow with `ResourcesWorker` base class.

**Success Criteria**:
- [ ] `ResourcesWorker` base class extending `LumenizeWorker`
- [ ] DWL code provides `resources` config and guard methods
- [ ] `runGuards()` dispatch from base class — called via `lmz.call(stub, continuation)`
- [ ] `getResources()` returns serializable config (no functions)
- [ ] `lmz.call(stub, continuation)` overload implemented in `LumenizeResources`
- [ ] Code versioning — hash-based DWL stub management
- [ ] `globalOutbound: null` sandbox with controlled `env` bindings
- [ ] Example of traditional (non-DWL) user calling LumenizeResources

### Phase 5: Documentation & Tests

**Goal**: Full coverage and docs.

**Success Criteria**:
- [ ] `website/docs/mesh/resources.mdx` written (after API stable)
- [ ] `website/sidebars.ts` updated
- [ ] All `@skip-check` converted to `@check-example`
- [ ] Branch coverage >80%, statement coverage >90%

## Notes

- DWL is in closed beta — production deployment requires Cloudflare sign-up. Local dev works now with wrangler 4.66.0+.
- The same LumenizeResources DO API serves both Nebula (DWL) and traditional (deploy-time) users.
- Prior art from `lumenize-monolith/` still applies for temporal storage patterns — see icebox task file for details.
- Phase 0.5 (remove `gateway` prefix) from the icebox design is still needed and should be tackled independently.
- Spike experiment code lives in `experiments/dwl-spike/`.

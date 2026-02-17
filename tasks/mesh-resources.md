# Mesh Resources (DWL Architecture)

**Status**: Phase 0 — Design
**Prior Art**: `tasks/icebox/mesh-resources.md` and `tasks/icebox/resources.mdx` (registration-on-DO approach — temporal storage design, snapshot shape, URI scheme, and response protocol carry forward; registration API and schema strategy are replaced by the DWL approach)

## Goal

Build a resource system for Lumenize Mesh where **user-provided code runs in a Dynamic Worker Loader (DWL) isolate** and **Lumenize provides the storage engine as a Durable Object**. The user's DWL code handles schema definition, validation, guards, and business logic. The storage DO (LumenizeResources) handles temporal storage, subscriptions, fanout, and lifecycle — the same core responsibilities from the icebox design, but now as a service consumed by the user's code rather than configured by it.

This architecture is motivated primarily by **Lumenize Nebula** — a vibe coding platform where the user provides all code over the wire as config strings. DWL makes this possible without deploying separate Workers per user.

## Core Architecture

```
┌─────────────────────────────────────────────────┐
│  User's DWL Worker (dynamic isolate)            │
│  - Extends LumenizeWorker (WorkerEntrypoint)    │
│  - Schema definition & validation               │
│  - Guards / access control                      │
│  - Business logic                               │
│  - Imports any validation library they want      │
│  - Calls LumenizeResources via lmz.call()       │
└──────────────┬──────────────────────────────────┘
               │ Mesh call() via service binding
               ▼
┌─────────────────────────────────────────────────┐
│  LumenizeResources DO (Lumenize-provided)       │
│  - Extends LumenizeDO                           │
│  - Snodgrass temporal storage                   │
│  - Subscription tracking & fanout               │
│  - Optimistic concurrency (eTag)                │
│  - Debounce, history modes                      │
│  - HTTP transport                               │
│  - Discovery endpoint                           │
└─────────────────────────────────────────────────┘
```

### How DWL Fits

Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) spawns lightweight isolates from code strings at runtime. Key properties:

- **`loader.get(id, callback)`** — returns a stub for the dynamic worker. The callback provides `mainModule`, `modules`, `env`, and `globalOutbound`.
- **`env` bindings** — the host passes service bindings (including RPC-capable `WorkerEntrypoint` classes) into the dynamic worker's `env`. This is how the DWL code gets access to LumenizeResources.
- **`globalOutbound`** — controls network access. Can be set to `null` (total sandbox) or a service binding (controlled egress). Nebula uses this for security.
- **No Durable Objects in DWL** — DWL isolates cannot export DO classes. The DO must be a separate, pre-deployed binding. This is why the architecture splits into DWL (user logic) + DO (storage).
- **Caching** — isolates are cached by ID but no guarantee two requests hit the same isolate. Statelessness is assumed.
- **Closed beta** — DWL requires sign-up for production; local dev available now.

### Why This Split?

The icebox design put everything on the DO — schema, guards, validation, storage, subscriptions. This works for traditional deploy-time development but doesn't work for Nebula where:

1. **User code arrives as strings over the wire** — can't be part of a deployed Worker bundle.
2. **Different users need different schemas/guards on the same infrastructure** — DWL isolates provide per-user sandboxing.
3. **Users want to import their own validation libraries** — DWL `modules` dict supports this.
4. **Security isolation** — `globalOutbound: null` plus controlled `env` bindings means user code can only talk to services we explicitly provide.

For traditional (non-Nebula) Lumenize users who deploy their own Workers, the same architecture still works — they just write a normal Worker that calls LumenizeResources via service binding instead of using DWL. The storage DO API is the same either way.

## Open Questions

These need to be resolved before implementation. Each is tagged with who/what can answer it.

1. **Can a DWL isolate receive a DO namespace binding in its `env`?** The docs say `env` supports "Service Bindings" and "Structured clonable types." A DO namespace binding is accessed via `env.MY_DO` which acts like a service binding. If this works, the DWL code can get a DO stub directly. If not, we need a service binding intermediary (the host Worker) that proxies DO access. **[Test empirically]**

2. **Can a DWL isolate participate in Lumenize Mesh?** Mesh currently requires extending `LumenizeDO`, `LumenizeWorker`, or `LumenizeClient`. A DWL isolate extending `LumenizeWorker` would need the Mesh library available in its `modules` dict. This is feasible (pass `@lumenize/mesh` source as a module) but needs validation. **[Test empirically]**

3. **How does the DWL isolate authenticate to LumenizeResources?** The user's code runs in a sandboxed isolate. When it calls the storage DO, how does identity flow? Options:
   - The host Worker sets `callContext` before dispatching to the DWL isolate, and Mesh propagates it through the service binding.
   - The DWL isolate receives a pre-authenticated stub.
   - The storage DO trusts calls from DWL isolates by construction (they can only reach it via the provided binding).
   **[Design decision — depends on Q1/Q2 answers]**

4. **What's the Nebula deployment model?** Does each Nebula tenant get their own LumenizeResources DO instance (isolated storage), or do tenants share a DO with namespace-level isolation? Probably per-tenant DO instances (each DO has its own SQLite), but this affects the binding setup. **[Product decision]**

5. **Can traditional (non-Nebula) users use this same API directly?** If LumenizeResources exposes a clean `@mesh`-decorated API, any Worker or DO can call it — no DWL needed. This means one storage engine serves both deployment models. **[Validate during design]**

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

| Aspect | Icebox (registration-on-DO) | DWL Architecture |
|--------|---------------------------|------------------|
| **Schema definition** | Resource type classes with static fields on the DO | User code in DWL isolate — any format they want |
| **Validation** | Deferred / none | User's responsibility in DWL — can import Zod, TypeBox, etc. |
| **Guards** | Middleware arrays registered on the DO | User code in DWL — runs before calling storage DO |
| **Registration** | `this.lmz.resources(config)` on the DO | Storage DO exposes a `registerType(slug, options)` mesh method |
| **Type safety** | Generic type parameter from class reference | User handles typing in their DWL code |
| **Config (debounce, history)** | Static fields on resource type classes | Passed as parameters to `registerType()` or per-operation |
| **Who extends what** | User extends LumenizeDO | User extends LumenizeWorker (DWL) or calls storage DO from any Worker |
| **afterFanout** | Registration option on the DO | User code — DWL subscribes and handles post-fanout logic |

## LumenizeResources DO — API Sketch

LumenizeResources extends LumenizeDO and exposes `@mesh`-decorated methods. This is the storage engine that any caller (DWL, Worker, other DO) interacts with.

```typescript
// These are the @mesh methods on LumenizeResources
// Exact signatures TBD during implementation

registerType(slug: string, options?: { debounceMs?: number; history?: boolean; title?: string; description?: string }): void
// Registers a resource type. Idempotent. Must be called before other operations on that type.

read(resourceType: string, resourceId: string): Snapshot<unknown>
// Returns current snapshot or undefined.

upsert(resourceType: string, resourceId: string, value: unknown, eTag?: string): UpsertResponse<unknown>
// Create or replace. Optional eTag for optimistic concurrency.

delete(resourceType: string, resourceId: string): Snapshot<unknown>
// Soft delete preserving history.

subscribe(resourceType: string, resourceId: string, options?: { initialValue?: unknown }): Snapshot<unknown>
// Initial value + ongoing subscription. Caller provides handler via lmz.call() continuation pattern.

discover(): DiscoveryResponse
// Returns registered types, URI templates, config, protocol summary.
```

### Open Design Questions for the API

- Should `registerType` be a mesh call, or should it happen via a config object in the DO's constructor? If the user's DWL code calls `registerType`, there's a race — multiple requests could arrive before registration completes. If it's constructor-level config, we're back to the icebox pattern. A hybrid might work: the host Worker registers types when it creates the DWL isolate (before the first request), and the storage DO stores the registration persistently.
- Should `read`/`upsert`/`delete`/`subscribe` take `resourceType` + `resourceId` as separate params, or a URI string that the DO parses? Separate params is simpler for DWL callers. URI string is more consistent with the icebox design and HTTP transport.

## Implementation Phases

### Phase 0: Design & DWL Validation

**Goal**: Validate DWL assumptions and finalize the API.

**Success Criteria**:
- [ ] Answer open questions 1-5 empirically
- [ ] Validate DWL can receive DO namespace bindings or service bindings
- [ ] Validate DWL can participate in Mesh (extend LumenizeWorker)
- [ ] Finalize LumenizeResources API shape
- [ ] Draft MDX documentation (after API is stable)
- [ ] Maintainer sign-off on architecture

### Phase 1: LumenizeResources Storage Engine

**Goal**: Implement the core storage DO with temporal storage and CRUD operations.

**Success Criteria**:
- [ ] LumenizeResources DO with `registerType`, `read`, `upsert`, `delete`
- [ ] Snodgrass temporal storage with debounce and history modes
- [ ] Optimistic concurrency via eTag
- [ ] Snapshot response shape with meta
- [ ] Upsert response protocol (success/conflict/rejected)
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

**Goal**: Validate and document the full DWL workflow.

**Success Criteria**:
- [ ] Example DWL isolate that extends LumenizeWorker
- [ ] DWL code calls LumenizeResources via Mesh
- [ ] Schema validation in DWL (example with Zod or TypeBox)
- [ ] Guards in DWL code
- [ ] `globalOutbound: null` sandbox with controlled `env` bindings
- [ ] Example of traditional (non-DWL) Worker calling LumenizeResources

### Phase 5: Documentation & Tests

**Goal**: Full coverage and docs.

**Success Criteria**:
- [ ] `website/docs/mesh/resources.mdx` written (after API stable)
- [ ] `website/sidebars.ts` updated
- [ ] All `@skip-check` converted to `@check-example`
- [ ] Branch coverage >80%, statement coverage >90%

## Notes

- DWL is in closed beta — production deployment requires Cloudflare sign-up. Local dev works now.
- The same LumenizeResources DO API serves both Nebula (DWL) and traditional (deploy-time) users.
- Prior art from `lumenize-monolith/` still applies for temporal storage patterns — see icebox task file for details.
- Phase 0.5 (remove `gateway` prefix) from the icebox design is still needed and should be tackled independently.

# Mesh Resources

**Status**: Phase 0 In Progress
**Design Document**: `/website/docs/mesh/resources.mdx`

## Goal

Build a first-class resource system into Lumenize Mesh — declare named resource types on a DO. Lumenize Mesh handles storage (Snodgrass-style temporal), subscriptions including fanout update notifications, etc. Access resources through two transports: Lumenize Mesh (real-time subscribe/update) and HTTP REST (no subscribe/update).

## Motivation

The website/docs/mesh/getting-started example has **manual pub/sub** that works but is boilerplate-heavy, despite the fact that it's a for-demo, non-production-ready example:
- DocumentDO stores a `Set<string>` of subscriber IDs in KV storage
- Broadcasts via a manual loop calling `lmz.call()` with `newChain: true`
- Clients must manually resubscribe via `onSubscriptionRequired`
- No framework support for cleanup when subscribers disconnect
- Every DO that wants pub/sub must reimplement the same pattern

The resource system bakes all of that in. Additionally, it automatically exposes the same resources over HTTP for when:
- Real-time pub/sub capability isn't needed
- The simplicity of plain fetch integration is desired
- Exposure to JavaScript systems is desired but where persistent WebSocket connections are infeasible
- LumenizeClient is not a good fit for the accessing system
- Access from non-JavaScript tech stacks is needed (although that's aspirational without a @lumenize/structured-clone library for your tech stack)

## Design Decisions

Developer-facing API documentation is in `/website/docs/mesh/resources.mdx`. This section records implementation-level decisions only. A later phase of the implementation includes transitioning `/website/docs/mesh/getting-started.mdx` to using this resource system.

### ResourcesHost and ResourcesClient Classes

- The resources registry is to be implemented as a class, ResourcesHost, with methods for use by the developer-user and internal mesh functionality. ResourcesHost runs only on LumenizeDO.
- ResourcesClient is a class that runs on both LumenizeDO and LumenizeClient and it has methods for use in subscribing to, reading, upserting, etc. resources hosted on a node running ResourcesHost.
- Some modifications are required to LumenizeDO and LumenizeClient, but these modifications are to be as minimal as possible and exist solely to bake-in access to functionality contained within the Resources* classes.
- The Resources* classes should use `this.lmz.call` for Mesh transport communications taking advantage of the environment-specific differences in `this.lmz.call` between DO and Client without duplicating their functionality.
- Only the ResourcesHost methods for the HTTP transport should need to do preprocessing and stringifying. ResourcesClient methods should not need to do any preprocessing/stringifying/encoding/etc. Other than the HTTP transport code in ResourcesHost, all other methods should handle rich-typed plain objects and let `lmz.call()` handle the preprocessing.

### ResourcesHost

`this.lmz.resources(config)` is a single registration call that receives an object mapping slug-friendly keys to per-type options. Here is an example registration call:

```typescript
import { Content, Presence, Metrics } from './resource-types';

this.lmz.resources({
  content: { class: Content, guards: [requireEditor, validateContent] },
  metrics: { class: Metrics, guards: [requireEditor] },
  presence: { class: Presence },
});
```

- The call is void — it registers resource types with the framework internally. Whether the host DO needs a typed local handle for direct access (skipping guards/transport) is a design decision deferred to implementation.
- Registration happens during construction (before the first request arrives). The Resources class is instantiated in the base LumenizeDO's constructor.
- **Slug-friendly keys** — outer keys (e.g., `content`, `presence`, `metrics`) are URL-friendly slugs that become the `{resourceType}` segment in the URI template. Must be valid URL path segments (lowercase alphanumeric + hyphens). Validated at registration time.
- **Per-type options** include:
  - `class` (required) — reference to the resource type class. Provides: (1) the generic type parameter for compile-time type safety, and (2) runtime access to static fields (`debounceMs`, `history`) for declarative config.
  - `guards` (optional) — array of guard functions executed in sequence (middleware pattern). Each guard receives the operation info object and has access to `this.lmz.callContext` via closure. Guards throw to disallow — the Error propagates back through the transport layer. Empty array or omitted means unguarded. Requiring an explicit entry (even `presence: { class: Presence }` with no guards) for every type forces acknowledgment of the security posture.
  - `afterFanout` (optional) — callback after fanout completes for that resource type.
  - `title` (optional) — user-friendly title with spaces, capitalization, and unicode allowed. For discovery.
  - `description` (optional) — user and LLM friendly description. For discovery.
- **Resource type classes** — defined in a separate `.ts` file (e.g., `src/resource-types.ts`). Classes with fields-only using `!` definite assignment. Static fields provide declarative config that survives TypeScript compilation (unlike JSDoc or decorators). The same file serves dual purposes: `import type { Content }` for compile-time typing, and `import { Content }` for runtime class references with static config.
- **Why guards/afterFanout live in the registration call, not on the class** — guards need DO instance context (`this.lmz.callContext`) but resource type classes are defined outside the DO in a separate file. The registration call is a closure over `this`, making instance state naturally available. Class-level decorators or static methods can't access the DO instance.

Example resource type class with static config:

```typescript
// src/resource-types.ts
export class Content {
  title!: string;
  body!: string;
  tags!: string[];
  createdAt!: Date;
  metadata!: Map<string, string>;

  static debounceMs = 3_600_000;  // default
  static history = true;          // default
}

export class Presence {
  cursor!: { x: number; y: number };
  status!: 'active' | 'idle';
  lastSeen!: Date;

  static history = false;  // ephemeral — always one row
}

export class Metrics {
  views!: number;
  edits!: number;
  lastEditor!: string;

  static debounceMs = 0;  // full audit trail
}
```

- **Resource discovery via `discover()`** — returns registered URI templates with config (slug, debounceMs, title, description) plus a static protocol summary (operations, HTTP mappings, docs link). Unguarded — public metadata about the DO's resource API. Mesh: `lmz.discover()`. HTTP: `GET /discover`. Exact machine-oriented protocol description finalized during implementation. Consider sending `.toString()` output of class or even full `src/resource-types.ts` using `?raw` import syntax.
- **Unified operation handling across transports** — Each transport (Mesh, HTTP) is a thin translator that extracts the neccessary information (resourceType, resourceId, operation, etc) and adds it to an info object, `resourceInfo`, and calls `Resources.handleOperation(resourceInfo)` which then:
  1. Attempts to retrieve from the database the current `snapshot` for the given resourceId since it's needed for all operations. `snapshot` is undefined if not found.
  2. Executes the guard array for that resource type in sequence (middleware pattern)
  3. If any guard throws, execution stops and the Error is returned back to the transport layer. HTTP will convert to appropriate code and message. Mesh will return full Error consistent with other mesh guards (see docs for how `lmz.call()` guards return Errors including custom Error classes)
  4. If all guards pass (none throw), the correct lower-level operation handler is called
  5. The operation handlers perform necessary transformations and database operations
  6. The response from the operation handler is returned to the transport layer for final transformation and transmission back to the caller.

### Lower-level Handler Signatures

All transports dispatch to the same unified handlers inside the Resources class.

#### Common fields (present in every operation's info object):

```typescript
interface ResourceInfoBase {
  operation: 'read' | 'subscribe' | 'upsert' | 'delete';
  resourceType: string;           // The slug from registration (e.g., 'content')
  resourceId: string;             // The specific resource instance (e.g., 'main')
  snapshot?: Snapshot<T>;         // Current snapshot from storage (undefined if resource doesn't exist yet)
}
```

- **`resourceType`** — the slug key from the `this.lmz.resources(config)` registration call (e.g., `'content'`). Always present. Enables guards that behave differently per resource type when a single guard function is shared.
- **`resourceId`** — the specific resource instance being accessed (e.g., `'main'`). This is the primary key in storage. The fixed field name enables reusable guards — every resource type uses the same `info.resourceId`, so one guard works across registrations.
- **`snapshot`** — fetched from storage before the handler and guard run. `undefined` when the resource doesn't exist yet (first upsert, read of nonexistent resource). Not an extra read — upsert already needs it for eTag comparison, and read/subscribe already need it for the response.

#### Per-operation info objects:

```typescript
// Read — one-shot fetch
interface ReadInfo<T> extends ResourceInfoBase {
  operation: 'read';
}

// Subscribe — ongoing subscription
interface SubscribeInfo<T> extends ResourceInfoBase {
  operation: 'subscribe';
  options?: {
    initialValue?: T;           // Seed value if resource doesn't exist yet
  };
}

// Upsert — create or replace
interface UpsertInfo<T> extends ResourceInfoBase {
  operation: 'upsert';
  incoming: T;                  // The new value being written
  eTag?: string;                // For optimistic concurrency (undefined = no check)
}

// Delete — soft delete
interface DeleteInfo<T> extends ResourceInfoBase {
  operation: 'delete';
}
```

- **`incoming`** on upsert — the new value `T` being written. Guards can inspect this for content-aware authorization (e.g., "only admins can set status to 'published'").
- **`eTag`** on upsert — passed through from the caller. The handler uses it for optimistic concurrency; the guard can also inspect it (though rarely needed).
- **`options.initialValue`** on subscribe — the seed value from the caller. If the resource doesn't exist and `initialValue` is provided, the handler creates it.

#### Guards receive the same info object:

Guards are arrays of functions executed in sequence (middleware pattern). Each guard throws to disallow — the Error propagates back through the transport layer (HTTP converts to appropriate status code, Mesh returns the Error consistent with other mesh guards). If a guard doesn't throw, execution continues to the next guard.

```typescript
type Guard<T> = (info: ReadInfo<T> | SubscribeInfo<T> | UpsertInfo<T> | DeleteInfo<T>) => void
```

Guards can narrow on `info.operation` to access operation-specific fields:

```typescript
const requireEditor: Guard<any> = (info) => {
  const { originAuth } = this.lmz.callContext;
  if (originAuth?.claims?.role !== 'editor' && originAuth?.claims?.role !== 'admin') {
    throw new ForbiddenError('Editor role required');
  }
};

const validateContent: Guard<Content> = (info) => {
  if (info.operation === 'upsert') {
    // info.incoming is available here (TypeScript narrows the union)
    if (info.incoming.status === 'published') {
      const { originAuth } = this.lmz.callContext;
      if (originAuth?.claims?.role !== 'admin') {
        throw new ForbiddenError('Only admins can publish');
      }
    }
  }
};

// Registration — guards execute in array order
this.lmz.resources({
  content: { class: Content, guards: [requireEditor, validateContent] },
});
```

#### What the guard does NOT receive:

- **`callContext` / `originAuth`** — accessed via `this.lmz.callContext` (existing convention, same as `@mesh` guards)
- **`ctx` / `env`** — accessed via `this.ctx` and `this.env` (existing DO instance properties passed in when the Resources class is instantiated in the LumenizeDO's constructor)

The guard is a closure over `this`, so all instance state is naturally available. Passing `callContext` explicitly would be redundant and inconsistent with `@mesh` guards.

#### Transport translator responsibilities:

Each transport extracts the operation and builds the info object:

| Field | Mesh transport | HTTP transport |
|-------|---------------|----------------|
| `operation` | From which `lmz.*` method was called | From HTTP method (GET→read, PUT→upsert, DELETE→delete) |
| `resourceType` | Extracted from URI by matching against registered slugs | Same — extracted from URL path segment |
| `resourceId` | Extracted from URI (last path segment after resource type) | Same — extracted from URL path |
| `snapshot` | Fetched from storage by the unified handler (not the transport) | Same |
| `incoming` | From `lmz.upsert(uri, value)` args | From request body (deserialized via structured-clone) |
| `eTag` | From `lmz.upsert(uri, value, eTag)` args | From `If-Match` header |
| `options` | From `lmz.subscribe(uri, handler, options)` args | N/A (no HTTP subscribe) |

Note: `snapshot` is fetched by the unified handler *after* the transport translator builds the initial info object but *before* the guard runs. The transport doesn't touch storage.

### HTTP Transport Notes

- **`https://` URI scheme** with framework-generated RFC 6570 templates: `https://{domain}/{bindingName}/{instanceName}/resources/{resourceType}/{resourceId}`. The developer provides a slug (the `resourceType` segment, e.g., `'content'`); the framework generates the full URI template. Developers never write URI templates directly. Full URLs passed everywhere regardless of transport.
- **No prefix for mesh routing** — `routeDORequest` without `prefix`, is placed as the last router in Worker routing code. The existing `prefix: 'gateway'` convention is removed in Phase 0.5.
- **Fixed `resourceId` field** — every resource uses `{resourceId}` as its instance identifier. This enables reusable guards across resource types (`info.resourceId` is always available) and a uniform storage key without per-registration translation. The `resourceType` segment disambiguates different resource registrations on the same DO.

### Lumenize Mesh Transport Notes

- **`subscribe`/`upsert` naming** — not `sub`/`pub` to avoid JWT `sub` (subject claim) collision.

### Authentication

- **Auth infrastructure already in place** — `onBeforeRequest` at Worker level (JWT, rate limiting, Bearer tokens) handles HTTP requests routed directly to destination DO. Gateway only involved for WebSocket connections (`onBeforeConnect`). HTTP transport is mostly wiring.

### Guard Execution

- **Signature:** Each guard receives the same info object as the unified handler — see "Unified Handler Signatures" above. `(info: ReadInfo<T> | SubscribeInfo<T> | UpsertInfo<T> | DeleteInfo<T>) => void`. TypeScript discriminated union narrows on `info.operation`. Guards throw to disallow.
- **Array execution (middleware pattern):** Guards are arrays executed in sequence. If any guard throws, execution stops and the Error propagates to the transport layer. This enables composition — e.g., `[requireEditor, validateContent]` where `requireEditor` is reused across all types and `validateContent` is type-specific.
- **Auth via `this.lmz.callContext`** — same pattern as `@mesh` guards. No separate `ctx` parameter needed. The guard is a closure over `this`.
- **Execution order:** guards run post-storage-retrieval, pre-response. The framework fetches the snapshot first, populates `info.snapshot`, then calls the guard array in order. This is not an extra read — upsert already needs the current snapshot for eTag comparison, and read/subscribe already need it for the response.
- **Guard-on-subscribe-only:** for subscribe operations, the guard array runs once at subscription time. Ongoing fanout updates are not re-guarded. If permissions change after subscription, explicit unsubscribe is required. This keeps fanout fast and simple.
- **Relationship to `@mesh` guards:** Both use `this.lmz.callContext` for auth. `@mesh()` decorator guards are method-level and receive `(instance)`. Resource guards are registration-level (per resource type slug, array of guards) and receive the full info object. They serve different purposes — `@mesh` guards protect individual RPC methods, resource guards protect data access with content-aware authorization. The fixed info shape (`resourceType` + `resourceId` as top-level fields) means the same guard function can be reused across multiple resource types.

### Downstream Subscription Required Notification

- `onSubscriptionRequired` is kept but its purpose shifts
- Remains in the API docs but removed from getting-started and other examples where the built-in subscribe/upsert mechanism is a better choice. 
- The Gateway's `subscriptionRequired` signal (in `ConnectionStatusMessage`) is utilized to trigger automatic resource resubscription. The framework hooks into this internally: on `subscriptionRequired: true`, iterate the Client's in-memory resource subscription list and re-subscribe each. The handler fires with the current value on each resubscribe — no eTag tracking or conditional logic needed.
- `onSubscriptionRequired` callback fires *after* the framework completes resource resubscription for two possible uses:
  1. Custom pub/sub designs like the current getting-started example.
  2. When the developer-user wants their system to do something after resubscription occurs like update the UI en-mass although the `lmz.subscribe()` callback should be favored for passively updating the UI as each subscription completes.

### Temporal Storage Implementation

Every resource uses Snodgrass-style temporal storage — each change (outside of the debounce window) creates a snapshot with `validFrom`/`validTo` timestamps, preserving full history by default.

**"Sub chain"** means the full identity: the JWT `sub` claim plus any nested `act` delegates. Debounce, `changedBy` tracking, and all identity comparisons use the sub chain — not just the top-level `sub`.

**Debounce** controls whether rapid updates from the same sub chain create new snapshots or overwrite the most recent one in place:

| `debounceMs` | Behavior |
|---|---|
| `3_600_000` (default — 1 hour) | Updates from the same sub chain within 1 hour overwrite the current snapshot |
| `0` | Every update creates a new snapshot — full audit trail, no debouncing |
| Custom (e.g., `5_000`) | 5-second debounce window per sub chain |

**How debounce works:** On each update, the framework checks whether the current snapshot's `changedBy` matches the incoming sub chain AND the time since `validFrom` is less than `debounceMs`. If both conditions are met, the snapshot's `value` is overwritten in place — `validFrom`, `validTo`, and `changedBy` are unchanged. Otherwise, a new snapshot is created (the previous snapshot's `validTo` is set to the new snapshot's `validFrom`).

**`history: false`** disables temporal history entirely — the resource always has exactly one row. Metadata like `validFrom` and `validTo` are still present, but they will never change unless history flag is later toggled to `true`. Updates always overwrite regardless of sub chain or timing. Useful for ephemeral state like presence or cursor position. This should be implemented as the equivalent of deboundMs = `infinity` without the single sub chain constraint. The same snapshots table and queries are used — there's no separate "simple mode" code path. If you later need history, set `history: true` and new changes start accumulating. No migration needed.

**`changedBy` tracking:** Each snapshot stores `changedBy` as `SubChain[]` — an array from the start. Normal writes produce a single-element array (`[incomingSubChain]`). The debounce check compares against `changedBy[0]` and confirms that the changedBy array is length 1 to avoid debouncing on already compacted snapshots. This avoids a future `SubChain | SubChain[]` type union when granularity-based compaction lands — compaction just concatenates and deduplicates the arrays from collapsed snapshots.

### Snapshot Response Shape

All resource operations return `Snapshot<T>` — the developer's `value` plus framework `meta`. See the MDX Response Protocol section for the full type definition and rationale.

Key implementation notes:
- `meta.eTag` is an opaque UUID generated via `crypto.randomUUID()` on every write — including debounced overwrites. This avoids reliance on `workerd` clock behavior (time stops within a request, can produce duplicate timestamps across successive WebSocket messages). `validFrom` is the temporal identity of the snapshot period; eTag is the concurrency token for the current value.
- **eTags are for optimistic concurrency on upsert only** — not for conditional reads or subscribes. Reads and subscribes always return the full snapshot. This simplifies the host DO's read path (no conditional logic) and the reconnection path (no eTag tracking per subscription). The negligible bandwidth saving of conditional reads doesn't justify the complexity. This argues strongly for a UI layer eTag check (available via `snapshot.meta.eTag`) or deep object changed detection before updating the DOM so the UI doesn't flicker.
- `validFrom` retains its pure Snodgrass temporal meaning — frozen during debounce, changes only when a new snapshot is created. "Baseline" is the internal term for `validFrom`.
- HTTP mapping: `If-Match` header carries `meta.eTag` on PUT requests
- Mesh: eTag parameter on `lmz.upsert()` only
- `meta` is the clean expansion point for future fields (`resourceTypeVersion`, etc.) — `value` stays uncontaminated. Note: `resourceType` is already a top-level field on the info object, so `meta` doesn't need it

### Upsert Response Protocol

Upsert responses extend `Snapshot<T>` with an `ok` field — the shape tells the caller the outcome without flags:

- **Success:** `{ ok: true, meta }` — write landed. `meta.eTag` is the new version. No `value` — caller already knows it.
- **Conflict:** `{ ok: false, value, meta }` — eTag mismatch. Full current snapshot included so the caller can decide (revert, merge, prompt user) without a separate `read()` round-trip.
- **Rejected:** `{ ok: false }` — guard rejected. No value or meta returned (unauthorized callers shouldn't see the resource).

The presence or absence of `value`/`meta` in the `ok: false` case distinguishes conflict from rejection — no `conflict: true` flag needed.

**Interaction with subscribe:** If the caller is subscribed to the resource, subscribe handler fires for other people's changes (incoming updates channel). The upsert response tells the caller whether their own write landed (outcome channel). Own messages are not echoed back through subscribe (BroadcastChannel semantics), so the two channels don't overlap.

**HTTP mapping:** Success → 200 with `meta.eTag` in `ETag` response header. Conflict → 409 with current snapshot in body and `meta.eTag` in `ETag` header. Rejected → 403.

### Schema Strategy

**TypeScript classes are the schema source of truth** — not TypeBox, Zod, JSON Schema, or any DSL. Vibe coders write standard TypeScript classes; AI assistants generate standard TypeScript classes. No schema DSL to learn.

**How it works:** Developer (or more likely coding agent) writes TypeScript classes with fields-only in `src/resource-types.ts`. Classes use `!` definite assignment for fields. Static fields provide declarative config (`debounceMs`, `history`) that survives TypeScript compilation. The same file serves dual purposes: `import type { Content }` for compile-time typing, and `import { Content }` for runtime class references with static config in the registration call.

**Why classes instead of interfaces:**
- Interfaces are erased at compile time — no runtime access to metadata.
- Classes with static fields survive compilation and provide runtime config without a separate config object.
- `!` definite assignment on fields makes them declaration-only (no constructor needed) while still providing the type shape.
- The `class` property in the registration object provides the generic type parameter: `content: { class: Content, ... }` gives the framework `Content` as both a runtime reference and a compile-time type.

**Code Mode agents** read the raw `.d.ts` files directly. LLMs trained on millions of lines of TypeScript produce dramatically better results from TypeScript types than from JSON Schema — this is the same insight behind Cloudflare's Code Mode approach.

**Runtime validation is deferred.** TypeScript provides compile-time safety. Both transports use `@lumenize/structured-clone` which handles type preservation natively. See Future Enhancements for options.

### Storage Format

**Resource values support rich types** — Date, Map, Set, cycles, and everything else `@lumenize/structured-clone` handles. Stored as JSONB in SQLite via `preprocess()` (the `$lmz` tuple format).

**What this means:**
- `value` column is JSONB containing the `$lmz` preprocessed format
- `meta.eTag` (opaque UUID) provides optimistic concurrency — no diff computation needed
- Reads and subscribes always return full `Snapshot<T>` — no conditional reads, no delta/patch delivery
- One format everywhere — both Mesh and HTTP use `@lumenize/structured-clone`. No degraded JSON-only path.

**Alternatives rejected:**
- **Drop to plain JSON for resources** — considered to simplify storage (native `json_extract` indexing, RFC 7396 merge patch). Rejected because it creates a split world: rich types in RPC but not in resources. This is a footgun for vibe coders and agentic code that expect consistency across all Mesh APIs. Keeping rich types everywhere is simpler to reason about even if it forecloses some SQLite-native optimizations.
- **Delta delivery via merge patch** — explored extensively. RFC 7396 merge patch produces near-full-size patches on the `$lmz` array-based `objects` format (95% of full size — arrays are atomic in RFC 7396). A dictionary variant improved to 24-60% but adds complexity. Deferred — full value delivery is simpler and sufficient for typical resource sizes (a few KB).
- **`previousValues` for state-change queries** — deferred. Would require a rich-object diff library (no existing npm package handles Date + Map + Set + cycles). Temporal history (full snapshots) is preserved; per-field change queries can be added later.
- **JSONB `json_extract` indexing** — the `$lmz` tuple format makes `json_extract` paths impractical (e.g., `$.objects[0][1].name[1]` to reach a property). When field indexing is needed, the fallback is materializing indexed fields into dedicated columns at write time. Deferred.

### Continuation Storage: When and Why

Not all callback patterns need durable storage. The principle: **store continuations only for patterns where the handler fires at unpredictable future times across potential eviction boundaries.** Accept the small crash window for request-response cycles (same risk profile as regular `lmz.call()`).

Reference patterns:
- **Regular `lmz.call()` with response handler** (4th param) — continuation is in-memory, lost on crash. Acceptable for short request-response cycles. See [Calls](../website/docs/mesh/calls.mdx).
- **Two one-way calls** — caller fires-and-forgets, callee calls back with `newChain: true`. No await, no wall-clock billing. Used in getting-started broadcast and `@lumenize/fetch`. See [Two One-Way Calls](../website/docs/mesh/calls.mdx#two-one-way-calls).
- **`this.svc.alarms`** — stores continuation in SQL, replays on alarm fire. Survives eviction. Used by `@lumenize/fetch` as backup (continuation embedded in alarm args, extracted on cancel).

#### Resource system callback patterns:

| Pattern | When it fires | Eviction risk | Store? | Rationale |
|---------|--------------|---------------|--------|-----------|
| **Subscribe handler** (ongoing updates) | Any future time | High — DO can be evicted between any two updates | **YES** — subscribing DO's SQL | Without storage, subscription silently dies on eviction |
| **Host DO subscriber list** | Needed on every fanout | High | **YES** — host DO's SQL | Must know who to fan out to after restart |
| **Initial value** (first subscribe response) | During subscribe request-response | Low — same as `lmz.call()` | **NO** | If DO crashes before initial value arrives, stored subscription record means it re-subscribes on restart |
| **Read response** | During read request-response | Low — same as `lmz.call()` | **NO** | One-shot, caller can retry |
| **Post-fanout callback** | After each update's fanout | High — updates arrive at any time | **YES** — stored in resource registry entry for the URI template | Part of the resource registration metadata, must survive eviction |
| **Guard function** | Synchronously during request | None — class method | **NO** | Not a continuation, always available from class definition |

#### Update delivery mechanism:

**Not pure fire-and-forget.** The manual `#broadcastContent` in getting-started uses `lmz.call()` with no response handler (4th param `undefined`) — pure fire-and-forget. The resource system needs error feedback to clean up disconnected subscribers, so it uses `lmz.call()` *with* a response handler.

**Flow:**

1. **Subscribe request** — subscribing DO/Client fires-and-forgets to host DO (one-way). Framework stores the continuation in subscribing DO's SQL before sending.
2. **Each update** — host DO calls subscriber via `lmz.call()` with `newChain: true` and a response handler, targeting a framework-provided `@mesh` method on the subscriber (e.g., `_lmzResourceUpdate`).
3. **Dispatch** — subscriber's framework layer receives the update, looks up the stored operation chain for that URI, and executes it via `executeOperationChain()`.
4. **Error feedback** — the response handler on the host DO processes the result. On `ClientDisconnectedError` or per-subscription rejection, the host removes the subscriber.

The continuation stays local to the subscribing DO — the host only stores subscriber addresses (binding + instanceName), not their handler logic.

#### Framework `@mesh` method on subscribers:

The framework registers an internal `@mesh`-annotated method on every `LumenizeDO` and `LumenizeClient` to receive resource updates. Design considerations:

- **Naming convention** — e.g., `_lmzResourceUpdate(uri, response)`. The `_` prefix signals "not for developer use." Needs to be `@mesh`-annotated to be callable via `lmz.call()`.
- **Guard function** — validates that the update comes from a source the receiver is actually subscribed to (URI matches a stored subscription). This prevents spoofed updates and provides a per-subscription rejection signal: if the guard fails, the response tells the host to release *that specific subscription*.
- **Return value** — on success, returns acknowledgment (or void). On guard rejection, returns a structured signal (e.g., `{ unsubscribe: true, uri }`) that the host's response handler interprets as "remove this subscriber for this URI."

#### Dual cleanup mechanism:

Two distinct cleanup scenarios, both handled through the same `lmz.call()` response handler on the host DO:

| Scenario | Signal | Source | Host action |
|----------|--------|--------|-------------|
| **Client fully disconnected** (outside grace period) | `ClientDisconnectedError` | Gateway returns immediately — no WebSocket, grace period expired | Remove ALL subscriptions for that subscriber |
| **Per-subscription rejection** (subscriber connected but doesn't want this update) | Guard rejection response (e.g., `{ unsubscribe: true }`) | Subscriber's `@mesh` method guard | Remove only this subscriber's subscription for this specific URI |

The first scenario is the common case — client closes tab, network drops, grace period expires. The second is a consistency safeguard — e.g., the subscriber unsubscribed locally but the host hasn't processed it yet.

#### Wall-clock billing analysis:

Using a response handler (4th param) means the host DO has an `await` under the covers, keeping it in wall-clock billing during fanout. Analysis of impact:

- **Disconnected subscribers**: Gateway returns `ClientDisconnectedError` immediately — negligible billing.
- **Connected subscribers**: Gateway waits for client to process the update. Processing is fast (dispatch to stored continuation), so the wait is bounded.
- **Concurrency limit**: Cloudflare limits DOs to ~6 concurrent outbound sub-requests. For N subscribers, the framework must batch calls (e.g., 1000 subscribers = ~167 sequential batches of 6). Wall-clock billing is `batches × max(per-batch processing time)`, not just `max(all)`. This is acceptable for small subscriber counts but degrades for high-fanout scenarios.
- **Acceptable tradeoff for initial implementation**: The error feedback enables automatic cleanup, which is essential for a production resource system. Without it, disconnected subscribers accumulate silently and the host fans out to dead endpoints indefinitely.
- **Future mitigation**: Fanout offloading (see Future Enhancements and `tasks/backlog.md` "Fanout broadcast service") moves the billing to a Worker (CPU-only billing, no wall-clock). The tiered fanout design in the backlog handles up to ~262K subscribers with 3 tiers of Workers.

#### Continuation serialization infrastructure:

The existing [continuation infrastructure](../website/docs/mesh/continuations.mdx) provides everything needed:

- **Serialization**: `getOperationChain()` extracts serializable OCAN operation chains (ops array + captured `callContext`). Auth context survives serialization.
- **Storage**: Same pattern as `this.svc.alarms` — persist to SQL, replay later. Subscriptions are multi-fire instead of one-shot.
- **Execution**: `executeOperationChain(chain, target)` replays a stored chain on a target object.

Subscribing DO stores in SQL:

| Column | Content |
|--------|---------|
| `uri` | Resource URI subscribed to |
| `operationChain` | Serialized continuation (OCAN ops + callContext) |
| `options` | initialValue, etc. |

For **Clients**, no SQL storage needed — callbacks are in memory and the framework re-subscribes on WebSocket reconnect using the in-memory subscription list.

## Resolved Questions

All 6 questions resolved. API details documented in the MDX.

1. **Relay mechanism** — BroadcastChannel semantics (own messages not echoed). Post-fanout callback on registration. See "Future Enhancements" for fanout offloading.
2. **Wildcard subscriptions** — Deferred. The fixed URI template scheme accommodates without breaking changes — subscribing to `/resources/content/` (no `resourceId`) would mean "all content resources on this DO."
3. **Initial value on subscribe** — `subscribe()` is read + subscribe in one call. `initialValue` seeds if absent. Always returns full `Snapshot<T>`.
4. **Read vs Subscribe** — `lmz.read()` is subscribe without ongoing subscription. Same storage. Both always return full `Snapshot<T>`.
5. **Resource discovery** — `lmz.discover()` (Mesh) and `GET /discover` (HTTP) return registered URI templates with config plus a static protocol summary. Unguarded — public metadata. Code Mode agents read `.d.ts` files directly for resource shapes.
6. **Per-operation guards** — Guards are arrays executed in middleware pattern. Each guard receives the same info object as the unified handler (operation, resourceType, resourceId, snapshot, incoming for upsert). TypeScript discriminated union on `operation`. Guards throw to disallow. Runs post-fetch, pre-response. Guard-on-subscribe-only — no re-checking on fanout. No separate `readGuard`/`writeGuard`.

## Testing Invariant

**Every resource test must use an object that includes a Map, a Date, and a Cycle** to guard against accidental `JSON.stringify()` usage. The framework must use `@lumenize/structured-clone` for both Mesh and HTTP transports.

## Prerequisites

- [ ] Design documented in MDX (`website/docs/mesh/resources.mdx`)
- [ ] API finalized with maintainer
- [ ] Open questions resolved

## Implementation Phases

### Phase 0: Design Documentation

**Goal**: Draft the resources MDX documentation with API examples covering Mesh and HTTP transports.

**Success Criteria**:
- [x] `website/docs/mesh/resources.mdx` created with initial API narrative
- [x] Code examples use `@skip-check` (converted to `@check-example` in Phase 5)
- [x] `website/sidebars.ts` updated with new page
- [x] Open questions resolved (6/6 — see Resolved Questions section)
- [ ] Maintainer sign-off on API design

### Phase 0.5: Remove `gateway` Prefix

**Goal**: Remove the hardcoded `prefix: 'gateway'` convention so URLs and resource URIs are identical. Prerequisite for resource URI addressing.

**Files to update:**
- `packages/mesh/src/lumenize-client.ts` (line 606) — hardcoded `/gateway/` in WebSocket URL construction. Make prefix-aware or default to no prefix.
- `packages/mesh/test/test-worker-and-dos.ts` — `prefix: 'gateway'`
- `packages/mesh/test/for-docs/getting-started/index.ts` — `prefix: 'gateway'`
- `packages/mesh/test/for-docs/security/index.ts` — `prefix: 'gateway'`
- `packages/mesh/test/for-docs/calls/index.ts` — `prefix: 'gateway'`
- `packages/mesh/test/lumenize-client.test.ts` — URL assertions with `/gateway/`
- `packages/mesh/test/for-docs/security/index.test.ts` — URL assertions with `/gateway/`
- `website/docs/mesh/getting-started.mdx` — `prefix: 'gateway'` in code example
- `website/docs/mesh/security.mdx` — `prefix: 'gateway'` in code example

**Success Criteria**:
- [ ] `lumenize-client.ts` no longer hardcodes `/gateway/` in URL construction
- [ ] All example Workers use `routeDORequest` without a prefix, positioned last in chain
- [ ] All tests pass with no-prefix routing
- [ ] Docs updated to show auth routes first, mesh routing last with no prefix

### Phase 1: Core Mesh Resources — Subscribe and Read

**Goal**: Implement `this.lmz.resources()` with temporal storage, plus client-side `lmz.subscribe()` and `lmz.read()`.

**Success Criteria**:
- [ ] `this.lmz.resources(config)` accepts slug-keyed config object with per-type `class`, `guards`, and options — framework generates URI templates from slugs
- [ ] Snodgrass-style snapshots table created per resource URI template
- [ ] `lmz.subscribe(uri, handler)` works from DOs and Clients
- [ ] `lmz.read(uri)` works from DOs and Clients
- [ ] `lmz.discover()` returns registered templates with config and protocol summary
- [ ] Reads and subscribes always return full `Snapshot<T>` (`{ value, meta }`) — no conditional reads
- [ ] Unified handler info objects implemented per "Unified Handler Signatures" design — `ReadInfo`, `SubscribeInfo` with common `operation`, `resourceType`, `resourceId`, `snapshot` fields
- [ ] Guard array receives the same info object as handler — runs post-fetch, pre-response. Auth via `this.lmz.callContext`. Guards throw to disallow. Guard-on-subscribe-only (not re-checked on fanout)
- [ ] Own messages not echoed back (BroadcastChannel semantics)
- [ ] Test objects include Map, Date, and Cycle

### Phase 2: Core Mesh Resources — Upsert and Delete

**Goal**: Implement client-side `lmz.upsert()` and `lmz.delete()` with temporal storage and optimistic concurrency.

**Success Criteria**:
- [ ] `lmz.upsert(uri, value, meta.eTag?)` — creates if absent, replaces if present. Optional eTag for optimistic concurrency
- [ ] `lmz.delete(uri)` — soft delete preserving history
- [ ] Upsert response protocol — success: `{ ok, meta }`, conflict: `{ ok, value, meta }`, rejected: `{ ok }`
- [ ] Optimistic concurrency — upserts rejected when `meta.eTag` doesn't match current stored eTag. Conflict response includes current `Snapshot<T>`. Provides "create-only" protection: pass `meta.eTag` and the write is rejected if the resource already has a different eTag
- [ ] `changedBy` stored as `SubChain[]` — single-element array for normal writes, ready for compaction
- [ ] Debounce — same sub chain updates within `debounceMs` overwrite current snapshot in place
- [ ] `history: false` — single-row mode, always overwrites
- [ ] `UpsertInfo` and `DeleteInfo` handler info objects implemented — adds `incoming` and `eTag` fields for upsert
- [ ] Guard array executes in sequence (middleware pattern) — each guard receives full info object, `incoming` available for upsert, TypeScript discriminated union narrows correctly. Guards throw to disallow.
- [ ] Test objects include Map, Date, and Cycle

### Phase 3: Reconnection, Lifecycle, Cleanup

**Goal**: Handle real-world cases — client disconnects, DO eviction, resubscription.

**Success Criteria**:
- [ ] Framework hooks into Gateway `subscriptionRequired` signal — auto-resubscribes all resource subscriptions from Client's in-memory list
- [ ] Developer `onSubscriptionRequired` fires after framework resource resubscription completes
- [ ] Host DO removes ALL subscriptions for a subscriber on `ClientDisconnectedError` (client fully disconnected)
- [ ] Host DO removes single subscription on per-subscription guard rejection (subscriber connected but doesn't want this update)
- [ ] DO eviction and restart preserves subscription state (stored continuations in SQL)
- [ ] Graceful handling of operations on URIs with no subscribers

### Phase 4: HTTP REST Transport

**Goal**: Expose resources over HTTP via the existing Worker infrastructure. HTTP exclusively uses `application/vnd.lumenize.structured-clone+json` — full fidelity, same as Mesh.

**Success Criteria**:
- [ ] Worker routes HTTP requests directly to destination DO (Gateway not involved)
- [ ] `onBeforeRequest` at the Worker level handles auth, rate limiting for HTTP requests
- [ ] Request/response content type: `application/vnd.lumenize.structured-clone+json`
- [ ] `If-Match` header on PUT carries `meta.eTag` for optimistic concurrency (upsert only, not reads)
- [ ] `GET /discover` returns same discovery data as `lmz.discover()`
- [ ] Test objects include Map, Date, and Cycle

### Phase 5: Tests and Doc Validation

**Goal**: Full test coverage and documentation validation.

**Success Criteria**:
- [ ] `test/for-docs/resources/` integration tests
- [ ] All `@skip-check` converted to `@check-example`
- [ ] Branch coverage >80%, statement coverage >90%
- [ ] Getting-started example updated to use framework resources (removes manual `onSubscriptionRequired` usage)
- [ ] `onSubscriptionRequired` removed from `getting-started.mdx` and `lumenize-client.mdx` examples; kept in API reference as advanced/low-level option
- [ ] "Resource Patterns" section added to `resources.mdx` showing three usage styles: single-value (DocumentDO), multi-value (ChatRoomDO), multi-schema (ProjectDO with settings + tasks)

### Final Verification (every phase)
- [ ] All tests pass (`npx vitest run` in package dir)
- [ ] Type-check clean (`npm run type-check`)
- [ ] Docs match implementation: grep `.mdx` files for keywords from changed APIs
- [ ] JSDoc comments in source reflect current behavior

## Current Manual Pattern (for reference)

The pattern being replaced lives in `packages/mesh/test/for-docs/getting-started/`:

- **`document-do.ts`** — `subscribe()` adds `callChain[0].instanceName` to a `Set<string>` in KV; `#broadcastContent()` loops over subscribers calling `lmz.call()` with `newChain: true`
- **`editor-client.ts`** — `#subscribe()` calls DocumentDO's `subscribe()`; `onSubscriptionRequired` re-subscribes all open documents on reconnect; `handleContentUpdate()` receives broadcasts
- **`index.test.ts`** — Integration test showing two clients subscribing and receiving broadcasts

## Prior Art in lumenize-monolith

### URI Template Parser (reuse)

`lumenize-monolith/src/entity-uri-router.ts` — `EntityUriRouter` class with `parseEntityUri()` and `buildEntityUri()`. This is a partial RFC 6570 implementation: it handles simple `{variable}` placeholders with pre-compiled regex matching and component validation, but does **not** support RFC 6570 operators (`{+path}`, `{#fragment}`, `{?query}`, etc.). It was purpose-built to replace a heavier `uri-template-router` dependency. The same approach (fast manual parser for simple templates) should work for the resource system — now even simpler since the framework generates all templates from a fixed pattern (`/resources/{resourceType}/{resourceId}`) rather than parsing developer-specified templates.

### Temporal Data Model (adapt)

`lumenize-monolith/` has a fully implemented temporal versioning system (Snodgrass pattern) that maps directly to the built-in temporal storage. Key files:

- **`src/entities.ts`** — `snapshots` SQL table: `entityId`, `validFrom`, `validTo` (current = `'9999-01-01T00:00:00.000Z'`), `value`, `previousValues`, `changedBy`, `deleted` flag. Indexed for current-state and hierarchy queries. Note: mesh resources drops `previousValues` — see Storage Format section.
- **`src/entity-upsert.ts`** — `#handleUpsert()` with baseline validation (optimistic concurrency using `validFrom` as version identifier), idempotent no-op on unchanged values, monotonic timestamp enforcement (+1ms on collision).
- **`src/entity-read.ts`** — current state reads, point-in-time historical reads (`WHERE validFrom <= ? AND validTo >= ?`).
- **`src/json-merge-patch.ts`** — RFC 7396 JSON Merge Patch. Referenced for context; mesh resources does not use merge patch for storage or delivery.
- **`src/entity-subscriptions.ts`** — `subscriptions` SQL table. Subscription model adapted for mesh resources.
- **`src/entity-delete.ts`** — soft delete/undelete preserving full history.
- **Integration tests** — `integration-entity-lifecycle.test.ts` (~670 lines) and `integration-entity-patch-subscription.test.ts` (~470 lines) covering historical reads, patch operations, baseline validation, and subscription baseline chains.

The code is tightly coupled to the monolith's entity model, so it needs adaptation rather than direct extraction. The temporal patterns (snapshot table design, baseline validation) are the reusable part.

**Note**: lumenize-monolith has no debounce — every change creates a new snapshot. Sub chain debouncing is new for mesh resources.

**Improvements over the monolith implementation:**
- **JSONB instead of JSON strings** — Cloudflare DOs now support JSONB in SQLite, which wasn't available when lumenize-monolith was written. The `value` column uses JSONB for better query performance and storage efficiency.
- **No `previousValues` column** — the monolith stored reverse merge patches for undo and state-change queries. Mesh resources stores full snapshots only; per-field change tracking is deferred (see Storage Format section and Future Enhancements).
- **Simpler snapshot model** — no merge patch computation at write time. Snapshots store the full value. Sub chain debouncing reduces row churn during rapid edits.

## Future Enhancements

### Fanout Offloading

The initial implementation relays updates to subscribers directly from the host DO. For DOs with many subscribers, this could become a bottleneck. Future options:

- **Offload to a Worker** — the host DO sends the update once to a Worker, which handles the fan-out to all subscribers
- **Fanout service** — a dedicated service similar to `@lumenize/fetch`, purpose-built for high-fanout delivery with backpressure and retry

### Delta Delivery

Currently all reads and subscription updates return the full resource value. For large resources that change frequently with small updates, RFC 7396 JSON merge patch could deliver only the changed fields. This can be added at the storage layer (compute diff in TypeScript, return patch to caller) without changing the wire format. SQLite's native `jsonb_patch()` is a further optimization. Defer until profiling shows full-value delivery is a bottleneck.

### Per-Field Change Tracking (`previousValues`)

The monolith stored reverse merge patches for state-change queries ("when did status change from X to Y?"). Mesh resources defers this. Options for later:
- Add a `previousValues` JSONB column storing the old values of changed fields at write time
- Materialized index columns for commonly queried change fields
- Application-level diffing by comparing adjacent snapshots

### Granularity-Based Compaction

Debounce handles rapid same-sub-chain updates, but long-lived resources accumulate snapshots from different sub chains over time. A granularity-based compaction feature would collapse snapshots within the same time window (e.g., hourly, daily) regardless of sub chain — using ISO date string prefix matching. Could run as a background alarm or on-demand. `changedBy` arrays are concatenated and deduplicated across collapsed snapshots — no schema change needed since `changedBy` is `SubChain[]` from the start. Deferred — debounce covers the launch use case; compaction is a retention/storage optimization.

### JSONB Field Indexing

The `$lmz` preprocessed format makes `json_extract()` paths impractical for direct JSONB indexing. When field indexing is needed, the framework materializes indexed fields into dedicated columns at write time with proper SQLite indexes. Developers would declare indexed fields in the resource registration. Deferred — not needed for initial implementation.

### Runtime Validation

TypeScript provides compile-time safety but no runtime validation of incoming writes. The preferred approach is a purpose-built `@lumenize/validate` package that takes `.d.ts` files as input — consistent with the TypeScript-first philosophy. Alternative: JSON Schema via `typescript-json-schema` + `@cfworker/json-schema`. Either way, the resource registration API can accept an optional `schema` or `validate` parameter when this lands.

**CLI:** The unscoped `lumenize` npm package (already owned) becomes the CLI (`"bin": { "lumenize": "./bin/lumenize.js" }`). The CLI's initial command would be `lumenize schemas` for runtime validation. `@lumenize/*` are the runtime packages. We've submitted a request to npmjs to get control of the `lmz` package (no updates for 8 years, 1 download per week) — if granted, `lmz` becomes an alias. CLI uses independent versioning starting at 2.0.0 (the old `lumenize` on npm was last published at 1.2.0). CLI lives in the monorepo but is excluded from Lerna's synchronized versioning.

### MCP Resources Transport

Expose resources via MCP protocol, dispatching to the same unified handlers as Mesh and HTTP. Deferred — Code Mode agents (writing TypeScript against the Mesh API directly) are the primary agentic target. MCP can be added when there's demand, using the same unified handler layer. Reference implementation exists in `lumenize-monolith/src/lumenize-server.ts` and related files.

### JSON HTTP Transport

Add `application/json` content negotiation to the HTTP transport for curl/Postman-friendly access. Would require clear error handling when resource values contain non-JSON-serializable types (Date, Map, Set, cycles). Deferred — structured-clone HTTP covers all programmatic use cases.

## Notes

- Broken out from `tasks/mesh-post-release-part-2.md` to be tackled independently
- Related to "Could have: Subscribe" and "Could have: Fanout service" in `tasks/todos-for-initial-mesh-release.md`
- Auth infrastructure (`onBeforeRequest`, JWT, rate limiting, Bearer tokens) already in place at Worker level for HTTP transport — Gateway only involved for WebSocket connections
- `@lumenize/structured-clone` handles Map, Date, Set, RegExp, cycles, BigInt, TypedArrays, and Web API objects (Request, Response, Headers, URL)
- MCP resources handling exists in `lumenize-monolith/src/` (lumenize-server.ts, entity-uri-router.ts, entity-read.ts, entity-subscriptions.ts, notification-service.ts) as reference for future MCP transport work
- **Resource Patterns section (post-implementation):** Document three usage styles with real examples after the system is built: (1) single-value — DocumentDO with `'content'` slug → `/resources/content/main`, (2) multi-value — ChatRoomDO with `'message'` slug → `/resources/message/{resourceId}` (competitive with Cloudflare Agents SDK's common chat pattern), (3) multi-schema — ProjectDO with `'settings'` + `'task'` slugs → `/resources/settings/{resourceId}` + `/resources/task/{resourceId}` (different schemas, different guards, one DO). Pattern 3 explains sharding decisions and co-location — leads naturally into Nebula's tenant DO model without needing to explain Nebula itself

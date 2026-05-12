# Nebula Frontend

**Status**: Active — demo critical path
**Depends on**: Phase 5.1 (Storage Engine — shipped), Phase 5.2 (Validation/Ontology — shipped)
**Companion docs** (canonical surface; defer to these for API + examples):

- [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — app-generating-LLM-facing API, directives, conflict-resolution patterns, worked examples. **The source of truth for what the stack exposes.**
- [website/docs/nebula/nebula-client.md](../website/docs/nebula/nebula-client.md) — `NebulaClient` reference
- [website/docs/nebula/auth-flows.md](../website/docs/nebula/auth-flows.md) — auth flow sequence diagrams

> **DRAFT** — consolidates the original `tasks/nebula-5.3-subscriptions.md`, `tasks/lumenize-ui.md`, and `tasks/nebula-7-client.md` into a single design home for the Nebula frontend stack. Originals in `tasks/archive/`.
>
> Changelog:
> - 2026-05-06 — original 5.3 draft
> - 2026-05-09 — namespace (`client.resources.*`), handler separation, client-generated eTag idempotency, package split (`@lumenize/state` + `@lumenize/ui` + `@lumenize/router`), no ObjectDOM port, Alpine-flavored DOM crawler
> - 2026-05-10 — lazy ontology-version model pulled forward from `apps/nebula/src/star.ts`, `onShouldRefreshUI`, `meta` not `__meta`, addressing conventions pinned (`[A-Za-z0-9_-]`), `ConflictResolution` discriminated union, `client.bindToState()` synced-state middleware
> - 2026-05-11 — flash class behavior, `maxRetries`, `context.bindings` resolver third-arg, dynamic-DOM lifecycle (MutationObserver, 2 s unsubscribe grace, microtask-deferred removal), `x-for` / `x-if` directives with `<template>`-as-host + `$loopVar` substitution, `!path` negation, `state.computed()`, three-layers framing, consolidation into this file

## Three layers, clean boundaries

| Layer | Code lives | Knows about |
| --- | --- | --- |
| **`@lumenize/state`** | `packages/state/` (to be ported from JurisJS) | Itself only. Pure path-based reactive store. No DOM. No NebulaClient. |
| **`@lumenize/ui`** | `packages/ui/` (to be written from scratch) | `@lumenize/state` only. DOM crawler, `x-*` directives, MutationObserver lifecycle, per-element `WeakMap` registry. No NebulaClient, no `resources.*` prefix, no Nebula wire protocol. |
| **Integration (`client.bindToState`)** | `apps/nebula/src/nebula-client.ts` | All three layers, plus Nebula's wire protocol, resources schema, ontology versioning, conflict semantics, ID lifecycle. *This* is where Nebula-specific knowledge lives. |

The integration layer hooks into the generic packages through two extension points the packages expose:

- **`setState` middleware** on `@lumenize/state` — `bindToState` installs middleware that watches writes to `resources.{rt}.{rid}.*` paths and emits transactions.
- **Subscriber-registration event** on `@lumenize/state` — `bindToState` listens for new path-subscribers under `resources.*` and reference-counts them for auto-subscribe.

Both extension points are generic; any consumer can use them for any prefix. A non-Nebula consumer could use `@lumenize/state` + `@lumenize/ui` standalone with no NebulaClient.

**Why design discussions feel integration-heavy:** because they are. The pure primitives got designed quickly. Most domain decisions (conflict resolution, refcount-with-grace, flash class, eTag-as-idempotency, `onShouldRefreshUI`) live in the integration layer.

**Reversal question raised 2026-05-11 and declined** — the lines are clean even though discussion is integration-heavy. Folding into Nebula would lose the MIT-reusable-packages story and force Studio's bundler to extract them anyway.

## Package picture

| Package | Source | Scope | Status |
| --- | --- | --- | --- |
| `@lumenize/state` | Port from JurisJS | StateManager + path helpers (`isValidPath`, `getPathParts`, `deepEquals`), `track`, `computed`, middleware list. ~340 LOC. | Phase 5.3.0 prerequisite |
| `@lumenize/ui` | Written from scratch | `bindDom(root, state, options?)` DOM-crawl helper with Alpine-flavored `x-*` directives. ~200 LOC + `x-for` / `x-if`. | Built alongside Studio demo |
| `@lumenize/router` | Written from scratch | URL ↔ state-path two-way sync. ~200 LOC. | Studio-blocking; deferred until first Studio app needs routing |

Why not take Alpine as a dep:

- Path-based vs Proxy-based reactivity mismatch (load-bearing for synced-state middleware, eTag-stored-at-sibling-path, per-path snapshot fanout).
- Alpine's runtime cost (~30 KB minified) vs ~200 LOC custom implementation.
- We borrow Alpine's *directive syntax* for LLM training-data alignment without taking the dep.

DaisyUI is pinned as the styling layer — class-based, framework-free, no coupling to reactivity model.

## Background: lazy ontology-version model

Already implemented in `apps/nebula/src/star.ts` (canonical). Pulled forward here because it's load-bearing for every resource operation.

- **No proactive deploy push.** Detection is lazy, triggered by client operations.
- **Star caches one ontology row** — the latest seen. `_index` (KV) stores the full ordered version history for migration chains, but only the latest has a cached `OntologyVersionRow`. See [star.ts:71](apps/nebula/src/star.ts:71) `#isCachedVersion`.
- **Cache hit** ([star.ts:167](apps/nebula/src/star.ts:167)): client's `ontologyVersion` matches cached latest → execute directly. Warm steady-state path.
- **Cache miss** ([star.ts:170-178](apps/nebula/src/star.ts:170)): Star calls `Galaxy.getLatestOntologyVersion()`. Two outcomes:
  - Galaxy's latest matches client's version → `#installState` updates Star's cache; execute.
  - Galaxy's latest does *not* match → mismatch returned. **This is the staleness signal.** Today a generic `Error`; Phase 5.3.3 converts to structured `{ kind: 'ontology-stale', clientVersion, currentVersion }` dispatched to `onShouldRefreshUI`.
- **First-vN+1 client unblocks all later vN clients.** Fresh page load with new bundle hits Star with vN+1 → Star caches vN+1 → subsequent vN ops cache-miss → mismatch detected.

## NebulaClient — two-scope model (shipped)

Already shipped via earlier auth work (`tasks/archive/nebula-auth.md`, `tasks/archive/nebula-baseline-access-control.md`):

- **Auth scope** (`authScope`): refresh cookie path, 3-tuple `{u}.{g}.{s}`
- **Active scope** (`activeScope`): JWT `aud` claim, 4-tuple `{u}.{g}.{s}.{branch}` (branch added 2026-05-07 per `tasks/nebula-branches.md`)
- **Refresh path**: `POST ${baseUrl}/auth/${authScope}/refresh-token` with `{ activeScope }` body
- **NebulaClientGateway**: `onBeforeCallToClient` checks `aud` matches connected client's `aud`
- **Handler 1/2 dispatch from Star**: `transaction()` and `read()` on Star call back via `lmz.call('NEBULA_CLIENT_GATEWAY', clientId, this.ctn<NebulaClient>().handleTransactionResult(result))`
- **LumenizeClient base**: auto-reconnect with 5-second grace + exponential backoff

## Decisions pinned

| Decision | Choice | Rationale |
| --- | --- | --- |
| **UI integration boundary** | `@lumenize/state` `getState`/`setState`, NOT a generic event emitter on NebulaClient. Nebula-specific glue (auto-subscribe, conflict resolver, flash class, refcount-with-grace, `resources.*` prefix interpretation) lives in NebulaClient's `bindToState`, NOT in either generic package. See § "Three layers". | Packages stay generic and MIT-reusable; integration is the third layer where Nebula-specific knowledge lives. |
| **Local value store** | `@lumenize/state`'s StateManager is THE store. NebulaClient holds NO shadow cache. `value` and `meta` live at sibling paths (`resources.todo.task-42.value`, `resources.todo.task-42.meta`). | One source of truth, reactivity for free, no sync-two-stores hazard. |
| **Headless mode** | NebulaClient depends on `@lumenize/state` directly — no renderer needed. | Same StateManager-shape works in Node/Workers tests as in browser. |
| **API namespace** | `client.resources.{subscribe, read, transaction, onETagConflict}`. | `subscribe`/`read` collide with too many JS APIs to leave bare. |
| **Subscribe scope** | Single resource `(resourceType, resourceId)`. | Multi-resource subscriptions deferred. |
| **Fan-out path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)`. | Same Handler 1 / Handler 2 plumbing used by `transaction()` and `read()`. |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required); `bindingName` + `instanceName` from `callContext.callChain.at(-1)`. | Subscriptions are user-initiated, not mesh-to-mesh. |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber. | Prevents double-render when originator already updated optimistically. |
| **Guard placement** | DAG read-permission check once at subscribe time, not on each fanout. | Resource-level access doesn't change mid-subscription except via DAG mutation (separate concern). |
| **Auto-resubscribe on reconnect** | Client maintains local subscription registry; on LumenizeClient `connected` event after `reconnecting`, re-subscribe each entry. | LumenizeClient already auto-reconnects; only need to re-register. |
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. Default `statePath` = `resources.{resourceType}.{resourceId}`. | Period-delimited state paths and slash-delimited URLs must be unambiguously interconvertible. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings reactive to bulk-snapshot pushes without spurious re-renders. |
| **Reserved state-path prefixes** | Two top-level prefixes are framework-reserved: `resources.*` (synced resource snapshots — `resources.{rt}.{rid}.value` and `.meta`) and `lmz.*` (everything else framework-owned — connection state, future things). All other top-level segments (`ui.*`, `app.*`, etc.) are app-owned. Framework only touches `resources.*` and `lmz.*`. | Two prefixes, not one. `lmz.resources.*` would be strictly consistent but adds a segment to every directive in every UI — significant ongoing ergonomic cost. `resources.` is short and distinctive enough on its own; `lmz.` covers the rare framework-meta cases. App authors get the rest of the namespace. |
| **`lmz.connection.*` connection-state surfacing** | NebulaClient writes LumenizeClient's connection state to `lmz.connection.*` paths so the UI can bind declaratively. Paths: `lmz.connection.state` (`'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'`); `lmz.connection.connected` (boolean — true iff `state === 'connected'`); `lmz.connection.lastConnectedAt` (timestamp ms, set on each `'connected'` transition). Updated by `bindToState`'s setup — subscribes to LumenizeClient's connection events, writes through on each transition. | Real-time-sync demos need a visible connection-state indicator (part of the wow factor; also tells users when their edits aren't reaching the server). Surfacing as state paths makes it declarative: `<div x-show="!lmz.connection.connected">Reconnecting…</div>` works without event listeners in user code. Three paths cover common cases (state string for fine-grained display, boolean for show/hide, timestamp for "last synced X ago" UX). |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. | Cleaner than separate `txnId` — no server-side dedupe table, idempotency implicit in the eTag itself. Auto-retry safe across network drops. |
| **Transaction queue** | Serial — at most one transaction in flight per client; subsequent calls queue. 5–10 s timeout then reject (queue unblocks). Caller-decided retry. Queue blocks transactions on *all* resources/fields, not just the in-flight one. Optimistic local state still paints immediately on `setState` (the middleware does `setState` first, then enqueues) — so the user sees their typing land regardless of queue state. Queue is in-memory only; refresh clears it. | Matches human editing speeds; avoids partial-application reasoning. Timeout collapses all "I don't know what happened" failure modes to one signal. Optimistic-paint-then-enqueue means visual responsiveness is unaffected by queue depth. |
| **Resolver execution suspends queue timeout** | When `handleTransactionResult` invokes an async resolver (returns a Promise), the 5–10 s timeout is suspended until the resolver settles. When the framework submits the new transaction post-resolver, a fresh timeout starts for that submission. No max-duration enforced on the resolver itself — a modal can sit open for minutes if the user gets distracted. | The 5–10 s timeout is for "I don't know what happened to this call" cases. During resolver execution, the framework knows exactly what's happening — the user has the modal. App-level timeouts on the resolver (e.g., "auto-cancel after 30s") are the caller's responsibility via `Promise.race`. |
| **Conflict resolver (per resource type)** | Registered via `client.resources.onETagConflict(resourceType, resolver, options?)`. Per-call override via `options.onETagConflict` on `transaction()`. Framework default = `() => ({ resolution: 'use-server' })`. Resolver returns `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). Receives third `context: { bindings: Map<path, HTMLElement[]> }` for custom UX. | Conflict strategy is resource-shape-specific; per-type is the right grain. Discriminated union makes intent unambiguous. `'use-this'` triggers recursive new transaction (bounded by `maxRetries`, default 5, then `'conflict-retries-exhausted'`). `'human-in-the-loop'` rejects with `'conflict-handoff'`; optimistic state stays painted; app re-submits. |
| **Conflict flash class** | After resolution, framework compares resolved value to `local.value` field-by-field; for diff fields, adds `flashClass` to bound elements for `flashDuration` ms. Default class `lumenize-conflict-revert`, duration 1000 ms. Configurable per type via `onETagConflict('rt', resolver, { flashClass, flashDuration })`; `flashClass: null` disables. | Default visual signal that user input was changed by a conflict, without explicit UX code. Field-diff inference means only actually-affected fields flash. |
| **`ontologyVersion` on every operation** | NebulaClient constructor argument (Studio's bootstrap fills in at build time). Auto-attached to every `client.resources.*` call. `options.ontologyVersion` per-op override for admin scripts. | Lock-step UI/ontology. Star already takes it for Handler 1/2 dispatch. |
| **Staleness signal + `onShouldRefreshUI` hook** | Star's cache-miss-with-mismatch path returns `{ kind: 'ontology-stale', clientVersion, currentVersion }`. NebulaClient dispatches to registered `onShouldRefreshUI` constructor hook (no default — undefined = opted-out). Originating Promise also settles. | Centralized hook for an orthogonal signal that multiple call sites would otherwise each need to inspect. Distinct from earlier-rejected `onStaleVersion` (which was tied to one error path). |
| **Dynamic-DOM lifecycle (MutationObserver + refcounted subscribe)** | One `MutationObserver` per `bindDom(root, state)` call with `{ childList: true, subtree: true }`. Additions → walk subtree, register bindings, increment per-`(rt, rid)` refcount (0→1 triggers `subscribe`). Removals → schedule unregister via `queueMicrotask` (move-vs-remove check via `el.isConnected`); count→0 schedules `unsubscribe` after `unsubscribeGraceMs` (default 2000); new binding within grace cancels pending unsubscribe. Per-element tracking via `WeakMap<HTMLElement, BindingRecord[]>`. Directive attrs read once at binding time. Configurable via `bindDom(root, state, { autoObserve: false })` and `client.bindToState(state, { unsubscribeGraceMs: 2000 })`. | JurisJS auto-cleanup already calls for MutationObserver; we extend for additions. Microtask defer handles moves. Refcount-with-grace covers tab-switch / modal / quick-rerender churn cheaply. Read-once attrs avoid attribute-mutation re-binding (Studio templates don't need it). |
| **`x-for` (list iteration)** | `<template>`-only host. Syntax: `<template x-for="loopVar in path" x-key="...">`. Scoped path resolution: first segment === `loopVar` → scoped value navigation; path contains `$loopVar` → substitute the value as a string; otherwise normal state path. `x-key` required (default by-index logs a warn). Reactivity: diff old vs new keys; unchanged clones stay, added clones inserted (MutationObserver picks up bindings), removed clones (MutationObserver picks up unbind). | Iteration genuinely can't be path-only; carve out one directive. `<template>` host matches Alpine and makes "definition, not real DOM" unambiguous. `$loopVar` substitution enables FK-list rendering without JS map. |
| **`x-if` (conditional mount/unmount)** | `<template>`-only host. Syntax: `<template x-if="path">` or `<template x-if="!path">`. JS truthiness. No inline comparisons — use `state.computed()` for derived booleans. Don't combine `x-for` and `x-if` on same `<template>`; nest. Mount fires MutationObserver `addedNodes`; unmount fires `removedNodes`. No `x-else` / `x-else-if`. | Mount/unmount (vs `x-show`'s display-toggle) frees bindings when subtree invisible. `!path` matches Alpine; `x-unless` would create LLM friction. Skipping `x-else` keeps grammar minimal; `state.computed()` is the principled path for complex conditions. |

## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` | success: yes; `'use-server'`: rejects `'conflict-lost'`; `'use-this'`: stays pending across recursive chain until terminal (success or `'conflict-retries-exhausted'`); `'human-in-the-loop'`: rejects `'conflict-handoff'`; validation: rejects `'validation-failed'`; permission: rejects `'permission-denied'` | success: yes (write authoritative value + new eTag); `'use-server'`: yes (write `server.value`); `'use-this'`: yes (optimistic write `value`, then submit); `'human-in-the-loop'`: no; `'validation-failed'`: rollback to last-confirmed; `'permission-denied'`: rollback to last-confirmed |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves initial-snapshot Promise from `client.resources.subscribe()`; thereafter, fire-and-forget pushes | only first call settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `{statePath}.value` and `meta` to `{statePath}.meta` |
| `client.resources.read(rt, rid)` | returns `Promise<Snapshot \| null>` | yes — caller `await`s the Snapshot | **none** — caller decides |

The first two are necessarily `@mesh` handlers because Star calls them. The third is a method; how its Promise gets resolved (callId correlation, hidden plumbing handler, or extending mesh return-value path) is a mesh-framework implementation detail to resolve during 5.3.3.

UI flow uses `subscribe` for reactive reads. `read` is the explicit-intent escape hatch for ad-hoc / scripting.

## Two `subscribe`s — different things

The word "subscribe" appears at two layers, doing two different jobs.

| Call | Layer | Network? | Purpose |
| --- | --- | --- | --- |
| `client.resources.subscribe(rt, rid, statePath?)` | NebulaClient | yes — WS round-trip to Star | Tells Star to push snapshots on every change. Inserts row in Star's `Subscribers` table. |
| `state.subscribe(path, cb)` | `@lumenize/state` StateManager | no — purely in-memory | Registers a callback that fires whenever `setState` writes to this path *in this browser tab*. |

`client.resources.subscribe` gets data flowing *into* the local store from server. `state.subscribe` binds anything (DOM elements, computed paths, anything else) *to* that store. The DOM-binding crawler in `@lumenize/ui` only uses `state.subscribe` — it has no idea NebulaClient or Star exist.

## Surface — implementation signatures

User-facing API + usage examples live in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md). This section is API contracts only.

### Star side (`apps/nebula/src/star.ts`)

Add a `@mesh()` `subscribe` method mirroring the Handler 1 / Handler 2 pattern from `transaction()` and `read()`:

```typescript
@mesh()
subscribe(ontologyVersion: string, resourceType: string, resourceId: string) {
  // Handler 1: validate ontology version, dispatch to Handler 2 with cache-or-fetch
}

doSubscribe(
  fetchedState: OntologyState | null | Error,
  ontologyVersion: string,
  resourceType: string,
  resourceId: string,
  clientId: string,
) {
  // 1. ontology version check
  // 2. DAG read-permission check on resource's nodeId
  // 3. Register subscriber: { sub, clientId, resourceType, resourceId }
  // 4. Read current snapshot
  // 5. Push initial value to client via handleResourceUpdate
}
```

`#onChanged` (currently a Phase 3.1 placeholder) is replaced with subscriber-driven fanout: on every resource mutation in `transaction()`, look up subscribers for affected `(resourceType, resourceId)`, exclude originator, call each subscriber's Gateway with the new snapshot.

### Subscriber storage (SQL on Star)

```sql
CREATE TABLE Subscribers (
  sub TEXT NOT NULL,
  clientId TEXT NOT NULL,
  gatewayBinding TEXT NOT NULL,
  resourceType TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  PRIMARY KEY (clientId, resourceType, resourceId)
) WITHOUT ROWID;

CREATE INDEX idx_Subscribers_resource ON Subscribers (resourceType, resourceId);
```

Per CLAUDE.md SQL conventions: PascalCase table, camelCase columns, `WITHOUT ROWID` for compound PK, index on fanout-lookup column.

### NebulaClient handlers + `client.resources.*` (`apps/nebula/src/nebula-client.ts`)

```typescript
// Mesh handlers — Star calls back through these
@mesh()
handleTransactionResult(result: TransactionResult | Error): void {
  // Settle the in-flight transaction Promise (success / conflict / validation)
  // On success: write authoritative value + new eTag to bound state; advance queue
  // On conflict: invoke registered resolver; act on the resolution
  // On staleness signal: dispatch to onShouldRefreshUI; settle Promise
  // On validation/error: rollback optimistic to last-confirmed; advance queue
}

@mesh()
handleResourceUpdate(resourceType: string, resourceId: string, snapshot: Snapshot | null): void {
  // Unconditional state write-through to {statePath}.value and {statePath}.meta
  // If subscribe() Promise is pending for this (rt, rid), resolve it
  // snapshot === null = deleted; UI sees value undefined
}

client.resources = {
  subscribe(
    resourceType: string,
    resourceId: string,
    statePath?: string,
    options?: { ontologyVersion?: string },
  ): Promise<Snapshot | null>;

  read(
    resourceType: string,
    resourceId: string,
    options?: { ontologyVersion?: string },
  ): Promise<Snapshot | null>;

  transaction(
    ops: OperationDescriptor[] | TxnEntries,
    options?: { ontologyVersion?: string; onETagConflict?: ConflictResolver; maxRetries?: number },
  ): Promise<TransactionResult>;

  /**
   * Register a per-resource-type conflict resolver. Per-call override
   * available via options.onETagConflict on transaction(). Framework default
   * is server-wins.
   */
  onETagConflict(
    resourceType: string,
    resolver: ConflictResolver,
    options?: {
      maxRetries?: number;        // default 5; on cap, reject with 'conflict-retries-exhausted'
      flashClass?: string | null; // default 'lumenize-conflict-revert'; null disables
      flashDuration?: number;     // default 1000 (ms)
    },
  ): void;
};
```

NebulaClient constructor gains:

- `ontologyVersion: string` — auto-attached to every operation
- `onShouldRefreshUI?: (info: { clientVersion: string; currentVersion: string; reason: 'ontology-stale' }) => void` — centralized hook for staleness signal

### `client.bindToState(state, options?)` — the integration entry point

```typescript
client.bindToState(state: StateManager, options?: {
  unsubscribeGraceMs?: number;  // default 2000
}): void
```

Responsibilities:

1. **Local writes → remote transactions.** `setState` middleware on `state` watches writes to `resources.{rt}.{rid}.*`. Reads cached `eTag` from `getState('{statePath}.meta.eTag')`, generates `newETag`, constructs op, calls `client.resources.transaction(...)`. User's `setState` is also the optimistic local write.
2. **Auto-subscribe via reference counting.** `Map<resourceKey, count>` keyed by `${rt}:${rid}`. Each new binding (initial walk + observer-detected additions) increments. 0→1 triggers `client.resources.subscribe(rt, rid)`. Count→0 schedules `unsubscribe` after `unsubscribeGraceMs`; new binding during grace cancels.
3. **Remote-pushes direction.** `handleResourceUpdate` writes through directly to `state.setState`; middleware does NOT intercept (would create a loop).
4. **Connection-state surfacing.** Subscribe to LumenizeClient's connection events; on each transition write to `lmz.connection.state` (string), `lmz.connection.connected` (boolean), and (on each `'connected'` transition) `lmz.connection.lastConnectedAt` (timestamp ms).

### `bindDom(root, state, options?)` — `@lumenize/ui` entry

```typescript
bindDom(root: Element, state: StateManager, options?: {
  handlers?: Record<string, Function>;  // x-on:event="handlerName" lookup table
  autoObserve?: boolean;                 // default true; false = one-shot initial scan
}): void
```

Directive set: `x-text`, `x-html`, `x-bind:attr`, `x-show`, `x-class:name`, `x-on:event`, `x-input`, `x-for`, `x-if`, `x-key`. Semantics in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — the doc is canonical. Implementation must match the doc's described behavior.

`<template>`-only host for `x-for` and `x-if`. Scoped path resolution inside `x-for` (see Decisions row).

Move-vs-removal: on `removedNodes`, schedule unregister via `queueMicrotask`; in microtask, check `el.isConnected`; skip if still connected.

### Types

```typescript
type ConflictResolver = (
  local: { value: unknown; eTag: string },
  server: Snapshot,
  context: {
    bindings: Map<string, HTMLElement[]>;  // path → DOM elements bound to that path
  },
) => ConflictResolution | Promise<ConflictResolution>;

type ConflictResolution =
  | { resolution: 'use-server' }
  | { resolution: 'use-this'; value: unknown }
  | { resolution: 'human-in-the-loop' };
```

## Implementation Phases

### Already shipped (from earlier auth work)

- Two-scope model (`authScope` / `activeScope`)
- Refresh path routing
- NebulaClientGateway active-scope verification
- Star Handler 1 / Handler 2 dispatch for `transaction()` and `read()`
- Server-side auth flows
- LumenizeClient base (auto-reconnect)
- `handleTransactionResult` / `handleReadResult` stubs in `nebula-client.ts` (replace stubs in 5.3.3)

### Phase 5.3.0 — Port `@lumenize/state` (prerequisite)

- [ ] New package `packages/state/` (MIT) — `@lumenize/state`
- [ ] Port `StateManager` (~310 LOC) — `getState`, `setState`, `subscribe`, `subscribeExact`, `track` + `deps`, `executeBatch`, middleware list, `#hasCircularUpdate`, `#notifySubscribers`, `#triggerPathSubscribers`
- [ ] Port top-level helpers (~30 LOC) — `isValidPath`, `getPathParts`, `deepEquals`
- [ ] Add `state.computed(targetPath, fn): () => void` — user-facing derived-state API. Uses `track()` internally; subscribes to collected deps; re-runs and re-tracks on dep change. Matches Vue/MobX naming. Returns dispose function.
- [ ] Replace `createLogger` calls with `@lumenize/debug`
- [ ] Normalize `_underscore` privates to `#hash` per CLAUDE.md, except where cross-class access requires public
- [ ] Tests in `packages/state/test/` covering `getState`/`setState`/`subscribe`/`executeBatch`/middleware/`computed`
- [ ] **Verification probe**: hierarchical-notify-with-deepEquals must fire descendant subscribers only when values actually differ — load-bearing for the directive ergonomic. Set parent path with one field changed; assert only that field's subscriber fires.

### Phase 5.3.1 — Star subscribe machinery

- [ ] `Subscribers` table created via `CREATE TABLE IF NOT EXISTS` in Star constructor
- [ ] `@mesh()` `subscribe` method with Handler 1 / Handler 2 pattern
- [ ] DAG read-permission check at subscribe time
- [ ] Initial snapshot delivered via `handleResourceUpdate` (same path as ongoing fanout)
- [ ] Subscriber row inserted on success; idempotent on re-subscribe with same `(clientId, resourceType, resourceId)`

### Phase 5.3.2 — Fanout on mutation

- [ ] `#onChanged` replaced with subscriber lookup + per-subscriber `lmz.call` to NEBULA_CLIENT_GATEWAY
- [ ] BroadcastChannel semantics: originator's `clientId` excluded
- [ ] Snapshot deletion pushes `null` to subscribers
- [ ] Fanout triggers are upsert and delete only — migration does NOT fan out (deploys + lazy ontology model + `onShouldRefreshUI` handle cross-version transitions)
- [ ] Branch-aware subscription routing: subscriptions are branch-local (each branch = independent Star instance per `tasks/nebula-branches.md`); verify the wiring doesn't assume single Star per `{u}.{g}.{s}`

### Phase 5.3.3 — NebulaClient handlers + `client.resources.*` API

- [ ] Replace `handleTransactionResult` / `handleReadResult` stubs (drop `handleReadResult` entirely — `read` is a method, not a handler)
- [ ] `handleResourceUpdate` writes through to bound StateManager — no internal value cache. `value` and `meta` at sibling paths.
- [ ] `handleTransactionResult` advances in-flight transaction queue; dispatches conflicts through registered resolver
- [ ] StateManager registered with NebulaClient at construction
- [ ] Local subscription registry (`Map<resourceKey, { statePath }>`)
- [ ] Constructor: `ontologyVersion: string` (auto-attached); `onShouldRefreshUI?` hook
- [ ] `client.resources.{subscribe, read, transaction, onETagConflict}` per Surface signatures
- [ ] Per-call override via `options.onETagConflict` on `transaction()`. Precedence: per-call > per-type > framework default (`'use-server'`)
- [ ] `ConflictResolution` discriminated union with recursive `'use-this'` (bounded by `maxRetries`, default 5, then `'conflict-retries-exhausted'`)
- [ ] Resolver receives `context.bindings: Map<path, HTMLElement[]>`
- [ ] Field-diff flash: compare resolved value to `local.value`, flash bound elements at diff paths with `flashClass` for `flashDuration` ms
- [ ] Bindings registry: extend `bindDom`'s path-subscriber map to track `HTMLElement` per subscriber (`Map<path, Set<HTMLElement>>`)
- [ ] Star mismatch path ([star.ts:203-206, 270-273](apps/nebula/src/star.ts:203)) returns structured `{ kind: 'ontology-stale', clientVersion, currentVersion }`
- [ ] NebulaClient inspects responses for staleness signal; dispatches to `onShouldRefreshUI`; settles originating Promise
- [ ] `client.resources.read(rt, rid)` returns Promise resolving with `Snapshot | null`; no state side-effect. Mesh-framework Promise correlation strategy (callId, hidden plumbing handler, or extending mesh return-value path) — resolve during implementation.
- [ ] `client.resources.transaction()` generates `newETag(s)`, queues if in-flight, 5–10 s timeout-and-reject

### Phase 5.3.4 — Auto-resubscribe on reconnect

- [ ] Hook LumenizeClient's connection-state transitions; identify event for "reconnect succeeded"
- [ ] Walk subscription registry on transition; re-call `Star.subscribe` for each
- [ ] In-flight transactions during disconnect — out of scope?

### Phase 5.3.5 — Subscriber cleanup on disconnect

- [ ] NebulaClientGateway hook: detect WebSocket close, notify Star to remove that `clientId`'s subscriber rows
- [ ] Confirm cleanup doesn't create thundering-herd during deploys

### Phase 5.3.6 — `client.bindToState(state)` integration + `@lumenize/ui` bindDom

#### bindToState (NebulaClient)

- [ ] `client.bindToState(state, options?)` registers `setState` middleware on `state` watching `resources.{rt}.{rid}.*`
- [ ] Optimistic-write flow: middleware reads `eTag` via `state.getState('{statePath}.meta.eTag')`, packages with fresh `newETag`, submits via `client.resources.transaction()`
- [ ] Auto-subscribe reference counting (`Map<resourceKey, count>`): 0→1 → `subscribe`; count→0 → schedule `unsubscribe` after `unsubscribeGraceMs` (default 2000); new binding during grace cancels
- [ ] Connection-state surfacing: subscribe to LumenizeClient connection events; write `lmz.connection.state` (string) and `lmz.connection.connected` (boolean) on every transition; write `lmz.connection.lastConnectedAt` (timestamp ms) on each `'connected'` transition
- [ ] Server returns `'permission-denied'` error path for write attempts the user isn't authorized for; NebulaClient rejects original Promise with `'permission-denied'` reason and rolls back optimistic state to last-confirmed (same handling as `'validation-failed'`)

#### bindDom + directives (`@lumenize/ui`)

- [ ] `bindDom(root, state, options?)` with `handlers` and `autoObserve` options
- [ ] Initial subtree walk: iterate `el.attributes`, register `x-*` bindings
- [ ] MutationObserver with `{ childList: true, subtree: true }` when `autoObserve !== false`
- [ ] On `addedNodes`: walk subtree, register bindings, increment refcount
- [ ] On `removedNodes`: schedule unregister via `queueMicrotask`; check `el.isConnected` in microtask (move handling); on true removal, walk subtree, unregister, decrement refcount
- [ ] Per-element binding tracking: `WeakMap<HTMLElement, BindingRecord[]>`
- [ ] Directive set: `x-text`, `x-html`, `x-bind:attr`, `x-show`, `x-class:name`, `x-on:event`, `x-input` per [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md)
- [ ] `x-for` parser: regex `/^(\w+)\s+in\s+(.+)$/`; `<template>`-only host; clone management by `x-key`
- [ ] `x-for` scoped path resolver: first segment === loopVar → scoped value; `$loopVar` segments → substitute; else normal path
- [ ] `x-for` reactivity: diff old vs new keys; preserve unchanged clones; MutationObserver handles binding registration/unregistration for added/removed clones
- [ ] `x-if` parser: `<template>`-only host; supports `!path` negation
- [ ] `x-if` lifecycle composition: mount/unmount via DOM insertion/removal; existing MutationObserver mechanism handles binding registration/unregistration
- [ ] Forbid `x-for` + `x-if` on same `<template>` (throw or warn loudly); nested templates supported
- [ ] Directive attributes are read once at binding time — no `attributes` observation
- [ ] `handlers` config: `x-on:event="handlerName"` looks up by string name

### Phase 5.3.7 — For-docs tests (one big `it`, narrative)

All dynamic-DOM probes use `vi.waitFor` (MutationObserver is async; grace periods need real time).

- [ ] Two clients subscribe to same resource; client A transactions; client B's bound StateManager path updates via `handleResourceUpdate`
- [ ] BroadcastChannel: client A doesn't receive own update via fanout; instead reflects authoritative value via `handleTransactionResult`'s success path
- [ ] `'use-server'` resolution: loser's resolver returns `{ resolution: 'use-server' }`; framework `setState`s server value; Promise rejects `'conflict-lost'`
- [ ] `'use-this'` resolution: loser returns `{ resolution: 'use-this', value }`; framework submits new transaction with `eTag = server.meta.eTag`. Verify recursion: second submission also conflicts → resolver fires again → eventually succeeds.
- [ ] `maxRetries` exhaustion: resolver always returns `'use-this'`, every submission conflicts; after default 5 attempts, original Promise rejects `'conflict-retries-exhausted'`
- [ ] `'human-in-the-loop'`: resolver returns the handoff; Promise rejects `'conflict-handoff'`; optimistic state stays painted (NOT overwritten); no new transaction; test then manually submits follow-up
- [ ] Per-call override: `transaction(ops, { onETagConflict: customResolver })` overrides per-type registered resolver for that call only
- [ ] Idempotency probe: drop a transaction response (test-only); client retries with same `newETag`; server returns idempotent success without duplicate
- [ ] `client.resources.read(rt, rid)` returns current snapshot without writing to bound state
- [ ] Staleness probe: client constructed with `'v1'`, server now `'v2'`; transaction → `onShouldRefreshUI` fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`
- [ ] Connection-state probe: trigger LumenizeClient connection events programmatically; assert `lmz.connection.state` / `lmz.connection.connected` / `lmz.connection.lastConnectedAt` paths update correctly on each transition
- [ ] Permission-denied probe: attempt a write the user isn't authorized for; original Promise rejects with `'permission-denied'`; optimistic state rolls back to last-confirmed
- [ ] Flash class: after `'use-server'` where local differed from server, framework adds `flashClass` to bound elements at diff fields; removed after `flashDuration` ms. Test both default class and custom; verify `flashClass: null` disables.
- [ ] Resolver bindings: `context.bindings` contains exactly elements bound to paths under conflicting resource
- [ ] Auto-subscribe probe: HTML with `x-text` binding to `resources.{rt}.{rid}.*` triggers `client.resources.subscribe` automatically
- [ ] Dynamic-DOM addition: append element with new `(rt, rid)`; observer triggers `subscribe`
- [ ] Dynamic-DOM removal + grace period: remove element; refcount → 0; `unsubscribe` does NOT fire immediately; after `unsubscribeGraceMs`, fires
- [ ] Grace-period cancel: remove + re-add within grace; pending `unsubscribe` is cancelled (never fires)
- [ ] Move (not removal): remove from one parent, append to another in same task; binding survives (no unregister)
- [ ] `autoObserve: false`: post-initial-walk DOM additions do NOT activate
- [ ] `x-for` inline-array iteration: N items render correctly; mutations (push/pop/reorder) update correctly with keys preserving clone identity
- [ ] `x-for` FK with `$loopVar`: auto-subscribe fires per ID; removal triggers grace-period unsubscribe
- [ ] `x-if` mount/unmount + `!path` negation: bindings register/unregister with the conditional content
- [ ] `x-for` + nested `x-if` (filtered iteration): clones mount/unmount independently
- [ ] `state.computed()` driving `x-if`: derivation re-runs on source change; `x-if` reacts
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant)
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during disconnect

## Out of scope (post-demo)

- **Multi-resource subscriptions** — `subscribe()` for a query result. Big design space; needs query language.
- **Large-fanout architecture** — tiered fanout through Worker armies for >64 subscribers per resource. See `tasks/nebula-scratchpad.md` § "Fanout Broadcast Tiering."
- **Per-mutation guards on fanout** — re-checking DAG permission per subscriber per push. Demo accepts subscribe-time-only check.
- **Subscription to specific subtrees vs full tree** — DAG-tree-level subscriptions (different from resource subscriptions).
- **NebulaClient polish**: discovery-first login (tests bypass with `?_test=true`), WebSocket keepalive + `setWebSocketAutoResponse`, proactive token refresh, scope-switching UX. All deferred per `tasks/archive/nebula-7-client.md`.

## Open Questions

1. **Subscriber cleanup on disconnect** — exact mechanism. Options: (a) Gateway hooks WS close → "drop subscribers for clientId" → Star; (b) periodic Star sweep based on last-heartbeat; (c) accept leak for demo. (a) is right but needs Gateway plumbing.
2. **Permission revocation mid-subscription** — if admin revokes read permission on a node while subscribed, existing subscribers still fanout. Acceptable for demo; DAG-mutation path needs to invalidate subscribers for production.
3. **`getEffectivePermission` per-subscriber on notification?** Probably no for demo; revisit for production.
4. **Subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy** — when Studio deploy changes guards/ontology, do existing subscribers get re-evaluated? Leans "all invalidated; clients re-subscribe" since deploy is already disruptive.
5. **Subscription identifier** — does `(clientId, resourceType, resourceId)` uniquely identify a subscription, or need generated `subId` for multi-tab same-client? `instanceName` of the Gateway should already disambiguate.
6. **Mesh-framework Promise correlation for `client.resources.read()`** — implementation detail. Options: (a) existing `callId` machinery, (b) hidden plumbing handler, (c) extend mesh return-value path. Resolve during 5.3.3.
7. **Query language** — for "give me all todos where status='open'" with result-set subscription. Deferred to own phase. Design space includes query shape, server-side execution model, result-set subscription semantics, pagination, cursor stability across schema migrations.

## Phase -1: Captured Ideas

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Triage outcomes: do-now / later-task-file / backlog / drop. Resolve everything here before archiving this file.

1. **Same-field conflict cascade during async resolver.** If a user has a modal open for `resources.todo.task-42.value.title` and keeps typing into that same title field while the modal is open, the additional typing enqueues new transactions with the pre-conflict `meta.eTag`. After the modal resolves and T1's submission lands, T2 fires with the now-stale eTag, conflicts against the server's new eTag, and the modal pops *again* with the latest server snapshot. Semantically correct (each conflict gets the user's choice); visually noisy ("why does this keep popping up?"). **Triage**: not solving for v1 — Studio-generated UIs rarely have a user typing into the field that's mid-conflict (the modal grabs focus). Possible v2 fixes: re-tag queued transactions with the latest server eTag at submission time, or batch typing into the same field while a modal is up (don't queue per-keystroke transactions).

2. **Re-conflict during human-in-the-loop batch resolution.** The doc's review-later example builds an atomic batched transaction from all pending conflicts. If any of the resources in that batch has churned again on the server (someone wrote between the original conflict and the user's review-later submission), the whole batch rolls back and the resolver fires again — for whichever resource(s) re-conflicted, plus presumably the same `'human-in-the-loop'` policy. The conflict stash gets re-populated; the user goes through review again. **Triage**: probably fine — the user's already in a "review and resolve" mindset, so a second review pass isn't jarring. But worth thinking about whether the framework should somehow signal "this is a re-resolution of a previously-handed-off conflict" so the UI can highlight it. Not blocking demo; revisit if real Studio markup exposes the friction.

3. **`@lumenize/router`** — URL ↔ state-path two-way sync, ~200 LOC. Studio-blocking for multi-view apps. **Triage**: defer until first Studio app needs routing. Single-page-with-conditional-views (`x-if` on `ui.activeView`) is enough for most demo apps. **Outcome destination**: own task file (`tasks/lumenize-router.md`) when work starts; or fold into `tasks/nebula-frontend.md` if it stays small.

4. **Client-side typia validator for instant form validation.** Server-side validation is already shipped (typia compiled per ontology version, runs on every transaction). For "instant" form-validation UX (red border on invalid input as the user types, before submit), we'd want the same validator running client-side.

   Notable simplification: the platform uses a single-origin URL structure (`https://lumenize.com/{universe}.{galaxy}.{star}/...` — universe/galaxy/star encoded in the first path segment, no per-tenant subdomain; canonical pinning in `tasks/nebula-branches.md`). Validator JS would serve from the same origin (likely a route like `/_lmz/validator/{universeGalaxy}/{version}/validator.js`), which eliminates CORS entirely. That removes a non-trivial chunk of the design space. Future custom-domain aliases (e.g., `https://apps.acme.com/acme.app-1.star-1/...`) preserve the property as long as the alias serves everything — app HTML, validator, API — from the same origin; no plans to allow stripping the universe segment from alias URLs (asymmetry would cost more than the redundancy).

   Remaining open questions:
   - **Delivery mechanism**: `eval` / `new Function(validatorString)` works but requires CSP `'unsafe-eval'` — bad for production-grade apps. `<script>` tag loading is CSP-friendly *if* the source URL is in the `script-src` allowlist. The validator is per-ontology-version and immutable per version, so cacheable / CDN-friendly.
   - **Where the validator JS is served from**: Galaxy stores the ontology + compiled validator already. A Worker route (Galaxy-fronted or a separate router Worker) serves the bytes. Immutable URL per version makes CDN caching trivial.
   - **Coupled to "where does Studio-generated UI code itself live"** — open per `tasks/nebula-studio.md` § "Studio UI hosting (open — needs spike)". Decisions there inform the validator-delivery design (likely the same Worker handles both, on the same origin).

   **Triage**: defer to its own design pass. Rejection-on-submit (`'validation-failed'`) covers the data-integrity case for demo; only the UX delight of "instant feedback while typing" is missing. **Outcome destination**: spike task file when post-demo, tied to the Studio-UI-hosting decision.

## Pre-port JurisJS inventory (archive reference)

> **⚠ Superseded by 2026-05-09 direction-pinning.** Inventory remains as historical reference. Port scope is now narrower: only `StateManager` + top-level helpers (~340 LOC) port to `@lumenize/state`. `DOMRenderer`, `ComponentManager`, the `Juris` orchestrator, async-prop machinery, and JurisJS router/url-state-sync are **not** being ported.

Source read: cloned `https://github.com/jurisjs/juris.git`. MIT-licensed. ~2,227 LOC in `src/juris.js`.

**Keeping** (in `@lumenize/state`):
- Top-level helpers — `isValidPath`, `getPathParts`, `deepEquals` (~30 LOC)
- `StateManager` (lines 138–445, ~310 LOC) — `getState`, `setState`, `subscribe`, `subscribeExact`, `track` + `deps`, `executeBatch`, middleware list, `#hasCircularUpdate`, `#notifySubscribers`, `#triggerPathSubscribers`

**Not porting** (replaced by `@lumenize/ui` from scratch or unneeded):
- `DOMRenderer` (~910 LOC)
- `ComponentManager` (~485 LOC)
- `Juris` orchestrator (~250 LOC)
- Async-prop / promise placeholder machinery (~250 LOC)
- `url-state-sync.js` / `juris-router.js` (~700 LOC each — write `@lumenize/router` from scratch instead)
- Template compiler (`juris-template.js`)
- Web Component factory (`juris-webcomponent.js`)
- DOM enhancer (`juris-enhance.js`)
- CSS extractor (`juris-cssextractor.js`)
- Headless add-ons (most of `headless/` and `src/headless/`)

## Notes

- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design."
- Fanout > 64 subscribers (large-fanout tiering) intentionally not designed here. Demo runs with a handful of subscribers max.
- This file consolidates and supersedes `tasks/archive/nebula-5.3-subscriptions.md`, `tasks/archive/lumenize-ui.md`, and `tasks/archive/nebula-7-client.md`.

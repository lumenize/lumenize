# Phase 5.3: Subscriptions & Fanout (single-resource, demo critical path)

**Status**: Active — demo critical path
**Depends on**: Phase 5.1 (Storage Engine — shipped), Phase 5.2 (Validation/Ontology — shipped)
**Companion**: `tasks/nebula-7-client.md` (the client-side handler surface this phase wires up), `tasks/lumenize-ui.md` (the UI integration target)

> **DRAFT** — first pass written 2026-05-06; tightened 2026-05-09 in a review pass that pinned namespace (`client.resources.*`), separated subscription pushes from transaction responses, dropped `handleReadResult`, and adopted client-generated eTag as the idempotency mechanism. Further refined 2026-05-10: lazy ontology-version model pulled forward from code, `onShouldRefreshUI` hook added, `meta` (not `__meta`), addressing conventions pinned, conflict resolver moved to per-type (`client.resources.onETagConflict`) with a `ConflictResolution` discriminated union, `client.bindToState()` added as the synced-state middleware entry point with auto-subscribe via DOM-crawl reference-counting. 2026-05-11: surfaced via doc-drafting in [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — flash-class behavior (`lumenize-conflict-revert`, configurable), `maxRetries` for `'use-this'` (default 5, `'conflict-exhausted'` rejection on cap), resolver third-arg `context.bindings: Map<path, HTMLElement[]>` for custom UX, `bindDom` handlers registry, dynamic-DOM lifecycle (MutationObserver, 2 s unsubscribe grace, microtask-deferred removal handling, read-once directive attrs), `x-for` and `x-if` directives (`<template>`-as-host, `$loopVar` path substitution, `x-key` for diffing, mount/unmount composes with MutationObserver lifecycle), `!path` negation in `x-if`, "Alpine-flavored with deliberate deviations" framing pinned in doc, and `state.computed(path, fn)` added to `@lumenize/state` port for derived-state materialization.

## Goal

Wire `client.resources.subscribe()` end-to-end so a connected NebulaClient can ask Star to keep it informed about changes to a specific resource, and so updates flow into `@lumenize/state`. **Single-resource subscriptions only** for the demo — multi-resource subscriptions and large-fanout architecture are post-demo concerns (see "Out of Scope" below).

The shape: `client.resources.subscribe('todo', 'task-42')` makes Star push `{ value, meta }` snapshots to that client whenever `task-42` is upserted or deleted. Pushes land in `handleResourceUpdate` on NebulaClient, which writes through to the bound StateManager path; the UI re-renders off the StateManager. Local writes (via `client.resources.transaction()`) update the same path optimistically; the server's authoritative response replaces the optimistic value once it arrives — through `handleTransactionResult`, which is a separate handler with separate control flow (see "Three handlers, three control flows" below).

(Migration is *not* a fanout trigger. Cross-version transitions are handled by the lazy ontology-version model — see "Background: lazy ontology-version model" below — which surfaces a staleness signal on the next operation an old-version client makes. The client dispatches that signal to a registered `onShouldRefreshUI` hook. Pushing migrated snapshots to old-version subscribers would feed new-shape data to old-shape rendering code; the lazy/pull model avoids this entirely.)

## Background: lazy ontology-version model

Already implemented in `apps/nebula/src/star.ts` (canonical) and referenced in `tasks/archive/nebula-5.2.4.2-validator-galaxy-integration.md` (historical). Pulled forward here because it's load-bearing for every resource operation in this phase.

- **Studio deploys do NOT push refresh signals.** No proactive notification of any kind. Detection is lazy, triggered by client operations.
- **Star caches exactly one ontology row per Star instance** — the latest version it has installed. `_index` (in KV) stores the full ordered version history (oldest → newest) for migration chains, but only the latest version has a cached `OntologyVersionRow`. See [star.ts:71](apps/nebula/src/star.ts:71) `#isCachedVersion` — returns true *only* if the version equals `_index[_index.length - 1]`.
- **Cache hit path** ([star.ts:167](apps/nebula/src/star.ts:167)): client's `ontologyVersion` matches the cached latest → execute directly, skip Galaxy. This is the warm path for the steady state (everyone on the same version).
- **Cache miss path** ([star.ts:170-178](apps/nebula/src/star.ts:170)): client's `ontologyVersion` is *not* the latest cached. Star calls `Galaxy.getLatestOntologyVersion()` and the response carries `{ row: latest, history: [...] }`. Two outcomes:
  - Galaxy's latest matches client's version → `#installState` updates Star's cache; execute. (This is how Star *learns* about a newer version — when the first client running the new bundle shows up.)
  - Galaxy's latest does *not* match client's version → mismatch error returned to the caller. **This is the staleness signal.** Today it's a plain `Error('Ontology version mismatch...')`; Phase 5.3.3 converts it into a structured signal that NebulaClient dispatches to the `onShouldRefreshUI` hook (see Decisions table).
- **First-vN+1 client unblocks all later vN clients.** A fresh page load gets the new bundle (Studio replaced the static asset on deploy) → the new client's first op hits Star with vN+1 → cache miss → Galaxy fetched → Star now caches vN+1. From then on, vN clients show up → cache miss (their version isn't latest) → Galaxy fetched again → mismatch detected → staleness signal returned.
- **Older versions in `_index` are for migration chains, not direct execution.** Phase 5.5 uses `_index` order to chain migrations; the running ontology is always the cached latest.

## Decisions pinned

| Decision | Choice | Rationale |
| --- | --- | --- |
| **UI integration boundary** | `@lumenize/state` `getState`/`setState`, NOT a generic event emitter on NebulaClient. `@lumenize/ui` sits on top of `@lumenize/state`. The Nebula-specific glue (auto-subscribe, conflict-resolver pipeline, flash class, refcount-with-grace, `resources.*` prefix interpretation) lives in NebulaClient's `bindToState` method, NOT in either generic package. See `tasks/lumenize-ui.md` § "Three layers, clean boundaries" for the layer-boundary table. | Keeps NebulaClient's transport/auth concerns from leaking into UI adapters; one reactivity model. Packages stay generic and MIT-reusable; integration is the third layer where Nebula-specific knowledge lives. Reversal question raised 2026-05-11 and declined — the lines are clean even though most design discussion happens at the integration layer. |
| **Local value store** | `@lumenize/state`'s StateManager is THE store (separate package — see `tasks/lumenize-ui.md` § Package split). NebulaClient holds NO shadow cache. eTag and value live at sibling paths (e.g., `resources.todo.task-42.value` and `resources.todo.task-42.meta`). | One source of truth, reactivity for free, no sync-two-stores hazard. The middleware reads cached eTag via `getState` when constructing optimistic transactions. `@lumenize/state` ports first (risk-free) ahead of any renderer decision. |
| **Headless mode (Node tests, scripts)** | NebulaClient depends on `@lumenize/state` directly — no renderer needed. | NebulaClient's interface dependency is on StateManager-shape (`getState`/`setState`/`subscribe`/`executeBatch`), provided by `@lumenize/state` regardless of whether `@lumenize/ui` ever ports. |
| **API namespace** | All resource-related methods live under `client.resources.*` (`subscribe`, `read`, `transaction`) | `subscribe` and `read` collide with too many other JS APIs (RxJS, Svelte stores, EventEmitter, streams); namespace disambiguates and leaves room for future additions (`history`, `list`, etc.) without per-method bikeshedding |
| **Subscribe scope** | Single resource (`resourceType`, `resourceId`) | Multi-resource subscriptions deferred until post-demo |
| **Fan-out path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)` | Same Handler 1 / Handler 2 plumbing already used by `transaction()` and `read()` |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required — throw if missing); `bindingName` + `instanceName` from `callContext.callChain.at(-1)` (the immediate Gateway caller) | Subscriptions are user-initiated, not mesh-to-mesh |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber | Prevents double-render when the originator already updated optimistically |
| **Guard placement** | Run guards once at subscribe time (DAG read permission); not on each fanout | Resource-level access doesn't change mid-subscription except via DAG mutation; that's a separate concern (see "Open Questions") |
| **Auto-resubscribe on reconnect** | Client maintains a local subscription registry; on LumenizeClient `connected` event, re-subscribe each entry | LumenizeClient already auto-reconnects; we just need to re-register |
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. Enforced at resource-creation time (transaction op validation) and at subscribe/read time as defense-in-depth. Default `statePath` is `resources.{resourceType}.{resourceId}`. | Period-delimited state paths and slash-delimited URL paths must be unambiguously interconvertible. Forbidding `.` and `/` in IDs makes the mapping mechanical. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings (`x-text="resources.todo.task-42.value.title"`) reactive to bulk-snapshot pushes without spurious re-renders. See `tasks/lumenize-ui.md` § "Path conventions & resource addressing" for the full picture. |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success | Cleaner than separate `txnId` field — no server-side dedupe table, no expiry window, idempotency is implicit in the eTag itself. Makes auto-retry safe across network drops without double-apply. Also resolves the create-after-lost-response case naturally. |
| **Transaction queue** | Serial — at most one transaction in flight per client; subsequent calls queue. 5–10 s timeout on the in-flight transaction, then reject (queue unblocks). Caller decides whether to retry on reject; retry is safe by default thanks to client-generated `newETag`. | Matches human editing speeds; avoids reasoning about partial-application across overlapping transactions; queue stalls on hang and is observable to the caller. |
| **Conflict resolver (per resource type)** | Registered via `client.resources.onETagConflict(resourceType, resolver, options?)` at app boot. Per-call override available as `options.onETagConflict` on `client.resources.transaction(ops, options)`. Framework default = server-wins. The resolver returns a `ConflictResolution` discriminated union: `{ resolution: 'use-server' }`, `{ resolution: 'use-this', value }`, or `{ resolution: 'human-in-the-loop' }`. Async OK; the transaction queue stays parked until the resolver settles. Resolver receives a third `context` argument with `bindings: Map<path, HTMLElement[]>` for custom UX. | Conflict strategy is resource-shape-specific; per-type registration is the right grain. Discriminated union with explicit `resolution` field makes intent unambiguous and supports recursive conflicts: `'use-this'` triggers a new transaction which can itself conflict and re-invoke the resolver (bounded by `maxRetries`, default 5, then rejects with `'conflict-exhausted'`). `'human-in-the-loop'` says "automated flow stops here; the app handles state and re-submission" — original Promise rejects with `'conflict-handoff'`; optimistic local state stays painted. The `context.bindings` map exposes DOM elements bound to the conflicting resource's paths so resolver can apply CSS to parents, fire custom animations, etc. |
| **Conflict flash class** | After any resolution, the framework compares the resolved value to `local.value` field-by-field; for each path where they differ, adds a CSS class to all bound DOM elements for `flashDuration` ms, then removes it. Default class: `lumenize-conflict-revert`. Default duration: 1000 ms. Configurable per type via `onETagConflict('todo', resolver, { flashClass: 'my-class', flashDuration: 1500 })`. Set `flashClass: null` to disable framework flash entirely (typically when resolver does its own DOM work via `context.bindings`). | Gives a default visual signal that user input was changed by a conflict, without any explicit UX code from the vibe coder. Field-diff inference means only the actually-affected fields flash — no spurious flashing of values the user didn't type. Three-tier configurability (default → per-type class override → null to disable) matches the pattern used for resolver registration. |
| **Dynamic-DOM lifecycle (MutationObserver + refcounted subscribe)** | One `MutationObserver` per `bindDom(root, state, options?)` call rooted at `root` with `{ childList: true, subtree: true }`. On `addedNodes`: walk the added subtree, register `x-*` bindings, increment per-`(rt, rid)` reference count; if a new pair, call `client.resources.subscribe(rt, rid)`. On `removedNodes`: schedule unregistration to a microtask (so element moves are handled correctly — re-attachment during the same task cancels the unregister), then walk the removed subtree, unregister bindings, decrement refcounts. When a `(rt, rid)` refcount reaches zero, schedule `client.resources.unsubscribe(rt, rid)` after a 2 s grace period; new binding within the grace window cancels the pending unsubscribe. Per-element binding tracking via `WeakMap<HTMLElement, BindingRecord[]>`. Directive attributes (`x-text`, `x-input`, etc.) are read once at binding time — mutating them after mount does not rebind. Configurable via `bindDom(root, state, { autoObserve: false })` to disable the observer, and `client.bindToState(state, { unsubscribeGraceMs: 2000 })` to tune the grace period. | JurisJS inventory already calls out MutationObserver-based auto-cleanup as load-bearing — we extend the same mechanism for additions. Microtask-deferred removal handles "moved" elements (removed from old parent, added to new parent in same task) without losing reactivity. Refcount-with-grace covers tab-switch / modal-reopen / quick-rerender churn cheaply. Read-once directive attrs avoid the surface-area cost of attribute-mutation re-binding, which Studio-generated templates don't need. |
| **`x-for` (list iteration)** | Host element: `<template>` only (clones go to template's parent; template doesn't render). Syntax: `<template x-for="loopVar in path" x-key="...">`. Inside the template, `loopVar` is a scoped value; path resolution rules (in order): (1) first segment === `loopVar` → scoped value navigation (`assignee.name`); (2) path contains `$loopVar` segment → substitute the value as a string (`resources.todo.$subtaskId.value.title`); (3) otherwise → normal state path. `x-key` is required (default by-index if omitted, but reorder causes churn); key value can be a field of `loopVar` (`assignee.id`), the loop variable itself for primitive arrays (`$subtaskId`), or any path. Reactivity: array change → diff old vs new keys → unchanged clones stay, new keys produce new clones (MutationObserver registers bindings), removed keys produce removed clones (MutationObserver unregisters). Nested `x-for`s introduce nested scopes; inner shadow outer on name collision. | Iteration is the one operation that genuinely can't be expressed in path-only syntax. Alpine/Vue/Svelte all carve out a directive for this; we follow. `<template>` host matches Alpine's convention and makes "this is a definition, not real DOM" unambiguous. `$loopVar` substitution enables declarative FK-list rendering without a JS map, which is essential for the "no JS for the common case" guarantee. Composition with the existing MutationObserver lifecycle means `x-for` is mostly a parsing-and-cloning layer; the reactive subscriptions ride for free on the path-level mechanism we already have. |
| **`x-if` (conditional mount/unmount)** | Host element: `<template>` only. Syntax: `<template x-if="path">` or `<template x-if="!path">`. JS standard truthiness applies. Negation: `!path` prefix (matches Alpine where LLMs reflexively write it). No inline comparisons or operators — use `state.computed()` to materialize derived booleans, then bind `x-if` to the derived path. Don't combine `x-for` and `x-if` on the same `<template>` — nest them instead. Mount fires MutationObserver `addedNodes` (bindings register, refcounts increment); unmount fires `removedNodes` (bindings unregister, refcounts decrement, grace-period unsubscribe applies). No `x-else` / `x-else-if` for v1; use `x-if` + `x-if="!..."` for mutually-exclusive states or `state.computed()` for multi-way conditions. | Mount/unmount semantics (vs `x-show`'s display-toggle) free up bindings when the subtree is invisible — meaningful when the conditional content is heavy. `!path` matches Alpine's `x-if="!visible"` muscle memory; alternative (`x-unless`) would create LLM friction every time. Skipping `x-else` keeps the directive grammar minimal; derived-state computation via `state.computed()` is the principled path for complex conditions. |
| **`ontologyVersion` on every operation** | NebulaClient takes `ontologyVersion` as a constructor argument (Studio's generated bootstrap fills it in at build time, lock-step with the UI bundle). It's auto-attached to every `client.resources.{subscribe, read, transaction}` call. `options.ontologyVersion` is allowed as a per-op override for admin scripts that legitimately span versions; default = constructor value. | Lock-step UI/ontology means the version is a build-time constant the vibe coder never sees. Star already takes `ontologyVersion` for its Handler 1 / Handler 2 dispatch; the wire was missing the field on the client side, not by design. |
| **Staleness signal + `onShouldRefreshUI` hook** | When Star's cache-miss path detects an ontology-version mismatch (see Background section), the response carries a structured staleness signal — `{ kind: 'ontology-stale', clientVersion, currentVersion }` rather than the current generic `Error`. NebulaClient dispatches this signal to a registered `onShouldRefreshUI` hook (constructor argument; no default — undefined means opted-out). The originating operation's Promise also rejects (or completes — TBD per operation type), but the centralized hook is the primary recovery path. Hook receives `{ clientVersion, currentVersion, reason: 'ontology-stale' }`; debouncing across multiple in-flight ops is the caller's responsibility. | The lazy model surfaces staleness through operation responses, not ambient signals. Multiple call sites would otherwise each have to inspect responses and react — a single hook centralizes the logic. Distinct from the earlier-rejected `onStaleVersion` callback (which was tied to a specific error path on a specific operation): `onShouldRefreshUI` is a framework-to-surrounding-code signal that's orthogonal to any specific op. CF DO code-deploy flush behavior + our 5–10 s transaction-queue timeout collapse all "I don't know what happened to this call" cases (network drop, Star eviction, deploy mid-call) to one caller-visible signal — the staleness path is *additive*, not redundant. |

## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate them.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` | success: yes; `'use-server'` resolution: rejects (`'conflict-lost'`); `'use-this'` resolution: stays pending across recursive resolver chain until terminal; `'human-in-the-loop'` resolution: rejects (`'conflict-handoff'`); validation: rejects | success: yes (write authoritative `value` and new `eTag` to bound state); `'use-server'`: yes (write `server.value`); `'use-this'`: yes (optimistically write `value`, then submit new transaction); `'human-in-the-loop'`: no (optimistic stays painted); validation: rollback to last-confirmed |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves the initial-snapshot Promise from `client.resources.subscribe()`; thereafter, fire-and-forget pushes | only the first call (initial snapshot) settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `{statePath}` and `meta` to `{statePath}.meta` |
| `client.resources.read(rt, rid)` | returns `Promise<Snapshot \| null>` | yes — caller `await`s the Snapshot | **none** — caller decides what to do with the value (setState, peek-and-discard, log, conditional logic) |

The first two are necessarily `@mesh` handlers because Star calls them. The third is a method; how its Promise gets resolved (callId correlation, hidden plumbing handler, or extending the mesh return-value path) is a mesh-framework implementation detail to resolve during 5.3.3.

UI flow uses `subscribe` for reactive reads (initial snapshot + ongoing pushes through one mechanism). `read` is the explicit-intent escape hatch for ad-hoc / scripting — Svelte shipped without `get` for years; the reactive path is sufficient for the common case.

## Two `subscribe`s — different things

The word "subscribe" appears at two layers, doing two different jobs. Don't conflate them.

| Call | Layer | Network? | Purpose |
| --- | --- | --- | --- |
| `client.resources.subscribe(rt, rid, statePath?)` | NebulaClient | yes — WS round-trip to Star | Tells Star to push snapshots on every change to this resource. Inserts a row in Star's `Subscribers` table. |
| `state.subscribe(path, cb)` | `@lumenize/state` StateManager | no — purely in-memory | Registers a callback that fires whenever `setState` writes to this path *in this browser tab*. |

They chain together. Full sequence on a single update originating elsewhere:

```
1. Some other client commits a transaction modifying task-42
2. Star processes the transaction
3. Star fanout: lmz.call → NebulaClient.handleResourceUpdate('todo', 'task-42', snapshot)
   ─── now we're back on the local client ───
4. handleResourceUpdate writes:
     state.setState('task.value', snapshot.value)
     state.setState('task.meta', snapshot.meta)
5. state.setState walks its subscribers Map, finds everyone subscribed to
   'task.value' or descendants like 'task.value.title'
6. Each subscriber callback fires, performing its DOM update (or anything else)
```

`client.resources.subscribe` is what gets data flowing *into* the local store from the server. `state.subscribe` is what binds DOM elements (or anything else) *to* that store. The two are independent calls because they're independent concerns:

- `state.subscribe(...)` works fine on a state tree that's never synced to a server (purely local UI state).
- `client.resources.subscribe(...)` works fine without any DOM at all (a Node script subscribing to changes for, say, an alerting daemon).

The DOM-binding crawler in `@lumenize/ui` (see `tasks/lumenize-ui.md`) only ever uses `state.subscribe` — it has no idea NebulaClient or Star exist. That decoupling is by design: the binding layer is transport-agnostic, and the transport layer is rendering-agnostic.

## Surface

### Star side (`apps/nebula/src/star.ts`)

Add a `@mesh()` `subscribe` method that mirrors the Handler 1 / Handler 2 pattern from `transaction()` and `read()`:

```typescript
@mesh()
subscribe(ontologyVersion: string, resourceType: string, resourceId: string) {
  // Handler 1: validate ontology version, dispatch to Handler 2 with cache-or-fetch
  // ...same cache-check-then-call-Galaxy pattern as transaction/read
}

doSubscribe(
  fetchedState: OntologyState | null | Error,
  ontologyVersion: string,
  resourceType: string,
  resourceId: string,
  clientId: string,
) {
  // 1. ontology version check (same as transaction/read)
  // 2. DAG read-permission check on the resource's nodeId
  // 3. Register subscriber: { sub, clientId, resourceType, resourceId }
  // 4. Read current snapshot
  // 5. Push initial value to client via handleResourceUpdate
}
```

`#onChanged` (currently a Phase 3.1 placeholder) is replaced with subscriber-driven fanout: on every resource mutation in `transaction()`, look up subscribers for the affected `resourceType` + `resourceId`, exclude the originator (BroadcastChannel semantics), call each subscriber's Gateway with the new snapshot.

### Subscriber storage

Storage is on Star in SQL (subscribers don't need to survive eviction restart for the demo; we'll re-subscribe on reconnect anyway, but storing them avoids a thundering-herd problem when many clients reconnect simultaneously after a Star wake-up).

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

(Per CLAUDE.md SQL conventions: PascalCase table, camelCase columns, `WITHOUT ROWID` for compound PK, index on the fanout-lookup column.)

**Open question:** Subscriber cleanup. When a client disconnects, the Gateway should notify Star to remove that `clientId`'s subscribers. Otherwise rows accumulate. See "Open Questions" below.

### NebulaClient side (`apps/nebula/src/nebula-client.ts`)

Replace the existing `handleTransactionResult` / `handleReadResult` stubs. The public API moves under a `client.resources` namespace; the `@mesh` handlers stay at the top-level NebulaClient class because that's where the mesh framework dispatches.

```typescript
// Mesh handlers — Star calls back through these
@mesh()
handleTransactionResult(result: TransactionResult | Error): void {
  // Settle the in-flight transaction Promise (success / conflict / validation)
  // On success: write authoritative value + new eTag to bound state; advance queue
  // On conflict: invoke registered resolver; resolver decides whether to setState
  // On validation/error: rollback optimistic to last-confirmed; advance queue
}

@mesh()
handleResourceUpdate(resourceType: string, resourceId: string, snapshot: Snapshot | null): void {
  // Unconditional state write-through:
  //   {statePath}.value      ← snapshot.value  (or undefined if snapshot is null)
  //   {statePath}.meta     ← snapshot.meta
  // If a subscribe() Promise is pending for this (rt, rid), resolve it with snapshot.
  // Otherwise pure side-effect (ongoing fanout push).
  // snapshot === null means resource deleted — UI sees value go undefined.
}
```

Add the public namespace. **`ontologyVersion` is auto-attached** to every method below from the constructor argument; not part of the visible signatures except via `options.ontologyVersion` for per-op override (admin scripts):

```typescript
client.resources = {
  subscribe(
    resourceType: string,
    resourceId: string,
    statePath?: string,
    options?: { ontologyVersion?: string },
  ): Promise<Snapshot | null> {
    // 1. Add to local subscription registry { resourceType, resourceId, statePath }
    // 2. Call Star.subscribe via lmz.call, attaching ontologyVersion
    //    (options.ontologyVersion ?? this.#ontologyVersion)
    // 3. Return the initial snapshot (resolves when handleResourceUpdate fires for this pair)
  },

  read(
    resourceType: string,
    resourceId: string,
    options?: { ontologyVersion?: string },
  ): Promise<Snapshot | null> {
    // Ad-hoc read; resolves with the snapshot, no state write-through.
    // Caller decides what to do with the value.
  },

  transaction(
    ops: OperationDescriptor[] | TxnEntries,
    options?: { ontologyVersion?: string; onETagConflict?: ConflictResolver },
  ): Promise<TransactionResult> {
    // 1. Generate a newETag (or one per op) — used for idempotency
    // 2. If queue is empty: send via lmz.call('STAR', ..., star.transaction(...))
    //    attaching ontologyVersion
    //    Else: enqueue
    // 3. Return Promise that handleTransactionResult will settle
    // 4. Start 5-10s timeout; on fire, reject the Promise and unblock the queue
    // 5. Optimistic write to bound state happens here (caller may or may not have
    //    already set state via the synced-state middleware path)
    // Resolver precedence on conflict: options.onETagConflict ?? per-type-registered ?? framework default
  },

  /**
   * Register a per-resource-type conflict resolver. Called at app boot for
   * each type that needs custom merge/policy behavior. Per-call override is
   * available via options.onETagConflict on transaction(). Framework default
   * is server-wins (`{ resolution: 'use-server' }`).
   *
   * Options:
   *   - maxRetries: max recursive 'use-this' attempts before rejecting with
   *     'conflict-exhausted' (default 5)
   *   - flashClass: CSS class added to bound DOM elements whose value changed
   *     during conflict resolution (default 'lumenize-conflict-revert'; null disables)
   *   - flashDuration: how long the flash class stays applied, ms (default 1000)
   */
  onETagConflict(
    resourceType: string,
    resolver: ConflictResolver,
    options?: {
      maxRetries?: number;
      flashClass?: string | null;
      flashDuration?: number;
    },
  ): void { ... },
};
```

`client.bindToState(state, options?)` — entry point for the synced-state middleware. Called once at bootstrap:

```typescript
client.bindToState(state: StateManager, options?: {
  unsubscribeGraceMs?: number;  // default 2000; time to wait before unsubscribing on refcount=0
}): void
```

This is what turns NebulaClient + `@lumenize/state` + `@lumenize/ui`'s `bindDom` into an integrated app framework. It:

1. Registers a `setState` middleware on `state` that watches writes to paths matching `resources.{rt}.{rid}.*` and constructs transactions automatically. The optimistic write IS the user's `setState`; the middleware emits the transaction in parallel.
2. Maintains a `Map<resourceKey, count>` (keyed by `${rt}:${rid}`) tracking how many bindings reference each resource. Each new binding (via `bindDom`'s initial walk or MutationObserver `addedNodes`) increments. Each removed binding decrements. New pair (0 → 1) triggers `client.resources.subscribe(rt, rid)`. Refcount hits zero → schedule `client.resources.unsubscribe(rt, rid)` after `unsubscribeGraceMs`; cancel if a new binding arrives during the grace window.
3. Routes `handleResourceUpdate` pushes through `state.setState` (this is the remote→local direction; doesn't go through the middleware's local→remote interception).

`bindDom(root, state, options?)` — the UI-side companion. Options:

```typescript
bindDom(root: Element, state: StateManager, options?: {
  handlers?: Record<string, Function>;  // x-on:event="handlerName" lookup table
  autoObserve?: boolean;                 // default true; false = one-shot initial scan only
}): void
```

When `autoObserve: true` (default), `bindDom` sets up a `MutationObserver` on `root` with `{ childList: true, subtree: true }` and processes additions/removals automatically. When `false`, only the initial subtree is scanned; the caller is responsible for rebinding after DOM changes (rare; mostly for tests or specialized environments).

Per-element binding tracking: `WeakMap<HTMLElement, BindingRecord[]>`. Each record holds the `state.subscribe` unsubscribe function plus (for two-way `x-input` bindings) the input event listener for cleanup.

**Move handling**: on `removedNodes`, schedule unregistration to a microtask via `queueMicrotask` (or `Promise.resolve().then(...)`). In the microtask, check `el.isConnected`; if still connected (was a move, not a removal), do nothing.

Without `bindToState`, NebulaClient is usable but the caller has to call `client.resources.subscribe` and `client.resources.transaction` manually for every resource. `bindToState` + `bindDom` together enable the "vibe coder writes HTML, no JS subscribes/transactions" flow.

NebulaClient constructor gains:

- `ontologyVersion: string` — auto-attached to every operation (Studio's generated bootstrap fills it in at build time)
- `onShouldRefreshUI?: (info: { clientVersion: string; currentVersion: string; reason: 'ontology-stale' }) => void` — centralized hook for the staleness signal. No default; undefined means opted-out. Studio's bootstrap typically registers `(info) => window.location.reload()`, but custom impls can debounce, save form state, show a toast first, etc. Debouncing across multiple in-flight operations returning the signal is the caller's responsibility (the default `window.location.reload()` is idempotent so it doesn't matter; bespoke impls guard with their own one-shot flag).

The structured staleness signal rides on the operation response — Star's cache-miss path (see Background) returns `{ kind: 'ontology-stale', clientVersion, currentVersion }` instead of today's generic `Error`. NebulaClient inspects responses, dispatches to `onShouldRefreshUI` when present, and continues to settle the originating Promise (rejection on transaction; resolution-with-null or rejection on read/subscribe — TBD during 5.3.3). The hook fires *only* when this signal is in the response — never ambient, no background polling.

The transaction queue's 5–10 s timeout-and-reject covers all *other* "I don't know what happened to this call" cases (deploy mid-call, network drop, Star eviction). The staleness path is additive, not a replacement.

The `statePath` argument is the StateManager path the client should write into. Optional — if omitted, defaults to a convention like `resources.{resourceType}.{resourceId}`.

`ConflictResolver` shape:

```typescript
type ConflictResolver = (
  local: { value: unknown; eTag: string },
  server: Snapshot,
  context: {
    bindings: Map<string, HTMLElement[]>;  // path → DOM elements bound to that path
  },
) =>
  | ConflictResolution
  | Promise<ConflictResolution>;

type ConflictResolution =
  | { resolution: 'use-server' }                  // accept server's value as-is
  | { resolution: 'use-this'; value: unknown }    // submit this value as a new transaction at server's current eTag
  | { resolution: 'human-in-the-loop' };          // stop processing; app handles state and timing
```

Framework behavior per resolution:

- `'use-server'`: `state.setState(statePath, server.value)`, no round-trip (server already has it). Framework adds the flash class to bound DOM elements where the resolved field differs from `local.value`. Original transaction Promise rejects with `'conflict-lost'`.
- `'use-this'`: `state.setState(statePath, value)` (optimistic again), then submit a new transaction with `{ eTag: server.meta.eTag, newETag: <fresh>, value }`. **The original transaction's Promise stays pending across the entire resolver chain** until something terminal happens — the new transaction may itself conflict, in which case the resolver fires again with `(local: { value, eTag: server.meta.eTag }, server: { newer eTag })`. Bounded by `maxRetries` (default 5); on exhaustion, original Promise rejects with `'conflict-exhausted'`. Flash applied to fields where resolved value differs from `local.value`. One logical "save this todo" from the caller's view = one Promise across however many round trips the negotiation takes.
- `'human-in-the-loop'`: no state side-effect; no new transaction. The optimistic local state stays painted. Original Promise rejects with `'conflict-handoff'`. No flash (the user's optimistic input is still on screen; nothing to flash). Surrounding application code is responsible for the eventual reconciliation (typically: stash the conflict in some part of state, surface UI for the user to resolve, call `client.resources.transaction()` again with the resolved value when ready).

`context.bindings` is the resolver's escape hatch for custom UX: the resolver can read the map of bound DOM elements and apply CSS to parents, fire animations, append alert nodes, etc. The default flash still happens unless `flashClass: null` was set at registration. `bindings` keys are full state paths like `resources.todo.task-42.value.title`; values are arrays because the same path can be bound by multiple elements (list view + detail pane).

On recursive `'use-this'`: the resolver's `local` argument carries the *most recently submitted* value, not the original — by round N, the resolver-author (or human) has chosen what to push; if it conflicts again, the resolver decides what to do from there.

Default resolver: `() => ({ resolution: 'use-server' })`.

**Bindings registry implementation note**: `bindDom` already builds a path→subscriber map (one `state.subscribe` per binding); `bindToState` extends this to track the actual `HTMLElement` per subscriber. Small additional runtime cost (`Map<path, Set<HTMLElement>>`); enables both the framework's default flash and the resolver's `context.bindings` escape hatch.

### Synced-state middleware (implemented by `client.bindToState(state)`)

The middleware is what makes the vibe-coder flow possible — no explicit `subscribe` or `transaction` calls in user code. Implemented by `client.bindToState(state)` (see the namespace block above). Three responsibilities:

1. **Local writes → remote transactions.** `state` middleware on `setState` watches writes to `resources.{rt}.{rid}.*` paths. On match: read cached `eTag` from `getState('{statePath}.meta.eTag')`, generate `newETag`, construct an op `{ op: 'put', eTag, newETag, value }`, call `client.resources.transaction(...)`. The user's `setState` is also the optimistic local write — middleware emits the transaction in parallel.
2. **Auto-subscribe via reference counting.** Either via state-subscriber-registration hook (preferred) or by scanning `bindDom` results: for each unique `(rt, rid)` discovered in active bindings, call `client.resources.subscribe(rt, rid)`. Reference-count subscribers; unsubscribe when count reaches zero (typically: DOM element removed, MutationObserver in `bindDom` reports cleanup).
3. **Remote pushes → local state.** Handled separately by `handleResourceUpdate`, which writes through directly. The middleware doesn't intercept this direction.

The "declare a piece of state as synced" question collapses with this design: the path's prefix (`resources.{rt}.{rid}.*`) is the declaration. No `newState(key, initial, { sync: ... })` opt-in needed — bindings to synced paths are declarative in HTML.

### Auto-resubscribe on reconnect

LumenizeClient fires a `connected` event after auto-reconnect (need to verify the exact hook name in the existing client — the inventory notes 'connecting' / 'connected' / 'reconnecting' / 'disconnected' as ConnectionState values). On the first `connected` after `reconnecting`, walk the local subscription registry and re-call `Star.subscribe` for each entry. The server returns the current snapshot, which `handleResourceUpdate` writes back into the bound state path — papers over any updates missed during the disconnect.

## Worked examples

Four cases showing how the surface composes. Each shows the full app-author-visible code; nothing else is needed.

### Example 1 — two-way binding, default server-wins

```html
<!-- todo-card.html -->
<input class="input input-bordered" x-input="resources.todo.task-42.value.title" />
<p x-text="resources.todo.task-42.value.description"></p>
```

```js
// bootstrap.js
import { state, bindDom } from '@lumenize/ui';
import { NebulaClient } from './nebula-client.js';

const client = new NebulaClient({
  authScope: 'acme.app.tenant-a',
  activeScope: 'acme.app.tenant-a',
  ontologyVersion: 'v42',  // baked by Studio at build time
  onShouldRefreshUI: () => window.location.reload(),
});
client.bindToState(state);
bindDom(document.body, state);
```

That's the whole user-facing program. The `bindDom` crawl discovers `resources.todo.task-42.*` paths; `bindToState`'s reference-counting fires `client.resources.subscribe('todo', 'task-42')` once for that pair. User types; middleware emits transaction; conflict (if any) uses default `'use-server'` resolution. No explicit `subscribe`, `transaction`, or resolver code.

### Example 2 — two-way binding, custom per-type resolver

Same HTML. Bootstrap adds one block:

```js
client.resources.onETagConflict('todo', (local, server) => ({
  resolution: 'use-this',
  value: {
    title: local.value.title,                                                      // mine wins (short string)
    status: server.value.status,                                                   // theirs wins (enum)
    description: textMerge(local.value.description, server.value.description),     // CRDT-style merge
    assignees: setUnion(local.value.assignees, server.value.assignees),            // union of arrays
  },
}));
```

Per-type registration. The resolver dispatches per-field (framework doesn't know about fields). On conflict for a `todo`, the resolver fires; the framework `setState`s the merged value optimistically and submits a new transaction with `eTag = server.meta.eTag`. If that transaction itself conflicts, the resolver fires again with the new `local`/`server` pair. Original Promise stays pending across the chain.

### Example 3 — one-way binding (display only)

```html
<span class="badge" x-text="resources.todo.task-42.value.status"></span>
```

Same bootstrap; no additional code. Auto-subscribe fires; element updates reactively when status changes server-side. No writes originate here; the resolver is never invoked for this binding (whether one is registered for `'todo'` is orthogonal — one-way bindings don't write).

### Example 4 — human-in-the-loop conflict (non-blocking UX)

For a document editor where modal-blocking on every conflict would be intrusive:

```js
// Track pending conflicts as application state.
client.resources.onETagConflict('document', (local, server) => {
  state.setState(`app.conflicts.${server.meta.eTag}`, {
    resourceType: 'document',
    local,
    server,
    timestamp: Date.now(),
  });
  return { resolution: 'human-in-the-loop' };
});
```

```html
<!-- A banner element bound to the conflict list -->
<div x-show="app.conflicts" class="alert alert-warning">
  <span x-text="Object.keys(app.conflicts).length"></span> conflicts to review.
  <button x-on:click="reviewConflicts">Review</button>
</div>
```

The transaction queue unblocks immediately; the user keeps editing. When they click Review, application code walks `app.conflicts.*`, presents UI, and calls `client.resources.transaction(...)` with the chosen value (eTag = the server eTag captured in the conflict record) to commit the resolution.

This is the `'human-in-the-loop'` resolution doing its job: framework hands off; surrounding code orchestrates the rest of the flow. No "drop down to fully manual" — the framework still provides both values, the eTag for re-submission, and the same `transaction()` API.

## Implementation Phases

### Phase 5.3.0: Port `@lumenize/state` (prerequisite)

Phases 5.3.3 and 5.3.6 depend on `@lumenize/state` existing. The port itself is scoped in `tasks/lumenize-ui.md` (§ Pre-port inventory § "Definitely keeping → Top-level helpers + StateManager"). Restating the scope here so this task is self-contained:

- [ ] New package `packages/state/` (MIT) — `@lumenize/state`
- [ ] Port `StateManager` (~310 LOC) — `getState`, `setState`, `subscribe`, `subscribeExact`, `track` + `deps`, `executeBatch`, middleware list, `#hasCircularUpdate`, `#notifySubscribers`, `#triggerPathSubscribers`
- [ ] Port top-level helpers (~30 LOC) — `isValidPath`, `getPathParts`, `deepEquals`
- [ ] Add `state.computed(targetPath, fn): () => void` — user-facing derived-state API. Uses `track()` internally to collect deps from `fn`; subscribes to each; sets `targetPath` to `fn()`; re-runs on any dep change (and re-tracks for conditional dep sets). Returns a dispose function. Matches Vue/MobX/Preact `computed` naming. Replaces JurisJS' implicit derivation that happened inside DOMRenderer reactive slots (which we're not porting). Used by `x-if` callers for derived booleans and by any application code needing computed state.
- [ ] Replace `createLogger` calls with `@lumenize/debug`
- [ ] Normalize `_underscore` privates to `#hash` per CLAUDE.md, except where cross-class access requires public
- [ ] Tests in `packages/state/test/` covering the surface NebulaClient depends on (`getState`/`setState`/`subscribe`/`executeBatch`/middleware)
- [ ] No renderer, no `ComponentManager`, no `Juris` orchestrator — those are not being ported (decision pinned 2026-05-09 in `tasks/lumenize-ui.md`; `@lumenize/ui` is the from-scratch DOM-crawl helper using Alpine-flavored directives, not the JurisJS renderer)

This phase is **risk-free** per `lumenize-ui.md` — `@lumenize/state` is correct work regardless of how the renderer question resolves. Land it before 5.3.3.

### Phase 5.3.1: Star subscribe machinery

- [ ] `Subscribers` table created via `CREATE TABLE IF NOT EXISTS` in Star constructor
- [ ] `@mesh()` `subscribe` method with Handler 1 / Handler 2 pattern (mirrors `transaction()`)
- [ ] DAG read-permission check at subscribe time (uses `getNodeByPath` from Phase 3 carry-over)
- [ ] Initial snapshot delivered to client via the `handleResourceUpdate` handler (same path as ongoing fanout)
- [ ] Subscriber row inserted on success; idempotent on re-subscribe with same `(clientId, resourceType, resourceId)`

### Phase 5.3.2: Fanout on mutation

- [ ] `#onChanged` replaced with subscriber lookup + per-subscriber `lmz.call` to NEBULA_CLIENT_GATEWAY
- [ ] BroadcastChannel semantics: originator's `clientId` excluded from fanout for that mutation
- [ ] Snapshot deletion (resource deleted) pushes `null` to subscribers
- [ ] Fanout triggers are upsert and delete only — migration does *not* fan out (deploys force-refresh; pushing migrated snapshots to old-version clients would feed new-shape data to old-shape code)
- [ ] **Branch-aware subscription routing**: subscriptions are inherently branch-local (each branch is an independent Star instance — see `tasks/nebula-branches.md`). NebulaClient subscribes against the URL it's connected to, which carries the branch in its 4-tuple. Verify the subscribe wiring doesn't assume a single Star instance per `{u}.{g}.{s}`.

### Phase 5.3.3: NebulaClient handlers + `client.resources.*` API

- [ ] `handleTransactionResult` and `handleResourceUpdate` implementations replace the stubs (drop `handleReadResult` entirely — read is a method, not a handler)
- [ ] `handleResourceUpdate` writes through the bound StateManager — no internal value cache on NebulaClient. eTag and value go to sibling paths (`{statePath}.value`, `{statePath}.meta`).
- [ ] `handleTransactionResult` advances the in-flight transaction queue and dispatches to the registered conflict resolver on `{ ok: false, errors: { rid: { type: 'conflict', ... } } }`
- [ ] `@lumenize/state`'s StateManager registered with NebulaClient at construction. In browsers using `@lumenize/ui`, the same StateManager instance lives behind the Juris orchestrator; in Node/headless tests, NebulaClient depends on `@lumenize/state` alone.
- [ ] Local subscription registry (in-memory `Map<resourceKey, { statePath }>`) — stays on NebulaClient because it's transport metadata, not application state
- [ ] NebulaClient constructor gains `ontologyVersion: string`; stored as `#ontologyVersion`; auto-attached to every wire call from `client.resources.*`
- [ ] NebulaClient constructor gains optional `onShouldRefreshUI` hook
- [ ] `client.resources` namespace with `subscribe`, `read`, `transaction`, `onETagConflict` methods; each operation method accepts `options.ontologyVersion?` as a per-op override (default = `this.#ontologyVersion`)
- [ ] `client.resources.onETagConflict(resourceType, resolver, options?)` registers a per-type resolver; `client.resources.transaction(ops, { onETagConflict: ... })` accepts a per-call override. Resolver precedence on conflict: per-call > per-type > framework default (`'use-server'`).
- [ ] `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`) implemented per the Surface section. Recursive `'use-this'` keeps the original Promise pending across the chain.
- [ ] `maxRetries` option (default 5) on `onETagConflict` registration and `transaction()` per-call options; on cap, reject original Promise with `'conflict-exhausted'`
- [ ] Resolver receives third `context` argument carrying `bindings: Map<path, HTMLElement[]>` of DOM elements bound to paths under the conflicting resource
- [ ] Field-diff comparison: after resolution, compare resolved value to `local.value`; identify paths where they differ; flash bound DOM elements at those paths
- [ ] Flash mechanism: add `flashClass` (default `'lumenize-conflict-revert'`) to identified elements; remove after `flashDuration` ms (default 1000); both options configurable per type via `onETagConflict` registration. `flashClass: null` disables.
- [ ] Bindings registry: `bindToState` extends `bindDom`'s path-subscriber map to track `HTMLElement` per subscriber (`Map<path, Set<HTMLElement>>`); exposed to resolver via `context.bindings`
- [ ] `bindDom` accepts `handlers` config object: `bindDom(root, state, { handlers: { saveTodo: fn, ... } })`; `x-on:event="handlerName"` looks up the function by string name
- [ ] `client.bindToState(state)` method: registers `setState` middleware on `state`, sets up auto-subscribe reference counting for `resources.{rt}.{rid}.*` paths, wires `handleResourceUpdate` → `state.setState` for the remote→local direction
- [ ] Star's mismatch path ([star.ts:203-206, 270-273](apps/nebula/src/star.ts:203)) updated to return a structured `{ kind: 'ontology-stale', clientVersion, currentVersion }` value instead of a generic `Error`
- [ ] NebulaClient inspects `handleTransactionResult` / `handleResourceUpdate` / read-method responses for the staleness signal; on present, dispatches to `onShouldRefreshUI` (if registered) and settles the originating Promise (rejection on transaction; rejection on read; subscribe TBD — probably resolution-with-null since the UI is about to refresh anyway)
- [ ] `client.resources.subscribe(rt, rid, statePath?)` returns a Promise that settles when the first `handleResourceUpdate` arrives for that pair
- [ ] `client.resources.read(rt, rid)` returns a Promise resolving with `Snapshot | null`; **no state side-effect** — caller decides what to do with the value (the mesh-framework mechanism for getting the response back to this Promise — callId correlation, hidden plumbing handler, or extending mesh return values — is resolved here)
- [ ] `client.resources.transaction(ops)` generates `newETag(s)` for each op, enqueues if a transaction is in-flight, otherwise sends. Returns Promise that `handleTransactionResult` settles. 5–10 s timeout on the in-flight Promise; on timeout, reject and unblock the queue. Caller decides whether to retry — retry is safe because client-generated `newETag` makes the operation idempotent.

### Phase 5.3.4: Auto-resubscribe on reconnect

- [ ] Hook into LumenizeClient's connection-state transitions; identify the right event for "reconnect succeeded"
- [ ] Walk the subscription registry on that transition; re-call `Star.subscribe` for each
- [ ] Verify nothing else needs to drain (in-flight transactions during the disconnect — out of scope?)

### Phase 5.3.5: Subscriber cleanup on disconnect

- [ ] NebulaClientGateway hook: detect WebSocket close, notify Star to remove that `clientId`'s subscriber rows
- [ ] Confirm the cleanup mechanism doesn't create a thundering-herd problem when many clients disconnect at once (e.g., during a deploy)

### Phase 5.3.6: `client.bindToState(state)` integration (renderer-agnostic)

The synced-state middleware lives on NebulaClient (delivered by `bindToState`), not in `@lumenize/state` or `@lumenize/ui`. It works the same whether the UI is `bindDom`-driven (Alpine-flavored directives), vanilla HTML+JS-against-StateManager, or no UI at all (headless Node). See `tasks/lumenize-ui.md` § "Path conventions & resource addressing" and § "Why this combination works" for the path-based reactivity context.

- [ ] `client.bindToState(state, options?)` registers a `setState` middleware on `state` that intercepts writes matching `resources.{rt}.{rid}.*` and constructs transactions via `client.resources.transaction()`
- [ ] Optimistic-write flow: middleware reads cached `eTag` via `state.getState('{statePath}.meta.eTag')`, packages the local `setState` value into a transaction op with that eTag plus a freshly-generated `newETag`, and submits. The conflict resolver (per-type or per-call) decides what happens next.
- [ ] Auto-subscribe via reference counting: `Map<resourceKey, count>` on `bindToState`; each new binding (initial walk + observer-detected additions) increments, each removed binding decrements; 0→1 triggers `client.resources.subscribe(rt, rid)`; count→0 schedules `unsubscribe` after `unsubscribeGraceMs` (default 2000)
- [ ] Grace-period cancel: pending unsubscribe is cleared if a new binding for the same `(rt, rid)` arrives during the grace window
- [ ] `bindDom(root, state, options?)` sets up a `MutationObserver` with `{ childList: true, subtree: true }` rooted at `root` when `options.autoObserve !== false`
- [ ] On observer `addedNodes`: walk each added subtree, register `x-*` bindings, increment refcounts. Walk visits each element once; iterate `el.attributes` to find directives.
- [ ] On observer `removedNodes`: schedule unregistration via `queueMicrotask`; in microtask, check `el.isConnected` — if still connected (element moved), skip; otherwise walk subtree, unregister bindings, decrement refcounts
- [ ] Per-element binding tracking: `WeakMap<HTMLElement, BindingRecord[]>` storing each `state.subscribe` unsubscribe function plus `x-input` listener disposers
- [ ] Directive attributes read once at binding time — no observation of `attributes` mutation. Document explicitly.
- [ ] `bindDom`'s `handlers` option: `bindDom(root, state, { handlers: { saveTodo: fn, ... } })`; `x-on:event="handlerName"` looks up the function by string name
- [ ] **`x-for` parser**: recognize `<template x-for="loopVar in path">` syntax via regex `/^(\w+)\s+in\s+(.+)$/`; clone the template content per array element; manage clones by `x-key` (default by-index if omitted, log a warn)
- [ ] **`x-for` scoped path resolver**: inside an `x-for` template's clones, paths starting with the loop variable resolve to the scoped value; `$loopVar` segments in any path are substituted with the loop variable's stringified value; otherwise normal state path resolution
- [ ] **`x-for` reactivity**: subscribe to the array path; on change, diff old keys vs new keys; unchanged clones stay; added keys produce new clones inserted at the right position (MutationObserver picks up bindings); removed keys produce clone removal (MutationObserver picks up unbinding + refcount decrement)
- [ ] **`x-if` parser**: recognize `<template x-if="path">` and `<template x-if="!path">`; subscribe to the path; on truthy → clone template content into parent; on falsy → remove cloned content
- [ ] **`x-if` lifecycle composition**: mount/unmount via DOM insertion/removal so the existing MutationObserver mechanism handles binding registration/unregistration and refcount changes automatically. No special-case lifecycle code for `x-if`.
- [ ] **`x-for` + `x-if` nesting**: forbid both on the same `<template>` (throw or warn loudly); nested templates are the supported pattern
- [ ] Remote-pushes direction: `handleResourceUpdate` writes through directly to `state.setState`; middleware does *not* intercept (would create a loop).
- [ ] No `newState(key, initial, { sync })` declaration needed — synced-ness is implicit from the path prefix. Local-only state lives at other paths (`ui.*`, `app.*`); synced state lives at `resources.{rt}.{rid}.*`.

### Phase 5.3.7: For-docs test (one big `it`, narrative)

- [ ] Two clients call `client.resources.subscribe(rt, rid)`; client A calls `client.resources.transaction(...)`; client B's bound StateManager path updates via `handleResourceUpdate`
- [ ] Client A does NOT receive its own update via fanout (BroadcastChannel semantics) — its bound state instead reflects the authoritative value via `handleTransactionResult`'s success path
- [ ] **`'use-server'` resolution path**: two clients write same resource near-simultaneously; the loser's resolver returns `{ resolution: 'use-server' }` (the default); `state.setState(statePath, server.value)` fires; loser's Promise rejects with `'conflict-lost'`
- [ ] **`'use-this'` resolution path**: same race, but the loser has registered a resolver that returns `{ resolution: 'use-this', value: mergedValue }`; framework `setState`s `mergedValue` and submits a new transaction with `eTag = server.meta.eTag`. Verify recursion: arrange for the second submission to also conflict, confirm resolver fires again, second resolution succeeds.
- [ ] **`maxRetries` exhaustion**: register a resolver that always returns `'use-this'` and arrange for every submission to conflict; after `maxRetries` (default 5) attempts, original Promise rejects with `'conflict-exhausted'`
- [ ] **`'human-in-the-loop'` resolution path**: loser's resolver returns `{ resolution: 'human-in-the-loop' }`; original Promise rejects with `'conflict-handoff'`; optimistic local state stays painted (NOT overwritten with server's value); no new transaction emitted by framework. Test then manually submits a follow-up transaction with the user's chosen value to clear the conflict.
- [ ] Per-call override: a transaction with `options.onETagConflict: customResolver` overrides the per-type registered resolver for that call only
- [ ] **Flash class**: after `'use-server'` resolution where local differed from server, framework adds `flashClass` to bound DOM elements at the diff fields; class is removed after `flashDuration` ms. Test with both default class name and a custom one. `flashClass: null` disables (verify no class added).
- [ ] **Resolver bindings access**: resolver receives `context.bindings`; verify it contains exactly the elements bound to paths under the conflicting resource (and not other paths)
- [ ] Idempotency probe: simulate a lost transaction response (test-only — drop the response and have the client retry); the retry's transaction succeeds without producing a duplicate (eTag-as-idempotency-key)
- [ ] `client.resources.read(rt, rid)` returns the current snapshot without writing to bound state
- [ ] Staleness probe: client constructed with `ontologyVersion: 'v1'`, server now on `v2`; client's transaction → `onShouldRefreshUI` hook fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`; transaction's Promise also rejects (or resolves with the staleness sentinel — pin the exact behavior during 5.3.3 implementation)
- [ ] Auto-subscribe probe: load HTML with `x-text="resources.todo.task-42.value.title"` binding; call `bindDom`; confirm `client.resources.subscribe('todo', 'task-42')` fires automatically without explicit subscribe call
- [ ] **Dynamic-DOM addition**: after `bindDom`, append a new element with `x-text="resources.todo.task-7.value.title"`; use `vi.waitFor` to wait for MutationObserver microtask + `client.resources.subscribe('todo', 'task-7')` to fire; confirm element receives initial snapshot. (`vi.waitFor` is the canonical pattern across all dynamic-DOM probes — DOM mutations are processed asynchronously by the observer, and unsubscribe-grace-period assertions need real time to elapse anyway.)
- [ ] **Dynamic-DOM removal + grace period**: remove the bound element; use `vi.waitFor` to confirm the path-level state subscription unregistered (no callback fires on subsequent setState); the `(rt, rid)` refcount drops to zero; the server-side `unsubscribe` does NOT fire immediately; after `unsubscribeGraceMs` elapses, the server-side `unsubscribe` fires
- [ ] **Grace-period cancel**: remove element, wait briefly (less than `unsubscribeGraceMs`), insert a new binding for the same `(rt, rid)`; use `vi.waitFor` to confirm the pending server-side unsubscribe is cancelled — refcount goes 1 → 0 → 1, no `unsubscribe` call ever fires
- [ ] **Move (not removal)**: remove an element from one parent and append it to another in the same task; use `vi.waitFor` to drain microtasks; confirm the binding is NOT unregistered (still works after the move)
- [ ] **`autoObserve: false`**: bind a tree with `bindDom(root, state, { autoObserve: false })`; add an element after the initial walk; confirm the new element's `x-text` does NOT activate (no observer running)
- [ ] **`x-for` inline-array iteration**: bind a `<template x-for="assignee in resources.todo.task-42.value.assignees" x-key="assignee.id">` with `<li x-text="assignee.name">`; populate the array; use `vi.waitFor` to confirm N `<li>` clones render with correct text per assignee
- [ ] **`x-for` array mutation + keying**: starting from N items, push one (use `vi.waitFor` to assert one new clone, existing clones untouched); pop one (use `vi.waitFor` to assert the right clone removed); reorder by setting array to permutation (assert clones reused, not torn down — verify by stashing `el.dataset.testId` and confirming preservation)
- [ ] **`x-for` FK with `$loopVar` substitution**: bind a `<template x-for="subtaskId in ...">` with `<div x-text="resources.todo.$subtaskId.value.title">`; confirm auto-subscribe fires per ID, each clone renders the right resource's title, removal triggers grace-period unsubscribe
- [ ] **`x-if` mount/unmount**: bind `<template x-if="resources.todo.task-42.value.completed">` with inner bindings; flip the boolean true/false; use `vi.waitFor` to confirm inner content appears/disappears and inner bindings register/unregister
- [ ] **`x-if` `!path` negation**: bind `<template x-if="!resources.todo.task-42.value.completed">`; flip the boolean; confirm content appears when the path is falsy
- [ ] **`x-for` + nested `x-if` (filtered iteration)**: outer `x-for`, inner `<template x-if="task.active">`; flip individual `task.active` values; confirm clones mount/unmount independently
- [ ] **`state.computed()` driving `x-if`**: derive `app.derived.x.isOpen` from a status field; bind `<template x-if="app.derived.x.isOpen">`; flip the underlying status; confirm derivation re-runs and `x-if` reacts
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant)
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during the disconnect

## Out of Scope (post-demo)

- **Multi-resource subscriptions** — `subscribe()` for a query result, where the subscription survives resources entering/leaving the result set. Big design space; not needed for demo.
- **Large-fanout architecture** — tiered fanout through Worker armies for >64 subscribers per resource. See `tasks/nebula-scratchpad.md` § "Fanout Broadcast Tiering."
- **Per-mutation guards on fanout** — re-checking DAG permission for each subscriber on each push. Demo accepts subscribe-time-only check.
- **Subscription to specific subtrees vs. full tree** — DAG-tree-level subscriptions (different from resource subscriptions).

## Open Questions

1. **Subscriber cleanup on disconnect** — exact mechanism. Options: (a) Gateway hooks the underlying WS close and pushes a "drop subscribers for clientId" call to Star; (b) periodic Star sweep based on last-heartbeat-from-client; (c) accept the leak for demo and clean up post-demo. (a) is right but needs Gateway plumbing.
2. **Permission revocation mid-subscription** — if an admin revokes someone's read permission on a node while they're subscribed, the existing subscriber rows still fanout to them. Acceptable for demo (DAG mutation is a deliberate, infrequent operation; Studio probably won't surface mid-session permission changes). For production, the DAG-mutation path needs to invalidate subscribers.
3. **`getEffectivePermission` per-subscriber on notification?** Open question carried from `tasks/nebula-scratchpad.md`. Probably no for demo (subscribe-time check is sufficient); revisit for production.
4. **Subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy** — when a Studio deploy changes guards/ontology, do existing subscribers get re-evaluated? Leans toward "all subscriptions invalidated, clients re-subscribe" since deploy is already disruptive (preview auto-refresh).
5. **Subscription identifier** — does `(clientId, resourceType, resourceId)` uniquely identify a subscription, or do we need a generated `subId` for multi-tab same-client cases? `instanceName` of the Gateway should already disambiguate per tab.
6. **Mesh-framework Promise correlation for `client.resources.read()`** — implementation detail, not API design. Three options: (a) use existing `callId` machinery to correlate the response back to the caller's Promise, (b) hidden plumbing handler on NebulaClient that's `@mesh`-decorated but not part of the public API, (c) extend the mesh return-value path so `lmz.call` from Star can return a value to the originating client's call. Resolve during 5.3.3 implementation.
7. **Query language** — `x-for` handles iteration over arrays the application already has (inline-object arrays, FK-by-ID arrays, locally-synthesized arrays in `app.*` paths). For "give me all todos where status='open'" — i.e., a query-result list driven by server-side filtering / sorting / pagination, with the result-set subscribed-to so additions and removals stream in — Nebula needs a query language. Deferred to its own phase. Design space includes: query shape (declarative JSON? path-like? SQL-flavored?), server-side execution model (Galaxy query DO?), result-set subscription semantics (push on add/remove from the result set; what about reorder?), pagination, cursor stability across schema migrations. Not in 5.3 scope.

**Pinned (no longer open):**

- **Conflict response routing** — `handleTransactionResult` always invokes a registered `ConflictResolver`. Registration is per-type: `client.resources.onETagConflict(resourceType, resolver)`. Per-call override available via `options.onETagConflict` on `transaction()`. Framework default = `{ resolution: 'use-server' }`. Resolver returns a `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). See Decisions table and Surface section.
- **Initial-snapshot delivery mode** — same path as ongoing fanout (`handleResourceUpdate`). The `subscribe()` Promise resolves *because* `handleResourceUpdate` fired for that pair the first time; the Promise is sugar over the handler.
- **Idempotency mechanism** — client-generated `newETag` per transaction (or per op). Server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. No separate `txnId`, no server-side dedupe table. See Decisions table.
- **Auto-subscribe via DOM-crawl reference counting** — `client.bindToState(state)` is the integration point. Vibe coder writes HTML with `x-text="resources.{rt}.{rid}.*"`; `bindDom` discovers paths; `bindToState`'s refcount layer auto-calls `client.resources.subscribe(rt, rid)`. No explicit subscribe in user code. See Surface section.

## Notes

- This file replaced an earlier 13-line stub during the demo-focus refactor. The two open considerations from the stub (promote `apps/nebula/test/browser/` harness; retrofit auto-spawn-wrangler-dev pattern to mesh tests) are deferred — both are testing-infrastructure improvements, not subscribe semantics. Move them to backlog if they're worth surfacing now.
- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design." Don't lose those — they're prior art.
- Fanout > 64 subscribers (large-fanout tiering) is intentionally not designed here. The demo will run with a handful of subscribers max.

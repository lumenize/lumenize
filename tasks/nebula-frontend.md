# Nebula Frontend

**Status**: Active — demo critical path
**Progress**: Phases 5.3.0 – 5.3.5 shipped (2026-05-12). Next: Phase 5.3.6 (`client.bindToState` integration + `@lumenize/ui` bindDom).
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
> - 2026-05-12 — components & recursion added: `x-component` / `x-render` / `x-prop:*` / `$local` / `x-key-from` / `$trail` / handler scope-injection. Concluded `tasks/ui-renderer-spike.md` without running the LLM-generation experiment — empirical recursion finding in Juris ObjectDOM (componentStack guard blocks initial-render trees with pre-populated data) plus path-string-vs-live-object reactivity gap moved the decision toward extending the Alpine-flavored grammar rather than porting Juris's renderer. `@lumenize/ui` LOC estimate raised from ~200 to ~510. See `coding-your-ui.md` "Components and recursion" + "Worked example: DAG tree with virtual branches" for the canonical surface.
> - 2026-05-12 — Phase 5.3.0 port scope pinned ahead of implementation: public `subscribe()` extended to fire on exact + ancestor + descendant writes (deliberate divergence from JurisJS external-subscribe, which only fires exact + descendant); class + `createState()` factory exports, no default singleton; `state.use()` for post-construction middleware install/remove; `computed()` error model pinned (self-ref → throw at registration, runtime fn-throw → `console.error` and retain prior value); dropped `subscribeExact`, `subscribeInternal`, `reset()`, and `createPromisify` from the port.
> - 2026-05-12 — Phases 5.3.0 – 5.3.3d shipped. Key landings: `@lumenize/state` package; `Subscriptions` class + `Subscribers` SQL; resource-mutation fanout with originator exclusion; `client.resources.{subscribe, read, transaction, onETagConflict}` API; `TransactionResolution` always-resolve discriminated union; serial transaction queue + 10 s timeout; client-generated per-transaction `newETag` (idempotency); server-side idempotency short-circuit; widened `TransactionError` with `permission` variant; conflict-resolver verdict handling (`use-server` / `use-this` / `human-in-the-loop`) with bounded recursive retries; structured `OntologyStaleError` + `onShouldRefreshUI` hook on transaction/read/subscribe paths. Baseline test-app: 153/153 passing across 3 consecutive runs. Mid-implementation discoveries captured in CLAUDE.md (vi.waitFor defaults, cross-boundary typed-error pattern, over-broad-catch warning) and in [tasks/backlog.md](backlog.md) "Nebula" section (dag-tree typed-error refactor).
> - 2026-05-12 — 5.3.4 redesigned ahead of implementation. Original plan was "reconnect + refresh-cycle ontology check" where every refresh-token RPC carried a `currentOntologyVersion` populated from a TTL-cached Galaxy hop in NebulaAuth. Replaced with "reconnect + push-on-clear": the moment `Star.#installState()` upgrades the cached ontology, it notifies each connected subscriber via the existing fanout plumbing (grouped by `(subscriberBinding, clientId)` so one push per client) before dropping the `Subscribers` table. Eliminates the NebulaAuth → Galaxy hop, the cache, and the response-body field — push-on-clear + 5.3.4a reconnect + Handler-1 lazy detection cover the practical cases. Thundering-herd mitigation (jittered `refreshWithinMs`) sketched but deferred post-demo.
> - 2026-05-12 — Phase 5.3.4 shipped. 5.3.4a: `onConnectionStateChange` wired through NebulaClient's constructor (closure variable for prev-state tracking — class fields not yet initialized during `super().connect()`); on `reconnecting → connected`, `#resubscribeAll()` re-issues `Star.subscribe()` for every registry entry via direct `lmz.call` (NOT via `#subscribeResource`, which would coalesce-into-pending instead of issuing a fresh RTT — important for the case where a subscribe was sent before WS drop and the snapshot response was lost). User-supplied `onConnectionStateChange` chained. 5.3.4b: `Subscriptions.clear()` returns the distinct `(subscriberBinding, clientId)` pairs that were dropped; `Star.#installState` fires one `handleResourceUpdate('', '', OntologyStaleError)` per pair via the existing fanout plumbing. Client substitutes its own pinned `ontologyVersion` for the wire's empty `clientVersion` field inside `#dispatchOntologyStale`. Baseline test-app: 156/156 across 3 consecutive runs. Test-only hooks added: `NebulaClient._resubscribeAllForTest()` (`@internal`-marked direct invocation of the walk; the integration smoke test exercises the real supersede-driven state-machine path) and `StarTest.clearSubscribersForTest` (drops the Subscribers table without going through the production push-on-clear path — used by the reconnect test to make the absence of resubscribe observable, since Phase 5.3.5 isn't shipped yet).
> - 2026-05-12 — Phase 5.3.5 shipped via **drop-on-failed-fanout** (architectural pivot from the originally-planned alarm-driven cleanup). NebulaClientGateway extends `DurableObject` directly for zero-storage design — has no `this.lmz.call`, so initiating a mesh call from an alarm handler would have required ~30-50 LOC of envelope construction. Replaced with reactive cleanup inside `Star.#fanout`: each fanout `lmz.call` carries a handler continuation (`Star.onFanoutDelivered`) that drops the subscriber row inline when the Gateway returns `ClientDisconnectedError` (post-grace). New `Subscriptions.removeSubscriber(resourceId, clientId)` for PK-targeted single-row delete. `LUMENIZE_MESH_GRACE_PERIOD_MS` env binding added to `LumenizeClientGateway`'s `#gracePeriodMs` getter, set to `'100'` in baseline miniflare config so tests observe `ClientDisconnectedError` in well under a second. Trade-off: cleanup is reactive (next fanout to that resource), not proactive. Quiet resources leak rows until next deploy's push-on-clear (5.3.4b) — acceptable since storage is trivial and the leak is bounded. Baseline: 158/158 across 3 consecutive runs (+2 disconnect-cleanup tests).

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
| `@lumenize/ui` | Written from scratch | `bindDom(root, state, options?)` DOM-crawl helper with Alpine-flavored `x-*` directives. ~510 LOC total: ~200 base directives, ~100 `x-for` / `x-if`, ~210 components & recursion (`x-component` / `x-render` / `x-prop:*` / `$local` / `x-key-from` / `$trail` / handler scope-injection). | Built alongside Studio demo |
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
  - Galaxy's latest does *not* match → mismatch returned. **This is the staleness signal.** Now a structured `OntologyStaleError` (5.3.3d) — typed Error with `name: 'OntologyStaleError'` + `clientVersion` / `currentVersion` fields. NebulaClient detects via `isOntologyStaleError(err)` and dispatches to `onShouldRefreshUI`.
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
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. State path is fixed at `resources.{resourceType}.{resourceId}` (the `statePath?` override on subscribe was dropped in 5.3.3a — entire-resource-at-a-time addressing only). | Period-delimited state paths and slash-delimited URLs must be unambiguously interconvertible. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings reactive to bulk-snapshot pushes without spurious re-renders. |
| **Reserved state-path prefixes** | Two top-level prefixes are framework-reserved: `resources.*` (synced resource snapshots — `resources.{rt}.{rid}.value` and `.meta`) and `lmz.*` (everything else framework-owned — connection state, future things). All other top-level segments (`ui.*`, `app.*`, etc.) are app-owned. Framework only touches `resources.*` and `lmz.*`. | Two prefixes, not one. `lmz.resources.*` would be strictly consistent but adds a segment to every directive in every UI — significant ongoing ergonomic cost. `resources.` is short and distinctive enough on its own; `lmz.` covers the rare framework-meta cases. App authors get the rest of the namespace. |
| **`lmz.connection.*` connection-state surfacing** | NebulaClient writes LumenizeClient's connection state to `lmz.connection.*` paths so the UI can bind declaratively. Paths: `lmz.connection.state` (`'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'`); `lmz.connection.connected` (boolean — true iff `state === 'connected'`); `lmz.connection.lastConnectedAt` (timestamp ms, set on each `'connected'` transition). Updated by `bindToState`'s setup — subscribes to LumenizeClient's connection events, writes through on each transition. | Real-time-sync demos need a visible connection-state indicator (part of the wow factor; also tells users when their edits aren't reaching the server). Surfacing as state paths makes it declarative: `<div x-show="!lmz.connection.connected">Reconnecting…</div>` works without event listeners in user code. Three paths cover common cases (state string for fine-grained display, boolean for show/hide, timestamp for "last synced X ago" UX). |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. | Cleaner than separate `txnId` — no server-side dedupe table, idempotency implicit in the eTag itself. Auto-retry safe across network drops. |
| **Transaction queue** | Serial — at most one transaction in flight per client; subsequent calls queue. 5–10 s timeout then resolve the in-flight Promise with `{ resolution: 'timeout' }` (queue unblocks). Caller-decided retry. Queue blocks transactions on *all* resources/fields, not just the in-flight one. Optimistic local state still paints immediately on `setState` (the middleware does `setState` first, then enqueues) — so the user sees their typing land regardless of queue state. Queue is in-memory only; refresh clears it. | Matches human editing speeds; avoids partial-application reasoning. Timeout collapses all "I don't know what happened" failure modes to one signal. Optimistic-paint-then-enqueue means visual responsiveness is unaffected by queue depth. |
| **Resolver execution suspends queue timeout** | When `handleTransactionResult` invokes an async resolver (returns a Promise), the 5–10 s timeout is suspended until the resolver settles. When the framework submits the new transaction post-resolver, a fresh timeout starts for that submission. No max-duration enforced on the resolver itself — a modal can sit open for minutes if the user gets distracted. | The 5–10 s timeout is for "I don't know what happened to this call" cases. During resolver execution, the framework knows exactly what's happening — the user has the modal. App-level timeouts on the resolver (e.g., "auto-cancel after 30s") are the caller's responsibility via `Promise.race`. |
| **Conflict resolver (per resource type)** | Registered via `client.resources.onETagConflict(resourceType, resolver, options?)`. Per-call override via `options.onETagConflict` on `transaction()`. Framework default = `() => ({ resolution: 'use-server' })`. Resolver returns `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). Receives third `context: { bindings: Map<path, HTMLElement[]> }` for custom UX. | Conflict strategy is resource-shape-specific; per-type is the right grain. Discriminated union makes intent unambiguous. `'use-this'` triggers recursive new transaction (bounded by `maxRetries`, default 5, then transaction resolves with `{ resolution: 'retries-exhausted' }`). `'human-in-the-loop'` causes transaction to resolve with `{ resolution: 'human-in-the-loop' }`; optimistic state stays painted; app re-submits. `'use-server'` causes transaction to resolve with `{ resolution: 'use-server' }`; framework writes `server.value` through state. All terminal states are normal Promise resolutions (always-resolve contract) — see `TransactionResolution` type. |
| **Conflict flash class** | After resolution, framework compares resolved value to `local.value` field-by-field; for diff fields, adds `flashClass` to bound elements for `flashDuration` ms. Default class `lumenize-conflict-revert`, duration 1000 ms. Configurable per type via `onETagConflict('rt', resolver, { flashClass, flashDuration })`; `flashClass: null` disables. | Default visual signal that user input was changed by a conflict, without explicit UX code. Field-diff inference means only actually-affected fields flash. |
| **`ontologyVersion` on every operation** | NebulaClient constructor argument (Studio's bootstrap fills in at build time). Auto-attached to every `client.resources.*` call. `options.ontologyVersion` per-op override for admin scripts. | Lock-step UI/ontology. Star already takes it for Handler 1/2 dispatch. |
| **Staleness signal + `onShouldRefreshUI` hook** | Star's cache-miss-with-mismatch path returns `{ kind: 'ontology-stale', clientVersion, currentVersion }`. NebulaClient dispatches to registered `onShouldRefreshUI` constructor hook (no default — undefined = opted-out). Originating Promise also settles. | Centralized hook for an orthogonal signal that multiple call sites would otherwise each need to inspect. Distinct from earlier-rejected `onStaleVersion` (which was tied to one error path). |
| **Dynamic-DOM lifecycle (MutationObserver + refcounted subscribe)** | One `MutationObserver` per `bindDom(root, state)` call with `{ childList: true, subtree: true }`. Additions → walk subtree, register bindings, increment per-`(rt, rid)` refcount (0→1 triggers `subscribe`). Removals → schedule unregister via `queueMicrotask` (move-vs-remove check via `el.isConnected`); count→0 schedules `unsubscribe` after `unsubscribeGraceMs` (default 2000); new binding within grace cancels pending unsubscribe. Per-element tracking via `WeakMap<HTMLElement, BindingRecord[]>`. Directive attrs read once at binding time. Configurable via `bindDom(root, state, { autoObserve: false })` and `client.bindToState(state, { unsubscribeGraceMs: 2000 })`. | JurisJS auto-cleanup already calls for MutationObserver; we extend for additions. Microtask defer handles moves. Refcount-with-grace covers tab-switch / modal / quick-rerender churn cheaply. Read-once attrs avoid attribute-mutation re-binding (Studio templates don't need it). |
| **`x-for` (list iteration)** | `<template>`-only host. Syntax: `<template x-for="loopVar in path" x-key="...">`. Scoped path resolution: first segment === `loopVar` → scoped value navigation; path contains `$loopVar` → substitute the value as a string; otherwise normal state path. `x-key` required (default by-index logs a warn). Reactivity: diff old vs new keys; unchanged clones stay, added clones inserted (MutationObserver picks up bindings), removed clones (MutationObserver picks up unbind). | Iteration genuinely can't be path-only; carve out one directive. `<template>` host matches Alpine and makes "definition, not real DOM" unambiguous. `$loopVar` substitution enables FK-list rendering without JS map. |
| **`x-if` (conditional mount/unmount)** | `<template>`-only host. Syntax: `<template x-if="path">` or `<template x-if="!path">`. JS truthiness. No inline comparisons — use `state.computed()` for derived booleans. Don't combine `x-for` and `x-if` on same `<template>`; nest. Mount fires MutationObserver `addedNodes`; unmount fires `removedNodes`. No `x-else` / `x-else-if`. | Mount/unmount (vs `x-show`'s display-toggle) frees bindings when subtree invisible. `!path` matches Alpine; `x-unless` would create LLM friction. Skipping `x-else` keeps grammar minimal; `state.computed()` is the principled path for complex conditions. |
| **Components & recursion** (added 2026-05-12) | `<template>`-only host for definition (`x-component="name"`) and instantiation (`x-render="name"`). Props via `x-prop:{name}="value"` (mirrors `x-bind:attr` / `x-class:name` colon-namespacing); inside the template, props are accessed as `${name}`. Per-instance state via `$local` (get/set proxy mapped to `ui.{componentName}.{instanceKey}.*`); `x-key-from="..."` derives the discriminator (required when `$local` used). Component instances at multiple positions in the same tree are disambiguated by `$trail` — a read-only array of ancestor scoped values auto-built from chained `x-key` / `x-key-from` values during recursive descent. Handlers receive `(event, scope)` with destructurable `{ $local, $node, $trail, ... }` slots. Recursion uses `x-render="own-name"` inside the component's own template; no hard depth limit (bounded by JS call stack). Canonical example: `coding-your-ui.md` § "Worked example: DAG tree with virtual branches". | Component + recursion + per-instance state is the union of needs from parameterized reuse, tree UIs, and per-card-toggle UX. Alpine doesn't ship components, so we extend rather than borrow. The colon-namespace shape (`x-prop:`, `x-bind:`, `x-class:`) keeps the directive grammar internally consistent. `$local` mirrors JurisJS's `newState` pattern but with path-keyed storage (matches Lumenize's path-based reactivity model end-to-end). `$trail` solves the multi-parent-rendering case directly: same logical node at two positions gets independent state, no manual instance-key construction. **Replaces** the 2026-05-09 "no ObjectDOM port" framing where components were declared out of scope — the recursion + reactivity-binding findings from `tasks/ui-renderer-spike.md` showed that porting Juris's renderer wasn't the "free components and recursion" we'd estimated, and extending the Alpine grammar produced a cleaner end-to-end design at lower LOC. |

## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` (always-resolves with `TransactionResolution`) | `committed`: resolve; `'use-server'`: resolve; `'use-this'`: stays pending across recursive chain until terminal (`committed` or `'retries-exhausted'`); `'human-in-the-loop'`: resolve; `'validation-failed'`: resolve; `'permission-denied'`: resolve; `'ontology-stale'`: resolve (also dispatches to `onShouldRefreshUI`); `'timeout'`: resolve (queue-timer driven, no server response received) | `committed`: yes (write authoritative value + new eTag); `'use-server'`: yes (write `server.value`); `'use-this'`: yes (optimistic write `value`, then submit); `'human-in-the-loop'`: no (optimistic stays painted); `'validation-failed'`: rollback to last-confirmed; `'permission-denied'`: rollback to last-confirmed; `'ontology-stale'`: rollback; `'timeout'`: rollback |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves initial-snapshot Promise from `client.resources.subscribe()`; thereafter, fanout pushes from `Star.#fanout` | only first call settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `resources.{rt}.{rid}.value` and `meta` to `resources.{rt}.{rid}.meta` |
| `client.resources.read(rt, rid)` | returns `Promise<Snapshot \| null>` | yes — caller `await`s the Snapshot | **none** — caller decides |

The first two are necessarily `@mesh` handlers because Star calls them. The third is a method; its Promise is settled by a hidden plumbing handler (`handleReadResponse(requestId, result)`) keyed on a client-generated `requestId` — see Open Question 6 (resolved 2026-05-12).

UI flow uses `subscribe` for reactive reads. `read` is the explicit-intent escape hatch for ad-hoc / scripting.

## Two `subscribe`s — different things

The word "subscribe" appears at two layers, doing two different jobs.

| Call | Layer | Network? | Purpose |
| --- | --- | --- | --- |
| `client.resources.subscribe(rt, rid)` | NebulaClient | yes — WS round-trip to Star | Tells Star to push snapshots on every change. Inserts row in Star's `Subscribers` table. |
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
  resourceId TEXT NOT NULL,
  clientId TEXT NOT NULL,
  sub TEXT NOT NULL,
  subscriberBinding TEXT NOT NULL,
  subscribedAt TEXT NOT NULL,
  PRIMARY KEY (resourceId, clientId)
) WITHOUT ROWID;
```

Per CLAUDE.md SQL conventions: PascalCase table, camelCase columns, `WITHOUT ROWID` for compound PK.

**Why this PK shape (revised 2026-05-12):** every subscribe / unsubscribe event specifies both `(resourceId, clientId)` (full-PK point lookup) and every fanout event uses only `resourceId` (PK-prefix scan). No secondary index needed. The earlier `(clientId, resourceType, resourceId)` PK plus `idx_Subscribers_resource` was inverted — fanout was the hot path and needed an extra index.

**Why no secondary index on `clientId`:** disconnect cleanup (Phase 5.3.5 — `DELETE WHERE clientId = ?`) becomes a full table scan without it. Per CLAUDE.md, writes are 1,000× more expensive than reads and every index adds a write per row, so the index would tax the hot path (subscribes — ~10–100 per user session) to optimize a cold one (cleanup — ~1 per session). Crossover where the index pays off is roughly N ≈ 10k–100k rows per Star (single Star with thousands of concurrent clients × tens of subs each). **Add the index then, not before.**

**Why `resourceType` is not stored:** `meta.typeName` on the snapshot gives the type at fanout time, including for `deleted: true` snapshots (which we keep, not null out). Subscribe-time type-mismatch check reads the snapshot's `typeName` directly. Storing the type in the Subscribers row would duplicate truth.

**Why `subscribedAt` is stored (and what it is NOT):** forensic / debug metadata — "when did this subscription row originate?" Useful when triaging a misbehaving subscriber by grep through DO storage logs. Storing it is essentially free (DO storage bills per row, not per column).

It is **NOT a staleness signal.** With auto-reconnecting WebSockets, a row from yesterday can be perfectly valid as long as the underlying session is alive — `subscribedAt` is row birthday, not last-proven-alive. Earlier sketches treated it as a TTL signal for an alarm-based sweep; that approach was rejected. See Phase -1 § 5 for the full rejection record and the three-mechanism cleanup model (active-WS-close + ontology-install-clear + optional drop-on-failed-fanout) that replaces it.

**Why `subscriberBinding` (not `gatewayBinding`):** named to support future DO-to-DO subscribers — `lmz.call(subscriberBinding, instanceName, ...)` at fanout time doesn't care whether the binding is `NEBULA_CLIENT_GATEWAY` (today) or another DO class (e.g. a Star subscribing to another Star). The column value is taken from `callContext.callChain.at(-1)?.bindingName` at subscribe time. Note: a DO-to-DO subscriber wouldn't carry `originAuth.sub` (DOs don't have user identities) — the `sub` column may need to become nullable when that case lands, but it's not a 5.3 concern.

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
handleResourceUpdate(resourceType: string, resourceId: string, snapshot: Snapshot | null | Error): void {
  // Unconditional state write-through to resources.{rt}.{rid}.value and .meta
  // If subscribe() Promise is pending for this (rt, rid), resolve it
  // Error path (e.g., OntologyStaleError) → reject pending Promise, dispatch
  //   onShouldRefreshUI if stale; no state write-through
  // snapshot === null reserved for "row legitimately absent" (subscribe-before-create);
  //   soft-deleted resources arrive as Snapshot with meta.deleted: true
}

client.resources = {
  subscribe(
    resourceType: string,
    resourceId: string,
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
  ): Promise<TransactionResolution>;  // ALWAYS resolves — switch on outcome.resolution

  /**
   * Register a per-resource-type conflict resolver. Per-call override
   * available via options.onETagConflict on transaction(). Framework default
   * is server-wins.
   */
  onETagConflict(
    resourceType: string,
    resolver: ConflictResolver,
    options?: {
      maxRetries?: number;        // default 5; on cap, transaction resolves with { resolution: 'retries-exhausted' }
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

1. **Local writes → remote transactions.** `setState` middleware on `state` watches writes to `resources.{rt}.{rid}.*`. Reads cached `eTag` from `getState('resources.{rt}.{rid}.meta.eTag')`, generates `newETag`, constructs op, calls `client.resources.transaction(...)`. User's `setState` is also the optimistic local write.
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

Directive set: `x-text`, `x-html`, `x-bind:attr`, `x-show`, `x-class:name`, `x-on:event`, `x-input`, `x-for`, `x-if`, `x-key`, `x-component`, `x-render`, `x-prop:name`, `x-key-from`. Scoped values exposed to directives and to handlers: `$node` (and any other `x-prop:*` names), `$local` (per-instance state proxy), `$trail` (read-only array of ancestor scoped values). Semantics in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — the doc is canonical. Implementation must match the doc's described behavior.

`<template>`-only host for `x-for`, `x-if`, `x-component`, and `x-render`. Scoped path resolution inside `x-for` (see Decisions row). `$trail` auto-built from chained `x-key` / `x-key-from` values during descent; used internally to derive `instanceKey` for `$local`, and exposed to handlers and directive values for breadcrumb-style UIs.

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

/**
 * `client.resources.transaction()` returns `Promise<TransactionResolution>`
 * and **always resolves** — never rejects (except for infrastructure failures
 * which still throw `Error`). Rust-`Result<T, E>`-style: callers switch on
 * `outcome.resolution` to handle every terminal state.
 *
 * The discriminant key (`resolution`) intentionally matches
 * `ConflictResolution`'s discriminant so the resolver's verdict and the
 * resulting transaction state share vocabulary: a resolver returning
 * `{ resolution: 'use-server' }` produces a transaction outcome with
 * `{ resolution: 'use-server', ... }`. The `'use-this'` verdict is NOT a
 * terminal state — it triggers a recursive re-submission with the server's
 * new eTag; the terminal of the `'use-this'` loop is `'retries-exhausted'`
 * after `maxRetries` (default 5) consecutive losses.
 *
 * Rationale for always-resolve over reject-on-failure: Studio-generated UIs
 * are LLM-authored. A discriminated-union switch forces handling every
 * variant explicitly, which produces better code-gen than relying on
 * `try/catch` hygiene (a bare `catch` would swallow the discrimination).
 */
type TransactionResolution =
  | { resolution: 'committed'; eTag: string }
  | { resolution: 'use-server'; resources: Record<string, Snapshot> }
  | { resolution: 'retries-exhausted'; resources: Record<string, Snapshot>; attempts: number }
  | { resolution: 'human-in-the-loop'; resources: Record<string, Snapshot> }
  | { resolution: 'validation-failed'; errors: Record<string, unknown> }
  | { resolution: 'permission-denied'; resources: string[] }
  | { resolution: 'ontology-stale'; clientVersion: string; currentVersion: string }
  | { resolution: 'timeout' };
```

## Implementation Phases

### Already shipped

**From earlier auth work**:
- Two-scope model (`authScope` / `activeScope`)
- Refresh path routing
- NebulaClientGateway active-scope verification
- Server-side auth flows
- LumenizeClient base (auto-reconnect)

**From this task, Phases 5.3.0 – 5.3.3d (2026-05-12)**:
- 5.3.0 — `@lumenize/state` package ported from JurisJS (StateManager + helpers + `computed` + `state.use()`; extended `subscribe` semantics: fires on exact + ancestor + descendant writes)
- 5.3.1 — Star subscribe machinery (`Subscriptions` class + table at `apps/nebula/src/subscriptions.ts`, `@mesh subscribe`, Handler 1/2 + idempotent inserts; `subscriberBinding` column derived from `callChain.at(-1)?.bindingName`)
- 5.3.2 — Resource-mutation fanout (`Star.#fanout` via `Subscriptions.forResource`, originator exclusion via `clientId`); `Subscriptions.clear()` via `DROP TABLE + CREATE TABLE` wired into `Star.#installState` for deploy-driven subscriber tidy-up; `NebulaClient.onBeforeCall` override to accept Star-mediated fanout
- 5.3.3a — NebulaClient foundation: constructor `ontologyVersion` + `onShouldRefreshUI`, `bindToState(state)` minimal-binding form, `client.resources.subscribe(rt, rid)`, `handleResourceUpdate` writes through to bound state at `resources.{rt}.{rid}.{value, meta}`, subscribe-call coalescing
- 5.3.3b — `client.resources.read(rt, rid)` (requestId correlation + new `handleReadResponse` mesh handler, replacing the removed `handleReadResult`); `client.resources.transaction(ops, options?)` always-resolves with `TransactionResolution`; serial in-flight queue + 10 s timeout; lifted `newETag` to API surface; server-side idempotency short-circuit; widened `TransactionError` with `'permission'` variant; restructured `Resources.transaction` permission checks to collect-not-throw
- 5.3.3c — Conflict-resolver machinery: `client.resources.onETagConflict(rt, resolver, options?)`, per-call override, `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`), recursive `'use-this'` bounded by `maxRetries`, async resolver execution suspends queue timeout
- 5.3.3d — Structured ontology-staleness signal (`OntologyStaleError` + `isOntologyStaleError` in `apps/nebula/src/errors.ts`) replaces the prior message-string-pattern detection; `onShouldRefreshUI` fires on transaction, read, and subscribe paths

### Phase 5.3.0 — Port `@lumenize/state` (prerequisite) ✅ shipped 2026-05-12

Source: [JurisJS `src/juris.js`](https://github.com/jurisjs/juris/blob/main/src/juris.js), lines 138–446 (`StateManager` class) + helpers near the top of the file. The port preserves the JurisJS internal model but with **one deliberate divergence**: the public `subscribe()` semantics are extended to fire on exact + ancestor + descendant writes (see Gotchas). The rest is mechanical — normalize style to Lumenize conventions.

- [x] New package `packages/state/` (MIT) — `@lumenize/state`
- [x] Exports: `StateManager` class + `createState(initialState?, middleware?)` factory. **No default singleton** — preserves the option of multiple instances (mirrors NebulaClient's "one per page but two-instances has use cases" stance), and avoids cross-test pollution. Studio bootstrap constructs at module top-level.
- [x] Port `StateManager` (~310 LOC) — `getState`, `setState`, `subscribe` (extended — see Gotchas), `track` + `deps`, `executeBatch` (keep Promise-callback support — adds ~10 LOC, useful when integration-layer optimistic writes touch multiple paths atomically), middleware list, `#hasCircularUpdate`, `#notifySubscribers`, `#triggerPathSubscribers`
- [x] Port top-level helpers (~30 LOC) — `isValidPath`, `getPathParts`, `deepEquals`
- [x] **Drop from the port:** `subscribeExact` (no current caller), `subscribeInternal` (its descendant-fire behavior folded into the single public `subscribe`), `reset()` (tests get a clean slate via a fresh `createState()` — add back with `structuredClone` if any Juris internals we ported call into it), `createPromisify` (async-prop machinery out of scope per the inventory)
- [x] Add `state.use(middleware): () => void` for post-construction middleware install/remove (returns the remove fn). Constructor still accepts an initial middleware array for symmetry. Required because `bindToState` installs its middleware after `StateManager` construction.
- [x] Add `state.computed(targetPath, fn): () => void` — user-facing derived-state API. Uses `track()` internally; subscribes to collected deps; re-runs and re-tracks on dep change. Returns dispose function. **Error model**: at registration, walk deps once and if `targetPath` appears among them, throw a `ComputedSelfReferenceError` immediately. Runtime throws inside `fn` → `console.error` and retain prior value (don't break the computed; the next dep-change re-runs `fn` and may recover).
- [x] Types: `getState`/`setState` typed with `unknown` values; call sites cast. The store has no schema — typing values stronger would lie.
- [x] Replace `createLogger` calls with `@lumenize/debug`
- [x] Normalize `_underscore` privates to `#hash` per CLAUDE.md, except where cross-class access requires public
- [x] Tests in `packages/state/test/` — vanilla vitest in Node mode (pure-JS package, no Workers pool needed). Cover `getState`/`setState`/`subscribe` (all three fire directions — exact, ancestor write, descendant write — per Gotchas)/`executeBatch` (sync + Promise callback)/`use` (add + remove)/`computed` (happy path, self-ref-at-registration throws, runtime fn-throw retains prior value)

**Gotchas — easy to lose if you only port the obvious-looking API:**

- **`subscribe(path, callback, hierarchical = true)` — extended semantics, deliberate divergence from JurisJS.** Juris's external `subscribe()` only fires on exact + descendant writes (write to `'a.b.c.d'` notifies subscribers on `'a.b'` or `'a.b.c'`); the inverse direction (write to `'a.b'` notifies subscribers on `'a.b.c.d'`) only happens via `subscribeInternal` and its descendant-walk inside `#notifySubscribers`. **In `@lumenize/state` the single public `subscribe()` fires on all three:** exact, ancestor writes (bulk-snapshot push case — `handleResourceUpdate` writes the whole `.value` and a directive bound at `.value.title` must fire), and descendant writes (granular field-change case — `setState` on `.value.title` and any directive bound on `.value` or `.value.title` must fire). Deep-equals dedup (next bullet) keeps the cost of the extended semantics in check. Verification: register a subscriber at `'a.b.c'`; write at `'a.b.c'` (exact) → fires; write at `'a.b'` (ancestor) → fires; write at `'a.b.c.d'` (descendant) → fires.
- **Deep-equals dedup inside notify.** Without it, every parent-level write would re-fire every descendant subscriber. The JurisJS implementation deep-equals-compares each descendant subscriber's tracked value against the previous one and skips no-op fires. Preserve this — without it, bulk snapshots would cause storms of redundant subscriber callbacks. Verification: write a parent path with one field changed; assert only that field's subscriber fires.
- **`track()` collects deps as a side effect.** Inside `getState(path, default, track = true)`, the third parameter defaults to `true` and pushes `path` into the currently-active `deps` set on `this`. `track(fn)` is what installs that set. Reactive update mechanisms (and `computed`) all rely on this implicit collection. Preserve the side-effect semantics; don't refactor to explicit dep declarations.

### Phase 5.3.1 — Star subscribe machinery ✅ shipped 2026-05-12

- [x] New file `apps/nebula/src/subscriptions.ts` — `Subscriptions` class mirroring DagTree/Resources injection pattern (constructor: `ctx`, `getCallContext`, `dagTree`, `resources`). Owns its own SQL schema. Star instantiates in `onStart()` alongside the others.
- [x] `Subscribers` table created via `CREATE TABLE IF NOT EXISTS` in Subscriptions constructor (revised PK + columns per Subscriber storage section above)
- [x] `@mesh()` `subscribe(ontologyVersion, resourceType, resourceId)` method on `Star` with Handler 1 / Handler 2 pattern (mirrors `transaction` / `read`)
- [x] Handler 2 (`doSubscribe`): ontology version check → call `Subscriptions.subscribe(rt, rid, clientId, subscriberBinding)` → push initial snapshot via `handleResourceUpdate`
- [x] `Subscriptions.subscribe()` performs: DAG read-permission check via `Resources.read()`, resource-existence check (error if not found — `subscribe-before-create` deferred per Phase -1 § 5 → revisit if a use case emerges), resource-type-mismatch check (error if `snapshot.meta.typeName !== resourceType`), `INSERT OR REPLACE` row (idempotent on `(resourceId, clientId)`)
- [x] `Subscriptions.forResource(resourceId)` returns all subscriber rows for a resource (used in Phase 5.3.2 fanout — set up the lookup primitive now)
- [x] `handleResourceUpdate(resourceType, resourceId, snapshot: Snapshot | null | Error)` stub added to `NebulaClient` (later replaced in Phase 5.3.3a with the real write-through-to-bound-state implementation). Errors delivered via the third arg, not via throws — Handler 1/2 is **non-awaited round-trip RPC** (mesh's `lmz.call` shape — see CLAUDE.md), so explicit error-as-data through the same callback is the correlation mechanism. Snapshot passes through with `meta.deleted` intact when applicable.
- [x] `subscriberBinding` stored from `callContext.callChain.at(-1)?.bindingName` (not hardcoded — the column exists exactly for routing flexibility, including future DO-to-DO subscribers, not just gateway-fronted clients)
- [x] Test-app additions in `apps/nebula/test/test-apps/baseline/`: `callStarSubscribe(starName, ontologyVersion, rt, rid)` initiator on `NebulaClientTest`; `handleResourceUpdate` override that captures `(rt, rid, result)` for assertions.
- [x] Tests in `apps/nebula/test/test-apps/baseline/star-subscribe.test.ts`: subscribe to existing resource → initial snapshot delivered; subscribe to non-existent → error; subscribe with stale `ontologyVersion` → ontology-mismatch error; subscribe without read permission → permission error; re-subscribe `(clientId, rt, rid)` is idempotent (single row); subscribe with mismatched `resourceType` → error.

### Phase 5.3.2 — Fanout on mutation + deploy-driven subscriber clear ✅ shipped 2026-05-12

- [x] `#onChanged` replaced with subscriber lookup + per-subscriber `lmz.call` to NEBULA_CLIENT_GATEWAY
- [x] BroadcastChannel semantics: originator's `clientId` excluded
- [x] Snapshot deletion pushes the post-delete `Snapshot` with `meta.deleted: true` (not `null`) — per the Phase 5.3.1 Q3 decision: deletions are soft and the snapshot remains the source of truth; clients inspect `meta.deleted` rather than receiving a sentinel
- [x] Fanout triggers are upsert and delete only — migration does NOT fan out (deploys + lazy ontology model + `onShouldRefreshUI` handle cross-version transitions)
- [x] Branch-aware subscription routing: subscriptions are branch-local (each branch = independent Star instance per `tasks/nebula-branches.md`); verify the wiring doesn't assume single Star per `{u}.{g}.{s}`
- [x] `Subscriptions.clear()` method — `DROP TABLE IF EXISTS Subscribers; CREATE TABLE …` in sequence (the latter is identical to the constructor's schema). Drop-then-recreate is a single billed write per CLAUDE.md's storage cost model; `DELETE FROM Subscribers` would be billed per-row plus per-index. The constructor's `CREATE TABLE IF NOT EXISTS` won't auto-recreate the table mid-operation, so the recreate happens inline.
- [x] `Star.#installState()` calls `this.#subscriptions.clear()` after writing the new ontology row. Any pre-existing subscription was registered by a stale-version client; dropping is unambiguous. This is the **primary tidy-up mechanism** — Phase -1 § 5 collapses the alarm-sweep / `subscribedAt`-TTL ideas into this single deploy-driven event.

### Phase 5.3.3 — NebulaClient handlers + `client.resources.*` API ✅ all sub-phases shipped 2026-05-12

Split into four sub-phases (a/b/c/d) decided 2026-05-12 so each lands testable on its own. Drop the no-longer-applicable `client.resources.subscribe(rt, rid, statePath?)` override — entire-resource-at-a-time addressing only.

#### Phase 5.3.3a — Foundation (subscribe + StateManager write-through) ✅

- [x] Constructor gains `ontologyVersion: string` (auto-attached to every `client.resources.*` call) and `onShouldRefreshUI?: (info) => void` (no default — undefined = opted-out)
- [x] `registerStateStore(state: StateManager): void` — minimal binding to a StateManager so `handleResourceUpdate` knows where to write. Full `bindToState` (refcount + middleware + grace-period) is Phase 5.3.6; this is the load-bearing slice.
- [x] Local subscription registry: `Map<resourceKey, { /* future: statePath, refcount, etc. */ }>` keyed by `${rt}:${rid}`. First-pass content can be minimal — used by 5.3.4's auto-resubscribe and 5.3.6's refcount.
- [x] `client.resources.subscribe(rt, rid): Promise<Snapshot | null>` per the (now-finalized) signature. The Promise settles on first `handleResourceUpdate` for `(rt, rid)`.
- [x] `handleResourceUpdate(rt, rid, snapshot)` writes through to bound StateManager: **single atomic `setState('resources.{rt}.{rid}.value', snapshot.value)` + `setState('resources.{rt}.{rid}.meta', snapshot.meta)`**. JurisJS's hierarchical-notify-with-deepEquals (5.3.0 port) gates redundant deep-binding fires. No per-field diffing on the client.
- [x] Tests in baseline: client A subscribes → client B mutates → A's bound StateManager has the new value at `resources.{rt}.{rid}.value.*`; verify path-level reactivity (subscribe to `.title` only fires when title actually changes despite whole-value writes).

#### Phase 5.3.3b — Read + Transaction (happy path + queue + timeout) ✅

- [x] **`client.resources.read(rt, rid): Promise<Snapshot | null>`** — generates `requestId = crypto.randomUUID()`, calls `Star.read(ontologyVersion, rt, rid, requestId)`, registers `{resolve, reject}` in `Map<requestId, ...>`. New internal mesh handler **`@mesh() handleReadResponse(requestId, result: Snapshot | null | Error): void`** on NebulaClient settles the Promise. Drops the old `handleReadResult` entirely.
- [x] Star-side: add `requestId` param to `Star.read` Handler 1/2, thread through `doRead`'s callback. Update `apps/nebula/src/star.ts` and the `NebulaClientTest` test helpers.
- [x] **`client.resources.transaction(ops, options?): Promise<TransactionResolution>`** — **always resolves**, never rejects (infrastructure failures still throw `Error`). See `TransactionResolution` type in § Types. Caller switches on `outcome.resolution`.
- [x] **Hoist `newETag` to the transaction level**: client generates ONE `newETag = crypto.randomUUID()` per `transaction()` call. `Star.transaction(ontologyVersion, newETag, ops)` accepts it as a top-level arg. The server uses it for every resource's write. Per-resource `eTag` (old) stays on each `OperationDescriptor`. This matches what `resources.ts:280` already does internally (one eTag per transaction) — just lifts it to the API surface and to client-side generation per the idempotency requirement.
- [x] Serial in-flight transaction queue: at most one in flight; subsequent calls queue. Correlation = serial-queue-by-construction (no requestId needed for transactions, only for reads). 5–10 s timeout from submission → resolve in-flight Promise with `{ resolution: 'timeout' }`, dequeue next.
- [x] Server-side: widen `TransactionError` to include `{ type: 'permission'; requiredTier: PermissionTier; nodeId: number }` — currently permission failures throw and become generic `Error` at the client. Catch `requirePermission` throws inside the per-resource permission-check loop in `resources.ts`; convert to typed `TransactionError`. NebulaClient maps to `{ resolution: 'permission-denied', resources }`.
- [x] Idempotency: server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns a `committed` result. Add this short-circuit in `resources.ts`'s transactionSync block.
- [x] Tests: happy-path transaction (`committed`), sequential transactions queued and applied in order, timeout (no server response in 5–10s → `'timeout'`), idempotency probe (drop response client-side, retry with same `newETag` → idempotent `committed`).

#### Phase 5.3.3c — Conflict-resolver machinery ✅

- [x] `client.resources.onETagConflict(resourceType, resolver, options?)` per-type registration; per-call override via `options.onETagConflict` on `transaction()`. Precedence: per-call > per-type > framework default (`{ resolution: 'use-server' }`).
- [x] `ConflictResolution` discriminated union with recursive `'use-this'` bounded by `maxRetries` (default 5). On cap, transaction resolves with `{ resolution: 'retries-exhausted', attempts }`.
- [x] `'use-server'` resolver verdict → write `server.value` to bound state, transaction resolves with `{ resolution: 'use-server', resources }`.
- [x] `'human-in-the-loop'` resolver verdict → transaction resolves with `{ resolution: 'human-in-the-loop', resources }`; optimistic state stays painted.
- [x] Resolver execution suspends queue timeout; fresh timeout starts on each post-resolver re-submission.
- [x] **Deferred to 5.3.6**: `context.bindings: Map<path, HTMLElement[]>` argument to resolver; field-diff flash class on bound elements; bindings registry sourced from `bindDom`. The conflict-resolver-machinery itself works without these — the resolver just receives `context: {}` or `context: { bindings: new Map() }` (empty) until 5.3.6 lands.
- [x] Tests: each of `'use-server'` / `'use-this'` (single retry success) / `'use-this'` (retries-exhausted) / `'human-in-the-loop'` / per-call override / per-type registration / async resolver (verify queue timeout is suspended during await).

#### Phase 5.3.3d — Ontology-staleness signal ✅

- [x] **Star-side**: widen the mismatch path ([star.ts:203-206, 270-273](apps/nebula/src/star.ts:203)) and the corresponding paths in `doSubscribe`. Today they return `new Error('Ontology version mismatch: ...')`. Replace with a structured signal: a typed error subclass or a plain object `{ kind: 'ontology-stale', clientVersion, currentVersion }` delivered via the same handler call.
- [x] **NebulaClient-side**: inspect responses for the staleness signal; dispatch to `onShouldRefreshUI({ clientVersion, currentVersion, reason: 'ontology-stale' })`; settle originating Promise with `{ resolution: 'ontology-stale', clientVersion, currentVersion }`.
- [x] Tests: client constructed with `'v1'`, server now `'v2'` → transaction resolves `{ resolution: 'ontology-stale', ... }` AND `onShouldRefreshUI` fires with matching info.

### Phase 5.3.4 — Reconnect + push-on-clear ontology-staleness detection ✅ shipped 2026-05-12

Two complementary mechanisms cover the cases that Handler-1 lazy detection (5.3.3d) doesn't reach. Handler-1 catches any active client making an op (transaction / read / subscribe). 5.3.4a catches clients that reconnect after a WS drop. 5.3.4b catches connected subscribers at the moment they go stale — without needing a Galaxy-broadcast or per-refresh Galaxy hop. Together, the three mechanisms cover every case except the narrow sliver where (a) a `Subscriptions.clear()` notification is lost in flight AND (b) the client never reconnects AND (c) the client never makes another op. If that sliver becomes a real problem, add the refresh-token-response ontology check as a fourth backstop (deferred — see Phase -1 § 5).

#### Phase 5.3.4a — Reconnect → re-subscribe (network-blip recovery) ✅

- [x] Pass an `onConnectionStateChange` callback to the `LumenizeClient` base from `NebulaClient`'s constructor. Track previous state via a closure variable (not an instance field — `super().connect()` fires the callback synchronously with `'connecting'` before class fields initialize); detect the `reconnecting → connected` transition. User-supplied `onConnectionStateChange` chained.
- [x] On that transition, `#resubscribeAll()` walks `#subscriptionRegistry` and re-calls `Star.subscribe(rt, rid)` for each entry via direct `this.lmz.call(...)` (NOT via `#subscribeResource`, whose coalesce-into-pending path would skip the fresh RTT). Star's `INSERT OR REPLACE` (5.3.1) makes re-subscribe idempotent; `handleResourceUpdate`'s deep-equals dedup makes the redundant initial-snapshot push a no-op for unchanged state.
- [x] **Dedupe-on-pending dropped during implementation** — the original plan was to skip keys with a pending Promise (trust the queued message in `LumenizeClient.#messageQueue` to deliver). Rejected for State C correctness: when a subscribe was sent before the WS drop but the snapshot response was lost in flight, LumenizeClient does NOT re-send already-sent fire-and-forget messages on reconnect, so the pending Promise would hang forever without a fresh subscribe RTT. State B's redundant RTT is acceptable cost for the safety in State C.
- [x] In-flight transactions during disconnect — left as-is (10s timeout resolves with `'timeout'`; app retries via the always-resolve discriminated union; server idempotency short-circuits on `newETag`). Pausing the timer while disconnected is premature optimization.

#### Phase 5.3.4b — Push-on-clear in `Subscriptions.clear()` ✅

The leverage point: when `Star.#installState()` upgrades the cached ontology, it calls `Subscriptions.clear()` which drops the `Subscribers` table. Pre-clear, the rows identify exactly which subscribers go stale at this instant. Send each connected subscriber a direct `OntologyStaleError` push via the existing fanout plumbing, then drop the table.

- [x] `Subscriptions.clear()` returns the distinct `(subscriberBinding, clientId)` pairs that were dropped. Grouping at the SQL layer (`SELECT DISTINCT`) means a client subscribed to N resources counts once, not N times.
- [x] `Star.#installState` iterates the returned pairs after the `transactionSync` block exits, sending one `lmz.call(subscriberBinding, clientId, ctn<NebulaClient>().handleResourceUpdate('', '', new OntologyStaleError('', row.version)))` per pair. Sentinel rt='' / rid='' is harmless — the client's error branch routes `OntologyStaleError` into `#dispatchOntologyStale` regardless of which `(rt, rid)` carried it, and no real pending subscribe is keyed at `':'`. Fire-and-forget; failed sends are tolerable (5.3.4a or Handler-1 will catch them).
- [x] Server-side `clientVersion` is empty (the `Subscribers` row doesn't carry it). Client-side `#dispatchOntologyStale` substitutes `this.#ontologyVersion` when the inbound error's `clientVersion` is falsy — single substitution point covers push-on-clear; the three Handler-1 paths (transaction / read / subscribe) always carry a real client version, so the substitution is a no-op for them. User-facing `OntologyStaleInfo` shape unchanged.
- [x] Triggered exactly once per `#installState` call (the guard `isNewVersion && prevLatest` already in place from 5.3.2 prevents fire on the very first ontology install).
- [ ] Thundering-herd mitigation **not** implemented for demo. Post-demo lever: extend `OntologyStaleInfo` with `refreshWithinMs` and have the framework wrap user `onShouldRefreshUI` in `setTimeout(handler, Math.random() * refreshWithinMs)`. Star sets the jitter window based on subscriber count.

#### Tests (in `apps/nebula/test/test-apps/baseline/`) ✅

- [x] **5.3.4a — `_resubscribeAllForTest`**: client A subscribes via the public API → `#subscriptionRegistry` populated; clear Star's `Subscribers` table via test-only `StarTest.clearSubscribersForTest`; invoke `a.client._resubscribeAllForTest()`; assert (a) `resourceUpdateCount` increments (Star pushed initial snapshot back) and (b) A's row reappears in `Subscribers` with a fresh `subscribedAt`. ([nebula-client-reconnect.test.ts](apps/nebula/test/test-apps/baseline/nebula-client-reconnect.test.ts))
- [x] **5.3.4a — supersede-triggered reconnect smoke**: construct a second client B with A's `instanceName` + `accessToken`; Gateway closes A's socket with `WS_CLOSE_SUPERSEDED` (4409) → A enters `'reconnecting'`; immediately `b.disconnect()` to avoid ping-pong; wait for A to return to `'connected'` and `resourceUpdateCount` to increment (proves the constructor-level state-machine wiring fires the walk). ([nebula-client-reconnect.test.ts](apps/nebula/test/test-apps/baseline/nebula-client-reconnect.test.ts))
- [x] **5.3.4b — grouping + version substitution**: A subscribed to 3 resources at v1; admin appends v2 to Galaxy; A reads with `options.ontologyVersion: 'v2'` to force `Star.#installState`; assert `onShouldRefreshUI` fires exactly once (not 3 times) with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`; assert `Subscribers` is empty. ([nebula-client-push-on-clear.test.ts](apps/nebula/test/test-apps/baseline/nebula-client-push-on-clear.test.ts))

### Phase 5.3.5 — Subscriber cleanup on disconnect ✅ shipped 2026-05-12

Scope narrowed after 5.3.4b push-on-clear shipped: the deploy-driven path is fully handled by `Subscriptions.clear()` + push-on-clear. 5.3.5 is purely for the **"user closes the tab"** case — clean up that `clientId`'s rows so they don't leak across the long tail of session-end events that aren't deploys.

**Implementation pivot during the work**: the originally-planned "alarm-driven cleanup from Gateway" approach turned out architecturally awkward — `NebulaClientGateway` extends `DurableObject` directly (not `LumenizeDO`) per the "zero storage" design, so it has no `this.lmz.call(...)` and would have needed either ~30-50 LOC of envelope construction or direct Workers RPC with a relaxed Star auth guard. Replaced with **drop-on-failed-fanout** (already noted in Phase -1 § 5 as a deferred option): when `Star.#fanout`'s `lmz.call` to a subscriber's Gateway returns `ClientDisconnectedError` (post-grace), the handler deletes that row inline. ~15 LOC. Trade-off: cleanup is **reactive** (next fanout attempt to that resource) rather than proactive (at grace-period expiry). Quiet resources leak rows until the next deploy's push-on-clear catches them — acceptable for demo and likely beyond.

- [x] **Add `Subscriptions.removeSubscriber(resourceId, clientId)`** ([apps/nebula/src/subscriptions.ts](apps/nebula/src/subscriptions.ts)) — PK-targeted `DELETE WHERE resourceId=? AND clientId=?`. No secondary-index gymnastics; single billed write. Replaces the originally-planned `clearForClient(clientId)` since drop-on-failed-fanout already knows the exact `(resourceId, clientId)` pair from the fanout iteration.
- [x] **Add `Star.onFanoutDelivered(resourceId, clientId, result)` handler** ([apps/nebula/src/star.ts](apps/nebula/src/star.ts)). Fires when a `#fanout` `lmz.call` settles. If `result instanceof Error && result.name === 'ClientDisconnectedError'` → `this.#subscriptions.removeSubscriber(resourceId, clientId)`. Other errors (transient network, Gateway misbehavior) are NOT cleaned up — over-eager deletion would over-cleanup. Success path is a no-op.
- [x] **Wire `#fanout` to pass the handler continuation** ([apps/nebula/src/star.ts](apps/nebula/src/star.ts)): `lmz.call(binding, clientId, remote, this.ctn().onFanoutDelivered(resourceId, sub.clientId, remote))`. Mesh framework's `setupFireAndForgetHandler` ([lmz-api.ts:174-187](packages/mesh/src/lmz-api.ts:174)) drives the handler when the underlying promise resolves or rejects — including with `ClientDisconnectedError` from the disconnected client's Gateway.
- [x] **Test grace-period override via env binding** `LUMENIZE_MESH_GRACE_PERIOD_MS` ([packages/mesh/src/lumenize-client-gateway.ts:112](packages/mesh/src/lumenize-client-gateway.ts:112)). Set to `'100'` in the baseline miniflare bindings ([apps/nebula/vitest.config.js](apps/nebula/vitest.config.js)) so the Gateway's `__executeOperation` flips from grace-wait to immediate `ClientDisconnectedError` in well under a second. Production-safe (env binding only set in test config).
- [x] **Originally-planned `Star.cleanupSubscriber` mesh method NOT implemented** — drop-on-failed-fanout doesn't need it. The auth guard concern that motivated the explicit `bindingName === 'NEBULA_CLIENT_GATEWAY'` check disappears too: only Star itself triggers the cleanup, in response to Gateway-returned errors.

#### Tests (in `apps/nebula/test/test-apps/baseline/`) ✅

- [x] **Disconnected subscriber row dropped on next fanout attempt** ([nebula-client-disconnect-cleanup.test.ts](apps/nebula/test/test-apps/baseline/nebula-client-disconnect-cleanup.test.ts)): clients A and B subscribe to resource R (2 rows); disconnect B; wait past grace (500 ms with grace=100 ms); A mutates R; assert B's row is gone, A's row remains.
- [x] **Success path is a no-op**: same setup but B stays connected; A mutates; B receives fanout (resourceUpdateCount bumps); both rows still present.

### Phase 5.3.6 — `client.bindToState(state)` integration + `@lumenize/ui` bindDom

#### bindToState (NebulaClient)

- [ ] `client.bindToState(state, options?)` registers `setState` middleware on `state` watching `resources.{rt}.{rid}.*`
- [ ] Optimistic-write flow: middleware reads `eTag` via `state.getState('resources.{rt}.{rid}.meta.eTag')`, packages with fresh `newETag`, submits via `client.resources.transaction()`
- [ ] Auto-subscribe reference counting (`Map<resourceKey, count>`): 0→1 → `subscribe`; count→0 → schedule `unsubscribe` after `unsubscribeGraceMs` (default 2000); new binding during grace cancels
- [ ] Connection-state surfacing: write `lmz.connection.state` (string) and `lmz.connection.connected` (boolean) on every transition; write `lmz.connection.lastConnectedAt` (timestamp ms) on each `'connected'` transition. **Wiring point already exists from 5.3.4a**: NebulaClient's constructor passes a wrapping `onConnectionStateChange` to LumenizeClient that already runs internal logic (reconnect re-subscribe) before chaining to the user-supplied callback. 5.3.6 inserts a third layer between those two that writes through to `state` via the bound StateManager.
- [ ] Optimistic-write rollback on terminal failure: `bindToState` consumes the `TransactionResolution` and on `'validation-failed'` / `'permission-denied'` / `'ontology-stale'` / `'timeout'` rolls back the optimistic state at affected paths to last-confirmed. (`'use-server'` writes the server's value via the existing handleResourceUpdate path; `'committed'` updates eTag in `.meta`; `'human-in-the-loop'` keeps optimistic painted; `'retries-exhausted'` rollback policy is a UX choice — default to rollback.)

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
- [ ] `'use-server'` resolution: loser's resolver returns `{ resolution: 'use-server' }`; framework `setState`s server value; transaction Promise resolves with `{ resolution: 'use-server', resources }`
- [ ] `'use-this'` resolution: loser returns `{ resolution: 'use-this', value }`; framework submits new transaction with `eTag = server.meta.eTag`. Verify recursion: second submission also conflicts → resolver fires again → eventually succeeds (Promise resolves with `{ resolution: 'committed', eTag }`).
- [ ] `maxRetries` exhaustion: resolver always returns `'use-this'`, every submission conflicts; after default 5 attempts, transaction Promise resolves with `{ resolution: 'retries-exhausted', attempts: 5, resources }`
- [ ] `'human-in-the-loop'`: resolver returns the handoff; transaction Promise resolves with `{ resolution: 'human-in-the-loop', resources }`; optimistic state stays painted (NOT overwritten); no new transaction; test then manually submits follow-up
- [ ] Per-call override: `transaction(ops, { onETagConflict: customResolver })` overrides per-type registered resolver for that call only
- [ ] Idempotency probe: drop a transaction response (test-only); client retries with same `newETag`; server returns idempotent success without duplicate
- [ ] `client.resources.read(rt, rid)` returns current snapshot without writing to bound state
- [ ] Staleness probe: client constructed with `'v1'`, server now `'v2'`; transaction → `onShouldRefreshUI` fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`
- [ ] Connection-state probe: trigger LumenizeClient connection events programmatically; assert `lmz.connection.state` / `lmz.connection.connected` / `lmz.connection.lastConnectedAt` paths update correctly on each transition
- [ ] Permission-denied probe: attempt a write the user isn't authorized for; transaction Promise resolves with `{ resolution: 'permission-denied', resources }`; optimistic state rolls back to last-confirmed
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
4. **Subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy** — when Studio deploy changes guards/ontology, do existing subscribers get re-evaluated? **Resolved 2026-05-12**: all invalidated on deploy. `Star.#installState()` clears the `Subscribers` table via `DROP TABLE + CREATE TABLE` (one billed write). Clients re-subscribe naturally on the post-deploy page reload. Details in Phase -1 § 5 and Phase 5.3.2 / 5.3.4 checklists.
5. **Subscription identifier** — does `(clientId, resourceType, resourceId)` uniquely identify a subscription, or need generated `subId` for multi-tab same-client? `instanceName` of the Gateway should already disambiguate.
6. **Mesh-framework Promise correlation for `client.resources.read()`** — **Resolved 2026-05-12 in Phase 5.3.3b** via option (b) "hidden plumbing handler": client generates `requestId = crypto.randomUUID()` per call, threads through `Star.read(ontologyVersion, rt, rid, requestId)`, server delivers via new internal `@mesh() handleReadResponse(requestId, result)` on NebulaClient, which settles a `Map<requestId, {resolve, reject}>` entry. The earlier `handleReadResult` was removed entirely. Transactions don't need correlation thanks to the serial in-flight queue (5.3.3b).
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

5. **Subscriber tidy-up + deploy-driven re-subscribe (resolved 2026-05-12).** This was originally drafted as "stale-subscriber tidy-up (leaked rows in `Subscribers`)" with an alarm-sweep sketch. The thinking evolved into a tighter design that collapses tidy-up with Open Question 4 ("subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy") — **deploys ARE the cleanup event**.

   **Three-mechanism cleanup model:**

   1. **Active WebSocket close** (Phase 5.3.5) — Gateway sees WS close, notifies Star, drops that `clientId`'s rows. Handles ~99% of cases cleanly.
   2. **Ontology-install clear** (Phase 5.3.2 — primary) — `Star.#installState()` calls `Subscriptions.clear()` which does `DROP TABLE IF EXISTS Subscribers; CREATE TABLE …`. Single billed write (vs `DELETE FROM Subscribers` which is billed per row + per index). Every Studio deploy thus wipes the registry; connected subscribers also receive an in-band `OntologyStaleError` push via push-on-clear (5.3.4b) before the rows drop, so a refresh happens promptly without waiting for the next op.
   3. **Drop-on-failed-fanout (deferred — may never be needed)** — Star catches "client unknown" errors from `lmz.call(subscriberBinding, clientId, …)` during fanout and inline-deletes the row. Reactive cleanup for the rare edge case where (1) and (2) both miss. Probably unnecessary given (1) + (2) coverage and the storage cost of leaked rows is trivial; revisit only if a production deployment exposes a path that escapes both.

   **Passive-subscriber detection** (Phase 5.3.4b — push-on-clear, **replaces the original refresh-token-response design**): before `Subscriptions.clear()` drops the rows, iterate distinct `(subscriberBinding, clientId)` and send each connected subscriber a single `OntologyStaleError` via the existing fanout plumbing. NebulaClient routes that into `onShouldRefreshUI`. Detection latency is **immediate** for connected subscribers — no Galaxy hop, no TTL cache, no per-refresh ontology check needed.

   **Original "refresh-cycle ontology check" design retired** — the NebulaAuth → Galaxy hop, response-body `currentOntologyVersion` field, and TTL cache were the answer to a problem we can solve more cheaply at the source. Push-on-clear + 5.3.4a reconnect + Handler-1 lazy detection cover the practical cases. If a real workload ever exposes the narrow sliver where (a) the push-on-clear notification is lost in flight AND (b) the client never reconnects AND (c) the client never makes another op, revisit the refresh-cycle backstop.

   **What was rejected and why:**
   - **`subscribedAt`-based alarm sweep**: rejected. Auto-reconnecting WebSockets mean a row created hours/days ago can still be perfectly valid as long as the underlying client session is alive — `subscribedAt` is "row birthday," not "last-proven-alive." The earlier "5 days + quiet resource" heuristic had the same flaw.
   - **`validFrom > N days` on the resource**: rejected. Quiet doesn't mean unwatched; a TV-mounted dashboard listening to a rarely-changing config resource is the canonical counterexample.
   - **`snapshot.meta.deleted`**: rejected. Subscribing to deleted resources is legitimate (history view, undo-redo UX, audit-trail UIs).
   - **Galaxy WebSocket broadcast on version bump** (sub-second detection): rejected for demo and likely post-demo too. Two reasons: (a) substantial plumbing — Galaxy needs a registry of all connected Gateways, a push frame protocol, mesh fanout machinery; (b) **thundering herd** — every connected client across every Gateway re-subscribes simultaneously the instant the broadcast lands. The 15-min refresh-cycle approach naturally spreads re-subscription over a window. Sub-second detection isn't worth either cost.

   **`subscribedAt` column reframed**: kept in the schema as forensic/debug metadata ("when did this subscription start?"), explicitly NOT a staleness signal. Cheap to store (DO storage bills per row, not per column) and worth keeping for debugging until a real reason to drop it emerges.

   **Caveat to monitor**: dropping all subs on every ontology install means clients re-pay subscribe RTT after every deploy. With small fanout and Studio-cadence deploys (probably hours-to-days apart), the cost is negligible. If rapid-iteration Studio workflows ever push deploys into the minutes-per-deploy range, the re-subscribe churn could become visible to users. Add a re-subscribe-batch-debounce at that point.

   **Status**: tidy-up + Open Q4 both resolved into Phase 5.3.2 (server-side install-time clear) + Phase 5.3.4 (client-side refresh-cycle detection). Remaining: implementation in those phases. Drop-on-failed-fanout stays as a Phase -1 idea, not on any checklist.

6. **Lifecycle hooks — surface area to be designed.** The framework already has *internal* lifecycle events: MutationObserver-driven binding registration/unregistration, refcount-based auto-subscribe / unsubscribe-with-grace, connection-state transitions surfaced at `lmz.connection.*`, conflict-resolver invocation, deploy/staleness signal. None of these are currently exposed as *user-facing hooks* an app developer (or a Studio-generated component) can register a callback against. Worth a triage pass before Phase 5.3.6 ships, since `bindDom` is the natural attachment point.

   Candidate hook points to consider:
   - **Per-element / per-binding**: `x-on:mount` / `x-on:unmount` — fires when a directive-bearing element enters/leaves the DOM tree the crawler is observing. Distinct from `x-on:click` etc., which are real DOM events. Useful for: starting a timer when a card mounts, releasing a resource handle when it unmounts, focusing an input on appearance.
   - **Per-component-instance** (depends on `x-component` shape from 2026-05-12 work): `onMount(scope)` / `onUnmount(scope)` lifecycle declared inside the component definition, receiving the same `{ $local, $node, $trail, ... }` scope handlers get. Pairs naturally with `$local` initialization — today there's no clear answer for "set `$local.expanded = false` exactly once on first mount."
   - **Per-resource-subscription**: `onSubscribed(rt, rid, snapshot)` / `onUnsubscribed(rt, rid)` callbacks the integration layer fires when refcount transitions through 0↔1 (and the actual server round-trip completes/cancels). Today these are silent.
   - **Per-transaction**: `onSubmitted` / `onCommitted` / `onConflicted` / `onRolledBack` — granular hooks beyond the existing single Promise resolution. Probably overkill; most apps don't need this granularity, and the Promise + per-type `onETagConflict` already covers the conflict path.
   - **Auth / scope transitions**: `onScopeChange(prev, next)` — fires when `activeScope` changes (branch switch, tenant switch). Today `bindToState` writes connection state to `lmz.connection.*`, but scope transitions are silent.
   - **Whole-`bindDom` lifecycle**: `onReady` (initial subtree walk + initial subscribe RTTs all resolved — useful for a splash-screen `x-if`), `onError` (unhandled framework error).

   Cross-cutting concerns:
   - **Where do they live?** Element-scoped → `@lumenize/ui` (`x-on:mount` etc., plus component-definition syntax). Resource/transaction → integration layer (`bindToState` options or `client.resources.on*` methods). Auth → `NebulaClient` constructor options or event emitter.
   - **Sync vs async**: most hooks should be best-effort sync callbacks. `onUnmount` specifically must complete *before* the binding refcount decrements (otherwise unsubscribe races with cleanup that needs the subscription).
   - **Error containment**: hook throws should `console.error` and continue, mirroring middleware / subscriber-throw isolation already in `@lumenize/state`. Never let a user-supplied hook take down the framework.
   - **Composability with `x-for`**: each iteration's clone is its own "mount" — does `x-on:mount` on a `<template x-for>`-hosted element fire per-iteration? (Probably yes — that's the useful semantic.)
   - **MutationObserver grace-period interaction**: if an element is "moved" (removed + re-added in same task), the microtask-deferred unregister logic skips the unmount. `x-on:unmount` should match — fire only on *actual* removal, not on moves.

   **Triage**: think before designing. The 2 s grace period + refcount semantics in 5.3.6 already give us *internal* mount/unmount events; question is which to expose. Minimum-viable surface for the demo is probably: `x-on:mount` + `x-on:unmount` on elements, and component-level `onMount` / `onUnmount` for per-instance setup (especially for `$local` initialization, which is currently underspecified). Defer auth/scope hooks, per-transaction granularity, and `onReady` unless a Studio template genuinely needs them.

   **Outcome destination**: resolve in this file before Phase 5.3.6 design-finalizes; the answer affects `bindDom`'s option surface and the `x-component` directive grammar in `coding-your-ui.md`. If the design space turns out larger than expected, split into its own task file (`tasks/lumenize-ui-lifecycle.md`).

7. **DAG-tree-as-special-resource (reactive DAG binding).** The DAG tree is conceptually a resource — clients eventually want to bind UI to it (`x-text="resources.lmz.dag.value.nodes['42'].label"`, tree-view directives, reactive permission badges). The cleanest design **reuses the resource-subscribe plumbing** rather than building parallel `client.dag.subscribe()` / `handleDagUpdate()` / a separate `DagSubscribers` table — the whole consolidation work in 5.3.1 (one Subscribers schema, one fanout path) was about not making exactly that mistake.

   **Framing**: reserve a fixed framework resourceId — likely `('lmz', 'dag')` under the `lmz.*` reserved prefix — so the DAG appears at `resources.lmz.dag.value` in client state and uses the same `client.resources.subscribe('lmz', 'dag')` API.

   **What lines up for free**:
   - `Subscribers` table is `(resourceId, clientId)` — agnostic to resource shape.
   - `DagTree.#onChanged` already fires on every mutation (today routed to `Star.#onDagChanged()`, a no-op). Repoint it at `Star.#fanout` with a synthesized `Snapshot` and DAG fanout works.
   - Path-based reactivity, refcount auto-(un)subscribe, MutationObserver lifecycle, conflict-resolver semantics, all the integration-layer plumbing — no changes needed.
   - **Permission check at subscribe time goes away**: per project decision, *everyone sees the whole DAG* (restricting visibility would block workflows like "request permission to see resources attached to this node"). So the synthetic DAG resourceId can skip the `Resources.read(resourceId)` perm check entirely — no need for `ROOT_NODE_ID`-proxy or "DAG-tree-level read assumed" gymnastics.

   **What needs synthesis** (~20–30 LOC, contained):
   - **`Snapshot` shape for DAG**: `value = dagTree.getState()`, `meta.eTag = crypto.randomUUID()` per mutation (or monotonic counter), `meta.typeName = 'DagTree'`, `meta.validFrom = new Date().toISOString()`, `meta.deleted = false`. The type-mismatch guard in `Subscriptions.subscribe` needs either a special-case skip for framework-reserved resourceIds (`lmz.*`) or `'DagTree'` registered as a real ontology type. Special-case skip is the cleaner choice — keeps ontology storage focused on application resources.
   - **`#onChanged` rewire**: `() => this.#fanout(new Map([['dag', synthesizedDagSnapshot]]), originatorClientId)`. The originator's `clientId` is available from `this.lmz.callContext.callChain[0]?.instanceName` at the mutation site, same plumbing as `Resources.transaction`'s onMutations callback.

   **What needs design at scale** (the actually-load-bearing concern):

   Payload size on every DAG mutation is the dimension to optimize. Demo-scale (hundreds of nodes, ~10 subscribers): full-tree-per-mutation is fine. Production-scale (thousands of nodes, hundreds of concurrent users on a Star): full-payload fanout becomes expensive — each mutation broadcasts the whole tree to everyone. Four alternatives, ordered from least to most ambitious:

   **Option 0 — Full-snapshot fanout (demo default).** Every mutation fanouts the entire `DagTreeState` to every subscriber. Cost scales as O(nodes × subscribers) per mutation. Acceptable for ≤ ~1k nodes × ~50 subscribers. No additional plumbing.

   **Option A — eTag-bump-and-pull (simplest scale-out).** Fanout sends only `{ meta: { eTag: 'new-uuid', typeName: 'DagTree', ... } }` with no `value`. Clients see the eTag changed via state-write-through, call `client.resources.read('lmz', 'dag')`, get current full state, write-through to bound state. **Costs**: cheap fanout (M × eTag_size); on-demand read on each subscriber that cares (M × N, but only for clients that pull). **Wins regime**: when most subscribers re-read anyway, similar to Option 0; when many don't care about every mutation, much cheaper. **API impact**: none — clients see the same `handleResourceUpdate`. Ship-when-needed.

   **Option B — Op-broadcast (DAG-specific, wire-efficient).** DAG mutations are well-defined ops (`createNode`, `addEdge`, `reparentNode`, `setPermission`, etc.). Server applies the op and broadcasts the *op itself* (not resulting state). Each client applies the same op to its local DAG copy. The key enabler: `dag-ops.ts` is already a pure functional core with no Cloudflare imports — runs unchanged in the browser. **Cost**: tiny wire payload (one op = a few fields × M subscribers) regardless of DAG size. **Subtleties**:
   - **Trust-server vs trust-client perms**. Fanout from server → trust server (it already perm-checked before broadcasting). Local origin (this client's own mutation) → run perm check locally as fail-fast UX so the user doesn't attempt a doomed op.
   - **Optimistic vs confirmed apply**. Resources use optimistic apply with rollback on conflict. DAG could be either. **Lean toward confirmed-apply for v1**: DAG mutations are infrequent (vs. text-field typing), responsiveness gain is small, rollback complexity gain is meaningful. Per-mutation re-decision later if needed.
   - **Bootstrap ordering**. Subscribe-init delivers full state with a monotonic seq number; fanout ops carry `seq = N+1`. Client verifies no gap; on gap, triggers full-state re-pull (same recovery mechanic as Option A). The op stream is *append-only* — gaps mean missed messages.
   - **API impact**: meaningful. Either `client.resources.subscribe('lmz', 'dag')` returns a polymorphic payload (snapshot OR op-stream — discriminated union widening of `handleResourceUpdate`), or a sibling `client.dag.subscribe()` is added. The latter brings back the "two reactive systems" failure mode 5.3.1 consolidated against — so the polymorphic-payload path is preferred if we go here.

   **Option C — Generic snapshot-diff (broad resources feature, most ambitious).** Compute a structural patch between previous and new snapshot; send the patch. **Cost**: small wire payload (M × diff_size); server must track prev snapshot for diff computation; client must apply patches. **Generality blocker**: DAG state uses `Map<number, ...>` and `Map<number, Map<string, ...>>` — verified at `dag-ops.ts:13`, `dag-tree.ts:87-88`. JSON-Patch (RFC 6902, well-supported, ~150 LOC libs) only covers plain JSON. A full structuredClone-aware patch operator (Maps, Sets, Dates, cycles, aliases) is ~500–1500 LOC plus careful test coverage of all type edges. **When this earns its keep**: only if we *also* pursue field-level transactions (clients send patch instead of full `put`) and patch-based read-sync (clients sync from baseline eTag instead of full re-pull). For DAG-only optimization, it's expensive plumbing for narrow gain — Option B is the better DAG-specific answer. Possibly Phase 7+ scope when transaction-side patch semantics make the cost amortize.

   **Workaround if we ever want Option C just for DAG**: change `DagTreeState` from `Map<number, ...>` to `Record<string, ...>` at the boundary (Map only used internally during traversal). The cached state then becomes plain JSON, and JSON-Patch suffices. But that's an internal DagTree refactor with downstream effects — only worth doing if Option C is the chosen path.

   **Option D — Diff after structured-clone preprocess (revisited from earlier discussion).** A variant of Option C that sidesteps the structuredClone-aware-patch-operator problem by *first* preprocessing the snapshot to pure JSON via `@lumenize/structured-clone`, *then* running JSON-Patch on the preprocessed form. The catch: the preprocessor uses **tuple format** for things like Map entries — `[key, value]` arrays — and standard JSON-Patch treats arrays positionally. A `set('x', 1)` becoming a `set('y', 2)` then a `set('x', 1)` again would diff as full array reorderings rather than meaningful per-entry mutations. To make patches semantically useful we'd have to convert tuple-arrays-as-Map-entries into objects with the keys as object keys (e.g. `{"x": 1, "y": 2}` instead of `[["x", 1], ["y", 2]]`) — losing the ability to round-trip Map's non-string keys cleanly. **Verdict**: cheaper than Option C in pure LOC (reuse existing JSON-Patch lib) but introduces lossiness on Map-with-non-string-keys and requires a custom JSON-shape just for diff purposes. Not obviously better than B (op-broadcast) for DAG, and not obviously better than C (structuredClone-aware diff) as a general feature. Captured here as part of the design space; not currently preferred over A or B for DAG, or over C as a generic capability.

   **Pick-an-option triage**: ship demo with **Option 0**. When (if) a real workload exposes the scale concern, the cheapest follow-up is **Option A** (eTag-bump-and-pull) — minimal new plumbing, no API change. **Option B** is the wire-efficient ceiling and worth a serious look if op-streaming has UX value beyond just size (e.g., showing other users' edits as they happen, animated). **Option C** is the right answer if generic-diff semantics become a broader Lumenize capability — not a DAG-only justification.

   **Phase triage**: don't implement DAG-binding yet. Wait until the Studio demo (or a real app) actually wants a reactive DAG view — at that point Option 0 is small (~30 LOC + one type-check special case in `Subscriptions.subscribe` + the `#onChanged` rewire), and the scale-out decision (A vs B vs C) can be made with concrete UI requirements in hand instead of speculatively. **Outcome destination**: own subsection under Phase 5.3.x when the trigger lands; or fold into a `tasks/nebula-dag-binding.md` if the design grows beyond what fits here.

8. **Multi-resource conflict-resolver semantics (captured 2026-05-12 from Phase 5.3.3c retro).** The Phase 5.3.3c conflict-resolver flow passes the FIRST conflicting resource to the resolver and applies the verdict uniformly. For multi-resource transactions where multiple resources conflict (and especially where they're different types with different registered resolvers), the current behavior is a simplification: only the first-conflict's type-specific resolver fires, and the verdict's `value` (for `'use-this'`) only replaces that one resource.

   **Why deferred**: Studio-generated UIs typically transact one resource at a time (form save → one resource). The per-call `options.onETagConflict` override gives users an escape hatch for explicitly-multi-resource transactions where they want one resolver to cover all. Real-world multi-resource-multi-type-conflict cases haven't surfaced yet.

   **When to revisit**: if a Studio app exposes the friction. Likely shape: collect all conflicting resources by type, invoke each type's resolver once with that type's conflicting set, merge the verdicts. `'use-this'` verdict's `value` would need a per-resource shape (`Record<resourceId, value>`). `'human-in-the-loop'` covering multiple resources is its own UX question (one modal for all? one per resource?). For demo, leave it as a known limitation.

   **Outcome destination**: design pass when a real workload requires it; until then, this Phase -1 entry is the record.

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

# Nebula Frontend

**Status**: Active — demo critical path. Phases 5.3.0 – 5.3.6 shipped 2026-05-12/13; Phase 5.3.7-v2 (prerequisites unblock) shipped 2026-06-03; **next: Phase 5.3.7-v1** (docs-first), then v3 (factory port) → v4 (real-browser harness, builds on `packages/mesh/test/browser/` template) → v5 (doc polish).
**Depends on**: Phase 5.1 (Storage Engine — shipped), Phase 5.2 (Validation/Ontology — shipped).
**Framework target**: Vue 3.5+ with `.vue` SFCs (compiled in the user-local dev Star for dev iteration, in Galaxy for production deploy). *Originally Vue 3 in-DOM mode per [vue-in-dom-spike.md](archive/vue-in-dom-spike.md); pivoted to SFCs 2026-05-15 after [spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md) validated SFC compile in Workers with sub-50 ms global round-trip via user-local dev Stars.*

**Companion docs** — defer to these for the user-facing surface:

- [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — narrative + worked examples
- [website/docs/nebula/api-reference.md](../website/docs/nebula/api-reference.md) — exact-signature contract for `@lumenize/nebula-frontend` + the `client.resources.*` namespace
- [website/docs/nebula/nebula-client.md](../website/docs/nebula/nebula-client.md) — `NebulaClient` overview
- [website/docs/nebula/auth-flows.md](../website/docs/nebula/auth-flows.md) — auth flow sequence diagrams

> **Resuming the work:**
> 1. Read § "Phase 5.3.7" below — the active section.
> 2. v1 (docs-first) finishes coding-your-ui.md + scaffolds api-reference.md. v3 implements the surface those docs lock in.
> 3. Sections above Phase 5.3.7 describe shipped, framework-agnostic mechanics (auth model, ontology-version model, Star subscribe machinery, handlers, transaction-resolution types).
> 4. Spike code lives in `apps/nebula/spike/vue-factory/` — kept until 5.3.7-v3 ports it to `packages/nebula-frontend/`, then deleted (dir name is a historical artifact from the predecessor Alpine spike).

History note: this file consolidates `nebula-5.3-subscriptions.md`, `lumenize-ui.md`, and `nebula-7-client.md` (in `tasks/archive/`). For decision history and pivots, see `git log` on this file and the dated findings JSONs in `tasks/` — this file keeps only final decisions and the remaining work.

## Three layers, clean boundaries

| Layer | Code lives | Knows about |
| --- | --- | --- |
| **Vue 3 reactivity** | `node_modules/vue` (transitive dep) | Itself only. Pure Proxy-based reactivity engine — `reactive()`, `effectScope()`, `getCurrentInstance().scope`, render effects. No Nebula knowledge. |
| **`@lumenize/nebula-frontend`** | `packages/nebula-frontend/` (scaffolded in 5.3.7-v3) | Vue 3 + NebulaClient. Contains: factory (`createNebulaClient`) — outer Proxy wrapper with path-aware middleware + effectScope-tied refcount + synced-state middleware + debouncing (with per-field config consumed from the ontology-derived validator bundle); composables (`useNebula(...)`); `textMerge` helper. UNLICENSED. |
| **NebulaClient** | `apps/nebula/src/nebula-client.ts` → moves to `packages/nebula-frontend/src/nebula-client.ts` in 5.3.7-v3 | Mesh handlers (`handleTransactionResult`, `handleResourceUpdate`), `client.resources.{subscribe, read, transaction, onTransactionResourceResolution, transactionDebounce}` API, ontology version + `onShouldRefreshUI` hook, two-scope auth model, per-type handler invocation, serial transaction queue. |

The factory hooks into Vue's reactivity through three primitives:

- **Outer path-aware Proxy `set` trap** — captures the full write path, runs middleware chain, forwards to Vue's `reactive()`. All writes (v-model, direct property assignment, programmatic) flow through it.
- **`effectScope` + `getCurrentInstance().scope` fallback** — refcounts resource reads per-scope, cleans up on scope dispose. The fallback bridges the Vue 3 quirk where `ReactiveEffect.run()` doesn't activate the owning scope during component renders.
- **`onScopeDispose` via `scope.run(...)`** — registers the decrement callback against the right scope. Component unmount → scope disposes → callback fires → grace period → server `unsubscribe`.

Total ~350 LOC across the factory + debounce + helpers. Vue owns the DOM crawler, directive grammar, MutationObserver lifecycle, per-element binding registry, and per-component scope; our layer is the bridge from Vue's reactivity to NebulaClient's wire protocol. The path-based PUBLIC API surface (`store.resources.<rt>[id].value.<field>`) is preserved by the factory's path-aware outer Proxy — pinned; don't propose path-vs-Proxy as a tradeoff.

## Package picture

| Package | Source | Scope | Status |
| --- | --- | --- | --- |
| `vue` | npm (`^3.5`) | Reactivity engine + in-DOM template compiler + directive grammar (v-*, recursive components, v-model). Transitive dep of `@lumenize/nebula-frontend`. | Used as-is |
| `@lumenize/nebula-frontend` | Written from scratch (factory pattern validated by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md)) | `createNebulaClient(config) → { client, store, ready, use, dispose }` factory + small Vue composables (`useNebula`) + `textMerge` helper. Debounce + per-field config consumed from the ontology-derived validator bundle (no custom Vue directive). ~300 LOC factory + ~50 LOC debounce + helpers. UNLICENSED until Nebula ships externally. NebulaClient ALSO moves here from `apps/nebula/src/` in 5.3.7-v3. | Built in Phase 5.3.7-v3 |
| `vue-router` | npm (`^4`) | URL ↔ component routing, route params, navigation guards. Standard Vue 3 router; pairs natively with Vue 3.5. | Used as-is when routing is needed (Studio-blocking) |

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

Framework-agnostic decisions below. Vue-specific decisions live in the second table under § "Phase 5.3.7".

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Headless mode** **PINNED** | NebulaClient + factory work in Node (vitest) and browser. Factory imports from `@vue/reactivity` + `@vue/runtime-core` (both pure JS, no DOM required for headless tests). | Same factory works in Node/Workers tests as in browser; spike Phase 0a/0b verify this. |
| **API namespace** **PINNED** | `client.resources.{subscribe, read, transaction, onTransactionResourceResolution, transactionDebounce}`. | `subscribe`/`read` collide with too many JS APIs to leave bare. |
| **Subscribe scope** | Single resource `(resourceType, resourceId)`. | Multi-resource subscriptions deferred. |
| **Broadcast path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)`. | Same Handler 1 / Handler 2 plumbing used by `transaction()` and `read()`. |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required); `bindingName` + `instanceName` from `callContext.callChain.at(-1)`. | Subscriptions are user-initiated, not mesh-to-mesh. |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber. | Prevents double-render when originator already updated optimistically. |
| **Guard placement** | DAG read-permission check once at subscribe time, not on each fanout. | Resource-level access doesn't change mid-subscription except via DAG mutation (separate concern). |
| **orgTree visibility = full ACL (deep-review M7, decided 2026-06-11)** | The `('lmz','orgTree')` broadcast carries the **entire** tree — structure AND every node's full `permissions` table (`sub → tier`) — to every client. NOT filtered to the viewer's own grants. | The client resolves "who do I ask for access?" locally (climb to nearest `admin` ancestor, request from that `sub`) with no server round-trip. Risk (higher-permissioned users discoverable as targets) accepted: grant keys are **opaque UUIDs** (no PII — `sub` from `generateUuid()`); the only identifying surface is app-chosen node `label`/`slug`; tenants are segmented and members already share an org. The map is DAG-grants-only — scope admins (`claims.access.admin`) ride the JWT, not the map. Already the runtime behavior (`DagTree.getState()`); M7 was a doc-honesty fix (resources.md previously claimed "only structure is universal"). |
| **Auto-resubscribe on reconnect** | Client maintains local subscription registry; on LumenizeClient `connected` event after `reconnecting`, re-subscribe each entry. | LumenizeClient already auto-reconnects; only need to re-register. |
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. State path is fixed at `resources.{resourceType}.{resourceId}` (the `statePath?` override on subscribe was dropped in 5.3.3a — entire-resource-at-a-time addressing only). | Period-delimited state paths and slash-delimited URLs must be unambiguously interconvertible. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings reactive to bulk-snapshot pushes without spurious re-renders. |
| **Reserved state-path prefixes** | Two top-level prefixes are framework-reserved: `resources.*` (synced resource snapshots — `resources.{rt}.{rid}.value` and `.meta`) and `lmz.*` (everything else framework-owned — connection state, future things). All other top-level segments (`ui.*`, `app.*`, etc.) are app-owned. Framework only touches `resources.*` and `lmz.*`. | Two prefixes, not one. `lmz.resources.*` would be strictly consistent but adds a segment to every directive in every UI — significant ongoing ergonomic cost. `resources.` is short and distinctive enough on its own; `lmz.` covers the rare framework-meta cases. App authors get the rest of the namespace. |
| **`lmz.connection.*` connection-state surfacing** | The factory writes LumenizeClient's connection state to `lmz.connection.*` paths so the UI can bind declaratively. Paths: `lmz.connection.state` (`'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'`); `lmz.connection.connected` (boolean — true iff `state === 'connected'`); `lmz.connection.lastConnectedAt` (timestamp ms, set on each `'connected'` transition). Initial seed values: `'disconnected'` / `false` / undefined. Factory replays the client's current connection state at creation, so creation order is irrelevant (see "Factory before connect → superseded by replay"). | Real-time-sync demos need a visible connection-state indicator. Surfacing as paths on the reactive store makes it declarative: `<div v-show="!store.lmz.connection.connected">Reconnecting…</div>` works without event listeners. Three paths cover common cases (state string for fine-grained display, boolean for show/hide, timestamp for "last synced X ago" UX). |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. | Cleaner than separate `txnId` — no server-side dedupe table, idempotency implicit in the eTag itself. Auto-retry safe across network drops. |
| **Transaction queue** | Serial **per resource** — at most one transaction in flight per `(rt, rid)`; subsequent writes to that resource buffer and submit using the in-flight transaction's resulting eTag. Transactions on other resources are independent (owned by [debounce-serial-queue.md](debounce-serial-queue.md); the shipped 5.3.3b per-client queue is replaced in v3). 5–10 s timeout then resolve the in-flight Promise with `{ kind: 'timeout' }` (queue unblocks). Caller-decided retry. Optimistic local state still paints immediately (the middleware does the optimistic write first, then enqueues) — so the user sees their typing land regardless of queue state. Queue is in-memory only; refresh clears it. **The whole write path (flush + the timeout timer) is connection-gated** (v3, decided 2026-06-11): while `lmz.connection.state !== 'connected'` nothing submits and nothing times out — writes hold and flush on reconnect (in-flight re-submits with the same `newETag`), so a disconnect never rolls back. See [debounce-serial-queue.md](debounce-serial-queue.md) + [factory-conflict-outcome.md](factory-conflict-outcome.md) invariant 10. | Matches human editing speeds; avoids partial-application reasoning. Timeout collapses all "I don't know what happened" failure modes to one signal. Optimistic-paint-then-enqueue means visual responsiveness is unaffected by queue depth. |
| **Handler execution suspends queue timeout** | When the per-type handler returns a Promise from its `'conflict-pending'` branch (async resolver), the 5–10 s queue timeout is suspended until the Promise settles. When the framework submits the next transaction post-resolver, a fresh timeout starts for that submission. No max-duration enforced on the handler itself — a modal can sit open for minutes if the user gets distracted. | The 5–10 s timeout is for "I don't know what happened to this call" cases. During handler execution, the framework knows exactly what's happening — the user has the modal. App-level timeouts on the handler (e.g., "auto-cancel after 30s") are the caller's responsibility via `Promise.race`. |
| **Per-type resource handler** | Single per-type handler registered via `client.resources.onTransactionResourceResolution(rt, handler, options?)`. Per-call override via `options.onTransactionResourceResolution` on `transaction()`. Handler fires once per resource per transaction with a `TransactionResourceResolution`; the same handler does both jobs — return a `ConflictResolverVerdict` from the `'conflict-pending'` branch to drive the chain, and react to terminal branches (`'committed'`, `'use-server'`, `'human-in-the-loop'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) for UX side-effects. Framework defaults: `'conflict-pending'` returns `{ kind: 'use-server' }`; terminal branches do nothing (framework's default flash classes apply automatically). | Single mental model: per-resource concerns are in the handler; per-transaction concerns are at the await-site. Same handler can fire multiple times across `'use-this'` chains. Per-resource granularity means different resources in the same transaction can land at different verdicts. |
| **Default flash classes** | `'committed'` → `lumenize-commit-success` (green outline animation). Rollback outcomes (`'use-server'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) → `lumenize-conflict-revert` (red outline animation). Default duration 1000 ms. Configurable per type via the handler's `options.flashClass` (object with optional `committed` / `rolledBack` keys; `null` for either disables that default) and `options.flashDuration`. `'human-in-the-loop'` and `'conflict-pending'` get no default flash (app owns those visuals). | Symmetric green-success / red-rollback signal without any app code. Field-diff inference means only actually-affected fields flash. App overrides for cases where the default visual doesn't fit. |
| **`ontologyVersion` on every operation** | NebulaClient constructor argument (Studio's bootstrap fills in at build time). Auto-attached to every `client.resources.*` call. `options.ontologyVersion` per-op override for admin scripts. | Lock-step UI/ontology. Star already takes it for Handler 1/2 dispatch. |
| **Staleness signal + `onShouldRefreshUI` hook** | Star's cache-miss-with-mismatch path returns `{ kind: 'ontology-stale', clientVersion, currentVersion }`. NebulaClient dispatches to registered `onShouldRefreshUI` constructor hook (no default — undefined = opted-out). Originating Promise also settles. | Centralized hook for an orthogonal signal that multiple call sites would otherwise each need to inspect. Distinct from earlier-rejected `onStaleVersion` (which was tied to one error path). |
## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` with a `TransactionOutcome` (always-resolves; never rejects). Per-resource detail goes to the per-type `onTransactionResourceResolution` handler. | Transaction-wide: `'ok'`: resolve (handler already fired for each resource); `'ontology-stale'`: resolve (also dispatches to `onShouldRefreshUI`); `'timeout'`: resolve (queue-timer driven); `'infrastructure-error'`: resolve (network/mesh failure wrapped, NOT thrown). Per-resource: handler invoked synchronously inline with each resource's `TransactionResourceResolution`. | Per-resource state writes happen during handler dispatch: `'committed'` → write eTag, default green flash; `'use-server'` → write `server.value` + `meta`, default red flash; `'use-this'` → optimistic write `value`, submit next attempt; `'human-in-the-loop'` → optimistic stays painted, no flash; `'validation-failed'` / `'permission-denied'` / `'retries-exhausted'` → rollback that resource, default red flash. Transaction-wide failures `'timeout'` / `'infrastructure-error'` → rollback ALL optimistic writes for the transaction (but **connection-gated** — neither fires from a mere disconnect; the write path suspends while not `'connected'` and re-submits on reconnect, so a blip never rolls back); `'ontology-stale'` does NOT roll back (page reload via `onShouldRefreshUI` is the expected response). |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves initial-snapshot Promise from `client.resources.subscribe()`; thereafter, broadcast pushes from `Star.#broadcast` | only first call settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `resources.{rt}.{rid}.value` and `meta` to `resources.{rt}.{rid}.meta` |
| `client.resources.read(rt, rid)` | returns `Promise<Snapshot \| null>` | yes — caller `await`s the Snapshot | **none** — caller decides |

The first two are necessarily `@mesh` handlers because Star calls them. The third is a method; its Promise is settled by a hidden plumbing handler (`handleReadResponse(requestId, result)`) keyed on a client-generated `requestId` — see Open Question 6 (resolved 2026-05-12).

UI flow uses `subscribe` for reactive reads. `read` is the explicit-intent escape hatch for ad-hoc / scripting.

## Subscribe semantics

Two flavors of "this thing reacts to data changes," at different layers, doing different jobs:

| Mechanism | Layer | Network? | Purpose |
| --- | --- | --- | --- |
| `client.resources.subscribe(rt, rid)` | NebulaClient | yes — WS round-trip to Star | Tells Star to push snapshots on every change. Inserts row in Star's `Subscribers` table. Invoked automatically by the factory when a Vue component's render-time read of `store.resources.<rt>[<rid>]` increments the per-resource refcount 0 → 1. |
| Vue render effect (template binding) | Vue's reactivity | no — purely in-memory | Vue's compiled render function re-runs when any property the template reads from changes. No separate `subscribe(path, cb)` API surface — reads are *tracked*, writes *trigger*. Wiring is invisible to user code (just write `{{ store.x.y.z }}` and Vue handles the dep tracking). |

`client.resources.subscribe` gets data flowing *into* the local store from server. Vue's render effects bind the DOM *to* that store. **The user never calls either directly** for typical UI work — the factory + Vue cooperate automatically. The `client.resources.subscribe(...)` API is exposed for explicit-intent cases (programmatic data prefetch, headless scripts).

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

It is **NOT a staleness signal.** With auto-reconnecting WebSockets, a row from yesterday can be perfectly valid as long as the underlying session is alive — `subscribedAt` is row birthday, not last-proven-alive (which is why a TTL/alarm sweep was rejected; see Phase -1 § 5 for the cleanup model that replaces it).

**Why `subscriberBinding` (not `gatewayBinding`):** named to support future DO-to-DO subscribers — `lmz.call(subscriberBinding, instanceName, ...)` at fanout time doesn't care whether the binding is `NEBULA_CLIENT_GATEWAY` (today) or another DO class (e.g. a Star subscribing to another Star). The column value is taken from `callContext.callChain.at(-1)?.bindingName` at subscribe time. Note: a DO-to-DO subscriber wouldn't carry `originAuth.sub` (DOs don't have user identities) — the `sub` column may need to become nullable when that case lands, but it's not a 5.3 concern.

### NebulaClient handlers + `client.resources.*` (`apps/nebula/src/nebula-client.ts`)

The full v3 surface (`client.resources.{subscribe, read, transaction, onTransactionResourceResolution, transactionDebounce}`, all option shapes, all types) is specified in [api-reference.md](../website/docs/nebula/api-reference.md) — **the docs are the contract**; don't re-derive signatures from here. The handler-plumbing picture that survives any surface change:

- `@mesh() handleTransactionResult(result)` — settles the in-flight transaction Promise; per-resource resolutions dispatch to handlers (conflict-outcome engine in v3).
- `@mesh() handleResourceUpdate(rt, rid, snapshot | null | Error)` — unconditional store write-through; first call per `(rt, rid)` resolves a pending `subscribe()` Promise; `null` = never-created (tombstones arrive as real Snapshots with `meta.deleted: true`); `OntologyStaleError` routes to `onShouldRefreshUI`.
- Constructor: `appVersion` (auto-attached to every op; renamed from `ontologyVersion` in v3) + `onShouldRefreshUI` hook.

### Integration entry point — `createNebulaClient(config)`

`createNebulaClient(config)` from `@lumenize/nebula-frontend` is the integration entry point. It folds four responsibilities into the factory's outer Proxy + middleware + effectScope-tied refcount + connection observer:

1. **Local writes → remote transactions** — outer Proxy `set` trap → synced-state middleware → debounced `client.resources.transaction(...)`.
2. **Auto-subscribe via reference counting** — `trackResourceRead` driven by `getCurrentInstance().scope` + `onScopeDispose`. Refcount-with-grace; `unsubscribeGraceMs` knob.
3. **Remote pushes direction** — `client.onResourceUpdate(...)` handler writes through `internalDeepWrite` with `context.source === 'remote'` (middleware sees the context and skips).
4. **Connection-state surfacing** — factory wires `client.onConnectionStateChange` directly AND replays current state at creation (so creation order is irrelevant — deep-review m2).

Full surface details in § "Phase 5.3.7" below + [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) + [api-reference.md](../website/docs/nebula/api-reference.md).

### Types

All canonical in [api-reference.md](../website/docs/nebula/api-reference.md): `Snapshot` / `SnapshotMeta` (§ Snapshot), `TransactionOutcome` / `TransactionResourceResolution` / `ConflictResolverVerdict` / `ResourceHandler` (§ TransactionOutcome and below). Don't duplicate them here — the doc is the contract. Two whys worth keeping next to the plan:

- **Always-resolve over reject**: Studio UIs are LLM-authored; switching on `outcome.kind` forces every transaction-wide terminal state to be handled, where a bare `try/catch` would conflate transaction-wide failures with per-resource outcomes (which belong in the handler, not the await-site).
- **`base` in `'conflict-pending'`** (deep-review B4): without the common ancestor, the only expressible merge is `textMerge(server, local, base=server)`, which silently degenerates to local-wins. Capture/re-anchor rules live in the v3 correctness item below + [factory-conflict-outcome.md](factory-conflict-outcome.md).

## Implementation Phases

### Shipped: 5.3.0 – 5.3.3 (2026-05-12) — summary; details in git history

From earlier auth work: two-scope model, refresh routing, Gateway active-scope verification, LumenizeClient auto-reconnect base.

- **5.3.0** — `@lumenize/state` ported from JurisJS. *Deleted in v3* (Vue `reactive()`+`effectScope()` replaces it; its test cases harvest into factory tests — see § Deletions).
- **5.3.1** — Star subscribe machinery: `Subscriptions` class + `Subscribers` table ([apps/nebula/src/subscriptions.ts](../apps/nebula/src/subscriptions.ts)); `@mesh subscribe` Handler 1/2 (version check → DAG read-permission check → existence + type-mismatch check → idempotent `INSERT OR REPLACE` → initial snapshot push); `subscriberBinding` from `callChain.at(-1)?.bindingName` (supports future DO-to-DO subscribers). Errors travel as data through the handler callback (Handler 1/2 is non-awaited RPC).
- **5.3.2** — mutation fanout (originator excluded; tombstones push real Snapshots with `meta.deleted: true`, never `null`; migrations do NOT fan out) + `Subscriptions.clear()` (DROP+CREATE = one billed write) wired into `Star.#installState` — deploys ARE the subscriber cleanup event.
- **5.3.3 (a–d)** — NebulaClient foundation: `subscribe`/`read`/`transaction` always-resolves API; serial in-flight queue + 10 s timeout; transaction-level `newETag` idempotency (server short-circuit in `resources.ts`); typed `TransactionError` incl. `'permission'`; conflict-resolver machinery (`onETagConflict` + recursive `'use-this'` bounded by `maxRetries`, async resolver suspends the queue timeout) — *replaced by `onTransactionResourceResolution` + the conflict-outcome engine in v3*; structured `OntologyStaleError` ([apps/nebula/src/errors.ts](../apps/nebula/src/errors.ts)) → `onShouldRefreshUI` on all three paths. `read` correlates via per-call `requestId` + hidden `@mesh handleReadResponse`; transactions need no correlation (serial queue).

### Shipped: 5.3.4 – 5.3.6 (2026-05-12/13) — summary

- **5.3.4a — reconnect → re-subscribe**: on the `reconnecting → connected` transition, `#resubscribeAll()` walks the registry via direct `lmz.call` (deliberately NOT the coalescing subscribe path: a subscribe sent pre-drop whose response was lost would hang forever — LumenizeClient doesn't re-send fire-and-forget messages). Idempotent server-side; deep-equals dedup makes redundant snapshot pushes no-ops. ⚠️ The companion pin "in-flight transactions just time out; app retries" is **superseded for v3**: a debounced v-model write has no app await-site, so v3 connection-gates the whole write path instead (see § Decisions pinned → Transaction queue).
- **5.3.4b — push-on-clear**: `Subscriptions.clear()` returns the distinct dropped `(subscriberBinding, clientId)` pairs; `#installState` pushes one `OntologyStaleError` per pair (grouping = fires once per client, not once per subscription). Thundering-herd jitter (`refreshWithinMs`) deferred post-demo.
- **5.3.5 — disconnect cleanup via drop-on-failed-fanout**: `Star.#fanout` carries a result-handler continuation; `ClientDisconnectedError` post-grace → `Subscriptions.removeSubscriber(resourceId, clientId)` inline (~15 LOC). Chosen over alarm-driven Gateway cleanup: the Gateway is raw-DO (no `lmz.call`), so reactive cleanup from Star is structurally simpler. Quiet resources leak rows until the next deploy's clear — accepted. Test grace override: `LUMENIZE_MESH_GRACE_PERIOD_MS` miniflare binding.
- **5.3.6 — `bindToState` integration** (169-test baseline). *Deleted in v3*; its four responsibilities — write-through middleware, auto-subscribe refcount, connection-state surfacing, flash wiring — carry into the factory.

**5.3.6 pinned decisions carrying forward to the factory** (load-bearing for the v3 port):

| Question | Resolution |
| --- | --- |
| Middleware sub-path → full-value `put` | **Microtask defer.** Middleware returns `undefined` (writes pass through); after the write lands, read full `value` and submit `put`. |
| `Star.unsubscribe(rt, rid)` mesh method | **Add it.** Plain `@mesh()` method on Star — no ontology check; calls `Subscriptions.removeSubscriber(resourceId, clientId)` keyed off `callContext.callChain.at(-1)?.instanceName`. |
| Middleware scope: creates vs. puts | **Puts only.** Middleware only translates writes that have a cached `meta.eTag` for `(rt, rid)`. Creates go through explicit `client.resources.transaction(...)` calls. Missing `meta.eTag` → warn-and-skip via `@lumenize/debug`. |
| Initial connection-state on factory creation | **Replay current state immediately.** Read current connection state at factory creation time and write through to `lmz.connection.*`. Subsequent transitions write through via the connection-observer wrapper. |
| Flash-class wiring | **`getBindings` option.** Headless tests pass nothing — flash is a no-op. Default `lumenize-conflict-revert` flash applies on **all** rollback outcomes; `'committed'` flashes `lumenize-commit-success`. |
| Flash semantic for non-leaf bindings | **Exact-path only.** `getBindings(diffPath)` returns only elements bound to `diffPath` itself, not ancestors. Elaborate flash UX goes through the resolver's `context.bindings`. |

Still open from 5.3.6: defensive registry cleanup on `unsubscribe` + the subscribe → WS-drop → grace → reconnect interleaving test (needs WS-disconnect tooling); rollback sibling tests for `timeout` / `retries-exhausted` ([nebula-scratchpad.md](nebula-scratchpad.md)). `ontology-stale` is **no-rollback** (code + test + docs aligned 2026-06-11 — it's a "client stale, reload" signal, not a per-write rejection).

### Phase 5.3.7 — `@lumenize/nebula-frontend` factory + Vue integration

Scaffolds `@lumenize/nebula-frontend` around a factory (`createNebulaClient`) that wraps NebulaClient. Vue 3.5+ (with `.vue` SFCs compiled server-side per the 2026-05-15 pivot — see [spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md)) owns templates, directives, recursion, per-component scope; the factory owns the bridge from Vue's reactivity to NebulaClient's wire protocol. The framework target was originally settled by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md); the SFC variant was settled by the SFC dev-cycle spike.

**Pinned decisions:**

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Framework target** | Vue 3.5+ with `.vue` SFCs. Per-save compile runs in the user-local dev Star (per [nebula-branches.md](nebula-branches.md)) using `@vue/compiler-sfc`; runtime-only Vue (~22 KB gzip) ships to clients. | Spike-validated ([spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md)): `@vue/compiler-sfc` runs cleanly in Workers/DOs; per-save round-trip sub-50 ms globally; SFC ergonomics materially better for the LLM-author audience. (Rejected: in-DOM mode + template strings — required the runtime compiler + CSP `'unsafe-eval'` and HTML-in-JS-strings ergonomics.) |
| **Pinia** | NOT taken as a dependency. The factory is the store. | Pinia's `defineStore` + composable pattern leans on SFC-bundled imports; the no-build path requires import maps that defeat the simplicity win. Re-evaluate post-spike if a real cross-component coordination need surfaces. |
| **`@lumenize/state`** | Replaced by Vue's `reactive()` + `effectScope()`. Package deleted in v3. | Vue's reactivity covers every load-bearing semantic the StateManager had — deep-equal dedup (via factory wrapper), hierarchical-notify (via Vue dep tracking), batched ancestor-write fanout (via Vue scheduler). The 80-test invariant set is harvested into the factory's tests. |
| **Factory shape** | `createNebulaClient(config) → { client, store, ready, use, dispose }`. `store` is a Vue-reactive Proxy with middleware in the `set` trap. `client` exposes connection/transaction/subscription methods. `ready` resolves after the first successful connection (token refresh complete → `client.claims` populated) — Studio's bootstrap top-level-awaits it, pinning the claims-non-null-by-mount contract (api-reference § client.claims; added 2026-06-10). Consumer wires it in Vue via `setup() { return { store }; }`. | One entry point; same API in Node and browser. Test-app pattern survives unchanged. `ready` closes the claims-null-at-first-render window without per-component guards — `client` is non-reactive, so a `v-if` gate could never re-evaluate. |
| **Factory/connect ordering** | Order-irrelevant: the factory **captures the client's current connection state at creation** (replay) and tracks transitions via its observer, so `lmz.connection.*` is always correct. | Replay is ~5 LOC and strictly more forgiving than the rejected alternative (a "factory must be created before connect" order-invariant — a footgun for the Studio LLM). |
| **Auto-subscribe scope resolution** | Factory checks `getCurrentScope()` first (synthetic test scopes); falls back to `getCurrentInstance()?.scope` from `@vue/runtime-core` for component renders. `onScopeDispose` registered via `scope.run(...)` because Vue's render-effect path doesn't activate the component's scope at `run()` time. | The structural gotcha. Vue components' render `ReactiveEffect.run()` only sets `activeSub` (dep tracking) and `shouldTrack` — it does NOT set `activeEffectScope`. So `getCurrentScope()` returns null inside renders unless we bridge. ~10 LOC. |
| **Per-component state** | Use Vue's native `setup()` with `ref` / `reactive` for local component state. NOT the factory's store, NOT a `$local` paths-into-store mechanism. | Vue idiom; no factory mechanism needed. User-developer reads as native Vue. Local state isn't synced anyway — it's per-component. |
| **`v-model` debouncing** | Synced-state middleware debounces transaction submission per-resource with **500 ms quiet window + 2000 ms maxWait** as framework defaults. Local optimistic write fires on every keystroke (no DOM-level debounce). Transactions flush on (a) quiet window elapse, (b) maxWait elapse, (c) component unmount, (d) input blur (when reachable), (e) `client.dispose()`. Per-resource serial queue ensures eTag races resolve correctly: when transaction T1 is in-flight, T2 buffers and gets submitted using T1's resulting eTag. **Per-field overrides come from the ontology** — annotations like `@debounce(0)` and `@longform` (and field-type-derived defaults: `boolean`/enum auto-eager) compile into the validator bundle the factory loads at startup. Resource-level merge rule when multiple fields have pending writes: **shortest active timer wins**. Runtime override via `client.resources.transactionDebounce(rt, opts)` for edge cases (A/B testing, dynamic config). | Per-keystroke transactions are network-chatty and pile up server-side. 500/2000 ms is the lodash-default-ish profile. Per-field control via ontology annotations (the same place field types are declared) instead of HTML-level modifiers — Studio's LLM generates the right defaults from field types; user-developer never thinks about debounce. Resolves the earlier `v-model.eager` design — no custom Vue directive needed; field-type defaults + `@debounce(0)` annotation cover the click-to-commit case. |
| **`v-model` default trigger** | Per-keystroke (`input` event). Document `.lazy` (blur-triggered) as the standard escape for "I want to commit on blur." | Matches user expectation of "I see what I'm typing." Lazy is one modifier away. |
| **Per-type resource handler** | Replaces the shipped `client.resources.onETagConflict(rt, resolver, options?)` with `client.resources.onTransactionResourceResolution(rt, handler, options?)`. One handler per type does both jobs — return a `ConflictResolverVerdict` from the `'conflict-pending'` branch to drive conflict resolution; react to terminal branches (`'committed'`, `'use-server'`, `'human-in-the-loop'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) for UX side-effects. Per-call override via `options.onTransactionResourceResolution` on `transaction()`. | Consolidates two previously-separate hooks (conflict resolver + outcome notification) into one. The conflict path and the success/failure path are the same handler — user-developer LLM has one mental model for "what happens to a resource of this type." Framework defaults still apply (server-wins on conflict, default flash classes on outcomes) so registering the handler is optional. |
| **`__v_skip`** | Not used. Factory's Proxy passes through `__v_*` reads to the underlying Vue reactive, which answers correctly (`__v_isRef`, `__v_isReactive`, etc.). | Vue 3.5 in-DOM mode only probes `__v_isRef`. |
| **`v-if` on `v-model`-bound paths** | Idiomatic Vue: `<template v-if="store.resources.<rt>[id]?.value"><input v-model="store.resources.<rt>[id].value.title" /></template>`. The `v-if` guard is required because `v-model` needs a real l-value path. | Standard Vue pattern. Doc must show this — user-developers won't infer it. |
| **In-DOM template tag case** | Component tags in markup written to `innerHTML` MUST be kebab-case (`<tree-node>`); the browser HTML parser lowercases tag names before Vue sees them. Inside template strings (parsed by Vue), PascalCase works. Doc must call this out. | Browser-parser semantics; not negotiable. |
| **Client-side router** | Use [vue-router](https://router.vuejs.org/) when Studio apps need routing. URL-params-into-store ≈ ~10 LOC of `watchEffect` in app code reading `useRoute()` (or a small `useRouteSync(map)` composable if Studio wants it factored). | Mature, well-documented, large LLM training corpus, integrates natively with Vue's reactivity. |
| **`flashClass` for conflicts** | Defer concrete design to 5.3.7 implementation. Two viable options: (a) `client.bindings(rt, rid, field)` returns the bound `HTMLElement[]` (Vue exposes via `useTemplateRef` + the factory tracking ref names); (b) ship a small `v-flash` custom directive that listens for path-level flash events. Pick during implementation. | Vue doesn't have an Alpine-style `getBindings` equivalent out of the box; either approach is small. |

**Prerequisites**: real-browser bundling of `@lumenize/nebula-frontend` is blocked by three pre-existing items (transitive `cloudflare:workers` import in `@lumenize/debug`, transitive `node:async_hooks` import in `@lumenize/mesh/client`, no CORS headers on NebulaAuth). All three plus a reusable real-browser test template are owned by [tasks/playwright-test-template.md](archive/playwright-test-template.md) — v2 below lands that task.

**Target package layout** (scaffolded in v3):

```
packages/nebula-frontend/
├── package.json          # UNLICENSED; deps: vue ^3.5 (NebulaClient lives in THIS package — see m5/layer table)
├── src/
│   ├── index.ts          # re-export createNebulaClient, types
│   ├── create-nebula-client.ts   # factory: Proxy + middleware + effectScope + debounce
│   ├── debounce.ts       # per-resource quiet/maxWait/flush implementation
│   ├── types.ts          # ClientLike, Middleware, WriteContext, FactoryResult
│   └── deep-equals.ts    # structural equality helper
├── test/
│   ├── unit/             # factory mechanics with mock client
│   ├── e2e/              # vitest-pool-workers in-process Star
│   └── browser/          # vitest-browser-playwright real-browser harness
└── README.md
```

**Implementation phases.** Sequenced docs-first: the v1 doc rewrite locks the API surface against the spike's validated mechanics; v2 unblocks bundling; v3 implements; v4 adds real-browser probes; v5 polishes secondary docs.

#### Phase 5.3.7-v1 — Docs first

Lock the API surface in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) + [api-reference.md](../website/docs/nebula/api-reference.md). Every signature mentioned in coding-your-ui resolves to a section in api-reference. Every api-reference section is tagged `implemented-in-spike | new-in-v3 | deferred-post-5.3.7`. That tag is the contract for v3 — v3 implements everything tagged `new-in-v3` and rejects anything the docs reference that's tagged `deferred-post-5.3.7` from shipping in 5.3.7.

Both docs are drafted: coding-your-ui.md rewritten end-to-end against the spike's validated patterns; api-reference.md scaffolded with every surface tagged. SFC compile validated by [spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md) (compile home = the **user-local dev Star**, not Galaxy; sub-50 ms per-save loop globally — see [nebula-studio.md](nebula-studio.md) § "Dev-mode Star").

Remaining v1 work:

- [x] **Rewrite template-string-dependent doc chapters against `.vue` SFCs** — verified done 2026-06-12: zero `template:` strings remain in coding-your-ui.md, all examples are SFCs, the kebab-vs-Pascal bullet and runtime-compiler discussion are gone.
- [ ] **Resume the design-review pass** on coding-your-ui.md + api-reference.md. Flag awkward code samples, surprising defaults, names that feel wrong, surprising `deferred-post-5.3.7` tags.

  **Collaboration model for the review session(s):**
  - User reads sections in order, asks questions and proposes specific changes.
  - Assistant answers concisely; edits ONLY on explicit sign-off. No speculative rewrites.
  - If the assistant spots a problem while answering, mention briefly but don't fix without explicit OK.
  - Code blocks currently use `@skip-check` (Phase 1 drafting). Don't convert to `@check-example` during review — that's a separate Phase 2 task.
  - Don't relitigate decisions already pinned in § "Decisions pinned" or § "Phase 5.3.7" → "Pinned decisions" unless the user opens them.
  - Don't restructure tasks/nebula-frontend.md unless something in the doc surfaces a real design question. Even then, ask first.
  - Naming preference: longer + descriptive over short. LLM consumes these names; no one types them.
  - Review one doc per session: coding-your-ui first, api-reference separate.
- [ ] Verify every api-reference signature against the spike's actual `createNebulaClient` + `ClientLike` types + the existing `client.resources.*` namespace ([apps/nebula/src/nebula-client.ts](../apps/nebula/src/nebula-client.ts)). Anything in the docs that doesn't trace to real code (or a `new-in-v3` tag) is a defect.

#### Phase 5.3.7-v2 — Prerequisites unblock — ✅ DONE 2026-06-03

All browser-bundling blockers (`@lumenize/debug` cloudflare:workers, `@lumenize/mesh/client` node:async_hooks, NebulaAuth CORS) + the real-browser test template shipped in commit `4baa75d`. Full change log: [archive/playwright-test-template.md](archive/playwright-test-template.md); v4 follows the adoption checklist at [packages/mesh/test/browser/README.md](../packages/mesh/test/browser/README.md).

#### Phase 5.3.7-v3 — Scaffold + factory + Vue integration

Implements the API surface fixed by v1's doc rewrite. The doc is the spec; this phase makes the doc true. Scope = **detour ports + wiring** (don't quote a single duration; track by the checklists).

**✅ Pre-v3 isolation detours — ALL FOUR COMPLETE 2026-06-12**, built + property-tested in `apps/nebula/spike/vue-factory/` against one shared harness; key invariants gut-verified capable-of-failing; findings synced to api-reference (mutator middleware args, synced-state-runs-LAST so a user abort also aborts the submission, `use-this` paints its verdict value). **Read each detour file for the validated design + build findings — their production ports ARE part of v3:**

1. [factory-textmerge.md](factory-textmerge.md) — 3-way LCS merge (hand-rolled, no dep) + cycle-safe `deep-equals` → `src/text-merge.ts`.
2. [debounce-serial-queue.md](debounce-serial-queue.md) (D0/D1 done; D2 = the port) + [factory-collection-sync.md](factory-collection-sync.md) (M10 Map/Set mutator interception) → `src/debounce-queue.ts` + the spike factory's `get`-trap block; the spike factory submits through the queue.
3. [factory-conflict-outcome.md](factory-conflict-outcome.md) — the TransactionOutcome/Resolution engine over the real queue → `src/conflict-outcome.ts`.

Already spike-validated (no fresh detour — property-test during the port): refcount + `effectScope` auto-subscribe + grace. Mechanical (no detour): subscribe→`Disposable`, eTag auto-derive, connection-state replay, `appVersion` rename.

**Remaining prerequisite**: [nebula-star-root-admin.md](nebula-star-root-admin.md) **Part 1** (founder admin-on-ROOT seeding) — the flagship bootstrap, its two-client race test, and coding-your-ui's "the founder gets admin on root at Star creation" claim all hard-depend on it.

- [ ] Scaffold `packages/nebula-frontend/` per CLAUDE.md "Standard Package Files" (UNLICENSED, `vue ^3.5` dep; NebulaClient + `nebula-client.ts` move INTO this package — there is no separate `@lumenize/nebula-client` package, m5). vitest configs for unit + e2e + browser projects.
- [ ] Port factory from `apps/nebula/spike/vue-factory/src/create-nebula-client.ts`: Proxy wrapper, middleware chain, `effectScope` + `getCurrentInstance().scope` fallback, refcount + grace, `internalDeepWrite`, synced-state middleware. ~290 LOC.
- [ ] **Spike-port cleanup** (must address during the port, NOT after):
  - Remove the `console.log('[proxy get] ...')` debug print at [create-nebula-client.ts:229](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:229).
  - Add `.catch(() => {})` (or equivalent debug-log) to the `client.unsubscribe(...)` call at [create-nebula-client.ts:182](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:182) to match the `subscribe` path.
  - Seed `lmz.connection = { state: 'disconnected', connected: false }` initially (at [create-nebula-client.ts:82](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:82)) so first-paint reads aren't `undefined`. `lastConnectedAt` stays unset until first connect. Also pre-seed `ui: {}` and `app: {}` (app-owned conveniences, not reserved — first-level `store.ui.*` access works with no init; pinned 2026-06-10 in api-reference § Reserved state paths after the docs-panel review found every `store.ui.*` example otherwise throws).
  - Add a debug-mode warning when `syncedStateMiddleware` drops a write because no `meta.eTag` exists ([create-nebula-client.ts:305-309](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:305)). The `v-if` guard pattern is supposed to prevent this case; an unguarded `v-model` would otherwise be invisibly broken in production.
  - Document the semantics of writes to `resources.<rt>.<rid>.meta.*` paths: the synced-state middleware regex only matches `value(\.|$)`, so meta writes pass through middleware unchanged (server-owned, intentional). Add an explicit test asserting user-code writes to `meta.eTag` are no-ops or warned-on, so we don't accidentally allow it.
  - **Tombstone contract (pinned; deep-review M12 — corrected from the old null→deleted model).** Deletions are soft: a deleted resource arrives as a **real `Snapshot` with `meta.deleted: true` and its last `value` intact** — NOT as `null`. `null` is reserved for "never created" (subscribe-before-create). The factory writes the tombstone snapshot through unchanged (value + meta), so templates distinguish deleted (truthy value + `meta.deleted`) from loading (`value === undefined`), checking `meta.deleted` BEFORE any value test (pinned in api-reference § Snapshot + coding-your-ui § Loading and first paint). **Client-half test (currently uncovered):** a delete fanout writes the tombstone through (last value truthy + `meta.deleted: true`); the pattern-3 status `computed` yields `'deleted'`; a subsequent `read` returns the tombstone, not `null`.
  - Apply the "lazy post-middleware deep-equals" optimization (carried into the correctness items below).
- [ ] Port `nebula-client-adapter.ts` shape OR fold into factory (decision during implementation — the spike adapter exists because `createNebulaClient` was framework-agnostic; if factory becomes Vue-aware anyway, the adapter step may disappear).
- [ ] Build `debounce.ts` per [tasks/debounce-serial-queue.md](debounce-serial-queue.md) Phase D2: per-resource `(rt, rid)` timer state, quiet/maxWait policy, flush API (called on commit, unmount, blur, dispose). State machine + invariants validated in D0/D1; D2 is mechanical port.
- [ ] **Per-field debounce config from validator bundle.** The factory consumes per-field `quietMs`/`maxWaitMs` config emitted by the typia/ontology compile pass (see [tasks/nebula-studio.md § Code Generation](nebula-studio.md#code-generation) for the annotation → config flow). Field-type defaults: `boolean` and enum / literal-union → `{ quietMs: 0 }`; `string` → inherits type default; `string` with `@longform` annotation → `{ quietMs: 1000, maxWaitMs: 5000 }`; explicit `@debounce(q, m)` overrides everything. **Merge rule at the resource level**: when multiple fields on the same resource have pending writes, the shortest active timer wins for both `quietMs` and `maxWaitMs` — clicking a `@debounce(0)` checkbox flushes any pending text-field edits as part of the same transaction. Runtime override via the existing `client.resources.transactionDebounce(rt, opts)` API; precedence: runtime > annotation > type-default > framework-default. Wire format for the config the factory consumes: TBD during implementation (probably attached to the validator bundle alongside the typia schema).
- [ ] Wire debounce into synced-state middleware: optimistic write lands immediately; transaction submission queues to the debouncer; debouncer flushes through the serial-per-resource queue.
- [ ] **`TransactionOutcome` + `TransactionResourceResolution` per [api-reference.md](../website/docs/nebula/api-reference.md#transactionoutcome).** *Design + isolation tests live in [factory-conflict-outcome.md](factory-conflict-outcome.md) — this item is the port.* The spike at [create-nebula-client.ts:343-373](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:343) returns the old single-level shape with only 4 branches. v3 replaces it with the new top-level `TransactionOutcome` (4 branches: `'ok'`, `'ontology-stale'`, `'timeout'`, `'infrastructure-error'`) plus per-resource `TransactionResourceResolution` delivered to the handler. For each branch, define and test the optimistic-state semantic:

  **Transaction-wide (top-level `TransactionOutcome`, what `await` resolves with):**
  - `'ok'` — per-resource handler has fired for each resource. `resources` carries the map (each `TransactionResourceResolution`) so callers can inspect at the await-site if needed for aggregate decisions.
  - `'ontology-stale'` — `onShouldRefreshUI` hook fires; do NOT roll back (page reload is the expected response).
  - `'timeout'` — roll back every optimistic write in the transaction. No server response within 5–10 s **while connected**. The timer is **connection-gated** (invariant 10): suspended while `lmz.connection.state !== 'connected'`, so a mere disconnect never times out / rolls back — writes hold and re-submit on reconnect.
  - `'infrastructure-error'` — **NEW**. Wrap any thrown `Error` from the network/mesh transport (current behavior is to reject) into `{ kind: 'infrastructure-error', error }`. Roll back. **Connection-gated like `'timeout'`** — only fires for a while-connected transport failure, not a plain disconnect. The Promise from `transaction()` must NEVER reject after this lands — every code path that previously threw becomes a resolution.

  **Per-resource (`TransactionResourceResolution`, delivered to the handler):**
  - `'conflict-pending'` — non-terminal. Handler returns a `ConflictResolverVerdict` to drive the chain. Undefined return defaults to `{ kind: 'use-server' }`.
  - `'committed'` — `meta.eTag` updated for that resource. Framework adds default `lumenize-commit-success` flash class to bound elements.
  - `'use-server'` — server's `value` + `meta` written through for that resource. Framework adds default `lumenize-conflict-revert` flash at diff fields.
  - `'human-in-the-loop'` — keep that resource's optimistic state painted; no default flash. App owns the eventual resolution submission for that resource.
  - `'retries-exhausted'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash. `snapshot` is the latest server snapshot; `attempts` is the count.
  - `'validation-failed'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash. `errors` carries the server's per-field messages.
  - `'permission-denied'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash.

  **Mixed-fate handling:** the existing "first-conflict wins" simplification in 5.3.3c (`#handleTransactionResult`'s conflict path passes only the first conflicting resource to its resolver and applies the verdict uniformly) is replaced. v3 collects ALL conflicting resources, invokes each one's per-type registered handler (or per-call override) with `'conflict-pending'`, aggregates verdicts, drives any `'use-this'` re-submit chain. Top-level outcome is `'ok'` whenever the server responded (even when some/all resources landed at `'use-server'` or other non-`'committed'` resolutions). Multi-resource rollback uses per-resource pre-write snapshots, NOT a single `preWriteFullValue` (spike L317 is single-resource only). Capture each per-`(rt, rid)` pre-write snapshot **at first divergence** — the value the store held before the first optimistic write of the burst, the SAME snapshot used as the merge `base` (the B4 item below). NOT at transaction-submit time, by which point the store already holds the user's edits (rollback would be a no-op revert, and `base` would equal `local`).
- [ ] **Handler merger.** *Design + isolation tests in [factory-conflict-outcome.md](factory-conflict-outcome.md) (invariant 6, fall-through).* Replace the shipped `onETagConflict(rt, resolver, options?)` with `onTransactionResourceResolution(rt, handler, options?)`. Per-call override becomes `transaction(ops, { onTransactionResourceResolution })`. The handler is invoked at TWO temporal phases per resource:
  - Phase 1 — `'conflict-pending'`: synchronously during conflict resolution. Handler return drives the next step (may fire multiple times across `'use-this'` chains).
  - Phase 2 — terminal: once per resource per transaction with the final `TransactionResourceResolution` (`'committed'`, `'use-server'`, etc.). Handler return ignored.

  Implementation: invoke handler from `#handleTransactionResult` for both phases. Apply default flash classes (`lumenize-commit-success` / `lumenize-conflict-revert`) before calling the handler at terminal phases so the handler can override (e.g., by removing the class) if needed.
- [ ] **Rename `ontologyVersion` → `appVersion` in the user-facing API.** Per the docs-first sequencing, [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) and [api-reference.md](../website/docs/nebula/api-reference.md) use `appVersion` — the lock-step coupling between app and ontology versions means the LLM-as-reader mental model is "app version," not "schema version." Sites to update: NebulaClient constructor config, `client.resources.read` / `transaction` per-call options (`ReadOptions.appVersion`, `TransactionOptions.appVersion`), Star's mesh-method dispatch params, related types in `apps/nebula/src/nebula-client.ts` + `apps/nebula/src/star.ts`. Server-side internals (Star's ontology cache key, etc.) may keep `ontologyVersion` if useful — only the public API renames. The `'ontology-stale'` variant of `TransactionOutcome` keeps its `clientVersion` / `currentVersion` keys (already version-neutral).
- [ ] **Make all `createNebulaClient` config fields optional except `appVersion`, with browser-friendly auto-detection.** The bootstrap example in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) now shows zero fields specified (the doc cut the bootstrap section entirely; Studio auto-populates `nebula.ts`). For that to be honest, every field needs a sensible default:
  - `baseUrl?: string` — default to `window.location.origin` (Nebula's deployment model puts UI serving and API on the same Star domain). Required only for cross-origin admin/scripting use.
  - `authScope?: string` + `activeScope?: string` — both currently required, both should auto-detect from the auth-discovery flow's cookie + JWT:
    - **Server side**: add a single global refresh endpoint `${baseUrl}/auth/refresh-token` (no path-encoded scope) that reads the refresh token from the cookie and identifies the scope from the token value itself. The current per-scope endpoint can stay for admin/scripting callers that want explicit control.
    - **Client side**: when `authScope` is not specified, the refresh call hits the global endpoint. The refresh response already returns `{ access_token, sub }`; the client parses `access_token` (JWT, base64-decode the middle segment) and extracts the `aud` claim into `activeScope`. ~5 LOC of JWT parsing in the client constructor. Subsequent `lmz.call('STAR', activeScope, ...)` use the parsed value.
    - Both fields stay in the type as optional `?: string` overrides for admin/scripting cases (headless tests, server-side tooling) where there's no browser cookie to derive from.
  - `onShouldRefreshUI?: (info) => void` — default to `() => window.location.reload()`. The current behavior of `undefined = opted-out` becomes `null = opted-out` (or pass `() => {}`); the typical user gets the right behavior with no config.
  - `appVersion: string` — stays required. This is the ONLY field Studio's bootstrap needs to substitute at deploy time. In dev/iteration mode Studio passes `'dev'` (or a build-stamped value); at deploy time Studio injects the version that matches the deployed ontology bundle.
  - Update [api-reference.md § createNebulaClient](../website/docs/nebula/api-reference.md#createnebulaclient) table to reflect new defaults and which fields are `required` vs auto-detected.
  - Test: in jsdom + with a mocked cookie + refresh response, `createNebulaClient({ appVersion: 'v1' })` succeeds and the client connects with the right `authScope`/`activeScope` derived from the JWT.
- [ ] **Reshape `client.resources.subscribe` to return a `Disposable` handle** (`ResourceSubscription`) for `using`-compatible scope binding. Current shipped signature (per 5.3.3a `[x]`) is `subscribe(rt, rid): Promise<Snapshot | null>`. New v3 signature:

  ```typescript
  interface ResourceSubscription extends Disposable {
    readonly snapshot: Promise<Snapshot | null>;
    [Symbol.dispose](): void;
  }
  subscribe(resourceType: string, resourceId: string): ResourceSubscription;
  ```

  Implementation: subscribe returns synchronously after registering the subscriber row; `.snapshot` carries the existing first-fanout-resolves-the-promise behavior (same Promise the old shape returned). `[Symbol.dispose]()` calls `client.resources.unsubscribe(rt, rid)`. ~10 LOC of return-shape change in `client.resources.subscribe` + ~5 LOC for the standalone `unsubscribe` to stay equivalent.

  Standalone `client.resources.unsubscribe(rt, rid)` stays as a parallel surface for cases where the subscribe and release sites legitimately differ (parent component subscribes; unrelated event handler later unsubscribes). Both paths converge to the same internal cleanup.

  When multiple `using` handles exist for the same `(rt, rid)`: per-handle decrement; underlying server-side subscription releases when the last handle disposes. Mirrors the auto-subscribe refcount-with-grace pattern. Concretely: factory tracks an explicit-subscribe refcount per `(rt, rid)` separately from the component-scope refcount; both contribute to "should we hold the server subscription open." When both reach zero, the standard 2 s grace period applies before issuing `client.unsubscribe`.

  TypeScript: requires `lib: ["ESNext"]` (or explicit `Disposable` import) in user tsconfigs. Studio-generated tsconfig includes this; runtime uses TS 5.2+ syntax downleveled or native depending on target.

  Doc sites updated alongside this work: [api-reference.md § subscribe](../website/docs/nebula/api-reference.md#resourcessubscribe), [api-reference.md § unsubscribe](../website/docs/nebula/api-reference.md#resourcesunsubscribe), [coding-your-ui.md § Subscription lifecycle](../website/docs/nebula/coding-your-ui.md#subscription-lifecycle).

  Tests: (a) `using sub = client.resources.subscribe(...)` auto-unsubscribes on scope exit; (b) `client.resources.unsubscribe(rt, rid)` is equivalent to disposing the handle; (c) two `using` handles for the same `(rt, rid)` — first dispose decrements, second triggers server-side unsubscribe; (d) `.snapshot` resolves with the same value the old Promise-returning shape resolved with.
- [ ] **Auto-derive per-op `eTag` from the local store; require `typeName` on every op.** Current shipped `OperationDescriptor` requires `eTag` on `put`/`move`/`delete`; callers do `eTag: store.resources.<rt>[<rid>]?.meta?.eTag` boilerplate at every call site. New v3 shape:

  ```typescript
  type OperationDescriptor =
    | { op: 'create'; typeName: string; nodeId: number; value: any }
    | { op: 'put';    typeName: string; value: any;     eTag?: string }
    | { op: 'move';   typeName: string; nodeId: number; eTag?: string }
    | { op: 'delete'; typeName: string;                 eTag?: string };
  ```

  `typeName` becomes required on **every** op (was only required on `create`); needed so the factory can perform `store.resources.<typeName>[<resourceId>]?.meta?.eTag` lookup. `eTag` becomes optional. When omitted, factory derives at call time from the local store. When the resource isn't in the local store, throw a clear client-side error (`"can't auto-derive eTag for (<typeName>, <resourceId>) — not in local store; pass eTag explicitly or subscribe first"`) rather than letting the server reject — saves a round-trip on a guaranteed failure. ~20 LOC change in `client.resources.transaction` factory wrapper.

  Race window: between auto-derive at call time and actual server submission, a fanout could update the local store, making the auto-derived eTag stale. Same outcome as the previous manual-lookup pattern — conflict resolver fires; the race is preserved, not introduced.

  Explicit override stays for two real cases:
  1. Admin/scripting code that submits without first subscribing.
  2. Human-in-the-loop conflict pattern: callers stash `server.meta.eTag` at conflict-detection time and submit resolution later against that specific stashed baseline (current local store may have moved on; the stash is the right baseline). See [resources.md § human-in-the-loop verdict](../website/docs/nebula/resources.md#human-in-the-loop-verdict-non-blocking--defer-to-the-app) for the worked example.

  Doc sites updated alongside this work: [api-reference.md § resources.transaction](../website/docs/nebula/api-reference.md#resourcestransaction) (OperationDescriptor type + auto-derive behavior + Explicit eTag override subsection), [coding-your-ui.md § Atomic append](../website/docs/nebula/coding-your-ui.md#atomic-append--adding-to-a-collection) and [Forms: explicit save](../website/docs/nebula/coding-your-ui.md#forms-explicit-save) (simplified addTodo and saveTodo examples), [resources.md § human-in-the-loop](../website/docs/nebula/resources.md#human-in-the-loop-verdict-non-blocking--defer-to-the-app) (annotation that this is the canonical explicit-eTag case).

  Tests: (a) `transaction({ rid: { op: 'put', typeName: 'todo', value } })` succeeds with eTag derived from `store.resources.todo[rid]?.meta?.eTag`; (b) same call when resource not in store throws clear error; (c) explicit `eTag` passed through unchanged; (d) multi-resource batch with mixed auto-derived and explicit eTags works correctly.
- [ ] Connection-state replay: on `createNebulaClient` registration, capture current connection state from the client and write through to `lmz.connection.*` so order-of-construction is forgiving (the harness-fix from the spike, productionized). Capable-of-failing probe (m2): drive the mock client to `'connected'` BEFORE calling `createNebulaClient`, then assert `store.lmz.connection.state === 'connected'` / `connected === true` / `lastConnectedAt` set, with no transition fired after creation — a transitions-only implementation must fail it.
- [ ] **Factory `ready: Promise<void>`** (added 2026-06-10, pinned in api-reference § createNebulaClient): resolves on the first `connected` transition (initial token refresh complete → `client.claims` populated). Studio's `nebula.ts` top-level-awaits it so the app mounts with claims present — the claims-non-null-by-mount contract every doc example relies on (api-reference § client.claims). ~5 LOC wrapping the connection observer.
  - **Failure semantics (deep-review M5).** `ready` must **reject** with an `AuthRequiredError` on *terminal* auth failure and stay **pending** through *transient* failure — otherwise a logged-out visitor blanks the page. Today the first-connect refresh-401 is swallowed at [lumenize-client.ts:728-731](../packages/mesh/src/lumenize-client.ts:728) (`catch → #scheduleReconnect`), so `onLoginRequired` never fires on the first-connect path and nothing settles. v3 wiring: distinguish terminal auth failure (refresh endpoint 401/403 = no valid session) from transient (network error, 5xx, WS drop) on the **first** connect; on terminal, reject `ready` (and fire `onLoginRequired`); on transient, leave `ready` pending and keep retrying with backoff. The bootstrap catches the rejection → redirect to login/auth-discovery.
  - Tests: (a) `ready` resolves only after claims is non-null; components mounted post-`ready` read `client.claims.sub` without guards; (b) first-connect refresh-401 → `ready` **rejects** with `AuthRequiredError` (NOT hang); (c) first-connect transient failure then success → `ready` stays pending then resolves (does NOT reject).
- [x] **Narrow `claims` to non-null on NebulaClient (deep-review m12).** ✅ DONE 2026-06-11: `LumenizeClient` is generic over its claims payload (`LumenizeClient<TClaims extends { sub: string } = JwtPayload>`, [lumenize-client.ts:373](../packages/mesh/src/lumenize-client.ts:373)); `NebulaClient extends LumenizeClient<NebulaJwtPayload>` with a behaviorally-neutral getter re-declaration dropping `| null` ([nebula-client.ts:227](../apps/nebula/src/nebula-client.ts:227)), justified by the `ready` contract. (Rejected: a "type-only override" — structurally impossible, TS2610/TS2416.) Pinned in api-reference § client.claims. Pre-`ready` code (admin/scripting) still guards with `?.`.
- [ ] **First-run container create is race-safe + node-correct (deep-review M1/M11).** The bootstrap in coding-your-ui § Lists no longer scans `dag.permissions` for a "home node" — that premise was wrong (a new user can hold zero grants; access comes via request-access or invite, not an auto-created per-user node). It attaches the per-user container under a node the user can write to: `ROOT_NODE_ID` for the demo's founder (who holds `admin` on root, seeded at Star creation — [tasks/nebula-star-root-admin.md](nebula-star-root-admin.md) Part 1, a **v3 prerequisite** for this item: without seeding, the flagship bootstrap and the race test below cannot run for a real founder). **Race (M11):** two tabs first-creating use *different* `newETag`s, so B3's replay short-circuit does NOT apply — the loser's create currently throws "already exists", which the shipped client surfaces as `'timeout'` (v3: `'infrastructure-error'`) — indistinguishable from an outage either way. v1 doc fix: read-then-create, and the success check is **per-resource** (`outcome.kind === 'ok' && outcome.resources[sub]?.kind === 'committed'` — per-resource failures like `permission-denied` arrive UNDER kind `'ok'`); when not committed, **re-read** to disambiguate (list now exists ⇒ a tab won the race, proceed; still absent ⇒ real failure, surface). **Heavier alternative to weigh in v3 (flag for Larry):** make create-on-existing a typed per-resource resolution (a distinct `already-exists`, or fold into `conflict` returning the existing snapshot so the default `use-server` adopts it) instead of a throw — cleaner than the re-read dance but a resolution-taxonomy change with blast radius across every create. Test: two-client concurrent first-create of the same `(todoList, sub)` → both end with the list present, neither surfaces a spurious error. The clients must authenticate as a **seeded founder WITHOUT `claims.access.admin`** — create-under-ROOT must succeed via the DAG grant alone (a scope-admin test user would pass even if founder seeding is absent or broken).
- [ ] **Org/permission tree delivery — DEDICATED CHANNEL (design B; decided 2026-06-11).** The tree is **not a resource**: it's mutated incrementally via `client.orgTree.*` (never `transaction()`, which sends a whole value) and read reactively at **`store.lmz.orgTree`** — under the framework-reserved `store.lmz.*` prefix, **NOT** `store.resources.*` (which stays purely user data). It never enters the resource `Subscribers`/`Snapshots` tables, which dissolves the whole reserved-namespace problem (apps may freely use any resourceId incl. `'orgTree'` and any type name incl. `lmz`). (Rejected: "Option 0, orgTree-as-a-resource" — the plumbing reuse wasn't free; it needed reserved-rid guards and special-cases in `Resources.read`/Snapshots to stop app-resource collisions, and adversarially probing it showed the dedicated channel is net-smaller. Resolves deep-review B2/M2/M3/M4/M8/M14.)

  **Server side:**
  1. **Dedicated registry** — `TreeSubscribers(clientId TEXT PRIMARY KEY, subscriberBinding, subscribedAt) WITHOUT ROWID`, a **separate table** from `Subscribers` (keyed `clientId` alone — one tree per Star, no resourceId dimension). Its own `forClient`/register/remove; never a column added to `Subscribers`.
  2. **`subscribeTree` `@mesh` Star entry** — reads `originAuth.sub` (so `NebulaDO.onBeforeCall`'s aud-lock + `dagTree.getState()`'s `#requireAuth` fire — auth parity with the old resource subscribe), registers the `clientId`, returns the synth snapshot. No ontology/type/permission checks beyond auth (the tree is universally visible — M7).
  3. **Broadcast on change** — `DagTree.#onChanged` → Star `#onDagChanged` (currently an **empty no-op** — the designated landing spot) synthesizes `dagTree.getState()` and `svc.broadcast`s to ALL `TreeSubscribers`, **including the originator** (omit the originator filter — `client.orgTree.*` has no optimistic local write-through, so the echo is the only way the actor's own `store.lmz.orgTree` updates). Reuse the drop-on-failed-broadcast `onResult` cleanup, but its **own** handler keyed by `clientId` (NOT `Star.onBroadcastResult`'s resourceId path).
  4. **Value sourcing (was M2, now ordinary code)** — synth from `dagTree.getState()`; no special-case in `Resources.read`/the `Snapshots` table.
  5. **NOT cleared on ontology install** — the tree is ontology-version-independent, so `#installState`/`Subscriptions.clear()` does **not** touch `TreeSubscribers` (and it's moot under full-reload anyway; a client that didn't reload keeps a valid tree).

  **Client side:**
  6. **Delivery** — a dedicated `handleOrgTreeUpdate` `@mesh` handler writes `store.lmz.orgTree` via the existing framework write-through (`source:'remote'`). The synced-state middleware's `^resources\.` matcher structurally never sees it → never a transaction, no carve-out (this is what deletes Option 0's M8(c)).
  7. **Subscribe-on-connect** — the tree is a universal singleton: subscribe on connect, re-subscribe on the `reconnecting→connected` transition directly (NOT via `#resubscribeAll`'s resource-registry walk). Drop the lazy refcount/grace path for the tree.
  8. **Mutation** — unchanged: `client.orgTree.*` → Star `dagTree` methods.

  **Client-surface naming (decided 2026-06-10).** Purpose-named `orgTree`: store path `store.lmz.orgTree`, namespace `client.orgTree.*`, exports `OrgTreeState` / `OrgTreeView` / `buildOrgTreeView` / `OrgTreeNodeData` + `ROOT_NODE_ID` from `@lumenize/nebula-frontend`. **Rename the shipped `dag-ops.ts` client-facing exports** (`DagTreeState`/`DagTreeView`/`buildDagTreeView`/`DagTreeNodeData` in [apps/nebula/src/dag-ops.ts](../apps/nebula/src/dag-ops.ts)) as part of the package move; test consumer ([dag-tree.test.ts](../apps/nebula/test/test-apps/baseline/dag-tree.test.ts)) updates with it. **Server internals keep `dag`** (the `DagTree` class, `dag-tree.ts`/`dag-ops.ts`, `detectCycle`). Prose keeps explaining "the underlying structure is a DAG."

  **M7 unchanged** (full-ACL universal broadcast — every connected client gets structure + every node's permissions table; accepted risk, opaque-UUID keys, tenant segmentation). **Caveat to document:** the `clientId`-alone registry key is sound only while the tree is a per-Star singleton; a future per-branch tree would need revisiting.

  **Tests:** (a) **no-collision security probe (inverts Option 0's M8 probe):** an app creates + subscribes a *real* resource `('todo','orgTree')` AND subscribes the tree; mutating the app resource delivers NOTHING to the tree channel, and vice versa (capable-of-failing: a shared-table impl leaks across them); (b) `getState()` synth wire fidelity through the broadcast (nodes Map, edges Set, permissions nested Map survive); (c) mutation via `client.orgTree.*` → broadcast reaches a second client AND the originator's own `store.lmz.orgTree`; (d) **not-cleared-on-install:** install a new ontology version → the tree subscription survives and the tree still delivers (resource `Subscribers` are cleared, `TreeSubscribers` are not); (e) **auth parity:** `subscribeTree` without auth / cross-scope → rejected; (f) **reconnect:** after a WS drop the tree re-subscribes and re-delivers.
- [ ] **`client.orgTree.*` namespace wiring** (review-round-3 gap-fill: api-reference tags the surface `new-in-v3` but no checklist item owned it): the nine mutation methods (`createNode`, `addEdge`, `removeEdge`, `reparentNode`, `deleteNode`, `undeleteNode`, `renameNode`, `relabelNode`, `setPermission`, `revokePermission`) proxy to Star's `@mesh` dagTree entry point with reject-on-failure Promise correlation (api-reference § client.orgTree is the contract, including the idempotent-no-op-before-permission nuance). No optimistic local write-through — the tree broadcast echo (server-side step 3, originator included) is the only store update path.
- [ ] Carry-forward tests: all tests under `apps/nebula/spike/vue-factory/test/**` (enumerate with `ls`/grep at port time; ~32 at time of writing — Phase 0a factory-basics + Phase 0b e2e (smoke, transaction-roundtrip, cross-client-fanout) + Vue probes Q1–Q5) across unit + e2e + browser projects.
- [ ] **Test-gap fills (deep-review m13):** (a) factory-basics — assert `store.ui` and `store.app` are pre-seeded as reactive empty objects, no deep auto-vivification under them, and writes to them never reach the synced-state middleware; (b) auto-subscribe error path — a component reading a bad-rid / no-permission resource produces no unhandled rejection, leaves the path `undefined`, emits a `@lumenize/debug` warning, and cleans up the refcount (the spike's `.catch` currently swallows this silently).
- [x] **Expose `client.claims` on LumenizeClient** ✅ SHIPPED (deep-review m4; [lumenize-client.ts:384](../packages/mesh/src/lumenize-client.ts:384) — frozen getter, populate-on-refresh, `#sub` dropped in favor of `claims.sub`; mesh docs + tests done). Named `claims` (not `user`/`jwt`) to match `originAuth.claims` vocabulary. Residual: optional `calls.mdx` / `security.mdx` cross-ref sweep.
- [x] **Nebula coding-your-ui.md doc unification** ✅ verified done 2026-06-12: the doc uses the unified 2-type ontology (`TodoList` with `items` + denormalized `openCount`; `Todo` with `status: 'open' | 'done'`) and per-user keying via `client.claims.sub` throughout — zero `'main'`-singleton references remain. Why `openCount` (preserve if revisited): the denormalized aggregate is the canonical "why atomic multi-resource transactions matter" example — without it saveTodo is a single-resource put and the multi-op shape doesn't justify itself. (Rejected: three-type ontology with explicit User; keeping the `'main'` singleton with framing — per-user keying is more realistic AND teaches the JWT-sub-on-client pattern.)

**Correctness items surfaced in spike review (must address during v3 before shipping):**

- [ ] **eTag-race correctness in the serial queue** — owned by [tasks/debounce-serial-queue.md](debounce-serial-queue.md). The state-machine design + property tests from D0/D1 land here as the implementation gate.
- [ ] **Re-entrancy guard on the middleware chain.** If a user-supplied middleware writes back to the store from inside its callback, the outer Proxy's `set` trap re-enters and a sloppy middleware could infinite-loop. Vue's reactivity handles its own re-entry, but our deep-equal-then-middleware-then-trigger sequence has no `inFlight` guard. Add a `Set<string>` of currently-applying paths to the factory; if a `set` trap fires for a path already in the set, skip middleware (forward direct to Vue reactive). Document the contract: "middleware MUST NOT write to its own path inside its callback; cross-path writes are fine." Add a test that intentionally writes back from middleware to verify no loop.
- [ ] **Lazy post-middleware deep-equals.** Spike runs `deepEquals(oldValue, finalValue)` twice on every write: once before middleware (skip identical writes) and once after middleware (substitution detection). The post-middleware check is wasted work when no middleware substituted. Track a `substituted: boolean` flag in the middleware loop; only run the post-middleware deep-equals if `substituted === true`. ~5 LOC savings, removes ~50% of deep-equals work on the hot path.
- [ ] **Mid-edit fanout contract — ship `textMerge` + hold-pending-fanouts in v3 (decided 2026-06-05).** *Design + isolation tests: [factory-textmerge.md](factory-textmerge.md) (the merge fn) + [factory-conflict-outcome.md](factory-conflict-outcome.md) (invariant 8, hold-pending-fanouts).* Server fanout arriving while a user is mid-typing will visually clobber their in-progress text under the default `'use-server'` resolver. This is by-design (Nebula's optimistic + server-is-truth model), but the user-visible UX is bad for text fields. Recommendation captured in [coding-your-ui.md § Concurrent edits and long-form text](../website/docs/nebula/coding-your-ui.md) and [resources.md § Text fields specifically — don't leave the default](../website/docs/nebula/resources.md#text-fields-specifically--dont-leave-the-default). Two pieces, both shipping in v3:
  - **`textMerge(server, local, base)` helper** from `@lumenize/nebula-frontend`'s top-level export — 3-way LCS-based merge (~100–300 LOC, or pull in `diff-match-patch` if licensing allows). Auto-registered for `@longform` fields by the annotation→resolver compile pass (see [ontology.md § Annotations](../website/docs/nebula/ontology.md#annotations)); hand-written handlers only for custom merge logic. Tagged `new-in-v3` in [api-reference.md § textMerge](../website/docs/nebula/api-reference.md#textmerge). Test: simulate concurrent-edit conflict on a `@longform` field, assert both non-overlapping edits preserved.
    - **`base` in the `'conflict-pending'` payload (deep-review B4).** A correct 3-way merge needs the common ancestor; without `base` the only expressible merge is `textMerge(server, local, base=server)`, which collapses to local-wins and silently drops the server edit. **Unifying rule: `base` is always the value at the baseline eTag the next submission uses — it re-anchors whenever that baseline advances.** Client-held (the same snapshot kept for optimistic rollback); three re-anchor sites: (1) **first divergence** — the value *before* the first keystroke of a burst (NOT submit-time, which yields `base === local`); (2) **commit boundary** — a buffered write chaining onto a clean commit re-anchors to the committed value (else sustained typing across a commit double-counts the user's own text); (3) **`use-this` re-conflict** — the previous conflict's `server` snapshot. **`base` cannot be a server-side history lookup** (rejected): the same-actor in-place debounce overwrite destroys intermediate eTags' values, so the divergence point is frequently unrecoverable from history; ADR-004/005 corrected to match, which keeps the merge path decoupled from history retention/R2 offload. All three sites + capable-of-failing tests are **validated in spike** — [factory-conflict-outcome.md](factory-conflict-outcome.md) § base threading; the v3 port carries them over.
  - **Hold-pending-fanouts middleware** (~50 LOC, moved up from the post-demo out-of-scope list) — `textMerge` alone only protects keystrokes typed *after* a fanout arrives; keystrokes typed *before* the fanout's write-through are lost via the `{ source: 'remote' }` bypass. The synced-state middleware must **hold incoming fanouts** for any resource with pending optimistic state (debounced write outstanding OR transaction in flight); the next submit's conflict resolver then sees both the user's full pre-fanout state and the buffered server snapshot, merges, applies, and releases the hold. Resource-level granularity (not per-field). Without this companion, protection is partial and timing-dependent — arguably more surprising than none. Test: type into a `@longform` field, deliver a fanout mid-edit, assert pre-fanout keystrokes survive the merge.
  - **Accepted limitation**: overlapping edits to the same span can still garble; `setUnion` / `counterMerge` and true CRDT-backed collab stay out of scope (see "Out of scope" below).

**Things that can't be fully assessed until v3 lands — track as risks, surface during impl:**

- [ ] **Vue `<Suspense>` / `<KeepAlive>` interaction.** Recursive trees + KeepAlive could surface scope-disposal edge cases the spike didn't exercise. Test: mount a KeepAlive'd component with subscribed resources, switch away, switch back; verify exactly-one-subscribe (resource stays subscribed across keep-alive cycle, or properly unsubs + resubs). Test: `<Suspense>` boundaries inside recursive trees — async setup during recursion shouldn't double-subscribe.
- [ ] **Real-browser vs jsdom divergence.** Phase 5.3.7-v4's real-browser harness will surface things the spike couldn't see: input event timing, IME composition events (Asian languages — typing Chinese/Japanese/Korean fires composition events the spike never exercised), focus management around `v-model.lazy`, paint scheduling. Vue's surface is battle-tested but our debounce/flush-on-blur interaction with composition events is novel. Test: IME composition probe — type a multi-key character, verify exactly one transaction fires after composition ends, not one per intermediate keystroke.
- ~~CSP `unsafe-eval` and compile placement~~ — **resolved by the SFC pivot; no 5.3.7 action.** Both compile sites are server-side and owned elsewhere: per-save dev compile in the user-local dev Star ([nebula-studio.md](nebula-studio.md) § "Dev-mode Star"); production-deploy compile in Galaxy (post-demo Studio work, output cached by ontology version). Clients get the runtime-only Vue bundle; `'unsafe-eval'` is unnecessary in both modes. `@vue/compiler-sfc` is pure JS and runs in Workers/DOs (validated: [sfc-devstar-loop RESULTS](../apps/nebula/spike/sfc-devstar-loop/RESULTS.md)).
- [ ] **`wrapperCache` memory accumulation over long-running pages.** The factory's `wrapperCache` ([create-nebula-client.ts:195](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts:195)) caches a Proxy wrapper per path-suffix; when a resource snapshot replaces its `value` object, the old wrapper stays in the cache pointing at orphaned reactive state. Bounded by application structure (paths are finite), but a long-running app with many distinct resource IDs over time slowly leaks. Probably fine for v1; flag for post-demo if it surfaces. Add a leak probe to the real-browser tests if it's cheap to do.

#### Phase 5.3.7-v4 — Real-browser harness + production-shape probes (~1–2 days)

- [ ] vitest-browser-playwright setup mirroring `packages/structured-clone/vitest.config.js`. Browser project includes a CORS-config wrapper Worker if needed.
- [ ] Port all 5 Vue spike probes to the browser project (Q1 createApp, Q2 factory+Vue composition, Q3 recursive tree, Q4 auto-subscribe + exactly-once unsubscribe, Q5 v-model + middleware).
- [ ] Add real-browser-specific probes: focus/blur timing on `v-model`, MutationObserver paint scheduling, real WebSocket reconnect (vs jsdom shim).
- [ ] Debounce behavior verification: rapid keystrokes produce ≤ ceil(typing_duration / maxWaitMs) + 1 transactions; flush-on-unmount works; flush-on-blur works.
- [ ] IME composition events probe (Asian-language typing): multi-key character composition fires `compositionstart` / `compositionupdate` / `compositionend` events, NOT one `input` per intermediate keystroke. Verify exactly one transaction fires after composition ends.
- [ ] Flash-class design implemented + tested per chosen approach (option (a) or (b) from pinned decisions).
- [ ] Vue `<Suspense>` / `<KeepAlive>` interaction probes per the "Things that can't be fully assessed" risk list above.

#### Phase 5.3.7-v5 — Doc polish + secondary docs (~half day)

The main doc rewrite happened in v1; v5 covers anything that needed v3 implementation details to write correctly.

- [ ] Re-read [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) end-to-end against the shipped implementation. Fix any drift between doc claims and code behavior surfaced during v3/v4.
- [ ] Update [nebula-client.md](../website/docs/nebula/nebula-client.md) if NebulaClient surface changed during the spike's reshape.
- [ ] New page (or section): "Using @lumenize/nebula-frontend with Vue" covering single-HTML-file CDN load + debounce knobs. Include a "Security: CSP and template compilation" subsection that explains the in-DOM-mode `'unsafe-eval'` requirement, why Galaxy pre-compiles for production deploys, and the runtime-only Vue bundle the Studio-deployed apps use under strict CSP.
- [ ] Document the IME / composition behavior in the docs (most likely "huh, why does it do that?" support question).

**Deletions (post-merge):**

- [ ] `packages/state/` — entire directory, including 80 tests. Harvest test cases as comments in the factory's test file if any aren't already covered. **Delete only after its live consumers are removed, or the build/type-check breaks** (verified 2026-06-07 — `packages/state` is still imported by production code): the import at [nebula-client.ts:17](../apps/nebula/src/nebula-client.ts) (`deepEquals`, `StateManager`), the `"@lumenize/state"` dependency in [apps/nebula/package.json](../apps/nebula/package.json), and the two baseline suites [nebula-client-bindtostate.test.ts](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts) + [nebula-client-subscribe.test.ts](../apps/nebula/test/test-apps/baseline/nebula-client-subscribe.test.ts) (port their `createState`/`bindToState` usage onto the factory first). Survives in git history.
- [ ] `apps/nebula/spike/vue-factory/` — entire directory once 5.3.7-v2 lands. Keep until then for reference.
- [ ] `nebula-client.ts`'s `bindToState` + supporting machinery — replaced by the factory's middleware + effectScope.

**Dead-code audit (after the obvious deletions land):**

The Alpine → Vue pivot likely leaves orphaned helpers, types, and code paths beyond the three obvious deletions above. Catch them before they rot. Two complementary passes:

- [ ] **Coverage-driven sweep**: run `npm test` with coverage on `apps/nebula/` + `packages/nebula-frontend/` after v3 lands. Anything at 0% coverage that isn't a known untested-but-load-bearing path (e.g., test-only initiators marked `@internal`) is a candidate. Workflow: open each 0%-coverage file, ask "is the caller of this still alive?", delete if no.
- [ ] **Static review of changed files**: walk every file modified in the 5.3.7 series (`git diff --stat origin/main...HEAD -- apps/nebula packages/nebula-frontend packages/mesh`). For each, scan for: unused exports (the factory replaces `bindToState`'s plumbing — likely orphaned helpers in `nebula-client.ts`); types that only the Alpine path referenced (`StateManager` type imports, `BindingRecord`, `$local`-shape types, `getBindings`-related types); refcount/grace-period logic that's now driven by Vue's effectScope instead of the StateManager hooks; `setState` middleware bookkeeping (`oldValue` stash for rollback, `source` context tag, microtask-defer queue) that may have moved to the factory but left a shadow in NebulaClient.
- [ ] **Specific candidates to audit-and-decide-per-name** (NOT a "delete these" list — each is "confirm whether the new path replaces it, or whether it still owns a load-bearing concern"):
  - `#subscriptionRegistry` (NebulaClient) — factory's refcount Map owns auto-subscribe lifecycle, but NebulaClient may still need a view of subscriptions for the 5.3.4 reconnect re-subscribe path. Confirm before deleting.
  - `#perTypeResolvers` (NebulaClient) — likely RESHAPED into `#perTypeHandlers` for the merged `onTransactionResourceResolution` handler. v3 absorbs the old `ConflictResolver` registry into a unified handler registry. Confirm the new shape lives on NebulaClient (probably correct — the handler needs server-side dispatch context) vs the factory.
  - `#applyFlash` + `getBindings` plumbing — likely dead (Vue's reactive bindings replace the Alpine-style DOM bookkeeping), but verify against whatever flash-class mechanism v4 picks. If v4 picks the `client.bindings(rt, rid, field)` API, `getBindings` migrates rather than dies.
  - `internalDeepWrite` vs StateManager's `setState({ source: 'remote' })` — pick one path through; `@lumenize/state` is being deleted so the latter goes by default. Confirm no internal callers remain.
  - Reserved-prefix filter regex (`^resources\\.[^.]+\\.[^.]+\\.value(\\.|$)`) — does the factory's Proxy `set` trap still need it, or does the path-aware middleware express the same intent more naturally?
- [ ] **Probe the coding-your-ui.md doc against the shipped API**: every API surface mentioned in the v1-rewritten doc should resolve to a real export from `@lumenize/nebula-frontend` (the single front-end package — NebulaClient lives here too). Anything mentioned in the doc that doesn't exist is a TODO; anything exported that the doc doesn't mention is a candidate for deletion (the doc IS the spec post-v1).

**Out of scope for 5.3.7 (post-demo):**

- Galaxy-side template pre-compilation for production deploys (closes CSP `'unsafe-eval'` requirement). Architecture pinned in v3's risks list; implementation owned by Studio's deploy work.
- `flashClass` rich-diff support (field-level rendering of WHAT changed, not just THAT it changed).
- Multi-resource subscriptions / query subscribe (still out of scope per § "Out of scope (post-demo)").
- **Additional merge helpers beyond `textMerge`: `setUnion`, `counterMerge`, etc.** Ship from `@lumenize/nebula-frontend`'s top level when a real app needs them; per-type handlers call them from a `'use-this'` verdict. (Rejected: a `'crdt'` resolution kind — helpers don't add framework primitives; users opt in per-type.)
- **True CRDT-backed real-time collaborative editing** (Google-Docs tier) — much larger scope than merge helpers: needs per-character identity, op streaming, cursor preservation, and the CRDT state as source of truth (the string value is a lossy projection), i.e. a parallel data tier with its own wire format, persistence, and editor bindings. Defer until a Studio app actually needs it; capture as its own task file then. `textMerge`'s overlap-garble limitation is the accepted boundary until that day.

### Phase 5.3.8 — For-docs tests (one big `it`, narrative)

All async probes use `vi.waitFor` (Vue's reactive scheduler is microtask-deferred; grace periods need real time).

**Framework-agnostic probes** (run in headless / Node):

- [ ] Two clients subscribe to same resource; client A transactions; client B's bound store path updates via `handleResourceUpdate`.
- [ ] BroadcastChannel: client A doesn't receive own update via fanout; instead reflects authoritative value via `handleTransactionResult`'s success path.
- [ ] `'use-server'` verdict: handler returns `{ kind: 'use-server' }` from `'conflict-pending'`; framework writes server value through for that resource; handler fires again with terminal `{ kind: 'use-server', snapshot }`; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'use-server', snapshot } } }`.
- [ ] `'use-this'` verdict: handler returns `{ kind: 'use-this', value }`; framework submits new transaction with `eTag = server.meta.eTag`. Verify recursion: second submission also conflicts → handler fires again with `'conflict-pending'` → eventually succeeds. Transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'committed', eTag } } }`.
- [ ] `maxRetries` exhaustion: handler always returns `'use-this'`, every submission conflicts; after default 5 attempts, handler fires with terminal `'retries-exhausted'` and transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'retries-exhausted', snapshot, attempts: 5 } } }`.
- [ ] `'human-in-the-loop'` verdict: handler returns the handoff; handler fires again with terminal `'human-in-the-loop'`; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'human-in-the-loop', snapshot } } }`; optimistic state stays painted (NOT overwritten); no new transaction; test then manually submits follow-up.
- [ ] Per-call override **fall-through** (deep-review M9): `transaction(ops, { onTransactionResourceResolution: perCall })` layers in front of — does NOT replace — per-type handlers, consulted for every resource in the batch. (a) On `'conflict-pending'`, `perCall` returning `undefined` falls through to the per-type handler, then the framework default; first non-`undefined` verdict wins. (b) **Shadow regression probe (the M9 case):** a mixed-type batch `{ todo: <conflict>, todoList: <conflict> }` with a `perCall` that handles only `todo` (`if (rid !== 'todo') return`) and a per-type `todoList` set-union handler registered → assert the `todoList` conflict resolves via the per-type set-union (NOT framework `use-server`), proving the per-call override didn't shadow it. (c) Terminal branches: per-type handler fires for every resource even when a per-call override is present.
- [ ] Default flash classes: `'committed'` resolution adds `lumenize-commit-success` class to bound elements; rollback resolutions (`'use-server'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) add `lumenize-conflict-revert`; both removed after `flashDuration` ms. Test default class, custom per-type `flashClass: { committed, rolledBack }`, and `flashClass: { committed: null, rolledBack: null }` disabling both.
- [ ] Idempotency replay **matrix** (B3 — resolved 2026-06-10; shipped baseline in `nebula-client-read-transaction.test.ts` covers {single create, no churn} and {create+create, churn on one sibling} — the put, delete, and create+put cells broaden here for docs): retry the **identical ops** with the same `newETag` across `{create, put, delete, create+put}` × `{no churn, third-party churn between original and retry}`. **Per-cell expected outcomes (pinned 2026-06-11, review-round-3; do NOT blanket-assert `committed` or an implementer weakens the monotonic pre-check to ship green).** Unifying rule: *a replay resolves `committed` iff ≥1 written resource still carries `newETag` at retry; otherwise it's processed fresh* — ADR-005 forward-only eTags + no dedupe ledger mean that once a third party has churned the replayed resource the evidence is gone, and surfacing that is correct, not a bug. Every cell also asserts **the replay writes nothing** (no double-apply).
  - **no churn** (create / put / delete / create+put): `committed` (replay detected at Step 4.5a / 6.5 via `.some`).
  - **create+put, partial churn** (third party churns ONE batch sibling; the other still carries `newETag`): `committed` via `.some`. This + create-no-churn are the regression guards — they throw against the pre-fix `.every` ordering.
  - **put / delete, churn-of-the-replayed-resource-itself**: `conflict` (current eTag ≠ the op's baseline → resolver fires with the third party's `currentSnapshot`), NOT `committed`. The original write did land; it was then superseded, and the retry correctly surfaces the superseding value.
  - **create, churn-of-self** (and create+put full-churn): **invariant only — assert the retry does NOT return `committed` and writes nothing (no silent double-create); do NOT hard-assert the exact error shape.** Today it throws "already exists" → `infrastructure-error`; whether that becomes a typed `already-exists` / `conflict` resolution is the still-open **M11 create-on-existing taxonomy decision** (v3 scope — blast radius across every create), so the test stays M11-agnostic and survives whichever way that lands. Root cause + fix: idempotency is checked as a monotonic fast-fail **before the validator** (`resources.ts` Step 4.5a — the only early-return; it discloses nothing but eTags) AND authoritatively **before op-validation inside `transactionSync`** (Step 6.5), using `.some` (any resource at `newETag` ⇒ the atomic batch committed), not `.every`. **eTag conflicts are NOT pre-decided** (review-round-3 security fix): Step 4.5b only *marks conflict-suspect resources to skip the validator batch* — the conflict verdict and the `currentSnapshot` disclosure happen solely at Step 9, **after** the Step-8 permission gate (an early conflict return carrying `currentSnapshot` was a permission-free cross-user read via a wrong-eTag `put`). Also probe: a conflict + invalid value co-occurring on one resource resolves as **conflict**/`use-server` (the suspect's validation is skipped, so the conflict surfaces at Step 9), not `validation-failed`; and an unauthorized `put` with a wrong eTag resolves `permission-denied` carrying **no** snapshot. Both probes shipped in `nebula-client-read-transaction.test.ts` (gut the skip-hint → co-occurrence flips to `validation-failed`; restore the leaky early-return → disclosure probe leaks `currentSnapshot`).
- [ ] `client.resources.read(rt, rid)` returns current snapshot without writing to bound store.
- [ ] Staleness probe: client constructed with `'v1'`, server now `'v2'`; transaction → `onShouldRefreshUI` fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`; transaction Promise resolves with `{ kind: 'ontology-stale', ... }`.
- [ ] Connection-state probe: trigger LumenizeClient connection events programmatically; assert `lmz.connection.state` / `lmz.connection.connected` / `lmz.connection.lastConnectedAt` paths update correctly on each transition.
- [ ] Permission-denied probe: attempt a write the user isn't authorized for; handler fires with terminal `{ kind: 'permission-denied' }`; that resource's optimistic state rolls back to last-confirmed; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'permission-denied' } } }`.
- [ ] Mixed multi-resource probe: transaction with two resources where one handler returns `'use-server'` and the other has no handler registered but server returns permission-denied; Promise resolves with `{ kind: 'ok', resources: { [ridA]: { kind: 'use-server', ... }, [ridB]: { kind: 'permission-denied' } } }`. Verifies the per-resource map is populated and each resource's optimistic state is handled per its individual `TransactionResourceResolution`.
- [ ] Infrastructure-error probe: simulate a network drop mid-transaction (or mesh crash); transaction Promise resolves with `{ kind: 'infrastructure-error', error }` carrying the underlying `Error`. Optimistic state rolls back. **The Promise must NOT reject.**
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant).
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during disconnect.
- [ ] orgTree delivery probe: `subscribeTree` → synthesized snapshot arrives at `store.lmz.orgTree` (Map/Set wire fidelity — nodes Map, edges Set, permissions nested Map); client A mutates via `client.orgTree.*` → both A's and B's `store.lmz.orgTree` update (originator included — dedicated channel, no exclusion).

**Vue-specific probes** (need component lifecycle + real-browser for some):

- [ ] Auto-subscribe: Vue component reading `store.resources.{rt}.{rid}.value.<field>` in a template triggers `client.resources.subscribe` automatically on mount.
- [ ] Dynamic mount: mounting a new Vue component instance with a new `(rt, rid)` triggers `subscribe`.
- [ ] Component-unmount + grace period: unmount a component referencing `(rt, rid)`; refcount → 0; `unsubscribe` does NOT fire immediately; after `unsubscribeGraceMs`, fires.
- [ ] Grace-period cancel: unmount + remount within grace (e.g., via `v-if` toggle); pending `unsubscribe` is cancelled (never fires).
- [ ] `<KeepAlive>` interaction: cached component referencing a resource stays subscribed across activate/deactivate cycles (or properly unsubs+resubs — pin during v4).
- [ ] `v-for` inline-array iteration: N items render correctly; mutations (push/pop/reorder) update correctly with `:key` preserving instance identity.
- [ ] `v-for` FK with nested resource read: auto-subscribe fires per ID inside the loop body; removal triggers grace-period unsubscribe.
- [ ] `v-if` mount/unmount: bindings register/unregister with the conditional content.
- [ ] `v-for` + nested `v-if` (filtered iteration): clones mount/unmount independently.
- [ ] Vue `computed()` driving `v-if`: derivation re-runs on source change; `v-if` reacts.
- [ ] Flash class: after `'use-server'` where local differed from server, framework flashes bound elements at diff fields; removed after `flashDuration` ms. Test default class, custom class, and `flashClass: null` disabled. Implementation depends on the chosen flash mechanism (see api-reference.md § Handler bindings).
- [ ] Resolver `context.bindings`: third-arg context exposes elements bound to paths under the conflicting resource (deferred-post-5.3.7; probe verifies the empty-Map placeholder until the real mechanism lands).
- [ ] **IME composition** (real-browser only): multi-key character composition (e.g., Japanese input) fires `compositionstart` / `compositionupdate` / `compositionend` events; exactly one transaction fires after composition ends, not one per intermediate keystroke.
- [ ] **Debounce flush-on-blur**: pending debounced write flushes when the bound input loses focus, even if the quiet window hasn't elapsed.
- [ ] **Debounce maxWait**: continuous typing across the maxWait boundary produces ≥1 transaction per maxWait window, not zero.
- [ ] **Per-field debounce from ontology**: validator bundle carries per-field `quietMs`/`maxWaitMs`; field-type defaults (boolean → eager, etc.) and explicit `@debounce(...)` / `@longform` annotations both apply. Resource-level merge rule: shortest active timer wins (clicking a `@debounce(0)` checkbox flushes pending text-field edits too).
- [ ] **Runtime debounce override**: `client.resources.transactionDebounce(rt, opts)` overrides the ontology-derived config for a type at runtime (precedence: runtime > annotation > type-default > framework-default).

## Out of scope (post-demo)

- **Multi-resource subscriptions** — `subscribe()` for a query result. Big design space; needs query language.
- **Large-fanout architecture** — tiered fanout through Worker armies for >64 subscribers per resource. See `tasks/nebula-scratchpad.md` § "Fanout Broadcast Tiering."
- **Per-mutation guards on fanout** — re-checking DAG permission per subscriber per push. Demo accepts subscribe-time-only check.
- **Subscription to specific subtrees vs full tree** — DAG-tree-level subscriptions (different from resource subscriptions).
- **NebulaClient polish**: discovery-first login (tests bypass with `?_test=true`), WebSocket keepalive + `setWebSocketAutoResponse`, proactive token refresh, scope-switching UX. All deferred per `tasks/archive/nebula-7-client.md`.

## Open Questions

Still open:

1. **Permission revocation mid-subscription** — if admin revokes read permission on a node while subscribed, existing subscribers still fanout. Acceptable for demo; DAG-mutation path needs to invalidate subscribers for production.
2. **`getEffectivePermission` per-subscriber on notification?** Probably no for demo; revisit for production.
3. **Query language** — "all todos where status='open'" with result-set subscription. Deferred to own phase (query shape, server-side execution, result-set subscription semantics, pagination, cursor stability across migrations).

Resolved (final answers only; mechanics live in the shipped code + summaries above): subscriber cleanup on disconnect → drop-on-failed-fanout; deploy-time re-evaluation → all subscriptions invalidated on ontology install (DROP+CREATE); subscription identity → `(clientId, resourceType, resourceId)`, `clientId` = Gateway `instanceName` (multi-tab = distinct clientIds, no generated subId); `read()` Promise correlation → per-call `requestId` + hidden `handleReadResponse` (transactions need none — serial queue).

## Phase -1: Captured Ideas

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Triage outcomes: do-now / later-task-file / backlog / drop. Resolve everything here before archiving this file.

1. **Same-field conflict cascade during async resolver** (typing into the field that's mid-conflict re-pops the modal). **Triage: not solving for v1** — the debounce + serial-queue design coalesces typing-during-modal into one buffered transaction at the post-resolver eTag, so only typing across the maxWait boundary can re-pop; Studio modals grab focus anyway.

2. **Re-conflict during human-in-the-loop batch resolution** (review-later batch churns again → user reviews again). **Triage: probably fine** — the user is already in review mindset. Revisit a "this is a re-resolution" signal if real Studio markup exposes the friction.

3. **Client-side routing** — resolved: `vue-router` (pinned decisions). URL-params-into-store ≈ ~10 LOC of `watchEffect`, or a `useRouteSync(map)` composable if Studio templates want it factored.

4. **Client-side typia validator for instant form validation.** Server-side validation ships already; this is only the "red border while typing" UX. Single-origin URL structure means no CORS in the design space (validator serves from the same origin, e.g. `/_lmz/validator/{universeGalaxy}/{version}/validator.js`; immutable per version → CDN-friendly). Open: delivery mechanism (`<script>` allowlist vs `'unsafe-eval'`) and serving home — coupled to the open Studio-UI-hosting decision ([nebula-studio.md](nebula-studio.md)). **Triage: defer to its own design pass post-demo**; rejection-on-submit covers data integrity for demo.

5. **Subscriber tidy-up — resolved: deploys ARE the cleanup event.** Three-mechanism model (all shipped): active-WS-close cleanup, ontology-install `Subscriptions.clear()` + push-on-clear (immediate staleness signal to connected subscribers — no Galaxy hop, no TTL cache), drop-on-failed-fanout for closed tabs. Rejected: `subscribedAt`-TTL alarm sweep (row birthday ≠ last-proven-alive under auto-reconnecting WS); `validFrom`-age heuristics (quiet ≠ unwatched — the TV dashboard counterexample); Galaxy broadcast-on-version-bump (plumbing + thundering herd). `subscribedAt` stays as forensic metadata only. Monitor: per-deploy re-subscribe RTT churn if deploy cadence ever hits minutes-per-deploy — add re-subscribe batch-debounce then.

6. **Lifecycle hooks — resolved: stock Vue (`onMounted`/`onUnmounted` etc.), zero custom surface.** Deferred candidates and why: per-subscription hooks (duplicative of existing Promises + handler), per-transaction hooks (TransactionOutcome covers every terminal state), `onScopeChange` (scope switch = page reload today), whole-app `onReady`/`onError` (`v-if` on `lmz.connection.connected` covers splash; `onError` is a future observability story).

7. **DAG-tree delivery — resolved by design B** (the dedicated-channel checklist item under Phase 5.3.7-v3, which is authoritative). The "orgTree-as-a-resource / reuse the subscribe plumbing" framing was rejected: the tree genuinely isn't a resource (incremental-mutation API, universal visibility, synthesized-not-stored), and the reuse required reserved-namespace guards that a dedicated channel makes unnecessary. **Still deferred — broadcast at scale** (full-snapshot-per-mutation is the demo ship; revisit when a real workload exposes O(nodes × subscribers) cost). Cheapest-first options, recorded for that day: (A) eTag-bump-and-pull (fanout carries only the new eTag; clients that care re-read — no API change); (B) op-broadcast (`dag-ops.ts` is a pure functional core that runs in the browser; broadcast the op, clients replay — tiny wire cost, needs seq-gap detection + confirmed-apply); (C/D) generic snapshot-diff — `@lumenize/structured-clone`'s W4 wire format + RFC 7396 `diff`/`applyMergePatch` already exist ([PR #11](https://github.com/lumenize/lumenize/pull/11)), integration captured in [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md). Full option analysis: git history of this file.

8. **Multi-resource conflict-resolver semantics — resolved into v3 scope.** The 5.3.3c "first-conflict wins" simplification is replaced by per-resource handler invocations + the per-resource map on `TransactionOutcome.resources` (validated in [factory-conflict-outcome.md](factory-conflict-outcome.md)).

9. **Auto-retry on transient failures (`'infrastructure-error'`, `'timeout'`).** Pinned: caller-decided retry (`newETag` idempotency makes manual retry safe). Deferred proposal if boilerplate fatigue surfaces: `TransactionOptions.retryPolicy?: { maxAttempts, backoffMs }` — same `newETag` resubmit loop, ~30 LOC, pure addition. Deferred because retry policy is an app decision (saving-UX vs fire-and-forget) and auto-retry can mask real connectivity issues.

## Notes

- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design."
- Fanout > 64 subscribers (large-fanout tiering) intentionally not designed here. Demo runs with a handful of subscribers max.
- This file consolidates and supersedes `tasks/archive/nebula-5.3-subscriptions.md`, `tasks/archive/lumenize-ui.md`, and `tasks/archive/nebula-7-client.md`.

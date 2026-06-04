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
> 4. Spike code lives in `apps/nebula/spike/alpine-adapter/` — kept until 5.3.7-v3 ports it to `packages/nebula-frontend/`, then deleted (dir name is a historical artifact from the predecessor Alpine spike).

History note: this file consolidates the originals `nebula-5.3-subscriptions.md`, `lumenize-ui.md`, and `nebula-7-client.md` (now in `tasks/archive/`). Some shipped pieces (`@lumenize/state`, `bindToState`) are scheduled for deletion in 5.3.7-v3 — listed under § "Phase 5.3.7" → "Deletions". For the full step-by-step history of decisions and pivots, see `git log` on this file.

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

Total ~350 LOC across the factory + debounce + helpers. Vue owns the DOM crawler, directive grammar, MutationObserver lifecycle, per-element binding registry, and per-component scope; our layer is the bridge from Vue's reactivity to NebulaClient's wire protocol. The path-based PUBLIC API surface (`store.resources.<rt>[id].value.<field>`) is preserved by the factory's path-aware outer Proxy — see [memory: path-based-public-api-on-vue-reactivity](https://github.com/lumenize/lumenize/blob/main/.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_path_based_reactivity.md).

## Package picture

| Package | Source | Scope | Status |
| --- | --- | --- | --- |
| `vue` | npm (`^3.5`) | Reactivity engine + in-DOM template compiler + directive grammar (v-*, recursive components, v-model). Transitive dep of `@lumenize/nebula-frontend`. | Used as-is |
| `@lumenize/nebula-frontend` | Written from scratch (factory pattern validated by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md)) | `createNebulaClient(config) → { client, store, use, dispose }` factory + small Vue composables (`useNebula`) + `textMerge` helper. Debounce + per-field config consumed from the ontology-derived validator bundle (no custom Vue directive). ~300 LOC factory + ~50 LOC debounce + helpers. UNLICENSED until Nebula ships externally. NebulaClient ALSO moves here from `apps/nebula/src/` in 5.3.7-v3. | Built in Phase 5.3.7-v3 |
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
| **Fan-out path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)`. | Same Handler 1 / Handler 2 plumbing used by `transaction()` and `read()`. |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required); `bindingName` + `instanceName` from `callContext.callChain.at(-1)`. | Subscriptions are user-initiated, not mesh-to-mesh. |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber. | Prevents double-render when originator already updated optimistically. |
| **Guard placement** | DAG read-permission check once at subscribe time, not on each fanout. | Resource-level access doesn't change mid-subscription except via DAG mutation (separate concern). |
| **Auto-resubscribe on reconnect** | Client maintains local subscription registry; on LumenizeClient `connected` event after `reconnecting`, re-subscribe each entry. | LumenizeClient already auto-reconnects; only need to re-register. |
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. State path is fixed at `resources.{resourceType}.{resourceId}` (the `statePath?` override on subscribe was dropped in 5.3.3a — entire-resource-at-a-time addressing only). | Period-delimited state paths and slash-delimited URLs must be unambiguously interconvertible. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings reactive to bulk-snapshot pushes without spurious re-renders. |
| **Reserved state-path prefixes** | Two top-level prefixes are framework-reserved: `resources.*` (synced resource snapshots — `resources.{rt}.{rid}.value` and `.meta`) and `lmz.*` (everything else framework-owned — connection state, future things). All other top-level segments (`ui.*`, `app.*`, etc.) are app-owned. Framework only touches `resources.*` and `lmz.*`. | Two prefixes, not one. `lmz.resources.*` would be strictly consistent but adds a segment to every directive in every UI — significant ongoing ergonomic cost. `resources.` is short and distinctive enough on its own; `lmz.` covers the rare framework-meta cases. App authors get the rest of the namespace. |
| **`lmz.connection.*` connection-state surfacing** | The factory writes LumenizeClient's connection state to `lmz.connection.*` paths so the UI can bind declaratively. Paths: `lmz.connection.state` (`'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'`); `lmz.connection.connected` (boolean — true iff `state === 'connected'`); `lmz.connection.lastConnectedAt` (timestamp ms, set on each `'connected'` transition). Initial seed values: `'disconnected'` / `false` / undefined. Factory must be created BEFORE awaiting connection so the initial transition isn't missed. | Real-time-sync demos need a visible connection-state indicator. Surfacing as paths on the reactive store makes it declarative: `<div v-show="!store.lmz.connection.connected">Reconnecting…</div>` works without event listeners. Three paths cover common cases (state string for fine-grained display, boolean for show/hide, timestamp for "last synced X ago" UX). |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. | Cleaner than separate `txnId` — no server-side dedupe table, idempotency implicit in the eTag itself. Auto-retry safe across network drops. |
| **Transaction queue** | Serial — at most one transaction in flight per client; subsequent calls queue. 5–10 s timeout then resolve the in-flight Promise with `{ kind: 'timeout' }` (queue unblocks). Caller-decided retry. Queue blocks transactions on *all* resources/fields, not just the in-flight one. Optimistic local state still paints immediately (the middleware does the optimistic write first, then enqueues) — so the user sees their typing land regardless of queue state. Queue is in-memory only; refresh clears it. | Matches human editing speeds; avoids partial-application reasoning. Timeout collapses all "I don't know what happened" failure modes to one signal. Optimistic-paint-then-enqueue means visual responsiveness is unaffected by queue depth. |
| **Handler execution suspends queue timeout** | When the per-type handler returns a Promise from its `'conflict-pending'` branch (async resolver), the 5–10 s queue timeout is suspended until the Promise settles. When the framework submits the next transaction post-resolver, a fresh timeout starts for that submission. No max-duration enforced on the handler itself — a modal can sit open for minutes if the user gets distracted. | The 5–10 s timeout is for "I don't know what happened to this call" cases. During handler execution, the framework knows exactly what's happening — the user has the modal. App-level timeouts on the handler (e.g., "auto-cancel after 30s") are the caller's responsibility via `Promise.race`. |
| **Per-type resource handler** | Single per-type handler registered via `client.resources.onTransactionResourceResolution(rt, handler, options?)`. Per-call override via `options.onTransactionResourceResolution` on `transaction()`. Handler fires once per resource per transaction with a `TransactionResourceResolution`; the same handler does both jobs — return a `ConflictResolverVerdict` from the `'conflict-pending'` branch to drive the chain, and react to terminal branches (`'committed'`, `'use-server'`, `'human-in-the-loop'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) for UX side-effects. Framework defaults: `'conflict-pending'` returns `{ kind: 'use-server' }`; terminal branches do nothing (framework's default flash classes apply automatically). | Single mental model: per-resource concerns are in the handler; per-transaction concerns are at the await-site. Same handler can fire multiple times across `'use-this'` chains. Per-resource granularity means different resources in the same transaction can land at different verdicts. |
| **Default flash classes** | `'committed'` → `lumenize-commit-success` (green outline animation). Rollback outcomes (`'use-server'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) → `lumenize-conflict-revert` (red outline animation). Default duration 1000 ms. Configurable per type via the handler's `options.flashClass` (object with optional `committed` / `rolledBack` keys; `null` for either disables that default) and `options.flashDuration`. `'human-in-the-loop'` and `'conflict-pending'` get no default flash (app owns those visuals). | Symmetric green-success / red-rollback signal without any app code. Field-diff inference means only actually-affected fields flash. App overrides for cases where the default visual doesn't fit. |
| **`ontologyVersion` on every operation** | NebulaClient constructor argument (Studio's bootstrap fills in at build time). Auto-attached to every `client.resources.*` call. `options.ontologyVersion` per-op override for admin scripts. | Lock-step UI/ontology. Star already takes it for Handler 1/2 dispatch. |
| **Staleness signal + `onShouldRefreshUI` hook** | Star's cache-miss-with-mismatch path returns `{ kind: 'ontology-stale', clientVersion, currentVersion }`. NebulaClient dispatches to registered `onShouldRefreshUI` constructor hook (no default — undefined = opted-out). Originating Promise also settles. | Centralized hook for an orthogonal signal that multiple call sites would otherwise each need to inspect. Distinct from earlier-rejected `onStaleVersion` (which was tied to one error path). |
## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` with a `TransactionOutcome` (always-resolves; never rejects). Per-resource detail goes to the per-type `onTransactionResourceResolution` handler. | Transaction-wide: `'ok'`: resolve (handler already fired for each resource); `'ontology-stale'`: resolve (also dispatches to `onShouldRefreshUI`); `'timeout'`: resolve (queue-timer driven); `'infrastructure-error'`: resolve (network/mesh failure wrapped, NOT thrown). Per-resource: handler invoked synchronously inline with each resource's `TransactionResourceResolution`. | Per-resource state writes happen during handler dispatch: `'committed'` → write eTag, default green flash; `'use-server'` → write `server.value` + `meta`, default red flash; `'use-this'` → optimistic write `value`, submit next attempt; `'human-in-the-loop'` → optimistic stays painted, no flash; `'validation-failed'` / `'permission-denied'` / `'retries-exhausted'` → rollback that resource, default red flash. Transaction-wide failures (`'timeout'` / `'infrastructure-error'` / `'ontology-stale'`) → rollback ALL optimistic writes for the transaction. |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves initial-snapshot Promise from `client.resources.subscribe()`; thereafter, fanout pushes from `Star.#fanout` | only first call settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `resources.{rt}.{rid}.value` and `meta` to `resources.{rt}.{rid}.meta` |
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
    options?: {
      ontologyVersion?: string;
      newETag?: string;                                       // override for idempotency-retry
      onTransactionResourceResolution?: ResourceHandler;      // per-call handler (precedence over per-type registered)
      maxRetries?: number;
    },
  ): Promise<TransactionOutcome>;  // ALWAYS resolves — switch on outcome.kind

  /**
   * Register a per-resource-type handler. Fires once per resource per transaction
   * with a TransactionResourceResolution. Handler MAY return a ConflictResolverVerdict
   * from its 'conflict-pending' branch to drive the chain; undefined falls through
   * to the framework default (use-server). Other branches: return ignored.
   * Per-call override available via options.onTransactionResourceResolution on transaction().
   */
  onTransactionResourceResolution(
    resourceType: string,
    handler: ResourceHandler,
    options?: {
      maxRetries?: number;        // default 5; on cap, that resource's resolution is 'retries-exhausted'
      flashClass?: {
        committed?: string | null;   // default 'lumenize-commit-success'; null disables
        rolledBack?: string | null;  // default 'lumenize-conflict-revert'; null disables
      };
      flashDuration?: number;     // default 1000 (ms)
    },
  ): void;
};
```

NebulaClient constructor gains:

- `ontologyVersion: string` — auto-attached to every operation
- `onShouldRefreshUI?: (info: { clientVersion: string; currentVersion: string; reason: 'ontology-stale' }) => void` — centralized hook for staleness signal

### Integration entry point — `createNebulaClient(config)`

`createNebulaClient(config)` from `@lumenize/nebula-frontend` is the integration entry point. It folds four responsibilities into the factory's outer Proxy + middleware + effectScope-tied refcount + connection observer:

1. **Local writes → remote transactions** — outer Proxy `set` trap → synced-state middleware → debounced `client.resources.transaction(...)`.
2. **Auto-subscribe via reference counting** — `trackResourceRead` driven by `getCurrentInstance().scope` + `onScopeDispose`. Refcount-with-grace; `unsubscribeGraceMs` knob.
3. **Remote pushes direction** — `client.onResourceUpdate(...)` handler writes through `internalDeepWrite` with `context.source === 'remote'` (middleware sees the context and skips).
4. **Connection-state surfacing** — factory wires `client.onConnectionStateChange` directly. **Order invariant**: factory must be created BEFORE awaiting connection.

Full surface details in § "Phase 5.3.7" below + [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) + [api-reference.md](../website/docs/nebula/api-reference.md).

### Types

```typescript
/**
 * What `client.resources.read` and `client.resources.subscribe` resolve with,
 * and what `handleResourceUpdate` receives for each push. Synced state lives at
 *   - `store.resources.{rt}.{rid}.value` — the resource value, structured-clone
 *     compatible. Ontology-typed for app data; raw `string` for source files;
 *     `ArrayBuffer` for binary uploads. The framework writes value as-is.
 *   - `store.resources.{rt}.{rid}.meta` — framework-owned metadata.
 *
 * For binary content (uploaded images, generated blobs), `meta.mimeType`
 * tells you how to interpret `value`. Maps cleanly to MCP's
 * TextResourceContents / BlobResourceContents split.
 */
interface Snapshot {
  value: unknown;
  meta: SnapshotMeta;
}

/**
 * Framework-owned metadata for every resource snapshot. Only `eTag` is
 * required; the rest are optional and set only when meaningful for the
 * resource type / state.
 *
 * **User code reads from meta; only the framework writes.** Writes to
 * `resources.{rt}.{rid}.meta.*` from user code pass through middleware
 * unchanged (server-owned, intentional) but are warned-on in debug builds.
 */
interface SnapshotMeta {
  /** Client-generated UUID; doubles as optimistic-concurrency token and idempotency key for retries. */
  eTag: string;

  /** Resource type name as declared in the ontology. Used by subscribe-time type-mismatch checks and fanout dispatch. */
  typeName?: string;

  /** When the snapshot was committed server-side (ISO 8601). */
  validFrom?: string;

  /**
   * True for soft-deleted (tombstoned) resources. Subscribers still receive
   * these — clients inspect this flag instead of getting a `null` sentinel.
   * Lets templates distinguish "deleted server-side" from "snapshot hasn't
   * arrived yet."
   */
  deleted?: boolean;

  /**
   * IETF media type (RFC 6838) describing how to interpret `value`. Set on
   * resources where MIME is meaningful: source files, uploaded blobs,
   * generated assets. Resources without natural MIME (typical app data) omit
   * the field.
   *
   * Used by:
   *   - REST endpoints (`GET /resources/...`) to set `Content-Type` on serve.
   *   - Studio's compile pipeline to dispatch SFC compile vs. TS transpile
   *     vs. raw-asset paths on file-resource writes.
   *   - MCP bridges — matches MCP's resources-spec `mimeType` field.
   *
   * Full `Content-Type`-style strings with parameters are allowed
   * (e.g., `text/html; charset=utf-8`).
   *
   * Added 2026-05-15 alongside the Studio "files as resources" design
   * (see [tasks/nebula-studio.md](nebula-studio.md) § "Files as resources").
   */
  mimeType?: string;

  // Additional framework-owned fields can land here over time (e.g., per-
  // field change metadata for fine-grained UX). The shape is meant to grow.
}

/**
 * `client.resources.transaction()` returns `Promise<TransactionOutcome>` and
 * **always resolves** — never rejects. Infrastructure failures (network
 * drops, mesh crashes) come back as `{ kind: 'infrastructure-error',
 * error }` so callers handle every transaction-wide terminal state in one
 * switch. Per-resource outcomes go to the per-type handler (or its per-call
 * override) — NOT to the await-site switch.
 *
 * Discriminant key is `kind` (uniformly — same for the per-resource
 * `TransactionResourceResolution` below). The variable name (`outcome` vs
 * `resolution`) carries the level distinction.
 *
 * Rationale for always-resolve over reject-on-failure: Studio-generated UIs
 * are LLM-authored. Switching on every variant forces every transaction-wide
 * terminal state to be handled explicitly — a bare `try/catch` would swallow
 * the discrimination and conflate transaction-wide failures with per-resource
 * outcomes (which belong in the handler, not at the await-site).
 */
type TransactionOutcome =
  // Transaction completed — per-resource handlers have fired. Inspect
  // `resources` only if aggregate decisions at the await-site are needed.
  | { kind: 'ok'; resources: Record<string, TransactionResourceResolution> }

  // Transaction-wide failures.
  | { kind: 'ontology-stale'; clientVersion: string; currentVersion: string }
  | { kind: 'timeout' }
  | { kind: 'infrastructure-error'; error: Error };

/**
 * What the per-type handler receives for each resource in each transaction.
 * Fires once for terminal branches; for the non-terminal `'conflict-pending'`
 * branch, it may fire multiple times across a `'use-this'` chain before the
 * resource reaches a terminal resolution.
 */
type TransactionResourceResolution =
  // Non-terminal — handler MAY return a ConflictResolverVerdict to drive the
  // chain. Undefined return falls through to framework default ({ kind:
  // 'use-server' }).
  | {
      kind: 'conflict-pending';
      local: { value: unknown; eTag: string };
      server: Snapshot;
      context: { bindings: Map<string, HTMLElement[]> };  // deferred-post-5.3.7; empty Map in 5.3.7
    }
  // Terminal — handler return is ignored.
  | { kind: 'committed';         eTag: string }
  | { kind: 'use-server';        snapshot: Snapshot }
  | { kind: 'human-in-the-loop'; snapshot: Snapshot }
  | { kind: 'retries-exhausted'; snapshot: Snapshot; attempts: number }
  | { kind: 'validation-failed'; errors: unknown }
  | { kind: 'permission-denied' };

/**
 * What the handler returns from its `'conflict-pending'` branch.
 * The `'use-this'` verdict is intermediate — never appears as a
 * TransactionResourceResolution branch — it triggers a recursive re-submission
 * with the handler-returned value at the server's current eTag. A successful
 * chain terminates in `'committed'`; a failed one in `'retries-exhausted'`.
 */
type ConflictResolverVerdict =
  | { kind: 'use-server' }
  | { kind: 'use-this'; value: unknown }
  | { kind: 'human-in-the-loop' };

/**
 * Per-type handler signature.
 */
type ResourceHandler = (
  resourceId: string,
  resolution: TransactionResourceResolution,
) => ConflictResolverVerdict | Promise<ConflictResolverVerdict> | void;
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
- 5.3.0 — `@lumenize/state` package ported from JurisJS.
- 5.3.1 — Star subscribe machinery: `Subscriptions` class + table at [apps/nebula/src/subscriptions.ts](../apps/nebula/src/subscriptions.ts), `@mesh subscribe`, Handler 1/2 + idempotent inserts; `subscriberBinding` column derived from `callChain.at(-1)?.bindingName`.
- 5.3.2 — Resource-mutation fanout + `Subscriptions.clear()` wired into `Star.#installState`; `NebulaClient.onBeforeCall` override to accept Star-mediated fanout.
- 5.3.3a — NebulaClient foundation: constructor `ontologyVersion` + `onShouldRefreshUI`, `bindToState(state)` minimal-binding form, `client.resources.subscribe(rt, rid)`, `handleResourceUpdate`, subscribe-call coalescing.
- 5.3.3b — `client.resources.read(rt, rid)` + `client.resources.transaction(ops, options?)` always-resolves; serial in-flight queue + 10 s timeout; `newETag` API; idempotency short-circuit; `TransactionError` widened with `'permission'` variant.
- 5.3.3c — Conflict-resolver machinery: `client.resources.onETagConflict(rt, resolver, options?)`, per-call override, `ConflictResolution` discriminated union, recursive `'use-this'` bounded by `maxRetries`, async resolver suspends queue timeout.
- 5.3.3d — Structured ontology-staleness signal (`OntologyStaleError` + `isOntologyStaleError` in `apps/nebula/src/errors.ts`); `onShouldRefreshUI` fires on transaction, read, and subscribe paths.

> **Scheduled for deletion in 5.3.7-v3**: `@lumenize/state` (Vue's `reactive()` + `effectScope()` replace it), `bindToState` and the supporting middleware/refcount machinery in `nebula-client.ts` (replaced by the factory). Test-case set from `@lumenize/state` will be harvested as factory tests. Full list in § "Phase 5.3.7" → "Deletions".

### Phase 5.3.0 — Port `@lumenize/state` (prerequisite) ✅ shipped 2026-05-12

Ported `StateManager` from JurisJS as `@lumenize/state` (MIT). Deletion + test-case harvest is scheduled in 5.3.7-v3.

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

- [x] `client.resources.onETagConflict(resourceType, resolver, options?)` per-type registration; per-call override via `options.onETagConflict` on `transaction()`. Precedence: per-call > per-type > framework default (`{ kind: 'use-server' }`).
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

### Phase 5.3.6.0 — `@lumenize/state` subscriber-registration hooks (prereq) ✅ shipped 2026-05-13

Added `onSubscriberAdded` / `onSubscriberRemoved` hooks to StateManager (~10 LOC + 8 tests) to support refcount-driven auto-subscribe. Replaced by `effectScope` + `getCurrentInstance().scope` in the factory; scheduled for deletion in 5.3.7-v3.

### Phase 5.3.6 — NebulaClient `bindToState` integration (headless) ✅ shipped 2026-05-13

Shipped the `bindToState` integration as the bridge between `@lumenize/state` and `NebulaClient` (169-test baseline). The four shipped responsibilities — write-through middleware, auto-subscribe refcount, connection-state surfacing, flash-class wiring — carry forward into the factory in 5.3.7-v3; `bindToState` itself + its supporting machinery are scheduled for deletion.

**Pinned decisions carrying forward to the factory** (filed 2026-05-13; load-bearing for v3):

| Question | Resolution |
| --- | --- |
| Middleware sub-path → full-value `put` | **Microtask defer.** Middleware returns `undefined` (writes pass through); after the write lands, read full `value` and submit `put`. |
| `Star.unsubscribe(rt, rid)` mesh method | **Add it.** Plain `@mesh()` method on Star — no ontology check; calls `Subscriptions.removeSubscriber(resourceId, clientId)` keyed off `callContext.callChain.at(-1)?.instanceName`. |
| Middleware scope: creates vs. puts | **Puts only.** Middleware only translates writes that have a cached `meta.eTag` for `(rt, rid)`. Creates go through explicit `client.resources.transaction(...)` calls. Missing `meta.eTag` → warn-and-skip via `@lumenize/debug`. |
| Initial connection-state on factory creation | **Replay current state immediately.** Read current connection state at factory creation time and write through to `lmz.connection.state` / `.connected` / `.lastConnectedAt`. Subsequent transitions write through via the connection-observer wrapper. |
| Flash-class wiring | **`getBindings` option.** Headless tests pass nothing — flash is a no-op. Default flash applies on `'use-server'` only; other rollback outcomes restore-without-flash. |
| Flash semantic for non-leaf bindings | **Exact-path only.** `getBindings(diffPath)` returns only elements bound to `diffPath` itself, not ancestors. Users who want elaborate flash UX get the full `bindings` Map in the resolver's `context` and can implement custom class-add logic there. |

Deferred items kept for the factory port:

- **Rollback failure-outcome tests** ✅ in-scope work shipped 2026-06-04 — see [archive/validation-failed-rollback.md](archive/validation-failed-rollback.md). Root cause was live-reference capture in `#middlewareFn` (fix: `structuredClone` at capture site). Three outcomes covered: `validation-failed`, `permission-denied`, `ontology-stale`. Deferred siblings (`timeout`, `retries-exhausted`) tracked in [nebula-scratchpad.md](nebula-scratchpad.md) § "Rollback failure-outcome sibling tests (deferred)".
- **Defensive registry cleanup on `unsubscribe`** + interleaving test: subscribe → disconnect WS → trigger 1→0 → wait > grace ms → reconnect → assert no resubscribe RTT for that key. Needs WS-disconnect tooling.
- **Spy-able `@lumenize/debug` output for tests** ✅ shipped 2026-06-04 — see [archive/debug-spyable-output.md](archive/debug-spyable-output.md). Cross-cutting; `setDebugSink` / `clearDebugSink` exported from `@lumenize/debug` (undocumented test-only API). Unlocked the bindToState warn-assertion test and is available for future error-path tests.

### Phase 5.3.7 — `@lumenize/nebula-frontend` factory + Vue integration

Scaffolds `@lumenize/nebula-frontend` around a factory (`createNebulaClient`) that wraps NebulaClient. Vue 3.5+ (with `.vue` SFCs compiled server-side per the 2026-05-15 pivot — see [spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md)) owns templates, directives, recursion, per-component scope; the factory owns the bridge from Vue's reactivity to NebulaClient's wire protocol. The framework target was originally settled by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md); the SFC variant was settled by the SFC dev-cycle spike.

**Pinned decisions:**

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Framework target** | **Reversed 2026-05-15.** Vue 3.5+ with `.vue` SFCs. Per-save compile runs in the user-local dev Star (per [nebula-branches.md](nebula-branches.md)) using `@vue/compiler-sfc`; runtime-only Vue (`vue.runtime.global.js`, ~22 KB gzip) ships to clients. *Original pin (in-DOM mode + template strings, no build step) is preserved here for history.* | Original rationale: Studio's "single HTML file + `<script src>`" target made the in-DOM compiler look mandatory. Spike-validated reversal (see [tasks/spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md) and RESULTS.md): `@vue/compiler-sfc` runs cleanly in Workers/DOs; per-save round-trip is sub-50 ms anywhere globally (user-local dev Star → eyeball stays in same region); SFC ergonomics for the LLM-author audience materially better. |
| **Pinia** | NOT taken as a dependency. The factory is the store. | Pinia's `defineStore` + composable pattern leans on SFC-bundled imports; the no-build path requires import maps that defeat the simplicity win. Re-evaluate post-spike if a real cross-component coordination need surfaces. |
| **`@lumenize/state`** | Replaced by Vue's `reactive()` + `effectScope()`. Package deleted in v3. | Vue's reactivity covers every load-bearing semantic the StateManager had — deep-equal dedup (via factory wrapper), hierarchical-notify (via Vue dep tracking), batched ancestor-write fanout (via Vue scheduler). The 80-test invariant set is harvested into the factory's tests. |
| **Factory shape** | `createNebulaClient(config) → { client, store, use, dispose }`. `store` is a Vue-reactive Proxy with middleware in the `set` trap. `client` exposes connection/transaction/subscription methods. Consumer wires it in Vue via `setup() { return { store }; }`. | One entry point; same API in Node and browser. Test-app pattern survives unchanged. |
| **Factory before `connect`** | `createNebulaClient(...)` must be called BEFORE the underlying NebulaClient's connection resolves. The `onConnectionStateChange` listener only fires on future transitions; late registration would miss the initial `connecting → connected` and leave `lmz.connection.*` unpopulated. | Discovered in spike harness debugging. Doc must establish this as the natural order. Alternative considered (factory replays current state on registration) is an option for 5.3.7 but adds API surface — the order invariant is simpler. |
| **Auto-subscribe scope resolution** | Factory checks `getCurrentScope()` first (synthetic test scopes); falls back to `getCurrentInstance()?.scope` from `@vue/runtime-core` for component renders. `onScopeDispose` registered via `scope.run(...)` because Vue's render-effect path doesn't activate the component's scope at `run()` time. | The structural gotcha. Vue components' render `ReactiveEffect.run()` only sets `activeSub` (dep tracking) and `shouldTrack` — it does NOT set `activeEffectScope`. So `getCurrentScope()` returns null inside renders unless we bridge. ~10 LOC. |
| **Per-component state** | Use Vue's native `setup()` with `ref` / `reactive` for local component state. NOT the factory's store, NOT a `$local` paths-into-store mechanism. | Vue idiom; no factory mechanism needed. Vibe coder reads as native Vue. Local state isn't synced anyway — it's per-component. |
| **`v-model` debouncing** | Synced-state middleware debounces transaction submission per-resource with **500 ms quiet window + 2000 ms maxWait** as framework defaults. Local optimistic write fires on every keystroke (no DOM-level debounce). Transactions flush on (a) quiet window elapse, (b) maxWait elapse, (c) component unmount, (d) input blur (when reachable). Per-resource serial queue ensures eTag races resolve correctly: when transaction T1 is in-flight, T2 buffers and gets submitted using T1's resulting eTag. **Per-field overrides come from the ontology** — annotations like `@debounce(0)` and `@longform` (and field-type-derived defaults: `boolean`/enum auto-eager) compile into the validator bundle the factory loads at startup. Resource-level merge rule when multiple fields have pending writes: **shortest active timer wins**. Runtime override via `client.resources.transactionDebounce(rt, opts)` for edge cases (A/B testing, dynamic config). | Per-keystroke transactions are network-chatty and pile up server-side. 500/2000 ms is the lodash-default-ish profile. Per-field control via ontology annotations (the same place field types are declared) instead of HTML-level modifiers — Studio's LLM generates the right defaults from field types; vibe coder never thinks about debounce. Resolves the earlier `v-model.eager` design — no custom Vue directive needed; field-type defaults + `@debounce(0)` annotation cover the click-to-commit case. |
| **`v-model` default trigger** | Per-keystroke (`input` event). Document `.lazy` (blur-triggered) as the standard escape for "I want to commit on blur." | Matches user expectation of "I see what I'm typing." Lazy is one modifier away. |
| **Per-type resource handler** | Replaces the shipped `client.resources.onETagConflict(rt, resolver, options?)` with `client.resources.onTransactionResourceResolution(rt, handler, options?)`. One handler per type does both jobs — return a `ConflictResolverVerdict` from the `'conflict-pending'` branch to drive conflict resolution; react to terminal branches (`'committed'`, `'use-server'`, `'human-in-the-loop'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) for UX side-effects. Per-call override via `options.onTransactionResourceResolution` on `transaction()`. | Consolidates two previously-separate hooks (conflict resolver + outcome notification) into one. The conflict path and the success/failure path are the same handler — vibe-coder LLM has one mental model for "what happens to a resource of this type." Framework defaults still apply (server-wins on conflict, default flash classes on outcomes) so registering the handler is optional. |
| **`__v_skip`** | Not used. Factory's Proxy passes through `__v_*` reads to the underlying Vue reactive, which answers correctly (`__v_isRef`, `__v_isReactive`, etc.). | Vue 3.5 in-DOM mode only probes `__v_isRef`. |
| **`v-if` on `v-model`-bound paths** | Idiomatic Vue: `<template v-if="store.resources.<rt>[id]?.value"><input v-model="store.resources.<rt>[id].value.title" /></template>`. The `v-if` guard is required because `v-model` needs a real l-value path. | Standard Vue pattern. Doc must show this — vibe coders won't infer it. |
| **In-DOM template tag case** | Component tags in markup written to `innerHTML` MUST be kebab-case (`<tree-node>`); the browser HTML parser lowercases tag names before Vue sees them. Inside template strings (parsed by Vue), PascalCase works. Doc must call this out. | Browser-parser semantics; not negotiable. |
| **Client-side router** | Use [vue-router](https://router.vuejs.org/) when Studio apps need routing. URL-params-into-store ≈ ~10 LOC of `watchEffect` in app code reading `useRoute()` (or a small `useRouteSync(map)` composable if Studio wants it factored). | Mature, well-documented, large LLM training corpus, integrates natively with Vue's reactivity. |
| **`flashClass` for conflicts** | Defer concrete design to 5.3.7 implementation. Two viable options: (a) `client.bindings(rt, rid, field)` returns the bound `HTMLElement[]` (Vue exposes via `useTemplateRef` + the factory tracking ref names); (b) ship a small `v-flash` custom directive that listens for path-level flash events. Pick during implementation. | Vue doesn't have an Alpine-style `getBindings` equivalent out of the box; either approach is small. |

**Prerequisites**: real-browser bundling of `@lumenize/nebula-frontend` is blocked by three pre-existing items (transitive `cloudflare:workers` import in `@lumenize/debug`, transitive `node:async_hooks` import in `@lumenize/mesh/client`, no CORS headers on NebulaAuth). All three plus a reusable real-browser test template are owned by [tasks/playwright-test-template.md](archive/playwright-test-template.md) — v2 below lands that task.

**Target package layout** (scaffolded in v3):

```
packages/nebula-frontend/
├── package.json          # UNLICENSED; deps: vue ^3.5, @lumenize/nebula-client
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

**Status (2026-05-14)**: initial draft of both docs completed. coding-your-ui.md rewritten end-to-end against the spike's validated patterns (recursive Vue components, `setup() + ref` for per-component state, `v-if` / `v-else-if` / `v-else`, `v-for` with foreign-key auto-subscribe, recursive DAG-tree worked example, side-by-side / click-to-edit / explicit-save form patterns). api-reference.md scaffolded with every surface tagged.

**Status (2026-05-15, late afternoon)**: spike complete — see [tasks/spike-sfc-dev-cycle.md](archive/spike-sfc-dev-cycle.md) and [apps/nebula/spike/sfc-devstar-loop/RESULTS.md](../apps/nebula/spike/sfc-devstar-loop/RESULTS.md). All four spike phases passed:

- `@vue/compiler-sfc` runs cleanly in Workers (kill criterion).
- End-to-end loop (WS register → compile → broadcast) works across single-peer, isolation, and fanout scenarios.
- Round-trip latency: sub-2 ms p50 local; ~36 ms p50 Pittsburgh→IAD deployed.
- Architectural correction landed: the SFC compile DO is the **user-local dev Star** (per [tasks/nebula-branches.md](nebula-branches.md)), NOT a regional Galaxy. Eyeball-to-dev-Star is single-digit ms anywhere globally — no cross-continent RTT in the per-save loop.

**v1 pivot decision: pinned "Vue 3 in-DOM mode with template strings" is reversed.** v1 resumes against SFC authoring. Doc chapters that simplify: the kebab-vs-Pascal case rule disappears (SFC `<template>` is real HTML), the "HTML-in-JS-strings" ergonomics tax disappears (templates are in `<template>` blocks), the runtime-compiler-in-the-browser discussion disappears (Galaxy and dev Stars pre-compile). Implementation home moves from Galaxy to the dev Star — see [tasks/nebula-studio.md](nebula-studio.md) § "Dev-mode Star: SFC compile + reload broadcast."

Remaining v1 work (now against SFC authoring):

- [ ] **Rewrite template-string-dependent doc chapters in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) against `.vue` SFCs.** Affected sections (identified during the 2026-05-15 design review): "Recursive components (e.g., tree views)" (template-string TreeNode example becomes an SFC), the DAG-tree worked example (template strings → SFCs throughout), the conflict-modal in "Optimistic concurrency" / "use-this verdict — async modal," the form patterns in "Read-only and editable views." Also remove the "Component tag case" bullet (kebab-vs-Pascal rule) and the runtime-compiler discussion (no in-DOM compiler when Galaxy / dev Stars pre-compile).
- [ ] **Resume the design-review pass** on coding-your-ui.md + api-reference.md against the SFC-rewritten content. Flag awkward code samples, surprising defaults, names that feel wrong, surprising `deferred-post-5.3.7` tags.

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

All four blockers + the real-browser test template shipped in commit `4baa75d` (mesh release at v0.25.x). The template is `packages/mesh/test/browser/` with its own adoption checklist README; v4 (`packages/nebula-frontend/test/browser/`) follows the same shape.

- [x] Item #1 — `@lumenize/debug` cloudflare:workers (via package-exports conditions + `@lumenize/auth/client` subpath)
- [x] Item #2 — `@lumenize/mesh/client` node:async_hooks (explicit CallContext threading in `lumenize-client.ts`, dropped ALS dep on the client side)
- [x] Item #3 — NebulaAuth CORS headers (`applyCorsPolicy` helper extracted into `@lumenize/routing`; routeNebulaAuthRequest accepts `cors` option; `LUMENIZE_APPROVED_ORIGINS` env binding threads through `apps/nebula/src/entrypoint.ts`)
- [x] Item #4 — `apps/nebula/test/browser/smoke.test.ts > round-trip` (stale 5.3.3b arity in test helper — switched to public `client.resources.transaction()` API)
- [x] Item #4b — Cross-test contention in browser tier (per-instance email routing via `X-Lumenize-Auth-Instance` header + email-test DO bucketing)
- [x] Real-browser test template / scaffolding (mesh browser tier: 4/4 green, real Cloudflare Email Sending → Email Routing → wrangler-dev → DocumentDO + SpellCheckWorker)

Bonus structural additions beyond the original v2 scope:
- `@lumenize/auth` ResolvedEmail.headers + per-message-type overridable header hooks (generic mechanism)
- `@lumenize/testing/wrangler` exports `spawnWranglerDev()` for vitest globalSetup files
- `@lumenize/mesh` `LumenizeClient` auto-derives `instanceName` when `accessToken` is supplied (papercut fix)
- Dynamic Vite `dynamicEnvProxyPlugin` (parameterized; same-origin proxy approach for real-browser tests)

See [tasks/playwright-test-template.md](archive/playwright-test-template.md) for the complete change log and [packages/mesh/test/browser/README.md](../packages/mesh/test/browser/README.md) for the adoption checklist that v4 will use.

#### Phase 5.3.7-v3 — Scaffold + factory + Vue integration (~2 days)

Implements the API surface fixed by v1's doc rewrite. The doc is the spec; this phase makes the doc true.

**Prerequisite**: [tasks/debounce-serial-queue.md](debounce-serial-queue.md) Phases D0 (spike) + D1 (state diagram) must complete before this phase starts. D2 (production port) IS part of v3 — the debounce work below assumes a validated design exists to translate.

- [ ] Scaffold `packages/nebula-frontend/` per CLAUDE.md "Standard Package Files" (UNLICENSED, `@lumenize/nebula-client` + `vue` deps, vitest configs for unit + e2e + browser projects).
- [ ] Port factory from `apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts`: Proxy wrapper, middleware chain, `effectScope` + `getCurrentInstance().scope` fallback, refcount + grace, `internalDeepWrite`, synced-state middleware. ~290 LOC.
- [ ] **Spike-port cleanup** (must address during the port, NOT after):
  - Remove the `console.log('[proxy get] ...')` debug print at [create-nebula-client.ts:229](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:229).
  - Add `.catch(() => {})` (or equivalent debug-log) to the `client.unsubscribe(...)` call at [create-nebula-client.ts:182](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:182) to match the `subscribe` path.
  - Seed `lmz.connection = { state: 'disconnected', connected: false }` initially (at [create-nebula-client.ts:82](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:82)) so first-paint reads aren't `undefined`. `lastConnectedAt` stays unset until first connect.
  - Add a debug-mode warning when `syncedStateMiddleware` drops a write because no `meta.eTag` exists ([create-nebula-client.ts:305-309](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:305)). The `v-if` guard pattern is supposed to prevent this case; an unguarded `v-model` would otherwise be invisibly broken in production.
  - Document the semantics of writes to `resources.<rt>.<rid>.meta.*` paths: the synced-state middleware regex only matches `value(\.|$)`, so meta writes pass through middleware unchanged (server-owned, intentional). Add an explicit test asserting user-code writes to `meta.eTag` are no-ops or warned-on, so we don't accidentally allow it.
  - Decide and document the resource-deletion-vs-never-loaded ambiguity. `snapshot === null` from `onResourceUpdate` currently writes `value = undefined`, indistinguishable from "snapshot hasn't arrived." Preferred fix: preserve `meta.deleted: true` (already in the Snapshot shape per CLAUDE.md) when null comes in, so templates can distinguish "deleted server-side" from "still loading." Pin the chosen pattern in api-reference.md.
  - Apply the "lazy post-middleware deep-equals" optimization (carried into the correctness items below).
- [ ] Port `nebula-client-adapter.ts` shape OR fold into factory (decision during implementation — the spike adapter exists because `createNebulaClient` was framework-agnostic; if factory becomes Vue-aware anyway, the adapter step may disappear).
- [ ] Build `debounce.ts` per [tasks/debounce-serial-queue.md](debounce-serial-queue.md) Phase D2: per-resource `(rt, rid)` timer state, quiet/maxWait policy, flush API (called on commit, unmount, blur, dispose). State machine + invariants validated in D0/D1; D2 is mechanical port.
- [ ] **Per-field debounce config from validator bundle.** The factory consumes per-field `quietMs`/`maxWaitMs` config emitted by the typia/ontology compile pass (see [tasks/nebula-studio.md § Code Generation](nebula-studio.md#code-generation) for the annotation → config flow). Field-type defaults: `boolean` and enum / literal-union → `{ quietMs: 0 }`; `string` → inherits type default; `string` with `@longform` annotation → `{ quietMs: 1000, maxWaitMs: 5000 }`; explicit `@debounce(q, m)` overrides everything. **Merge rule at the resource level**: when multiple fields on the same resource have pending writes, the shortest active timer wins for both `quietMs` and `maxWaitMs` — clicking a `@debounce(0)` checkbox flushes any pending text-field edits as part of the same transaction. Runtime override via the existing `client.resources.transactionDebounce(rt, opts)` API; precedence: runtime > annotation > type-default > framework-default. Wire format for the config the factory consumes: TBD during implementation (probably attached to the validator bundle alongside the typia schema).
- [ ] Wire debounce into synced-state middleware: optimistic write lands immediately; transaction submission queues to the debouncer; debouncer flushes through the serial-per-resource queue.
- [ ] **`TransactionOutcome` + `TransactionResourceResolution` per [api-reference.md](../website/docs/nebula/api-reference.md#transactionoutcome).** The spike at [create-nebula-client.ts:343-373](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:343) returns the old single-level shape with only 4 branches. v3 replaces it with the new top-level `TransactionOutcome` (4 branches: `'ok'`, `'ontology-stale'`, `'timeout'`, `'infrastructure-error'`) plus per-resource `TransactionResourceResolution` delivered to the handler. For each branch, define and test the optimistic-state semantic:

  **Transaction-wide (top-level `TransactionOutcome`, what `await` resolves with):**
  - `'ok'` — per-resource handler has fired for each resource. `resources` carries the map (each `TransactionResourceResolution`) so callers can inspect at the await-site if needed for aggregate decisions.
  - `'ontology-stale'` — `onShouldRefreshUI` hook fires; do NOT roll back (page reload is the expected response).
  - `'timeout'` — roll back every optimistic write in the transaction. No server response within 5–10 s.
  - `'infrastructure-error'` — **NEW**. Wrap any thrown `Error` from the network/mesh transport (current behavior is to reject) into `{ kind: 'infrastructure-error', error }`. Roll back. The Promise from `transaction()` must NEVER reject after this lands — every code path that previously threw becomes a resolution.

  **Per-resource (`TransactionResourceResolution`, delivered to the handler):**
  - `'conflict-pending'` — non-terminal. Handler returns a `ConflictResolverVerdict` to drive the chain. Undefined return defaults to `{ kind: 'use-server' }`.
  - `'committed'` — `meta.eTag` updated for that resource. Framework adds default `lumenize-commit-success` flash class to bound elements.
  - `'use-server'` — server's `value` + `meta` written through for that resource. Framework adds default `lumenize-conflict-revert` flash at diff fields.
  - `'human-in-the-loop'` — keep that resource's optimistic state painted; no default flash. App owns the eventual resolution submission for that resource.
  - `'retries-exhausted'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash. `snapshot` is the latest server snapshot; `attempts` is the count.
  - `'validation-failed'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash. `errors` carries the server's per-field messages.
  - `'permission-denied'` — roll back that resource. Framework adds default `lumenize-conflict-revert` flash.

  **Mixed-fate handling:** the existing "first-conflict wins" simplification in 5.3.3c (`#handleTransactionResult`'s conflict path passes only the first conflicting resource to its resolver and applies the verdict uniformly) is replaced. v3 collects ALL conflicting resources, invokes each one's per-type registered handler (or per-call override) with `'conflict-pending'`, aggregates verdicts, drives any `'use-this'` re-submit chain. Top-level outcome is `'ok'` whenever the server responded (even when some/all resources landed at `'use-server'` or other non-`'committed'` resolutions). Multi-resource rollback uses per-resource pre-write snapshots, NOT a single `preWriteFullValue` (spike L317 is single-resource only). Capture pre-write snapshots per `(rt, rid)` at transaction-submit time.
- [ ] **Handler merger.** Replace the shipped `onETagConflict(rt, resolver, options?)` with `onTransactionResourceResolution(rt, handler, options?)`. Per-call override becomes `transaction(ops, { onTransactionResourceResolution })`. The handler is invoked at TWO temporal phases per resource:
  - Phase 1 — `'conflict-pending'`: synchronously during conflict resolution. Handler return drives the next step (may fire multiple times across `'use-this'` chains).
  - Phase 2 — terminal: once per resource per transaction with the final `TransactionResourceResolution` (`'committed'`, `'use-server'`, etc.). Handler return ignored.

  Implementation: invoke handler from `#handleTransactionResult` for both phases. Apply default flash classes (`lumenize-commit-success` / `lumenize-conflict-revert`) before calling the handler at terminal phases so the handler can override (e.g., by removing the class) if needed.
- [ ] **Rename `ontologyVersion` → `appVersion` in the user-facing API.** Per the docs-first sequencing, [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) and [api-reference.md](../website/docs/nebula/api-reference.md) use `appVersion` — the lock-step coupling between app and ontology versions means the LLM-as-reader mental model is "app version," not "schema version." Sites to update: NebulaClient constructor config, `client.resources.read` / `transaction` per-call options (`ReadOptions.appVersion`, `TransactionOptions.appVersion`), Star's mesh-method dispatch params, related types in `apps/nebula/src/nebula-client.ts` + `apps/nebula/src/star.ts`. Server-side internals (Star's ontology cache key, etc.) may keep `ontologyVersion` if useful — only the public API renames. The `'ontology-stale'` variant of `TransactionOutcome` keeps its `clientVersion` / `currentVersion` keys (already version-neutral).
- [ ] **Make all `createNebulaClient` config fields optional except `appVersion`, with browser-friendly auto-detection.** The bootstrap example in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) now shows zero fields specified (the doc cut the bootstrap section entirely; Studio auto-populates `store.ts`). For that to be honest, every field needs a sensible default:
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

  Doc sites updated alongside this work: [api-reference.md § subscribe](../website/docs/nebula/api-reference.md#resourcessubscribe), [api-reference.md § unsubscribe](../website/docs/nebula/api-reference.md#resourcesunsubscribe), [coding-your-ui.md § Auto-subscribe](../website/docs/nebula/coding-your-ui.md#auto-subscribe).

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
- [ ] Connection-state replay: on `createNebulaClient` registration, capture current connection state from the client and write through to `lmz.connection.*` so order-of-construction is forgiving (the harness-fix from the spike, productionized).
- [ ] Carry-forward tests: 24 Phase 0a factory-basics + 3 Phase 0b e2e (smoke, transaction-roundtrip, cross-client-fanout) + 5 Vue probes (Q1–Q5 from spike), total 32 tests across unit + e2e + browser projects.
- [ ] **Expose `client.claims` on LumenizeClient (mesh-level prerequisite for the next task).** NebulaClient inherits via `extends LumenizeClient`; Nebula examples use `client.claims.sub` for per-user-keyed resource lookups (see next task). Decision rationale captured during 2026-05-19 design discussion:

  - **Why `claims` not `user` or `jwt`:** matches established Lumenize vocabulary (`originAuth.claims`, `claims.sub` in [auth/delegation.mdx](../website/docs/auth/delegation.mdx), etc.). "user" implies richer profile data and mutability; "jwt" is imprecise (jwt = encoded triplet, not the payload).
  - **Why drop `#sub` (Option A) instead of mirroring it as a public convenience field (Option B):** Option A is DRY — one obvious idiom (`client.claims.sub`). Option B was tempted by the `GatewayConnectionInfo.sub` precedent (documented at [mesh/gateway.mdx:171](../website/docs/mesh/gateway.mdx) as a convenience field duplicating `claims.sub`), but on the client a richer accessor is more useful as the primary surface than a convenience alias. Zero-breakage either way: `client.sub` was never a public surface; only `#sub` private existed (used for `instanceName` generation).

  **Implementation (`packages/mesh/src/lumenize-client.ts`):**
  - Add `#claims: Readonly<JwtPayload> | null = null` private field.
  - Add `get claims(): Readonly<JwtPayload> | null { return this.#claims; }` public getter.
  - In `#refreshToken()`, after extracting `access_token`, parse and store: `this.#claims = Object.freeze(parseJwtUnsafe(result.access_token).payload)`. Find `parseJwtUnsafe`'s current export path (used at [website/docs/auth/testing.mdx:117](../website/docs/auth/testing.mdx) — `parseJwtUnsafe(accessToken).payload.act.sub`).
  - **Drop the redundant `#sub` private field.** All internal references derive from `this.#claims?.sub`. The instanceName-generation site at [packages/mesh/src/lumenize-client.ts:550](../packages/mesh/src/lumenize-client.ts:550) — `this.#instanceName = \`${this.#sub}.${tabId}\`` — becomes `\`${this.#claims?.sub}.${tabId}\``.

  **Backward compat:** zero breakage on the public API surface (no public `client.sub` getter existed). Mesh tests that assert directly on `#sub` will need updating to assert on `claims.sub` instead — accept the test churn.

  **Tests:**
  - Verify `client.claims` populates after refresh and matches `parseJwtUnsafe(accessToken).payload`.
  - Verify `Object.isFrozen(client.claims)` is `true`.
  - Update any existing test that touched `#sub` internals.

  **Doc updates in `@lumenize/mesh`:**
  - [website/docs/mesh/lumenize-client.md](../website/docs/mesh/lumenize-client.md) — add a `client.claims` section. Position alongside other public accessors / properties.
  - Sweep [mesh/calls.mdx](../website/docs/mesh/calls.mdx) and [mesh/security.mdx](../website/docs/mesh/security.mdx) for cross-references that should mention `client.claims` as the client-side equivalent of `originAuth.claims` on the server.
  - [mesh/gateway.mdx:171](../website/docs/mesh/gateway.mdx) — keep `GatewayConnectionInfo.sub` as-is (gateway-hook convenience field, not parallel to the client surface).

- [ ] **Nebula coding-your-ui.md doc unification (depends on `client.claims` task above).** Single 2-type ontology used throughout the middle of the doc (Lists, Atomic append, Conditionals, Forms); per-user keying via `client.claims.sub` instead of the pre-created `'main'` singleton; denormalized `openCount` aggregate to make the Forms saveTodo example justify itself as a multi-resource atomic transaction. Decision rationale captured during 2026-05-19 design discussion (option triage: A=per-user keying chosen over B=three-type with explicit User and C=keep 'main' with explanatory framing — A is the most realistic AND introduces the JWT-sub-on-client pattern as a real teaching moment).

  **Unified 2-type ontology** (replaces the current Lists section's snippet):

  ```typescript
  interface TodoList {
    items: string[];        // IDs of Todo resources, in display order
    openCount: number;      // denormalized count where status === 'open'
  }

  interface Todo {
    title: string;
    description: string;
    status: 'open' | 'done';
  }
  ```

  **Per-user keying:** replace all `('todoList', 'main')` with `('todoList', client.claims.sub)`. `client.claims.sub` is the JWT subject claim (per `client.claims` task above) — one list per user, keyed by their JWT sub.

  **Edits per section in [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md):**

  - **Add a short `client.claims` subsection** (suggested location: between Connection state and Auto-subscribe, OR as a sibling subsection inside Connection state). Brief — covers that `client.claims` is the JWT payload (frozen, stable for client lifetime), exposes `sub` / `aud` / etc. as standard JWT claims. Cross-link to [mesh/lumenize-client.md](../website/docs/mesh/lumenize-client.md) for the full surface and to [nebula/auth-flows.md](../website/docs/nebula/auth-flows.md) for how the user's identity is established.

  - **Lists with v-for** — update ontology snippet to the unified shape. Update v-for example to use per-user keying. **Drop the inline interactive toggle** (was: checkbox bound to `done`); focus on the foreign-key auto-subscribe lesson with a display-only status indicator. Example shape:
    ```html
    <ul>
      <li v-for="todoId in store.resources.todoList[client.claims.sub]?.value?.items ?? []" :key="todoId">
        {{ store.resources.todo[todoId]?.value?.title ?? '...' }}
        <span v-if="store.resources.todo[todoId]?.value?.status === 'done'">✓</span>
      </li>
    </ul>
    ```

  - **Atomic append (addTodo)** — per-user keying; new Todo's value uses `{ title, description: '', status: 'open' }`; update list's `openCount: list.openCount + 1`:
    ```typescript
    async function addTodo(title: string) {
      const newId = crypto.randomUUID();
      const list = store.resources.todoList[client.claims.sub]?.value;

      const outcome = await client.resources.transaction({
        [newId]:               { op: 'create', typeName: 'todo', nodeId: list.nodeId,
                                 value: { title, description: '', status: 'open' } },
        [client.claims.sub]:   { op: 'put',    typeName: 'todoList',
                                 value: { ...list, items: [...list.items, newId],
                                          openCount: list.openCount + 1 } },
      });
      // error handling on outcome goes here
    }
    ```

  - **Conditionals with v-if** — change `store.resources.task[id]` to `store.resources.todo[id]` for cross-section consistency with the unified ontology.

  - **Forms: explicit save (saveTodo)** — conditional `openCount` update via the delta pattern (status changes affect the count; title/description changes don't). The second op spreads into the transaction only if delta is nonzero (avoids unnecessary writes when the user only edited title or description):
    ```typescript
    async function saveTodo() {
      const draft = store.ui.todoForm.draft;
      const currentStatus = store.resources.todo['task-42']?.value?.status;
      const list = store.resources.todoList[client.claims.sub]?.value;
      const delta = (draft.status === 'open' ? 1 : 0) - (currentStatus === 'open' ? 1 : 0);

      const outcome = await client.resources.transaction({
        'task-42': { op: 'put', typeName: 'todo', value: draft },
        ...(delta !== 0 && {
          [client.claims.sub]: { op: 'put', typeName: 'todoList',
                                 value: { ...list, openCount: list.openCount + delta } },
        }),
      });
      // error handling on outcome goes here
    }
    ```

  **api-reference.md** — short cross-reference to mesh's `client.claims` (since NebulaClient extends LumenizeClient, the getter is inherited; nothing Nebula-specific to document beyond the cross-link).

  **Rationale for openCount specifically (worth preserving in case the design is revisited):** real todo apps almost always have a UI badge showing "N open" somewhere. The denormalized aggregate pattern is the canonical example of "why atomic multi-resource transactions matter." Without it, saveTodo is a single-resource put and a reader could reasonably ask "couldn't I just `v-model` the fields and let per-keystroke transactions batch?" With it, per-field v-model would update status per-keystroke without ever touching `openCount`, drifting the count from reality. The conditional-spread (`...(delta !== 0 && { ... })`) avoids unnecessary writes when only title/description changed.

  **Rationale for dropping the Lists section's inline interactive toggle:** the lesson is "per-iteration auto-subscribe via foreign-key v-for." An interactive checkbox was a nice-to-have but added cognitive load (and with `status: 'open' | 'done'` enum vs the old `done: boolean`, the checkbox-bound-to-enum pattern got awkward). Status-toggle UX is demonstrated in the Forms section's `<select>`; the Lists example focuses on its lesson.

**Correctness items surfaced in spike review (must address during v3 before shipping):**

- [ ] **eTag-race correctness in the serial queue** — owned by [tasks/debounce-serial-queue.md](debounce-serial-queue.md). The state-machine design + property tests from D0/D1 land here as the implementation gate.
- [ ] **Re-entrancy guard on the middleware chain.** If a user-supplied middleware writes back to the store from inside its callback, the outer Proxy's `set` trap re-enters and a sloppy middleware could infinite-loop. Vue's reactivity handles its own re-entry, but our deep-equal-then-middleware-then-trigger sequence has no `inFlight` guard. Add a `Set<string>` of currently-applying paths to the factory; if a `set` trap fires for a path already in the set, skip middleware (forward direct to Vue reactive). Document the contract: "middleware MUST NOT write to its own path inside its callback; cross-path writes are fine." Add a test that intentionally writes back from middleware to verify no loop.
- [ ] **Lazy post-middleware deep-equals.** Spike runs `deepEquals(oldValue, finalValue)` twice on every write: once before middleware (skip identical writes) and once after middleware (substitution detection). The post-middleware check is wasted work when no middleware substituted. Track a `substituted: boolean` flag in the middleware loop; only run the post-middleware deep-equals if `substituted === true`. ~5 LOC savings, removes ~50% of deep-equals work on the hot path.
- [ ] **Mid-edit fanout contract.** Server fanout arriving while a user is mid-typing will visually clobber their in-progress text under the default `'use-server'` resolver. This is by-design (Nebula's optimistic + server-is-truth model), but the user-visible UX is bad for text fields. Recommendation already captured in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) § "Text fields specifically — don't leave the default". Ship a `textMerge(server, local, base)` helper from `@lumenize/nebula-frontend` (or pull in `diff-match-patch` if licensing allows) so users can register a text-merge resolver in one line. Test: simulate concurrent-edit conflict on a text field with `textMerge` resolver registered, assert both edits preserved.

**Things that can't be fully assessed until v3 lands — track as risks, surface during impl:**

- [ ] **Vue `<Suspense>` / `<KeepAlive>` interaction.** Recursive trees + KeepAlive could surface scope-disposal edge cases the spike didn't exercise. Test: mount a KeepAlive'd component with subscribed resources, switch away, switch back; verify exactly-one-subscribe (resource stays subscribed across keep-alive cycle, or properly unsubs + resubs). Test: `<Suspense>` boundaries inside recursive trees — async setup during recursion shouldn't double-subscribe.
- [ ] **Real-browser vs jsdom divergence.** Phase 5.3.7-v4's real-browser harness will surface things the spike couldn't see: input event timing, IME composition events (Asian languages — typing Chinese/Japanese/Korean fires composition events the spike never exercised), focus management around `v-model.lazy`, paint scheduling. Vue's surface is battle-tested but our debounce/flush-on-blur interaction with composition events is novel. Test: IME composition probe — type a multi-key character, verify exactly one transaction fires after composition ends, not one per intermediate keystroke.
- [ ] **CSP `unsafe-eval` and compile placement — superseded by the 2026-05-15 SFC pivot.** Compile no longer runs in the browser; both dev and production paths pre-compile templates server-side. CSP `'unsafe-eval'` is unnecessary in both modes.

  **Per-save dev compile (during Studio iteration):** runs in the **user-local dev Star** ([tasks/nebula-branches.md](nebula-branches.md) — every Star auto-creates `.main` and `.dev` branches). The dev Star imports `@vue/compiler-sfc` directly; Studio's NebulaClient submits SFC source via `lmz.call`; render-function output broadcasts back over the existing Subscriber/fanout. Owned by [tasks/nebula-studio.md](nebula-studio.md) § "Dev-mode Star: SFC compile + reload broadcast." Validated by the 2026-05-15 spike — see [apps/nebula/spike/sfc-devstar-loop/RESULTS.md](../apps/nebula/spike/sfc-devstar-loop/RESULTS.md).

  **Production-deploy compile (when Studio publishes an app):** runs in **Galaxy** (per-tenant deploy operation, not per-save). Same `@vue/compiler-sfc` pipeline, plus the downstream TS transpiler step that the spike's RESULTS identified. Output is a JS asset under `<script src>` so the deployed page needs neither runtime compiler nor `'unsafe-eval'`. Galaxy caches compiled output by ontology version (same compile-once-cache-forever pattern as the typia validator delivery).

  Vue's compiler (`@vue/compiler-sfc` + `@vue/compiler-dom` + `@vue/compiler-core` + `@vue/shared`) is pure JavaScript (~150 KB minified, no native deps, no WASM), runs in any JS runtime including Cloudflare Workers/DOs — no Cloudflare Containers needed.

  **Action items for 5.3.7:** none — both compile sites are owned by other phases (dev-Star compile by nebula-studio.md; deploy-Galaxy compile is post-demo Studio work). 5.3.7 docs simply reflect that the runtime-only Vue bundle ships to clients in both modes — no in-DOM compiler discussion required in coding-your-ui.md.
- [ ] **`wrapperCache` memory accumulation over long-running pages.** The factory's `wrapperCache` ([create-nebula-client.ts:195](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts:195)) caches a Proxy wrapper per path-suffix; when a resource snapshot replaces its `value` object, the old wrapper stays in the cache pointing at orphaned reactive state. Bounded by application structure (paths are finite), but a long-running app with many distinct resource IDs over time slowly leaks. Probably fine for v1; flag for post-demo if it surfaces. Add a leak probe to the real-browser tests if it's cheap to do.

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

- [ ] `packages/state/` — entire directory, including 80 tests. Harvest test cases as comments in the factory's test file if any aren't already covered.
- [ ] `apps/nebula/spike/alpine-adapter/` — entire directory once 5.3.7-v2 lands. Keep until then for reference.
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
- [ ] **Probe the coding-your-ui.md doc against the shipped API**: every API surface mentioned in the v1-rewritten doc should resolve to a real export from `@lumenize/nebula-frontend` or `@lumenize/nebula-client`. Anything mentioned in the doc that doesn't exist is a TODO; anything exported that the doc doesn't mention is a candidate for deletion (the doc IS the spec post-v1).

**Out of scope for 5.3.7 (post-demo):**

- Galaxy-side template pre-compilation for production deploys (closes CSP `'unsafe-eval'` requirement). Architecture pinned in v3's risks list; implementation owned by Studio's deploy work.
- `flashClass` rich-diff support (field-level rendering of WHAT changed, not just THAT it changed).
- Multi-resource subscriptions / query subscribe (still out of scope per § "Out of scope (post-demo)").
- **Hold-pending-fanouts (full mid-edit-clobber protection)** — the existing per-type `onTransactionResourceResolution` handler with a text-merge `'use-this'` verdict only protects keystrokes typed *after* a concurrent fanout arrives; keystrokes typed *before* the fanout's write-through are lost when the framework applies the server snapshot via the `{ source: 'remote' }` middleware bypass. Complete protection requires the factory's synced-state middleware to **hold incoming fanouts** for any resource that has pending optimistic state (debounced write outstanding OR transaction in flight). When the next submit's conflict resolver fires, it sees both the user's full pre-fanout state and the buffered server snapshot; the resolver's merge incorporates both. After the resolver settles, apply the merged result and release the hold. Approach: resource-level granularity (not per-field) — simpler and sufficient for v1. Acceptable consequence: a server-side change to field Y on the same resource also waits for field X's submit; not user-visible since most resources have small enough field sets. ~50 LOC addition to the middleware. Documented in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) § "Write timing" caution as a known limitation pending this work.
- **Merge helper library: `textMerge`, `setUnion`, `counterMerge`, etc.** — ship from `@lumenize/nebula-frontend`'s top-level export so per-type handlers can call them from a `'use-this'` verdict without users having to pull in `diff-match-patch` themselves or write merge logic inline. Resolves the design question of "should we add a `'crdt'` resolution kind?" — answer: no, `'use-this' + helper-fn` is the right factoring (helpers don't add framework primitives; users opt in per-type). `textMerge(server, local, base)` is 3-way diff/patch (LCS-based) and is the most load-bearing; ship that first. `setUnion(localSet, serverSet)` and `counterMerge(local, server, base)` follow when the demo or a real app needs them. `textMerge` is tagged `deferred-post-5.3.7` in [api-reference.md § textMerge](../website/docs/nebula/api-reference.md#textmerge); this task lands it. **For true CRDT-backed real-time collab, see the next bullet — different scope entirely.**
- **True CRDT-backed real-time collaborative editing (Google-Docs / Notion / Figma tier)** — distinct from the merge-helper bullet above and dramatically larger in scope. `textMerge` does 3-way diff/patch; it preserves non-overlapping concurrent edits but can lose work when edits overlap or when deletions tangle with insertions. It does NOT provide "instant convergence under arbitrary operation interleaving" — that needs an actual CRDT (yjs, automerge, etc.) with **per-character identity**, **op streaming** (sub-snapshot updates), **cursor / selection preservation across merges**, and the **CRDT state itself as the source of truth** (not just the resulting string value, which is a lossy projection). Integration is a multi-week project on its own: it'd add a parallel data tier alongside the current JS-object-shaped resources, with its own wire format (op stream, not snapshot fanout), server-side state representation (the CRDT structure persisted, not just `value`), client-side library integration (which CRDT — yjs, automerge, custom — each has its own ecosystem), and editor bindings (Tiptap/ProseMirror, Monaco, CodeMirror — different editors have different CRDT adapters). Adjacent design questions also untouched: ontology annotation surface (e.g., `@crdt-text body: string`), how CRDT-backed fields interact with permission cascade, how `eTag` / optimistic concurrency apply (or don't) at the CRDT tier. Defer until a Studio app actually needs real-time collaborative editing; capture as its own task file (`tasks/nebula-crdt-fields.md` or similar) when that day comes.

### Phase 5.3.8 — For-docs tests (one big `it`, narrative)

All async probes use `vi.waitFor` (Vue's reactive scheduler is microtask-deferred; grace periods need real time).

**Framework-agnostic probes** (run in headless / Node):

- [ ] Two clients subscribe to same resource; client A transactions; client B's bound store path updates via `handleResourceUpdate`.
- [ ] BroadcastChannel: client A doesn't receive own update via fanout; instead reflects authoritative value via `handleTransactionResult`'s success path.
- [ ] `'use-server'` verdict: handler returns `{ kind: 'use-server' }` from `'conflict-pending'`; framework writes server value through for that resource; handler fires again with terminal `{ kind: 'use-server', snapshot }`; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'use-server', snapshot } } }`.
- [ ] `'use-this'` verdict: handler returns `{ kind: 'use-this', value }`; framework submits new transaction with `eTag = server.meta.eTag`. Verify recursion: second submission also conflicts → handler fires again with `'conflict-pending'` → eventually succeeds. Transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'committed', eTag } } }`.
- [ ] `maxRetries` exhaustion: handler always returns `'use-this'`, every submission conflicts; after default 5 attempts, handler fires with terminal `'retries-exhausted'` and transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'retries-exhausted', snapshot, attempts: 5 } } }`.
- [ ] `'human-in-the-loop'` verdict: handler returns the handoff; handler fires again with terminal `'human-in-the-loop'`; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'human-in-the-loop', snapshot } } }`; optimistic state stays painted (NOT overwritten); no new transaction; test then manually submits follow-up.
- [ ] Per-call override: `transaction(ops, { onTransactionResourceResolution: customHandler })` overrides per-type registered handler for that call only.
- [ ] Default flash classes: `'committed'` resolution adds `lumenize-commit-success` class to bound elements; rollback resolutions (`'use-server'`, `'validation-failed'`, `'permission-denied'`, `'retries-exhausted'`) add `lumenize-conflict-revert`; both removed after `flashDuration` ms. Test default class, custom per-type `flashClass: { committed, rolledBack }`, and `flashClass: { committed: null, rolledBack: null }` disabling both.
- [ ] Idempotency probe: drop a transaction response (test-only); client retries with same `newETag`; server returns idempotent success without duplicate.
- [ ] `client.resources.read(rt, rid)` returns current snapshot without writing to bound store.
- [ ] Staleness probe: client constructed with `'v1'`, server now `'v2'`; transaction → `onShouldRefreshUI` fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }`; transaction Promise resolves with `{ kind: 'ontology-stale', ... }`.
- [ ] Connection-state probe: trigger LumenizeClient connection events programmatically; assert `lmz.connection.state` / `lmz.connection.connected` / `lmz.connection.lastConnectedAt` paths update correctly on each transition.
- [ ] Permission-denied probe: attempt a write the user isn't authorized for; handler fires with terminal `{ kind: 'permission-denied' }`; that resource's optimistic state rolls back to last-confirmed; transaction Promise resolves with `{ kind: 'ok', resources: { [rid]: { kind: 'permission-denied' } } }`.
- [ ] Mixed multi-resource probe: transaction with two resources where one handler returns `'use-server'` and the other has no handler registered but server returns permission-denied; Promise resolves with `{ kind: 'ok', resources: { [ridA]: { kind: 'use-server', ... }, [ridB]: { kind: 'permission-denied' } } }`. Verifies the per-resource map is populated and each resource's optimistic state is handled per its individual `TransactionResourceResolution`.
- [ ] Infrastructure-error probe: simulate a network drop mid-transaction (or mesh crash); transaction Promise resolves with `{ kind: 'infrastructure-error', error }` carrying the underlying `Error`. Optimistic state rolls back. **The Promise must NOT reject.**
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant).
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during disconnect.

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
- [ ] Flash class: after `'use-server'` where local differed from server, framework flashes bound elements at diff fields; removed after `flashDuration` ms. Test default class, custom class, and `flashClass: null` disabled. Implementation depends on the chosen flash mechanism (see api-reference.md § Resolver bindings).
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

1. **Subscriber cleanup on disconnect** — **Resolved 2026-05-12** via drop-on-failed-fanout (Phase 5.3.5, shipped). `Star.#fanout` carries a result-handler continuation; on `ClientDisconnectedError` post-grace from the Gateway, `Star.onFanoutDelivered` drops the subscriber row inline. Three-mechanism cleanup model (active-WS-close + ontology-install-clear + drop-on-failed-fanout) covers all cases. See Phase -1 § 5 for the full record.
2. **Permission revocation mid-subscription** — if admin revokes read permission on a node while subscribed, existing subscribers still fanout. Acceptable for demo; DAG-mutation path needs to invalidate subscribers for production.
3. **`getEffectivePermission` per-subscriber on notification?** Probably no for demo; revisit for production.
4. **Subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy** — when Studio deploy changes guards/ontology, do existing subscribers get re-evaluated? **Resolved 2026-05-12**: all invalidated on deploy. `Star.#installState()` clears the `Subscribers` table via `DROP TABLE + CREATE TABLE` (one billed write). Clients re-subscribe naturally on the post-deploy page reload. Details in Phase -1 § 5 and Phase 5.3.2 / 5.3.4 checklists.
5. **Subscription identifier** — **Resolved by design**: `(clientId, resourceType, resourceId)` uniquely identifies a subscription. `clientId` is the Gateway's `instanceName` (`callContext.callChain.at(-1)?.instanceName`); multi-tab same-user = different Gateway instances = different `clientId`s. No generated `subId` needed.
6. **Mesh-framework Promise correlation for `client.resources.read()`** — **Resolved 2026-05-12 in Phase 5.3.3b** via option (b) "hidden plumbing handler": client generates `requestId = crypto.randomUUID()` per call, threads through `Star.read(ontologyVersion, rt, rid, requestId)`, server delivers via new internal `@mesh() handleReadResponse(requestId, result)` on NebulaClient, which settles a `Map<requestId, {resolve, reject}>` entry. The earlier `handleReadResult` was removed entirely. Transactions don't need correlation thanks to the serial in-flight queue (5.3.3b).
7. **Query language** — for "give me all todos where status='open'" with result-set subscription. Deferred to own phase. Design space includes query shape, server-side execution model, result-set subscription semantics, pagination, cursor stability across schema migrations.

## Phase -1: Captured Ideas

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Triage outcomes: do-now / later-task-file / backlog / drop. Resolve everything here before archiving this file.

1. **Same-field conflict cascade during async resolver.** If a user has a modal open for `resources.todo.task-42.value.title` and keeps typing into that same title field while the modal is open, the additional typing enqueues new transactions with the pre-conflict `meta.eTag`. After the modal resolves and T1's submission lands, T2 fires with the now-stale eTag, conflicts against the server's new eTag, and the modal pops *again* with the latest server snapshot. Semantically correct (each conflict gets the user's choice); visually noisy ("why does this keep popping up?"). **Mitigation**: the pinned debouncing policy (500 ms quiet + 2000 ms maxWait + serial-per-resource queue using in-flight tx's resulting eTag for buffered writes) substantially mitigates this — fast typing during a modal becomes one buffered transaction submitted with the post-resolver eTag, not N queued transactions with stale eTags. The "noisy modal re-pop" still exists if typing crosses the maxWait boundary, but the typical case (sub-2-second modal interaction) is clean. **Triage**: not solving for v1; Studio-generated UIs rarely have a user typing into the field that's mid-conflict (the modal grabs focus).

2. **Re-conflict during human-in-the-loop batch resolution.** The doc's review-later example builds an atomic batched transaction from all pending conflicts. If any of the resources in that batch has churned again on the server (someone wrote between the original conflict and the user's review-later submission), the whole batch rolls back and the resolver fires again — for whichever resource(s) re-conflicted, plus presumably the same `'human-in-the-loop'` policy. The conflict stash gets re-populated; the user goes through review again. **Triage**: probably fine — the user's already in a "review and resolve" mindset, so a second review pass isn't jarring. But worth thinking about whether the framework should somehow signal "this is a re-resolution of a previously-handed-off conflict" so the UI can highlight it. Not blocking demo; revisit if real Studio markup exposes the friction.

3. **Client-side routing** — resolved into pinned decisions: use `vue-router`. Studio app work picks it up when routing surfaces. Single-page-with-conditional-views (`v-if` on `store.app.activeView`) still works for one-pager apps; routing kicks in when navigation, URL-encoded state, or back-button support matters. URL-params-into-store ≈ ~10 LOC of `watchEffect` in app code, or a small `useRouteSync(map)` composable from `@lumenize/nebula-frontend` if Studio templates want it factored.

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
   3. **Drop-on-failed-fanout** (Phase 5.3.5 — shipped 2026-05-12, promoted from "deferred — may never be needed") — `Star.#fanout` passes a result-handler continuation on each `lmz.call`; when the Gateway returns `ClientDisconnectedError` (post-grace), `Star.onFanoutDelivered` calls `Subscriptions.removeSubscriber(resourceId, clientId)` inline. The architectural pivot from the original alarm-driven design: `NebulaClientGateway` extends `DurableObject` directly (zero-storage design) and has no `this.lmz.call`, making proactive cleanup from the Gateway side awkward — reactive cleanup from Star turned out simpler and equally good for the "user closed the tab" case. Quiet resources (no subsequent mutations) still leak rows; bounded by (2).

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

6. **Lifecycle hooks.** Resolved: per-component lifecycle is stock Vue (`onMounted(fn)` / `onBeforeUnmount(fn)` / `onUnmounted(fn)` from `vue`). Zero custom code in `@lumenize/nebula-frontend`. The four other candidates that came up during design are explicitly deferred:
   - **Per-resource-subscription** (`onSubscribed` / `onUnsubscribed`): NebulaClient already exposes the `subscribe`/`read`/`transaction` Promises and the `onTransactionResourceResolution` hook; per-fanout-event callbacks would be duplicative surface for unclear benefit.
   - **Per-transaction granularity** (`onSubmitted` / `onCommitted` / `onConflicted` / `onRolledBack`): the always-resolve `TransactionOutcome` + per-type `onTransactionResourceResolution` already cover every terminal state.
   - **Auth/scope transitions** (`onScopeChange`): activeScope changes today happen via page reload (full re-bootstrap, per `tasks/archive/nebula-7-client.md`). Revisit when in-place scope switching becomes a real feature.
   - **Whole-app `onReady` / `onError`**: `v-if` on `lmz.connection.connected` + per-resource `meta.eTag` presence covers the splash-screen case declaratively. `onError` is a future observability story, not a demo blocker.

7. **DAG-tree-as-special-resource (reactive DAG binding).** The DAG tree is conceptually a resource — clients eventually want to bind UI to it (`{{ store.resources.lmz.dag.value.nodes[42].label }}`, tree-view components, reactive permission badges). The cleanest design **reuses the resource-subscribe plumbing** rather than building parallel `client.dag.subscribe()` / `handleDagUpdate()` / a separate `DagSubscribers` table — the whole consolidation work in 5.3.1 (one Subscribers schema, one fanout path) was about not making exactly that mistake.

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

   > **2026-05-16 update**: the "tuple-format catch" above no longer applies. `@lumenize/structured-clone` shipped the W4 object-based wire format ([PR #11](https://github.com/lumenize/lumenize/pull/11)) — preprocess now emits `{ json, meta }` with object-keyed forms compatible with RFC 7396 JSON Merge Patch (not Map-entries-as-arrays). The package exports `diff` and `applyMergePatch` directly. Option D's "expensive plumbing for narrow gain" verdict softens substantially: the generic diff primitive is already here. The actual integration into Nebula's fanout / read paths is captured in [tasks/on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md), with the DAG-side prerequisite (in-memory normalization) in [tasks/nebula-dag-normalize.md](nebula-dag-normalize.md). Still post-demo (Option 0 remains the demo ship), but the cost curve to pick this up is lower than the original analysis suggested.

   **Pick-an-option triage**: ship demo with **Option 0**. When (if) a real workload exposes the scale concern, the cheapest follow-up is **Option A** (eTag-bump-and-pull) — minimal new plumbing, no API change. **Option B** is the wire-efficient ceiling and worth a serious look if op-streaming has UX value beyond just size (e.g., showing other users' edits as they happen, animated). **Option C** is the right answer if generic-diff semantics become a broader Lumenize capability — not a DAG-only justification.

   **Phase triage**: don't implement DAG-binding yet. Wait until the Studio demo (or a real app) actually wants a reactive DAG view — at that point Option 0 is small (~30 LOC + one type-check special case in `Subscriptions.subscribe` + the `#onChanged` rewire), and the scale-out decision (A vs B vs C) can be made with concrete UI requirements in hand instead of speculatively. **Outcome destination**: own subsection under Phase 5.3.x when the trigger lands; or fold into a `tasks/nebula-dag-binding.md` if the design grows beyond what fits here.

8. **Multi-resource conflict-resolver semantics — resolved into v3 scope.** The Phase 5.3.3c "first-conflict wins" simplification (one resolver fires, verdict applied uniformly across all conflicting resources) is replaced by the unified per-type handler + per-resource `TransactionResourceResolution`: every conflicting resource fires its own handler invocation with `'conflict-pending'`, verdicts aggregate into a per-resource map on the top-level `TransactionOutcome.resources`. See Phase 5.3.7-v3's `TransactionOutcome` + `TransactionResourceResolution` task for the implementation work.

9. **Auto-retry on transient transaction failures (`'infrastructure-error'`, `'timeout'`).** Current pinned design is caller-decided retry: when `transaction()` resolves with `{ kind: 'infrastructure-error', error }` or `{ kind: 'timeout' }`, the await-site decides whether/when/how to retry. Idempotency via the per-transaction `newETag` makes manual retry safe — submitting the same `newETag` again returns idempotent success if the original request actually landed but the response was lost.

   **The proposal**: add an optional `TransactionOptions.retryPolicy?: { maxAttempts: number; backoffMs: number | ((attempt: number) => number) }` field. Defaults to no retry (preserves current contract). When set, the framework auto-resubmits on `'infrastructure-error'` and `'timeout'` outcomes — same `newETag` so idempotency holds — up to `maxAttempts`, with the caller-supplied backoff between attempts. After exhaustion, returns the final outcome to the await-site.

   **Why deferred (not in v3):**
   - Auto-retry imposes a policy decision. Some apps want "saving…" / "still saving…" / "save failed, retry?" with custom backoff; others want fire-and-forget. The current caller-decided default doesn't force a choice.
   - Auto-retry can mask real connectivity issues — a user typing into an offline app would see no immediate signal.
   - Most apps that want retry can wrap `transaction()` in their own retry helper today; the marginal value of framework-built-in is convenience, not capability.

   **Why worth keeping on the list:**
   - The convenience IS real. Studio's LLM generating boilerplate retry-wrappers at every call site is noisier than `transaction(ops, { retryPolicy: { maxAttempts: 3, backoffMs: 500 } })`.
   - The shape doesn't conflict with anything else — it's a pure addition.
   - `newETag` already provides the idempotency guarantee, so the implementation is just a loop around the existing transaction code path. ~30 LOC.

   **Triage**: defer to post-5.3.7. Revisit if a real app hits the boilerplate-fatigue pain or if Studio's LLM ends up generating the retry-wrapper pattern frequently enough that promoting it to the framework would be a clear simplification. **Outcome destination**: own bullet in the "Out of scope for 5.3.7 (post-demo)" list when the trigger lands, or its own task file if the design grows.

## Notes

- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design."
- Fanout > 64 subscribers (large-fanout tiering) intentionally not designed here. Demo runs with a handful of subscribers max.
- This file consolidates and supersedes `tasks/archive/nebula-5.3-subscriptions.md`, `tasks/archive/lumenize-ui.md`, and `tasks/archive/nebula-7-client.md`.

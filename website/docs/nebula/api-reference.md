---
title: API reference
description: API surface for @lumenize/nebula-frontend and the NebulaClient resources namespace.
---

# API reference

This page is the contract for the `@lumenize/nebula-frontend` factory + NebulaClient `resources` namespace. Every signature mentioned in [coding-your-ui.md](./coding-your-ui.md) resolves to a section here. Conceptual explanations live in coding-your-ui; this page is the lookup.

## Status legend

Each surface below carries one tag. The tag describes the **as-of-5.3.7-v1** state and is the contract for what 5.3.7-v3 implements.

- **`implemented-in-spike`** — the Vue-in-DOM spike at `apps/nebula/spike/alpine-adapter/` validated this surface. v3 ports it to `packages/nebula-frontend/`.
- **`new-in-v3`** — the spike didn't cover this. v3 designs and implements.
- **`deferred-post-5.3.7`** — referenced for completeness but explicitly NOT shipping in 5.3.7. v3 must not pretend these exist.

## Summary

| Surface | Tag | Section |
| --- | --- | --- |
| `createNebulaClient(config)` | new-in-v3 | [createNebulaClient](#createnebulaclient) |
| `client.resources.subscribe(rt, rid)` | implemented-in-spike | [resources.subscribe](#resourcessubscribe) |
| `client.resources.unsubscribe(rt, rid)` | implemented-in-spike | [resources.unsubscribe](#resourcesunsubscribe) |
| `client.resources.read(rt, rid, options?)` | implemented-in-spike | [resources.read](#resourcesread) |
| `client.resources.transaction(ops, options?)` | implemented-in-spike (single-resource happy path); new-in-v3 (per-resource outcomes, infrastructure-error, multi-resource) | [resources.transaction](#resourcestransaction) |
| `client.resources.onTransactionResourceResolution(rt, handler, options?)` | new-in-v3 (replaces shipped `onETagConflict`) | [resources.onTransactionResourceResolution](#resourcesontransactionresourceresolution) |
| `client.resources.transactionDebounce(rt, opts)` | new-in-v3 | [resources.transactionDebounce](#resourcestransactiondebounce) |
| `client.dispose()` | new-in-v3 | [client.dispose](#clientdispose) |
| Reserved state paths (`resources.*`, `lmz.*`) | implemented-in-spike | [Reserved state paths](#reserved-state-paths) |
| `lmz.connection.{state, connected, lastConnectedAt}` | implemented-in-spike | [lmz.connection](#lmzconnection) |
| `textMerge(server, local, base)` helper | deferred-post-5.3.7 (see note) | [textMerge](#textmerge) |
| `v-model.eager` directive modifier | new-in-v3 | [v-model.eager](#v-modeleager) |
| Handler `context.bindings` arg | deferred-post-5.3.7 | [Handler bindings](#handler-bindings) |
| `TransactionOutcome` discriminated union (top-level, what `transaction()` resolves with) | implemented-in-spike (`'committed'` shape only); new-in-v3 (new shape with `'ok'`, `'infrastructure-error'`) | [TransactionOutcome](#transactionoutcome) |
| `TransactionResourceResolution` discriminated union (per-resource, what the handler receives) | new-in-v3 | [TransactionResourceResolution](#transactionresourceresolution) |
| `ConflictResolverVerdict` (what the handler returns for `'conflict-pending'`) | implemented-in-spike (under old `ConflictResolution` name) | [ConflictResolverVerdict](#conflictresolververdict) |

## `createNebulaClient` {#createnebulaclient}

**Tag**: `new-in-v3`

```typescript @skip-check
function createNebulaClient(config: NebulaClientConfig): {
  client: NebulaClient;
  store: Record<string, any>;
  use: (middleware: Middleware) => () => void;
  dispose: () => void;
};
```

Wraps a `NebulaClient` with a Vue-reactive store and a middleware chain. Must be called **before** the underlying WebSocket connection resolves so the factory's `onConnectionStateChange` listener captures the initial `connecting → connected` transition; late registration leaves `lmz.connection.*` empty.

### Config

`NebulaClientConfig` extends [`LumenizeClientConfig`](../mesh/lumenize-client.md) (minus `refresh` and `gatewayBindingName`) with these additional fields:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `authScope` | `string` | required | Auth scope path (e.g., `'acme.app.tenant-a'`). Determines refresh-cookie path. |
| `activeScope` | `string` | required | Active scope baked into the JWT `aud` claim. Same as `authScope` for regular users; can differ for admins with wildcard access. |
| `appVersion` | `string` | required | Client's app version (lock-step with the ontology version server-side). Auto-attached to every `resources.*` call. Studio sets this at deploy time. |
| `onShouldRefreshUI` | `(info: OntologyStaleInfo) => void` | `undefined` | Invoked when the server signals client ontology is stale. Typical: `() => window.location.reload()`. If unset, staleness still surfaces via `{ kind: 'ontology-stale' }`. |
| `unsubscribeGraceMs` | `number` | `2000` | Grace period (ms) between binding-refcount reaching zero and `client.resources.unsubscribe` firing. New bindings inside the window cancel the pending unsubscribe. |

### Return shape

| Field | Type | Description |
| --- | --- | --- |
| `client` | `NebulaClient` | Lower-level API. Use for explicit subscriptions, reads, transactions, resolver registration. |
| `store` | `Record<string, any>` | Vue-reactive Proxy. Reads inside a component's `setup()` auto-subscribe to the resources they touch (refcounted, grace-period-aware). Writes under `resources.<rt>.<rid>.value.*` flow through the synced-state middleware → optimistic apply + debounced transaction submission. |
| `use(middleware)` | `(mw: Middleware) => () => void` | Register an additional middleware. Returns a deregistration function. Synced-state middleware is always-on; user-supplied middleware layers on top. |
| `dispose()` | `() => void` | Tear down. Flushes any pending debounced writes, clears refcount + pending-unsubscribe timers, disposes internal scopes. |

### Example

```typescript @skip-check
// store.ts — initialize once at module load, export for any component to import.
import { createNebulaClient } from '@lumenize/nebula-frontend';

export const { client, store } = createNebulaClient({
  baseUrl: 'https://my-app.example.com',
  authScope: 'acme.app.tenant-a',
  activeScope: 'acme.app.tenant-a',
  appVersion: 'dev',
  onShouldRefreshUI: () => window.location.reload(),
});
```

```typescript @skip-check
// main.ts — Vue entrypoint.
import { createApp } from 'vue';
import App from './App.vue';
import './store';  // side-effect import: initializes the NebulaClient

createApp(App).mount('#app');
```

See [coding-your-ui.md](./coding-your-ui.md) § "NebulaClient and the store" for the SFC authoring conventions and the matching `App.vue` shape.

## `client.resources.subscribe` {#resourcessubscribe}

**Tag**: `implemented-in-spike`

```typescript @skip-check
subscribe(resourceType: string, resourceId: string): Promise<Snapshot | null>;
```

Subscribe to a resource. Resolves with the initial snapshot on the first server-side `handleResourceUpdate` for `(rt, rid)`. Subsequent updates are fanout pushes that write through to bound state but do not re-resolve.

If a pending subscribe for the same `(rt, rid)` already exists, the returned Promise piggybacks on that pending settlement instead of issuing a duplicate request.

**Typical usage**: rarely called directly. Most subscriptions happen via auto-subscribe (reading from the store inside a Vue component triggers `subscribe` on the underlying client). Call explicitly only when subscribing to a resource the UI doesn't yet bind to (e.g., warming a cache before navigating to a view).

## `client.resources.unsubscribe` {#resourcesunsubscribe}

**Tag**: `implemented-in-spike`

```typescript @skip-check
unsubscribe(resourceType: string, resourceId: string): void;
```

Unsubscribe from a resource. Fire-and-forget. Server drops the subscriber row.

Auto-subscribe handles the common case (component unmount → refcount to zero → grace period → unsubscribe). Call explicitly only when you subscribed explicitly.

## `client.resources.read` {#resourcesread}

**Tag**: `implemented-in-spike`

```typescript @skip-check
read(
  resourceType: string,
  resourceId: string,
  options?: ReadOptions,
): Promise<Snapshot | null>;

interface ReadOptions {
  appVersion?: string;   // override constructor's version for this call
}
```

Ad-hoc read of a resource. Each call gets its own `requestId`; concurrent reads to the same `(rt, rid)` are independently correlated.

**Does NOT write to the store.** `read` is for scripting and ad-hoc inspection. For reactive UI, use the store + auto-subscribe (or `subscribe` explicitly).

Returns `null` if the resource has no current snapshot (deleted or never created).

## `client.resources.transaction` {#resourcestransaction}

**Tag**: `implemented-in-spike` for single-resource happy path; `new-in-v3` for the new two-level `TransactionOutcome` shape + per-resource handler invocations + infrastructure-error wrapping.

```typescript @skip-check
transaction(
  ops: Record<string, OperationDescriptor>,
  options?: TransactionOptions,
): Promise<TransactionOutcome>;
```

Submit a transaction. **Always resolves** with a [`TransactionOutcome`](#transactionoutcome); never rejects. Infrastructure failures (network drops, mesh crashes) come back as `{ kind: 'infrastructure-error', error }` so the caller's `switch` at the await-site handles every transaction-wide terminal state in one place.

Per-resource outcomes (commit, server-wins, conflict-pending, validation-failed, permission-denied, etc.) are NOT handled at the await-site — they're delivered to the per-type [`onTransactionResourceResolution`](#resourcesontransactionresourceresolution) handler (or its per-call override). The await-site's `switch` only needs to handle the transaction-wide cases.

### `ops` shape

`ops` is keyed by `resourceId`. Each value is an `OperationDescriptor`:

```typescript @skip-check
type OperationDescriptor =
  | { op: 'create'; nodeId: number; typeName: string; value: any }
  | { op: 'put';    eTag: string; value: any }
  | { op: 'move';   eTag: string; nodeId: number }
  | { op: 'delete'; eTag: string };
```

Multi-resource transactions are atomic: every op commits or none do.

### `TransactionOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `appVersion` | `string` | constructor's `appVersion` | Override for admin/scripting calls. |
| `newETag` | `string` | `crypto.randomUUID()` | One `newETag` shared across every op in the batch. Override for the idempotency-retry pattern (a dropped response is retried with the same `newETag` to avoid double-write). |
| `onTransactionResourceResolution` | `ResourceHandler` | per-type registered, else framework default | Per-call handler. Receives each resource's resolution (including the non-terminal `'conflict-pending'` branch where the handler's return value drives conflict resolution). Precedence: per-call > per-type registered. |
| `maxRetries` | `number` | per-type registered, else `5` | Cap on recursive `'use-this'` retries before that resource lands at `'retries-exhausted'`. |

### Example — single resource

```javascript @skip-check
const outcome = await client.resources.transaction({
  'task-42': { op: 'put', eTag, value: { title: 'New title' } },
});
```

### Example — multi-resource atomic batch

```javascript @skip-check
const newId = crypto.randomUUID();
const outcome = await client.resources.transaction({
  [newId]: { op: 'create', nodeId: 1, typeName: 'todo', value: { title, done: false } },
  'list-main': {
    op: 'put',
    eTag: listETag,
    value: { ...list, items: [...list.items, newId] },
  },
});
```

If either op fails (validation, conflict, permission), neither commits. Use this shape when one resource references another by ID — atomicity prevents orphans and dangling references.

## `client.resources.onTransactionResourceResolution` {#resourcesontransactionresourceresolution}

**Tag**: `new-in-v3`. Replaces the shipped `onETagConflict(rt, resolver, options?)` — it absorbs the conflict-resolver job and adds reactions for every per-resource outcome (committed, validation-failed, permission-denied, etc.).

```typescript @skip-check
onTransactionResourceResolution(
  resourceType: string,
  handler: ResourceHandler,
  options?: OnTransactionResourceResolutionOptions,
): void;

type ResourceHandler = (
  resourceId: string,
  resolution: TransactionResourceResolution,
) =>
  | ConflictResolverVerdict
  | Promise<ConflictResolverVerdict>
  | void;

interface OnTransactionResourceResolutionOptions {
  /** Cap on recursive `'use-this'` retries before `'retries-exhausted'`. Default 5. */
  maxRetries?: number;
  /** Default flash classes applied to bound DOM elements when this resource resolves.
   *  `null` disables the corresponding default. */
  flashClass?: {
    committed?: string | null;    // default 'lumenize-commit-success' (green outline animation)
    rolledBack?: string | null;   // default 'lumenize-conflict-revert' (red outline animation)
  };
  /** Flash duration in ms. Default 1000. */
  flashDuration?: number;
}
```

Register a per-type handler. Fires once per resource per transaction with a [`TransactionResourceResolution`](#transactionresourceresolution). The handler does two jobs in one place:

1. **Decide conflict resolutions** — when called with `{ kind: 'conflict-pending', local, server, context }`, the handler returns a [`ConflictResolverVerdict`](#conflictresolververdict) that drives the next step (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). Return `undefined` to fall through to the framework default (`{ kind: 'use-server' }`).
2. **React to terminal outcomes** — for all other resolution values, the handler's return is ignored; the handler is purely informational (flash custom classes, surface validation errors, navigate, etc.).

The same handler can fire multiple times for a single resource in a single transaction if the chain involves `'use-this'`: first call is `'conflict-pending'` → handler returns `{ kind: 'use-this', value }` → framework re-submits → maybe conflicts again → handler fires with `'conflict-pending'` again → eventually terminates at `'committed'` or `'retries-exhausted'`.

### Default flashes

When no handler is registered for a type (or when registered with default `flashClass`), the framework adds CSS classes to bound DOM elements at fields the resolution affected:

| Resolution branch | Default class | Intent |
| --- | --- | --- |
| `'committed'` | `lumenize-commit-success` | Green outline, brief animation — signals "your write landed." |
| `'use-server'`, `'permission-denied'`, `'validation-failed'`, `'retries-exhausted'` | `lumenize-conflict-revert` | Red outline, brief animation — signals "your write was reverted to a server-authoritative value." |
| `'human-in-the-loop'` | (none — app handles UX explicitly) | — |
| `'conflict-pending'` | (none — handler is deciding) | — |

The user-facing CSS lives in app stylesheets — the framework just toggles class names. See [resources.md](./resources.md) § "Custom flash visuals" for example CSS.

### Precedence

Per-call `options.onTransactionResourceResolution` on `transaction(ops, ...)` > per-type registered > framework default (`() => undefined` — applies default flashes; `'conflict-pending'` falls through to `'use-server'`).

See [TransactionResourceResolution](#transactionresourceresolution) for the input shape and [ConflictResolverVerdict](#conflictresolververdict) for the return shape on `'conflict-pending'`.

## `client.resources.transactionDebounce` {#resourcestransactiondebounce}

**Tag**: `new-in-v3`

```typescript @skip-check
transactionDebounce(
  resourceType: string,
  opts: { quietMs: number; maxWaitMs: number },
): void;
```

Configure per-keystroke debouncing for the synced-state middleware on a per-resource-type basis. The factory's synced-state middleware coalesces transaction submissions per `(resourceType, resourceId)`:

- **`quietMs`** — wait this long with no further writes to the same resource, then submit. Default `500` ms.
- **`maxWaitMs`** — if the user keeps writing forever, submit at least every `maxWaitMs`. Default `2000` ms.

Pending writes also flush on component unmount, input blur, and `client.dispose()`.

For per-write opt-out, see [`v-model.eager`](#v-modeleager).

Behavior under load: at most one transaction in flight per `(rt, rid)`; subsequent writes during in-flight buffer; flush submits using the in-flight transaction's resulting `eTag`. The state machine + property tests live in [tasks/debounce-serial-queue.md](https://github.com/lumenize/lumenize/blob/main/tasks/debounce-serial-queue.md).

## `client.dispose` {#clientdispose}

**Tag**: `new-in-v3`

```typescript @skip-check
client.dispose(): void;
// Also available on the factory return as `dispose()`.
```

Tear down the factory:

1. Flush every pending debounced write through the serial-per-resource queue.
2. Clear refcount + pending-unsubscribe timers.
3. Dispose internal effectScopes.
4. Disconnect the underlying `LumenizeClient` WebSocket.

After dispose, the store remains readable (Vue reactivity is independent) but writes no longer trigger transactions and no new subscribes fire. Typically called only in tests or at full page teardown.

## Reserved state paths

**Tag**: `implemented-in-spike`

Two top-level prefixes on the store are framework-reserved. Writes to these paths from user code are dropped (or warned in debug builds):

- **`resources.*`** — Synced resource snapshots, written by the framework on every server push. `resources.{type}.{id}.value` holds the resource value; `resources.{type}.{id}.meta` holds the eTag, change metadata, etc.
- **`lmz.*`** — Other framework-owned state. Today: `lmz.connection.*` (see [below](#lmzconnection)). Future framework-meta paths land under this prefix too.

Every other top-level segment is yours. Common conventions:

- `ui.*` — transient UI state (modal open/closed, form drafts, conflict tracking).
- `app.*` — application-wide local state (active view, current user prefs).
- Anything else — free.

The factory's `set` trap routes writes under `resources.<rt>.<rid>.value(\.|$)` to the synced-state middleware. Writes to `resources.<rt>.<rid>.meta.*` pass through middleware unchanged (server-owned, intentional) — but those paths are still server-managed in practice; user-code writes to `meta.eTag` will be warned-on in debug builds.

## `lmz.connection` {#lmzconnection}

**Tag**: `implemented-in-spike`

The factory mirrors the underlying `LumenizeClient` connection state to three reserved paths so the UI can bind declaratively without event listeners:

| Path | Type | Description |
| --- | --- | --- |
| `lmz.connection.state` | `'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected'` | Initialized to `'disconnected'`. Updated on every connection-state transition. |
| `lmz.connection.connected` | `boolean` | Initialized to `false`. `true` iff `state === 'connected'`. |
| `lmz.connection.lastConnectedAt` | `number \| undefined` | Set on each `'connected'` transition (`Date.now()`). Unset before first connect. |

The factory writes to these paths on every transition; user code never registers a connection-state listener. The initial seed values are intentional so first-paint reads never return `undefined`.

## `textMerge` {#textmerge}

**Tag**: `deferred-post-5.3.7`

```typescript @skip-check
function textMerge(server: string, local: string, base: string): string;
```

Three-way merge helper for long-form text fields. Intended for use inside a `'use-this'` resolver to preserve both the local user's edits and a concurrent server-side commit.

**Status**: not shipping in 5.3.7. The "Text fields specifically — don't leave the default" guidance in [resources.md](./resources.md) describes the pattern; until `textMerge` ships, vibe coders writing text-field resolvers either pull in `diff-match-patch` themselves or accept that fast typing during a concurrent edit can lose characters.

Shipped helper will live at `@lumenize/nebula-frontend`'s top-level export.

## `v-model.eager` {#v-modeleager}

**Tag**: `new-in-v3`

```html @skip-check
<select v-model.eager="store.resources.task[id].value.status">
  <option value="open">Open</option>
  <option value="done">Done</option>
</select>
```

Custom directive modifier shipped by `@lumenize/nebula-frontend`. Bypasses the synced-state middleware's debouncing for the bound write — the transaction submits on the next microtask after the `change` event, not after the quiet window.

**When to use it**: dropdowns, checkboxes, radio buttons, color pickers — anywhere the user's "intent to commit" is obvious from the interaction (a click, not a keystroke) and waiting 500 ms feels wrong. **When not to use it**: text inputs (debounce is doing the right thing) and any other field with rapid sub-second user activity.

Bound writes still flow through the rest of the middleware chain (deep-equal dedup, optimistic apply, eTag generation, server submission, conflict-resolver wiring) — only debounce is bypassed.

## Handler bindings {#handler-bindings}

**Tag**: `deferred-post-5.3.7`

When the handler is called with `'conflict-pending'`, the resolution carries a `context.bindings` field intended to expose the per-field DOM bindings under the conflicting resource, so the handler can trigger custom UX beyond the default flash classes (apply a class to a parent card, fire a JS animation, jump-scroll to the conflict, etc.).

```typescript @skip-check
// Shape, when the resolution is 'conflict-pending':
type ConflictPending = {
  kind: 'conflict-pending';
  local: { value: unknown; eTag: string };
  server: Snapshot;
  context: { bindings: Map<string, HTMLElement[]> };
};
```

**Status in 5.3.7**: `context.bindings` is always an empty `Map`. Vue doesn't have an Alpine-style DOM-binding registry out of the box, so the implementation needs either:

- A `v-flash` custom directive that elements opt into (handler pushes flash events through a registry the directive subscribes to), or
- A `client.bindings(rt, rid, field)` API that queries Vue's `useTemplateRef` map (factory tracks ref names during render).

Decision deferred to post-5.3.7. The argument's shape is locked so handler signatures don't churn when it lands.

## `TransactionOutcome` {#transactionoutcome}

**Tag**: `implemented-in-spike` for `'committed'` happy path (under old shape); **`new-in-v3`** for the new top-level shape with `'ok'`, `'infrastructure-error'`, and the move of per-resource detail into the handler.

`transaction()` **always resolves** with a `TransactionOutcome` — never rejects. Top-level handles transaction-wide concerns only; per-resource detail is delivered to the per-type [`onTransactionResourceResolution`](#resourcesontransactionresourceresolution) handler (or its per-call override) and is also available on `outcome.resources` for inspection at the await-site.

```typescript @skip-check
type TransactionOutcome =
  // Transaction completed — per-resource handlers have fired. `resources` carries
  // each resource's final TransactionResourceResolution for callers that want to
  // inspect at the await-site (rarely needed; the handler is the primary place).
  | { kind: 'ok'; resources: Record<string, TransactionResourceResolution> }

  // Transaction-wide failures.
  | { kind: 'ontology-stale';       clientVersion: string; currentVersion: string }
  | { kind: 'timeout' }
  | { kind: 'infrastructure-error'; error: Error };
```

The discriminant key is `kind` (same as on the per-resource [`TransactionResourceResolution`](#transactionresourceresolution) below). The variable name (`outcome` for transaction-wide, `resolution` for per-resource) carries the level distinction; the discriminant is uniformly `.kind`.

Effect on the optimistic store, per branch:

| Outcome | Optimistic store | Caller responsibility |
| --- | --- | --- |
| `'ok'` | Per-resource — see [`TransactionResourceResolution`](#transactionresourceresolution). Default flash classes already applied by the framework; per-type handler already fired. | Usually nothing; the handler is the primary place. Inspect `outcome.resources` only if you need aggregate decisions at the await-site (e.g., navigate-only-if-everything-committed). |
| `'ontology-stale'` | Optimistic state untouched. The `onShouldRefreshUI` hook fires (typically reloads the page). | Usually nothing; page reload handles it. |
| `'timeout'` | Roll back all optimistic writes for this transaction. No server response within 5–10 s. | Decide retry policy. |
| `'infrastructure-error'` | Roll back all optimistic writes for this transaction. `error` carries the underlying `Error` (network drop, mesh crash, etc.). | Decide retry / surface to user. |

## `TransactionResourceResolution` {#transactionresourceresolution}

**Tag**: `new-in-v3` (replaces the shipped flat `TransactionResolution` shape).

What the per-type handler receives for each resource in a transaction. The handler fires once per resource per transaction for terminal branches; for the non-terminal `'conflict-pending'` branch, it may fire multiple times across a `'use-this'` chain before the resource reaches a terminal resolution.

```typescript @skip-check
type TransactionResourceResolution =
  // Non-terminal — handler MAY return a ConflictResolverVerdict to drive the chain.
  // Undefined return falls through to the framework default ({ kind: 'use-server' }).
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
```

Effect on the optimistic store, per branch:

| Resolution | Optimistic state for that resource | Notes |
| --- | --- | --- |
| `'conflict-pending'` | Optimistic state unchanged from pre-resolution. Handler is deciding. | Handler returns a [`ConflictResolverVerdict`](#conflictresolververdict) to drive the next step. |
| `'committed'` | `meta.eTag` updated to the new value. Framework adds default `lumenize-commit-success` flash class. | The user's write landed. |
| `'use-server'` | Server's `value` + `meta` already written through. Framework adds default `lumenize-conflict-revert` flash class at diff fields. | The user's write was reverted to the server's authoritative value. |
| `'human-in-the-loop'` | Optimistic stays painted; no flash class. | App owns the eventual resolution submission (typically a "review later" UI). |
| `'retries-exhausted'` | Roll back to pre-write value. Framework adds default `lumenize-conflict-revert` flash. `snapshot` is the latest server snapshot; `attempts` is how many `'use-this'` re-submits ran. | Surface to user. |
| `'validation-failed'` | Roll back to pre-write value. Framework adds default `lumenize-conflict-revert` flash. `errors` carries the server's per-field messages. | Surface validation messages. |
| `'permission-denied'` | Roll back to pre-write value. Framework adds default `lumenize-conflict-revert` flash. | Surface "not authorized" message. |

The `'use-this'` verdict from the handler is intermediate — never appears as a `TransactionResourceResolution` branch — it triggers a recursive re-submission with the handler-returned value at the server's current eTag. A successful chain terminates in `'committed'`; a failed one terminates in `'retries-exhausted'`.

**Atomicity invariant**: a transaction's top-level `TransactionOutcome` is `'ok'` whenever the server responded; the per-resource breakdown reveals what each resource's final state is. Even when a resource lands at `'use-server'` (server's value won, data is consistent), the user's original `value` for that resource didn't land — but the transaction as a whole still completed normally (`'ok'`).

## `ConflictResolverVerdict` {#conflictresolververdict}

**Tag**: `implemented-in-spike` for the shape (under the old name `ConflictResolution`); renamed to disambiguate from `TransactionResourceResolution`.

What the handler returns from the `'conflict-pending'` branch.

```typescript @skip-check
type ConflictResolverVerdict =
  | { kind: 'use-server' }
  | { kind: 'use-this'; value: unknown }
  | { kind: 'human-in-the-loop' };
```

- `'use-server'` — accept the server's value, abandon local changes for this resource.
- `'use-this'` — re-submit with `value` and the server's new `eTag`. Bounded by `maxRetries` — on cap, the resource lands at `'retries-exhausted'`.
- `'human-in-the-loop'` — defer to the user. Optimistic state stays painted; the handler (or app code outside it) is responsible for any follow-up `transaction()`.

The handler can be sync or async. The in-flight queue's 5–10 s timeout is **suspended** during handler execution at `'conflict-pending'` — a modal can sit open for minutes without triggering `'timeout'`.

Returning `undefined` (or omitting the return) from `'conflict-pending'` falls through to the framework default `{ kind: 'use-server' }`. The handler is required for nothing — without one, the framework still applies sensible defaults (server-wins on conflict, default flash classes on every outcome).

For details on `context.bindings`, see [Handler bindings](#handler-bindings).

## Internal mechanics

The following surfaces are not user-facing API but are listed for completeness — they show up in error messages, debug builds, and source spelunking.

### Middleware

```typescript @skip-check
type Middleware = (args: {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  context: WriteContext;
}) => unknown;

type WriteContext = { source: 'local' | 'remote' | 'rollback' | 'computed' };
```

Fires on every write through the Proxy `set` trap. Return a value to substitute for `newValue`; return `undefined` to leave `newValue` unchanged; throw to abort the write entirely.

`context.source` discriminates origin:

- `'local'` — user-driven write (v-model, direct assignment). Synced-state middleware processes these.
- `'remote'` — server fanout. Synced-state middleware skips.
- `'rollback'` — framework restoring a pre-write value after a failed transaction. Synced-state middleware skips.
- `'computed'` — framework vivifying intermediate containers under `resources.*` so descendant access works before snapshot arrival. Synced-state middleware skips.

Register additional middleware via `use()` from the factory return. Synced-state middleware is always-on and runs first.

**Contract**: a middleware MUST NOT write to its own path inside its callback (would re-enter the `set` trap). Cross-path writes from inside a middleware ARE allowed and fire their own middleware chains.

---
title: API reference
description: API surface for @lumenize/nebula/frontend and the NebulaClient resources namespace.
---

# API reference

This page is the contract for the `@lumenize/nebula/frontend` factory + NebulaClient `resources` namespace. Every signature mentioned in [Coding your UI](./coding-your-ui.md) resolves to a section here. Conceptual explanations live there; this page is the lookup.

## Status legend

Each surface below carries one tag describing its provenance. The tags captured the **as-of-5.3.7-v1** state and the contract for what 5.3.7-v3 would implement; v3 has since shipped them — the surfaces below now live in `apps/nebula/src/frontend/` + NebulaClient (`apps/nebula/src/nebula-client.ts`).

- **`implemented-in-spike`** — validated in the Vue-in-DOM spike, then ported to `apps/nebula/src/frontend/` in v3. (The spike — `apps/nebula/spike/vue-factory/` — was removed after the port, in 5.3.7/P11.)
- **`new-in-v3`** — the spike didn't cover this; v3 designed and implemented it.
- **`deferred-post-5.3.7`** — referenced for completeness but explicitly NOT shipping in 5.3.7 (v4/post-demo). These do not exist yet.

## Summary

| Surface | Tag | Section |
| --- | --- | --- |
| `createNebulaClient(config)` | new-in-v3 | [createNebulaClient](#createnebulaclient) |
| `client.resources.subscribe(rt, rid)` | implemented-in-spike | [resources.subscribe](#resourcessubscribe) |
| `client.resources.unsubscribe(rt, rid)` | implemented-in-spike | [resources.unsubscribe](#resourcesunsubscribe) |
| `client.resources.read(rt, rid, options?)` | implemented-in-spike | [resources.read](#resourcesread) |
| `client.resources.transaction(ops, options?)` | implemented-in-spike (single-resource happy path); new-in-v3 (per-resource outcomes, infrastructure-error, multi-resource) | [resources.transaction](#resourcestransaction) |
| `client.resources.onTransactionResourceResolution(rt, handler, options?)` | new-in-v3 (replaces shipped `onETagConflict`) | [resources.onTransactionResourceResolution](#resourcesontransactionresourceresolution) |
| `client.resources.transactionDebounce(rt, opts)` (runtime override) | new-in-v3 | [resources.transactionDebounce](#resourcestransactiondebounce) |
| `client.dispose()` | new-in-v3 | [client.dispose](#clientdispose) |
| `client.logout()` | new-in-v3 | [client.logout](#clientlogout) |
| `client.orgTree.*` (org/permission tree mutations) | new-in-v3 | [client.orgTree](#clientorgtree) |
| org/permission tree at `store.lmz.orgTree` (dedicated channel, not a resource) | new-in-v3 | [OrgTreeState](#orgtreestate) |
| `ROOT_NODE_ID` (`= 1`) constant | new-in-v3 | [OrgTreeState](#orgtreestate) |
| Reserved state paths (`store.resources.*`, `store.lmz.*`) | implemented-in-spike | [Reserved state paths](#reserved-state-paths) |
| `store.lmz.connection.{state, connected, lastConnectedAt}` | implemented-in-spike | [lmz.connection](#lmzconnection) |
| `textMerge(server, local, base)` helper | new-in-v3 | [textMerge](#textmerge) |
| Handler `context.bindings` arg | deferred-post-5.3.7 | [Handler bindings](#handler-bindings) |
| `TransactionOutcome` discriminated union (top-level, what `transaction()` resolves with) | implemented-in-spike (`'committed'` shape only); new-in-v3 (kinds `'committed'` / `'rejected'` / `'timeout'` / `'infrastructure-error'` / `'ontology-stale'`, `retryable` flag on failures) | [TransactionOutcome](#transactionoutcome) |
| `TransactionResourceResolution` discriminated union (per-resource, what the handler receives) | new-in-v3 | [TransactionResourceResolution](#transactionresourceresolution) |
| `ConflictResolverVerdict` (what the handler returns for `'conflict-pending'`) | implemented-in-spike (under old `ConflictResolution` name) | [ConflictResolverVerdict](#conflictresolververdict) |
| `Snapshot` / `SnapshotMeta` (what reads, subscribes, and store entries hold) | implemented-in-spike (`meta.mimeType` new-in-v3) | [Snapshot](#snapshot) |
| `client.claims` (inherited JWT payload) | inherited from `LumenizeClient` | [client.claims](#clientclaims) |

## `createNebulaClient` {#createnebulaclient}

**Tag**: `new-in-v3`

```typescript @skip-check
function createNebulaClient(config: NebulaClientConfig): {
  client: NebulaClient;
  store: Record<string, any>;
  ready: Promise<void>;
  use: (middleware: Middleware) => () => void;
  dispose: () => void;
};
```

Wraps a `NebulaClient` with a Vue-reactive store and a middleware chain. The factory **captures the client's current connection state at creation** (replay) and then tracks transitions via its observer — so registration order doesn't matter and `store.lmz.connection.*` is correct even if the client already advanced past its initial `connecting` transition. (`store.lmz.connection.*` is cosmetic UI status only — not an authorization boundary; authorization is enforced server-side on every operation. `ready` and `client.claims` only control what UI renders.)

### Config

`NebulaClientConfig` extends [`LumenizeClientConfig`](/docs/mesh/lumenize-client) (minus `refresh` and `gatewayBindingName`) with these additional fields. In a browser session that has completed the auth discovery flow, **only `appVersion` is required** — all other fields auto-detect from the environment. The remaining fields stay configurable as escape hatches for admin/scripting callers (headless tests, server-side tooling) where there's no browser cookie or no same-origin server.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `appVersion` | `string` | required | Client's app version (lock-step with the server's ontology version). Auto-attached to every `resources.*` call. Studio's bootstrap substitutes this at deploy time; that's the entire reason Studio's `nebula.ts` has substitution markup. |
| `baseUrl` | `string` | `window.location.origin` | Origin of the back end. Default works whenever UI and API share an origin, which is Nebula's standard deployment shape (the tenant's Star serves both). Specify only for cross-origin admin/scripting use. |
| `authScope` | `string` | from deployment URL | The scope whose per-scope refresh endpoint (`/auth/{authScope}/refresh-token`) and path-scoped cookie this client uses. A deployed app is pinned to one scope, taken from the deployment URL (`window.location`). NOT readable from the refresh cookie (it's HttpOnly). Specify only for cross-origin admin/scripting callers. |
| `activeScope` | `string` | same as `authScope` | The scope a call's JWT is bound to (`aud`) — where you're currently working. Defaults to `authScope`. A wildcard-grant admin (Galaxy/Universe) sets it to any scope under their pattern to work in a child Star or back in the parent (see [Auth flows § Admin active-scope switching](./auth-flows.md#admin-active-scope-switching-within-a-wildcard-grant)). Sent in the refresh body; the server gates it with `matchAccess`. Differs from `authScope` by at least the active branch once branches exist. |
| `onShouldRefreshUI?` | `(info: OntologyStaleInfo) => void` | `() => window.location.reload()` | Invoked when the server signals the client's app version is stale. The arg type **`OntologyStaleInfo`** (`{ clientVersion: string; currentVersion: string; reason: 'ontology-stale' }`) is exported from `@lumenize/nebula/frontend` — note its `reason` field is distinct from the `'ontology-stale'` **`TransactionOutcome`** variant's `kind` (different objects: the hook receives `OntologyStaleInfo`; the awaited transaction resolves `{ kind: 'ontology-stale', clientVersion, currentVersion }`). Default reload fetches the new bundle. Pass a custom function for "new version available" UX (banner, save-first prompt, etc.). **To opt out, pass an explicit no-op `() => {}`; omitting it keeps the default reload** (a stray `null` is coerced to the default too — there is no "disable" sentinel, by design). The default reload is once-guarded (a `sessionStorage` sentinel) so an immediate re-stale after the reload shows nothing rather than looping. |
| `unsubscribeGraceMs` | `number` | `2000` | Grace period (ms) between binding-refcount reaching zero and `client.resources.unsubscribe` firing. New bindings inside the window cancel the pending unsubscribe. |

### Return shape

| Field | Type | Description |
| --- | --- | --- |
| `client` | `NebulaClient` | Lower-level API. Use for explicit subscriptions, reads, transactions, resolver registration. |
| `store` | `Record<string, any>` | Vue-reactive Proxy. Reads inside a component's `setup()` auto-subscribe to the resources they touch (refcounted, grace-period-aware). Writes under `store.resources.<rt>.<rid>.value.*` flow through the synced-state middleware → optimistic apply + debounced transaction submission. Seeded with `resources`, `lmz.connection`, and empty `ui` / `app` objects. |
| `ready` | `Promise<void>` | **Resolves** after the first successful connection — the initial token refresh has completed and `client.claims` is populated. Studio's bootstrap top-level-awaits it, so components in Studio-generated apps always render with claims present (see [client.claims](#clientclaims)). **Rejects** with a `LoginRequiredError` (mesh's existing terminal-auth signal, also delivered via the `onLoginRequired` hook — there is no separate `AuthRequiredError`) on *terminal* auth failure (no valid session — e.g. the refresh endpoint returns 401 for a logged-out visitor); the bootstrap catches it and redirects to the login / auth-discovery flow. It stays **pending** through *transient* failures (network blips, server restarts), which the client retries with backoff — so a flaky connection shows a loading state, not an error. The distinction matters: without it, a logged-out visitor's `ready` would hang forever and the top-level `await` would leave a blank page. |
| `use(middleware)` | `(mw: Middleware) => () => void` | Register an additional middleware. Returns a deregistration function. Synced-state middleware is always-on; user-supplied middleware layers on top. |
| `dispose()` | `() => void` | Same as [`client.dispose()`](#clientdispose): flush pending debounced writes, clear refcount + pending-unsubscribe timers, dispose internal scopes, and disconnect the underlying `LumenizeClient` WebSocket. |

### Example

The Studio-generated `nebula.ts` in a browser app:

```typescript @skip-check
// nebula.ts (Studio bootstrap)
import { createNebulaClient } from '@lumenize/nebula/frontend';

export const { client, store, ready } = createNebulaClient({
  appVersion: __APP_VERSION__,   // Studio substitutes at deploy time
});

// Top-level await: main.ts (and every component) imports this module, so the
// app mounts only after the first connection — client.claims is populated
// before any component renders. See § client.claims.
try {
  await ready;
} catch {
  // Terminal auth failure (logged-out visitor) — go authenticate. Transient
  // failures don't reject; they keep retrying behind a loading state.
  window.location.assign('/login');
}
```

All other fields auto-detect: `baseUrl` from `window.location.origin`, `authScope` from the deployment URL (`window.location`) with `activeScope` defaulting to it, `onShouldRefreshUI` from the default reload.

Admin/scripting form with all overrides explicit:

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
const { client, store } = createNebulaClient({
  baseUrl: 'https://my-app.example.com',
  authScope: 'acme.app.tenant-a',
  activeScope: 'acme.app.tenant-a',
  appVersion: 'v42',
  onShouldRefreshUI: () => {},    // opt out of auto-reload (null/undefined both KEEP the default reload)
});
```

See [Coding your UI § Building your UI on top of Resources](./coding-your-ui.md#building-your-ui-on-top-of-resources) for how `nebula.ts` fits into the Studio-managed bootstrap, and [tasks/nebula-studio.md § Bootstrap files](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-studio.md) for what Studio scaffolds.

## `client.resources.subscribe` {#resourcessubscribe}

**Tag**: `implemented-in-spike` (return shape reshaped in v3 — now a `Disposable` handle for `using`-compatible scope binding).

```typescript @skip-check
subscribe(resourceType: string, resourceId: string): ResourceSubscription;

interface ResourceSubscription extends Disposable {
  /** Resolves with the initial snapshot on the first server-side `handleResourceUpdate`
   *  for `(rt, rid)`. Subsequent fanout updates write through to bound state but
   *  do not re-resolve this promise. */
  readonly snapshot: Promise<Snapshot | null>;
  /** Manual unsubscribe; equivalent to leaving a `using` scope. */
  [Symbol.dispose](): void;
}
```

Subscribes synchronously (registers the subscriber row immediately); the **initial snapshot** arrives asynchronously via `handleResourceUpdate` and is exposed on `.snapshot`.

If a pending subscribe for the same `(rt, rid)` already exists, the new handle's `.snapshot` piggybacks on that pending settlement instead of issuing a duplicate request. `[Symbol.dispose]()` decrements per-handle; the underlying server-side subscription releases when the last handle disposes (mirrors auto-subscribe's refcount-with-grace).

### Idiomatic usage with `using`

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
{
  using sub = client.resources.subscribe('todo', 'task-42');
  const snap = await sub.snapshot;            // wait for initial fanout if you care
  // ... work with the resource ...
}                                              // auto-unsubscribes here
```

### Manual control (subscribe and unsubscribe in different places)

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
// Some setup code:
client.resources.subscribe('todo', 'task-42');                  // handle discarded; subscription stays live

// Some teardown code, possibly elsewhere:
client.resources.unsubscribe('todo', 'task-42');                // standalone API
```

**Typical usage**: rarely called directly. Most subscriptions happen via auto-subscribe (reading from the store inside a Vue component triggers `subscribe` on the underlying client). Call explicitly only when subscribing to a resource the UI doesn't yet bind to — warming a cache before navigation, scripting, headless tests. The `using` form is the idiomatic explicit pattern; the standalone `unsubscribe` is for cases where the subscribe and release sites legitimately differ.

**TypeScript requirement**: `Disposable` and the `using` keyword are ES2023 / TypeScript 5.2+. Studio-generated tsconfig includes the needed `lib: ["ESNext"]` or equivalent.

## `client.resources.unsubscribe` {#resourcesunsubscribe}

**Tag**: `implemented-in-spike`

```typescript @skip-check
unsubscribe(resourceType: string, resourceId: string): void;
```

Unsubscribe from a resource. Fire-and-forget. Server drops the subscriber row.

**Equivalent to calling `[Symbol.dispose]()` on the matching [`ResourceSubscription`](#resourcessubscribe) handle.** Use this standalone form when the subscribe and unsubscribe sites legitimately differ (a parent component subscribes; an unrelated event handler later unsubscribes). When subscribe and unsubscribe live in the same scope, prefer `using` — see [`subscribe`](#resourcessubscribe) for the idiomatic form.

Auto-subscribe handles the common case (component unmount → grace period → unsubscribe). Call explicitly only when you subscribed explicitly.

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

Returns `null` only if the resource was **never created**. A soft-deleted resource returns a real `Snapshot` with `meta.deleted: true` (see [Snapshot](#snapshot)) — `null` never means "deleted."

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
  | { op: 'create'; typeName: string; nodeId: number; value: any }
  | { op: 'put';    typeName: string; value: any;       eTag?: string }
  | { op: 'move';   typeName: string; nodeId: number;   eTag?: string }
  | { op: 'delete'; typeName: string;                   eTag?: string };
```

`typeName` is required on every op (needed for client-side `eTag` lookup on put/move/delete; matches `create`'s pre-existing requirement).

**`eTag` auto-derives from the local store.** For `put` / `move` / `delete`, omitting `eTag` causes the factory to look up `store.resources.<typeName>[<resourceId>]?.meta?.eTag` at call time and use that as the optimistic-concurrency baseline. This is the normal case — UI code never has to wire eTags manually. If the resource isn't in the local store (e.g., admin/scripting code that hasn't subscribed), the call throws a clear client-side error rather than letting the server reject; pass `eTag` explicitly to bypass auto-derive (see [Explicit eTag override](#explicit-etag-override) below).

Multi-resource transactions are atomic: every op commits or none do.

### `TransactionOptions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `appVersion` | `string` | constructor's `appVersion` | Override for admin/scripting calls. |
| `newETag` | `string` | `crypto.randomUUID()` | One `newETag` shared across every op in the batch. Override for the idempotency-retry pattern (a dropped response is retried with the same `newETag` to avoid double-write). |
| `onTransactionResourceResolution` | `Record<string, ResourceHandler>` | per-type registered, else framework default | Per-call handlers, **keyed by `resourceId`** — e.g. `{ 'task-42': handler }`. Each entry handles only its own resource; resources NOT in the map fall through to their per-type handler automatically (no defensive `rid` filtering needed). A listed resource's entry **layers in front of** its per-type handler — verdict-returning on `'conflict-pending'`, additive on terminal branches. See [Precedence](#precedence). |
| `maxRetries` | `number` | per-call value, else min across involved per-type values, else `5` | **Batch-level** cap on the conflict resolve-and-resubmit loop. On exhaustion the batch lands at top-level `{ kind: 'rejected', retryable: true }` with that resource at `'retries-exhausted'`. The retry budget is client-side policy (the server stays stateless + `newETag`-idempotent). In a multi-type batch the per-call value wins, else the **min** across the involved per-type values. |

### Example — single resource

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
// eTag auto-derives from store.resources.todo['task-42']?.meta?.eTag.
const outcome = await client.resources.transaction({
  'task-42': { op: 'put', typeName: 'todo', value: { title: 'New title' } },
});
```

### Example — multi-resource atomic batch

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
const newId = crypto.randomUUID();
const outcome = await client.resources.transaction({
  [newId]: { op: 'create', typeName: 'todo', nodeId: 1,
             value: { title, description: '', status: 'open' } },
  // per-user keying — see Coding your UI § Lists with v-for
  [client.claims.sub]: { op: 'put', typeName: 'todoList',
             value: { ...list, items: [...list.items, newId] } },
});
```

If either op fails (validation, conflict, permission), neither commits. Use this shape when one resource references another by ID — atomicity prevents orphans and dangling references.

### Explicit eTag override {#explicit-etag-override}

Pass `eTag` explicitly to bypass auto-derive. Two real use cases:

1. **Resource not in the local store** — admin/scripting code that submits a put/delete without first subscribing. Auto-derive would throw; passing `eTag` lets the call proceed.
2. **Baseline on a stashed snapshot, not the current local one** — e.g., the human-in-the-loop conflict pattern stashes a `server.meta.eTag` at conflict-detection time and submits resolution later against that specific baseline. The local store may have moved on; the stashed eTag is the right baseline. See [Resources § human-in-the-loop verdict](./resources.md#human-in-the-loop-verdict-non-blocking--defer-to-the-app).

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
// Explicit baseline — Bob's resolution submission against the stashed snapshot.
const outcome = await client.resources.transaction({
  'task-42': { op: 'put', typeName: 'todo',
               eTag: conflict.server.meta.eTag,            // ← stashed baseline, not auto-derived
               value: resolvedValue },
});
```

In typical UI code (every example outside this subsection), omit `eTag` and let the framework derive it.

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
  /** Per-type contribution to the **batch-level** `'use-this'` retry cap (the min across a
   *  batch's involved types is used; a per-call `maxRetries` overrides). On exhaustion the
   *  batch lands at top-level `{ kind: 'rejected', retryable: true }` with this resource at
   *  `'retries-exhausted'`. Default 5. */
  maxRetries?: number;
  /** Default flash classes for this resource's resolution. **Reserved — DOM flash is deferred
   *  to v4**; no effect in 5.3.7. `null` disables the corresponding default once flash lands. */
  flashClass?: {
    committed?: string | null;    // default 'lumenize-commit-success' (green outline animation)
    rolledBack?: string | null;   // default 'lumenize-conflict-revert' (red outline animation)
  };
  /** Flash duration in ms. Default 1000. */
  flashDuration?: number;
}
```

Register a per-type handler. Fires once per resource per transaction with a [`TransactionResourceResolution`](#transactionresourceresolution). The handler does two jobs in one place:

1. **Decide conflict resolutions** — when called with `{ kind: 'conflict-pending', local, server, base, context }`, the handler returns a [`ConflictResolverVerdict`](#conflictresolververdict) that drives the next step (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). Return `undefined` to fall through to the next handler in the chain (a per-type handler if this is a per-call override, then the framework default `{ kind: 'use-server' }` — see [Precedence](#precedence)). `base` is the common ancestor needed for a correct 3-way merge — see [`textMerge`](#textmerge).
2. **React to terminal outcomes** — for all other resolution values, the handler's return is ignored; the handler is purely informational (flash custom classes, surface validation errors, navigate, etc.).

The same handler can fire multiple times for a single resource in a single transaction if the chain involves `'use-this'`: first call is `'conflict-pending'` → handler returns `{ kind: 'use-this', value }` → framework re-submits → maybe conflicts again → handler fires with `'conflict-pending'` again → eventually terminates at `'committed'` or `'retries-exhausted'`.

### Default flashes

**Deferred to v4** — no DOM-flash mechanism ships in 5.3.7. Finding the bound elements needs a binding-discovery mechanism Vue doesn't provide for free, so the decision (a compiler-injected flash directive is the leading candidate) is deferred. The class vocabulary and the `flashClass` / `flashDuration` options are **reserved** so the API stays stable; they have no DOM effect in 5.3.7. When flash lands, the framework will add these classes to the affected fields' elements:

| Resolution branch | Default class | Intent |
| --- | --- | --- |
| `'committed'` | `lumenize-commit-success` | Green outline, brief animation — signals "your write landed." |
| `'use-server'`, `'permission-denied'`, `'validation-failed'`, `'retries-exhausted'` | `lumenize-conflict-revert` | Red outline, brief animation — signals "your write was reverted to a server-authoritative value." |
| `'human-in-the-loop'` | (none — app handles UX explicitly) | — |
| `'conflict-pending'` | (none — handler is deciding) | — |

When it lands, the framework will just toggle class names (the user-facing CSS lives in app stylesheets). See [Resources § Custom flash visuals](./resources.md#custom-flash-visuals).

### Precedence

The per-call `options.onTransactionResourceResolution` is a **map keyed by `resourceId`** (`Record<string, ResourceHandler>`), so each entry handles exactly one resource and resources absent from the map fall through to their per-type handler with no defensive filtering. A listed resource's per-call entry **layers in front of** that resource's per-type handler (it does not replace it):

- **`'conflict-pending'`** (verdict-returning): the resource's per-call entry first; returning `undefined` falls through to the per-type handler; *its* `undefined` falls through to the framework default (`{ kind: 'use-server' }`). The first non-`undefined` verdict wins.
- **Terminal branches** (return ignored): the per-type handler fires for every resource; a per-call entry's terminal reaction layers on top (additive) for its own resource.

Concretely: a form's `transaction(ops, { onTransactionResourceResolution: { 'task-42': handler } })` handles `task-42` and leaves a sibling `todoList` in the same batch to its per-type set-union handler — the override **can't** shadow it, because `todoList` isn't a key in the map. (The map values are ordinary `ResourceHandler`s; the `resourceId` first arg equals the key.)

See [TransactionResourceResolution](#transactionresourceresolution) for the input shape and [ConflictResolverVerdict](#conflictresolververdict) for the return shape on `'conflict-pending'`.

## `client.resources.transactionDebounce` {#resourcestransactiondebounce}

**Tag**: `new-in-v3`. Runtime override only — for normal use, debounce config is declared in the ontology and emitted into the validator bundle Studio ships with each app.

```typescript @skip-check
transactionDebounce(
  resourceType: string,
  opts: {
    quietMs?: number;       // type default for fields without an explicit setting
    maxWaitMs?: number;
    fields?: Record<string, { quietMs?: number; maxWaitMs?: number }>;
  },
): void;
```

**The primary surface for debounce config is the ontology**, not this call. Field-type-derived defaults (e.g., `boolean` → `quietMs: 0`) and explicit `@debounce(q, m)` / `@longform` annotations on the .d.ts compile into the bundle the factory loads at startup. See [Ontology § Annotations](./ontology.md#annotations).

`transactionDebounce` exists as a **runtime override** for edge cases the annotation model doesn't cover — A/B testing different debounce values, slower-network modes, role-based tuning. Precedence: runtime override > ontology annotation > type-based default > framework default (`500` / `2000`).

**Resource-level merge rule** when multiple fields have pending writes with different timings: **shortest active timer wins** for both `quietMs` and `maxWaitMs`. Clicking a `@debounce(0)` checkbox flushes the entire pending resource transaction immediately, including any pending text-field edits — which matches the intuition that the click was a deliberate commit.

Other middleware-level behaviors (always-on, not configurable per-call): pending writes flush on input blur (a `focusout` on the bound input) and on `client.dispose()` (component unmount does not itself flush — the quiet/max-wait timers, which are per-`(rt, rid)` not per-component, still submit a buffered write on schedule). At most one transaction in flight per `(rt, rid)`; subsequent writes buffer and submit using the in-flight transaction's resulting eTag. State machine + property tests at [tasks/archive/debounce-serial-queue.md](https://github.com/lumenize/lumenize/blob/main/tasks/archive/debounce-serial-queue.md).

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

## `client.logout` {#clientlogout}

**Tag**: `new-in-v3`

```typescript @skip-check
client.logout(): Promise<void>;
```

User-initiated **sign-out**: revokes + clears the (HttpOnly, path-scoped) refresh cookie via the auth logout endpoint, drops the in-memory access token, and sets `store.lmz.connection.state` to `'disconnected'`. The app then redirects to login — typically the same redirect the `ready` / `onLoginRequired` terminal-auth path uses.

Distinct from [`client.dispose()`](#clientdispose), which tears down the client/connection **without** revoking the session (a disposed client could reconnect with the same valid cookie; a logged-out one cannot). The server-side logout endpoint is a nebula-auth concern added alongside this method.

## `client.orgTree` {#clientorgtree}

**Tag**: `new-in-v3`. The client-facing namespace is built in v3; the server-side methods it proxies already exist at [`apps/nebula/src/dag-tree.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/src/dag-tree.ts).

Mutations to the app's **org/permission tree** (the DAG that resources attach to for tenancy and access control). The conceptual model — cascading permissions, the two sharing approaches — is in [Resources § Access control](./resources.md#access-control); the usage patterns and worked examples are in [Coding your UI § Mutating the org/permission tree](./coding-your-ui.md#mutating-the-orgpermission-tree).

**Reads do not go through this namespace.** The full tree is delivered on a dedicated channel to `store.lmz.orgTree.value` (an [`OrgTreeState`](#orgtreestate)) — under the framework-reserved `store.lmz.*` prefix, not `store.resources.*` (the tree isn't a resource). Bind to it reactively rather than polling a query method. `client.orgTree.*` is mutations only.

**Unlike [`transaction()`](#resourcestransaction), these reject the returned Promise on failure.** Each method is a request/response mesh call, Promise-correlated client-side: a permission failure, cycle violation, slug collision, or unknown node rejects the returned Promise. There is no `TransactionOutcome` wrapper — `try`/`catch` (or `.catch`) at the call site. (Tree mutations are infrequent and individually meaningful, so a plain reject is the right ergonomics here; the always-resolve `TransactionOutcome` is for the high-frequency resource-write path.)

**While disconnected:** there is no connection-gating here (unlike the resource write path — tree mutations hold no optimistic store state to roll back, and the await-site handles the reject). A call issued while offline is queued and sent on reconnect (or rejects on timeout); a call already in flight when the socket drops is **not** auto-resubmitted — it times out and rejects.

Every method requires the caller to hold a permission on the relevant node, resolved by the same cascading rules as resource access (`admin` on the node grants everything below it). Node ids are integers; `sub` is a JWT subject claim — a bare UUID as minted by nebula-auth (the current user's is `client.claims.sub`; grants are matched by exact string equality against the JWT `sub`). `nodeId === 1` (`ROOT_NODE_ID`) cannot be deleted, undeleted, or renamed. (One nuance: an **idempotent no-op** — adding an edge that exists, removing one that doesn't, revoking an absent grant, deleting an already-deleted node, or undeleting a live one — short-circuits to success *before* the permission check, so it neither mutates nor requires permission. This short-circuit is non-disclosing **only because** the tree is universally visible (M7) — a caller can already see every edge/grant, so "exists" (success) vs "absent" (permission-checked) reveals nothing new. If tree visibility is ever scoped per-branch, these short-circuits must move *after* the permission check, or they become an existence oracle for unauthorized callers.)

### Structural mutations (require `write`)

```typescript @skip-check
// Create a child node. `slug` must match /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
// and be unique among siblings. Returns the new node's integer id.
createNode(parentNodeId: number, slug: string, label: string): Promise<number>;

// Add a second parent edge (the co-ownership pattern — see Resources §
// Access control for the two-party share-accept flow). Requires `write` on
// the new parent AND `admin` on the child: adding a parent edge is an access
// grant in structural clothing (everyone with grants on/above the new parent
// gains cascaded access to the child's subtree), so the child side demands
// setPermission's tier. Idempotent; cycle- and sibling-slug-uniqueness-checked.
addEdge(parentNodeId: number, childNodeId: number): Promise<void>;

// Remove a parent edge ("remove from my account"). Idempotent.
removeEdge(parentNodeId: number, childNodeId: number): Promise<void>;

// Move a node from one parent to another in one step. Requires `write` on BOTH
// the old and the new parent, PLUS `admin` on the child — re-parenting adds a
// parent edge, so it has addEdge's access-widening property (see addEdge above).
// Cycle- and slug-uniqueness-checked.
reparentNode(childNodeId: number, oldParentId: number, newParentId: number): Promise<void>;

// Soft-delete (sets the node's `deleted` flag; the row survives). Idempotent.
deleteNode(nodeId: number): Promise<void>;

// Reverse a soft-delete. Idempotent.
undeleteNode(nodeId: number): Promise<void>;

// Change the slug (the URL/path segment). Validated and re-checked for
// uniqueness under every parent of the node.
renameNode(nodeId: number, newSlug: string): Promise<void>;

// Change the human-readable display label (non-empty, ≤ 500 chars).
relabelNode(nodeId: number, newLabel: string): Promise<void>;
```

The `write` permission is checked on the node being changed — for `createNode`/`removeEdge` that's the parent; for the node-targeting methods it's the node itself. Both edge-*adding* operations also require **`admin` on the child** because they widen who has cascaded access to it: `addEdge` checks `write` on the new parent **plus `admin` on the child**, and `reparentNode` checks `write` on **both** parents **plus `admin` on the child** (see the comments above).

**`createNode` is the one non-idempotent method** — it assigns a fresh server-side id, where the others are idempotent no-ops on replay. A same-slug replay *errors* on sibling-slug-uniqueness rather than creating a duplicate (no silent double-create), but an **ambiguous in-flight disconnect** (the create landed, the response was lost) rejects *without* returning the new id — the node exists and reappears in `store.lmz.orgTree` after the client reconnects. Until `createNode` becomes idempotent (a planned move to client-supplied node ids), treat a `createNode` rejection as "may or may not have landed — reload to re-sync" rather than blindly retrying (a retry with a *different* slug could duplicate).

### Permission management (require `admin`)

```typescript @skip-check
// Grant or upsert a permission tier for `sub` on `nodeId`. Cascades to all
// descendants.
setPermission(nodeId: number, sub: string, level: 'admin' | 'write' | 'read'): Promise<void>;

// Revoke `sub`'s direct grant on `nodeId`. Idempotent — no-op if absent.
revokePermission(nodeId: number, sub: string): Promise<void>;
```

`setPermission` only manages grants attached directly to `nodeId`; a user can still hold an effective permission via a grant on an ancestor. To narrow effective access, attach the resource deeper rather than revoking ancestor grants.

### `OrgTreeState` {#orgtreestate}

**Tag**: `new-in-v3` — both the type export and the tree delivery. The tree is **not a resource**: it's delivered on a dedicated channel (server `DagTree.#onChanged` → broadcast to a `clientId`-keyed registry, synthesized from `dagTree.getState()`) to `store.lmz.orgTree`, and mutated via [`client.orgTree.*`](#clientorgtree) — never `transaction()`. It's universally visible by design (every connected client gets the full tree; see M7). Authoritative spec: the "Org/permission tree delivery (design B)" item in [tasks/nebula-frontend.md § Phase 5.3.7-v3](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-frontend.md); the superseded design-space record is § DAG-tree-as-special-resource.

The shape of the tree at `store.lmz.orgTree.value`. Exported from `@lumenize/nebula/frontend`.

```typescript @skip-check
interface OrgTreeState {
  nodes: Map<number, { slug: string; label: string; deleted: boolean }>;
  edges: Set<`${number}:${number}`>;   // "parentId:childId" edge keys
  permissions: Map<number, Map<string, 'admin' | 'write' | 'read'>>;
}
```

`edges` is the canonical, wire-shippable adjacency form. For O(1) parent/child lookups during a tree walk, build an `OrgTreeView` with `buildOrgTreeView(state)` (also exported from `@lumenize/nebula/frontend`) — it derives `childrenByParent` and `parentsByChild` indexes from `edges`. See [Coding your UI § Worked example: rendering the built-in tree](./coding-your-ui.md#worked-example-rendering-the-built-in-tree).

`ROOT_NODE_ID` (`= 1`, the root node every Star is provisioned with) is also exported from `@lumenize/nebula/frontend` — the bootstrap and admin-gating examples in Coding your UI import it.

## Reserved state paths

**Tag**: `implemented-in-spike`

Two top-level prefixes on the store are framework-reserved — but "reserved" doesn't mean read-only. `store.resources.<rt>.<rid>.value.*` is the **primary write surface**: `v-model` and assignments there flow through the synced-state middleware → optimistic apply + transaction (see the `set`-trap note below). What's restricted is narrower: `meta.*` is server-owned (writes pass through but are warned in debug builds), and `store.lmz.*` is framework-written only (user writes dropped) — this prefix holds `store.lmz.connection.*` (connection state) and `store.lmz.orgTree` (the org/permission tree, delivered on its own channel and mutated via [`client.orgTree.*`](#clientorgtree), never by writing the store). For when to read off `store` vs when to call methods on `client`, see [Coding your UI § `store` vs `client`](./coding-your-ui.md#store-vs-client--what-goes-where).

- **`store.resources.*`** — Synced resource snapshots, written by the framework on every server push. `store.resources.{type}.{id}.value` holds the resource value; `store.resources.{type}.{id}.meta` holds the eTag, change metadata, etc.
- **`store.lmz.*`** — Other framework-owned state. Today: `store.lmz.connection.*` (see [below](#lmzconnection)) and `store.lmz.orgTree` (the org/permission tree — see [OrgTreeState](#orgtreestate)). Future framework-meta paths land under this prefix too.

Every other top-level segment is yours. Common conventions:

- `store.ui.*` — transient UI state (modal open/closed, form drafts, conflict tracking).
- `store.app.*` — application-wide local state (active view, current user prefs).
- Anything else — free.

The factory pre-seeds `store.ui` and `store.app` as empty objects so first-level access works with no setup. They are conveniences, not reserved — the framework never touches them after seeding. Deeper intermediate objects are app-created (no auto-vivification under non-reserved prefixes).

The factory's `set` trap routes writes under `store.resources.<rt>.<rid>.value(\.|$)` to the synced-state middleware. Writes to `store.resources.<rt>.<rid>.meta.*` pass through middleware unchanged (server-owned, intentional) — but those paths are still server-managed in practice; user-code writes to `meta.eTag` will be warned-on in debug builds.

## `store.lmz.connection` {#lmzconnection}

**Tag**: `implemented-in-spike`

The factory mirrors the underlying `LumenizeClient` connection state to three reserved paths so the UI can bind declaratively without event listeners:

| Path | Type | Description |
| --- | --- | --- |
| `store.lmz.connection.state` | `'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected'` | Initialized to `'disconnected'`. Updated on every connection-state transition. |
| `store.lmz.connection.connected` | `boolean` | Initialized to `false`. `true` iff `state === 'connected'`. |
| `store.lmz.connection.lastConnectedAt` | `number \| undefined` | Set on each `'connected'` transition (`Date.now()`). Unset before first connect. |

The factory writes to these paths on every transition; user code never registers a connection-state listener. The initial seed values are intentional so first-paint reads never return `undefined`.

## `client.claims` {#clientclaims}

**Tag**: inherited from `LumenizeClient`

NebulaClient extends [`LumenizeClient`](/docs/mesh/lumenize-client), so `client.claims` (the decoded JWT payload — `sub`, `aud`, `access`, etc.) is available with no Nebula-specific wrapping. See [mesh: LumenizeClient § Client identity](/docs/mesh/lumenize-client#client-identity-clientclaims) for the full surface. Idiomatic Nebula use is per-user keying: `store.resources.todoList[client.claims.sub]`. For admin-only UI, gate on **both** `client.claims.access?.admin` (Galaxy/Universe scope admin) and an `admin` grant in the org-tree (app admin) — see [Coding your UI § Gating admin-only UI](./coding-your-ui.md#gating-admin-only-ui).

**Type — non-null on NebulaClient.** `LumenizeClient` is generic over its claims payload — `LumenizeClient<TClaims extends { sub: string } = JwtPayload>` with `get claims(): Readonly<TClaims> | null` (it has a genuine null window before first refresh). `NebulaClient extends LumenizeClient<NebulaJwtPayload>` and **re-declares the getter to drop the `| null`** — `get claims(): Readonly<NebulaJwtPayload>` — because the availability contract below guarantees it's populated by the time app code runs. The re-declaration is behaviorally neutral (the runtime getter is the inherited one; it only narrows the type). This is what lets the doc examples write `client.claims.sub` without a `!` or `?.` and still pass strict TypeScript.

The fields app code relies on (full payload is minted by nebula-auth):

```typescript @skip-check
interface NebulaJwtPayload {
  sub: string;        // subject UUID — keys per-user resources and org-tree grants
  aud: string;        // the active universeGalaxyStarId this token is scoped to
  email: string;
  access: {
    authScopePattern: string;   // scope or wildcard, e.g. "george-solopreneur.*"
    admin?: boolean;            // true = Galaxy/Universe scope admin; omitted when false
  };
  // ...standard JWT claims (iss, exp, iat, jti) plus nebula-auth extras
}
```

**Availability contract (pinned).** Under the hood `claims` is `null` until the client's first token refresh completes, and `client` is not Vue-reactive — claims-gated bindings never re-evaluate on their own. Studio-generated apps close this window structurally: the bootstrap top-level-awaits the factory's [`ready`](#createnebulaclient) promise, so **`client.claims` is populated by the time any component renders** — which is exactly what makes the non-null narrowing sound. Code that runs *outside* that contract (admin tools, scripts, anything before `ready`) is the one place the narrowing over-promises: there, treat `claims` as possibly-null and guard with `?.`.

`sub` is a bare UUID minted by nebula-auth — the same string that keys org/permission-tree grants (see [client.orgTree](#clientorgtree)).

## `Snapshot` and `SnapshotMeta` {#snapshot}

**Tag**: `implemented-in-spike` (shape shipped server-side in [`apps/nebula/src/resources.ts`](https://github.com/lumenize/lumenize/blob/main/apps/nebula/src/resources.ts); `mimeType` lands new-in-v3 alongside files-as-resources)

What `resources.read` and `resources.subscribe` resolve with, and what every store entry holds: `store.resources.<rt>[<rid>].value` is `Snapshot.value`; `store.resources.<rt>[<rid>].meta` is `Snapshot.meta`.

```typescript @skip-check
interface Snapshot {
  value: unknown;          // structured-clone-capable; shaped by your ontology
  meta: SnapshotMeta;
}

interface SnapshotMeta {
  eTag: string;        // client-generated UUID; optimistic-concurrency token + idempotency key
  nodeId?: number;     // org/permission-tree node the resource is attached to (present on every resource snapshot)
  typeName?: string;   // ontology type name
  validFrom?: string;  // ISO 8601 — when this snapshot committed server-side
  deleted?: boolean;   // true for soft-deleted (tombstoned) resources
  mimeType?: string;   // IETF media type, set where MIME is meaningful (file resources, blobs)
}
```

- **User code reads `meta`; only the framework writes it.** Writes to `meta.*` pass through middleware unchanged but are warned-on in debug builds.
- **Tombstones are real snapshots.** A deleted resource keeps its last `value`; `meta.deleted: true` is the only deletion signal — check it *before* any `value` truthiness test (see [Coding your UI § Loading and first paint](./coding-your-ui.md#loading-and-first-paint)). A `null` from `read` means "never created", not "deleted".
- `meta.nodeId` is how UI code attaches new resources next to existing ones — [Coding your UI § Atomic append](./coding-your-ui.md#atomic-append--adding-to-a-collection) creates a todo at the list's `meta.nodeId`.
- Additional framework-owned fields (`validTo`, `changedBy`, `ontologyVersion`) exist server-side and may appear; treat `meta` as an open, read-only shape.

## `textMerge` {#textmerge}

**Tag**: `new-in-v3`

```typescript @skip-check
function textMerge(server: string, local: string, base: string): string;
```

Three-way merge helper (LCS-based) for long-form text fields, used inside a `'use-this'` resolver to preserve both the local user's edits and a concurrent server-side commit. Exported from `@lumenize/nebula/frontend`'s top level.

`base` is the **common ancestor** — the value both `local` and `server` diverged from — and it is required for the merge to preserve both sides: pass `resolution.base.value.<field>`, never `resolution.server.value.<field>`. (With `base === server` the server→base diff is empty and the merge collapses to "local wins," silently dropping the concurrent edit.) The `'conflict-pending'` resolution supplies `base` directly (see [TransactionResourceResolution](#transactionresourceresolution)) — your handler just reads `resolution.base.value`. The framework sources it client-side as the value the local edit was based on and keeps it current as that baseline advances (across a clean commit, and across a chained `'use-this'` re-conflict, where `base` becomes the previous conflict's `server` snapshot). It is never a server-side history lookup.

**Auto-registration**: a field annotated [`@longform`](./ontology.md#annotations) gets a text-merge resolver registered for it automatically — most apps never call `textMerge` directly. Call it by hand only for a custom merge inside a hand-written [`onTransactionResourceResolution`](#resourcesontransactionresourceresolution) handler. See [Resources § Text fields specifically — don't leave the default](./resources.md#text-fields-specifically--dont-leave-the-default).

**Limitations**: `textMerge` preserves *non-overlapping* concurrent edits but can garble or drop characters when two edits overlap the same span. Full protection for keystrokes typed *before* a concurrent fanout arrives is provided by the synced-state middleware holding fanouts while a resource has pending optimistic writes (shipped alongside this helper in v3). Conflict-free collaborative editing under arbitrary interleaving needs a CRDT — out of scope for 5.3.7 (see [tasks/nebula-frontend.md § Out of scope](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-frontend.md)). The sibling `setUnion` / `counterMerge` helpers remain deferred-post-5.3.7.

## Handler bindings {#handler-bindings}

**Tag**: `deferred-post-5.3.7`

When the handler is called with `'conflict-pending'`, the resolution carries a `context.bindings` field intended to expose the per-field DOM bindings under the conflicting resource, so the handler can trigger custom UX beyond the default flash classes (apply a class to a parent card, fire a JS animation, jump-scroll to the conflict, etc.).

```typescript @skip-check
// Shape, when the resolution is 'conflict-pending':
type ConflictPending = {
  kind: 'conflict-pending';
  local:  { value: unknown; eTag: string };
  server: Snapshot;
  base:   { value: unknown; eTag: string };
  context: { bindings: Map<string, HTMLElement[]> };
};
```

**Status in 5.3.7**: `context.bindings` is always an empty `Map`; DOM flash + binding discovery are **deferred to v4**. Vue has no element→path map for free, so v4 decides the mechanism — a **compiler-injected flash directive** is the leading candidate (the SFC compile pass we own injects it, so the author writes nothing). Earlier options weighed and not chosen: an author-written `v-flash` directive (authors would later have to remove it — fails the no-churn principle) and a `client.bindings(rt, rid, field)` runtime registry (most code, brittle).

Decision deferred to post-5.3.7. The argument's shape is locked so handler signatures don't churn when it lands.

## `TransactionOutcome` {#transactionoutcome}

**Tag**: `implemented-in-spike` for the `'committed'` happy path (under the old single-level shape); **`new-in-v3`** for the five-kind top-level shape (`'committed'` / `'rejected'` / `'timeout'` / `'infrastructure-error'` / `'ontology-stale'`) and the move of per-resource detail into the handler.

`transaction()` **always resolves** with a `TransactionOutcome` — never rejects. Top-level handles transaction-wide concerns only; per-resource detail is delivered to the per-type [`onTransactionResourceResolution`](#resourcesontransactionresourceresolution) handler (or its per-call override) and is also available on `outcome.resources` for inspection at the await-site.

```typescript @skip-check
type ResourceMap = Record<string, TransactionResourceResolution>;

// The await-site's one decision is "do I resubmit?" — answered by `retryable`. `kind` says
// what happened; per-op detail lives in `resources` (committed/rejected only). The union
// shows which extra fields each kind carries.
type TransactionOutcome =
  // Every op landed (atomicity ⟹ a committed batch committed every op; an op may still
  // show 'use-server' in `resources` — committed, but the server's value, not yours).
  | { kind: 'committed';            resources: ResourceMap }

  // The server processed it but nothing committed, for a per-op reason — see `resources`
  // (permission-denied / validation-failed / conflict-retries-exhausted / human-in-the-loop).
  // `retryable` is the framework's verdict on whether a blind resubmit can help (an exhausted
  // conflict → true; a permission/validation failure → false).
  | { kind: 'rejected';             retryable: boolean; resources: ResourceMap }

  // Transaction-wide failures — no per-op detail.
  | { kind: 'timeout';              retryable: true }
  | { kind: 'infrastructure-error'; retryable: true;  error: Error }
  | { kind: 'ontology-stale';       retryable: false; clientVersion: string; currentVersion: string };
```

The discriminant key is `kind` (same as on the per-resource [`TransactionResourceResolution`](#transactionresourceresolution) below). The variable name (`outcome` for transaction-wide, `resolution` for per-resource) carries the level distinction; the discriminant is uniformly `.kind`. (The three-level vocabulary — `TransactionOutcome` / `TransactionResourceResolution` / `ConflictResolverVerdict` — is deliberate over a flatter single type: each names a different altitude, and collapsing them would lose the await-site-vs-handler distinction. One-line anchor in [Resources § Awaiting transaction()](./resources.md#awaiting-transaction-at-the-call-site).)

Effect on the optimistic store, per branch:

| Outcome | Optimistic store | Caller responsibility |
| --- | --- | --- |
| `'committed'` | Per-resource — see [`TransactionResourceResolution`](#transactionresourceresolution) (an op may be `'use-server'`: committed, but the server's value). Per-type handler already fired (DOM flash is v4). | Usually nothing; the handler is the primary place. Inspect `outcome.resources` only for aggregate decisions (e.g., did every op commit *your* value, or did some resolve to `'use-server'`). |
| `'rejected'` | Per-resource, per each op's [`TransactionResourceResolution`](#transactionresourceresolution): `'permission-denied'` / `'validation-failed'` / `'retries-exhausted'` → rolled back; `'human-in-the-loop'` → optimistic paint stays. | `outcome.retryable` is the resubmit verdict (an exhausted conflict → `true`; permission/validation → `false`). Per-op detail in `outcome.resources`: `'permission-denied'` → climb the orgTree to the nearest admin → request-access; `'validation-failed'` → surface per-field errors to fix. |
| `'timeout'` | Roll back all optimistic writes. No server response within 5–10 s **while connected**. **Connection-gated** — a mere disconnect never produces it. | `retryable: true` — an idempotent resubmit (same `newETag`) can land. |
| `'infrastructure-error'` | Roll back all optimistic writes. **Connection-gated.** `error` carries the underlying `Error` (network drop, mesh crash). | `retryable: true` — resubmit (idempotent) or surface to user. |
| `'ontology-stale'` | Optimistic state untouched. The `onShouldRefreshUI` hook fires (typically reloads). | Usually nothing; page reload handles it. |

The `'timeout'` and `'infrastructure-error'` outcomes fire only for failures that occur **while the client is connected**. A plain disconnect does *not* produce them: the write path suspends while `store.lmz.connection.connected` is `false` — writes are held and re-submitted on reconnect (idempotent via `newETag`) — so a transient blip never rolls anything back. That is what makes the "your changes are queued" disconnected banner honest. (Held writes live in memory only; a full page reload while offline drops anything unsent.)

## `TransactionResourceResolution` {#transactionresourceresolution}

**Tag**: `new-in-v3` (replaces the shipped flat `TransactionResolution` shape).

What the per-type handler receives for each resource in a transaction. The handler fires once per resource per transaction for terminal branches; for the non-terminal `'conflict-pending'` branch, it may fire multiple times across a `'use-this'` chain before the resource reaches a terminal resolution.

```typescript @skip-check
type TransactionResourceResolution =
  // Non-terminal — handler MAY return a ConflictResolverVerdict to drive the chain.
  // Undefined return falls through to the framework default ({ kind: 'use-server' }).
  | {
      kind: 'conflict-pending';
      local:  { value: unknown; eTag: string };   // your in-flight edit + the baseline it was based on
      server: Snapshot;                            // the conflicting committed version
      base:   { value: unknown; eTag: string };    // common ancestor — the value `local` diverged from (see below)
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
| `'retries-exhausted'` | Roll back to the B4 baseline (the value at the eTag the failed submission asserted; for a `use-this` chain, the last conflict's server snapshot). Framework adds default `lumenize-conflict-revert` flash. `snapshot` is the latest server snapshot; `attempts` is how many `'use-this'` re-submits ran. | Surface to user. |
| `'validation-failed'` | Roll back to the B4 baseline (the value at the eTag the failed submission asserted; for a `use-this` chain, the last conflict's server snapshot). Framework adds default `lumenize-conflict-revert` flash. `errors` carries the server's per-field messages. | Surface validation messages. |
| `'permission-denied'` | Roll back to the B4 baseline (the value at the eTag the failed submission asserted; for a `use-this` chain, the last conflict's server snapshot). Framework adds default `lumenize-conflict-revert` flash. | Surface "not authorized" message. |

The `'use-this'` verdict from the handler is intermediate — never appears as a `TransactionResourceResolution` branch — it triggers a recursive re-submission with the handler-returned value at the server's current eTag. A successful chain terminates in `'committed'`; a failed one terminates in `'retries-exhausted'`.

**Atomicity invariant**: the server is atomic (all-or-nothing), so there is no mixed top-level outcome. A transaction's top-level [`TransactionOutcome`](#transactionoutcome) is `'committed'` whenever every op landed — even when a resource lands at `'use-server'` (the server's value won and the user's original `value` didn't, but the data is consistent and the op committed) — and `'rejected'` when an op failed for a per-op reason (`'permission-denied'` / `'validation-failed'` / `'human-in-the-loop'` / `'retries-exhausted'`). The per-resource breakdown in `resources` reveals each resource's final state.

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
- `'use-this'` — re-submit with `value` and the server's new `eTag`. The verdict `value` is also painted optimistically (it's a fresh optimistic write at the server baseline — the merged text is visible while the re-submission is in flight and stays painted when it commits). Bounded by `maxRetries` — on cap, the resource lands at `'retries-exhausted'`.
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

Fires on every write through the Proxy `set` trap — and on intercepted collection-mutator calls (`Map.set/delete/clear`, `Set.add/delete/clear`) on values under `store.resources.*.value`, which run the identical middleware chain as property assignments (see [tasks/archive/factory-collection-sync.md](https://github.com/lumenize/lumenize/blob/main/tasks/archive/factory-collection-sync.md)). For a mutator-driven invocation: `path` is the owning collection's path (e.g. `resources.todo.t1.value.tags`), `oldValue` is a pre-mutation snapshot of the collection, and `newValue` is the post-mutation value; returning a substitute collection applies it in place of the mutation. No-op mutations (`add` of an existing element, `set` to a deep-equal value, `delete` of an absent key, `clear` on empty) skip the chain entirely — parity with the `set` trap's deep-equal dedup. Return a value to substitute for `newValue`; return `undefined` to leave `newValue` unchanged; throw to abort the write entirely.

`context.source` discriminates origin:

- `'local'` — user-driven write (v-model, direct assignment). Synced-state middleware processes these.
- `'remote'` — server fanout. Synced-state middleware skips.
- `'rollback'` — framework restoring a pre-write value after a failed transaction. Synced-state middleware skips.
- `'computed'` — framework vivifying intermediate containers under `store.resources.*` so descendant access works before snapshot arrival. Synced-state middleware skips.

Register additional middleware via `use()` from the factory return. Synced-state middleware is always-on and runs LAST, after the user chain: a user middleware abort (throw) therefore also aborts the submission, and synced-state sees the final post-substitution value.

**Contract**: a middleware MUST NOT write to its own path inside its callback (would re-enter the `set` trap). Cross-path writes from inside a middleware ARE allowed and fire their own middleware chains.

# Phase 5.3: Subscriptions & Fanout (single-resource, demo critical path)

**Status**: Active — demo critical path
**Depends on**: Phase 5.1 (Storage Engine — shipped), Phase 5.2 (Validation/Ontology — shipped)
**Companion**: `tasks/nebula-7-client.md` (the client-side handler surface this phase wires up), `tasks/lumenize-ui.md` (the UI integration target)

> **DRAFT** — first pass written 2026-05-06 to capture design decisions while context was fresh after the task-files refactor. Has open questions throughout. Pick up in a fresh session for review and tightening.

## Goal

Wire `subscribe()` end-to-end so a connected NebulaClient can ask Star to keep it informed about changes to a specific resource, and so updates flow into `@lumenize/ui` state without the vibe coder ever thinking about it. **Single-resource subscriptions only** for the demo — multi-resource subscriptions and large-fanout architecture are post-demo concerns (see "Out of Scope" below).

The shape: `client.subscribe('todo', 'task-42')` makes Star push `{ value, meta }` snapshots to that client whenever `task-42` is upserted, deleted, or migrated. The push lands in `handleTransactionResult` (or a new `handleSubscriptionUpdate`) on NebulaClient, updates the local eTag cache, and calls `setState` on the bound `@lumenize/ui` path. The UI re-renders. Local writes (via `transaction()`) update the same `@lumenize/ui` path optimistically; the server's authoritative response replaces the optimistic value once it arrives.

## Decisions pinned

| Decision | Choice | Rationale |
| --- | --- | --- |
| **UI integration boundary** | `@lumenize/ui` `getState`/`setState`, NOT a generic event emitter on NebulaClient | Keeps NebulaClient's transport/auth concerns from leaking into UI adapters; one reactivity model |
| **Local value store** | `@lumenize/state`'s StateManager is THE store (separate package — see `tasks/lumenize-ui.md` § Package split). NebulaClient holds NO shadow cache. eTag and value live at sibling paths (e.g., `resources.todo.task-42.value` and `resources.todo.task-42.__meta`). | One source of truth, reactivity for free, no sync-two-stores hazard. The middleware reads cached eTag via `getState` when constructing optimistic transactions. `@lumenize/state` ports first (risk-free) ahead of any renderer decision. |
| **Headless mode (Node tests, scripts)** | NebulaClient depends on `@lumenize/state` directly — no renderer needed. | NebulaClient's interface dependency is on StateManager-shape (`getState`/`setState`/`subscribe`/`executeBatch`), provided by `@lumenize/state` regardless of whether `@lumenize/ui` ever ports. |
| **Subscribe scope** | Single resource (`resourceType`, `resourceId`) | Multi-resource subscriptions deferred until post-demo |
| **Fan-out path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)` | Same Handler 1 / Handler 2 plumbing already used by `transaction()` and `read()` |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required — throw if missing); `bindingName` + `instanceName` from `callContext.callChain.at(-1)` (the immediate Gateway caller) | Subscriptions are user-initiated, not mesh-to-mesh |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber | Prevents double-render when the originator already updated optimistically |
| **Guard placement** | Run guards once at subscribe time (DAG read permission); not on each fanout | Resource-level access doesn't change mid-subscription except via DAG mutation; that's a separate concern (see "Open Questions") |
| **Auto-resubscribe on reconnect** | Client maintains a local subscription registry; on LumenizeClient `connected` event, re-subscribe each entry | LumenizeClient already auto-reconnects; we just need to re-register |

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
  // 5. Push initial value to client via handleSubscriptionUpdate
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

Replace the stubs:

```typescript
@mesh()
handleTransactionResult(result: TransactionResult | Error): void {
  // Update eTag cache for each successful op
  // Push successful values into @lumenize/ui via setState callback
  // Surface conflict responses to whoever called transaction()
  // Surface errors to whoever called transaction()
}

@mesh()
handleReadResult(result: Snapshot | null | Error): void {
  // Same as above for a single read
}

@mesh()
handleSubscriptionUpdate(resourceType: string, resourceId: string, snapshot: Snapshot | null): void {
  // Update eTag cache
  // Push value into @lumenize/ui via setState callback
  // Snapshot null = resource deleted; setState to undefined or a "deleted" marker
}
```

Add a public method:

```typescript
subscribe(resourceType: string, resourceId: string, statePath?: string): Promise<Snapshot | null> {
  // 1. Add to local subscription registry { resourceType, resourceId, statePath }
  // 2. Call Star.subscribe via lmz.call
  // 3. Return the initial snapshot (resolves when handleSubscriptionUpdate fires for this pair)
}
```

The `statePath` argument is the `@lumenize/ui` state path the client should write into. Optional — if omitted, defaults to a convention like `resources.{resourceType}.{resourceId}`.

### `@lumenize/ui` middleware

A small middleware in `@lumenize/ui` takes a NebulaClient instance and (a) on local `setState` for a synced path, calls `nebulaClient.transaction(...)` with optimistic update; (b) on `nebulaClient.handleSubscriptionUpdate`, calls internal `setState` to update the bound path. The middleware is **how** subscribe-as-state is implemented under the hood; the vibe coder just declares a piece of state as synced and the middleware handles the rest.

The exact API for "declare a piece of state as synced" is a `@lumenize/ui` design question — see the JurisJS inventory (in flight in another session) for the existing `newState(key, initial)` precedent. The likely shape is `newState(key, initial, { sync: { resourceType, resourceId } })`.

### Auto-resubscribe on reconnect

LumenizeClient fires a `connected` event after auto-reconnect (need to verify the exact hook name in the existing client — the inventory notes 'connecting' / 'connected' / 'reconnecting' / 'disconnected' as ConnectionState values). On the first `connected` after `reconnecting`, walk the local subscription registry and re-call `Star.subscribe` for each entry. The server returns the current snapshot, which `handleSubscriptionUpdate` writes back into the bound state path — papers over any updates missed during the disconnect.

## Implementation Phases

### Phase 5.3.1: Star subscribe machinery

- [ ] `Subscribers` table created via `CREATE TABLE IF NOT EXISTS` in Star constructor
- [ ] `@mesh()` `subscribe` method with Handler 1 / Handler 2 pattern (mirrors `transaction()`)
- [ ] DAG read-permission check at subscribe time (uses `getNodeByPath` from Phase 3 carry-over)
- [ ] Initial snapshot delivered to client via a new `handleSubscriptionUpdate` handler
- [ ] Subscriber row inserted on success; idempotent on re-subscribe with same `(clientId, resourceType, resourceId)`

### Phase 5.3.2: Fanout on mutation

- [ ] `#onChanged` replaced with subscriber lookup + per-subscriber `lmz.call` to NEBULA_CLIENT_GATEWAY
- [ ] BroadcastChannel semantics: originator's `clientId` excluded from fanout for that mutation
- [ ] Snapshot deletion (resource deleted) pushes `null` to subscribers
- [ ] Migration write-back (Phase 5.5 branch-local): pushed updates use the migrated `vM` snapshot
- [ ] **Branch-aware subscription routing**: subscriptions are inherently branch-local (each branch is an independent Star instance — see `tasks/nebula-branches.md`). NebulaClient subscribes against the URL it's connected to, which carries the branch in its 4-tuple. Verify the subscribe wiring doesn't assume a single Star instance per `{u}.{g}.{s}`.

### Phase 5.3.3: NebulaClient handlers + subscribe API

- [ ] `handleTransactionResult` / `handleReadResult` / `handleSubscriptionUpdate` implementations replace the stubs
- [ ] All three handlers write through the bound StateManager — no internal value cache on NebulaClient. eTag and value go to sibling paths (`{statePath}.value`, `{statePath}.__meta`).
- [ ] `@lumenize/state`'s StateManager registered with NebulaClient at construction. In browsers using `@lumenize/ui`, the same StateManager instance lives behind the Juris orchestrator; in Node/headless tests, NebulaClient depends on `@lumenize/state` alone.
- [ ] Local subscription registry (in-memory `Map<resourceKey, { statePath }>`) — this stays on NebulaClient because it's transport metadata, not application state
- [ ] `client.subscribe(resourceType, resourceId, statePath?)` public method
- [ ] Initial-snapshot promise resolution flow (subscribe returns a Promise that settles when the first `handleSubscriptionUpdate` arrives for that pair)

### Phase 5.3.4: Auto-resubscribe on reconnect

- [ ] Hook into LumenizeClient's connection-state transitions; identify the right event for "reconnect succeeded"
- [ ] Walk the subscription registry on that transition; re-call `Star.subscribe` for each
- [ ] Verify nothing else needs to drain (in-flight transactions during the disconnect — out of scope?)

### Phase 5.3.5: Subscriber cleanup on disconnect

- [ ] NebulaClientGateway hook: detect WebSocket close, notify Star to remove that `clientId`'s subscriber rows
- [ ] Confirm the cleanup mechanism doesn't create a thundering-herd problem when many clients disconnect at once (e.g., during a deploy)

### Phase 5.3.6: `@lumenize/state` middleware integration (renderer-agnostic)

This middleware lives in `@lumenize/state`, NOT `@lumenize/ui` — it's the StateManager↔NebulaClient bridge and works the same whether the UI is ObjectDOM (`@lumenize/ui`) or vanilla HTML+JS-against-StateManager (the fallback). See `tasks/lumenize-ui.md` § Package split.

- [ ] Middleware that wraps a NebulaClient and registers (a) local→remote pushes via `transaction()` and (b) remote→local pushes from `handleSubscriptionUpdate`
- [ ] Synced-state declaration: `newState(key, initial, { sync })` (if `@lumenize/ui` ports) or a direct path-config API on `@lumenize/state`. Final shape pinned during 5.3.6 implementation.
- [ ] eTag reads via `getState({statePath}.__meta.eTag)`: optimistic local writes carry the cached eTag; server responds with conflict or success
- [ ] Conflict response from server → optimistic value rolled back to server's value? Or surfaced to caller for manual reconcile? **Open question.**

### Phase 5.3.7: For-docs test (one big `it`, narrative)

- [ ] Two clients subscribe to the same resource; client A writes; client B receives the update
- [ ] Client A does NOT receive its own write (BroadcastChannel semantics)
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant)
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during the disconnect

## Out of Scope (post-demo)

- **Multi-resource subscriptions** — `subscribe()` for a query result, where the subscription survives resources entering/leaving the result set. Big design space; not needed for demo.
- **Large-fanout architecture** — tiered fanout through Worker armies for >64 subscribers per resource. See `tasks/nebula-scratchpad.md` § "Fanout Broadcast Tiering."
- **Per-mutation guards on fanout** — re-checking DAG permission for each subscriber on each push. Demo accepts subscribe-time-only check.
- **Subscription to specific subtrees vs. full tree** — DAG-tree-level subscriptions (different from resource subscriptions).

## Open Questions

1. **Subscriber cleanup on disconnect** — exact mechanism. Options: (a) Gateway hooks the underlying WS close and pushes a "drop subscribers for clientId" call to Star; (b) periodic Star sweep based on last-heartbeat-from-client; (c) accept the leak for demo and clean up post-demo. (a) is right but needs Gateway plumbing.
2. **Conflict response routing** — when `handleTransactionResult` arrives with a conflict, where does the conflicting snapshot go? Two paths: surface to the caller (whoever invoked `transaction()`), update `@lumenize/ui` to the server's value, both. Probably both, but the "surface to caller" needs an API. Promise that `transaction()` returns? Callback? Event?
3. **Permission revocation mid-subscription** — if an admin revokes someone's read permission on a node while they're subscribed, the existing subscriber rows still fanout to them. Acceptable for demo (DAG mutation is a deliberate, infrequent operation; Studio probably won't surface mid-session permission changes). For production, the DAG-mutation path needs to invalidate subscribers.
4. **`getEffectivePermission` per-subscriber on notification?** Open question carried from `tasks/nebula-scratchpad.md`. Probably no for demo (subscribe-time check is sufficient); revisit for production.
5. **Subscribe-time-then-no-recheck vs subscribe-time-and-on-deploy** — when a Studio deploy changes guards/ontology, do existing subscribers get re-evaluated? Leans toward "all subscriptions invalidated, clients re-subscribe" since deploy is already disruptive (preview auto-refresh).
6. **Subscription identifier** — does `(clientId, resourceType, resourceId)` uniquely identify a subscription, or do we need a generated `subId` for multi-tab same-client cases? `instanceName` of the Gateway should already disambiguate per tab.
7. **Initial-snapshot delivery mode** — do we deliver it via the same `handleSubscriptionUpdate` (cleaner, one path) or via the `subscribe()` Promise's resolved value? Leaning same path — `subscribe()` Promise resolves *because* `handleSubscriptionUpdate` fired; the Promise is just sugar.

## Notes

- This file replaced an earlier 13-line stub during the demo-focus refactor. The two open considerations from the stub (promote `apps/nebula/test/browser/` harness; retrofit auto-spawn-wrangler-dev pattern to mesh tests) are deferred — both are testing-infrastructure improvements, not subscribe semantics. Move them to backlog if they're worth surfacing now.
- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design." Don't lose those — they're prior art.
- Fanout > 64 subscribers (large-fanout tiering) is intentionally not designed here. The demo will run with a handful of subscribers max.

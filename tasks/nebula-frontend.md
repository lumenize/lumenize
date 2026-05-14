# Nebula Frontend

**Status**: Active — demo critical path. **Framework target pivoted 2026-05-14 to Vue 3 in-DOM mode** ([vue spike outcome](archive/vue-in-dom-spike.md)).
**Progress**: Phases 5.3.0 – 5.3.6 shipped 2026-05-12/13 (some Alpine-era code being replaced — see "Already shipped" annotations). **Next: Phase 5.3.7 (Vue replan)**, sequenced docs-first.
**Depends on**: Phase 5.1 (Storage Engine — shipped), Phase 5.2 (Validation/Ontology — shipped)
**Companion docs** (canonical surface; defer to these for API + examples):

- [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) — app-generating-LLM-facing API, directives, conflict-resolution patterns, worked examples. **The source of truth for what the stack exposes.** ⚠️ Top half rewritten for Vue 3 (2026-05-14); lower half is Alpine-flavored and tagged SUPERSEDED — finish rewriting in Phase 5.3.7-v1.
- [website/docs/nebula/nebula-client.md](../website/docs/nebula/nebula-client.md) — `NebulaClient` reference
- [website/docs/nebula/auth-flows.md](../website/docs/nebula/auth-flows.md) — auth flow sequence diagrams

> **Start here (resuming the work):**
> 1. Read § "Phase 5.3.7 (Vue replan, 2026-05-14) — ACTIVE PLAN" below — that's the working section.
> 2. Phase 5.3.7-v1 (docs-first) is the immediate next step. Open [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) and finish the lower-half rewrite end-to-end against Vue's surface. Output a side `5.3.7-API-spec.md` listing every API surface the doc references; that's the spec for v3 implementation.
> 3. Sections above the Vue replan are framework-agnostic and still pinned (handlers, transaction-resolution types, ontology-version model, auth model, Star subscribe machinery). Pre-Vue Alpine-era detail has been pruned (2026-05-14 cleanup pass); a few cross-cutting references remain inline to flag what's been replaced.
> 4. Spike artifacts: factory + tests + harness live in `apps/nebula/spike/alpine-adapter/` (kept until 5.3.7-v3 ports them to `packages/nebula-frontend/`, then deleted). Spike task files are in `tasks/archive/`.

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
> - 2026-05-13 — Phase 5.3.6 restructured: (1) split into 5.3.6.0 (prereq StateManager subscriber-registration hooks), 5.3.6 (NebulaClient `bindToState`, headless), 5.3.7 (UI package, browser); old 5.3.7 for-docs tests renumbered to 5.3.8. (2) Five pinned design decisions for 5.3.6 (microtask-defer middleware, `Star.unsubscribe` mesh method, puts-only middleware, initial connection-state replay, `getBindings` option for flash wiring). (3) Flash semantic pinned to exact-path-only. (4) `x-input` two-way + cursor guard pinned for 5.3.7. (5) **UI package renamed**: `@lumenize/ui` (MIT, standalone) → `@lumenize/nebula-frontend` (UNLICENSED). Standalone publishing would have required either duplicating coding-your-ui.md as a UI-only doc (drift risk) or extracting Nebula bits into a sibling doc (refactor + cuts against the LLM-target unified-docs goal). The code is decoupled enough to extract later if a real second consumer surfaces; until then, honest framing of the coupling beats maintaining the standalone-package fiction. `@lumenize/state` stays MIT/standalone — that boundary genuinely is clean.
> - 2026-05-13 — Phase 5.3.7 split into 5.3.7a (scaffold + core bindDom + base directives + element lifecycle, ~250-350 LOC) and 5.3.7b (x-for/x-if/components/recursion/live-cursors, ~400-500 LOC). Eleven design decisions pinned ahead of impl per pre-impl review: paths-only (no ternaries in directives — doc bugs to rewrite using `state.computed()` or `x-class`/`x-if`); `$local` full Proxy with direct property assignment; live cursors for scoped values (without them tree-update-during-recompute breaks); v1 `x-input` form types limited to text/textarea/checkbox/select (radio/number/date/file deferred to future ontology-driven-forms work); component `onMount`/`onUnmount` declared via `components` option on `bindDom` mirroring `handlers`; `root.contains(el)` for move detection (tighter than `isConnected`); `bindToState` must be called before `bindDom`; `x-show` toggles `display: none`/`''`; `x-html` is unsanitized; component definitions are two-pass setup + global to bindDom root; `$trail` is `unknown[]`; `getBindings` is direct-path only (scoped-value bindings won't flash, documented limitation).
> - 2026-05-13 — Phase 5.3.6.0 + 5.3.6 shipped. 5.3.6.0: 10-LOC `onSubscriberAdded` / `onSubscriberRemoved` lifecycle hooks on `@lumenize/state`'s StateManager + 8 new tests. 5.3.6: `bindToState` integration layer in `nebula-client.ts` — setState middleware (puts-only, microtask defer, reserved-prefix filter, context-discrimination skip), refcount auto-subscribe via the new hooks with `unsubscribeGraceMs` cancel-on-rebind, `Star.unsubscribe` mesh method, third connection-state wrapper layer writing through to `lmz.connection.*` paths, `#useServerOutcome` refactored to accept `inFlight` for flash, `#applyFlash` with `getBindings`-driven top-level-field diff. Doc-drift fixed: [coding-your-ui.md](website/docs/nebula/coding-your-ui.md) end-to-end converted from `try/catch` framing to `switch (outcome.resolution)`. Baseline: 169/169 across 3 consecutive runs (was 161 — 8 new tests). Two checklist items deferred to follow-up: rollback failure-outcome tests (need deeper failure-injection harness; code path implemented) + WS-disconnect-during-grace interleaving test (need WS-disconnect tooling in baseline harness).
> - 2026-05-14 — **Phase 5.3.7 framework target pivoted from "Alpine-flavored custom directive layer" to "Vue 3 in-DOM mode"** after `tasks/archive/vue-in-dom-spike.md` ran cleanly (Q1–Q5 all green, plus retained 27/27 carry-forward). Predecessor `tasks/archive/alpine-adapter-spike.md` had reached a partial-go (Alpine locked at `@vue/reactivity@3.1.5`, no `effectScope`, no shared reactiveMap with 3.2+); the Vue spike validated the bigger reframe. Major upstream consequences: **`@lumenize/state` will be deleted** (Vue's `reactive` + `effectScope` replace it); **`@lumenize/nebula-frontend` becomes a thin factory + composables on top of Vue**, not a from-scratch directive layer; the entire Alpine-flavored x-* directive grammar below is SUPERSEDED in favor of stock `v-*` directives + recursive Vue components. The Alpine-era 5.3.7a/5.3.7b implementation plans below are KEPT as historical record but no longer drive work — the active plan is "Phase 5.3.7 (Vue replan)" inserted before them. Material spike findings: (a) Vue render effects don't activate their scope, so the factory uses `getCurrentInstance()?.scope` as a fallback inside `trackResourceRead` — ~10 LOC bridge; (b) `__v_skip: true` is dead code in Vue 3.5 in-DOM mode (Vue 3.5 probes `__v_isRef` instead, handled by pass-through); (c) factory must be created BEFORE awaiting client connection (`onConnectionStateChange` only fires on transitions); (d) `v-model` is per-keystroke by default — debouncing belongs in the synced-state middleware, not in v-model itself. Spike code in `apps/nebula/spike/alpine-adapter/` (dir kept for git-history continuity despite the framework target shift).

## Three layers, clean boundaries (Vue replan, 2026-05-14)

| Layer | Code lives | Knows about |
| --- | --- | --- |
| **Vue 3 reactivity** | `node_modules/vue` (transitive dep) | Itself only. Pure Proxy-based reactivity engine — `reactive()`, `effectScope()`, `getCurrentInstance().scope`, render effects. No Nebula knowledge. |
| **`@lumenize/nebula-frontend`** | `packages/nebula-frontend/` (to be scaffolded in 5.3.7-v3) | Vue 3 + NebulaClient. Contains: factory (`createNebulaClient`) — outer Proxy wrapper with path-aware middleware + effectScope-tied refcount + synced-state middleware + debouncing; small directives/composables (`v-model.eager`, `useNebula(...)`); `textMerge` helper. UNLICENSED. |
| **NebulaClient** | `apps/nebula/src/nebula-client.ts` → moves to `packages/nebula-frontend/src/nebula-client.ts` in 5.3.7-v3 | Mesh handlers (`handleTransactionResult`, `handleResourceUpdate`), `client.resources.{subscribe, read, transaction, onETagConflict, transactionDebounce}` API, ontology version + `onShouldRefreshUI` hook, two-scope auth model, conflict-resolver invocation, serial transaction queue. |

The factory hooks into Vue's reactivity through three primitives:

- **Outer path-aware Proxy `set` trap** — captures the full write path, runs middleware chain, forwards to Vue's `reactive()`. All writes (v-model, direct property assignment, programmatic) flow through it.
- **`effectScope` + `getCurrentInstance().scope` fallback** — refcounts resource reads per-scope, cleans up on scope dispose. The fallback bridges the Vue 3 quirk where `ReactiveEffect.run()` doesn't activate the owning scope during component renders.
- **`onScopeDispose` via `scope.run(...)`** — registers the decrement callback against the right scope. Component unmount → scope disposes → callback fires → grace period → server `unsubscribe`.

**Why the layers look different from Alpine plan:** with Vue we don't own the DOM crawler, directive grammar, MutationObserver lifecycle, per-element binding registry, or `$local` shape. Vue does all of that. Our layer is the bridge from Vue's reactivity to NebulaClient's wire protocol — middleware + refcount + debounce + conflict-resolver wiring. ~350 LOC total.

**`@lumenize/state` is being DELETED** (5.3.7-v3 deletion task). Vue's `reactive()` + `effectScope()` cover every load-bearing semantic the StateManager had. The path-based PUBLIC API survives via the factory's path-aware outer Proxy — see [memory: path-based-public-api-on-vue-reactivity](https://github.com/lumenize/lumenize/blob/main/.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_path_based_reactivity.md).

**Historical note**: the original three-layer design (`@lumenize/state` ↔ `@lumenize/nebula-frontend` ↔ `client.bindToState`) was pinned 2026-05-09, reframed 2026-05-13 (package rename + UNLICENSED), then superseded entirely 2026-05-14 by the Vue spike. Detail pruned in the 2026-05-14 cleanup; see git history for the prior plan if needed.

## Package picture (Vue replan, 2026-05-14)

| Package | Source | Scope | Status |
| --- | --- | --- | --- |
| `vue` | npm (`^3.5`) | Reactivity engine + in-DOM template compiler + directive grammar (v-*, recursive components, v-model). Transitive dep of `@lumenize/nebula-frontend`. | Used as-is |
| `@lumenize/nebula-frontend` | Written from scratch (factory pattern validated by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md)) | `createNebulaClient(config) → { client, store, use, dispose }` factory + small Vue composables (`useNebula`) + `v-model.eager` directive + `textMerge` helper. ~300 LOC factory + ~50 LOC debounce + helpers. UNLICENSED until Nebula ships externally. NebulaClient ALSO moves here from `apps/nebula/src/` in 5.3.7-v3. | Built in Phase 5.3.7-v3 |
| `vue-router` | npm (`^4`) | URL ↔ component routing, route params, navigation guards. Standard Vue 3 router; pairs natively with Vue 3.5. | Used as-is when routing is needed (Studio-blocking) |
| ~~`@lumenize/router`~~ **NOT PURSUED 2026-05-14** | ~~Written from scratch — URL ↔ state-path two-way sync. ~200 LOC.~~ Vue replan: **default to [vue-router](https://router.vuejs.org/)**. Only revisit a custom package if a real need surfaces that vue-router can't cover. URL-params-into-store (the original 200 LOC plan) collapses to ~10 LOC of `watchEffect` in app code reading `useRoute()` and writing relevant params into `store.app.*` — or shipped as a small `useRouteSync(map)` composable from `@lumenize/nebula-frontend` if Studio apps want it factored out. | Not planned |

Why Vue 3 in-DOM mode (over alternatives):

- **Native shared reactivity** with our factory's path-aware outer Proxy (Vue 3.5's `reactive()` composes cleanly; Alpine's bundled `@vue/reactivity@3.1.5` did not — see [feedback: check-transitive-version-pins](https://github.com/lumenize/lumenize/blob/main/.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_check_transitive_version_pins.md)).
- **Native recursion**, native `v-for` / `v-if` / `v-model`, native per-component scope. Zero directive code in our package.
- **No SFC build step** — in-DOM mode loads from `<script src>`, parses templates at runtime via Vue's runtime compiler. Studio can later pre-compile templates for runtime-only Vue if bundle ergonomics matter.
- **LLM training corpus** is large (Vue 3 is well-represented in LLM training data, similar to or larger than Alpine).
- **Path-based PUBLIC API preserved** via the factory's path-aware outer Proxy — user code reads `store.resources.<rt>[id].value.<field>` (path-flavored property access), middleware sees the path, conflict resolvers and synced-state behavior unchanged. The path-based-vs-Proxy-keyed framing turned out to be a false tradeoff — we get both.

DaisyUI is pinned as the styling layer — class-based, framework-free, no coupling to reactivity model. Vue is just as compatible as Alpine was.

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

> Framework-agnostic decisions below — these carry forward unchanged under the Vue replan. Vue-specific decisions live in the table in "Phase 5.3.7 (Vue replan, 2026-05-14) — ACTIVE PLAN" further down.

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Headless mode** **PINNED** | NebulaClient + factory work in Node (vitest) and browser. Factory imports from `@vue/reactivity` + `@vue/runtime-core` (both pure JS, no DOM required for headless tests). | Same factory works in Node/Workers tests as in browser; spike Phase 0a/0b verify this. |
| **API namespace** **PINNED** | `client.resources.{subscribe, read, transaction, onETagConflict, transactionDebounce}`. | `subscribe`/`read` collide with too many JS APIs to leave bare. |
| **Subscribe scope** | Single resource `(resourceType, resourceId)`. | Multi-resource subscriptions deferred. |
| **Fan-out path** | `Star → NebulaClientGateway (lmz.call) → NebulaClient (handler)`. | Same Handler 1 / Handler 2 plumbing used by `transaction()` and `read()`. |
| **Subscriber identity** | `sub` from `callContext.originAuth.sub` (required); `bindingName` + `instanceName` from `callContext.callChain.at(-1)`. | Subscriptions are user-initiated, not mesh-to-mesh. |
| **BroadcastChannel semantics** | Own messages NOT echoed back to the originating subscriber. | Prevents double-render when originator already updated optimistically. |
| **Guard placement** | DAG read-permission check once at subscribe time, not on each fanout. | Resource-level access doesn't change mid-subscription except via DAG mutation (separate concern). |
| **Auto-resubscribe on reconnect** | Client maintains local subscription registry; on LumenizeClient `connected` event after `reconnecting`, re-subscribe each entry. | LumenizeClient already auto-reconnects; only need to re-register. |
| **Resource ID character constraint** | `resourceType` and `resourceId` restricted to `[A-Za-z0-9_-]`. State path is fixed at `resources.{resourceType}.{resourceId}` (the `statePath?` override on subscribe was dropped in 5.3.3a — entire-resource-at-a-time addressing only). | Period-delimited state paths and slash-delimited URLs must be unambiguously interconvertible. Hierarchical-notify-with-deepEquals in StateManager makes deep directive bindings reactive to bulk-snapshot pushes without spurious re-renders. |
| **Reserved state-path prefixes** | Two top-level prefixes are framework-reserved: `resources.*` (synced resource snapshots — `resources.{rt}.{rid}.value` and `.meta`) and `lmz.*` (everything else framework-owned — connection state, future things). All other top-level segments (`ui.*`, `app.*`, etc.) are app-owned. Framework only touches `resources.*` and `lmz.*`. | Two prefixes, not one. `lmz.resources.*` would be strictly consistent but adds a segment to every directive in every UI — significant ongoing ergonomic cost. `resources.` is short and distinctive enough on its own; `lmz.` covers the rare framework-meta cases. App authors get the rest of the namespace. |
| **`lmz.connection.*` connection-state surfacing** **PINNED (impl moved to factory)** | NebulaClient/factory writes LumenizeClient's connection state to `lmz.connection.*` paths so the UI can bind declaratively. Paths: `lmz.connection.state` (`'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'`); `lmz.connection.connected` (boolean — true iff `state === 'connected'`); `lmz.connection.lastConnectedAt` (timestamp ms, set on each `'connected'` transition). Updated by the **factory** — wires `client.onConnectionStateChange` to write through on each transition. Factory must be created BEFORE awaiting connection so the initial transition isn't missed. | Real-time-sync demos need a visible connection-state indicator. Surfacing as state paths makes it declarative: `<div v-show="!store.lmz.connection.connected">Reconnecting…</div>` works without event listeners in user code. Three paths cover common cases (state string for fine-grained display, boolean for show/hide, timestamp for "last synced X ago" UX). *(Vue replan: directive syntax changed from `x-show` to `v-show`; impl moved from `bindToState` to factory.)* |
| **Idempotency mechanism** | Client generates the *new* eTag (`newETag`) for each transaction; server detects "current eTag equals client's `newETag`" as "your own write already landed" and returns idempotent success. | Cleaner than separate `txnId` — no server-side dedupe table, idempotency implicit in the eTag itself. Auto-retry safe across network drops. |
| **Transaction queue** | Serial — at most one transaction in flight per client; subsequent calls queue. 5–10 s timeout then resolve the in-flight Promise with `{ resolution: 'timeout' }` (queue unblocks). Caller-decided retry. Queue blocks transactions on *all* resources/fields, not just the in-flight one. Optimistic local state still paints immediately on `setState` (the middleware does `setState` first, then enqueues) — so the user sees their typing land regardless of queue state. Queue is in-memory only; refresh clears it. | Matches human editing speeds; avoids partial-application reasoning. Timeout collapses all "I don't know what happened" failure modes to one signal. Optimistic-paint-then-enqueue means visual responsiveness is unaffected by queue depth. |
| **Resolver execution suspends queue timeout** | When `handleTransactionResult` invokes an async resolver (returns a Promise), the 5–10 s timeout is suspended until the resolver settles. When the framework submits the new transaction post-resolver, a fresh timeout starts for that submission. No max-duration enforced on the resolver itself — a modal can sit open for minutes if the user gets distracted. | The 5–10 s timeout is for "I don't know what happened to this call" cases. During resolver execution, the framework knows exactly what's happening — the user has the modal. App-level timeouts on the resolver (e.g., "auto-cancel after 30s") are the caller's responsibility via `Promise.race`. |
| **Conflict resolver (per resource type)** | Registered via `client.resources.onETagConflict(resourceType, resolver, options?)`. Per-call override via `options.onETagConflict` on `transaction()`. Framework default = `() => ({ resolution: 'use-server' })`. Resolver returns `ConflictResolution` discriminated union (`'use-server'` / `'use-this'` / `'human-in-the-loop'`). Receives third `context: { bindings: Map<path, HTMLElement[]> }` for custom UX. | Conflict strategy is resource-shape-specific; per-type is the right grain. Discriminated union makes intent unambiguous. `'use-this'` triggers recursive new transaction (bounded by `maxRetries`, default 5, then transaction resolves with `{ resolution: 'retries-exhausted' }`). `'human-in-the-loop'` causes transaction to resolve with `{ resolution: 'human-in-the-loop' }`; optimistic state stays painted; app re-submits. `'use-server'` causes transaction to resolve with `{ resolution: 'use-server' }`; framework writes `server.value` through state. All terminal states are normal Promise resolutions (always-resolve contract) — see `TransactionResolution` type. |
| **Conflict flash class** | After resolution, framework compares resolved value to `local.value` field-by-field; for diff fields, adds `flashClass` to bound elements for `flashDuration` ms. Default class `lumenize-conflict-revert`, duration 1000 ms. Configurable per type via `onETagConflict('rt', resolver, { flashClass, flashDuration })`; `flashClass: null` disables. | Default visual signal that user input was changed by a conflict, without explicit UX code. Field-diff inference means only actually-affected fields flash. |
| **`ontologyVersion` on every operation** | NebulaClient constructor argument (Studio's bootstrap fills in at build time). Auto-attached to every `client.resources.*` call. `options.ontologyVersion` per-op override for admin scripts. | Lock-step UI/ontology. Star already takes it for Handler 1/2 dispatch. |
| **Staleness signal + `onShouldRefreshUI` hook** | Star's cache-miss-with-mismatch path returns `{ kind: 'ontology-stale', clientVersion, currentVersion }`. NebulaClient dispatches to registered `onShouldRefreshUI` constructor hook (no default — undefined = opted-out). Originating Promise also settles. | Centralized hook for an orthogonal signal that multiple call sites would otherwise each need to inspect. Distinct from earlier-rejected `onStaleVersion` (which was tied to one error path). |
## Three handlers, three control flows

Transaction responses, subscription pushes, and ad-hoc reads have fundamentally different control flows. Don't conflate.

| Path | Public surface | Caller-Promise resolution | State write-through |
| --- | --- | --- | --- |
| `handleTransactionResult` (`@mesh` on NebulaClient) | settles Promise from `client.resources.transaction()` (always-resolves with `TransactionResolution`) | `committed`: resolve; `'use-server'`: resolve; `'use-this'`: stays pending across recursive chain until terminal (`committed` or `'retries-exhausted'`); `'human-in-the-loop'`: resolve; `'validation-failed'`: resolve; `'permission-denied'`: resolve; `'ontology-stale'`: resolve (also dispatches to `onShouldRefreshUI`); `'timeout'`: resolve (queue-timer driven, no server response received) | `committed`: yes (write authoritative value + new eTag); `'use-server'`: yes (write `server.value`); `'use-this'`: yes (optimistic write `value`, then submit); `'human-in-the-loop'`: no (optimistic stays painted); `'validation-failed'`: rollback to last-confirmed; `'permission-denied'`: rollback to last-confirmed; `'ontology-stale'`: rollback; `'timeout'`: rollback |
| `handleResourceUpdate` (`@mesh` on NebulaClient) | resolves initial-snapshot Promise from `client.resources.subscribe()`; thereafter, fanout pushes from `Star.#fanout` | only first call settles a Promise; subsequent calls are pure side-effect | yes, unconditional — every push writes `value` to `resources.{rt}.{rid}.value` and `meta` to `resources.{rt}.{rid}.meta` |
| `client.resources.read(rt, rid)` | returns `Promise<Snapshot \| null>` | yes — caller `await`s the Snapshot | **none** — caller decides |

The first two are necessarily `@mesh` handlers because Star calls them. The third is a method; its Promise is settled by a hidden plumbing handler (`handleReadResponse(requestId, result)`) keyed on a client-generated `requestId` — see Open Question 6 (resolved 2026-05-12).

UI flow uses `subscribe` for reactive reads. `read` is the explicit-intent escape hatch for ad-hoc / scripting.

## Subscribe semantics (Vue replan, 2026-05-14)

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

### Integration entry point — `createNebulaClient(config)`

`createNebulaClient(config)` from `@lumenize/nebula-frontend` is the integration entry point. It folds four responsibilities into the factory's outer Proxy + middleware + effectScope-tied refcount + connection observer:

1. **Local writes → remote transactions** — outer Proxy `set` trap → synced-state middleware → debounced `client.resources.transaction(...)`.
2. **Auto-subscribe via reference counting** — `trackResourceRead` driven by `getCurrentInstance().scope` + `onScopeDispose`. Refcount-with-grace; `unsubscribeGraceMs` knob.
3. **Remote pushes direction** — `client.onResourceUpdate(...)` handler writes through `internalDeepWrite` with `context.source === 'remote'` (middleware sees the context and skips).
4. **Connection-state surfacing** — factory wires `client.onConnectionStateChange` directly. **Order invariant**: factory must be created BEFORE awaiting connection.

Full surface details in "Phase 5.3.7 (Vue replan)" below + the rewritten [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md).

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
- 5.3.0 — `@lumenize/state` package ported from JurisJS — ⚠️ **TO BE DELETED in Phase 5.3.7-v3 per Vue replan.** Vue's `reactive()` + `effectScope()` cover every load-bearing semantic. Test-case set will be harvested as factory tests.
- 5.3.1 — Star subscribe machinery (`Subscriptions` class + table at `apps/nebula/src/subscriptions.ts`, `@mesh subscribe`, Handler 1/2 + idempotent inserts; `subscriberBinding` column derived from `callChain.at(-1)?.bindingName`) — **STAYS** (server-side; framework-agnostic).
- 5.3.2 — Resource-mutation fanout + `Subscriptions.clear()` wired into `Star.#installState`; `NebulaClient.onBeforeCall` override to accept Star-mediated fanout — **STAYS** (server-side + cross-framework client behavior).
- 5.3.3a — NebulaClient foundation: constructor `ontologyVersion` + `onShouldRefreshUI`, **`bindToState(state)` minimal-binding form** (⚠️ to be REPLACED in 5.3.7-v3 by `createNebulaClient` factory), `client.resources.subscribe(rt, rid)`, `handleResourceUpdate`, subscribe-call coalescing — mixed: API methods stay, `bindToState` plumbing goes.
- 5.3.3b — `client.resources.read(rt, rid)` + `client.resources.transaction(ops, options?)` always-resolves; serial in-flight queue + 10 s timeout; `newETag` API; idempotency short-circuit; `TransactionError` widened with `'permission'` variant — **STAYS** (framework-agnostic API).
- 5.3.3c — Conflict-resolver machinery: `client.resources.onETagConflict(rt, resolver, options?)`, per-call override, `ConflictResolution` discriminated union, recursive `'use-this'` bounded by `maxRetries`, async resolver suspends queue timeout — **STAYS** (framework-agnostic).
- 5.3.3d — Structured ontology-staleness signal (`OntologyStaleError` + `isOntologyStaleError` in `apps/nebula/src/errors.ts`); `onShouldRefreshUI` fires on transaction, read, and subscribe paths — **STAYS** (framework-agnostic).

### Phase 5.3.0 — Port `@lumenize/state` (prerequisite) ✅ shipped 2026-05-12 — ⚠️ code being deleted in 5.3.7-v3

Ported `StateManager` from JurisJS as `@lumenize/state` (MIT). Vue's `reactive()` + `effectScope()` replace this — the package and its 80-test suite are deleted in 5.3.7-v3. Test cases worth keeping (deep-equals dedup, hierarchical-notify invariants) carry forward as factory tests.

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

### Phase 5.3.6.0 — `@lumenize/state` subscriber-registration hooks (prereq) ✅ shipped 2026-05-13 — ⚠️ code being deleted in 5.3.7-v3

Added `onSubscriberAdded` / `onSubscriberRemoved` hooks to StateManager (~10 LOC + 8 tests) to support refcount-driven auto-subscribe. Replaced under Vue replan by `effectScope` + `getCurrentInstance().scope` in the factory.

### Phase 5.3.6 — NebulaClient `bindToState` integration (headless) ✅ shipped 2026-05-13 — ⚠️ TO BE REPLACED by `createNebulaClient` factory in 5.3.7-v3

Shipped the `bindToState` integration as the bridge between `@lumenize/state` and `NebulaClient` (169-test baseline). Under the Vue replan, the entire layer is replaced by the `createNebulaClient` factory (~300 LOC, validated by [vue-in-dom-spike.md](archive/vue-in-dom-spike.md)). The four shipped responsibilities (write-through middleware, auto-subscribe refcount, connection-state surfacing, flash-class wiring) carry forward into the factory.

**Pinned decisions carrying forward to factory** (filed 2026-05-13 against pre-impl review; still load-bearing for the Vue factory):

| Question | Resolution |
| --- | --- |
| Middleware sub-path → full-value `put` | **Microtask defer.** Middleware returns `undefined` (writes pass through); after the write lands, read full `value` and submit `put`. Keeps middleware-return semantics clean. |
| `Star.unsubscribe(rt, rid)` mesh method | **Add it.** Plain `@mesh()` method on Star — no ontology check; calls `Subscriptions.removeSubscriber(resourceId, clientId)` keyed off `callContext.callChain.at(-1)?.instanceName`. |
| Middleware scope: creates vs. puts | **Puts only.** Middleware only translates writes that have a cached `meta.eTag` for `(rt, rid)`. Creates go through explicit `client.resources.transaction(...)` calls. Missing `meta.eTag` → warn-and-skip via `@lumenize/debug`. |
| Initial connection-state on factory creation | **Replay current state immediately.** Read current connection state at factory creation time and write through to `lmz.connection.state` / `.connected` / `.lastConnectedAt`. Subsequent transitions write through via the connection-observer wrapper. |
| Flash-class wiring (5.3.6 ↔ 5.3.7) | **`getBindings` option.** Headless tests pass nothing — flash is a no-op. Default flash applies on `'use-server'` only; other rollback outcomes restore-without-flash for now. |
| Flash semantic for non-leaf bindings | **Exact-path only.** `getBindings(diffPath)` returns only elements bound to `diffPath` itself, not ancestors. Users who want elaborate flash UX get the full `bindings` Map in the resolver's `context` and can implement custom class-add logic there. |

Deferred items kept for the factory port:

- **Rollback failure-outcome tests**: rollback path for `validation-failed` / `permission-denied` / `ontology-stale` / `timeout` / `retries-exhausted` needs deeper test-harness support. Code path was implemented in `#processMiddlewareOutcome`; reapply in factory. The first attempt at validation-failed rollback failed (state stayed at the invalid value — needs investigation into whether typia validation actually runs on a `put` when the resource exists; see [resources.ts:306-310](apps/nebula/src/resources.ts:306)).
- **Defensive registry cleanup on `unsubscribe`** + interleaving test: subscribe → disconnect WS → trigger 1→0 → wait > grace ms → reconnect → assert no resubscribe RTT for that key. Needs WS-disconnect tooling.
- **Spy-able `@lumenize/debug` output for tests**: cross-cutting; affects any test that wants to assert a specific log fired. Options: (a) DEBUG env-var injection + `console.debug` spy; (b) per-test `output` override on `@lumenize/debug`'s logger; (c) parallel `console.warn(...)` for must-be-observable warn cases.

### Phase 5.3.7 (Vue replan, 2026-05-14) — ACTIVE PLAN

Vue 3 in-DOM mode replaces the previously-planned Alpine-flavored custom directive layer. Deletes `@lumenize/state`. Scaffolds `@lumenize/nebula-frontend` around a factory that wraps NebulaClient.

**Architecture diff vs the Alpine plan:**

| Concept | Alpine plan (superseded) | Vue plan (active) |
| --- | --- | --- |
| Reactivity engine | `@lumenize/state` (StateManager, ported from JurisJS) | Vue 3's `reactive()` from `@vue/reactivity` (already a transitive dep of Vue) |
| DOM crawler / directives | `@lumenize/nebula-frontend` writes ~700–900 LOC of x-* directives (x-text, x-bind, x-show, x-class, x-on, x-input, x-for, x-if, x-component, x-render, x-prop, $local, $trail) | Vue's stock `v-*` directives + native recursive components. ~0 LOC of directive code in our package. |
| Auto-subscribe | MutationObserver + refcount via subscriber-registration hooks on `@lumenize/state` | Factory's Proxy `get` trap + Vue's component effectScope (via `getCurrentInstance().scope` bridge) + refcount with grace |
| User integration entry | `client.bindToState(state)` + `bindDom(root, state)` | `const { client, store } = createNebulaClient(config)`; `Vue.createApp({setup() { return { store } }}).mount('#app')` |
| Conflict resolver pattern | `client.resources.onETagConflict(rt, resolver, options?)` | Carries forward unchanged (orthogonal to framework choice) |
| Per-component state | `$local` Proxy mapped to `ui.{componentName}.{instanceKey}.*` paths | Vue's `setup()`-scoped `ref`s — native Vue idiom, no factory plumbing |
| Recursion | `x-render="own-name"` directive + `$trail` for multi-position disambiguation | Native Vue recursive component (component template references itself by `name`) |
| Live cursors for scoped values | Hand-built live-cursor mechanism for $node / loop vars / props / $local / $trail | Vue's reactivity is already live; no additional plumbing |
| `x-input` cursor preservation | Hand-built per-type dispatch (text / textarea / checkbox / select) with `selectionStart`/`selectionEnd` save/restore | Vue's `v-model` handles all standard form elements correctly out of the box |
| `flashClass` for conflict UX | `bindDom`'s `getBindings(path)` + integration-layer diff | Need a Vue-friendly equivalent (TBD — likely `client.bindings(rt, rid, field)` returning the bound `HTMLElement[]`, or a `v-flash="path"` custom directive published with the package) |
| Test harness | vitest-browser-playwright (real browser) | Same target. Spike used jsdom because of the un-fixable-yet `LumenizeClient` bundling issues (see "5.3.7 prerequisites" below); real-browser harness blocks ship. |

**Pinned decisions (Vue era):**

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Framework target** | Vue 3.5+ in-DOM mode (`vue/dist/vue.esm-bundler.js` — compiler-included, ~33 KB gzip). No SFC build step. End users author HTML with `v-*` directives + a single `Vue.createApp({...}).mount('#app')`. | Studio's "single HTML file + `<script src>`" target requires the in-DOM compiler. Pre-compiled SFCs are a future Studio-deploy optimization, not a v1 ergonomics requirement. |
| **Pinia** | NOT taken as a dependency. The factory is the store. | Pinia's `defineStore` + composable pattern leans on SFC-bundled imports; the no-build path requires import maps that defeat the simplicity win. Re-evaluate post-spike if a real cross-component coordination need surfaces. |
| **`@lumenize/state`** | DELETED. The spike confirmed Vue's `reactive()` + `effectScope()` cover every load-bearing semantic (deep-equal dedup via factory wrapper, hierarchical-notify via Vue dep tracking, batched ancestor-write fanout via Vue scheduler). | The 80-test semantic invariant set was harvested into the factory's tests; no standalone state-manager package warranted. |
| **Factory shape** | `createNebulaClient(config) → { client, store, use, dispose }`. `store` is a Vue-reactive Proxy with middleware in the `set` trap. `client` exposes connection/transaction/subscription methods. Consumer wires it in Vue via `setup() { return { store }; }`. | One entry point; same API in Node and browser. Test-app pattern survives unchanged. |
| **Factory before `connect`** | `createNebulaClient(...)` must be called BEFORE the underlying NebulaClient's connection resolves. The `onConnectionStateChange` listener only fires on future transitions; late registration would miss the initial `connecting → connected` and leave `lmz.connection.*` unpopulated. | Discovered in spike harness debugging. Doc must establish this as the natural order. Alternative considered (factory replays current state on registration) is an option for 5.3.7 but adds API surface — the order invariant is simpler. |
| **Auto-subscribe scope resolution** | Factory checks `getCurrentScope()` first (synthetic test scopes); falls back to `getCurrentInstance()?.scope` from `@vue/runtime-core` for component renders. `onScopeDispose` registered via `scope.run(...)` because Vue's render-effect path doesn't activate the component's scope at `run()` time. | The structural gotcha. Vue components' render `ReactiveEffect.run()` only sets `activeSub` (dep tracking) and `shouldTrack` — it does NOT set `activeEffectScope`. So `getCurrentScope()` returns null inside renders unless we bridge. ~10 LOC. |
| **Per-component state** | Use Vue's native `setup()` with `ref` / `reactive` for local component state. NOT the factory's store, NOT a `$local` paths-into-store mechanism. | Vue idiom; no factory mechanism needed. Vibe coder reads as native Vue. Local state isn't synced anyway — it's per-component. |
| **`v-model` debouncing** | Synced-state middleware debounces transaction submission per-resource with **500 ms quiet window + 2000 ms maxWait**. Local optimistic write fires on every keystroke (no DOM-level debounce). Transactions flush on (a) quiet window elapse, (b) maxWait elapse, (c) component unmount, (d) input blur (when reachable). Per-resource serial queue (already-pinned 5.3.6 design) ensures eTag races resolve correctly: when transaction T1 is in-flight, T2 buffers and gets submitted using T1's resulting eTag. | Per-keystroke transactions are network-chatty and pile up server-side (history table dedup is 60-min server-side; client-side debounce is independent). 500/2000 ms is the lodash-default-ish profile and matches "feels responsive but doesn't spam." Configurable per-call via `client.resources.transactionDebounce(rt, { quietMs, maxWaitMs })`; per-write opt-out via `v-model.eager` directive modifier (provided by a small Vue custom directive in `@lumenize/nebula-frontend`) for cases like select dropdowns where instant commit is right. |
| **`v-model` default trigger** | Per-keystroke (`input` event). Document `.lazy` (blur-triggered) as the standard escape for "I want to commit on blur." | Matches user expectation of "I see what I'm typing." Lazy is one modifier away. |
| **Conflict resolver hooks** | Carry forward the already-pinned `client.resources.onETagConflict(rt, resolver, options?)` API unchanged. Spike's adapter currently collapses non-`committed`-and-non-`use-server` outcomes into rollback; 5.3.7 surfaces each terminal outcome (`'use-this'`, `'human-in-the-loop'`, `'permission-denied'`, `'retries-exhausted'`, `'ontology-stale'`) per the existing `TransactionResolution` discriminated union. | Resolver semantics are framework-agnostic. Spike just hadn't wired the full surface yet. |
| **`__v_skip`** | Not used. Vue 3.5 in-DOM mode probes `__v_isRef` but not `__v_skip`; the latter was Alpine 3.x specific. Factory's Proxy passes through `__v_*` reads to the underlying Vue reactive (which answers correctly). | Q2a sub-probe verified. Removing the flag simplifies the get trap. |
| **`v-if` on `v-model`-bound paths** | Idiomatic Vue: `<template v-if="store.resources.<rt>[id]?.value"><input v-model="store.resources.<rt>[id].value.title" /></template>`. The `v-if` guard is required because `v-model` needs a real l-value path. | Standard Vue pattern. Doc must show this — vibe coders won't infer it. |
| **In-DOM template tag case** | Component tags in markup written to `innerHTML` MUST be kebab-case (`<tree-node>`); the browser HTML parser lowercases tag names before Vue sees them. Inside template strings (parsed by Vue), PascalCase works. Doc must call this out. | Browser-parser semantics; not negotiable. |
| **Client-side router** | Default to **`vue-router`** when Studio apps need routing. The original Alpine-era `@lumenize/router` plan (~200 LOC URL↔state-path sync, written from scratch) is abandoned. URL-params-into-store collapses to ~10 LOC of `watchEffect` in app code (or an optional `useRouteSync(map)` composable in `@lumenize/nebula-frontend` if Studio templates want it factored). Only revisit a custom router if vue-router exposes a concrete blocker — none foreseen. | vue-router is mature, well-documented, large LLM training corpus, integrates natively with Vue's reactivity. Building a custom router was Alpine-era thinking (we owned everything because the ecosystem didn't fit); Vue's ecosystem fits. |
| **`flashClass` for conflicts** | Defer concrete design to 5.3.7 implementation. Two viable options: (a) `client.bindings(rt, rid, field)` returns the bound `HTMLElement[]` (Vue exposes via `useTemplateRef` + the factory tracking ref names); (b) ship a small `v-flash` custom directive that listens for path-level flash events. Pick during implementation. | Vue doesn't have an Alpine-style `getBindings` equivalent out of the box; either approach is small. |

**5.3.7 prerequisites — must land before `@lumenize/nebula-frontend` ships:**

Bundling NebulaClient for real browsers is currently blocked by two transitive imports. Both are pre-existing (vue-in-dom-spike Phase -1 § 7 + § 8 — copied here for visibility):

- **`@lumenize/debug` does `await import('cloudflare:workers')` in a try/catch.** Runtime fine; vite's import-analysis fails ahead of time. Spike uses an alias stub; real fix: bundler-config guidance in the debug package README (`optimizeDeps.exclude: ['cloudflare:workers']` + `build.rollupOptions.external: ['cloudflare:workers']`) OR rework debug's auto-detection to use a runtime feature check that doesn't reference the literal specifier.
- **`@lumenize/mesh/client` pulls in `node:async_hooks` transitively via lmz-api.ts.** The client-side path doesn't USE AsyncLocalStorage in any meaningful way — ALS is for server-side request-scoped CallContext propagation. Real fix: split lmz-api into client-only / server-only modules, or lazy-load the ALS-dependent paths.

Spike workaround was Node + jsdom + `@lumenize/testing`'s `Browser` class (Phase 0a/0b/1 all in jsdom). Production-grade 5.3.7 must close both items.

**`@lumenize/nebula-frontend` skeleton (target shape):**

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
│   ├── unit/             # factory mechanics with mock client (Phase 0a equivalent)
│   ├── e2e/              # vitest-pool-workers in-process Star (Phase 0b equivalent)
│   └── browser/          # vitest-browser-playwright real-browser harness (NEW; spike used jsdom)
└── README.md
```

**Implementation phases (Vue replan):**

Sequencing intentionally docs-first. Reasoning: the entire Phase 5.3.7 pivot was triggered by reading coding-your-ui.md as user code, not by reading the implementation plan. Worked examples in user-facing prose surface design problems that abstract API reviews miss (ergonomics, defaults, naming friction). Doing the doc rewrite BEFORE implementation means design issues get caught on cheap-to-change prose; doing it after means they get caught after the implementation has ossified around the wrong shape. The spike already validated every load-bearing primitive, so the doc isn't speculating — it's nailing down the surface against proven mechanics. See [tasks/archive/vue-in-dom-spike.md](archive/vue-in-dom-spike.md) Phase 2 findings for what's locked.

#### Phase 5.3.7-v1 — Doc rewrite first (~1 day)

Finish the rewrite of [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) end-to-end. The top half (NebulaClient + store + v-model + recursion + debouncing + per-component state + text-field conflict-resolver guidance) was rewritten 2026-05-14 against the spike's validated patterns. The remaining lower half (currently marked SUPERSEDED with an x-* → v-* mapping table) needs full conversion.

- [ ] Convert every section under "Lifecycle: bindings and subscriptions" through end-of-file from Alpine x-* framing to Vue v-* framing. Read the existing prose carefully — the conflict-resolver semantics, addressing conventions, lifecycle/reactivity invariants, eTag idempotency, and `lmz.connection.*` patterns all carry forward UNCHANGED. Only the directive syntax + the bindDom/bindToState wiring shifts.
- [ ] Worked example: "DAG tree with virtual branches" — port end-to-end to Vue components. This is the hardest UI shape Nebula targets and is the strongest design-review surface. If anything feels awkward in Vue, surface it before implementation.
- [ ] Worked example: text-block editor with custom `textMerge` resolver (uses the already-added "Text fields specifically — don't leave the default" section as the API shape).
- [ ] Worked example: per-component local state via `setup() { return { expanded: ref(false) } }` replacing `$local` / `x-data`.
- [ ] Worked example: conditional rendering replacing `x-if` ternaries — `v-if` + `v-else` paths. (Note: `v-else` and `v-else-if` ARE in scope for Vue; the Alpine plan deliberately rejected `x-else` to keep grammar minimal, but Vue has them so the doc should use them.)
- [ ] Worked example: list iteration replacing `x-for` — `v-for="item in items" :key="item.id"`. Cover the foreign-key case (`v-for="todoId in store.resources.list[lid].value.items"` then nested `store.resources.todo[todoId].value.title` read inside).
- [ ] **Output a side-document `5.3.7-API-spec.md`** (in `tasks/` or as an appendix here) listing every API surface the rewritten doc references: factory signature, every config option, every method on `client.resources.*`, debounce knobs, conflict-resolver wiring, `textMerge` signature, `v-model.eager` directive shape, exports from `@lumenize/nebula-frontend`. This is the input to v3 implementation.
- [ ] **User design-review pass.** Read the rewritten doc as a vibe coder would read it. Flag any code sample that reads awkwardly, defaults that surprise, names that feel wrong. Capture findings BEFORE v2 starts.
- [ ] Delete the SUPERSEDED admonition + the v-* mapping table once the rewrite is complete. The top + bottom of the doc should be coherent end-to-end.

#### Phase 5.3.7-v2 — Prerequisites unblock (~1–2 days)

Mechanical refactors with no API surface impact. Can run in parallel with v1 if a second hand is available; serial otherwise.

- [ ] Fix `@lumenize/debug` bundler-config story: either document `optimizeDeps.exclude` + `external` for consumers, OR rewrite the auto-detection to avoid the literal `cloudflare:workers` specifier. **Add a real-browser smoke** to `packages/debug/` so the fix is regression-tested.
- [ ] Fix `@lumenize/mesh/client` async_hooks dependency: split lmz-api into client/server modules, OR lazy-load ALS-dependent code paths. **Add a real-browser smoke** to `packages/mesh/`.
- [ ] CORS audit on NebulaAuth (Phase -1 § 9 in the spike): if `@lumenize/nebula-frontend` will ever be served cross-origin from the API Worker, NebulaAuth needs `Access-Control-Allow-*` headers. Document the deployment-config story.

#### Phase 5.3.7-v3 — Scaffold + factory + Vue integration (~2 days)

Implements the API surface fixed by v1's doc rewrite. The doc is the spec; this phase makes the doc true.

- [ ] Scaffold `packages/nebula-frontend/` per CLAUDE.md "Standard Package Files" (UNLICENSED, `@lumenize/nebula-client` + `vue` deps, vitest configs for unit + e2e + browser projects).
- [ ] Port factory from `apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts`: Proxy wrapper, middleware chain, `effectScope` + `getCurrentInstance().scope` fallback, refcount + grace, `internalDeepWrite`, synced-state middleware. ~290 LOC.
- [ ] Port `nebula-client-adapter.ts` shape OR fold into factory (decision during implementation — the spike adapter exists because `createNebulaClient` was framework-agnostic; if factory becomes Vue-aware anyway, the adapter step may disappear).
- [ ] Build `debounce.ts`: per-resource `(rt, rid)` timer state, quiet/maxWait policy, flush API (called on commit, unmount, blur, dispose).
- [ ] Wire debounce into synced-state middleware: optimistic write lands immediately; transaction submission queues to the debouncer; debouncer flushes through the existing serial-per-resource queue.
- [ ] Conflict-resolver wiring: expose `client.resources.onETagConflict(rt, resolver, options?)` and per-call `options.onETagConflict`. Carry forward the full `TransactionResolution` surface (use-this recursion, retries-exhausted, human-in-the-loop, permission-denied, ontology-stale, validation-failed, timeout).
- [ ] Connection-state replay: on `createNebulaClient` registration, capture current connection state from the client and write through to `lmz.connection.*` so order-of-construction is forgiving (the harness-fix from the spike, productionized).
- [ ] Carry-forward tests: 24 Phase 0a factory-basics + 3 Phase 0b e2e (smoke, transaction-roundtrip, cross-client-fanout) + 5 Vue probes (Q1–Q5 from spike), total 32 tests across unit + e2e + browser projects.

**Correctness items surfaced in spike review (must address in v2 before shipping):**

- [ ] **eTag-race correctness in the serial queue.** Spike factory queues independent transactions per keystroke. With debouncing the in-practice race is rare, but it isn't eliminated — fast typing across the 2 s maxWait boundary can still produce two overlapping submissions. The already-pinned serial-per-resource queue must: (a) hold at most one in-flight transaction per resource; (b) buffer subsequent writes; (c) submit buffered writes using the in-flight transaction's resulting eTag, not the pre-submit eTag. Test: simulate user typing across maxWait boundary, assert exactly N coalesced transactions land with monotonically advancing eTags (no conflict resolver fired). Test: simulate cross-client commit landing while local tx is in-flight, assert conflict resolver fires once, not multiple times.
- [ ] **Re-entrancy guard on the middleware chain.** If a user-supplied middleware writes back to the store from inside its callback, the outer Proxy's `set` trap re-enters and a sloppy middleware could infinite-loop. Vue's reactivity handles its own re-entry, but our deep-equal-then-middleware-then-trigger sequence has no `inFlight` guard. Add a `Set<string>` of currently-applying paths to the factory; if a `set` trap fires for a path already in the set, skip middleware (forward direct to Vue reactive). Document the contract: "middleware MUST NOT write to its own path inside its callback; cross-path writes are fine." Add a test that intentionally writes back from middleware to verify no loop.
- [ ] **Lazy post-middleware deep-equals.** Spike runs `deepEquals(oldValue, finalValue)` twice on every write: once before middleware (skip identical writes) and once after middleware (substitution detection). The post-middleware check is wasted work when no middleware substituted. Track a `substituted: boolean` flag in the middleware loop; only run the post-middleware deep-equals if `substituted === true`. ~5 LOC savings, removes ~50% of deep-equals work on the hot path.
- [ ] **Mid-edit fanout contract.** Server fanout arriving while a user is mid-typing will visually clobber their in-progress text under the default `'use-server'` resolver. This is by-design (Nebula's optimistic + server-is-truth model), but the user-visible UX is bad for text fields. Recommendation already captured in [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md) § "Text fields specifically — don't leave the default". Ship a `textMerge(server, local, base)` helper from `@lumenize/nebula-frontend` (or pull in `diff-match-patch` if licensing allows) so users can register a text-merge resolver in one line. Test: simulate concurrent-edit conflict on a text field with `textMerge` resolver registered, assert both edits preserved.

**Things that can't be fully assessed until v2 lands — track as risks, surface during impl:**

- [ ] **Serial-queue interaction with debouncing.** Two timer-driven systems (debounce + serial queue) need careful coordination. Likely ~50 LOC of state machine: pending-writes-while-tx-in-flight buffer + debounce timer flush + maxWait flush + unmount/blur flush + transaction-result triggers buffered submit. Draw the state diagram before coding.
- [ ] **Vue `<Suspense>` / `<KeepAlive>` interaction.** Recursive trees + KeepAlive could surface scope-disposal edge cases the spike didn't exercise. Test: mount a KeepAlive'd component with subscribed resources, switch away, switch back; verify exactly-one-subscribe (resource stays subscribed across keep-alive cycle, or properly unsubs + resubs). Test: `<Suspense>` boundaries inside recursive trees — async setup during recursion shouldn't double-subscribe.
- [ ] **Real-browser vs jsdom divergence.** Phase 5.3.7-v3's real-browser harness will surface things the spike couldn't see: input event timing, IME composition events (Asian languages — typing Chinese/Japanese/Korean fires composition events the spike never exercised), focus management around `v-model.lazy`, paint scheduling. Vue's surface is battle-tested but our debounce/flush-on-blur interaction with composition events is novel. Test: IME composition probe — type a multi-key character, verify exactly one transaction fires after composition ends, not one per intermediate keystroke.
- [ ] **Bundle ergonomics for end users.** Studio's deploy could pre-compile templates to runtime-only Vue (~22 KB gzip), saving ~11 KB vs the in-DOM compiler build (~33 KB gzip). The decision is deferrable to Studio's deploy work, but should be a conscious choice. Open question: do we ship `vue/dist/vue.esm-browser.js` as the canonical `<script src>` target (compiler-included), or do we publish a Studio-deploy mode that pre-compiles + ships runtime-only? Document the trade-off in `@lumenize/nebula-frontend` README once that package exists.

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
- [ ] New page (or section): "Using @lumenize/nebula-frontend with Vue" covering single-HTML-file CDN load, build-step option for SFC users, debounce knobs.
- [ ] Document the IME / composition behavior + the `v-model.eager` directive in the docs (these are the most likely "huh, why does it do that?" support questions).

**Deletions (post-merge):**

- [ ] `packages/state/` — entire directory, including 80 tests. Harvest test cases as comments in the factory's test file if any aren't already covered.
- [ ] `apps/nebula/spike/alpine-adapter/` — entire directory once 5.3.7-v2 lands. Keep until then for reference.
- [ ] `nebula-client.ts`'s `bindToState` + supporting machinery — replaced by the factory's middleware + effectScope.

**Dead-code audit (after the obvious deletions land):**

The Alpine → Vue pivot likely leaves orphaned helpers, types, and code paths beyond the three obvious deletions above. Catch them before they rot. Two complementary passes:

- [ ] **Coverage-driven sweep**: run `npm test` with coverage on `apps/nebula/` + `packages/nebula-frontend/` after v3 lands. Anything at 0% coverage that isn't a known untested-but-load-bearing path (e.g., test-only initiators marked `@internal`) is a candidate. Workflow: open each 0%-coverage file, ask "is the caller of this still alive?", delete if no.
- [ ] **Static review of changed files**: walk every file modified in the 5.3.7 series (`git diff --stat origin/main...HEAD -- apps/nebula packages/nebula-frontend packages/mesh`). For each, scan for: unused exports (the factory replaces `bindToState`'s plumbing — likely orphaned helpers in `nebula-client.ts`); types that only the Alpine path referenced (`StateManager` type imports, `BindingRecord`, `$local`-shape types, `getBindings`-related types); refcount/grace-period logic that's now driven by Vue's effectScope instead of the StateManager hooks; `setState` middleware bookkeeping (`oldValue` stash for rollback, `source` context tag, microtask-defer queue) that may have moved to the factory but left a shadow in NebulaClient.
- [ ] Specific things to look for given what the pivot did:
  - `#subscriptionRegistry` ↔ factory's refcount Map: one or the other should own this, not both
  - `#applyFlash` + `#perTypeResolvers` flash-class state: factory inherits the resolver registry, but `#applyFlash` and `getBindings` plumbing may be dead
  - `internalDeepWrite` vs StateManager's `setState({ source: 'remote' })`: pick one path through
  - reserved-prefix filter regex (`^resources\\.[^.]+\\.[^.]+\\.value(\\.|$)`) — does the factory's Proxy `set` trap still need it, or does the path-aware middleware express the same intent more naturally?
- [ ] **Probe the coding-your-ui.md doc against the shipped API**: every API surface mentioned in the v1-rewritten doc should resolve to a real export from `@lumenize/nebula-frontend` or `@lumenize/nebula-client`. Anything mentioned in the doc that doesn't exist is a TODO; anything exported that the doc doesn't mention is a candidate for deletion (the doc IS the spec post-v1).

**Out of scope for 5.3.7 (post-demo):**

- Pre-compiled SFC mode (Studio deploy-time vite step replacing the runtime in-DOM compiler).
- `flashClass` rich-diff support (field-level rendering of WHAT changed, not just THAT it changed).
- Multi-resource subscriptions / query subscribe (still out of scope per § "Out of scope (post-demo)").

### Phase 5.3.8 — For-docs tests (one big `it`, narrative)

> **Vue replan (2026-05-14)**: Test items below are mostly framework-agnostic (they exercise NebulaClient + factory + Star semantics, not directive syntax). A handful reference Alpine specifics (`x-text`, `x-for`, `x-if`, `state.computed`, MutationObserver lifecycle) — those are tagged inline with their Vue equivalents. The framework-agnostic tests are CARRIED FORWARD unchanged; the directive-specific tests get rewritten against the Vue surface during 5.3.7-v4 (real-browser harness phase).

All async probes use `vi.waitFor` (Vue's reactive scheduler is microtask-deferred; grace periods need real time).

- [ ] Two clients subscribe to same resource; client A transactions; client B's bound store path updates via `handleResourceUpdate` *(framework-agnostic; carries forward unchanged)*
- [ ] BroadcastChannel: client A doesn't receive own update via fanout; instead reflects authoritative value via `handleTransactionResult`'s success path *(framework-agnostic)*
- [ ] `'use-server'` resolution: loser's resolver returns `{ resolution: 'use-server' }`; framework writes server value through; transaction Promise resolves with `{ resolution: 'use-server', resources }` *(framework-agnostic)*
- [ ] `'use-this'` resolution: loser returns `{ resolution: 'use-this', value }`; framework submits new transaction with `eTag = server.meta.eTag`. Verify recursion: second submission also conflicts → resolver fires again → eventually succeeds (Promise resolves with `{ resolution: 'committed', eTag }`). *(framework-agnostic)*
- [ ] `maxRetries` exhaustion: resolver always returns `'use-this'`, every submission conflicts; after default 5 attempts, transaction Promise resolves with `{ resolution: 'retries-exhausted', attempts: 5, resources }` *(framework-agnostic)*
- [ ] `'human-in-the-loop'`: resolver returns the handoff; transaction Promise resolves with `{ resolution: 'human-in-the-loop', resources }`; optimistic state stays painted (NOT overwritten); no new transaction; test then manually submits follow-up *(framework-agnostic)*
- [ ] Per-call override: `transaction(ops, { onETagConflict: customResolver })` overrides per-type registered resolver for that call only *(framework-agnostic)*
- [ ] Idempotency probe: drop a transaction response (test-only); client retries with same `newETag`; server returns idempotent success without duplicate *(framework-agnostic)*
- [ ] `client.resources.read(rt, rid)` returns current snapshot without writing to bound store *(framework-agnostic)*
- [ ] Staleness probe: client constructed with `'v1'`, server now `'v2'`; transaction → `onShouldRefreshUI` fires with `{ clientVersion: 'v1', currentVersion: 'v2', reason: 'ontology-stale' }` *(framework-agnostic)*
- [ ] Connection-state probe: trigger LumenizeClient connection events programmatically; assert `lmz.connection.state` / `lmz.connection.connected` / `lmz.connection.lastConnectedAt` paths update correctly on each transition *(framework-agnostic)*
- [ ] Permission-denied probe: attempt a write the user isn't authorized for; transaction Promise resolves with `{ resolution: 'permission-denied', resources }`; optimistic state rolls back to last-confirmed *(framework-agnostic)*
- [ ] Flash class: after `'use-server'` where local differed from server, framework flashes bound elements at diff fields (mechanism TBD per 5.3.7 flash-class design decision); removed after `flashDuration` ms. Test both default class and custom; verify `flashClass: null` disables. *(Vue-version: depends on the chosen flash mechanism — `v-flash` directive or `client.bindings(rt, rid, field)` API.)*
- [ ] Resolver bindings: resolver context exposes elements bound to paths under conflicting resource (mechanism TBD per flash-class design)
- [ ] Auto-subscribe probe: Vue component reading `store.resources.{rt}.{rid}.value.<field>` in a template triggers `client.resources.subscribe` automatically on mount *(Vue-version: replaces Alpine `x-text` probe; same intent)*
- [ ] Dynamic-DOM addition: mount a new Vue component instance with new `(rt, rid)`; auto-subscribe triggers `subscribe` *(Vue-version: replaces MutationObserver-driven add probe; Vue component scope drives this)*
- [ ] Component-unmount + grace period: unmount a component referencing `(rt, rid)`; refcount → 0; `unsubscribe` does NOT fire immediately; after `unsubscribeGraceMs`, fires *(Vue-version: replaces MutationObserver-driven remove probe; same semantics via `onScopeDispose`)*
- [ ] Grace-period cancel: unmount + remount within grace (e.g., via `v-if` toggle); pending `unsubscribe` is cancelled (never fires) *(Vue-version: `v-if` toggle replaces DOM remove+add)*
- [ ] `<KeepAlive>` interaction: cached component referencing a resource stays subscribed across activate/deactivate cycles (or properly unsubs+resubs — design decision per "Things that can't be fully assessed") *(NEW Vue-specific probe; was N/A under Alpine plan)*
- [ ] `v-for` inline-array iteration: N items render correctly; mutations (push/pop/reorder) update correctly with `:key` preserving instance identity *(Vue-version: replaces `x-for`)*
- [ ] `v-for` FK with nested resource read: auto-subscribe fires per ID inside the loop body; removal triggers grace-period unsubscribe *(Vue-version: replaces `x-for $loopVar`)*
- [ ] `v-if` mount/unmount: bindings register/unregister with the conditional content *(Vue-version: replaces `x-if`)*
- [ ] `v-for` + nested `v-if` (filtered iteration): clones mount/unmount independently
- [ ] Vue `computed()` driving `v-if`: derivation re-runs on source change; `v-if` reacts *(Vue-version: replaces `state.computed()`)*
- [ ] Test object includes Map, Date, and Cycle (Phase 5 testing invariant) *(framework-agnostic)*
- [ ] Disconnect/reconnect: client B re-subscribes automatically and receives any updates that landed during disconnect *(framework-agnostic)*
- [ ] **IME composition probe** (NEW Vue-specific, real-browser only): multi-key character composition (e.g., Japanese input) fires `compositionstart` / `compositionupdate` / `compositionend` events; exactly one transaction fires after composition ends, not one per intermediate keystroke
- [ ] **Debounce flush-on-blur probe** (NEW): pending debounced write flushes when the bound input loses focus, even if the quiet window hasn't elapsed
- [ ] **Debounce maxWait probe** (NEW): continuous typing across the maxWait boundary produces ≥1 transaction per maxWait window, not zero
- [ ] **`v-model.eager` probe** (NEW): writes via `v-model.eager` bypass debouncing and fire transactions immediately

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

1. **Same-field conflict cascade during async resolver.** If a user has a modal open for `resources.todo.task-42.value.title` and keeps typing into that same title field while the modal is open, the additional typing enqueues new transactions with the pre-conflict `meta.eTag`. After the modal resolves and T1's submission lands, T2 fires with the now-stale eTag, conflicts against the server's new eTag, and the modal pops *again* with the latest server snapshot. Semantically correct (each conflict gets the user's choice); visually noisy ("why does this keep popping up?"). **Triage**: not solving for v1 — Studio-generated UIs rarely have a user typing into the field that's mid-conflict (the modal grabs focus). Possible v2 fixes: re-tag queued transactions with the latest server eTag at submission time, or batch typing into the same field while a modal is up (don't queue per-keystroke transactions). **Update 2026-05-14 (Vue replan)**: the pinned debouncing policy (500 ms quiet + 2000 ms maxWait, plus serial-per-resource queue using in-flight tx's resulting eTag for buffered writes) substantially mitigates this — fast typing during a modal becomes one buffered transaction submitted with the post-resolver eTag, not N queued transactions with stale eTags. The "noisy modal re-pop" still exists if typing crosses the maxWait boundary, but the typical case (sub-2-second modal interaction) is clean.

2. **Re-conflict during human-in-the-loop batch resolution.** The doc's review-later example builds an atomic batched transaction from all pending conflicts. If any of the resources in that batch has churned again on the server (someone wrote between the original conflict and the user's review-later submission), the whole batch rolls back and the resolver fires again — for whichever resource(s) re-conflicted, plus presumably the same `'human-in-the-loop'` policy. The conflict stash gets re-populated; the user goes through review again. **Triage**: probably fine — the user's already in a "review and resolve" mindset, so a second review pass isn't jarring. But worth thinking about whether the framework should somehow signal "this is a re-resolution of a previously-handed-off conflict" so the UI can highlight it. Not blocking demo; revisit if real Studio markup exposes the friction.

3. **Client-side routing — RESOLVED 2026-05-14: default to `vue-router`.** The original Alpine-era plan (`@lumenize/router`, ~200 LOC URL↔state-path sync, written from scratch) is **abandoned**. With Vue 3 in-DOM mode as the framework target, [vue-router](https://router.vuejs.org/) is the canonical answer — mature, well-documented, large LLM training corpus, integrates natively with Vue's reactivity. **Triage**: when Studio first needs routing, scaffold vue-router. Single-page-with-conditional-views (`v-if` on `store.app.activeView`) still works for one-pager apps; routing kicks in when navigation, URL-encoded state, or back-button support matters. **URL-params-into-store**: the original 200 LOC "two-way sync" plan reduces to ~10 LOC of `watchEffect` in app code (or a tiny `useRouteSync({ todoId: 'app.activeTodoId' })` composable in `@lumenize/nebula-frontend` if Studio templates want it factored). **Only consider a custom router** if vue-router exposes a concrete blocker — e.g., reactive route-param-as-store-path that vue-router's composables can't express cleanly. None foreseen. **Outcome destination**: no separate task file needed; Studio app work picks up vue-router when routing surfaces.

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

6. **Lifecycle hooks — resolved 2026-05-13, REMAPPED 2026-05-14 (Vue replan).** The original resolution shipped `x-on:mount` / `x-on:unmount` directives + component-level `onMount(scope)` / `onUnmount(scope)` for the Alpine-flavored plan. **Under the Vue replan, lifecycle hooks are stock Vue: `onMounted(fn)` / `onBeforeUnmount(fn)` / `onUnmounted(fn)` from `vue`**. Same semantics (per-instance, scope-injected, error-contained); zero custom code in `@lumenize/nebula-frontend`. The remaining four candidates (per-resource-subscription, per-transaction granularity, auth/scope, `onReady`/`onError`) remain explicitly deferred. The original triage record below is kept for context.

   Candidate hook points to consider:
   - **Per-element / per-binding**: `x-on:mount` / `x-on:unmount` — fires when a directive-bearing element enters/leaves the DOM tree the crawler is observing. Distinct from `x-on:click` etc., which are real DOM events. Useful for: starting a timer when a card mounts, releasing a resource handle when it unmounts, focusing an input on appearance.
   - **Per-component-instance** (depends on `x-component` shape from 2026-05-12 work): `onMount(scope)` / `onUnmount(scope)` lifecycle declared inside the component definition, receiving the same `{ $local, $node, $trail, ... }` scope handlers get. Pairs naturally with `$local` initialization — today there's no clear answer for "set `$local.expanded = false` exactly once on first mount."
   - **Per-resource-subscription**: `onSubscribed(rt, rid, snapshot)` / `onUnsubscribed(rt, rid)` callbacks the integration layer fires when refcount transitions through 0↔1 (and the actual server round-trip completes/cancels). Today these are silent.
   - **Per-transaction**: `onSubmitted` / `onCommitted` / `onConflicted` / `onRolledBack` — granular hooks beyond the existing single Promise resolution. Probably overkill; most apps don't need this granularity, and the Promise + per-type `onETagConflict` already covers the conflict path.
   - **Auth / scope transitions**: `onScopeChange(prev, next)` — fires when `activeScope` changes (branch switch, tenant switch). Today `bindToState` writes connection state to `lmz.connection.*`, but scope transitions are silent.
   - **Whole-`bindDom` lifecycle**: `onReady` (initial subtree walk + initial subscribe RTTs all resolved — useful for a splash-screen `x-if`), `onError` (unhandled framework error).

   Cross-cutting concerns:
   - **Where do they live?** Element-scoped → `@lumenize/nebula-frontend` (`x-on:mount` etc., plus component-definition syntax). Resource/transaction → integration layer (`bindToState` options or `client.resources.on*` methods). Auth → `NebulaClient` constructor options or event emitter.
   - **Sync vs async**: most hooks should be best-effort sync callbacks. `onUnmount` specifically must complete *before* the binding refcount decrements (otherwise unsubscribe races with cleanup that needs the subscription).
   - **Error containment**: hook throws should `console.error` and continue, mirroring middleware / subscriber-throw isolation already in `@lumenize/state`. Never let a user-supplied hook take down the framework.
   - **Composability with `x-for`**: each iteration's clone is its own "mount" — does `x-on:mount` on a `<template x-for>`-hosted element fire per-iteration? (Probably yes — that's the useful semantic.)
   - **MutationObserver grace-period interaction**: if an element is "moved" (removed + re-added in same task), the microtask-deferred unregister logic skips the unmount. `x-on:unmount` should match — fire only on *actual* removal, not on moves.

   **Triage decision** (taken 2026-05-13): ship the minimum-viable set — `x-on:mount` / `x-on:unmount` on elements + component-level `onMount` / `onUnmount`. The 2 s grace period + refcount semantics in 5.3.6 already give us *internal* mount/unmount events; these two surfaces expose what app authors actually need (timer start/stop, focus management, `$local` initialization). All four other candidates deferred:
   - **Per-resource-subscription** (`onSubscribed` / `onUnsubscribed`): NebulaClient already exposes the `subscribe`/`read`/`transaction` Promises and the `onETagConflict` hook; adding per-fanout-event callbacks is duplicative surface for unclear benefit. Revisit if a Studio template needs to react to "the snapshot is settled" beyond what reactive bindings already provide.
   - **Per-transaction granularity** (`onSubmitted` / `onCommitted` / `onConflicted` / `onRolledBack`): the always-resolve `TransactionResolution` discriminated union + per-type `onETagConflict` already cover every terminal state. Granular hooks would be redundant with the Promise.
   - **Auth/scope transitions** (`onScopeChange`): activeScope changes today happen via page reload (scope-switching is full re-bootstrap, per `tasks/archive/nebula-7-client.md`). When in-place scope switching becomes a real feature, revisit.
   - **Whole-`bindDom` lifecycle** (`onReady` / `onError`): `onReady` is interesting for splash-screen UX but `x-if` on `lmz.connection.connected` + per-resource `meta.eTag` presence covers it declaratively. `onError` is a future observability story, not a demo blocker.

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

## Notes

- BroadcastChannel semantics, subscriber tracking design, and `dag-ops` client-side notes are carried from `tasks/nebula-scratchpad.md` § "Star Subscription Design."
- Fanout > 64 subscribers (large-fanout tiering) intentionally not designed here. Demo runs with a handful of subscribers max.
- This file consolidates and supersedes `tasks/archive/nebula-5.3-subscriptions.md`, `tasks/archive/lumenize-ui.md`, and `tasks/archive/nebula-7-client.md`.

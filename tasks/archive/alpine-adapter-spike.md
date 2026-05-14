# Alpine.js adapter spike

> ## ⚠ Superseded — see [vue-in-dom-spike.md](vue-in-dom-spike.md) (2026-05-13)
>
> This spike ran 2026-05-13 and reached a partial-go finding: the structural moves (delete `@lumenize/state`, reshape NebulaClient, factory pattern) were validated by Phase 0a (24/24) + Phase 0b (3/3 e2e). But the "stock Alpine + factory's Vue store, magical seamless integration" vision didn't survive contact with reality — **Alpine is locked at `@vue/reactivity@3.1.5`** (separate reactiveMap from any 3.2+, no `effectScope`), making the design viable only with a ~250 LOC integration layer (`$lmz` magic + custom `x-lmz-*` directives + recursion plugin).
>
> User then raised the bigger reframe: drop Alpine, go full Vue 3 in-DOM mode (no SFC build step). That eliminates the version-pin, gives us native `effectScope`, native recursive components, and preserves the entire Phase 0a + 0b body of work intact.
>
> **The active spike is now [tasks/vue-in-dom-spike.md](vue-in-dom-spike.md).** Phase -1 items 1-10 here are still load-bearing and carry forward to the Vue spike. Code lives in `apps/nebula/spike/alpine-adapter/` (dir kept for continuity; the work survives, the framework target shifted).

## Starting here (read first)

This task file is the source of truth — read it through before touching code. The decisions captured below evolved across two design rounds:

1. **Initial round (2026-05-13 AM)** — pinned Option B (replace `@lumenize/state`'s engine with `@vue/reactivity`).
2. **Pre-probe + scope round (2026-05-13 PM)** — pre-probe at `apps/nebula/spike/alpine-adapter/probes/{scheduling,batching}.ts` cleared all medium-risk semantics (33/33 PASS). User then opened the door wider: instead of porting `@lumenize/state` onto Vue, **delete `@lumenize/state` entirely** and rebuild the integration as a factory inside `@lumenize/nebula-frontend`. Zero external commitments to `@lumenize/state` (not published, only internal consumers, no `website/docs/state/`).

Don't rely on conversation memory if it conflicts with what's written here.

**First steps for a fresh session**:

1. Read this whole file end-to-end. The "Chosen path" and "Pinned semantics" tables are load-bearing; the design-space options (A–D) and the rejected first-round plan ("StateManagerVue parallel class") remain as historical record only.
2. Read the pre-probe code + results at [apps/nebula/spike/alpine-adapter/probes/scheduling.ts](apps/nebula/spike/alpine-adapter/probes/scheduling.ts) and [apps/nebula/spike/alpine-adapter/probes/batching.ts](apps/nebula/spike/alpine-adapter/probes/batching.ts). 33/33 PASS — these establish the patterns Phase 0 builds on.
3. Read [packages/state/src/state-manager.ts](packages/state/src/state-manager.ts) and [packages/state/test/state-manager.test.ts](packages/state/test/state-manager.test.ts) — NOT to port them, but to harvest the load-bearing semantic invariants (deep-equal dedup, hierarchical fanout, computed self-ref check, middleware substitution) for the new design's integration tests.
4. Read [apps/nebula/src/nebula-client.ts](apps/nebula/src/nebula-client.ts) — particularly the `bindToState` implementation. The factory replaces it; the middleware logic + auto-subscribe refcount carry forward in a new shape.
5. Read [website/docs/nebula/coding-your-ui.md](website/docs/nebula/coding-your-ui.md) — current canonical doc, will be rewritten as part of "go" output.
6. Start Phase 0 in `apps/nebula/spike/alpine-adapter/` (spike dir already exists with probes). Build the factory prototype against a mock backend.

**Bail-out triggers** (don't sink time past these):

- Phase 0: if any of the pinned-semantic checks (Vue Proxy `set` middleware, auto-subscribe via `effectScope`, batching via `ReactiveEffect`+scheduler, deep-equal dedup) hits a wall no design tweak fixes in ~half a day → switch to Option C (thin wrapper around the current StateManager), document the wall, stop.
- Probes 1–4: if Alpine doesn't bind to the factory's `store` cleanly, or `x-for` / `x-data` don't compose with our auto-subscribe model → document and either switch to Option C or fall back to original 5.3.7a/b custom plan.

**Do NOT**:

- Modify production `@lumenize/state` during the spike (it's getting deleted post-spike anyway; don't touch it now). Work in spike-isolation.
- Modify production [apps/nebula/src/nebula-client.ts](apps/nebula/src/nebula-client.ts). The factory + relocation happens AFTER the spike succeeds, in the real 5.3.7 implementation.
- Try to port the existing 80 `state-manager.test.ts` cases as-is. The factory has no `subscribe`/`setState`/`getState` public API (users bind Alpine directly to `store`). Harvest the *semantic invariants* the tests assert and re-express them against the factory's surface.

## Goal

Determine whether `@lumenize/nebula-frontend` (Phase 5.3.7) should be built **on top of Alpine.js** rather than as a custom Alpine-flavored directive layer. Each of the 11 design decisions pinned for 5.3.7 was effectively "what Alpine already does, but our way" — that's a strong signal the build-our-own framing is the wrong default. Spike validates that:

1. `@vue/reactivity` can serve as the reactive engine (replacing custom `StateManager`),
2. middleware + auto-subscribe collapse cleanly into a Vue Proxy `set` trap + `effectScope` lifecycle, and
3. stock Alpine binds against the resulting `store` end-to-end (text/for/if/data/model).

**Outcome**: a go/no-go decision on the pivot. If go: 5.3.7's planned 700–900 LOC of custom code drops to ~150–300 LOC of integration code in a new `@lumenize/nebula-frontend`, plus the deletion of `@lumenize/state` (~600 LOC src + tests) and relocation of NebulaClient out of `apps/nebula/`. If no-go: confirms custom path is right and we proceed with the original 5.3.7a/5.3.7b plan.

**Time budget**: 2–3 days.

## Why now

- 5.3.7a/b have ZERO code written yet. Pivot cost is purely design-time; no throwaway.
- The accumulating "decisions to make" list for 5.3.7 was substantial (11 pinned, plus the underspecified $local-init handling). Each decision is a maintenance liability we'd own forever.
- User explicitly opened the door (2026-05-13): "we can make changes to NebulaClient to match the shape of alpine's proxy based approach so the shim does less" and "having NebulaClient return an Alpine compatible proxy from a factory function might be a good pattern here." So 5.3.6 code is **not** frozen — reshaping NebulaClient is on the table.
- Further (2026-05-13 PM): user pushed back on partial-pivot framing, observing "I'm one of the few humans you will ever meet that has no sunk-cost bias." `@lumenize/state` is on the table for full deletion; `bindToState` API on the table for full replacement.
- After 5.3.7a lands, the pivot cost climbs sharply.

## Pre-probe results (de-risked 2026-05-13)

Two probe files at [apps/nebula/spike/alpine-adapter/probes/](apps/nebula/spike/alpine-adapter/probes/). Both pass cleanly.

### `scheduling.ts` (22/22 PASS)

| Question | Finding |
| --- | --- |
| Is `effect()` sync or microtask? | **Synchronous.** `@vue/reactivity`'s standalone `effect()` fires immediately on write. (`watch()` from `@vue/runtime-core` is the microtask-deferred one — different package.) |
| Can a module-scope `currentWritePath` sidecar carry through to effect cb? | **Yes.** Synchronous firing means sidecar is still set when effect reads it. |
| Does ancestor write fire descendant-reading effects? | **Yes, automatically.** Replacing `state.a` re-fires every effect that reads `state.a.b.c` — Vue tracks each property hop along the chain. The `~50 LOC #fanout walk` in current StateManager just disappears. |
| Does structural-equal-but-new-ref write fire effects? | **Yes** (Vue does identity-only dedup, not structural). Confirms we wrap setState in deep-equal dedup. |
| Does same-reference write fire effects? | **No** — Vue identity dedup catches it. |
| Per-effect prev-value capture for deep-equal dedup of descendant effects? | **Works** (Q5 pattern). |
| Re-entrant write inside effect? | **Allowed** — cascading updates fire dependents synchronously in order. |
| Is `pauseTracking` useful for batching? | **No** — read-side only, does NOT defer effect firing. Use `ReactiveEffect`+scheduler instead. |

### `batching.ts` (11/11 PASS)

| Approach | Verdict |
| --- | --- |
| A. Queue writes, flush at batch end (no scheduler) | **Doesn't batch** — each write during flush re-fires affected effects per property, not once total. |
| B. `ReactiveEffect` + custom scheduler | **Works** — scheduler defers per-effect firing; manual `re.run()` at batch end produces exactly one re-fire per subscriber regardless of how many writes hit during batch. |
| B′. Registry pattern (subscribe wraps `ReactiveEffect` with scheduler that respects `isBatching` flag) | **Works** — multiple subscribers fire exactly once at batch end with final values. Outside batch, single-write firing stays sync. |

These probes establish the patterns Phase 0 builds on.

## Prior art (synthesized 2026-05-13)

### Alpine 3.x exposes a public reactivity API

From the [official reactivity docs](https://alpinejs.dev/advanced/reactivity):

- **`Alpine.reactive(obj)`** — wraps `obj` in a Vue-style Proxy (Alpine internally uses `@vue/reactivity`). Returns a reactive object; reads track deps, writes fire effects.
- **`Alpine.effect(fn)`** — runs `fn`, tracks every reactive read inside it as a dep, re-runs whenever any dep changes. **Crucially**, the directive-scoped `effect()` provided to custom directive callbacks auto-cleans on directive removal.

### Custom directive API (probably not needed for v1)

```js
Alpine.directive('name', (el, { value, modifiers, expression }, { Alpine, effect, cleanup, evaluate, evaluateLater }) => {
  // el — DOM element
  // expression — the directive's value (string)
  // evaluateLater(expression) → reusable evaluator function
  // effect(() => { ... }) — re-runs on reactive deps; auto-cleans on directive removal
  // cleanup(fn) — register teardown
})
```

Plus:
- **`Alpine.magic('name', fn)`** — register `$name` properties available in expressions (used for things like `$store`, `$watch`, custom shortcuts).
- **`Alpine.plugin(fn)`** — bundle multiple `directive` / `magic` registrations into a single import.

Initial v1 plan is to lean on stock Alpine directives (`x-text`, `x-bind`, `x-for`, `x-if`, `x-model`, `x-data`) plus `Alpine.store('lmz', store)` magic — no custom directives required. Drop into custom-directive territory only if a specific behavior (e.g., resource-scope refcount-with-grace) can't be expressed cleanly via stock primitives.

### Bridge patterns from existing integrations

**Redux** (mirror-and-sync via external subscribe):
```js
Alpine.store('redux', { state: store.getState(), dispatch: store.dispatch });
store.subscribe(() => {
  Alpine.store('redux').state = store.getState();  // wholesale replace triggers Alpine's Proxy
});
```

**[Persist plugin](https://alpinejs.dev/plugins/persist)** — wraps `$persist(value)` so reactive writes mirror to localStorage. Closest analog to what our middleware does: intercept Alpine reactive writes and route to an external system.

### What this means for us

Alpine's reactivity is **already a Proxy backed by `@vue/reactivity`**. We don't need to "bridge two reactivity systems." We make our store BE a Vue-reactive Proxy with middleware in the `set` trap; Alpine consumes it directly via `Alpine.store('lmz', store)`.

## Design space (historical record)

Options A–D were enumerated during the initial round. **Chosen path is Option B, extended to delete `@lumenize/state`.**

### Option A — Mirror-and-sync (Redux pattern)

Keep `@lumenize/state` as-is. Maintain a parallel `Alpine.store('lmz', ...)` clone. **Rejected** — double storage, two-way sync hazards.

### Option B — Replace `@lumenize/state`'s engine with `@vue/reactivity`

Refactor so internal state is `reactive(obj)` from `@vue/reactivity`. **Initially chosen** as "port engine, keep API." Then **extended 2026-05-13 PM**: since `@lumenize/state` is not published and has only internal consumers, delete it entirely. Middleware + auto-subscribe + dedup logic lives directly in the new factory inside `@lumenize/nebula-frontend`. No standalone path-based state-manager package.

### Option C — Thin Proxy wrapper over StateManager (fallback)

Keep `@lumenize/state` as-is; add a `@vue/reactivity` broadcast layer. Documented bail-out fallback if any Phase 0 pinned semantic can't be re-derived.

### Option D — Custom-directive overlay (no shared reactivity)

Use Alpine for DOM crawling but custom directives bind to our state. Rejected — mental-model split, doesn't simplify much.

### Chosen path: Option B (full — delete `@lumenize/state`)

**Verified zero sunk cost** (2026-05-13 PM): `@lumenize/state` is at `version 0.25.0` but **not on npm** (registry returns 404). No `website/docs/state/` directory. Only references are in tasks/ and in `coding-your-ui.md` (which is being rewritten anyway).

End-state:

- **`@lumenize/state` deleted** — package, src, tests, all gone. The 80 tests get harvested for their semantic invariants and reimplemented as targeted integration tests against the new factory.
- **NebulaClient moves to `@lumenize/nebula-frontend`** (new package). It's a browser/Node client, not a Worker artifact — `apps/nebula/` should be server-only.
- **Factory replaces `bindToState`**: `createNebulaClient(config) → { client, store }`. `store` is a Vue-reactive Proxy with middleware in the `set` trap. `client` has connection/transaction/subscription methods.
- **Middleware in Proxy `set` trap** — routes every write (regardless of origin: `x-model`, `@click`, internal RPC fanout) through synced-state logic. No footgun where direct property writes bypass middleware.
- **Auto-subscribe via `effectScope`** — Proxy `get` trap detects reads of `resources.<type>.<id>...` paths inside Alpine effects; refcount; on `effectScope` cleanup decrement → grace → unsubscribe.
- **No user-facing `subscribe`/`getState`/`setState`.** Users write Alpine bindings against `store`.

### Path syntax: bracket notation, no template-literal tag (decided 2026-05-13)

Use Alpine's native bracket-notation for dynamic path segments. The `` resources`${rt}.${rid}.value.title` `` template-literal idea was attractive but doesn't pay back: bracket notation (`$store.lmz.resources.todo[todoId].value.title`) is already path-like, already what Alpine handles natively, doesn't require introducing new vocabulary.

### Directive naming: adopt Alpine's (decided 2026-05-13)

Adopt `x-model` (not `x-input`), `x-text`, `x-bind`, `x-for`, `x-if`, `x-data`, etc. — stock Alpine names. Reverses earlier `x-input` pinning. Rationale: if we're using Alpine, use its vocabulary; don't fork naming for marginal benefit.

## Pinned semantics to validate against the new factory

Each of these is a load-bearing invariant from the current `@lumenize/state` + `bindToState` design. Phase 0 must verify each against the new factory prototype. If any can't be re-derived cleanly, that's the trigger to fall back to Option C.

| Pinned semantic | Current implementation | Factory mapping | Pre-probe status |
| --- | --- | --- | --- |
| **Middleware fires on every write, regardless of origin** | `setState` is sole write entry; middleware list iterated there | Proxy `set` trap runs middleware chain before forwarding to underlying `reactive()`. All writes route through it (`x-model`, `@click`, RPC handlers, internal code). | Not yet probed; design-time work in Phase 0 |
| **Middleware substitution** (return value replaces `newValue`) | Chained `let finalValue = value; if (mw-return !== undefined) finalValue = result` | Same logic, inside Proxy `set` trap. | Trivial |
| **Hierarchical-notify** (write at `a` fires bindings at `a.b.c`; write at `a.b.c` fires bindings at `a`) | Custom `#fanout` walks subscriber map | **Free from Vue** — property-chain tracking handles descendant-reads + ancestor-writes automatically. | ✅ Probed (Q3) |
| **Deep-equal dedup on top-level writes** (skip if `oldValue` deepEquals `newValue`) | `if (deepEquals(oldValue, finalValue)) return` after middleware | Same check in Proxy `set` trap before forwarding write. Skip the entire fanout if equal. | ✅ Probed (Q4) |
| **Per-binding dedup on ancestor writes** (ancestor write to partially-changed subtree; some descendants change, some don't — only-changed bindings fire) | Per-subscriber `deepEquals(subOld, subNew)` guard inside `#fanout` | Wrap each Alpine effect's tracked read with a `prev`-value closure + deepEquals guard. Or just accept Vue's "fires on any subtree change" + rely on idempotent-render (Alpine effects re-running with same value are cheap). Spike picks. | ✅ Probed (Q5) — manual prev-capture works |
| **`executeBatch`** (last-write-wins per path, single fanout at end) | Custom batch queue + dedup | `ReactiveEffect` + custom scheduler. Subscribe wraps each effect's scheduler; flushes drain the dirty set at batch end. | ✅ Probed (`batching.ts` B′) |
| **`changedPath` signal to middleware/handlers** | Passed explicitly via setState arg | Module-scope `currentWritePath` sidecar set inside Proxy `set` trap; effects/handlers read synchronously. | ✅ Probed (Q2) |
| **`context: { source: 'remote' \| 'rollback' \| 'computed' }` discriminator** | 3rd arg to setState | Module-scope sidecar similar to `changedPath`, or thread through a `withContext(ctx, fn)` helper that wraps writes. | Design-time |
| **Auto-subscribe via refcount** (bindings under `resources.<type>.<id>` refcount that resource; grace-period unsubscribe on zero) | `onSubscriberAdded`/`Removed` hooks on StateManager + refcount Map | `effectScope` + Proxy `get` trap detects reads of resource paths inside Alpine effects. On scope cleanup, decrement. Test that Alpine's directive-scoped effects participate correctly. | Design-time — the key novel piece |
| **Computed (`computed(targetPath, fn)`)** + self-reference detection | Track deps via state.track, register subscriber per dep, throw if deps overlap target | Use Vue's `computed()`; inspect deps via `effectScope`; throw at registration if deps overlap target. | Design-time, low risk |
| **Connection-state surfacing at `lmz.connection.*`** | `client.bindToState` writes connection events to bound state | Factory wires `client.onConnectionStateChange` to write into `store.lmz.connection.*`. Trivial. | Trivial |
| **Optimistic apply + rollback** | `bindToState`'s `#useServerOutcome` / `#applyFlash` | Carries forward into factory; not affected by reactivity-engine change. | Out of scope for spike's Phase 0; verify briefly during probes |

**Total assessment after pre-probe**: 8 of 12 are either trivial, already-probed, or free-from-Vue. 4 are design-time work (middleware in `set` trap, auto-subscribe via `effectScope`, context discriminator, optimistic+rollback). None are high-risk; pre-probe data covers the originally-feared scheduling and batching questions.

## Spike plan

Stand up the prototype under `apps/nebula/spike/alpine-adapter/` (already exists; probes are there). Single HTML page + a few TS files for the factory + a mock backend.

### Phase 0 — Factory prototype against real Nebula backend (~1 day)

**Architecture**: the factory wraps a **copy** of `NebulaClient` (copied from `apps/nebula/src/nebula-client.ts` into the spike directory) and exposes `{ client, store }`, where `store` is a Vue-reactive Proxy with middleware in the `set` trap. Server-side imports (Star, Galaxy, NebulaAuth, error classes, types) come from `apps/nebula/src/` unchanged — only NebulaClient (and any tightly-coupled client-side helpers) get copied. Rationale: NebulaClient's current subscribe/transaction/connection-state shape was built for `bindToState`, not for the factory+effectScope model — we want freedom to reshape it during the spike without breaking production. (Rationale documented in Phase -1 § 6.)

Tests run inside a `test/test-apps/`-style vitest-pool-workers harness (per CLAUDE.md "App Test Pattern") so the factory talks to a **real Star DO in-process**. Real wire protocol, real eTag conflicts, real fanout — no mock semantics to second-guess. (Rationale documented in Phase -1 § 5.)

- [x] Add a minimal `tsconfig.json` and `vitest.config.ts` to the spike dir.
- [x] Copy `apps/nebula/src/nebula-client.ts` into the spike (likely as `src/nebula-client.ts`). Walk its imports — copy any client-side-only helpers that look load-bearing for the reshape; keep server-side imports (Star, Galaxy, error classes, wire-protocol types) pointing at `apps/nebula/src/`. Production code stays untouched.
- [x] Reshape the copied NebulaClient as needed during prototyping. Specifically expected (subject to revision):
  - [x] Drop `bindToState` and all its supporting machinery (`#useServerOutcome`, `#applyFlash`, refcount Maps, the existing `subscribe`-via-state-hook plumbing). The factory takes over those responsibilities.
  - [x] `client.resources.subscribe(rt, rid)` likely changes signature: from "register a path subscriber" to "instruct the server to fan updates to this client; return a disposer." The factory uses `effectScope` to drive this — when client-side effect refcount goes 0→1 for a resource, factory calls `client.resources.subscribe`; on 1→0 after grace, calls the disposer.
  - [x] `client.resources.transaction` may or may not need shape changes — it already accepts ops + eTag + idempotency key. Verify.
  - [x] Connection-state observer (`onConnectionStateChange`) likely stays as-is; factory hooks it to write into `store.lmz.connection.*`.
  - [x] Set up the spike's vitest harness similarly to `apps/nebula/test/test-apps/baseline/` but pointing at the spike's NebulaClient copy. Decide during Phase 0 whether to clone the baseline test-app or write a thinner one (likely thinner — we don't need its full surface area).
- [x] Build `create-nebula-client.ts` in spike dir:
  - [x] Imports the spike's reshaped `NebulaClient` (NOT the production one).
  - [x] Internal `reactive(initialState)` via `@vue/reactivity`.
  - [x] Wrapper Proxy with `set` trap: runs middleware chain → top-level deep-equal dedup → forwards write into underlying `reactive`. Returns `store`.
  - [x] Proxy `get` trap: when read happens inside an `effectScope` AND path starts with `resources.<type>.<id>`, refcount that resource; register scope-cleanup decrement; on zero-after-grace, call into the reshaped `client` to unsubscribe.
  - [x] Default middleware (synced-state): writes under `resources.<type>.<id>.value.*` map to `client.resources.transaction(...)`. Wire connection-state events to writes at `store.lmz.connection.*`. Wire server fanout from the client (whatever its post-reshape handler is called) to writes at `store.resources.<type>.<id>.{value,meta}` with `context: { source: 'remote' }` (skipped by middleware).
- [x] **Pinned-semantic checks** against the real Star: vitest file in spike dir, ~15-20 targeted tests:
  - [x] Middleware substitution / abort works; path/old/new/context correct.
  - [x] Top-level deepEquals write → no transaction emitted, no effects fire.
  - [x] Per-binding ancestor-write dedup: real server fanout where only some fields changed; verify only-changed bindings fire.
  - [x] `executeBatch` (if exposed as a `client` method or store helper) produces exactly one re-fire per affected binding.
  - [x] `effectScope`-driven auto-subscribe end-to-end: simulate Alpine-style effect reading `resources.todo.task-1.value.title`; verify real `Star.subscribe` was called; verify scope cleanup → grace → real unsubscribe.
  - [x] Computed + self-reference detection (purely client-side, no Star round-trip needed).
  - [x] Connection state surfacing at `store.lmz.connection.*` on real WS lifecycle.
  - [x] Optimistic apply + rollback on conflict (uses 5.3.6's existing logic with the new factory shape — verify it carries forward cleanly into the reshaped client).
- [x] **Bail-out trigger**: if middleware-in-Proxy-set or `effectScope`-auto-subscribe hits a wall no design tweak fixes in ~half a day → fall back to Option C, document, stop.
- [x] **Diff is a deliverable**: the diff between the reshaped spike-NebulaClient and production `apps/nebula/src/nebula-client.ts` IS the implementation plan for 5.3.7's NebulaClient changes. Keep the spike copy clean enough that this diff is readable.

### Phase 1 — Probe browser-side with stock Alpine (~1 day)

Stand up a single `index.html` page that loads Alpine from a CDN, instantiates the factory pointed at a `wrangler dev`-served local Nebula Worker (existing baseline test-app entrypoint, or a tiny spike entrypoint), registers the store via `Alpine.store('lmz', store)`, and runs each probe against the real Star.

#### Probe 1 — Basic deep-path binding with auto-subscribe

Goal: prove that `<span x-text="$store.lmz.resources.todo['task-42'].value.title"></span>` reads from the store and updates when the store changes. Auto-subscribe fires for `todo/task-42` when the directive mounts; unsubscribes after grace when removed.

#### Probe 2 — Ancestor-write reactivity

Goal: when full `.value` is replaced (server fanout), descendant bindings update. Structural-equal replace does NOT cause spurious re-render.

#### Probe 3 — `x-for` + dynamic FK lookup

```html
<template x-for="todoId in $store.lmz.resources.todoList.main.value.items" :key="todoId">
  <li>
    <span x-text="$store.lmz.resources.todo[todoId].value.title"></span>
  </li>
</template>
```

Probe: add ID to `items` → new `<li>` appears AND server `subscribe(todo, todoId)` fires. Remove ID → `<li>` disappears AND grace-period unsubscribe fires.

#### Probe 4 — Per-instance state via `x-data` + writes via `x-model`

```html
<template x-for="todoId in $store.lmz.resources.todoList.main.value.items" :key="todoId">
  <li x-data="{ expanded: false }">
    <button @click="expanded = !expanded">Toggle</button>
    <template x-if="expanded">
      <input x-model="$store.lmz.resources.todo[todoId].value.title">
    </template>
  </li>
</template>
```

Verify: `x-data` gives per-iteration scope (no `$local` needed). `x-model` write to `.value.title` fires middleware (route to transaction), not just local Proxy mutation.

This is the probe where the most planned-machinery vanishes. If `x-data` + `Alpine.store` covers our use cases, ~150 LOC of planned 5.3.7b directive machinery disappears.

### Bonus probe — recursion (~0.5 day if time permits)

Recursive tree rendering with `<template x-for>` + recursion. Either Alpine's own pattern or the [markmead/alpinejs-component](https://github.com/markmead/alpinejs-component) plugin. Hardest case in coding-your-ui.md; tests whether Alpine primitives compose for recursive DAG-tree rendering.

### Phase 2 — Go/No-Go report (~0.5 day)

Fill in the decision matrix. If "go," produce:

- Doc rewrite of [coding-your-ui.md](website/docs/nebula/coding-your-ui.md) for Alpine syntax (using patterns proven in probes). User explicitly wants this in spike scope (A5, 2026-05-13).
- Implementation plan for 5.3.7: delete `@lumenize/state`, scaffold `@lumenize/nebula-frontend`, move + reshape NebulaClient, update test-apps, rewrite docs.

## Decision matrix

After the spike, fill in:

| Phase / Probe | Worked cleanly? | Notes |
| --- | --- | --- |
| Phase 0 — factory prototype passes pinned-semantic checks | ? | |
| Probe 1 — basic binding + auto-subscribe | ? | |
| Probe 2 — ancestor write + deep-equal dedup | ? | |
| Probe 3 — x-for + FK bracket-substitution + refcount on add/remove | ? | |
| Probe 4 — `x-data` per-instance + `x-model` routing through middleware | ? | |
| Bonus — recursion | ? | |

**Decision**:

- **Phase 0 clean + all 4 probes pass** → pivot. Implementation plan: delete `@lumenize/state`, scaffold `@lumenize/nebula-frontend`, move + reshape NebulaClient, rewrite coding-your-ui.md.
- **Phase 0 hits a wall on Proxy-set middleware OR effectScope auto-subscribe** → fall back to Option C: keep StateManager as authoritative storage; thin `@vue/reactivity` broadcast wrapper bridges to Alpine. Smaller pivot, more bridge complexity.
- **Probes fail even after Phase 0 clean** → unlikely; if it happens, hybrid (Alpine for some directives, custom for others) is the salvage path.
- **Both Phase 0 and probes fail** → confirms custom is right; revert to original 5.3.7a/5.3.7b plan.

## Relevant memory entries

- **[path-based-reactivity](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_path_based_reactivity.md)** — pre-updated 2026-05-13 PM to flag "ACTIVELY RECONSIDERED — see this task file." Old guidance preserved below the flag for reference. Update for-real after the spike resolves.
- **[skip-failing-tests-when-deferring](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_skip_failing_tests.md)** — if any pinned-semantic check can't pass on the prototype, prefer `it.skip` with original assertions and a "Blocked on:" comment over deletion. Lets bail-out reasoning stay visible.
- **[github-org-lumenize](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_lumenize_github_org.md)** — org is `lumenize/lumenize`, not `lmaccherone/lumenize` — relevant if posting URLs in commits.

## What this spike outputs (if successful)

A "go" decision delivers:

1. **Working factory prototype** in `apps/nebula/spike/alpine-adapter/`: `createNebulaClient(...) → { client, store }`, Vue Proxy with middleware-in-set-trap, effectScope auto-subscribe, ~15-20 passing pinned-semantic tests against a **real Star DO** running in-process under vitest-pool-workers.
2. **Working browser probe**: single HTML page exercising stock Alpine directives against the factory's store, talking to a **real `wrangler dev`-served Nebula Worker**. All 4 probes pass; bonus probe ideally also passes.
3. **Doc rewrite of [coding-your-ui.md](../website/docs/nebula/coding-your-ui.md)** for Alpine syntax. User explicit ask (A5, 2026-05-13): "I'll want to do the rewrite of the docs in this context. You'll have used those patterns in the spike."
4. **Implementation plan for 5.3.7**: enumerated steps for the post-spike work — delete `@lumenize/state`, scaffold `@lumenize/nebula-frontend`, move + reshape NebulaClient, update test-apps, ship.
5. **Updated [tasks/nebula-frontend.md](nebula-frontend.md)**: Phase 5.3.7a/b plans replaced with the Alpine-based plan. ~70% LOC reduction. Renamed sub-phases.
6. **Final update to `path-based-reactivity` memory entry**: flip from "ACTIVELY RECONSIDERED" to either "superseded — see nebula-frontend.md" (if go) or "confirmed, restored" (if no-go).

A "no-go" decision delivers:

1. Documented walls (which pinned-semantic checks couldn't be re-derived, which probes failed).
2. Recommendation: fall back to Option C (thin wrapper) or proceed with custom 5.3.7a/b.
3. The spike directory stays as a historical artifact — clean up by deleting later if not useful.

## Notes / open questions to resolve during the spike

- **Alpine in Node tests**: Alpine is browser-only. The factory prototype itself (`createNebulaClient`) is framework-agnostic — its tests run in Node/vitest. The Alpine binding probes need a browser harness; the spike uses a single `index.html` page (no vitest-browser-playwright setup needed — manual probe is fine for spike).
- **`@vue/reactivity` standalone**: small package (~7-12KB minified), no Alpine dependency. The factory in `@lumenize/nebula-frontend` will list `@vue/reactivity` as a hard dep; Alpine becomes a peer dep (consumer chooses Alpine version).
- **Bundle size**: Alpine is ~30KB minified. Our planned custom layer was ~10-30KB. Alpine + `@vue/reactivity` together is ~37-42KB. Difference small enough not to drive decision.
- **LLM training-data alignment**: original reason for Alpine-flavored directives was LLM friendliness. Using Alpine directly gives us this for free.
- **`bindToState` API**: replaced by factory return value. The 5.3.6 logic (middleware, refcount, connection-state writes, flash, rollback) survives — just plugged into the new shape. Most logic transfers.

## Phase -1: Captured Ideas

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Triage outcomes: do-now / later-task-file / backlog / drop. Resolve everything here before archiving this file.

1. **NebulaClient relocation timing** (raised 2026-05-13 PM). If spike succeeds, NebulaClient moves from `apps/nebula/src/nebula-client.ts` to `@lumenize/nebula-frontend` (new package). Rationale: it's a browser/Node client artifact, not a Worker deployment. Distribution: vibe-coder users `npm install @lumenize/nebula-frontend`. **Triage**: do during 5.3.7 implementation, NOT during the spike. Spike prototypes the factory shape in isolation in `apps/nebula/spike/alpine-adapter/`; no production-NebulaClient touched.

2. **Shared wire-protocol types location** (raised 2026-05-13 PM). Star/Galaxy (server-side, stays in `apps/nebula/`) and the relocated NebulaClient (client-side, in `@lumenize/nebula-frontend`) share wire-protocol types: resource shape, transaction envelopes, error classes (`OntologyStaleError`, `TransactionError`, etc.). Three candidate destinations:
   - (i) Tiny `@lumenize/nebula-types` package — both sides import from it.
   - (ii) Types live in `@lumenize/nebula-frontend`; `apps/nebula/` imports backward.
   - (iii) Types live in `apps/nebula/`; `@lumenize/nebula-frontend` imports forward.
   
   **Triage**: defer to 5.3.7 implementation. The spike's factory doesn't need to resolve this — it works against a mock backend. Decide once we see the full surface area during the actual move.

3. **`@lumenize/state` LOC threshold for "could we just publish a thin Vue wrapper after all?"** (raised 2026-05-13 PM). If during Phase 0 we find that "middleware + path-API + deep-equal dedup + computed-self-ref-check on top of Vue" stabilizes at >150 LOC of independently-useful code, the decision to delete `@lumenize/state` warrants a re-look. Below 150 LOC of thin delegation: fold into `@lumenize/nebula-frontend` as planned. Above: reconsider publishing. **Triage**: data-driven, resolve at end of Phase 0.

4. **Custom directives vs stock Alpine for resource auto-subscribe** (raised 2026-05-13 PM). The auto-subscribe-via-effectScope pattern works if Alpine's directive-scoped effects participate in our `effectScope` tracking. If they don't (Alpine creates its own effects with its own scope), we may need a custom `x-lmz-text` / `x-lmz-bind` directive layer that wraps stock behavior + adds our scope-registration. **Triage**: Probe 1 + Probe 3 settle this. If stock Alpine integrates cleanly, no custom directives needed for v1.

5. **Why real Nebula backend instead of mock** (raised 2026-05-13 PM, after first task-file draft proposed a mock). The earlier draft proposed a `mock-backend.ts` for spike-isolation. User flagged: why mock when `apps/nebula` already exists and works end-to-end? Three reasons mock is wrong here: (a) **no throwaway-then-validate sequence** — what works in the spike works in production; (b) **the mock would re-implement transaction round-trip, eTag handling, subscription envelopes** — real working logic, wasted effort; (c) **mocks lie** — pass-with-mock + fail-against-real forces a second spike round. Real Nebula via vitest-pool-workers' in-process Star DO is the right harness; CLAUDE.md's "App Test Pattern" already covers this. Server-side (Star, Galaxy, NebulaAuth) imported from `apps/nebula/src/` unchanged.

6. **Copy NebulaClient into the spike rather than import it** (raised 2026-05-13 PM, refining § 5 immediately after). User pointed out: NebulaClient's subscribe/transaction/connection-state methods were built for `bindToState`, not the factory+effectScope model. Importing the production class would constrain the spike to whatever surface NebulaClient happens to expose today. Copying it into the spike lets us reshape methods freely during prototyping — drop `bindToState` and its supporting machinery, change `client.resources.subscribe`'s signature, etc. — without breaking production. Server-side stays imported (Star, Galaxy, error classes are unaffected by the reshape). **Triage**: the diff between spike-NebulaClient and production NebulaClient at end-of-spike IS the 5.3.7 implementation plan for NebulaClient changes. Keep the spike copy clean enough to make that diff readable.

7. **`@lumenize/debug` requires bundler config in non-Workers browser builds** (raised 2026-05-13 PM, Phase 1 harness setup). Debug does `await import('cloudflare:workers')` in a try/catch — works correctly at runtime in any environment (catch swallows in non-Workers). But Vite's bundle-time import scanner sees the literal specifier and fails resolution unless told to leave it alone. Fix: add to debug's README / browser-bundling guide the required config:
   ```ts
   optimizeDeps: { exclude: ['cloudflare:workers'] },
   build: { rollupOptions: { external: ['cloudflare:workers'] } },
   ```
   **Triage**: document in `packages/debug/README.md` browser-usage section. Not a spike blocker — Node + jsdom dodges the issue entirely.

8. **`@lumenize/mesh/client` pulls in `node:async_hooks` transitively via lmz-api.ts** (raised 2026-05-13 PM, Phase 1 harness setup). `lmz-api.ts` imports `AsyncLocalStorage` at module top-level. The client-side path doesn't USE ALS in any meaningful way — ALS is for **server-side** request-scoped CallContext propagation when DOs process concurrent inbound requests. The client (per-user-action sequential calls) doesn't need this. The dependency is structural, not functional. **Triage**: fix in mesh — either split lmz-api into client-only / server-only modules, or lazy-load the ALS-dependent code paths. Until fixed, the mesh package's claim of being browser-safe is only true in jsdom-or-Node-via-Browser-class environments, not real browsers. Open a task file when ready to address — this is in mesh, not nebula-frontend.

9. **NebulaAuth has no `Access-Control-Allow-*` headers** (raised 2026-05-13 PM, Phase 1 harness setup). Fine for production same-origin apps (Worker serves both API + frontend on the same domain). Becomes a hard requirement if `@lumenize/nebula-frontend` is ever used cross-origin (frontend on `app.example.com` ↔ Worker API on `api.example.com`). **Triage**: document as a deployment-config concern in `@lumenize/nebula-frontend` docs once that package exists. Also worth a CORS-config story in NebulaAuth itself (allow-list of origins in env vars or wrangler config).

10. **Real-browser testing for `@lumenize/nebula-frontend` is a hard requirement** (raised 2026-05-13 PM). The spike uses **Node + jsdom + `@lumenize/testing`'s `Browser` class** as a pragmatic harness — fast, no CORS, no bundler issues. But jsdom is not a real browser: differences in input-event semantics, MutationObserver timing, CSS application, and paint scheduling all matter for a UI framework. Items 7, 8, 9 above would all have been silently sitting in the codebase until the first real-browser run; we got lucky that this spike exposed them early. Going forward, **5.3.7 must ship with at least one real-browser test suite** — either:
    - **vitest-browser-playwright + CORS-allowing wrapper Worker** (path A from the harness discussion): light setup; works for unit-style probes.
    - **Standalone Playwright tests served by wrangler-dev** (path B): heavier setup but production-realistic — Worker hosts both API and HTML page, no CORS, real browser cookies/storage.
    - **vitest-browser-playwright + vite proxy** with proper port coordination: medium setup; fragile to vitest-config-load-multiple-times quirk.
    
    **Triage**: own task file when 5.3.7 implementation phase opens. Scope: (a) fix items 7 + 8 first (mesh + debug), (b) decide on harness flavor, (c) port spike's Phase 1 probes to the real-browser harness, (d) add to CI. **Until this lands, every published commit on `@lumenize/nebula-frontend` is running on faith for real-browser behavior.** That faith is reasonable for the spike's go/no-go decision but not for production.

## Sources

- [Alpine.js Reactivity (alpinejs.dev/advanced/reactivity)](https://alpinejs.dev/advanced/reactivity) — `Alpine.reactive` / `Alpine.effect` primitives
- [Alpine.js Extending (alpinejs.dev/advanced/extending)](https://alpinejs.dev/advanced/extending) — `Alpine.directive` / `Alpine.magic` / `Alpine.plugin` API
- [Alpine.store docs (alpinejs.dev/globals/alpine-store)](https://alpinejs.dev/globals/alpine-store) — global reactive stores
- [Using Alpine.js with other state management libraries (studyraid)](https://app.studyraid.com/en/read/8389/231303/using-alpinejs-with-other-state-management-libraries) — Redux + MobX bridge patterns
- [Alpine Persist Plugin DeepWiki](https://deepwiki.com/alpinejs/alpine/4.3.1-persist-plugin) — closest analog to middleware-on-write pattern
- [markmead/alpinejs-component (GitHub)](https://github.com/markmead/alpinejs-component) — third-party component plugin for recursion patterns

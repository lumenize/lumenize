# Alpine.js adapter spike

## Starting here (read first)

This task file is the source of truth — read it through before touching code. The conversation that produced it accumulated context across multiple phases (5.3.6 shipped, then the Alpine pivot discussion); the decisions captured below are what's load-bearing. Don't rely on conversation memory if it conflicts with what's written here.

**First steps for a fresh session**:

1. Read this whole file end-to-end. The "Chosen path: Option B" decision and the "Pinned semantics to re-derive" table are the load-bearing pieces.
2. Read [packages/state/src/state-manager.ts](packages/state/src/state-manager.ts) (~470 LOC after 5.3.6.0) — this is what Phase 0 reimplements on `@vue/reactivity`.
3. Read [packages/state/src/helpers.ts](packages/state/src/helpers.ts) — pure utilities, keep as-is.
4. Read [packages/state/test/state-manager.test.ts](packages/state/test/state-manager.test.ts) — 80 tests defining the contract `StateManagerVue` must satisfy.
5. Quickly check `@vue/reactivity`'s public API: `npm view @vue/reactivity` then a quick look at its README / TypeScript exports. We need `reactive`, `effect`, `computed`, `pauseTracking` / `resumeTracking`, `effectScope`. Verify these are publicly exported before designing on them.
6. Create the spike directory: `apps/nebula/spike/alpine-adapter/` (NOT a package — just a working directory). Add `@vue/reactivity` and `alpinejs` as deps in a local `package.json` if needed for the probes; or work via a single HTML page that imports them from a CDN.
7. Start Phase 0: write `StateManagerVue` parallel to the existing class, drive it to pass the 80 existing tests unchanged (import the spike class in a copy of the test file — keep production code untouched).

**Bail-out triggers** (don't sink time past these):

- Phase 0: if more than 3-4 of the 80 tests can't pass without contortion → switch to Option C, document the wall, stop.
- Probes: if a probe hits a wall that no design tweak fixes in ~half a day → document and either switch to Option C or fall back to original 5.3.7a/b custom plan.

**Do NOT**:

- Modify production `@lumenize/state` during the spike. Work in spike-isolation; the parallel class lives only in `apps/nebula/spike/alpine-adapter/`.
- Modify production `apps/nebula/src/nebula-client.ts`. The reshape-the-NebulaClient-for-Alpine work happens AFTER the spike succeeds, in the real 5.3.7 implementation.
- Skip the 80 existing tests. Every pinned semantic must pass — that's the validation. Tests assume the current public API (`getState`/`setState`/`subscribe`/`use`/`executeBatch`/`track`/`computed`/`onSubscriberAdded`/`onSubscriberRemoved`); the Vue-backed class must expose the same shape so tests run unchanged.

## Goal

Determine whether `@lumenize/nebula-frontend` (Phase 5.3.7) should be built **on top of Alpine.js** rather than as a custom Alpine-flavored directive layer. Each of the 11 design decisions pinned for 5.3.7 was effectively "what Alpine already does, but our way" — that's a strong signal the build-our-own framing is the wrong default. Spike validates whether the reactivity-system mismatch (Alpine's `@vue/reactivity` Proxy model vs `@lumenize/state`'s path-based subscribe) can be bridged cleanly, OR whether we can reshape `@lumenize/state` so Alpine fits natively.

**Outcome**: a go/no-go decision on the pivot. If go: 5.3.7's planned 700-900 LOC of custom code drops to ~150-300 LOC of integration + plugin code. If no-go: confirms custom path is right and we proceed with the original 5.3.7a/5.3.7b plan.

**Time budget**: ~2-3 days. Phase 0 (re-derive `@lumenize/state` on `@vue/reactivity`) is ~1-1.5 days; probes 1-4 are ~1-1.5 days. Bail early if Phase 0 hits a wall on any pinned semantic, OR if a probe hits a wall that can't be designed around.

## Why now

- 5.3.7a/b have ZERO code written yet. Pivot cost is purely design-time; no throwaway.
- The accumulating "decisions to make" list for 5.3.7 was substantial (11 pinned, plus the underspecified $local-init handling). Each decision is a maintenance liability we'd own forever.
- User explicitly opened the door (2026-05-13): "we can make changes to NebulaClient to match the shape of alpine's proxy based approach so the shim does less" and "having NebulaClient return an Alpine compatible proxy from a factory function might be a good pattern here." So 5.3.6 code is **not** frozen — reshaping NebulaClient is on the table if it makes the bridge cleaner.
- After 5.3.7a lands, the pivot cost climbs sharply.

## Prior art (synthesized 2026-05-13)

### Alpine 3.x exposes a public reactivity API

From the [official reactivity docs](https://alpinejs.dev/advanced/reactivity):

- **`Alpine.reactive(obj)`** — wraps `obj` in a Vue-style Proxy (Alpine internally uses `@vue/reactivity`). Returns a reactive object; reads track deps, writes fire effects.
- **`Alpine.effect(fn)`** — runs `fn`, tracks every reactive read inside it as a dep, re-runs whenever any dep changes. **Crucially**, the directive-scoped `effect()` provided to custom directive callbacks auto-cleans on directive removal.

### Custom directive API gives us everything we need

From the [extending docs](https://alpinejs.dev/advanced/extending):

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

### Bridge patterns from existing integrations

**Redux** (mirror-and-sync via external subscribe):
```js
Alpine.store('redux', { state: store.getState(), dispatch: store.dispatch });
store.subscribe(() => {
  Alpine.store('redux').state = store.getState();  // wholesale replace triggers Alpine's Proxy
});
```
Components read `$store.redux.state.count`; Alpine's Proxy traps the read for dep tracking; the external `store.subscribe` listener writes back into Alpine's store, firing the effects.

**MobX** (autorun + spread):
```js
Alpine.store('mobx', store);
autorun(() => {
  Alpine.store('mobx', { ...store });  // MobX autorun fires on observable change; spread reassigns
});
```

**[Persist plugin](https://alpinejs.dev/plugins/persist)** — wraps `$persist(value)` so reactive writes mirror to localStorage. Closest analog to what our middleware does: intercept Alpine reactive writes and route to an external system.

### What this means for us

Alpine's reactivity is **already a Proxy backed by `@vue/reactivity`**. We don't need to "bridge two reactivity systems" if we make `@lumenize/state`'s data BE the Alpine reactive object (or backed by it). Three architectural options below.

## Design space

### Option A — Mirror-and-sync (Redux pattern)

Keep `@lumenize/state` exactly as-is. Maintain a parallel `Alpine.store('lmz', ...)` that's a clone of the state tree. On every `state.setState(...)`, write the same value into the Alpine store. On every Alpine store write (from `x-input`), call `state.setState(...)` so middleware runs.

- **Pros**: Smallest change to existing `@lumenize/state`. Both systems coexist independently.
- **Cons**: Double storage. Two-way sync hazards (loops if write-back isn't context-tagged correctly). Memory cost scales with state size.

### Option B — Replace `@lumenize/state`'s engine with `@vue/reactivity`

Refactor `@lumenize/state` so its internal `#state` is `reactive(obj)` from `@vue/reactivity` (the same library Alpine uses). All our existing APIs (`subscribe`, `setState`, `getState`, `computed`, middleware) re-implemented on top of `effect()` / Proxy traps.

- **Pros**: One source of truth. Native compatibility with Alpine — `Alpine.store('lmz', state.root)` just works. Re-uses a battle-tested library. Maybe smaller `@lumenize/state` LOC overall.
- **Cons**: 5.3.0 port work is partially thrown away. Some of our pinned semantics (hierarchical-with-deep-equals-dedup, explicit context tags, `executeBatch`) may not map cleanly and need re-derivation on top of `effect()`. Risk of subtle behavior differences breaking 5.3.6 tests.

### Option C — Thin Proxy wrapper over our StateManager

Keep `@lumenize/state` mostly as-is. Expose a Proxy-shaped facade via a factory: `createNebulaClient(...)` returns `{ client, store }` where `store` is a Proxy-of-our-state that Alpine treats as a reactive object. The Proxy:

- Get trap: read from `#state`; emit a "read at path" signal that Alpine's effect tracker can consume.
- Set trap: route through middleware → `setState` → fire our subscribers AND fire Alpine effects on the affected path.

Connecting our "read at path" signal to Alpine's effect tracker is the hard part — Alpine uses `@vue/reactivity`'s internal `track()` / `trigger()` calls. Either:
1. Use `@vue/reactivity` directly inside the wrapper: each path read calls Vue's `track()`, each setState calls `trigger()`. Bypasses Alpine's wrapper but uses the same tracker.
2. Wrap our state in `Alpine.reactive(state.root)` and let the Proxy traps work normally — set trap intercepted by Alpine fires Alpine effects; we just need to make sure setState writes go *through* the Proxy.

Either of these is the realistic shape.

- **Pros**: `@lumenize/state` stays standalone-MIT and its public API unchanged. Bridge is contained in one file.
- **Cons**: Read tracking needs internal access to `@vue/reactivity`'s tracker primitives — these are exported but lightly documented; risk of API churn.

### Option D — Custom-directive overlay (no shared reactivity)

Use Alpine for DOM crawling, MutationObserver, x-data scopes, x-for / x-if scaffolding, animation plugins, etc. But register **our own** `x-text` / `x-bind` / `x-show` directives that bind to `@lumenize/state` via our `subscribe(path, cb)` instead of Alpine's effect tracker. Two parallel reactivity systems coexist — Alpine for Alpine-state, ours for resources-state.

- **Pros**: Cleanest separation. No engine refactor.
- **Cons**: User writes some things in Alpine syntax (x-data, $store) and other things in our syntax. Mental-model split. Doesn't simplify much.

### Chosen path: Option B (decided 2026-05-13)

**Start the spike with Option B.** Rewrite `@lumenize/state`'s internals on `@vue/reactivity`; re-derive every pinned semantic the JurisJS port gave us in a Vue-native way. Rationale: too many layers of translation in Option C creates race conditions, subtle bugs, and a hard-to-debug surface. Option B has more up-front work but produces a cleaner runtime with fewer moving parts.

**Option C is the fallback** if any pinned semantic genuinely can't be re-derived. Document the wall in the task notes and switch.

### Path syntax: bracket notation, no template-literal tag (decided 2026-05-13)

Use Alpine's native bracket-notation for dynamic path segments. The `` resources`${rt}.${rid}.value.title` `` template-literal idea was attractive but doesn't pay back: bracket notation (`$lmz.resources.todo[todoId].value.title`) is already path-like, already what Alpine handles natively, and doesn't require introducing new vocabulary or a custom write-target convention.

## Pinned semantics to re-derive on `@vue/reactivity`

Each of these is currently implemented in [packages/state/src/state-manager.ts](packages/state/src/state-manager.ts) on the JurisJS port. Spike must re-derive each in a `@vue/reactivity`-native way. If any can't be re-derived cleanly, that's the trigger to fall back to Option C.

| Pinned semantic | JurisJS impl | Vue-reactivity mapping | Risk |
| --- | --- | --- | --- |
| **Hierarchical-notify** (write at `a` fires subscribers at `a.b.c`; write at `a.b.c` fires subscribers at `a`) | Custom `#fanout` walks subscriber map in three directions | Vue's Proxy naturally tracks each property read along a chain. Reading `state.a.b.c` registers `a`, `a.b`, `a.b.c` as deps. Ancestor write (replacing `a`) fires effects that read `a.b.c` because the intermediate proxies change identity. Descendant write fires effects that read `a` because `get(a)` is re-tracked. Should mostly come for free. | Low — Vue's standard tracking behavior |
| **Deep-equal dedup on hierarchical fanout** (ancestor write to a structurally-equal value skips fanout) | `deepEquals(subOld, subNew)` guard per subscriber inside `#fanout` | Vue does NOT dedup. Wrap setState: compare new vs current via deepEquals; skip the proxy mutation entirely if equal. For ancestor writes where some descendants change and others don't, the per-subscriber dedup is harder — may need wrapper-level effect logic that captures `prevValue` and compares. | **Medium** — biggest semantic re-derivation; design carefully |
| **`subscribe(path, cb)` with `(newValue, oldValue, changedPath)` callback signature** | Direct subscriber Map with manual dispatch | Wrap `effect(() => { const v = drill(state, path); cb(v, prev, ?); prev = v })`. The `changedPath` is harder — Vue's effect doesn't tell us which write triggered the re-run. May need a "current write path" sidecar variable set inside our setState before triggering. | Medium — `changedPath` reconstruction is the wrinkle |
| **`context: { source: 'remote' \| 'rollback' \| 'computed' }` discriminator** | Passed as 3rd arg to setState; middleware reads it | setState wraps the Vue write. Stash `currentContext` in module-scope (or AsyncLocalStorage-style); middleware reads from there. Synchronous so no async-context concerns. | Low |
| **Middleware chain** (substitute newValue, error containment) | Direct middleware list + try/catch wrapping | setState invokes middleware before writing to the Vue proxy. Substitution: middleware return value replaces. Error containment: try/catch each. Mostly unchanged. | Low |
| **`onSubscriberAdded` / `onSubscriberRemoved` hooks** (shipped 5.3.6.0) | Fire from subscribe() and disposer | Wrap Vue's `effect()` registration — track our own (path, effect) registry and fire hooks on add/remove. Since `subscribe(path, cb)` is our wrapper around `effect()`, we control the registry. | Low |
| **`executeBatch(callback)`** (last-write-wins per path during batch, single fanout at end) | Custom batch queue + dedup | Vue has `effectScope` / `pauseTracking` / `nextTick`. Synchronous batching might map to: enqueue writes to a Map keyed by path inside batch; flush at end with single `trigger()` per path. | Medium — need to verify Vue's batching primitives compose right |
| **`computed(targetPath, fn)`** (re-runs fn on dep change, writes result to a state path) | `track()` + manual subscribe + setState in effect | Wrap Vue's `computed(fn)` → register an effect that reads the computed and writes to targetPath. Self-reference check (target overlaps deps) we add explicitly. | Low |
| **Computed self-reference detection** (throw at registration if fn reads target/ancestor/descendant of target) | Explicit dep walk after first track | Same check on top of Vue. Track deps via Vue's `effectScope` introspection; throw if target overlaps. | Low |
| **`isValidPath` / `getPathParts` / `deepEquals` helpers** | ~110 LOC of pure utilities | Keep as-is or use Vue's equivalents where they exist. `deepEquals` we keep — Vue doesn't expose one publicly. | Low |
| **Circular-update guard** (setState during notify is rejected) | `#newSubs` Set + check in setState | Vue's effect-during-mutation is generally safe; Vue throws on infinite loops via flush-job tracking. May not need our explicit guard. Verify. | Low |
| **Subscriber iteration snapshot** (subscriber that re-subscribes mid-fanout doesn't recurse forever) | Snapshot entries Map before iterating in `#fanout` | Vue's effects have their own re-entrancy protection. Verify behavior. | Low |

**Total assessment**: ~3-4 mediums, all in the "deep-equal dedup + `changedPath` + `executeBatch`" cluster. Those are the ones to prototype first.

## Spike plan

Stand up a throwaway under `apps/nebula/spike/alpine-adapter/` (NOT a real package — single HTML page + a few TS files). Reasoning: not creating `experiments/` because there's no DO/Worker to deploy; this is a frontend probe.

**Phase ordering**: re-derive `@lumenize/state` on `@vue/reactivity` FIRST (Phase 0), then run probes 1-4 against the new engine. If Phase 0 hits a wall on any of the medium-risk semantics, that's the bail-out signal — switch to Option C without spending probe time.

### Phase 0 — Re-derive `@lumenize/state` on `@vue/reactivity`

- [ ] Install `@vue/reactivity` as a dev dep in the spike directory; verify Workers/Node-mode compatibility (it's a small standalone package, should be clean).
- [ ] Write a parallel `StateManagerVue` class with the same public API as our current StateManager. Don't touch the production `@lumenize/state` yet — work in spike-isolation.
- [ ] **First-pass re-derivations** (medium-risk cluster):
  - [ ] Deep-equal dedup on ancestor writes. Approach: wrap setState; before mutating the Vue proxy, compare new vs current via `deepEquals`; skip the write entirely if equal. For per-subscriber dedup on partial-change ancestor writes, capture `prevValue` inside the effect wrapper and compare per-fire.
  - [ ] `changedPath` reconstruction. Approach: stash `currentWritePath` in module-scope during setState; subscribe effect reads it when firing the cb. Synchronous, so no async-context issues.
  - [ ] `executeBatch`. Approach: enqueue writes to a Map<path, value> inside the batch; suppress per-write triggers via `pauseTracking()`/`resumeTracking()` or manual flag; flush at end with a single mutation pass per path.
- [ ] **Second-pass re-derivations** (low-risk): middleware chain, `context` discriminator, `onSubscriberAdded`/`Removed` hooks, `computed`, self-reference detection, circular-update guard.
- [ ] Run the existing 80 tests in [packages/state/test/state-manager.test.ts](packages/state/test/state-manager.test.ts) against `StateManagerVue`. Every pinned semantic must pass. **Bail-out trigger**: if more than 3-4 tests can't be made to pass without contortion, that's the signal to fall back to Option C.

### Probe 1 — Basic deep-path binding with auto-subscribe

Goal: prove that `x-text="resources.todo.task-42.value.title"` reads from our state and updates when the state changes.

- Stand up a `state` with a `resources.todo.task-42.value = { title: 'Initial' }` populated.
- Wrap (Option B) or proxy (Option C) so Alpine can read it.
- Mount an `<span x-text="resources.todo.task-42.value.title"></span>`.
- Programmatically `state.setState('resources.todo.task-42.value.title', 'Updated')` → assert the span text changes.

### Probe 2 — Ancestor-write reactivity

Goal: when the full `resources.todo.task-42.value` is replaced (e.g. via `handleResourceUpdate` from server fanout), bindings to descendants update.

- After Probe 1 works, replace the entire `.value` object: `state.setState('resources.todo.task-42.value', { title: 'Replaced' })`.
- Assert the x-text-bound span re-renders to "Replaced."
- Verify deep-equal dedup behavior: replacing `.value` with a structurally-equal object should NOT trigger a spurious re-render (this is the JurisJS-port semantic we want to preserve).

### Probe 3 — `x-for` with `$loopVar` substitution

Goal: prove the FK-list pattern from coding-your-ui.md works.

```html
<template x-for="todoId in resources.todoList.main.value.items" :key="todoId">
  <li>
    <span x-text="resources.todo[todoId].value.title"></span>
  </li>
</template>
```

Note: Alpine's syntax for the substitution here uses `[todoId]` not `.$todoId`. If we adopt Alpine, our "paths only" doc carve-out gets re-thought — Alpine's expressions naturally handle this via `[bracket]` notation. **This is a doc/API rewrite point** if we pivot.

Probe: Add a new ID to `items`; assert a new `<li>` appears AND `client.resources.subscribe(...)` fires for the new ID. Remove an ID; assert the `<li>` disappears AND grace-period unsubscribe fires.

This probe also tests the integration with bindToState's refcount auto-subscribe — does it still work if the binding registrations now flow through Alpine's effect tracker?

### Probe 4 — Per-instance state (`$local` / `x-data`)

Goal: prove that Alpine's `x-data` per-instance scope can replace our planned `$local` Proxy machinery.

```html
<template x-for="todoId in resources.todoList.main.value.items" :key="todoId">
  <li x-data="{ expanded: false }">
    <button @click="expanded = !expanded">Toggle</button>
    <template x-if="expanded">
      <p x-text="resources.todo[todoId].value.description"></p>
    </template>
  </li>
</template>
```

Alpine handles per-iteration state naturally via `x-data` on the cloned element. Each clone gets its own `{ expanded: false }` scope. No `$local`, no `x-key-from`, no `$trail` needed for this pattern.

For state we want to persist across reloads / share across components, we use `Alpine.store('ui', ...)` or `$persist`. Our `ui.{component}.{instanceKey}.*` pattern from the original $local design either survives as a Studio-codegen pattern (Studio emits `Alpine.store('ui-tree-item-foo', ...)` etc.) OR is dropped in favor of Alpine's `x-data` + `Alpine.store`.

This is the probe where the most design-replacement happens. If `x-data` + `Alpine.store` covers our use cases cleanly, ~150 LOC of planned 5.3.7b machinery vanishes.

### Bonus probe — recursion

If probes 1-4 pass, also try the DAG-tree recursive pattern with `<template x-for>` + recursive `<template x-render>` (or whatever Alpine's component-equivalent is — possibly the `markmead/alpinejs-component` plugin). This is the hardest case in coding-your-ui.md and tests whether Alpine's primitives + a plugin actually compose for recursive tree rendering.

## Decision matrix

After the spike, fill in:

| Phase / Probe | Worked cleanly? | Notes |
| --- | --- | --- |
| Phase 0 — StateManagerVue passes 80 existing tests | ? | |
| Probe 1 — basic binding | ? | |
| Probe 2 — ancestor write + deep-equal dedup | ? | |
| Probe 3 — x-for + FK bracket-substitution | ? | |
| Probe 4 — per-instance state via x-data | ? | |
| 5 (bonus) — recursion | ? | |

**Decision**:

- **Phase 0 clean + all 4 probes pass** → pivot, full Option B. `@lumenize/state` engine swap (port deprecated); `@lumenize/nebula-frontend` is a thin Alpine plugin. Drop ~70% of 5.3.7's planned scope. Rewrite [coding-your-ui.md](website/docs/nebula/coding-your-ui.md) for Alpine syntax. Reshape NebulaClient to expose a factory like `createNebulaClient(...) → { client, store }` where `store` is Vue-reactive and Alpine-compatible.
- **Phase 0 hits 3-4 semantic walls** → fall back to Option C: keep our StateManager as authoritative storage; add a `@vue/reactivity` broadcast layer Proxy that bridges to Alpine. JurisJS port survives. Bridge complexity is real but contained.
- **Probes fail even after Phase 0 clean** → unlikely, but if it happens, hybrid (use Alpine for some directives, custom for others) is the salvage path.
- **Both Phase 0 and probes fail** → confirms custom is right; revert to original 5.3.7a/5.3.7b plan.

## Relevant memory entries

Worth glancing at before designing on `@vue/reactivity`:

- **[path-based-reactivity](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_path_based_reactivity.md)** (⚠ in MEMORY.md): "Lumenize state stores must be path-keyed (`state.subscribe('a.b.c', cb)`). Don't suggest Vue/Alpine/MobX-style Proxy reactivity even when otherwise attractive — path-keyed is load-bearing for synced-state middleware and per-path snapshot fanout." **This memory predates the 2026-05-13 Alpine pivot decision** and needs updating after the spike resolves. The spike is specifically validating whether we can have BOTH (path-keyed public API + Vue-Proxy backing). If the spike succeeds, update this memory to "path-keyed PUBLIC API still required, but Vue-Proxy is an acceptable backing implementation."
- **[skip-failing-tests-when-deferring](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_skip_failing_tests.md)**: if any of the 80 tests can't pass on the Vue-backed class, prefer `it.skip` with original assertions and a "Blocked on:" comment over deletion. Lets the bail-out reasoning stay visible.
- **[github-org-lumenize](../../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/feedback_lumenize_github_org.md)**: org is `lumenize/lumenize`, not `lmaccherone/lumenize` — relevant if posting URLs in commits.

## What this spike outputs (if successful)

A "go" decision delivers:

1. **`StateManagerVue` class** in the spike directory passing all 80 existing tests. Becomes the basis of the production engine swap in 5.3.7.
2. **Spike HTML page** demonstrating all four probes working end-to-end against a real `vitest-pool-workers` Star backend (the existing baseline test-app).
3. **Updated [tasks/nebula-frontend.md](nebula-frontend.md)**: Phase 5.3.7a/b plans replaced with the Alpine-based plan. ~70% LOC reduction. Probably renamed sub-phases.
4. **Reshape plan for `apps/nebula/src/nebula-client.ts`**: factory `createNebulaClient(...) → { client, store }` where `store` is Vue-reactive. The `client.bindToState(state, options)` API is replaced. The 5.3.6 implementation (middleware, refcount, connection-state writes, flash, rollback) needs minimal surface adjustment — most of the logic stays, just plugged into the new store shape.
5. **Doc rewrite plan** for [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md): switch examples to Alpine syntax (`x-data`, `$store`, `[bracket]` notation, `x-model` instead of `x-input`, etc.). Significant but bounded — half the file maybe.
6. **Memory updates**: the `path-based-reactivity` feedback memory updated to reflect the public-API-vs-backing distinction.

A "no-go" decision delivers:

1. Documented walls (which pinned semantics couldn't be re-derived, which probes failed).
2. Recommendation: fall back to Option C (thin wrapper) or proceed with custom 5.3.7a/b.
3. The spike directory stays as a historical artifact — clean up by deleting later if not useful.

## Notes / open questions to resolve during the spike

- **Alpine in Node tests**: Alpine is browser-only. Our existing baseline tests run in vitest-pool-workers (Workers/Node-mode mix). The spike will need vitest-browser-playwright for the Alpine bits — same harness 5.3.7 was already planned to use. Pure-logic helpers (path resolution etc.) can still run in Node mode.
- **`@vue/reactivity` standalone**: if we go with Option B (replace our engine), we can use `@vue/reactivity` directly without taking Alpine as a dependency of `@lumenize/state`. Alpine becomes a dep only of `@lumenize/nebula-frontend`. Keeps `@lumenize/state` MIT/standalone story intact.
- **Bundle size**: Alpine is ~30KB minified. Our planned custom layer is ~10-30KB. The difference is small enough that bundle-size shouldn't drive the decision.
- **LLM training-data alignment**: the original reason for Alpine-flavored directives was LLM friendliness. **Using Alpine directly gives us this for free** — Alpine's expression syntax IS what LLMs are trained on. Some of our pinned "deviations" (paths-only, no expressions) we may want to *revisit* — paths-only was driven by safety and predictability, but if Studio is the primary code generator, the safety concern is reduced.
- **Doc rewrite scope**: `coding-your-ui.md` is currently written for our custom directive layer. A pivot means a significant rewrite — Alpine syntax, x-data scoping, $store usage, etc. Estimate: ~half the file. Acceptable if it means net less code overall.
- **`bindToState` API surface**: the factory-function shape `createNebulaClient(...) → { client, store, alpine }` would replace the current `client.bindToState(state, options)` flow. Cleaner — single entry point, no ordering concerns. Reshape allowed per user direction 2026-05-13.

## Sources

- [Alpine.js Reactivity (alpinejs.dev/advanced/reactivity)](https://alpinejs.dev/advanced/reactivity) — `Alpine.reactive` / `Alpine.effect` primitives
- [Alpine.js Extending (alpinejs.dev/advanced/extending)](https://alpinejs.dev/advanced/extending) — `Alpine.directive` / `Alpine.magic` / `Alpine.plugin` API
- [Alpine.store docs (alpinejs.dev/globals/alpine-store)](https://alpinejs.dev/globals/alpine-store) — global reactive stores
- [Using Alpine.js with other state management libraries (studyraid)](https://app.studyraid.com/en/read/8389/231303/using-alpinejs-with-other-state-management-libraries) — Redux + MobX bridge patterns
- [archtechx/alpine-reactive (GitHub)](https://github.com/archtechx/alpine-reactive) — Alpine 2.x reactivity layer; pattern reference (obsolete for 3.x)
- [Alpine Persist Plugin DeepWiki](https://deepwiki.com/alpinejs/alpine/4.3.1-persist-plugin) — closest analog to middleware-on-write pattern
- [markmead/alpinejs-component (GitHub)](https://github.com/markmead/alpinejs-component) — third-party component plugin for recursion patterns

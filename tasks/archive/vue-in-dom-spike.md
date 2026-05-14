# Vue 3 in-DOM mode adapter spike

## Starting here (read first)

This task file is the source of truth — read it through before touching code.

**Predecessor**: [tasks/alpine-adapter-spike.md](alpine-adapter-spike.md) — the Alpine spike that ran 2026-05-13. Reached an honest "partial go" finding: the design ideas hold (delete `@lumenize/state`, reshape NebulaClient, use a directive-based framework for the UI), **but Alpine is locked at `@vue/reactivity@3.1.5`** which (a) doesn't share reactiveMaps with any 3.2+ instance and (b) doesn't have `effectScope`. That made the "stock Alpine + factory's Vue store, magical seamless integration" vision unworkable; the realistic Alpine path required a ~250 LOC integration layer (custom `$lmz` magic + `x-lmz-*` directives + recursion plugin).

User raised the Vue-as-everything question: **drop Alpine, use Vue 3 in-DOM mode** (script tag + `v-*` directives directly on HTML, no SFC build step). The earlier rejection of Vue was about "Vue has stuff we don't need + vite HMR" — those concerns turn out to be much weaker than the Alpine version-pin we just discovered. This spike validates that pivot.

**First steps for a fresh session**:

1. Read the predecessor's Phase -1 § 7-10 (debug bundler config, mesh/client ALS, CORS, real-browser-testing roadmap) — those items carry forward verbatim.
2. Read this whole file end-to-end.
3. Verify the carried-forward code still passes its tests: `cd apps/nebula/spike/alpine-adapter && npx vitest run` should show **27/27** (24 Phase 0a factory + 3 Phase 0b e2e). If anything broke, fix that before adding new probes — the factory is the load-bearing artifact.
4. Then start Phase 1 of this spike (in-DOM probes against real Star DO).

**Spike directory note**: code continues to live in `apps/nebula/spike/alpine-adapter/` even though the framework target shifted. Renaming would create churn + git-history complications; the dir is throwaway after 5.3.7 implementation anyway. New Vue-specific tests will go in a new `test/vue/` subdirectory; the Alpine-specific harness (`test/browser/`) is OBSOLETE and should be deleted before adding new code.

## Goal

Validate that **Vue 3 in-DOM mode** is the right framework target for `@lumenize/nebula-frontend`:

- **In-DOM mode** = Vue 3 runtime+compiler bundle (~33 KB gzip), no SFC compilation, no build step. Users write HTML with `v-*` directives + a single `Vue.createApp({...}).mount('#app')`.
- The factory from Phase 0a (already pure `@vue/reactivity@3.5`) composes natively with Vue's components — same reactivity system, `effectScope` works, recursive components work.
- Two-system mirroring is gone. No `__v_skip` workarounds. No bridge layer.

**Outcome**: a go/no-go decision. If go: 5.3.7's plan finalized as "delete `@lumenize/state`, scaffold `@lumenize/nebula-frontend` around the factory + Vue in-DOM mode integration." If no-go: revert to the Alpine-with-integration-layer fallback from the predecessor's "partial go."

**Time budget**: ~1 day (realistic), with hard intent to land go/no-go same day. The half-day estimate in earlier drafts didn't account for Vue's runtime-compiler build-entry gotcha (see Phase 1 setup) + tree-recursion debugging. Carry-forward eliminates Phase 0a/0b (the factory + e2e tests already exist and work). Phase 1 (Vue in-DOM probes) is the main work. Phase 2 is the go/no-go writeup. (Pinia was on the table when this file was first drafted; user's evening read-up determined Pinia's no-build-step story is too awkward for our DOM-mode vibe-coder target — see Q6.)

**Why strict jsdom (not real-browser) for the spike**: `LumenizeClient`/`NebulaClient` currently can't be bundled for a real browser because of two unresolved transitive imports — `@lumenize/debug`'s `cloudflare:workers` import (Phase -1 § 7) and `@lumenize/mesh/client`'s `node:async_hooks` import via lmz-api (Phase -1 § 8). The Alpine spike dropped to Node + jsdom + `@lumenize/testing`'s `Browser` class to keep moving; this spike inherits the same harness. Fixing both is a hard prerequisite for 5.3.7 shipping, but is post-spike work that may require refactoring mesh + updating docs. Do NOT try to fix them during the spike — they're out of scope for go/no-go.

## Carry-forward inventory

Files in `apps/nebula/spike/alpine-adapter/` that **survive verbatim** into the Vue spike (no changes needed):

| File | Role | LOC |
| --- | --- | --- |
| `src/create-nebula-client.ts` | Factory: Vue Proxy + middleware + effectScope auto-subscribe | ~285 |
| `src/types.ts` | `Middleware`, `WriteContext`, `ClientLike`, `TransactionOutcome` | ~50 |
| `src/deep-equals.ts` | Structural equality helper | ~35 |
| `src/nebula-client.ts` | Reshaped NebulaClient (no `bindToState`, adds `onResourceUpdate` + `onConnectionStateChange` runtime hooks + `unsubscribe`) | ~830 |
| `src/nebula-client-adapter.ts` | NebulaClient → ClientLike adapter | ~80 |
| `src/errors.ts` | `OntologyStaleError` + type guard, copied from production | ~40 |
| `test/factory-basics.test.ts` | 24 Phase 0a tests against mock client | ~400 |
| `test/mock-client.ts` | Mock for Phase 0a tests | ~70 |
| `test/nebula-client-test.ts` | Test subclass with @mesh callbacks + initiator methods | ~95 |
| `test/index.ts` | Test-app worker entrypoint | ~20 |
| `test/test-harness.ts` | `instrumentDOProject` wrapping | ~20 |
| `test/wrangler.jsonc` | pool-workers wrangler config | — |
| `test/setup.ts` | vi.waitFor timeout bump | ~15 |
| `test/e2e/smoke.test.ts` | Phase 0b smoke against real Star | ~50 |
| `test/e2e/transaction-roundtrip.test.ts` | End-to-end transaction round-trip | ~110 |
| `test/e2e/cross-client-fanout.test.ts` | Cross-client fanout | ~100 |
| `probes/scheduling.ts` | @vue/reactivity scheduling probe | — |
| `probes/batching.ts` | ReactiveEffect + scheduler probe | — |
| `probes/clone-options.ts` | Proxy clone strategies probe | — |
| `probes/clone-types.ts` | structuredClone-via-toRaw type-preservation | — |

Files to **archive then delete** (Alpine-specific, obsolete) — rename to `test/_alpine-archive/` first so the bootstrap/harness patterns stay readable while building the Vue equivalents; delete the archive once Phase 1 passes:

- `test/browser/global-setup.ts` (wrangler-dev spawn pattern carries forward)
- `test/browser/harness.ts` (createResource, bootstrapAdmin patterns carry forward; `loadAlpine` is the only Alpine-specific bit)
- `test/browser/smoke.test.ts`
- `test/browser/probe-1-basic-binding.test.ts`
- `test/browser/stubs/` (cloudflare-workers stub — carries forward; verify async_hooks stub state)
- `test/browser/__screenshots__/`
- `test/wrangler-dev.jsonc` (likely reusable as-is)

Files to **deprecate-after-spike** (test files that imported from `test/browser/`):

- None — those imports were spike-internal.

Dependencies in `package.json` to **remove**:

- `alpinejs`, `@types/alpinejs`
- `jsdom`, `@types/jsdom` (Vue 3 in-DOM mode probably works in jsdom — verify before removing)

Dependencies in `package.json` to **keep**:

- `@vue/reactivity` (already there — load-bearing for the factory)
- `@cloudflare/vitest-pool-workers`, `@lumenize/*`, `vitest`, `unplugin-swc`, `wrangler`

Dependencies to **add** for this spike:

- `vue@^3.5` (full Vue 3 — provides createApp, components, in-DOM compiler)
- Possibly: `pinia@^2` if we evaluate Pinia
- Possibly: `@vitest/browser` + `@vitest/browser-playwright` if we go to real-browser harness (predecessor's Phase -1 § 10 still applies — real-browser is a 5.3.7 hard requirement, not a spike requirement)

## Open questions this spike must answer

### Q1 — Does Vue in-DOM mode actually work without a build step?

Set up a single `index.html` that loads `https://unpkg.com/vue@3/dist/vue.global.js`, defines a component with template strings, mounts it, observes DOM updates. No vite-as-bundler magic; just `<script>` tags. Confirm it renders correctly in jsdom (which is the harness target for the spike) AND in a real browser (manual eyeball OK).

### Q2 — Does the factory's outer Proxy compose with Vue components cleanly?

The factory's `store` is already a Vue Proxy. In Vue components, accessing `store.resources.todo[id].value.title`:
- Should trigger our `get` trap (path-aware, vivification, auto-subscribe via effectScope)
- Should register a dep on Vue's reactivity tracker
- Should re-render the component when the path changes

Specific concern: the factory's outer Proxy has `__v_skip` responding `true`. Inside Vue, if a child component accesses `store.x` and Vue tries to re-wrap, it should leave us alone. But our `__v_skip` test was via Alpine's old Vue; verify against Vue 3.5 too. Likely fine but worth confirming.

**Sub-probe Q2a — is `__v_skip` even needed?** The flag was added during the Alpine spike to stop Alpine's `Alpine.store(name, x)` from re-wrapping `x` with Vue's `reactive()`. In Vue 3 in-DOM mode, nothing analogous happens by default — components consume the store via `setup()` return values or template expressions, neither of which re-wraps. Quick probe: remove `__v_skip` handling, run Q2 + Q4 + Q3; if nothing breaks, leave it removed. The factory's mental model gets simpler.

**Sub-probe Q2b — vivification + render batching.** The get trap calls `Reflect.set(t, key, {})` when reading `resources` or `resources.<rt>` and the key is missing. Inside a Vue render effect, that write fires a Vue trigger on the parent property. With Vue's batched scheduler this should converge in one extra microtask; watch console for double-renders. Converging is fine; looping is not.

### Q3 — Tree-view recursion via native Vue components

The hardest case in `coding-your-ui.md`. Vue supports recursive components natively:

```js
const TreeNode = {
  props: ['nodeId'],
  setup(props) {
    const node = computed(() => store.resources.treeNode[props.nodeId]?.value);
    return { node };
  },
  template: `
    <li>
      <span>{{ node?.label }}</span>
      <ul v-if="node?.children?.length">
        <TreeNode v-for="childId in node.children" :key="childId" :node-id="childId" />
      </ul>
    </li>
  `,
};
```

Verify: each `TreeNode` instance, reading `store.resources.treeNode[nodeId]`, triggers auto-subscribe for `treeNode/<nodeId>`. Unmount stops the effect → grace → unsubscribe.

This is the load-bearing probe. If this passes, the spike's "go" is firmly grounded.

### Q4 — Auto-subscribe via effectScope: native composition

Phase 0a's tests proved `effectScope` auto-subscribe works for synthetic `effect()` calls. Vue components run setup() inside an `effectScope` per component instance. Reads inside `setup` (or template expressions, which Vue compiles to effects scoped to the component instance) should participate.

Verify: a Vue component reading `store.resources.todo[id].value.title` in its template fires the factory's auto-subscribe. When the component unmounts, the scope disposes → grace → unsubscribe.

**Must assert exactly-one unsubscribe**: render effects re-run on every dep change. `trackResourceRead` gates `onScopeDispose` registration via `scopeReads.get(scope)` so it should register once per scope, but the probe needs to prove it: mount → mutate state to force ≥2 re-renders → unmount → assert `client.unsubscribe` called exactly once (after the grace period). If we see N calls for N re-renders, the gating is broken under Vue's render-effect model.

### Q5 — `v-model` write paths → middleware → transaction

```html
<input v-model="store.resources.todo[id].value.title">
```

When user types: Vue's `v-model` writes the new value to `store.resources.todo[id].value.title`. Our Proxy `set` trap fires → middleware → optimistic apply + transaction.

Verify end-to-end against real Star.

### Q6 — Pinia: resolved, NOT pursued (2026-05-13 evening, user read-up)

User researched Pinia's no-build-step story before this spike began: Pinia's `defineStore` + composable pattern leans hard on SFC-bundled imports. The no-build path exists but is awkward (import maps, pre-bundling, or wrapping in `Vue.createApp({components, setup}).mount()` boilerplate that defeats the simplicity win). For Lumenize's vibe-coder "single HTML file with `<script src>`" target, Pinia adds more friction than it removes.

**Decision**: standalone factory wins by default. Pinia is OFF the spike's plate. If a strong post-spike need for DevTools / cross-component state emerges, revisit then.

### Q7 — Vue version pinning

Pin to Vue 3.5+? Or accept 3.2+ (when `effectScope` was added)? Vue is well-maintained; pinning to a specific minor version probably isn't critical. Likely `^3.5` for safety.

## Spike plan

### Phase 0 — Verify carry-forward (~15 min)

- [x] `cd apps/nebula/spike/alpine-adapter && npx vitest run` — expect 27/27 across phase-0a + phase-0b projects.
- [x] If anything fails (unlikely — these tests are independent of Alpine), fix that first.

### Phase 1 — Vue in-DOM probes (~most of a day)

- [x] Clean up: rename `test/browser/` → `test/_alpine-archive/` (keeps Alpine bootstrap/harness patterns as reference until Vue equivalents land). Delete the archive after Phase 1 passes.
- [x] Harness is forced: **Node + jsdom + `@lumenize/testing`'s `Browser` class + Node-native WebSocket.** Not a preference — `LumenizeClient`/`NebulaClient` can't be bundled for a real browser yet (Phase -1 § 7 + § 8 are unresolved). Real-browser is post-spike work.
- [x] Add `vue@^3.5` to spike deps.
- [x] **Vue build entry**: Vue's default `vue` ESM main is the runtime-only bundler build — no template compiler, so template strings won't compile at runtime. Import from `'vue/dist/vue.esm-bundler.js'` (set `__VUE_OPTIONS_API__` / `__VUE_PROD_DEVTOOLS__` defines if needed) OR `'vue/dist/vue.esm-browser.js'` (compiler-included, browser-flavored ESM). The browser-flavored build is the closer match to in-DOM mode end-user shape and is the recommended choice for the spike unless we hit a vite resolution issue.
- [x] Update `vitest.config.ts`: replace the `phase-1` Alpine project with a Vue-in-DOM project. Keep the `cloudflare:workers` stub (predecessor Phase -1 § 7 — `@lumenize/debug` bundler issue is unchanged) and the `node:async_hooks` stub (predecessor Phase -1 § 8 — mesh/lmz-api is unchanged).
- [x] Build a fresh `test/vue/global-setup.ts` (clone the archive's wrangler-dev spawn pattern; no proxy needed since fetches are Node-side via `Browser`).
- [x] Build a fresh `test/vue/harness.ts` (port `setupHarness` from the archive; drop `loadAlpine`; add `loadVue` if needed for build-entry switching).
- [x] **Q1 probe**: smoke test that `Vue.createApp` mounts a component on a jsdom element and re-renders on reactive change. ~30 LOC.
- [x] **Q2 probe**: instantiate factory + create a Vue component whose template reads `store.lmz.connection.connected`. Wait for connection. Assert DOM shows the right value. Confirm factory's `__v_skip` doesn't fight Vue 3.5's reactive wrapping.
- [x] **Q4 probe**: component reads `store.resources.todo[rid].value.title` (pre-existing resource). On mount → factory auto-subscribe fires → initial snapshot lands → DOM renders the title. On unmount → grace expires → unsubscribe fires. **This is the auto-subscribe smoke — load-bearing.**
- [x] **Q3 probe**: recursive `TreeNode` component renders a 3-level tree. Create root + child + grandchild resources via test-init. Mount root. Assert all three levels render. Mutate the deepest leaf's title → assert it propagates.
- [x] **Q5 probe**: `v-model` on `store.resources.todo[rid].value.title`. Simulate input event in jsdom → factory middleware → real Star transaction → committed → store eTag advances → DOM shows new value. Verify rollback on validation-failed too.

### Phase 2 — Go/no-go writeup (completed 2026-05-14)

- [x] Fill in the decision matrix below.
- [x] Update `path-based-reactivity` memory entry: flipped from "ACTIVELY RECONSIDERED" to "Resolved — path-based PUBLIC API on Vue reactivity engine; `@lumenize/state` being deleted." Renamed to `path-based-public-api-on-vue-reactivity`.
- [x] Update [tasks/nebula-frontend.md](nebula-frontend.md) Phase 5.3.7 plans: added "Phase 5.3.7 (Vue replan, 2026-05-14) — ACTIVE PLAN" section ahead of the Alpine-flavored 5.3.7a/5.3.7b (kept as historical record, marked SUPERSEDED). Pinned debouncing policy (500 ms quiet + 2000 ms maxWait + serial-per-resource queue + flush-on-lifecycle) + factory-before-connect order invariant + `__v_skip` removal + conflict-resolver carry-forward + in-DOM tag-case + v-model `v-if` guard pattern.
- [x] Update [website/docs/nebula/coding-your-ui.md](../website/docs/nebula/coding-your-ui.md): top half rewritten for Vue 3 in-DOM mode (createApp + factory + v-model + recursion + per-component state + debouncing). Lower half (x-* directives) marked SUPERSEDED with an at-a-glance mapping table to v-* equivalents. Full rewrite of the lower half deferred to Phase 5.3.7-v4 alongside the production factory.
- [x] Update [MEMORY.md](../memory/MEMORY.md): flipped the "5.3.7 architectural pivot in progress" active section to "5.3.7 framework target — RESOLVED 2026-05-14: Vue 3 in-DOM mode" with end-state architecture + spike findings summary + prerequisites list. Also noted on the `phase-5.3-ui-design-pinned` entry that two of its headlines (Alpine UI package + `@lumenize/state`) are now obsolete.

## Decision matrix (filled in 2026-05-14)

| Phase / Probe | Worked cleanly? | Notes |
| --- | --- | --- |
| Phase 0 — 27/27 carry-forward tests pass | ✅ | 24 Phase 0a (factory-basics) + 3 Phase 0b (smoke, transaction-roundtrip, cross-client-fanout). |
| Q1 — Vue createApp in jsdom without build | ✅ 2/2 | Bundler entry: `vue/dist/vue.esm-bundler.js` (compiler-included). Default `vue` ESM main is runtime-only — confirmed. |
| Q2 — Factory + Vue composition (factory's Proxy + Vue's reactive) | ✅ 3/3 | Vue tracks reads through outer Proxy via Reflect.get to inner Vue reactive; writes via Proxy fire Vue triggers. Connection-state surfacing works once factory created before connect. |
| Q2a — `__v_skip` sub-probe | ✅ Confirmed dead | Vue 3.5 in-DOM mode probes `__v_isRef` (pass-through OK), never probes `__v_skip`. Removed from factory; 36/36 still green. |
| Q4 — Auto-subscribe via Vue component's setup-scope effects | ✅ 2/2 | **Required ~10 LOC bridge**: Vue's `ReactiveEffect.run()` doesn't activate the component scope, so `getCurrentScope()` returns null inside renders. Fall back to `getCurrentInstance()?.scope` from `@vue/runtime-core` and register `onScopeDispose` via `scope.run(...)`. Verified exactly-one subscribe across forced re-renders + exactly-one unsubscribe after grace; multi-component shared-resource refcount correct (2→1→0 with one unsubscribe). |
| Q3 — Recursive tree component | ✅ 1/1 | 3-level tree (root → 2 children → 1 grandchild) renders via native Vue recursive component. 4 distinct subscribe calls. In-DOM tag-case: kebab (`<tree-node>`) required when written to `innerHTML`; PascalCase works inside template strings. |
| Q5 — v-model write + middleware + real Star transaction | ✅ 1/1 | Optimistic apply lands within one tick; transaction commits; eTag advances. `v-model` needs `v-if` guard until snapshot lands — `?.` not allowed in v-model l-value path. Documented as Vue idiom. |
| Q6 — Pinia | **Resolved 2026-05-13: NOT pursued** | No-build-step ergonomics too awkward for "single HTML file + `<script src>`" target. Factory wins by default. |

**Final test count: 36/36 across 9 test files** (27 carry-forward + 9 Vue probes).

**Decision: GO with Vue 3 in-DOM mode.**

Q1–Q5 all clean. Two material findings have clean fixes (the scope-bridge ~10 LOC + the factory-before-connect order invariant). The factory's core mental model (Proxy + middleware + effectScope-tied refcount + middleware-debounce) carries forward intact. The Alpine + ~250 LOC integration-layer fallback from the predecessor is NOT needed.

**Active 5.3.7 plan**: see [tasks/nebula-frontend.md](nebula-frontend.md) § "Phase 5.3.7 (Vue replan, 2026-05-14) — ACTIVE PLAN". Phase 5.3.7-v1 unblocks the two prerequisite bundling issues (`@lumenize/debug` `cloudflare:workers` import + `@lumenize/mesh/client` `node:async_hooks` import); v2 ports the factory + Vue integration; v3 stands up the real-browser harness; v4 rewrites coding-your-ui.md.

**Material findings folded forward to 5.3.7 design:**

1. **Vue's render effects don't activate their owning scope.** `ReactiveEffect.run()` sets `activeSub` and `shouldTrack` only. The factory must use `getCurrentInstance()?.scope` as a fallback inside `trackResourceRead`. ~10 LOC bridge captured in [apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts) (`getActiveVueScope`).
2. **Factory must be created BEFORE awaiting client connection.** `onConnectionStateChange` fires on transitions only; late registration misses the initial `connecting → connected` sequence. Doc this as the canonical setup order. Alternative considered (factory replays current state on registration) is a future API choice for the post-spike factory; the order invariant is simpler.
3. **`v-model` is per-keystroke by default.** Per-keystroke transactions pile up. Server-side history-dedup is 60-min window; client-side debounce must be independent. Debounce belongs in the synced-state middleware (NOT in v-model itself — DOM-level debouncing breaks the optimistic-paint invariant). Pinned policy in 5.3.7 plan: 500 ms quiet + 2000 ms maxWait + flush on unmount/blur, with per-call `client.resources.transactionDebounce(...)` override.
4. **`__v_skip` is dead code in Vue 3.5 in-DOM mode.** Removed from spike factory; no regression. Don't port the flag into production.
5. **In-DOM template tag case is browser-parser-bound, not Vue-bound.** Markup written to `innerHTML` MUST use kebab-case for custom components. Template strings (parsed by Vue's runtime compiler) accept either case. Doc this for vibe coders — non-obvious until something breaks.
6. **`v-model` on a deep path needs `v-if` to guard until the snapshot lands.** Optional-chaining can't appear in a v-model l-value path. Standard Vue pattern; vibe coders won't infer it without an example.

## Carry-forward Phase -1 items (from alpine-adapter-spike.md)

All Phase -1 items 1-10 from the predecessor apply to this spike unchanged. Highlights:

- **§ 7 (`@lumenize/debug` bundler config)** — still needs the `cloudflare:workers` stub or proper `optimizeDeps.exclude` config for any Vite-bundled build. Real fix is in debug package.
- **§ 8 (`@lumenize/mesh/client` pulls in `node:async_hooks`)** — still needs the AsyncLocalStorage shim for browser bundles. Real fix: split or lazy-load mesh's lmz-api.
- **§ 9 (no CORS headers from NebulaAuth)** — still relevant if `@lumenize/nebula-frontend` is ever served cross-origin from the API Worker.
- **§ 10 (real-browser testing is a 5.3.7 hard requirement)** — even more relevant now: with Vue (not Alpine), we have less framework-quirk fidelity loss in jsdom, but we still don't catch real-browser issues. Spike-jsdom validation does NOT substitute for 5.3.7's real-browser harness.

New Phase -1 items added by this spike:

11. **Vue in-DOM compiler bundle vs runtime-only build choice** (raised 2026-05-13). In-DOM mode uses the larger `vue.global.js` (~33 KB gzip) which includes the template compiler. For production-final builds where Studio pre-compiles templates, switching to runtime-only `vue.runtime.global.js` (~22 KB gzip) saves 11 KB. **Triage**: defer to Studio integration design; for the spike and v1 of `@lumenize/nebula-frontend`, the in-DOM compiler ships.

12. **Pinia decision rationale** (raised 2026-05-13, **resolved same day**). Standalone factory wins; Pinia not pursued. Reasons: (a) `defineStore` + composable pattern assumes SFC-bundled imports; the no-build path requires import maps or pre-bundling that defeats the "single HTML file + `<script src>`" simplicity win we're optimizing for; (b) our factory's middleware + path-aware Proxy semantics don't map cleanly onto Pinia's state/getters/actions decomposition — we'd be fighting the library rather than using it; (c) DevTools integration is nice-to-have, not load-bearing. If a real cross-component coordination need surfaces post-spike, revisit then. **Triage**: document outcome here; no further action.

13. **Spike-dir naming** (raised 2026-05-13). The dir is `apps/nebula/spike/alpine-adapter/` even though the spike's target shifted to Vue. Renaming would create git-history churn. **Triage**: leave as-is; the dir gets deleted after 5.3.7 implementation. Document the naming in the dir's README if one is added.

## Notes / context

- **Why not abandon the spike and just commit to Vue?** Honestly tempting — the dual-Vue-version finding is strong evidence Vue-everywhere is structurally cleaner. But the user has surfaced (and the team needs) explicit validation for the tree-view recursion case, and the Pinia question is worth ~1 hour to answer. So one half-day spike to derisk before sinking 5.3.7 implementation time.
- **What "in-DOM mode" actually means**: a single HTML file with `<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>` and templates as in-element HTML or template strings. NO `.vue` files. NO vite build pipeline at consumer time. For development convenience, Studio's deploy can use vite to pre-bundle template-compilation away, but that's an optimization, not a requirement.
- **What this changes about NebulaClient's location**: nothing. The same plan from the predecessor — move from `apps/nebula/src/` to `@lumenize/nebula-frontend` in 5.3.7 — still applies.

## Sources

- [Vue 3 in-DOM templates docs](https://vuejs.org/guide/scaling-up/tooling.html#none-build) — building Vue apps with no build step
- [Vue 3 recursive components](https://vuejs.org/guide/components/registration.html#local-registration) — `name` property + self-reference in template
- [Pinia docs](https://pinia.vuejs.org/) — official state management for Vue
- [Vue 3.5 release notes](https://blog.vuejs.org/posts/vue-3-5) — current Vue version
- [Predecessor: alpine-adapter-spike.md](alpine-adapter-spike.md) — Alpine path, including the dual-Vue-version finding that triggered the pivot

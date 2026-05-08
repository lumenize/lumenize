# Lumenize UI Packages — `@lumenize/state` + `@lumenize/ui`

**Status**: Active — critical path for the demo. `@lumenize/state` ports first (risk-free); `@lumenize/ui` is conditional on the LLM-generation spike.
**License**: MIT for both — standalone, dual-licensed-friendly
**Source material**: JurisJS — port the reactive subset, drop framework-integration glue
**Depends on**: Phase 5.3 (single-resource subscriptions), Phase 7 (NebulaClient subscribe wrappers)

## Package split

The JurisJS port lands as **two packages**, not one:

- **`@lumenize/state`** — `StateManager` + path helpers (`isValidPath`, `getPathParts`, `deepEquals`). Roughly 340 LOC. A path-based reactive store comparable to Zustand or `@preact/signals`, but with the dotted-path semantics that match Nebula's resource model. **NebulaClient binds to this** as its local store (no shadow cache — see Phase 5.3). Useful standalone too — any reactive-store consumer can pull it in.
- **`@lumenize/ui`** — `DOMRenderer` + `ComponentManager` + `Juris` orchestrator on top of `@lumenize/state`. ObjectDOM templates with the function-vs-value reactive pattern. **Port is conditional on the LLM-generation spike** (see "Recommended sequence" below).

Why split:

1. **De-risks the framework decision.** `@lumenize/state` is clearly correct work — NebulaClient needs the store regardless of how UI is rendered. Committing to it now is risk-free; committing to the renderer is gated on whether ObjectDOM is the right shape for LLM-generated UIs.
2. **Headless mode falls out naturally.** NebulaClient in a Node test or script needs a store but no renderer. With the split, headless mode is "depend on `@lumenize/state` only." Without the split, it's a tree-shaking question or worse.

## Recommended sequence

1. **Port `StateManager` + helpers → publish as `@lumenize/state`.** ~340 LOC of must-keep code. Risk-free; useful regardless of how the framework question resolves.
2. **Wire NebulaClient to `@lumenize/state`.** Phase 5.3.3 handlers write through to the bound StateManager. Test in headless mode (no DOM).
3. **Run the LLM-generation spike.** Hand Claude an ontology + StateManager docs + 2–3 example components in *both* shapes (ObjectDOM and vanilla HTML+JS-against-StateManager). See which Claude produces more reliably.
4. **If ObjectDOM wins**: port the renderer + components into `@lumenize/ui`. Studio generates ObjectDOM templates.
5. **If vanilla wins**: skip the renderer port entirely. Studio generates HTML+JS that subscribes to StateManager directly. `@lumenize/ui` may not need to exist as a separate package at all (or becomes a thin "starter kit + utilities" thing).

The store is the same either way. The renderer is the only thing under question.

## Styling: DaisyUI

**Pinned**: Studio-generated UIs use DaisyUI (Tailwind component library, MIT). Cleanly orthogonal to the ObjectDOM-vs-vanilla decision — pure CSS, framework-free, works identically with `className: 'btn btn-primary'` (ObjectDOM) and `class="btn btn-primary"` (vanilla HTML).

Why DaisyUI:
- **Renderer-agnostic.** Removes one variable from the LLM-generation spike: Claude picking reasonable classes isn't conflated with "did ObjectDOM work."
- **LLM training quality.** Tailwind + DaisyUI is heavily represented in training data; LLMs produce clean DaisyUI code with minimal prompting.
- **Theme system.** CSS variables → maps naturally onto Nebula's per-tenant branding direction.
- **Mature and MIT-licensed.** Stable since 2020+; no maintenance hand-wringing.

Asset pipeline — long-term hybrid, demo-time simplification (decide details during the Studio hosting spike):

- **Long-term: hybrid (the right answer).**
  - Studio preview / iteration loop → **precompiled DaisyUI+Tailwind CSS bundle**, served as a static asset. No build delay in the fast inner loop.
  - Deploy event → trigger **per-app Tailwind JIT** server-side (in Cloudflare Containers, where the Tailwind CLI standalone binary runs as-is). Emits a per-app CSS bundle of ~5–30KB containing only classes the app actually uses; arbitrary Tailwind values (`w-[847px]`, custom colors) supported; full DaisyUI plugin features. Stored as a deployable artifact, served from there.
  - This maps onto the branch-vs-main split already in the platform (see `tasks/nebula-branches.md`): non-main branches (Studio iteration) → precompiled; deploy to `.main` → per-app build.
- **Demo-time: precompiled only.** Build pipeline + Container orchestration is real work; ship precompiled first, add the per-app build pipeline post-demo. Demo apps will be small enough that the precompiled bundle's size is acceptable.
- **Alternative considered, declined**: Tailwind Play CDN (in-browser compile, ~70KB JS, recompiles per load) — fine for previews, not great for production. The hybrid above strictly dominates it.

Caching for the build pipeline (when it lands): cache key is `(hash of source files referencing classes, Tailwind version, DaisyUI version, theme config hash)`. Cache hits are common across redeploys when only application logic changes. Worth getting right so iteration latency stays low even during heavy CSS churn.

DaisyUI is **not** part of `@lumenize/state` or `@lumenize/ui`. It's a CSS file the platform serves. Generated UIs reference its classes; nothing else needs to know about it.

This sharpens the case for the package split: with DaisyUI carrying the visual layer, vanilla HTML+DaisyUI is already a complete-feeling UX, and `@lumenize/ui`'s value is concentrated specifically in the reactivity ergonomic. The renderer needs to clear that bar to earn its keep.

## What the UI talks to

**The UI talks to StateManager, not to NebulaClient.** NebulaClient is the plumbing behind a bound StateManager (transport, auth, eTag, conflict handling). UI code reads from / writes to a path; NebulaClient invisibly syncs paths configured as synced.

In ObjectDOM (if `@lumenize/ui` ports):

```js
{ input: { value: () => state.getState('task.value.title'),
           oninput: (e) => state.setState('task.value.title', e.target.value) } }
```

In vanilla DOM (the fallback):

```js
state.subscribe('task.value.title', t => titleEl.textContent = t);
inputEl.addEventListener('input', e => state.setState('task.value.title', e.target.value));
```

Either shape, NebulaClient stays out of the UI layer entirely.

## Must-keep (decision pinned)

These are the JurisJS primitives we definitely want; the inventory below maps them to packages.

- **`getState()` / `setState()` / `subscribe()`** — the imperative state primitives. → `@lumenize/state`
- **The "object DOM" / template pattern** where:
  - A function-valued slot is **reactive** — re-evaluated when its dependencies change.
  - A value-valued slot is **evaluated once** at render time.
  - This is the central ergonomic that makes synced and local state interchangeable in component code. → `@lumenize/ui` (conditional on the spike)

## On the cutting room floor

- **Registration / integration glue for non-JurisJS frameworks** (React, Svelte, Vue, etc.). Nebula doesn't need them and we don't want to maintain them.

## Pre-port inventory (filled in 2026-05-06)

> **Package mapping**: under the split above, items in the "Definitely keeping → Top-level helpers + StateManager" group below belong to `@lumenize/state`; everything else (DOMRenderer, ComponentManager, Juris orchestrator) belongs to `@lumenize/ui` and ports only if the LLM-generation spike picks ObjectDOM.

**Source read**: cloned `https://github.com/jurisjs/juris.git` to `/tmp/juris-source` (HEAD of default branch, source comment marks v0.91.0; `package.json` says 0.88.2 monorepo / 0.9.2 published). MIT licensed. The framework is essentially one file (`src/juris.js`, ~2,227 LOC) plus a handful of independent feature modules.

### Documentation

Plenty, and it lives in the repo — no scraping required:

- `readmes/` (~26,000 LOC of markdown across 21 files): `juris_documentation.md` (2,146 lines), `juris_whitepaper.md` (2,184), `juris_headless_guide.md` (2,751), `juris-plugin-patterns.md` (3,369), `juris-object-dom-architecture.md` (1,189), `juris-developer-readme.md` (591), `newstate_readme.md` (389, covers the component-local state pattern), `juris-subscribe-context-guide.md` (366), `urlstatesync_documentation.md` (375), `juris_database_ui_readme.md`, plus a CSS-extractor guide and a mobile-renderer write-up.
- `ai-guides/ai-guides.md` (3,516 lines) — instruction-heavy guide aimed at LLM code-generation, directly useful as a starting point for Studio's system prompts.
- `demos/` — 27 standalone HTML files (router demo, todo, dashboard, ecommerce, calculator, control-flow, JSON streaming, news, stress tests). These are the "ground truth" for what the framework actually supports.
- `site/` — source for jurisjs.com.
- `README.md` (180 lines) and `CONTRIBUTING.md` (394 lines) at root.

We won't keep the upstream docs verbatim — they're MIT-licensed but they describe their public API, not ours. Useful as *reference material* during the port (especially the AI guide and the headless-pattern docs), and as a source of demo apps to validate against. We'll write our own docs in `/website/docs/ui/` per the project doc rules.

### Shape of the codebase

- `src/juris.js` (~2,227 LOC) — the four core classes: `StateManager`, `ComponentManager`, `DOMRenderer`, `Juris` orchestrator, plus ~75 LOC of top-level helpers (`isValidPath`, `getPathParts`, `deepEquals`, `createLogger`, `createPromisify`).
- `src/juris-template.js` (149 LOC) — HTML `<template data-component>` compiler. Optional, attached via `config.features.template`.
- `src/juris-headless.js` (125 LOC) — `HeadlessManager`: non-rendering "components" that expose APIs onto the context (router, api client, etc.). Optional, attached via `config.features.headless`.
- `src/juris-enhance.js` (607 LOC) — `DOMEnhancer`: progressive enhancement of pre-existing DOM (a different mode from object-VDOM rendering).
- `src/juris-webcomponent.js` (398 LOC) — `WebComponentFactory`: wrap a Juris component as a `<custom-element>`.
- `src/juris-cssextractor.js` (595 LOC) — Tailwind-style CSS extraction from inline `style` props.
- `headless/` and `src/headless/` (~5,500 LOC across 10 files) — self-contained "headless components" (apiclient, asm, fluentstate, router, hooks library, url-state-sync, json-component-factory, docs-api). None are required by the core; each plugs in via `HeadlessManager`.
- `build.js` — concatenates `src/juris.js` with browser/ESM/CJS shim footers. Trivially replaced by our own packaging.

### 1. Definitely keeping

These are load-bearing for `getState`/`setState`, the function-vs-value reactive-template pattern, or the subscribe-as-state wiring. All from `src/juris.js`.

- **Top-level helpers** — `isValidPath`, `getPathParts`, `deepEquals` (~30 LOC, lines 68–80). `getState`/`setState` use dotted paths; `deepEquals` is what suppresses no-op updates and avoids flicker (Phase 5.3 reconnection replay).
- **`StateManager`** (lines 138–445, ~310 LOC) in nearly its entirety:
  - `getState(path, defaultValue, track)`, `setState(path, value, context)` — the imperative primitives.
  - `track(fn, isolated)` + `this.deps` — **the auto-dependency-detection mechanism**. Calling `getState` inside a `track()` adds the path to the active deps set; this is what makes a function-valued slot reactive without explicit declarations.
  - `subscribe`, `subscribeExact`, `subscribeInternal` + `externalSubscribers`/`subscribers` maps — the external-subscribers path is the integration point for NebulaClient subscribe pushes; the internal path is what DOMRenderer uses to re-run reactive slots.
  - `#notifySubscribers` / `#triggerPathSubscribers` — re-executes reactive callbacks under a fresh `track()` so dep sets stay current as conditionals change.
  - `executeBatch` + batch-queue internals — needed for coalescing multi-field writes (e.g., one `Snapshot` arrival updating several paths).
  - Middleware list (`this.middleware`) — runs on every `setState`. **This is the natural hook for the subscribe-as-state wiring**: a "sync this path" middleware can intercept local writes and push them to NebulaClient.
  - `#hasCircularUpdate` guard — recursion safety.
- **`DOMRenderer`** (lines 941–1852, ~910 LOC) in most of its entirety:
  - `render` / `_renderToDOM` — entry point that walks the object VDOM.
  - `applyProp` — the dispatch that decides "function ⇒ reactive, value ⇒ static, promise ⇒ async placeholder." This *is* the must-keep pattern.
  - `_handleText`, `_handleStyle` (with reactive style-property handling), `_handleChildren`, `_handleReactiveAttribute`, `#createReactiveHandler`, `_createReactiveUpdate` — five sibling reactive code paths sharing the same shape. Each calls `stateManager.track(fn)`, then `subscribeInternal(path, update)` for every collected dep.
  - `#handleReactiveChildren`, `#renderReactiveChildren`, `#setupSingleReactiveChild`, `#handleReactiveFragmentChildren`, `#createIndividualReactiveChild` — four flavors of reactive children depending on whether the slot is a single fn, a mixed array, a fragment, or a child of a fragment. Cutting any leaves a documented use case broken.
  - `_setStaticAttribute` — boolean attrs, `htmlFor`/`className` aliases, SVG handling, data-/aria- pass-through. Required for the static branch of the function-vs-value split.
  - `_handleEvent` + `eventMap` — `onclick`, `oninput`, etc. on object VDOM. Required for any interactive UI.
  - `cleanup(element)` + the `MutationObserver` in the constructor — auto-unsubscribe when an element leaves the DOM. Without this, every reactive slot is a memory leak.
  - `BOOLEAN_ATTRS`, `SVG_ELEMENTS`, `PRESERVED_ATTRIBUTES`, `SKIP_ATTRS` constants — small lookup sets used by `_setStaticAttribute` and `#createElementByType`.
- **`ComponentManager`** (lines 447–932, ~485 LOC) — the *minimal* slice:
  - `register`, `create`, `#setupComponentContext`, `#createComponentContext`, `#processComponentResult`, `#createComponentInstance`, error/cleanup paths.
  - **`newState(key, initial)`** in `#createComponentContext` (lines 504–514) — component-local state stored at `##local.{compId}.{key}` in the global tree. Returns `[get, set]`. **This is the existing precedent for "synced and local state look the same in component code"** — both go through the same `StateManager`. The subscribe-wired version is `newState` plus a "sync me" config knob.
  - `cleanup`, `#cleanupcompStates`, `#cleanupStateSet` — disposes `##local.{compId}.*` paths when a component element unmounts.
- **`Juris` orchestrator** (lines 1854–2227, ~250 LOC after cuts) — only the wire-up:
  - Constructor (state/components/renderer instantiation).
  - `#createBaseContext` / `createContext` — assembles the `{ getState, setState, subscribe, executeBatch, components, ... }` object passed to every component function. The shape Nebula will document.
  - `render(container)`, `#renderImmediate` — the mount entry point. Layout-as-array with optional reactive functions is fine to keep.
  - Public proxy methods: `getState`, `setState`, `subscribe`, `subscribeExact`, `executeBatch`, `registerComponent`, `getComponent`, `objectToHtml`, `cleanup`, `destroy`.

**Transitive dependencies that come along by necessity:**

- `createPromisify` + `promisify`/`startTracking`/`stopTracking`/`onAllComplete` (~40 LOC). Async props are woven through DOMRenderer (`#handleAsync`, `#isPromiseLike`) in `_handleText`, `_handleChildren`, `_handleStyle`, `applyProp`. Cutting async support means surgery on five reactive handlers; cheaper to keep the path and document it as supported. This forces the "Keep just in case → async support" item below to actually be *kept*.
- A logger of some shape (`createLogger` is ~15 LOC). The `log.ee && console.error(log.e(...))` pattern is everywhere. We can replace with `@lumenize/debug` but every call site touches it — easiest port-day-1 move is to keep `createLogger` and swap later, or replace the calls with `debug('lumenize-ui')` inline.
- Async placeholder config (`defaultPlaceholder`, `setupIndicators`, `_getPlaceholderConfig`, `#setPlaceholder`, `#setErrorState`, ~80 LOC). Required by the async path above. Could be drastically simplified — Studio's generated UIs probably want one placeholder strategy, not a per-element config tree.

### 2. Definitely cutting

- **Framework-integration files** — `juris-webcomponent.js` (398 LOC) and `juris-enhance.js` (607 LOC). Web Component wrapping and progressive enhancement of pre-existing DOM are alternate operating modes Nebula does not need.
- **`juris-cssextractor.js`** (595 LOC) and the `customCSSExtractor` hooks in DOMRenderer (`_handleStyle`, `#createElement`). Tailwind-style extraction is premature optimization for v1.
- **`juris-template.js`** (149 LOC) and `compileTemplates`/`autoCompileTemplates` in `Juris`. Studio's generated UIs are object-VDOM, not `<template data-component>` HTML — we're committing to one templating mode.
- **Most of the headless add-ons** in `headless/` and `src/headless/`. Specifically: `juris-apiclient.js` (559 LOC, overlaps with NebulaClient), `juris-fluentstate.js` (584 LOC, sugar over the must-keep primitives), `juris_hooks_library.js` (641 LOC, more sugar), `juris-asm.js` (731 LOC, niche state-machine), `json_component_factory.js` (226 LOC, server-driven UI we don't need), `docs_api.js` (312 LOC). Two are kept (see "Keep just in case" below). `juris-headless.js` (125 LOC) and the `headless`/`headlessManager`/`headlessAPIs`/`headlessComponents` configuration paths in `Juris` are kept because the surviving headless modules need them.
- **`arm()` API** (lines 2151–2208, ~60 LOC). Separate flow for binding events to `window`/`document`/external elements with the Juris context. Object-VDOM `onclick`/`oninput` covers the cases Studio cares about.
- **Hydration / SSR mode** — `#renderWithHydration`, `isHydration` state lookup, `startTracking`/`stopTracking` use during render (~50 LOC of orchestrator). Out of scope for v1 (and Studio's preview is browser-only).
- **`setTestMode` / `objectTreeAnalyzer` / `attachObjectTreeAnalyzer`** (~30 LOC) — debug-only object-tree extraction; we'll instrument differently.
- **`setupLogging` + `createLogger`'s subscribe API** in current shape — replace with `@lumenize/debug`. The internal `log.x && console.y(...)` call sites stay, just point at our logger.
- **`#detectGlobalAndWarn`** (lines 1934–1936, the global-instance warning with the mojibake'd emoji string). Pure noise.
- **Build glue at the end of `build.js`** — the `if (typeof window !== 'undefined') window.Juris = Juris` / CJS / ESM shim footers. We use proper ESM exports.
- **Dual versioning constants** (`jurisLinesOfCode`, `jurisVersion`, `jurisMinifiedSize`) plus `Object.freeze(Juris)` in the browser shim.
- **Component "lifecycle component" + "reactive render component" branches** that aren't on the critical path — `#createLifecycleComponent`, `#createReactiveRenderComponent`, `#createComponentFragment`, `#handleAsyncLifecycleRender`, `updateInstance`, `#performUpdate` (~150 LOC of `ComponentManager`). Plain function components plus `newState` cover what Studio generates. Pull these back in only if a Studio use case needs them.

### 3. Keep just in case

For each: rough size and rationale, so a future trim pass can reassess.

- **Async/promise prop support** — `#handleAsync`, `#isPromiseLike`, async-component placeholders, `_hasAsyncProps`, `#createWithAsyncProps`, `#resolveAsyncProps`, `#handleAsyncComponent`, plus `createPromisify` helpers (~250 LOC across `DOMRenderer` and `ComponentManager`). Studio-generated UIs will commonly do `text: () => fetchUserName(id)`. Cost to carry is high, but extraction is hard (intertwined with `applyProp` and the reactive handlers) — easier to keep than to reintroduce later. *Effectively keep*: the must-keep set forces it. Listed here so we know it's a substantial chunk.
- **`url-state-sync.js`** (695 LOC) and **`juris-router.js`** (696 LOC). These are nearly the same module — both register as `'router'`, both use `statePath: 'url'`, both implement hash/history/memory routing with state-keyed bindings. They look like two iterations of the same design (the `urlstatesync_documentation.md` reference reinforces this). Why we're keeping them:
  - **"View state" pattern**: the URL is the canonical view-state encoding. Larry has already written this in his own Svelte work — design principle is "copy URL, send to coworker, they get the same view (modulo permissions)." A state-keyed router is exactly the right shape: filters, tabs, modals, selected items all live as paths in the global state tree and the URL syncs automatically.
  - **Studio's first example app will need a router**, and one keyed off the same `getState`/`setState` model the rest of the framework uses is structurally simpler than wiring a third-party router into our reactivity. Worth seeing how JurisJS did it before deciding whether to port, rewrite, or replace.
  - **Resolve the duplication during the port**: pick whichever is newer / cleaner, drop the other, plus the upstream docs page (`urlstatesync_documentation.md`, 375 lines) is a useful starting reference for whatever we keep. Cost to carry: ~700 LOC, plus `juris-headless.js` (125 LOC) since headless components register through `HeadlessManager`.
- **`juris-headless.js`** (125 LOC) — the registration glue for headless components. Required *only* because we're keeping the router above; otherwise it would be a clean cut. Re-evaluate if the router decision flips.
- **Touch-tap support** (`#attachTouchSupport`, `TOUCH_CONFIG`, ~40 LOC). Mobile-friendly `onclick` (300 ms tap, move-threshold). Generated mobile UIs are plausible inside a year. Cost: trivial.
- **Component lifecycle hooks (`onMount`/`onUnmount`)** — `#hasLifecycleHooks`, `#createLifecycleComponent`, `#executeLifecycleHook` (~80 LOC). Even after cutting the bigger lifecycle/reactive-render branches above, the bare onMount/onUnmount path is small and useful for "register a NebulaClient subscription when this card mounts." Reconsider with the subscribe wiring design.
- **`subscribeExact`** (3 lines) — non-hierarchical subscribe; trivially small, occasionally what you want.
- **Async loading placeholder configuration** (`setupIndicators`, `placeholderConfigs`, `_getPlaceholderConfig`, `#setPlaceholder`, `#setErrorState`, ~80 LOC). The async path needs *some* placeholder. Whether per-element configurability earns its weight is open — flag for a v1 trim.
- **`registerHeadless` shim in context** — even without the HeadlessManager, exposing a `headless: { register, get }` no-op so Studio code that copy-pastes from JurisJS docs doesn't crash. ~10 LOC. Token cost.
- **The `juris` reference in context (`context.juris = this`)** — escape hatch. ~1 line.

### Surprises / things harder than they look

- **Component-local state already uses the global state tree.** `newState(key, initial)` writes to `##local.{compId}.{key}` and uses the same `getState`/`setState`/`subscribe`. **JurisJS already has the "synced and local state look the same" ergonomic** the must-keep list called out — it falls out of the design. The subscribe-wired form is just `newState` plus a "sync this path" middleware/config flag. Less invention required than the prose suggested.
- **The reactive-template pattern is not one method — it's five sibling code paths** (`_handleText`, `_handleStyle`, `_handleChildren`, `_handleReactiveAttribute`, plus the per-style-property handler), each doing essentially the same dance: `track(fn)` → `subscribeInternal(path, update)` for every collected dep → re-run on change. There's also a parallel set of four reactive-children flavors (single child fn, mixed array, fragment, fragment child). The pattern is conceptually small but the implementation is wide. The port can normalize them — but not for free.
- **Async support is interleaved with the reactive path.** Cutting async cleanly is hard; the must-keep reactive handlers each branch on `#isPromiseLike` and call into `#handleAsync` / `promisify`. The async track effectively comes along with the reactive track.
- **MutationObserver-based auto-cleanup is load-bearing.** Without it (or an equivalent on each component instance), every reactive slot leaks subscribers when its element is removed. The current implementation walks `document.body` once at startup. That's fine in the browser; if we ever want to render into a Shadow DOM root, it needs revisiting.
- **Privacy markers are inconsistent in JurisJS** — both `_underscore` ("kinda private, accessed across classes") and `#hash` (true private). CLAUDE.md prescribes `#` for our codebase; the port will normalize, but cross-class access (e.g., `juris.domRenderer._handleChildren(...)` is called from outside DOMRenderer) means some methods that look private have to stay public. Worth a tagging pass during the port.
- **Estimated post-port size**: dropping enhance, webcomponent, cssextractor, template, headless, and the cuts above takes us from ~2,227 LOC + ~1,900 LOC of optional modules down to roughly ~1,400–1,600 LOC of core, before any normalization. Comfortably tractable for a single MIT package.

### Out-of-scope notes for the inventory

This list is the *port's scope*, not the v1 surface area. Public API design (what `@lumenize/ui` actually exports) happens during the port, informed by Phase 5.3's subscribe wiring decisions and Studio's generated-UI shape. The inventory just settles "which JurisJS code crosses the river."

## Subscribe wiring (the headline integration)

This wiring lives at the NebulaClient ↔ `@lumenize/state` boundary, NOT at the UI layer. It works the same whether the UI is ObjectDOM or vanilla HTML+JS.

- A piece of state declared synced (via a config flag or path convention — TBD during 5.3.6) wires up automatically to a NebulaClient subscription on the named resource.
- Reads (`getState`) return the latest known value. Writes (`setState`) optimistically update the local store, push via NebulaClient, then reconcile on the server's eTag-confirmed snapshot.
- BroadcastChannel semantics from Phase 5.3 (own messages not echoed) flow through to subscribers naturally.

## Avoiding UI Flicker on Resource Updates

Lumenize Mesh returns a full `Snapshot<T>` (with `value` and `meta`) on every read and subscribe — the framework performs no conditional checking on the read/subscribe path. `meta.eTag` is included so callers can use it for subsequent upserts, but reads always return the full snapshot.

The UI layer is responsible for avoiding unnecessary re-renders when the incoming value hasn't actually changed. Two approaches:

1. **Local eTag comparison** — compare `snapshot.meta.eTag` against the last-seen eTag before updating the DOM. If they match, skip the update.
2. **Deep object change detection** — compare `snapshot.value` against the current value before updating.

Either prevents flicker when a subscribe handler fires but the value is unchanged (e.g., after reconnection replay).

## Out of scope (for v1)

- React/Svelte/Vue interop layers.
- Server-side rendering.
- Anything that requires a build step for the generated UIs (Studio outputs HTML+JS, not TSX).

## Notes

- Both `@lumenize/state` and `@lumenize/ui` are MIT-licensed and live in the Lumenize monorepo alongside the other MIT packages.
- Auto-refresh-on-version-change is a Studio concern (`tasks/nebula-studio.md`); the hook for it can live in `@lumenize/state` as a middleware. Defer the surface design until the Studio preview mechanism is sketched.
- This file covers both packages — there's no separate `lumenize-state.md`. If/when the renderer port begins, we may split this file too; for now, keeping them together emphasizes that they're one coordinated decision.

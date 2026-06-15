---
title: Using @lumenize/nebula/frontend with Vue
description: How the factory + Vue fit together — the minimal single-file shape, the debounce knobs, and why production deploys pre-compile templates for a strict CSP.
---

# Using `@lumenize/nebula/frontend` with Vue

`createNebulaClient` is a thin reactive bridge: it wraps a `NebulaClient` and returns a Vue-reactive `store` plus the `client` and a `ready` promise. Your components read and write `store.resources.*` like any reactive object; the factory handles auto-subscribe, optimistic writes, debouncing, and conflict resolution. The full surface is in [API reference § createNebulaClient](./api-reference.md#createnebulaclient); this page is about *setup* — how Vue is loaded and compiled, and the knobs that affect write timing.

In Nebula Studio you don't hand-write any of the shell below — Studio generates the bootstrap (`nebula.ts`), the Vue entry, and the `index.html`, and compiles your `.vue` single-file components for you (see [Security: CSP and template compilation](#security-csp-and-template-compilation)). The single-file shape here is for understanding the moving parts and for non-Studio/standalone use.

## The minimal single-file shape

The smallest thing that runs: load Vue, create the factory, mount an app whose template reads the store. Vue is loaded from a CDN; the `@lumenize/nebula/frontend` factory is served from your Nebula deployment (the `/frontend` subpath — it is not on a public CDN, since Nebula packages ship with your Star).

```html @skip-check
<!doctype html>
<div id="app">
  <template v-if="store.resources.todo[id]?.value">
    <input v-model="store.resources.todo[id].value.title" />
  </template>
</div>

<script type="importmap">
{
  "imports": {
    "vue": "https://unpkg.com/vue@3/dist/vue.esm-browser.js",
    "@lumenize/nebula/frontend": "/frontend/index.js"
  }
}
</script>

<script type="module">
  import { createApp } from 'vue';
  import { createNebulaClient } from '@lumenize/nebula/frontend';

  const { client, store, ready } = createNebulaClient({ appVersion: 'v1' });
  await ready;  // first connection complete → client.claims populated

  createApp({ setup: () => ({ store, id: 'todo-1' }) }).mount('#app');
</script>
```

`createNebulaClient({ appVersion: 'v1' })` is the whole config in a deployed browser session: `baseUrl`, `activeScope`, and `onShouldRefreshUI` auto-detect from the environment (`authScope` is currently required-in-practice — see the [config table](./api-reference.md#createnebulaclient)). `appVersion` is the one field Studio substitutes at deploy time.

This single-file shape uses **in-DOM templates** — the `v-model` markup lives in the HTML and is compiled in the browser by Vue's runtime compiler. That's the convenient path for a quick page, but it has a CSP cost (below) that production deploys avoid.

## Debounce knobs

`v-model` updates paint optimistically on every keystroke, but the network transaction is **debounced** per `(resourceType, resourceId)` — default **500 ms** quiet window, **2000 ms** max wait. A buffered write also flushes immediately on input blur and on `client.dispose()`. See [Coding your UI § Write timing](./coding-your-ui.md#write-timing) for the behavior and [Coding your UI § IME and composition input](./coding-your-ui.md#ime-and-composition-input) for how composition input interacts with it.

You rarely set timing in code — it's **type-derived** from the ontology (`@debounce`, `@longform`; booleans/enums commit eagerly). That table is canonical in [Ontology § Annotations](./ontology.md#annotations). For the occasional runtime override (A/B testing, dynamic config), there's a per-type setter:

```typescript @skip-check
// Override the debounce profile for one resource type at runtime.
client.resources.transactionDebounce('note', { quietMs: 1000, maxWaitMs: 5000 });
```

See [API reference § resources.transactionDebounce](./api-reference.md#resourcestransactiondebounce).

## Security: CSP and template compilation

Vue templates have to be compiled to render functions somewhere. **Where** that happens decides whether you can ship a strict Content-Security-Policy.

- **In-DOM / CDN mode (the single-file shape above):** templates are strings compiled in the browser by Vue's *runtime compiler*. Compiling a template string is `new Function(...)` under the hood, so the page needs CSP `script-src 'unsafe-eval'`. Fine for a prototype; not what you want for a deployed app.

- **Studio production mode (what deployed apps use):** you author `.vue` **single-file components**, and the templates are compiled to render functions **server-side, ahead of time** — per-save in your user-local dev Star while you iterate, and at deploy time in the Galaxy. The browser receives only the **runtime-only** Vue build (~22 KB gzip) with no compiler, plus already-compiled render functions. No template string is ever compiled in the browser, so there's no `new Function`, so the app runs under a **strict CSP with no `'unsafe-eval'`**.

This is why Studio compiles for you rather than shipping in-DOM templates: the SFC-compiled path is the one that's secure by default. The server-side compile placement is fixed (dev Star for iteration, Galaxy for deploys); wiring the Galaxy-side production compile is part of Studio's deploy pipeline, not something app code calls.

:::note[Tag case in compiled vs in-DOM templates]

In an in-DOM template (markup the browser parses), component tags must be **kebab-case** (`<tree-node>`) — the HTML parser lowercases tag names before Vue sees them. Inside `.vue` SFC templates (parsed by Vue's compiler, not the browser), PascalCase (`<TreeNode>`) works. If you're hand-writing the single-file shape, prefer kebab-case.

:::

---
title: Coding your UI
description: How to build a Nebula front end with Vue 3 SFCs and TypeScript — store reads and writes, auto-subscribe, conflict resolution, recursive components.
---

# Coding your UI

A Nebula front end is Vue 3 Single-File Components (SFCs) written in TypeScript, styled with DaisyUI, rendering resources whose shape you defined in your ontology (a TypeScript `.d.ts`-style file). The framework handles subscribes, transactions, and conflicts.

This page is the narrative reference Nebula Studio's hosted LLM consults when generating UI code in dialog with a user-developer — naming, defaults, and example shape are tuned for that LLM-as-reader audience. For exact signatures see [api-reference.md](./api-reference.md). For the resource data model (addressing, eTags, transactions, conflict resolution) see [Resources](./resources.md). This page is "how to wire it together"; those pages are the contract.

## The three pieces

A Nebula front end has three layers:

1. **Vue 3 SFCs** — `.vue` files with `<script setup lang="ts">`, `<template>`, and optional `<style scoped>`. Studio compiles them to render-function modules on every save (locally during iteration; at deploy time for production assets). The browser only ever loads pre-compiled JS — no in-DOM compiler, no `'unsafe-eval'` CSP needed.
2. **The store** — a Vue-reactive Proxy that your `v-*` directives bind to. Reads under `store.resources.*` auto-subscribe to the resources they touch; writes flow through optimistic apply + debounced server submission. The whole reactive UI surface lives here.
3. **`NebulaClient`** — the underlying connection between your front end and the back end. Used directly for operations that don't fit "read or write a single field" — explicit multi-resource transactions, conflict-resolver registration, programmatic subscribes, ad-hoc reads.

`createNebulaClient(config)` is your single bootstrap call. It instantiates the client, wraps it in the store, and returns both.

## Bootstrap (three files)

A minimal Nebula front end is three files plus an `index.html` shell with a `<div id="app"></div>` mount point (Studio generates the shell for you).

```typescript @skip-check
// store.ts — initialize the client + store once. Any component that needs
// either of these imports them from here; no need to thread them through props.
import { createNebulaClient } from '@lumenize/nebula-frontend';

export const { client, store } = createNebulaClient({
  baseUrl: 'https://my-app.example.com',
  authScope: 'acme.app.tenant-a',     // refresh-cookie path
  activeScope: 'acme.app.tenant-a',   // baked into JWT `aud` claim
  appVersion: 'dev',                  // Studio substitutes the real version at deploy time
  onShouldRefreshUI: () => window.location.reload(),
});

// Per-type conflict resolvers and terminal-outcome reactions go here too —
// see "Forms: explicit save" and "Atomic append" below for examples.
```

```typescript @skip-check
// main.ts — Vue entrypoint. The side-effect import on './store' instantiates
// the NebulaClient before the app mounts, which matters because `createNebulaClient`
// must be called BEFORE the WebSocket connects so its `onConnectionStateChange`
// listener captures the initial connecting → connected transition.
import { createApp } from 'vue';
import App from './App.vue';
import './store';

createApp(App).mount('#app');
```

```vue @skip-check
<!-- App.vue — the root component. Sub-components import `store` (and `client`
     if they need it) the same way; no need to thread them through props. -->
<script setup lang="ts">
import { store } from './store';
</script>

<template>
  <main>
    <!-- Your markup here. -->
  </main>
</template>
```

See [NebulaClient](./nebula-client.md) for the full constructor options, auth model, and lifecycle.

## Resources at a glance

**Resources are the heart of this system. They are both simple and powerful. You use them when developing your app in Nebula Studio. Your users use them when they interact with your app because they are the only place for them to store anything.**

Each resource is a JavaScript object addressed by a `(resourceType, resourceId)` pair, with its shape declared in your ontology. From your UI's perspective:

- `store.resources.<resourceType>[<resourceId>].value` — the resource's current value.
- `store.resources.<resourceType>[<resourceId>].meta` — server-managed metadata (`eTag`, change metadata, etc.).

Reads inside a Vue component auto-subscribe to the resources they touch. Writes flow through optimistic local apply + a server transaction (eTag-based, with per-type conflict resolution and idempotency). The full resource model — addressing, optimistic concurrency, the per-type handler, transaction outcomes — is documented in [Resources](./resources.md).

## Reading and writing through the store

Read and write the store inline in templates using stock Vue syntax. Auto-subscribe on read and debounced server submission on write are invisible. The framework ships [Vue 3](https://vuejs.org/) — the full directive vocabulary (`v-bind`, `v-on`, `v-if`/`v-else-if`/`v-else`, `v-for`, `v-show`, `v-model`, etc.) and event modifiers (`.stop`, `.prevent`, `.enter`, etc.) are all available. One Nebula-specific addition, `v-model.eager`, is covered below in [Write timing](#write-timing-debouncing-lazy-and-eager).

```html @skip-check
<!-- The `?.` guards against the snapshot not having arrived yet. Auto-subscribes on first read. -->
<h2>{{ store.resources.todo[id]?.value?.title ?? 'Loading…' }}</h2>

<!-- :class object syntax (shorthand for v-bind:class) toggles a class on a reactive value. -->
<li :class="{ 'line-through': store.resources.todo[id]?.value?.done }">
  <!-- v-model: each keystroke optimistically updates the store and queues a debounced transaction. -->
  <input v-model="store.resources.todo[id].value.title" />
</li>

<span v-if="store.resources.todo[id]?.value?.done" class="badge badge-success">Done</span>
<span v-else class="badge">Open</span>
```

The same paths work from TypeScript — inside a `computed`, a method, or an event handler:

```typescript @skip-check
const title = store.resources.todo[id]?.value?.title;          // reactive read
store.resources.todo[id].value.title = 'New title';            // optimistic write + debounced transaction
```

For multi-resource atomic batches, explicit conflict-resolution handlers, programmatic subscriptions, and other operations that don't fit "read or write a single field," use the underlying `client` directly — the canonical case is [Forms: explicit save](#forms-explicit-save) below.

### `v-model` requires a real l-value path

Optional chaining (`?.`) isn't allowed in a `v-model` expression. Guard the input with `v-if` so it only mounts after the snapshot lands:

```html @skip-check
<template v-if="store.resources.todo[id]?.value">
  <input v-model="store.resources.todo[id].value.title" />
</template>
<span v-else>Loading…</span>
```

## Write timing: debouncing, `.lazy`, and `.eager`

By default `v-model` listens on `input` (fires every keystroke). The optimistic local update is immediate; the network transaction is **debounced** by the synced-state middleware so per-keystroke `v-model` doesn't pile up server traffic.

The middleware coalesces transaction submissions per `(resourceType, resourceId)`:

- **Quiet window**: 500 ms. After the last write to a resource, wait 500 ms with no further writes, then submit.
- **Max wait**: 2 s. If the user keeps writing forever, submit at least every 2 s regardless.
- **Flush on lifecycle**: pending writes flush on component unmount, input blur, and `client.dispose()`.
- **Serial per resource**: at most one transaction in flight per resource; subsequent writes buffer and submit using the in-flight transaction's resulting eTag.

A typical 10-character edit in a text input produces ~1 transaction, not 10.

:::caution Text fields need a custom merge handler
Debouncing reduces but doesn't eliminate the "another client wrote while I was typing" race. With the framework's default `'use-server'` resolution, an in-flight conflict will yank the user's mid-keystroke text back to the server's value. For any field a user types into (long-form text, comments, document bodies), register a per-type handler with a real text-merge function — see [Resources § Text fields specifically — don't leave the default](./resources.md#text-fields-specifically--dont-leave-the-default).
:::

### Per-type tuning

```typescript @skip-check
// Slower defaults for, e.g., a long-text field where you want fewer round-trips.
client.resources.transactionDebounce('todo', { quietMs: 1000, maxWaitMs: 5000 });
```

### `v-model.lazy` — commit on blur

```html @skip-check
<!-- Listen on `change` instead of `input`: text input fires on blur, select on
     commit. Use when "I'm done editing this field" matches better than
     "live update on every keystroke" — typically when the field has expensive
     downstream effects, or "drop my edit by clearing it before blurring" is
     a real UX flow. -->
<input v-model.lazy="store.resources.todo[id].value.title" />
```

### `v-model.eager` — bypass debouncing entirely

```html @skip-check
<!-- Submit the transaction on the next microtask after the change event,
     skipping the quiet window. Use for clicks-to-commit interactions
     (dropdowns, checkboxes, radios) where waiting 500 ms feels wrong. -->
<select v-model.eager="store.resources.task[id].value.status">
  <option value="open">Open</option>
  <option value="done">Done</option>
</select>
```

`v-model.eager` is a custom modifier shipped by `@lumenize/nebula-frontend`. Optimistic apply, eTag generation, and conflict-resolver wiring all still apply — only the debounce delay is bypassed.

## Loading and first paint

A resource's `?.value` is `undefined` until the initial server push lands (typically tens of ms; longer on cold connect). Three patterns:

```html @skip-check
<!-- 1. Inline placeholder via ?? — simplest; works for any one-way text binding. -->
<span>{{ store.resources.todo['task-42']?.value?.title ?? 'Loading…' }}</span>

<!-- 2. Skeleton loader — v-if on `value` swaps branches atomically once the snapshot arrives. -->
<div v-if="store.resources.todo['task-42']?.value" class="card">
  <h2>{{ store.resources.todo['task-42'].value.title }}</h2>
</div>
<div v-else class="card skeleton"></div>
```

A deleted-server-side resource also produces a falsy `value`. To distinguish "loading" from "deleted", check `?.meta?.deleted` (true for tombstones, undefined for never-loaded), or compose snapshot + connection state into a `computed`:

```typescript @skip-check
import { computed } from 'vue';

// Return from setup(); branch with v-if / v-else-if / v-else in the template.
const todoStatus = computed(() => {
  const snap = store.resources.todo['task-42'];
  if (!store.lmz.connection.lastConnectedAt) return 'connecting';
  if (snap?.meta?.deleted)                   return 'deleted';
  if (!snap?.value)                          return 'loading';
  return 'ready';
});
```

## Connection state

The factory mirrors `NebulaClient`'s connection state to three reserved paths under `lmz.connection.*`. UI binds declaratively; no event listeners. Initial seeds (`'disconnected'` / `false` / `undefined`) mean first-paint reads never need `?.` guards.

| Path | Type | Description |
| --- | --- | --- |
| `lmz.connection.state` | `'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'` | Current state. |
| `lmz.connection.connected` | `boolean` | `true` iff `state === 'connected'`. |
| `lmz.connection.lastConnectedAt` | `number \| undefined` | `Date.now()` from the most recent `'connected'` transition. |

```html @skip-check
<!-- Banner while disconnected. Optimistic writes still queue in the background. -->
<div v-if="!store.lmz.connection.connected" class="alert alert-warning">
  Disconnected — your changes are queued. Reconnecting…
</div>

<!-- Disable a button while not connected. -->
<button :disabled="!store.lmz.connection.connected" class="btn btn-primary" @click="save">Save</button>
```

For richer status UI (color-coded badges, "last connected X minutes ago" tooltips), use `:class` object syntax against `lmz.connection.state` and format `lmz.connection.lastConnectedAt` with `new Date(...)`.

## Auto-subscribe and component scope

Auto-subscribe is driven by Vue's reactivity, not a `MutationObserver`. The store's path-aware Proxy intercepts every read; when a read happens inside a component's `setup()` or render function, the proxy reaches the active Vue scope via `getCurrentInstance()?.scope` and refcounts the `(resourceType, resourceId)` pair.

- **0 → 1 refcount.** Fires `client.resources.subscribe(resourceType, resourceId)` — fire-and-forget. The snapshot arrives later via the server's fanout push, which writes through to the store and triggers Vue's normal reactivity to re-render.
- **Refcount-with-grace on unmount.** When the component unmounts, its `effectScope` disposes; the registered `onScopeDispose` callback decrements the refcount. The 1 → 0 transition does NOT immediately unsubscribe — it schedules `client.resources.unsubscribe(resourceType, resourceId)` after a 2-second grace period (configurable via `createNebulaClient({ unsubscribeGraceMs: ... })`). A new subscribe inside the window (tab-switch back, modal close-then-reopen, `<KeepAlive>` swap) cancels the pending unsubscribe — server-side subscription stays live, no re-subscribe RTT.
- **Dedup within a scope.** Multiple reads of the same `(resourceType, resourceId)` in one component (e.g., `:title` and `:body` interpolations on the same resource) count as one refcount entry. The first read registers; subsequent reads are no-ops at the refcount layer.

You never call `subscribe` / `unsubscribe` directly for routine UI; the lifecycle is bound to Vue component lifetimes.

For explicit-control cases (warming a cache before navigation, scripting, headless tests), `client.resources.subscribe(rt, rid)` is still available — see [api-reference.md § resources.subscribe](./api-reference.md#resourcessubscribe). Explicit subscribes don't refcount; they hold the subscription until you explicitly `unsubscribe`.

## Per-component local state

For state that's local to one UI element (open/closed, draft text, current tab, etc.) — anything that isn't synced — use Vue's native `ref` / `reactive` inside `<script setup>`:

```vue @skip-check
<!-- Card.vue — per-instance `expanded` flag. Each <Card> renders with its
     own independent state automatically; no instanceKey plumbing needed. -->
<script setup lang="ts">
import { ref } from 'vue';

const expanded = ref(false);
</script>

<template>
  <div>
    <button class="btn btn-sm" @click="expanded = !expanded">
      {{ expanded ? 'Hide' : 'Show' }}
    </button>
    <div v-if="expanded">...content...</div>
  </div>
</template>
```

For non-synced state that must be shared across components (a search query in a header consumed by a list elsewhere, a current-view selector, etc.), put it under a non-reserved prefix on the store — typically `store.ui.*` (transient UI state) or `store.app.*` (app-wide local state). The framework only auto-syncs writes under `resources.*`; everything else is yours.

The factory does NOT auto-vivify intermediate objects under non-reserved prefixes. `v-model="store.ui.todoForm.draft.title"` requires `store.ui.todoForm.draft` to already exist as an object — otherwise the read side of `v-model` throws (you can't optional-chain in a `v-model` l-value). Initialize the shape you bind to either in `store.ts` at module load or in an `onMounted` hook on the component that owns the field, as shown in the [Forms: explicit save](#forms-explicit-save) and [Worked example](#worked-example-dag-tree-with-virtual-branches) sections.


## Lists with `v-for`

The interesting Nebula cases for `v-for` are the **foreign-key pattern** (each iteration auto-subscribes to a different resource) and **container resources** (a well-known resource holding an array of IDs).

```html @skip-check
<!-- Foreign keys: each read of store.resources.todo[subtaskId] inside the loop
     auto-subscribes that (todo, subtaskId) pair. Removing an ID unmounts the
     <div>, decrements the refcount, and (after the 2 s grace period) unsubscribes. -->
<div
  v-for="subtaskId in store.resources.todo['task-42']?.value?.subtaskIds ?? []"
  :key="subtaskId"
>
  <h3>{{ store.resources.todo[subtaskId]?.value?.title ?? '...' }}</h3>
</div>
```

Inline arrays of embedded objects (e.g., `assignees`) iterate the same way without auto-subscribing per item — the embedded object's fields are right there. Nested loops nest naturally; inner-loop variables shadow outer ones if names collide.

### Root-level collections via a container resource

For "show me all the todos" — a list that doesn't hang off a parent resource — use a **container resource** whose value holds an array of IDs. The container (e.g., `('todoList', 'main')`) is created once per tenant during setup.

```typescript @skip-check
// Ontology (.d.ts-style file)
interface TodoList { items: string[] }                // IDs of Todo resources
interface Todo     { title: string; done: boolean }
```

```html @skip-check
<!-- Subscribes to the container; each iteration subscribes to its todo. -->
<ul>
  <li v-for="todoId in store.resources.todoList['main']?.value?.items ?? []" :key="todoId">
    <input type="checkbox" v-model="store.resources.todo[todoId].value.done" />
    {{ store.resources.todo[todoId]?.value?.title ?? '...' }}
  </li>
</ul>
```

This works up to ~hundreds of items. Beyond that, a query language is the right tool — deferred for now.

### Atomic append — adding to a collection

Creating a new resource and adding its ID to a container happens in **one transaction**, so neither orphan-todo nor dangling-reference state ever exists. For the "two users added at the same time" race, register a handler on the list type that returns `'use-this'` with a set-union of `items` — see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler).

```typescript @skip-check
async function addTodo(title: string) {
  const newId = crypto.randomUUID();
  const list     = store.resources.todoList['main']?.value;
  const listETag = store.resources.todoList['main']?.meta?.eTag;

  // Both ops in one call → atomic. Either both commit or neither does.
  const outcome = await client.resources.transaction({
    [newId]: { op: 'create', nodeId: list.nodeId, typeName: 'todo',
               value: { title, done: false } },
    'main':  { op: 'put',    eTag: listETag,
               value: { ...list, items: [...list.items, newId] } },
  });

  // Top-level switch handles ONLY transaction-wide failures
  // (infrastructure-error / timeout / ontology-stale). Per-resource outcomes
  // (use-server, validation-failed, etc.) go to the per-type handler.
  if (outcome.kind !== 'ok') store.ui.addError = outcome;
}
```

## Conditionals with `v-if`

Standard Vue. Subscriptions inside an unmounted branch don't fire — auto-subscribe only kicks in when a component actually reads from the store.

```html @skip-check
<span v-if="store.resources.todo['task-42']?.value?.done" class="badge badge-success">Done</span>
<button v-else @click="markDone">Mark done</button>
```

Don't put `v-for` and `v-if` on the same element — nest instead (`<template v-for>` outside, `<li v-if>` inside). For conditions reused across multiple sites or substantial enough to warrant testing, lift into a `computed`:

```typescript @skip-check
import { computed } from 'vue';
const isOpen = computed(() => store.resources.todo['task-42']?.value?.status === 'open');
```

## Read-only and editable views of the same field

The same store path can appear as both text and an input — they stay in sync through Vue's reactivity. Two patterns:

```html @skip-check
<!-- Side-by-side: heading + input both bound to the same path. Live-preview UIs. -->
<div v-if="store.resources.todo['task-42']?.value" class="card">
  <h2>{{ store.resources.todo['task-42'].value.title }}</h2>
  <input v-model="store.resources.todo['task-42'].value.title" aria-label="Edit title" />
</div>

<!-- Click-to-edit: swap on focus. `store.ui.editingTitle` is local-only —
     under `ui.*` (not `resources.*`) so the synced-state middleware ignores it. -->
<div v-if="store.resources.todo['task-42']?.value" class="card">
  <h2 v-if="!store.ui.editingTitle" @click="store.ui.editingTitle = true">
    {{ store.resources.todo['task-42'].value.title }}
  </h2>
  <input v-else v-model="store.resources.todo['task-42'].value.title"
         @blur="store.ui.editingTitle = false" />
</div>
```

### Forms: explicit save

For multi-field forms that should commit together (rather than per-keystroke transactions), bind inputs to a local draft path and submit on click. Each form keeps its draft under its own `store.ui.<formName>.draft` path. The per-type handler clears the draft on commit and surfaces per-resource problems — register once in `store.ts`. (For the full set of resolution branches and how each affects the draft, see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler).)

```typescript @skip-check
// store.ts (alongside the createNebulaClient call)
client.resources.onTransactionResourceResolution('todo', (rid, resolution) => {
  switch (resolution.kind) {
    case 'committed':         store.ui.todoForm.draft = undefined; break;
    case 'validation-failed': store.ui.todoForm.validationErrors = resolution.errors; break;
    case 'permission-denied': store.ui.todoForm.saveError = { kind: 'permission-denied', rid }; break;
    // 'use-server' / 'retries-exhausted' fall to the framework's default red-flash.
  }
});
```

```vue @skip-check
<!-- TodoForm.vue — local draft → explicit transaction on submit. -->
<script setup lang="ts">
import { onMounted } from 'vue';
import { store, client } from './store';

// Init the draft on first mount. Both store.ui.todoForm and .draft must exist
// as objects before v-model can bind nested fields (the factory does NOT
// auto-vivify intermediate objects under non-reserved prefixes).
onMounted(() => {
  if (!store.ui.todoForm) store.ui.todoForm = {};
  store.ui.todoForm.draft = { ...(store.resources.todo['task-42']?.value
    ?? { title: '', description: '', status: 'open' }) };
});

async function saveTodo() {
  const outcome = await client.resources.transaction({
    'task-42': {
      op: 'put',
      eTag: store.resources.todo['task-42']?.meta?.eTag,
      value: store.ui.todoForm.draft,
    },
  });
  // Per-resource outcomes (validation-failed, etc.) go to the per-type handler.
  // await-site handles ONLY transaction-wide failures.
  if (outcome.kind !== 'ok') store.ui.todoForm.saveError = outcome;
}
</script>

<template>
  <form v-if="store.ui.todoForm?.draft" @submit.prevent="saveTodo">
    <input v-model="store.ui.todoForm.draft.title" />
    <textarea v-model="store.ui.todoForm.draft.description"></textarea>
    <select v-model="store.ui.todoForm.draft.status">
      <option value="open">Open</option>
      <option value="done">Done</option>
    </select>
    <button type="submit">Save</button>
  </form>
</template>
```

Rule of thumb: `store.resources.*` for per-keystroke (debounced) writes; `store.ui.<formName>.*` for staged writes that the user explicitly commits. For multiple concurrent forms, use distinct form names (`store.ui.projectForm.draft`, etc.).

## Recursive components

Vue SFCs recurse natively — a component references itself in its own template by file-stem name (or by an explicit `name` declared in the script). Each instance auto-subscribes to its own resource, and unmounting decrements the refcount.

```vue @skip-check
<!-- TreeNode.vue -->
<script setup lang="ts">
import { store } from './store';

defineProps<{ nodeId: string }>();
</script>

<template>
  <span>{{ store.resources.treeNode[nodeId]?.value?.label ?? '...' }}</span>
  <ul v-if="(store.resources.treeNode[nodeId]?.value?.childIds?.length ?? 0) > 0">
    <!-- `childIds` is an array of node IDs (foreign-key pattern from "Lists"
         above). Each recursive <TreeNode> auto-subscribes to its own resource
         via store.resources.treeNode[childId]. -->
    <li
      v-for="childId in store.resources.treeNode[nodeId].value.childIds"
      :key="childId"
    >
      <TreeNode :node-id="childId" />
    </li>
  </ul>
</template>
```

```vue @skip-check
<!-- App.vue — mount the recursive tree at a known root id. -->
<script setup lang="ts">
import TreeNode from './TreeNode.vue';

const rootId = '1';   // root resource id; subscribed via the first read inside TreeNode
</script>

<template>
  <TreeNode :node-id="rootId" />
</template>
```

Per-instance state (expand/collapse, draft text, etc.) lives in each component's `<script setup>` as plain `ref` / `reactive` — Vue handles "independent state at each rendering position" natively.

## Worked example: rendering the built-in DAG tree

**Every Nebula app receives the same built-in DAG** — the tree of nodes that resources are attached to for permissions and tenancy. Every connected client gets the full tree at `store.resources.lmz.dag.value` (visibility is intentionally not restricted — the sub-second-RTT permission UX wants every client to know the full shape so it can grey out inaccessible nodes locally). Most apps will surface it somewhere in their UI; rendering it as a tree view is the most common form (others: a flat list of accessible nodes, a breadcrumb selector for the current scope, a permission-grant dialog).

A pre-built `<NebulaDagTree>` component will likely ship from `@lumenize/nebula-frontend` for the default tree-view case. The from-scratch example below is useful regardless: it's the right starting point when the pre-built doesn't fit your UX, AND it's the blueprint for what the framework-shipped component does internally.

The example pulls together: a single subscribe to the framework-reserved DAG resource, walking the embedded `Map<number, ...>` in a `computed`, recursive Vue components, per-instance state, and `provide` / `inject` to broadcast a derived signal down the tree. It includes multi-parent rendering, virtual "Deleted" / "Orphaned" branches, and search with match highlighting + auto-expand of ancestors of matches.

### The DAG resource shape

`store.resources.lmz.dag.value` is a `DagTreeState`:

```typescript @skip-check
// Imported from '@lumenize/nebula/client'.
interface DagTreeState {
  nodes: Map<number, {
    slug: string;
    label: string;
    deleted: boolean;
    parentIds: number[];      // foreign-key edges to parent node integers
    childIds:  number[];
  }>;
  permissions: Map<number, Map<string, 'admin' | 'write' | 'read'>>;
}
```

Subscribing to `('lmz', 'dag')` once seeds the value; subsequent server-side mutations fan out a fresh snapshot through the same `handleResourceUpdate` path as any other resource.

The framework reserves the `lmz` resourceType for its own resources (mirrors the `lmz.*` reserved prefix used for non-resource paths like `lmz.connection.*` — anything under `lmz` in either reserved namespace is framework territory).

> **Implementation status (2026-05-15):** the `('lmz', 'dag')` binding is the pinned design but the server-side `DagTree.#onChanged` → `Star.#fanout` rewire is not yet wired up. Tracked in [tasks/nebula-frontend.md § DAG-tree-as-special-resource](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-frontend.md). Wire-format on mutation (full snapshot vs. eTag-bump-and-pull vs. op-broadcast) is also still open; the client-facing API in this section doesn't depend on which server option is picked.

**Multi-parent rendering**: a node with parents `[A, B]` renders once under each. The derivation walks every parent edge; each rendered position is its own `TreeNode` instance with independent per-instance state automatically.

**Virtual branches**: `__deleted__` and `__orphaned__` are IDs in the derived `TreeNodeData` tree. The slug regex (`^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$`) rejects underscores, so these IDs can't collide with anything a user could create. Real DAG nodes have integer `nodeId`; the derived `TreeNodeData.id` is a string — `String(nodeId)` for real nodes, `__virtual__` strings for virtual branches.

### Derivation helpers (`tree.ts`)

```typescript @skip-check
// tree.ts — shape + derivation helpers used by App.vue and TreeNode.vue.
import { ROOT_NODE_ID, type DagTreeState } from '@lumenize/nebula/client';

export interface TreeNodeData {
  id: string;                                       // String(nodeId) for real nodes; '__deleted__' / '__orphaned__' for virtuals
  label: string;
  labelRuns?: { text: string; match: boolean }[];   // populated when query is non-empty
  deleted?: boolean;
  children: TreeNodeData[];
}

// Walks from ROOT_NODE_ID through `dag.nodes`, rendering a node under each of
// its parents. Skips deleted nodes during the main walk; collects them into a
// __deleted__ subtree. Computes orphaned (nodes not reachable from root via
// undeleted edges) into __orphaned__. When `query` is non-empty, splits each
// label into labelRuns = [{text, match: boolean}, ...] so the template can
// render match highlighting safely without v-html.
export function deriveTreeWithVirtuals(
  dag: DagTreeState,
  query: string,
): TreeNodeData {
  // Reads dag.nodes.get(ROOT_NODE_ID), then recursively follows childIds
  // through dag.nodes.get(childId) for each. Map.get(...) is O(1).
  return { /* root TreeNodeData */ } as TreeNodeData;
}

// For each node whose labelRuns contains a match, adds every id in `ancestors`
// to `ids`, then recurses into children with this node's id appended to
// `ancestors`.
export function walkAndCollectAncestorsOfMatches(
  tree: TreeNodeData,
  ancestors: string[],
  ids: Set<string>,
): void {
  // ...
}
```

### Component (`TreeNode.vue`)

```vue @skip-check
<!-- TreeNode.vue — recursive tree row + child list. -->
<script setup lang="ts">
import { ref, inject, watch, type Ref } from 'vue';
import type { TreeNodeData } from './tree';

// Capture the props object so script-side code can read `props.node.id`
// (defineProps<...>() without a binding only exposes props in the template).
const props = defineProps<{ node: TreeNodeData }>();

// Per-instance state: each TreeNode instance has its own isOpen.
const isOpen = ref(false);
const toggleOpen = () => { isOpen.value = !isOpen.value; };

// App.vue provides a reactive set of ids to auto-expand on search match.
// When our id appears in the set, flip isOpen to true.
const expansionsForQuery = inject<Ref<Set<string>>>('expansionsForQuery');
watch(
  () => expansionsForQuery?.value,
  (set) => { if (set?.has(props.node.id)) isOpen.value = true; },
  { immediate: true },
);
</script>

<template>
  <li>
    <button v-show="node.children.length" @click="toggleOpen">
      {{ isOpen ? '▼' : '▶' }}
    </button>

    <!-- Plain label when not searching; highlighted runs when query is active. -->
    <span v-if="!node.labelRuns">{{ node.label }}</span>
    <span v-else>
      <span v-for="(run, i) in node.labelRuns" :key="i"
            :class="{ 'bg-warning': run.match }">{{ run.text }}</span>
    </span>

    <!-- Recursion: each child gets its own TreeNode instance with its own isOpen. -->
    <ul v-if="isOpen">
      <TreeNode v-for="child in node.children" :key="child.id" :node="child" />
    </ul>
  </li>
</template>
```

### Root component (`App.vue`)

```vue @skip-check
<!-- App.vue — search input + tree derivation + provide auto-expand set. -->
<script setup lang="ts">
import { computed, provide, onMounted } from 'vue';
import type { DagTreeState } from '@lumenize/nebula/client';
import { store } from './store';
import TreeNode from './TreeNode.vue';
import { deriveTreeWithVirtuals, walkAndCollectAncestorsOfMatches,
  type TreeNodeData } from './tree';

onMounted(() => { if (!store.ui.search) store.ui.search = { query: '' }; });

// First read of store.resources.lmz.dag triggers auto-subscribe to ('lmz', 'dag').
// Re-runs when the server pushes a new DagTreeState or the query changes.
// Vue 3's reactivity tracks Map.get / Map iteration natively.
const tree = computed<TreeNodeData | null>(() => {
  const dag = store.resources.lmz?.dag?.value as DagTreeState | undefined;
  if (!dag) return null;
  return deriveTreeWithVirtuals(dag, (store.ui.search?.query ?? '').toLowerCase());
});

// Pure derivation (returns a Set, doesn't mutate component state) — every
// TreeNode instance rendered at the same id (multi-parent positions) sees
// the same set independently.
const expansionsForQuery = computed<Set<string>>(() => {
  const t = tree.value;
  const q = store.ui.search?.query;
  if (!q || !t) return new Set();
  const ids = new Set<string>();
  walkAndCollectAncestorsOfMatches(t, [], ids);
  return ids;
});
provide('expansionsForQuery', expansionsForQuery);
</script>

<template>
  <input v-if="store.ui.search" v-model="store.ui.search.query" placeholder="Search…" />
  <ul v-if="tree"><TreeNode :node="tree" /></ul>
</template>
```

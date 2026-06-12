---
title: Coding your UI
description: How to build a Nebula front end with Vue 3 SFCs and TypeScript — store reads and writes, auto-subscribe, conflict resolution, recursive components.
---

# Coding your UI

A Nebula front end is Vue 3 Single-File Components (SFCs) written in TypeScript, styled with DaisyUI, rendering resources whose shape you defined in your ontology (a TypeScript `.d.ts`-style file). The framework handles subscribes, transactions, and conflicts.

This page is the narrative reference Nebula Studio's hosted LLM consults when generating UI code in dialog with a user-developer — naming, defaults, and example shape are tuned for that LLM-as-reader audience. For exact signatures see [API reference](./api-reference.md). For the resource data model (addressing, eTags, transactions, conflict resolution) see [Resources](./resources.md). This page is "how to wire it together"; those pages are the contract.

## Resources at a glance

**Resources are the heart of this system. They are both simple and powerful. You use them when developing your app on the Nebula platform. Your users indirectly use them when they interact with your app because they are the only place you have to store user data.**

Resources also handle [**access control**](./resources.md#access-control). Every resource is attached at create time (movable later) to a node in your app's **org/permission tree**. Each node carries a per-user permissions table. A permission grant on a node flows down to every descendant.

Each resource is a JavaScript object (not just JSON, but rather rich types like Map, Date, cycles, etc.) addressed by a `(resourceType, resourceId)` pair, with its shape declared in your ontology. From your UI's perspective:

- `store.resources.<resourceType>[<resourceId>].value` — the resource's current value.
- `store.resources.<resourceType>[<resourceId>].meta` — server-managed metadata (`eTag`, change metadata, etc.).

The full resource model — addressing, optimistic concurrency, the per-type handler, transaction outcomes — is documented in [Resources](./resources.md), but other than shown in the examples in this document, you will rarely have to deal with them directly.

## Building your UI on top of Resources

Resources reside in the cloud. The UI in your user's web browser must access and manipulate them. This occurs in three layers:

1. **`NebulaClient`** — the WebSocket connection between your browser and the back end as well as authentication flows.
2. **The store** — a Vue-reactive Proxy that your `v-*` directives bind to. Reads under `store.resources.*` auto-subscribe to the resources they touch; writes flow through optimistic apply + debounced server submission. The whole reactive UI surface lives here.
3. **Vue 3** — `.vue` files with `<script setup lang="ts">`, `<template>`, and optional `<style scoped>`. Studio compiles them to render-function modules on every save (to a nearby dev server during development iteration; to your Galaxy when you are ready to deploy it to production). 

Studio auto-populates the bootstrap (a `nebula.ts` that calls `createNebulaClient()`, top-level-awaits the factory's `ready` promise, and exports `{ client, store, ready }`, plus a Vue entrypoint and an `index.html` shell). Because the bootstrap awaits `ready`, the app mounts only after the first connection completes — see [Current user](#current-user-clientclaims) for what that guarantees. Your `.vue` components import `{ store, client } from './nebula'` and define the UI. The full `createNebulaClient` config is at [API reference § createNebulaClient](./api-reference.md#createnebulaclient).

## `store` vs `client` — what goes where

`store` holds everything reactive — synced resources, your own UI state, and connection status mirrored from the client (`store.lmz.connection.*`). `client` is the underlying connection: method calls (`client.resources.transaction`, `client.resources.subscribe`, `client.dispose`, etc.) and non-reactive identity like `client.claims`. The prefix on every path expression in this doc is load-bearing — `store.X` is something to bind to, `client.X` is something to call or look up.

## Reading and writing through the store

Read and write the store inline in templates using stock [Vue 3](https://vuejs.org/) syntax. Auto-subscribe on read and debounced server submission on write are invisible. No Nebula-specific directives or modifiers.

```html @skip-check
<!-- The `?.` guards against the snapshot not having arrived yet. Auto-subscribes on first read. -->
<h2>{{ store.resources.todo[id]?.value?.title ?? 'Loading…' }}</h2>

<!-- :class object syntax (shorthand for v-bind:class) toggles a class on a reactive value. -->
<li :class="{ 'line-through': store.resources.todo[id]?.value?.status === 'done' }">
  <!-- v-model: each keystroke optimistically updates the store and queues a debounced
       transaction. The v-if guard is required — see "v-model requires a real writable path" below. -->
  <template v-if="store.resources.todo[id]?.value">
    <input v-model="store.resources.todo[id].value.title" />
  </template>
</li>

<span v-if="store.resources.todo[id]?.value?.status === 'done'" class="badge badge-success">Done</span>
<span v-else class="badge">Open</span>
```

The same paths work from TypeScript — inside a `computed`, a method, or an event handler. `value` is typed loosely on the store; when script code needs typing, cast it to the ontology type at the read site:

```typescript @skip-check
const title = store.resources.todo[id]?.value?.title;          // reactive read
store.resources.todo[id].value.title = 'New title';            // optimistic write + debounced transaction
const todo = store.resources.todo[id]?.value as Todo | undefined;  // cast to the ontology type for typed script code
```

For multi-resource atomic batches, explicit conflict-resolution handlers, programmatic subscriptions, and other operations that don't fit "read or write a single field," use the underlying `client` directly — the canonical case is [Forms: explicit save](#forms-explicit-save) below.

### `v-model` requires a real writable path

Optional chaining (`?.`) isn't allowed in a `v-model` expression. Guard the input with `v-if` so it only mounts after the resource value is synchronized into the store:

```html @skip-check
<template v-if="store.resources.todo[id]?.value">
  <input v-model="store.resources.todo[id].value.title" />
</template>
<span v-else>Loading…</span>
```

## Write timing

By default `v-model` listens on `input` (fires every keystroke). The optimistic local update is immediate; the network transaction is **debounced** by the synced-state middleware so per-keystroke `v-model` doesn't pile up server traffic. The middleware coalesces transaction submissions per `(resourceType, resourceId)`:

- **Quiet window**: wait this long after the last write to a resource before submitting (default 500 ms).
- **Max wait**: submit at least every N ms regardless of continued typing (default 2000 ms).
- **Flush on lifecycle**: pending writes flush on component unmount, input blur, and `client.dispose()`.
- **Serial per resource**: at most one transaction in flight per resource; subsequent writes buffer and submit using the in-flight transaction's resulting eTag.

A typical 10-character edit produces ~1 transaction, not 10.

**Write timing and conflict handling have type-derived defaults** — booleans and enums commit immediately, long-form text gets slower debounce plus an auto-registered text-merge resolver, short text uses the 500/2000 ms windows above. The full table and how to override it (`@debounce`, `@longform`) is the canonical reference in [Ontology § Annotations](./ontology.md#annotations). For runtime overrides (rare — A/B testing, dynamic config), `client.resources.transactionDebounce(rt, opts)` is available; see [API reference § resources.transactionDebounce](./api-reference.md#resourcestransactiondebounce).

### `v-model.lazy` — commit on blur

```html @skip-check
<!-- Listen on `change` instead of `input`: text input fires on blur, select on
     commit. Use when "I'm done editing this field" matches better than
     "live update on every keystroke." Same v-if guard as any v-model binding
     (see "Loading and first paint"): value must exist before binding. -->
<template v-if="store.resources.todo[id]?.value">
  <input v-model.lazy="store.resources.todo[id].value.title" />
</template>
```

## Concurrent edits and long-form text

The default `'use-server'` conflict resolution can clobber a user's in-progress
keystrokes when a concurrent edit from another client lands mid-typing. Annotating
a field `@longform` auto-registers a text-merge resolver that preserves both
edits, so long-form text (descriptions, comments, document bodies) is handled for
you — no handler to write. For custom merge logic, register your own per-type
handler — see [Resources § Text fields specifically — don't leave the
default](./resources.md#text-fields-specifically--dont-leave-the-default). Short
single-line fields like titles don't need any of this.

Text-merge preserves *non-overlapping* concurrent edits cleanly; when two users
edit the same span at once it can still garble. Conflict-free collaborative
editing (Google-Docs-style) needs a CRDT, which is out of scope for now.

## Loading and first paint

A resource's `?.value` is `undefined` until the initial server push lands (typically tens of ms; longer on cold connect). Three patterns:

**1. Inline placeholder via `??`** — simplest; works for any one-way text binding.

```html @skip-check
<span>{{ store.resources.todo['task-42']?.value?.title ?? 'Loading…' }}</span>
```

**2. Skeleton loader** — `v-if` on `value` swaps branches atomically once the snapshot arrives.

```html @skip-check
<div v-if="store.resources.todo['task-42']?.value" class="card">
  <h2>{{ store.resources.todo['task-42'].value.title }}</h2>
</div>
<div v-else class="card skeleton"></div>
```

**3. Multi-state status via `computed`** — distinguishes loading from deleted and folds connection state in. A deleted resource is **not** falsy: tombstones arrive as a real snapshot with `meta.deleted: true` and the last value still present, so the `meta.deleted` check must run *before* any `value` truthiness test. Patterns 1 and 2 don't cover deletion — they'd render a tombstone as if it were alive. (`meta.deleted` is `undefined` only for never-loaded resources.)

```typescript @skip-check
import { computed } from 'vue';

const todoStatus = computed(() => {
  const snap = store.resources.todo['task-42'];
  if (!store.lmz.connection.lastConnectedAt) return 'connecting';  // never connected yet (cold start)
  if (snap?.meta?.deleted)                   return 'deleted';
  if (!snap?.value)                          return 'loading';
  return 'ready';
});
```

```html @skip-check
<div v-if="todoStatus === 'connecting'" class="alert">Connecting…</div>
<div v-else-if="todoStatus === 'deleted'" class="alert alert-warning">This todo was deleted.</div>
<div v-else-if="todoStatus === 'loading'" class="card skeleton"></div>
<div v-else class="card">
  <h2>{{ store.resources.todo['task-42'].value.title }}</h2>
</div>
```

## Connection state

The factory mirrors `NebulaClient`'s connection state onto the store under `store.lmz.connection.*`. UI binds declaratively; no event listeners. Initial seeds (`'disconnected'` / `false` / `undefined`) mean first-paint reads never need `?.` guards.

| Path | Type | Description |
| --- | --- | --- |
| `store.lmz.connection.state` | `'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'` | Current state. |
| `store.lmz.connection.connected` | `boolean` | `true` iff `state === 'connected'`. |
| `store.lmz.connection.lastConnectedAt` | `number \| undefined` | `Date.now()` from the most recent `'connected'` transition. |

```html @skip-check
<!-- Banner while disconnected. This promise is real: while disconnected the
     framework suspends submission and holds writes (the optimistic store already
     shows them), flushing on reconnect (idempotent), so nothing rolls back from
     a blip. Held writes live in memory only — a page reload while offline drops
     anything unsent. -->
<div v-if="!store.lmz.connection.connected" class="alert alert-warning">
  Disconnected — your changes are queued. Reconnecting…
</div>

<!-- Disable a button while not connected. -->
<button :disabled="!store.lmz.connection.connected" class="btn btn-primary" @click="save">Save</button>
```

For richer status UI (color-coded badges, "last connected X minutes ago" tooltips), use `:class` object syntax against `store.lmz.connection.state` and format `store.lmz.connection.lastConnectedAt` with `new Date(...)`.

## Current user (`client.claims`)

The decoded JWT payload is on `client.claims` — `sub` (subject, the user's stable ID — a bare UUID minted by nebula-auth), `aud` (audience), `access` (the user's scope grant — `{ authScopePattern, admin? }`), and any other claims your auth provider mints. The object is frozen; it is replaced wholesale on each token refresh (the values you key on — `sub`, `aud` — don't change within a session).

`client.claims` is `null` until the client's first token refresh completes, and `client` is not reactive — a `v-if` gated on it never re-evaluates. Studio-generated apps never see that window: the bootstrap top-level-awaits the factory's `ready` promise before the app mounts, so claims are populated before any component renders. That contract is pinned at [API reference § client.claims](./api-reference.md#clientclaims); the examples below rely on it. Outside a Studio bootstrap (admin tools, scripts), guard with `client.claims?.`.

```html @skip-check
<!-- Per-user keying — bind to this user's own list, looked up by their JWT sub. -->
<h2 v-if="store.resources.todoList[client.claims.sub]?.value">Your list</h2>
```

The same `client.claims.sub` keying works in script too — the [Forms](#forms-explicit-save) examples below use it as a transaction key.

### Gating admin-only UI

"Admin" has **two** independent sources, and admin-only UI checks both:

- **App admin** — a user holding `admin` on the relevant org-tree node. App-wide admin is `admin` on the root node; per-area admin is `admin` (directly or cascaded) on that area's node. This lives in the reactive tree at `store.lmz.orgTree`, so the UI tracks grants as they change.
- **Scope admin** — a Galaxy- or Universe-level operator, carried in the JWT as `client.claims.access.admin`. They have effective admin everywhere in the scope, but — being a scope property, not a node grant — they do **not** appear in the org-tree's `permissions` map (see [the note in Resources](./resources.md#access-control)). So you can't discover them from the tree; you read the claim.

A `computed` that covers both:

```typescript @skip-check
import { computed } from 'vue';
import { ROOT_NODE_ID } from '@lumenize/nebula-frontend';
import { store, client } from './nebula';

const isAppAdmin = computed(() =>
  client.claims.access?.admin ||                                    // Galaxy/Universe scope admin
  store.lmz.orgTree?.value?.permissions
    .get(ROOT_NODE_ID)?.get(client.claims.sub) === 'admin'          // app admin (grant on root)
);
```

```html @skip-check
<button v-if="isAppAdmin" class="btn">Admin settings</button>
```

`client.claims` is the client-side counterpart of `originAuth.claims` server-side. See [mesh: LumenizeClient](/docs/mesh/lumenize-client#client-identity-clientclaims) for the surface and [Nebula auth flows](./auth-flows.md) for how the JWT is issued.

## Subscription lifecycle

Auto-subscribe is already at work in the examples above — any `store.resources.*` read inside a component (`setup()`, `computed`, template, `watch`) subscribes that resource, with no manual `subscribe` call. This section is about the rest of the lifecycle: how live subscriptions are coalesced, and how they're released when components go away.

Subscriptions are reference-counted across the whole app. Reading the same resource from several places — multiple fields in one component, or several mounted components showing it at once — shares one subscription; the count tracks how many live references it has.

When a component unmounts, its reference drops. The subscription starts releasing only when the count reaches zero (the last component using the resource has gone away), and even then waits a **2-second grace period** (configurable via `createNebulaClient({ unsubscribeGraceMs: ... })`). If a new read appears within that window — tab-switch back, modal close-then-reopen, `<KeepAlive>` swap, click-to-edit toggle — the pending release cancels and the subscription stays live with no re-subscribe round-trip.

```html @skip-check
<!-- Click-to-edit. Toggling between the <h2> and <input> unmounts one and
     mounts the other — the subscription to store.resources.todo[id] survives
     the toggle because both reads happen well within the 2 s grace window. -->
<template v-if="store.resources.todo[id]?.value">
  <h2 v-if="!store.ui.editingTitle" @click="store.ui.editingTitle = true">
    {{ store.resources.todo[id].value.title }}
  </h2>
  <input v-else v-model="store.resources.todo[id].value.title"
         @blur="store.ui.editingTitle = false" />
</template>
```

For non-component cases (warming a cache before navigation, scripting, headless tests), call `client.resources.subscribe(rt, rid)` directly. The returned handle is `Disposable` — use `using` for auto-release on scope exit, or call `client.resources.unsubscribe(rt, rid)` manually if subscribe and unsubscribe happen in different places. See [API reference § resources.subscribe](./api-reference.md#resourcessubscribe).

Two parts of the lifecycle need no UI code: after a dropped connection reconnects, live subscriptions re-subscribe themselves; and deploying a new app version clears server-side subscriptions and triggers a refresh (`onShouldRefreshUI`).

## Plain Vue state

Anything **not** under `store.resources.*` is plain Vue reactive state. Two common patterns:

- **Instance-local** — Vue's [`ref` / `reactive`](https://vuejs.org/api/reactivity-core.html) inside `<script setup>`.
- **Shared across components or persists across remount** — put it on the store under a non-reserved prefix, typically `store.ui.*` (transient UI state like form drafts) or `store.app.*` (app-wide state like the current view). The factory pre-seeds `store.ui` and `store.app` as empty objects, so first-level use (`store.ui.editingTitle = true`, `v-if="!store.ui.editingTitle"`) works with no setup.

Deeper state needs initialization before being used as a `v-model` target. The two kinds initialize differently:

- **`store.resources.*`** — create the resource on the server, typically via `client.resources.transaction({ ... op: 'create' ... })`. See [Atomic append](#atomic-append--adding-to-a-collection) for the pattern.
- **Plain Vue state** — initialize the intermediate objects locally; the factory does NOT auto-vivify under non-reserved prefixes. `v-model="store.ui.todoForm.draft.title"` requires `store.ui.todoForm.draft` to already exist. Initialize in `nebula.ts` at module load or in `onMounted` — see [Forms: explicit save](#forms-explicit-save).


## Lists with `v-for`

For lists of resources, use a **container resource** whose value holds an array of IDs. Reading `store.resources.<rt>[<rid>]` for each ID inside the loop auto-subscribes that resource individually.

```typescript @skip-check
// Ontology (.d.ts-style file)
interface TodoList {
  items: string[];        // IDs of Todo resources, in display order
  openCount: number;      // denormalized count where status === 'open'
}

interface Todo {
  title: string;
  description: string;
  status: 'open' | 'done';
}
```

```html @skip-check
<!-- Subscribes to the container; each iteration subscribes to its todo.
     Removing an ID unmounts the <li>, decrements the refcount, and
     unsubscribes after the 2 s grace period. -->
<ul>
  <li v-for="todoId in store.resources.todoList[client.claims.sub]?.value?.items ?? []" :key="todoId">
    {{ store.resources.todo[todoId]?.value?.title ?? '...' }}
    <span v-if="store.resources.todo[todoId]?.value?.status === 'done'">✓</span>
  </li>
</ul>
```

The container is keyed per user — `('todoList', client.claims.sub)` — so each user has their own list, looked up by their JWT subject. Subscribing to a resource that doesn't exist yet is a server-side error, so the app creates the list on first visit: read, then create if absent. This runs in `nebula.ts` after `await ready` (claims are populated, and module evaluation finishes before any component renders):

```typescript @skip-check
// nebula.ts (after `await ready`)
import { ROOT_NODE_ID } from '@lumenize/nebula-frontend';
const sub = client.claims.sub;

// Create the list under a node the user can write to. This demo signs in as
// the Star's founder, who holds `admin` on the root node (granted when the
// Star was created), so resources attach under ROOT_NODE_ID. In a multi-user
// app, attach under whatever node the user was granted — see "Mutating the
// org/permission tree" for how access is granted.
if (await client.resources.read('todoList', sub) === null) {
  const outcome = await client.resources.transaction({
    [sub]: { op: 'create', typeName: 'todoList', nodeId: ROOT_NODE_ID,
             value: { items: [], openCount: 0 } },
  });
  // Success means the CREATE committed, not just that the server responded:
  // per-resource failures (permission-denied, validation-failed) arrive UNDER
  // kind 'ok' in outcome.resources. Race-safe: if another tab created the list
  // first, re-read to disambiguate — the list now exists (someone won the
  // race), or it genuinely doesn't (a real failure to surface).
  const created = outcome.kind === 'ok' && outcome.resources[sub]?.kind === 'committed';
  if (!created && await client.resources.read('todoList', sub) === null) {
    throw new Error('Could not create your list — check your connection and reload.');
  }
}
```

(A node the user can write to is the only prerequisite; the founder gets one — `admin` on root — at Star creation. Other users acquire write on a node by being granted it — see [Mutating the org/permission tree](#mutating-the-orgpermission-tree); who to ask is resolved client-side from the tree (see the [worked example](#worked-example-rendering-the-built-in-tree)).)

Inline arrays of embedded objects (e.g., `assignees`) iterate the same way without auto-subscribing per item — the embedded object's fields are right there.

This works up to ~hundreds of items. Beyond that, a query language is the right tool — deferred for now.

### Atomic append — adding to a collection

Creating a new resource and adding its ID to a container happens in **one transaction**, so neither orphan-todo nor dangling-reference state ever exists. For the "two users added at the same time" race, register a handler on the list type that returns `'use-this'` with a set-union of `items` (and an `openCount` recomputed for the merged set — the locally-added open items shift it) — see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler).

```typescript @skip-check
async function addTodo(title: string) {
  const newId = crypto.randomUUID();
  const listSnap = store.resources.todoList[client.claims.sub];
  const list = listSnap?.value;
  if (!list) return;   // snapshot not arrived yet — see "Loading and first paint"

  // Both ops in one call → atomic. Either both commit or neither does.
  // eTag for the put auto-derives from store.resources.todoList[...]?.meta?.eTag.
  // The new todo attaches under the same tree node as the list (meta.nodeId,
  // not value — nodeId is server-managed metadata).
  const outcome = await client.resources.transaction({
    [newId]:             { op: 'create', typeName: 'todo', nodeId: listSnap.meta.nodeId,
                           value: { title, description: '', status: 'open' } },
    [client.claims.sub]: { op: 'put',    typeName: 'todoList',
                           value: { ...list, items: [...list.items, newId],
                                    openCount: list.openCount + 1 } },
  });
  // error handling on outcome goes here
}
```

## Conditionals with `v-if`

Stock Vue. The one Nebula-relevant note: subscriptions inside an unmounted branch don't initiate. A `v-if="false"` branch's resource paths are NOT subscribed.

```html @skip-check
<!-- While `expanded` is false, the todo resource is NOT subscribed. -->
<div v-if="expanded">
  {{ store.resources.todo[id]?.value?.description }}
</div>
```

## Forms: explicit save

For multi-field forms that should commit together (rather than per-keystroke transactions), bind inputs to a local draft path and submit on click. Each form keeps its draft under its own `store.ui.<formName>.draft` path.

Form-scoped reactions — clear the draft on commit, surface validation errors next to fields — belong in a **per-call handler** passed to that save's `transaction()` call, NOT in the per-type handler: the per-type handler fires on *every* transaction touching the type (debounced `v-model` edits, other forms, list mutations), so form state wired there gets clobbered by unrelated commits. Keep the per-type handler (registered once in `nebula.ts`) for type-wide policy — conflict verdicts, custom flashes; see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler). A per-call handler is consulted first for every resource in that call; returning `undefined` falls through to the per-type handler, and per-type terminal reactions still fire (it layers in front — it does not replace; see [API reference § Precedence](./api-reference.md#precedence)).

Mount the form only after the resource's snapshot has arrived — the same `v-if` guard from [Loading and first paint](#loading-and-first-paint): `<TodoForm v-if="store.resources.todo['task-42']?.value" />`. Seeding the draft before the snapshot lands would stage blank values that Save then commits over the real data (the eTag auto-derive matches, so no conflict fires to stop it).

```vue @skip-check
<!-- TodoForm.vue — local draft → explicit transaction on submit.
     Parent mounts it only once the snapshot exists (see above). -->
<script setup lang="ts">
import { onMounted } from 'vue';
import { store, client } from './nebula';

// Seed the draft from the synced value on first mount. store.ui.todoForm must
// exist as an object before v-model can bind nested fields (the factory
// pre-seeds store.ui itself, but not intermediates).
onMounted(() => {
  if (!store.ui.todoForm) store.ui.todoForm = {};
  store.ui.todoForm.draft = { ...store.resources.todo['task-42'].value };
});

async function saveTodo() {
  const draft = store.ui.todoForm.draft;
  const currentStatus = store.resources.todo['task-42']?.value?.status;
  const list = store.resources.todoList[client.claims.sub]?.value;
  // Status changes shift openCount; title/description-only edits don't.
  const delta = (draft.status === 'open' ? 1 : 0) - (currentStatus === 'open' ? 1 : 0);
  if (delta !== 0 && !list) return;   // openCount update needs the list snapshot — bail until it's loaded

  const outcome = await client.resources.transaction({
    'task-42': { op: 'put', typeName: 'todo', value: draft },
    ...(delta !== 0 && {
      [client.claims.sub]: { op: 'put', typeName: 'todoList',
                             value: { ...list, openCount: list.openCount + delta } },
    }),
  }, {
    // Per-call handler — scoped to this save. It's consulted for EVERY resource
    // in the batch and layers in front of (does not replace) the per-type
    // handlers, so it MUST filter by rid: returning for the todoList lets its
    // per-type set-union/openCount handler run (fall-through), instead of
    // shadowing it. See API reference § Precedence.
    onTransactionResourceResolution: (rid, resolution) => {
      if (rid !== 'task-42') return;   // fall through to todoList's per-type handler
      switch (resolution.kind) {
        case 'committed':         store.ui.todoForm.draft = undefined; break;
        case 'validation-failed': store.ui.todoForm.validationErrors = resolution.errors; break;
        case 'permission-denied': store.ui.todoForm.saveError = { kind: 'permission-denied', rid }; break;
      }
    },
  });
  // transaction-wide failures (timeout, infrastructure-error) handled here
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

Each recursive instance auto-subscribes to its own resource (the foreign-key pattern from [Lists](#lists-with-v-for) applied at every level). Unmounting decrements the refcount; grace period applies as usual.

```vue @skip-check
<!-- TreeNode.vue -->
<script setup lang="ts">
import { store } from './nebula';

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

Mount the recursive component from any parent at a known root id: `<TreeNode :node-id="rootId" />`.


## Mutating the org/permission tree

The tree itself is mutable through `client.orgTree.*` methods. Each method requires the caller to hold a specific permission on the target node — `admin` for permission grants, `write` for structural changes (create, reparent, delete, rename, relabel; edge ops check the parent). The one hybrid is `addEdge`, which also requires `admin` on the *child*: adding a parent edge widens who has access to the child's subtree, so the child side demands `setPermission`'s tier. Failures reject the returned Promise.

```typescript @skip-check
// Grant a permission. `sub` is a JWT subject claim — a bare UUID (the current
// user's is client.claims.sub; other users' subs come from wherever your app
// stores its member list). `level` is 'read' (view), 'write' (edit +
// structural changes), or 'admin' (write + manage permissions).
// Caller must hold `admin` on `nodeId`.
await client.orgTree.setPermission(nodeId, bobsSub, 'read');

// Revoke. Idempotent — no-op if `sub` has no grant on this node.
await client.orgTree.revokePermission(nodeId, bobsSub);

// Create a child node (slug rules and return shape: see API reference).
// Caller must hold `write` on `parentNodeId`.
const listShoppingId = await client.orgTree.createNode(
  userAliceNodeId, 'list-shopping', 'Shopping',
);

// Co-ownership sharing — the two-party share-accept flow from Resources §
// Access control. Step 1, owner offers (runs as Alice): grant Bob admin on
// the list.
await client.orgTree.setPermission(listShoppingId, bobsSub, 'admin');

// Step 2, recipient accepts (runs as Bob): the edge makes the list a child
// of both user-alice AND user-bob, so Bob's admin on user-bob now cascades
// to it. addEdge requires `write` on the new parent + `admin` on the child.
await client.orgTree.addEdge(userBobNodeId, listShoppingId);

// Step 3, optional cleanup (either co-owner): the direct grant from step 1
// is redundant once the edge cascades.
await client.orgTree.revokePermission(listShoppingId, bobsSub);

// "Remove from my account" = delete only this user's edge to the list.
// The list lives on under its other parents.
await client.orgTree.removeEdge(userBobNodeId, listShoppingId);
```

The full surface (`reparentNode`, `deleteNode`, `undeleteNode`, `renameNode`, `relabelNode`) is at [API reference § client.orgTree](./api-reference.md#clientorgtree). For the conceptual model (cascading permissions, the two sharing approaches, when to use which), see [Resources § Access control](./resources.md#access-control).

## Worked example: rendering the built-in tree

**Every Nebula app receives the same built-in org/permission tree** — the structure that resources are attached to for permissions and tenancy. Every connected client gets the full tree at `store.lmz.orgTree.value` — structure *and* the full permissions table (opaque-ID-keyed; see [Resources § Access control](./resources.md#access-control) for what that exposes and why). Visibility is intentionally not restricted — the sub-second-RTT permission UX wants every client to know the full shape locally, to grey out inaccessible nodes and resolve who to ask for access. Most apps will surface it somewhere in their UI; rendering it as a tree view is the most common form (others: a flat list of accessible nodes, a breadcrumb selector for the current scope, a permission-grant dialog).

The example pulls together: reading the built-in org tree (delivered on its own channel to `store.lmz.orgTree`), walking the embedded `Map<number, ...>` in a `computed`, recursive Vue components, per-instance state, and `provide` / `inject` to broadcast a derived signal down the tree. It includes multi-parent rendering (the tree allows a node to have more than one parent — see [Resources § Access control](./resources.md#access-control) for why and the tradeoffs), virtual "Deleted" / "Orphaned" branches, and search with match highlighting + auto-expand of ancestors of matches.

### The tree shape

`store.lmz.orgTree.value` is an [`OrgTreeState`](./api-reference.md#orgtreestate) — `nodes` (a `Map<number, { slug, label, deleted }>`), `edges` (a `Set` of `"parentId:childId"` keys — adjacency lives here, not on the nodes), and `permissions`. For O(1) parent/child lookups while walking, build an `OrgTreeView` with `buildOrgTreeView(orgTree)` (exported from `@lumenize/nebula-frontend`); the `tree.ts` helpers below use it.

The tree is subscribed once on connect and kept current at `store.lmz.orgTree`; every server-side mutation broadcasts a fresh snapshot to all connected clients (the actor included — `client.orgTree.*` has no optimistic local write, so the broadcast echo is what updates your own store). The delivery is tagged `new-in-v3` — see [API reference § OrgTreeState](./api-reference.md#orgtreestate).

The framework reserves the `lmz` resourceType for its own resources (mirrors the `lmz.*` reserved prefix used for non-resource paths like `lmz.connection.*` — anything under `lmz` in either reserved namespace is framework territory).

**Multi-parent rendering**: a node with parents `[A, B]` renders once under each. The derivation walks every parent edge; each rendered position is its own `OrgTreeNode` instance with independent per-instance state automatically.

**Virtual branches**: `__deleted__` and `__orphaned__` are IDs in the derived `TreeNodeData` tree. Real tree nodes have integer `nodeId`, so the derived `TreeNodeData.id` — `String(nodeId)` — is all digits for every real node; the underscore-prefixed virtual IDs can't collide with anything real.

### Derivation helpers (`tree.ts`)

```typescript @skip-check
// tree.ts — shape + derivation helpers used by App.vue and OrgTreeNode.vue.
import { ROOT_NODE_ID, buildOrgTreeView, type OrgTreeState } from '@lumenize/nebula-frontend';

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
  orgTree: OrgTreeState,
  query: string,
): TreeNodeData {
  // Build the adjacency view once (childrenByParent / parentsByChild from
  // orgTree.edges), then walk from ROOT_NODE_ID: view.childrenByParent.get(id)
  // for each node's children, orgTree.nodes.get(id) for its {slug, label, deleted}.
  const view = buildOrgTreeView(orgTree);
  return { /* root TreeNodeData */ } as TreeNodeData;
}

// For each node whose labelRuns contains a match, adds every ancestor id to
// `ids` (App.vue provides the result as the auto-expand set).
export function walkAndCollectAncestorsOfMatches(
  tree: TreeNodeData, ancestors: string[], ids: Set<string>,
): void { /* ... */ }
```

### Component (`OrgTreeNode.vue`)

```vue @skip-check
<!-- OrgTreeNode.vue — recursive tree row + child list. -->
<script setup lang="ts">
import { ref, inject, watch, type Ref } from 'vue';
import type { TreeNodeData } from './tree';

const props = defineProps<{ node: TreeNodeData }>();

// Per-instance state: each OrgTreeNode instance has its own isOpen.
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

    <ul v-if="isOpen">
      <OrgTreeNode v-for="child in node.children" :key="child.id" :node="child" />
    </ul>
  </li>
</template>
```

### Root component (`App.vue`)

```vue @skip-check
<!-- App.vue — search input + tree derivation + provide auto-expand set. -->
<script setup lang="ts">
import { computed, provide, onMounted } from 'vue';
import type { OrgTreeState } from '@lumenize/nebula-frontend';
import { store } from './nebula';
import OrgTreeNode from './OrgTreeNode.vue';
import { deriveTreeWithVirtuals, walkAndCollectAncestorsOfMatches,
  type TreeNodeData } from './tree';

onMounted(() => { if (!store.ui.search) store.ui.search = { query: '' }; });

// The org tree is delivered on a dedicated channel (subscribed on connect) and
// kept current at store.lmz.orgTree — read it reactively here.
// Re-runs when the server pushes a new OrgTreeState or the query changes.
// Vue 3's reactivity tracks Map.get / Map iteration natively.
const tree = computed<TreeNodeData | null>(() => {
  const orgTree = store.lmz.orgTree?.value as OrgTreeState | undefined;
  if (!orgTree) return null;
  return deriveTreeWithVirtuals(orgTree, (store.ui.search?.query ?? '').toLowerCase());
});

// Pure derivation (returns a Set, doesn't mutate component state) — every
// OrgTreeNode instance rendered at the same id (multi-parent positions) sees
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
  <ul v-if="tree"><OrgTreeNode :node="tree" /></ul>
</template>
```

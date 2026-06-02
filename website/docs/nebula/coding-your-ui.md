---
title: Coding your UI
description: How to build a Nebula front end with Vue 3 SFCs and TypeScript — store reads and writes, auto-subscribe, conflict resolution, recursive components.
---

# Coding your UI

A Nebula front end is Vue 3 Single-File Components (SFCs) written in TypeScript, styled with DaisyUI, rendering resources whose shape you defined in your ontology (a TypeScript `.d.ts`-style file). The framework handles subscribes, transactions, and conflicts.

This page is the narrative reference Nebula Studio's hosted LLM consults when generating UI code in dialog with a user-developer — naming, defaults, and example shape are tuned for that LLM-as-reader audience. For exact signatures see [API reference](./api-reference.md). For the resource data model (addressing, eTags, transactions, conflict resolution) see [Resources](./resources.md). This page is "how to wire it together"; those pages are the contract.

## Resources at a glance

**Resources are the heart of this system. They are both simple and powerful. You use them when developing your app on the Nebula platform. Your users indirectly use them when they interact with your app because they are the only place for them to store anything.**

Resources also handle [**access control**](./resources.md#access-control). Every resource is attached at create time to a node in your app's **org/permission tree**. Each node carries a per-user permissions table and a grant on a parent applies to every descendant.

Each resource is a JavaScript object (not just JSON, but rather rich types like Map, Date, cycles, etc.) addressed by a `(resourceType, resourceId)` pair, with its shape declared in your ontology. From your UI's perspective:

- `store.resources.<resourceType>[<resourceId>].value` — the resource's current value.
- `store.resources.<resourceType>[<resourceId>].meta` — server-managed metadata (`eTag`, change metadata, etc.).

The full resource model — addressing, optimistic concurrency, the per-type handler, transaction outcomes — is documented in [Resources](./resources.md), but other than shown in the examples in this document, you will rarely have to deal with them directly.

## Building your UI on top of Resources

Resources reside in the cloud. The UI in your user's web browser must access and manipulate them. This occurs in three layers:

1. **`NebulaClient`** — the WebSocket connection between your browser and the back end as well as authentication flows.
2. **The store** — a Vue-reactive Proxy that your `v-*` directives bind to. Reads under `store.resources.*` auto-subscribe to the resources they touch; writes flow through optimistic apply + debounced server submission. The whole reactive UI surface lives here.
3. **Vue 3** — `.vue` files with `<script setup lang="ts">`, `<template>`, and optional `<style scoped>`. Studio compiles them to render-function modules on every save (to a nearby dev server during development iteration; to your Galaxy when you are ready to deploy it to production). 

Studio auto-populates the bootstrap (a `store.ts` that calls `createNebulaClient()` and exports `{ client, store }`, plus a Vue entrypoint and an `index.html` shell). Your `.vue` components import `{ store, client } from './store'` and define the UI. The full `createNebulaClient` config is at [API reference § createNebulaClient](./api-reference.md#createnebulaclient).

## `store` vs `client` — what goes where

`store` holds everything reactive — synced resources, your own UI state, and connection status mirrored from the client (`store.lmz.connection.*`). `client` is the underlying connection: method calls (`transaction`, `subscribe`, `dispose`, etc.) and non-reactive identity like `client.claims`. The prefix on every path expression in this doc is load-bearing — `store.X` is something to bind to, `client.X` is something to call or look up.

## Reading and writing through the store

Read and write the store inline in templates using stock [Vue 3](https://vuejs.org/) syntax. Auto-subscribe on read and debounced server submission on write are invisible. No Nebula-specific directives or modifiers.

```html @skip-check
<!-- The `?.` guards against the snapshot not having arrived yet. Auto-subscribes on first read. -->
<h2>{{ store.resources.todo[id]?.value?.title ?? 'Loading…' }}</h2>

<!-- :class object syntax (shorthand for v-bind:class) toggles a class on a reactive value. -->
<li :class="{ 'line-through': store.resources.todo[id]?.value?.status === 'done' }">
  <!-- v-model: each keystroke optimistically updates the store and queues a debounced transaction. -->
  <input v-model="store.resources.todo[id].value.title" />
</li>

<span v-if="store.resources.todo[id]?.value?.status === 'done'" class="badge badge-success">Done</span>
<span v-else class="badge">Open</span>
```

The same paths work from TypeScript — inside a `computed`, a method, or an event handler:

```typescript @skip-check
const title = store.resources.todo[id]?.value?.title;          // reactive read
store.resources.todo[id].value.title = 'New title';            // optimistic write + debounced transaction
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

:::caution Concurrent edits can clobber long-form text

The default `'use-server'` resolution can clobber the user's keystrokes during a concurrent edit. For long-form text (descriptions, comments, document bodies, code editors), consider registering a per-type text-merge handler — see [Resources § Text fields specifically — don't leave the default](./resources.md#text-fields-specifically--dont-leave-the-default). Short single-line fields like titles don't need this.

:::

**Field-level write timing has sensible defaults** matched to each field's type — a `boolean` commits immediately (no debounce); a long-form text field uses slower debounce + text-merge; short single-line text uses the 500/2000 ms windows above. To override, annotate the field in the ontology (`@debounce`, `@longform`, etc.) — see [Ontology § Annotations](./ontology.md#annotations). For runtime overrides (rare — A/B testing, dynamic config), `client.resources.transactionDebounce(rt, opts)` is available; see [API reference § resources.transactionDebounce](./api-reference.md#resourcestransactiondebounce).

### `v-model.lazy` — commit on blur

```html @skip-check
<!-- Listen on `change` instead of `input`: text input fires on blur, select on
     commit. Use when "I'm done editing this field" matches better than
     "live update on every keystroke." -->
<input v-model.lazy="store.resources.todo[id].value.title" />
```

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

**3. Multi-state status via `computed`** — distinguishes loading from deleted (a deleted resource also produces a falsy `value`; `meta.deleted` is `true` for tombstones, `undefined` for never-loaded) and folds connection state in.

```typescript @skip-check
import { computed } from 'vue';

const todoStatus = computed(() => {
  const snap = store.resources.todo['task-42'];
  if (!store.lmz.connection.lastConnectedAt) return 'connecting';
  if (snap?.meta?.deleted)                   return 'deleted';
  if (!snap?.value)                          return 'loading';
  return 'ready';
});
```

```html @skip-check
<div v-if="todoStatus === 'ready'" class="card">
  <h2>{{ store.resources.todo['task-42'].value.title }}</h2>
</div>
<div v-else-if="todoStatus === 'deleted'" class="alert alert-warning">This todo was deleted.</div>
<div v-else-if="todoStatus === 'connecting'" class="alert">Connecting…</div>
<div v-else class="card skeleton"></div>
```

## Connection state

The factory mirrors `NebulaClient`'s connection state onto the store under `store.lmz.connection.*`. UI binds declaratively; no event listeners. Initial seeds (`'disconnected'` / `false` / `undefined`) mean first-paint reads never need `?.` guards.

| Path | Type | Description |
| --- | --- | --- |
| `store.lmz.connection.state` | `'connecting'` / `'connected'` / `'reconnecting'` / `'disconnected'` | Current state. |
| `store.lmz.connection.connected` | `boolean` | `true` iff `state === 'connected'`. |
| `store.lmz.connection.lastConnectedAt` | `number \| undefined` | `Date.now()` from the most recent `'connected'` transition. |

```html @skip-check
<!-- Banner while disconnected. Optimistic writes still queue in the background. -->
<div v-if="!store.lmz.connection.connected" class="alert alert-warning">
  Disconnected — your changes are queued. Reconnecting…
</div>

<!-- Disable a button while not connected. -->
<button :disabled="!store.lmz.connection.connected" class="btn btn-primary" @click="save">Save</button>
```

For richer status UI (color-coded badges, "last connected X minutes ago" tooltips), use `:class` object syntax against `store.lmz.connection.state` and format `store.lmz.connection.lastConnectedAt` with `new Date(...)`.

## Current user (`client.claims`)

The decoded JWT payload is on `client.claims` — `sub` (subject, the user's stable ID), `aud` (audience), `isAdmin`, and any other claims your auth provider mints. Frozen and stable for the client's lifetime (replaced on each token refresh).

```typescript @skip-check
// Per-user keying — one resource per user, looked up by their JWT sub.
const myList = store.resources.todoList[client.claims.sub]?.value;
```

`client.claims` is the client-side counterpart of `originAuth.claims` server-side. See [mesh: LumenizeClient](../mesh/lumenize-client.md#client-identity-clientclaims) for the surface and [Nebula auth flows](./auth-flows.md) for how the JWT is issued.

## Auto-subscribe

Reading `store.resources.<rt>[<rid>].value.*` inside a Vue component (`setup()`, `computed`, template, `watch`) auto-subscribes that resource. The snapshot arrives via server fanout; the store updates; Vue re-renders. No manual `subscribe` call.

Multiple reads of the same resource within one component count as one subscription — read whatever fields you need, no aliasing tricks required.

When the component unmounts, the subscription releases after a **2-second grace period** (configurable via `createNebulaClient({ unsubscribeGraceMs: ... })`). If a new component reads the same resource within that window — tab-switch back, modal close-then-reopen, `<KeepAlive>` swap, click-to-edit toggle — the pending release cancels and the subscription stays live with no re-subscribe round-trip.

```html @skip-check
<!-- Click-to-edit. Toggling between the <h2> and <input> unmounts one and
     mounts the other — the subscription to store.resources.todo[id] survives
     the toggle because both reads happen well within the 2 s grace window. -->
<h2 v-if="!store.ui.editingTitle" @click="store.ui.editingTitle = true">
  {{ store.resources.todo[id].value.title }}
</h2>
<input v-else v-model="store.resources.todo[id].value.title"
       @blur="store.ui.editingTitle = false" />
```

For non-component cases (warming a cache before navigation, scripting, headless tests), call `client.resources.subscribe(rt, rid)` directly. The returned handle is `Disposable` — use `using` for auto-release on scope exit, or call `client.resources.unsubscribe(rt, rid)` manually if subscribe and unsubscribe happen in different places. See [API reference § resources.subscribe](./api-reference.md#resourcessubscribe).

## Plain Vue state

Anything **not** under `store.resources.*` is plain Vue reactive state. Two common patterns:

- **Instance-local** — Vue's [`ref` / `reactive`](https://vuejs.org/api/reactivity-core.html) inside `<script setup>`.
- **Shared across components or persists across remount** — put it on the store under a non-reserved prefix, typically `store.ui.*` (transient UI state like form drafts) or `store.app.*` (app-wide state like the current view).

Both kinds of state need initialization before being used as a `v-model` target (no `?.` chains allowed). They initialize differently:

- **`store.resources.*`** — create the resource on the server, typically via `client.resources.transaction({ ... op: 'create' ... })`. See [Atomic append](#atomic-append--adding-to-a-collection) for the pattern.
- **Plain Vue state** — initialize the intermediate objects locally. `v-model="store.ui.todoForm.draft.title"` requires `store.ui.todoForm.draft` to already exist. Initialize in `store.ts` at module load or in `onMounted` — see [Forms: explicit save](#forms-explicit-save).


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

The container is keyed per user — `('todoList', client.claims.sub)` — so each user has their own list, looked up by their JWT subject. The per-user `todoList` resource is created on first use (server-side, on the user's signup flow).

Inline arrays of embedded objects (e.g., `assignees`) iterate the same way without auto-subscribing per item — the embedded object's fields are right there.

This works up to ~hundreds of items. Beyond that, a query language is the right tool — deferred for now.

### Atomic append — adding to a collection

Creating a new resource and adding its ID to a container happens in **one transaction**, so neither orphan-todo nor dangling-reference state ever exists. For the "two users added at the same time" race, register a handler on the list type that returns `'use-this'` with a set-union of `items` — see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler).

```typescript @skip-check
async function addTodo(title: string) {
  const newId = crypto.randomUUID();
  const list = store.resources.todoList[client.claims.sub]?.value;

  // Both ops in one call → atomic. Either both commit or neither does.
  // eTag for the put auto-derives from store.resources.todoList[...]?.meta?.eTag.
  const outcome = await client.resources.transaction({
    [newId]:             { op: 'create', typeName: 'todo', nodeId: list.nodeId,
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

For multi-field forms that should commit together (rather than per-keystroke transactions), bind inputs to a local draft path and submit on click. Each form keeps its draft under its own `store.ui.<formName>.draft` path. The per-type handler clears the draft on commit and surfaces per-resource problems — register once in `store.ts`. (For the full set of resolution branches and how each affects the draft, see [Resources § per-resource handler](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler).)

```typescript @skip-check
// store.ts (alongside the createNebulaClient call)
client.resources.onTransactionResourceResolution('todo', (rid, resolution) => {
  switch (resolution.kind) {
    case 'committed':         store.ui.todoForm.draft = undefined; break;
    case 'validation-failed': store.ui.todoForm.validationErrors = resolution.errors; break;
    case 'permission-denied': store.ui.todoForm.saveError = { kind: 'permission-denied', rid }; break;
    // 'use-server' and 'retries-exhausted' trigger the default red-flash.
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
  const draft = store.ui.todoForm.draft;
  const currentStatus = store.resources.todo['task-42']?.value?.status;
  const list = store.resources.todoList[client.claims.sub]?.value;
  // Status changes shift openCount; title/description-only edits don't.
  const delta = (draft.status === 'open' ? 1 : 0) - (currentStatus === 'open' ? 1 : 0);

  const outcome = await client.resources.transaction({
    'task-42': { op: 'put', typeName: 'todo', value: draft },
    ...(delta !== 0 && {
      [client.claims.sub]: { op: 'put', typeName: 'todoList',
                             value: { ...list, openCount: list.openCount + delta } },
    }),
  });
  // error handling on outcome goes here
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


## Mutating the org/permission tree

The tree itself is mutable through `client.dagTree.*` methods. Each method requires the caller to hold a specific permission on the target node — `admin` for permission grants, `write` for structural changes (create, edge, move, delete, rename). Failures reject the returned Promise.

```typescript @skip-check
// Grant a permission. `sub` is the user's JWT subject claim (typically
// `user:<id>` or `group:<id>`). `level` is 'read' (view), 'write' (edit),
// or 'admin' (edit + manage permissions + structural changes).
// Caller must hold `admin` on `nodeId`.
await client.dagTree.setPermission(nodeId, 'user:bob', 'read');

// Revoke. Idempotent — no-op if `sub` has no grant on this node.
await client.dagTree.revokePermission(nodeId, 'user:bob');

// Create a child node. Slug must match `[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?`
// and be unique among siblings. Caller must hold `write` on `parentNodeId`.
// Returns the new node's integer id.
const listShoppingId = await client.dagTree.createNode(
  userAliceNodeId, 'list-shopping', 'Shopping',
);

// Co-ownership sharing — the second-parent pattern from Resources §
// Access control. Adds an edge so `listShoppingId` becomes a child of
// both `user-alice` AND `user-bob`. Bob's existing `admin` on `user-bob`
// now cascades to the list. Caller must hold `write` on the new parent.
await client.dagTree.addEdge(userBobNodeId, listShoppingId);

// "Remove from my account" = delete only this user's edge to the list.
// The list lives on under its other parents.
await client.dagTree.removeEdge(userBobNodeId, listShoppingId);
```

The full surface (`moveNode`, `deleteNode`, `undeleteNode`, `renameNode`, `relabelNode`) is at [API reference § client.dagTree](./api-reference.md#clientdagtree). For the conceptual model (cascading permissions, the two sharing approaches, when to use which), see [Resources § Access control](./resources.md#access-control).

## Worked example: rendering the built-in tree

**Every Nebula app receives the same built-in org/permission tree** — the structure that resources are attached to for permissions and tenancy. Every connected client gets the full tree at `store.resources.lmz.dag.value` (visibility is intentionally not restricted — the sub-second-RTT permission UX wants every client to know the full shape so it can grey out inaccessible nodes locally). Most apps will surface it somewhere in their UI; rendering it as a tree view is the most common form (others: a flat list of accessible nodes, a breadcrumb selector for the current scope, a permission-grant dialog).

A pre-built `<NebulaPermissionTree>` component will likely ship from `@lumenize/nebula-frontend` for the default tree-view case. The from-scratch example below is useful regardless: it's the right starting point when the pre-built doesn't fit your UX, AND it's the blueprint for what the framework-shipped component does internally.

The example pulls together: a single subscribe to the framework-reserved tree resource, walking the embedded `Map<number, ...>` in a `computed`, recursive Vue components, per-instance state, and `provide` / `inject` to broadcast a derived signal down the tree. It includes multi-parent rendering (the tree allows a node to have more than one parent — see [Resources § Access control](./resources.md#access-control) for why and the tradeoffs), virtual "Deleted" / "Orphaned" branches, and search with match highlighting + auto-expand of ancestors of matches.

### The tree resource shape

`store.resources.lmz.dag.value` is a `DagTreeState` (the type name reflects the underlying graph-theory term — see [Resources § Access control](./resources.md#access-control)):

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

**Virtual branches**: `__deleted__` and `__orphaned__` are IDs in the derived `TreeNodeData` tree. The slug regex (`^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$`) rejects underscores, so these IDs can't collide with anything a user could create. Real tree nodes have integer `nodeId`; the derived `TreeNodeData.id` is a string — `String(nodeId)` for real nodes, `__virtual__` strings for virtual branches.

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

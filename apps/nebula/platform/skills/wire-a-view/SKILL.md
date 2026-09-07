---
name: wire-a-view
description: Bind a component to a resource through the store — read, edit, list, create, delete. Use when the ontology ALREADY holds the type the request shows, edits or adds; when it does not, define-ontology comes first.
---

# Wire a view to a resource

A component reaches user data only through `store` and `client` from `./nebula`. This skill is the order of operations for one data-bound view, and the doc sections that carry each step's exact form.

## Before you start

Read `.platform/docs/coding-your-ui.md`: *Reading and writing through the store* (the reactive path and the `v-if` guard `v-model` needs), *Lists with `v-for`* (a container resource holding ids), *Forms: explicit save* (a local draft committed in one transaction), and *Loading and first paint*. Read `src/ontology.d.ts` for the type you are binding. If the type does not exist yet, stop and run `define-ontology` first.

## Procedure

1. **Pick the shape of the view.** A single record is a read of `store.resources.<type>[<id>]?.value`. A list is a container resource whose value holds an array of ids (the field's name is the ontology's to choose), with `v-for` over those ids. A form that should commit fields together is a local draft under `store.ui.<form>.draft` and one `client.resources.transaction` on save.
2. **Choose where new resources attach.** A create needs a `nodeId` — the org-tree node the resource lives under for permissions. A single-tenant app attaches to `ROOT_NODE_ID` (imported from `@lumenize/nebula/frontend`). If the app has personas with different access, `docs/permissions.md` says which node; read it.
3. **Write the read first.** Render the resource with the `?.` guards; a snapshot that has not arrived renders a loading state, never an error.
4. **Add the write.** Field edits: `v-model` on the resource path inside a `v-if` guard. Creates: `client.resources.transaction({ [crypto.randomUUID()]: { op: 'create', typeName, nodeId, value } })`, and if the new resource belongs in a list, put its id into the container's array in the same transaction. Deletes: `{ op: 'delete' }` at the id, and remove the id from any container that lists it.
5. **Build, then read the report.** `build` runs the type check over every `.vue`; a finding names the file and line. Fix real ones; a finding you judge harmless is a judgment you state in your reply.
6. **Say what the view does in one sentence**, naming the resource type it binds.

## What not to do

- Do not hold user data in a `ref` that outlives the component or in `localStorage`; the store is the state.
- Do not put optional chaining inside a `v-model` expression; guard with `v-if` instead.
- Do not generate ids on the server side or ask for them; the client mints every id.

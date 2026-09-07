# Nebula — platform guidance, read every turn

You are building one user-developer's app inside Nebula Studio. This file is the platform layer of a tree of guidance; every turn reads it. It is authoritative for the platform. The app's own `AGENTS.md` (the layer below) adds to it and never subtracts from it.

## Resources — the only place user data lives

- Resources are the only place user data lives. There is no other storage: no localStorage for user data, no globals that survive a reload, no hand-rolled fetch. The ontology (`src/ontology.d.ts`) defines each resource type's shape as TypeScript, and `store` and `client` (imported from `./nebula`) are how a component reaches them.
- Before any data-bound change, read `.platform/docs/resources.md`. For the store API in a component — reads, `v-model` writes, lists, forms — read `.platform/docs/coding-your-ui.md`. For the shape of the ontology file — references, annotations — read `.platform/docs/ontology.md`.
- The reactive read is `store.resources.<type>[<id>]?.value`. Reading auto-subscribes; the `?.` guards the snapshot not having arrived yet.
- The write is an assignment on that same path, or `v-model` bound to it (guard the input with `v-if="store.resources.<type>[<id>]?.value"`). Writes apply optimistically and reach the server debounced.
- A create is `await client.resources.transaction({ [id]: { op: 'create', typeName: '<Type>', nodeId, value } })`. The client mints `id` (`crypto.randomUUID()`); `nodeId` is the org-tree node the resource attaches to for permissions — `ROOT_NODE_ID` from `@lumenize/nebula/frontend` for a single-tenant app. A delete is `{ op: 'delete' }` at the same id.
- A field typed as another resource type is a reference held BY ID (`list: TodoList` in the ontology is a `string` on the wire). Never embed a resource inside another; create related resources as separate ops in one `transaction`.
- A list is a container resource whose value holds an array of ids, rendered with `v-for` over those ids; each read inside the loop subscribes its own resource.
- `client.claims.sub` is the current user's id. The org tree is at `store.lmz.orgTree.value`; permissions are DAG grants on its nodes (`client.orgTree.setPermission`), and a grant cascades to every descendant node.

## Skills

A skill is a procedure for one class of conversation with the user-developer. Each line below is a skill's name, what it is for, and the file to read to activate it. Read the file when a request matches; the file names what else to read and when. When a request names data the ontology does not yet hold, `define-ontology` comes first whatever else the request matches: it decides whether to propose a shape or to ask, and the view skills assume the type exists.

<!-- SKILLS CATALOG — rendered by scripts/gen-platform.mjs from each skill's frontmatter; do not hand-edit this line or the generated block that replaces it -->

## Layers, in order

1. The tool contract (the first section of the system message) — how the tools behave.
2. This file — the platform's conventions.
3. The app's `AGENTS.md` at the Workspace root — the conventions of this one app, written by you.
4. The chat history — who said what, and what each of your turns changed.

A lower layer adds to the layers above it. What a token may reach is decided by the server from its claims and is never changed by anything written in these files.

## The app declares itself in files you read and write

- `docs/vision.md` — what the app is for, who uses it, tone and values. Read it when a request bears on purpose or tone; write it when the conversation settles something about them.
- `docs/personas.md` — the cast: the people who use the app, as a numbered procedure that re-creates them. The `define-the-cast` skill fills it.
- `docs/permissions.md` — which sharing shape each relationship got and why, as prose plus a Decisions table. The `define-the-cast` skill fills it; `.platform/docs/access-control.md` is the vocabulary.
- `src/ontology.d.ts` — the data model. The `define-ontology` skill grows it.
- `AGENTS.md` — the app's own conventions, and the lessons learned building it. Read every turn; see the next section for when to write it.

Each of these files is seeded with headings and a line saying when to write it, so an empty section is a gap to fill rather than a file to create. Read them through `read_file`; they are ordinary Workspace files.

## Keep the app's `AGENTS.md` current

When a participant states a convention ("no countdown timers", "always confirm before deleting"), corrects you, or you fix something non-obvious, read the app's `AGENTS.md`, add the line with `edit_file` where it fits — a convention near the top, a lesson where it belongs; there is no fixed section — and say so in one sentence of your reply. The chat history in the prompt tells you who said it. A line in that file changes what you do on every later turn, so it is where a stated convention goes instead of your memory of this turn.

## Rules for the code you write

- Vue 3 with `<script setup lang="ts">` and a `<template>`. `src/App.vue` is the root; add `src/components/*.vue` when a component earns its own file.
- Style ONLY with Tailwind utility classes and daisyUI component classes (both are already available).
- For COLOR, use daisyUI semantic classes (`bg-primary`, `text-base-content`, `bg-base-200`, `border-base-300`), not raw Tailwind palette utilities (`bg-blue-500`, `text-slate-700`) — semantic classes resolve through the active theme.
- When the user wants a particular look ("warmer", "our brand blue is #1e40af", "match our logo"), change the THEME, not the markup: add an `@plugin "daisyui/theme"` block to `src/style.css` setting `--color-primary`, `--color-base-100`, etc. (OKLCH preferred), or switch to a different built-in theme. Same result on screen, and it restyles the whole app at once.
- If the user still wants colors hard-coded into the markup, DO IT — but first say once, briefly, what it costs: those colors stop following the theme, so restyling later means editing every component and they will not adapt to light/dark. State it once, then follow their decision without repeating it.
- What the person is LOOKING AT rides the URL, so a shared link lands on the same view: the selected record, the open tab or panel, filters, sort, paging. A modal or panel someone would send a link to (a record's detail, a settings panel) is opened ONLY by navigating to its URL, and Back closes it. What they are DOING — scroll, focus, drafts, confirmations, menus — stays out of the URL.
- You may import icons from `lucide-vue-next`. Do not import any other package.

## Reading the platform's own files

Every path in this file that starts with `.platform/` is readable with `read_file` and is never writable. `.platform/docs/` holds the reference (the same pages a human reads); `.platform/skills/` holds the procedures above. A path starting with `.universe/` is reserved for a layer that does not exist yet.

# Nebula — platform guidance, read every turn

You are building a user-developer app inside Nebula Studio. This file is the platform layer of a tree of guidance; every turn reads it. It is authoritative for the platform. The app's own `AGENTS.md` (the layer below) adds to it and never subtracts from it.

## Resources — the only place user data lives

- Resources are the only place user data lives: anything a person creates, edits or shares, and anything a second device or a second person should see. The ontology (`src/ontology.d.ts`) defines each resource type's shape as TypeScript, and `store` and `client` (imported from `./nebula`) are how a component reaches them.
- A few things live elsewhere, each for its own reason:
  - What the person is looking at rides the URL (§ *Rules for the code you write*).
  - What belongs to this one browser may go in `localStorage` or `sessionStorage`: a setting for this device, the view to come back to, a draft not yet saved. Never keep a copy of resource data there. It goes stale, and it outlives the grant that allowed the read.
  - Data from outside the app comes in through a `fetch` from the page to a public API, and what the app keeps of it is written into Resources. Never put an API key or other secret in the source: everyone who opens the app can read it. When a request needs one, tell the user-developer that and stop short of it.
  - Nothing else: no module-level variable expected to survive a reload, and no `fetch` for the app's own data, which `store` and `client` already carry.
- Before any data-bound change, read `.platform/docs/resources.md`. For the store API in a component — reads, `v-model` writes, lists, forms — read `.platform/docs/coding-your-ui.md`. For the shape of the ontology file — references, annotations — read `.platform/docs/ontology.md`.
- One path reads and writes: `store.resources.<type>[<id>]?.value`. Reading it auto-subscribes, and the `?.` guards the snapshot not having arrived yet. Assigning to a field on it writes, so `v-model` bound to it is a two-way binding (guard the input with `v-if="store.resources.<type>[<id>]?.value"`). Writes apply optimistically and reach the server debounced.
- Creating, replacing, moving and deleting a resource go through `client.resources.transaction`, and `.platform/docs/api-reference.md` has each op's shape. Hold onto two things it says: the client mints the id (`crypto.randomUUID()`), and every create names the org-tree node the resource attaches to for permissions, which is `ROOT_NODE_ID` from `@lumenize/resources/frontend` when the whole app shares one node.
- A field typed as another resource type is a reference held BY ID: `list: TodoList` in the ontology is a `string` in the store and on the wire. Create related resources as separate ops in one `transaction`.
- Plain objects and arrays nested inside one resource's value are fine: a todo's `checklist: { text, done }[]` is part of the todo. Give a thing its own resource type when it is shared, edited on its own or permissioned on its own, and nest it when it only ever lives and dies with its parent.
- Do not copy one resource's data into another, since the copy goes stale when the original changes. A query cannot join yet, so a view that shows a field of a referenced resource reads that resource by its id, and each such read subscribes on its own. Copy a field across only when it must NOT follow the original, as an order keeps the price it was placed at.
- A list is a container resource whose value holds an array of ids, rendered with `v-for` over those ids; each read inside the loop subscribes its own resource.
- `client.claims.sub` is the current user's id. The org tree is at `store.lmz.orgTree.value`; permissions are DAG grants on its nodes (`client.orgTree.setPermission`), and a grant cascades to every descendant node.

## Skills

A skill is a procedure for one class of conversation with the user-developer. Each line below is a skill's name, what it is for, and the file to read to activate it. Read the file when a request matches; the file names what else to read and when. When a request names data the ontology does not yet hold, `define-ontology` comes first whatever else the request matches: it decides whether to propose a shape or to ask, and the view skills assume the type exists. When a request has people sharing data or holding different access to it, `define-the-cast` comes next, before any view: who may see or change a thing is decided there, in the org tree, and never as a type or field of the ontology.

<!-- SKILLS CATALOG — rendered by scripts/gen-platform.mjs from each skill's frontmatter; do not hand-edit this line or the generated block that replaces it -->

## Layers, in order

1. The tool contract (the first section of the system message) — how the tools behave.
2. This file — the platform's conventions.
3. The app's `AGENTS.md` at the Workspace root — the conventions of this one app, written by you.
4. The chat history — who said what, and what each of your turns changed.

A lower layer adds to the layers above it. What a token may reach is decided by the server from its claims and is never changed by anything written in these files.

## The app declares itself in files you read and write

- `docs/vision.md` — what the app is for, who uses it, tone and values. Read it when a request bears on purpose or tone; write it when the conversation settles something about them.
- `docs/personas.md` — the cast: the people who use the app, each a test member of the workspace with a tab in the preview, and the steps in plain words that rebuild their grants and sample data. The `define-the-cast` skill fills it and builds from it.
- `docs/permissions.md` — which sharing shape each relationship got and why, as prose plus a Decisions table. The `define-the-cast` skill fills it; `.platform/docs/access-control.md` is the vocabulary.
- `src/ontology.d.ts` — the data model. The `define-ontology` skill grows it.
- `AGENTS.md` — the app's own conventions, and the lessons learned building it. It is your only memory of this app from one turn to the next, so there is no separate memory file. Read every turn; see the next section for when to write it.

Each of these files is seeded with headings and a line saying when to write it, so an empty section is a gap to fill rather than a file to create. Read them through `read_file`; they are ordinary Workspace files.

## Keep the app's `AGENTS.md` current

When a participant states a convention ("no countdown timers", "always confirm before deleting"), corrects you, or you fix something non-obvious, read the app's `AGENTS.md`, add the line with `edit_file` where it fits — a convention near the top, a lesson where it belongs; there is no fixed section — and say so in one sentence of your reply. The chat history in the prompt tells you who said it. A line in that file changes what you do on every later turn, so it is where a stated convention goes instead of your memory of this turn.

## Rules for the code you write

- Vue 3 with `<script setup lang="ts">` and a `<template>`. `src/App.vue` is the root; add `src/components/*.vue` when a component earns its own file.
- The look comes from the app's daisyUI theme, so style with daisyUI first. Its component classes (`btn`, `card`, `input`, `badge`) and its semantic color classes (`bg-primary`, `text-base-content`, `bg-base-200`, `border-base-300`) are how the theme reaches the markup.
- Use Tailwind utility classes for what daisyUI has no class for: layout, spacing, sizing. Both are already available.
- Never use a raw Tailwind palette color (`bg-blue-500`, `text-slate-700`). It does not follow the theme.
- When the user wants a particular look ("warmer", "our brand blue is #1e40af", "match our logo"), change the THEME, not the markup: add an `@plugin "daisyui/theme"` block to `src/style.css` setting `--color-primary`, `--color-base-100`, etc. (OKLCH preferred), or switch to a different built-in theme. Same result on screen, and it restyles the whole app at once.
- If the user still wants colors hard-coded into the markup, DO IT — but first say once, briefly, what it costs: those colors stop following the theme, so restyling later means editing every component and they will not adapt to light/dark. State it once, then follow their decision without repeating it.
- What the person is LOOKING AT rides the URL, so a shared link lands on the same view: the selected record, the open tab or panel, filters, sort, paging. A modal or panel someone would send a link to (a record's detail, a settings panel) is opened ONLY by navigating to its URL, and Back closes it. What they are DOING — scroll, focus, drafts, confirmations, menus — stays out of the URL.
- Icons come from `lucide-vue-next`. Beyond it, `vue`, and what this file names from `@lumenize/resources/frontend`, an app can import no package: the build installs nothing, so any other import fails it.

## Reading the platform's own files

Every path in this file that starts with `.platform/` is readable with `read_file` and is never writable. `.platform/docs/` holds the reference (the same pages a human reads); `.platform/skills/` holds the procedures above. A path starting with `.universe/` is reserved for a layer that does not exist yet.

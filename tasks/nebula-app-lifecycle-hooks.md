# An app's own code creates its nodes when a Star moves onto a new ontology version

**Status:** Pass 1, split from [nebula-galaxy-builds-its-tree.md](nebula-galaxy-builds-its-tree.md) on 2026-11-22; phases are not written. It is reviewed once [nebula-query-upgrade.md](nebula-query-upgrade.md) has landed, since that task changes the `query` an app's hooks call, and once an experiment has measured C3. It builds the hook nebula-query-upgrade.md's D12 decided, delivers that task's DI22, and lands before the first invite (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `D` a decision Larry made, and `Q` an open question. C4 is the fourth claim raised, wherever it sits. A gap is an item removed or answered. Items raised before the split keep their numbers, so a gap may also be an item that stayed in nebula-galaxy-builds-its-tree.md, whose decisions this file cites by name, as in nebula-galaxy-builds-its-tree.md's D6.

## Objective

**An app's own code creates the orgTree nodes its pages name, in every Star, before the Star answers any call at the version that names them. The code lives in the app's `src/ontology/` folder beside its types, as exports named after the lifecycle hooks our hosts implement in-process, and runs in a facet. It does only what a page can do: it calls the operations a page calls, sandboxed, as a system principal such as `system:acme.crm`, which holds dominion over the Star and no grant.**

```ts
// src/ontology/types.d.ts — the app's types, the schema the compile reads
export interface List { title: string }
export interface Item { list: List; title: string; done?: boolean }

// src/ontology/index.ts — what pages import, and the hooks the platform calls
import { ROOT_NODE_ID } from '@lumenize/resources/client';
export type * from './types';
export const LISTS_NODE_ID = '7c1e9a4b-2f0d-4e8a-9b3c-5d6e7f809a1b'; // every List lives here

// Runs in each Star, once per version it installs
export async function onNewOntologyVersion({ orgTree }) {
  // Creates the node, with any starting grants, only where it is absent, so a Star
  // whose admin renamed or moved `lists` keeps it as the admin left it
  await orgTree.createNode(LISTS_NODE_ID, ROOT_NODE_ID, 'lists', 'Lists');
}

// src/App.vue — a page imports from the folder and queries at the node, in any Star
import { LISTS_NODE_ID } from './ontology';
client.resources.subscribeQuery({ typeName: 'List', nodeId: LISTS_NODE_ID, filter: {} });
```

What happens when a page built against version `3f2a9c…` makes its first call on a Star that runs `8d10e4…`:

1. The Star asks its Galaxy for its current row, as today, and receives `3f2a9c…`'s.
2. The Star stages the row and runs the install code against it. Calls pinned to `3f2a9c…` are answered `checking` meanwhile, and calls pinned to `8d10e4…` still run.
3. When the install code finishes, the Star records `3f2a9c…` as installed, tells each page on `8d10e4…` to reload, and answers the waiting page's next retry.
4. If the install code throws, the Star discards the staged row and stays on `8d10e4…`.

## Context

**An app has no way to create its own nodes.** [nebula-query-upgrade.md](nebula-query-upgrade.md)'s D9 has a page query at a node its source names as a constant, as our Galaxy's pages query at `MESSAGES_NODE_ID`. Something has to create that node in every Star, and nothing an app writes runs on a Star. A page can create one only for a viewer holding `write` at the parent. So the `define-the-cast` skill creates `lists` from the founder's tab with `crypto.randomUUID()`: `.dev` then holds a `lists` node whose id no page knows, and a tenant Star holds none until an admin opens the app.

**Our Galaxy does the same work first, in-process** (nebula-galaxy-builds-its-tree.md's D9 and D11). Its `onStart` creates `chat`, `messages` and `rounds` at every start through the idempotent `createNode`, inside `lmz.asSystemPrincipal`, which builds `system:acme.crm` from the node's name with dominion over its scope and no grant. This file gives an app the hooks, `onNewOntologyVersion` and `onStart`, defines the object each receives, and runs them across a facet.

**Larry chose the hook on 2026-11-21 (D1), and the folder that holds it on 2026-11-22 (D2).** The ids a page imports have to exist at runtime, so they live in a `.ts` file. The types stay in a `.d.ts`, which can hold no value.

What stands in the way today:

- **B1. The ontology is one declaration file, `src/ontology.d.ts`, so it holds no value a page can import.** A declaration file emits nothing, so a constant written there is `undefined` at runtime.
- **B2. Nothing async can run between receiving a version and answering at it.** `#install` is synchronous and records the row in one write (C1), and our hosts' hooks run inside it synchronously. An app's hook answers across a facet, so it cannot.
- **B3. A version is the hash of one file.** `#pendingOntology` names it as `git.hashBlob` of `src/ontology.d.ts`, and `#land` refuses a row whose `types` do not hash to it (C10). A change to the install code alone would make no new version, so no Star would run it.
- **B4. Nothing loads app code into a Star except the validator.** `getParserValidatorFacet` loads one generated module through the Worker Loader, and a Star calls only `parse` and `parseBatch` on it.

The sections that follow say what the install step becomes for an app, the claims that design rests on, and the question Larry decides before phases are written.

## Goals

1. **Every node a page names exists in every Star before the page's first call answers.** Today an app's node exists only where a viewer with `write` at its parent created it (Context).
2. **An admin's change to a node survives every later version.** nebula-galaxy-builds-its-tree.md's D6 makes `createNode` leave an existing node as it stands, so an app's install code inherits this.
3. **The install code can do only what a page can do, and its writes say who made them.** It calls the operations a page calls, each checked as a page's call is, and each write records the principal it ran as (ADR-016).

## Relationships

- **After [nebula-galaxy-builds-its-tree.md](nebula-galaxy-builds-its-tree.md)**, whose D4, D6, D8, D9 and D17 this builds on: the principal and its dominion, the create, the restore at each start, and our Galaxy's in-process form of the same work.
- **After [nebula-query-upgrade.md](nebula-query-upgrade.md)** (Larry, 2026-11-22). The `query` this file hands an app's code takes the descriptor that task changes. This file delivers that task's DI22, which has every Star create an app's nodes at install. Until it lands, a generated app has no node of its own to name in a query, which costs only our own scenarios, since nobody else builds apps before the first invite.
- **Before the first invite in [nebula-pre-alpha.md](nebula-pre-alpha.md).** Moving `src/ontology.d.ts` into `src/ontology/` breaks every Workspace that holds it, and before the invite no Workspace belongs to anyone but us.

## Current state

Built already:

- **The scaffold's `src/ontology.d.ts`** (`container/app/src/ontology.d.ts`, embedded by `gen-scaffold.mjs`). *Adapted:* it moves to `src/ontology/types.d.ts`, beside a new `src/ontology/index.ts` (DI1).
- **The build box's ontology step**, `runJob` step 1 in `container/compiler/job.ts`, which reads `src/ontology.d.ts` and calls `compileOntologyVersion`. *Adapted:* it reads `src/ontology/types.d.ts` and also bundles `src/ontology/index.ts` (DI7).
- **`compileOntologyVersion` and `extractTypeMetadata`.** *Carried over unchanged:* they are handed the types as text, never a path (C7).
- **`OntologyVersionRow`**: `version`, `types`, `validatorBundle`, `relationships`, `fields`, `indexes`. *Adapted:* it carries the folder's files, so `#land` can hash them again, the bundle of `index.ts`, and whether `index.ts` exports `onStart` (DI11).
- **The Galaxy's `ONTOLOGY_PATH`, `#readOntology`, `#pendingOntology` and `#land`'s hash check.** *Adapted:* they hash the folder `src/ontology/` (D5).
- **`Resources.#install`,** which records a version's row and calls no code of a host's or an app's. *Adapted:* for an app it stages the row, runs the install code in the facet, and only then records it (DI2).
- **`#settle` and `#askedAt`**, which answer `checking` while an ask waits. *Carried over:* a call at a version still installing is answered the same way.
- **`getParserValidatorFacet`**, the precedent for loading a row's bundle as a facet. *Carried over* as the pattern the install code's facet follows.
- **What reads the ontology's path**: `sfc-check.ts`'s `ontologyTypesDts`, the codegen loop's `ontologyDts` request part, `SKIPPED_FOR_ONTOLOGY`, and ADR-024's version wording. *Adapted:* they read the new path. The global `LumenizeOntology` that `ontologyTypesDts` writes imports `./ontology`, which then finds the folder's `index.ts` and the types it re-exports (C13).
- **The guidance the model reads**: `platform/AGENTS.md`'s declared files, the `define-ontology`, `wire-a-view` and `define-the-cast` skills, and `ontology.md` and `coding-your-ui.md`. *Adapted:* they say where nodes come from (DI9).
- **The `/live` scenarios and tests that write the ontology file**, which `grep -rln 'ontology\.d\.ts' apps/nebula/test apps/nebula/harness/scenarios` lists. *Adapted* mechanically.

## Design intent

- **DI1. An app's ontology is the folder `src/ontology/`** (D2).
  - **`types.d.ts` holds the types, the schema the compile reads.** A declaration file can hold no value, so only types reach the compile.
  - **`index.ts` re-exports the types, and exports the ids pages share with the install code and the hooks the platform calls,** `onNewOntologyVersion` and, when the app needs one, `onStart`. A page imports all of it from `./ontology`, and the types reach the store through `LumenizeOntology`, as today (C13).
  - **The model may split `index.ts` into more files,** importing each into `index.ts` and re-exporting it, as a Worker's `src/index.ts` gathers its handlers.
- **DI2. A Star runs an app's install code between receiving a version and recording it, and answers no call at that version until it has recorded it.**
  - **It stages the row, runs the install code, and then records the row as installed.** Calls pinned to the staged version are answered `checking` until then, and calls at the installed version keep running.
  - **The run is handed to `ctx.waitUntil`**, so it holds the Star while it runs.
  - **An eviction mid-run leaves the version staged, and the next call starts the install code again from the beginning.** So install code must be safe to run twice, which nebula-galaxy-builds-its-tree.md's D6 makes it.
  - **A Client retries `checking` for under two seconds (C2)**, so install code that takes longer has its page reload and ask again.
- **DI3. Install code that throws leaves the Star on the version it had.** The staged row is discarded, the error is logged at `error`, which raises a Workers Issue, and a waiting page's next retry is answered stale. How the model learns of it on `.dev` is Q6.
- **DI4. The install code runs in a facet and reaches the plane only through what the Star hands it.**
  - **The facet is loaded through the Worker Loader with `globalOutbound: null`,** from the row's bundle, under a bundle id built as the validator's is (C4). It has no network and no binding (C3).
  - **The Star passes in an object holding the operations a page calls,** `createNode` and the tree's other methods, `transaction`, `read` and `query`, with each method answering across the facet. Our Galaxy's `onStart` calls the same operations in-process and receives no such object, so this file defines it.
  - **Each call crosses a trust boundary, so the Star checks it as it checks a Client's** (`security.md`). It wraps the call in `lmz.asSystemPrincipal`, fixes the version to the staged one, and calls the plane's operation, which validates its arguments and checks the tree under those claims.
- **DI7. The version is the hash of the folder `src/ontology/`, git's tree id for it** (D5). A change to any file there, or a file added, removed or renamed, is a new version, which every Star installs and runs. The box's bundle step refuses a relative import from outside the folder, so no file the install code runs escapes the hash.
- **DI9. The guidance says where an app's nodes come from.** `platform/AGENTS.md` lists the folder and both its files. The `define-ontology` skill writes the ids in `index.ts`, and the `define-the-cast` skill creates only nodes for one person or one record, under nodes the install code made. `ontology.md` documents the install code, and its blocks are `@check-example` once a phase makes them real. The embed and the scaffold are regenerated when they land (`studio-guidance.md`).
- **DI10. A `.dev` wipe is followed by a first install, so the install code makes the app's nodes again** (C9).
- **DI11. An app's `onStart` export runs at every start, after the grants nebula-galaxy-builds-its-tree.md's D8 writes back.** The row records whether `index.ts` exports it, so a Star loads the app's facet at start only when it does. A throw is logged at `error` and the start goes on.

Claims the design rests on:

- **C1.** `#install` records a row in one `transactionSync` and returns nothing to wait on. Its callers are `#settle`, which every Client op's gate reaches, and `#onOntologyPulled`, a fire-back handler.
- **C2.** While an ask waits, `#settle` answers `OntologyStaleError` with `checking: true`, and `ASK_BOUND_MS`'s JSDoc says a Client's retries span under two seconds.
- **C3.** A Dynamic Worker reaches only what it is handed, and each call on a stub it was given is an RPC back into the code that gave it (Cloudflare's Dynamic Workers docs, *Bindings* § *Capability-based sandboxing*). Passing an `RpcTarget` into a facet's method is not yet measured here.
- **C4.** `env.LOADER.get` caches by bundle id across the whole Worker (`durable-objects.md` § *Dynamic Worker Loader cache*). The validator's id names the app and the version, so a tenant Star shares its app's bundle, and `.dev` names itself (`star.ts`'s `#ontologySource`).
- **C7.** `compileOntologyVersion` takes `{ version, types }`, the types as text, and `runJob` reads that text from one fixed path, so moving the file changes only that path.
- **C9.** A `.dev` wipe drops the tree's tables and every `ontology:` key, so the next call's install is a first install (`#wipe`'s JSDoc).
- **C10.** `#land` hashes the row's `types` with `git.hashBlob` and refuses the row unless that hash is the version the build asked for.
- **C11.** A tab call's answer reaches its turn through a result handler, `onTabAnswer`, and nothing waits on it (`runInTab`'s JSDoc).
- **C12.** Nothing is published yet, so today an app version installs only on `.dev` (`getCurrentOntology`'s JSDoc).
- **C13.** Under tsc 5.9 with the scaffold's tsconfig, `src/ontology/types.d.ts` stays in the program, `./ontology` resolves to `src/ontology/index.ts`, and `export type *` carries the types to `LumenizeOntology`, so a page writing a field `Item` lacks fails the check. With `src/ontology.ts` beside `src/ontology.d.ts`, tsc leaves the `.d.ts` out, `./ontology` resolves to the `.ts`, and under the scaffold's `skipLibCheck` every type in `LumenizeOntology` becomes `any` without an error. Measured in scratch projects on 2026-11-22.
- **C14.** `#pendingOntology` names the version from the Workspace before the build, as `git.hashBlob` of the types file, and the build box compiles the ontology only when the Galaxy hands it a version (`runJob` step 1).

## Constraints

- **[ADR-001](../docs/adr/001-typescript-as-schema.md)**: the types in `src/ontology/types.d.ts` stay the schema, and the ids in `index.ts` are values, not a second schema.
- **[ADR-003](../docs/adr/003-continuation-messaging.md)**: the facet call stays inside one Durable Object. A `.dev` install's answer reaching the Galaxy crosses a hop, so it comes back by continuation (Q6).
- **[ADR-007](../docs/adr/007-shared-node-security-core.md)**: the install step is the plane's, so every host runs it by composition.
- **[ADR-010](../docs/adr/010-random-opaque-keys.md)**: a node the app names is a random id written as a constant, never found by its slug.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: every write the install code makes records the claims it ran under.
- **[ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)**: a call runs only at the version its page was built against, and only once the Star has installed it. ADR-024 names the version as the hash of `src/ontology.d.ts`, and D5 makes it the hash of `src/ontology/`.
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: it says a node does its own bookkeeping as its system principal, in a block our own code writes. Install code is the app's, run on the server in a sandbox, so ADR-025 gains that sentence.
- **`durable-objects.md`**: the run is handed to `ctx.waitUntil`, nothing depends on the Star staying awake, and a bundle id names its host.
- **`security.md`** § *Trust-boundary crossings*: the facet's calls are checked as a Client's are (DI4).
- **`live.md`**: a `/live` scenario builds an app whose install code creates a node, renames that node as its admin, builds a new version, and finds the node as the admin left it.
- **`studio-guidance.md`**: the platform layer and the scaffold are regenerated and committed with the guidance.

## Beyond this task

- **More hooks could be exports of `src/ontology/index.ts`, as `onNewOntologyVersion` and `onStart` are** (Larry, 2026-11-21 and 2026-11-22).
- **A migration of one resource could be lazy,** an export handed the old value where it is read and returning the new one.
- **A structural migration could see every resource and run eagerly, in batches.** Each batch would be an alarm run that saves its cursor in the write that saves its results, and a moment makes a natural cursor. A failed alarm retries (`durable-objects.md` § *A failed `alarm()` retries by one rule*), so each batch would have to be safe to run twice.
- ⚠️ Design consideration: **in a tenant Star, install code runs as that Star's root admin.** Today it reaches no tenant Star, since nothing is published (C12), and it has no network to send data out with. When a publish runs it in tenant Stars, Larry's line that collaborators never see a tenant's data rests on what the code grants, which matters once `anyone` exists (nebula-accounts-and-apps-have-names.md's D7).

## Decisions

This file also builds on nebula-galaxy-builds-its-tree.md's D3, D4, D6, D7, D8, D9, D17 and D21, which stay there. Its review confirms which scope's system principal an app's code runs as: D17 there expects the Galaxy's, `system:acme.crm`, which holds dominion over every tenant Star, and whose claims reach a Star only once a call can carry them (that file's § *Beyond this task*). The same section leaves this file the member who creates a child under a fixed id before our code or an app's does: that node answers `'differs'` at every install and never lands under its parent.

| Decision | Alternatives weighed |
|---|---|
| **D1. An app's own code runs when a Star moves onto a new ontology version, in a facet, as a system principal holding dominion over the Star, with only the operations a Client's calls reach** (Larry, 2026-11-21, recorded as nebula-query-upgrade.md's D12) | A declared list of nodes in the ontology, read by the compile, which would be a second way to create nodes beside the code. Creating the nodes in `onStart`: a version arrives while a Star runs, so its nodes have to exist before calls at it, which only an install comes before, and every app would load its facet on every start. Pages creating the nodes, which only a viewer with `write` at the parent can do |
| **D2. The ontology is the folder `src/ontology/`: `types.d.ts` holds the types, and `index.ts` re-exports them and exports the ids and `onNewOntologyVersion`** (Larry, 2026-11-22; was Q1). Larry: paying for the rename now buys a structure we live with for good, and one file of standard exports leaves no special filename per hook | `src/ontology.ts` beside `src/ontology.d.ts`: tsc leaves the `.d.ts` out, so the store's types become `any` with no error (C13). `src/ontology-version.ts` or `src/star.ts` beside an unchanged `src/ontology.d.ts`: no rename, but pages import from two paths for good. One `src/ontology.ts` holding the types and the ids: the compile would have to refuse a value or an `import`. A file per hook, `src/on-new-ontology-version.ts`: each later hook adds another special file |
| **D5. The version is the hash of the folder `src/ontology/`, git's tree id for it** (Larry, 2026-11-22; was Q5). The Galaxy takes it from the Workspace before the build, as it takes today's file hash (C14), and `#land` hashes the files the row carries again. The box's bundle step refuses a relative import from outside the folder | `types.d.ts` and the bundle of `index.ts`: the bundle exists only once the box has run, so the Galaxy could not name a version before the build, and a new bundler output would make a new version. The types alone, as today: install code changed on its own would run nowhere |

## Open questions

- **Q6. How install code that fails on `.dev` reaches the model.**
  - **(a) The landing asks `.dev` to install at once, and the Star's answer reaches the turn by a result handler, as a tab call's answer does (C11).** The turn that wrote the mistake reads it and can fix it.
  - **(b) The failure stays on the Star.** It is logged at `error`, the page is answered stale, and the model hears of it from a person.
  - **(c) The build box runs the install code against an empty tree before the landing.** That catches code that throws on any tree, and not code that throws only on the tree a Star holds. It also needs a stand-in for the plane in the box.
  - **Recommendation:** (a).

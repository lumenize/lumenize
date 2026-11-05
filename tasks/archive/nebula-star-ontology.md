# Each Star runs the ontology its Galaxy calls current

> ✅ **Built and archived 2026-10-12.** All six phases landed on `pre-alpha`, in `f1a4491` through `1e2e3da`; Phase 6, added at the retro, deleted the Client's version gate that Phase 3 built. The deployed pass is in § *Build notes* under Phase 5. ADR-024 was renamed [024-two-versions-keep-an-app-in-step.md](../../docs/adr/024-two-versions-keep-an-app-in-step.md) while Larry reviewed it, and now names two versions. The status line below is the file's state when it was written.

**Status:** Pass 2 written and its Stage 2 review applied 2026-10-11; ready for `/build-task`. Pass 1 was drafted 2026-10-10 and reworked with Larry on 2026-10-11, and its Stage 1 review was resolved the same day. Split out of [nebula-testing-with-personas.md](../nebula-testing-with-personas.md) at its third Stage 1 gate, and gates it.

## Objective

**Every Star runs the ontology its Galaxy calls current for it: a Galaxy's `.dev` Star always runs the data types of the app's last build that landed, and every other Star the last published version, which stays empty until `publish()` exists.**

## Context

**The ontology is one file, and its history is git's.** `src/ontology.d.ts` lives in the Galaxy's Workspace, and the Workspace's git history is the record of every change to it.

**A Star validates every write against a compiled form of that file, and only the build can compile it.** The compiled form is an `OntologyVersionRow`: the types, plus a typia validator bundle the Star loads into a sandboxed facet. Its `version` is the file's content hash, such as `3f2a9c…`. The Worker never runs `tsc`; the build container does. So the compiled row is a build artifact, like `dist/`, and lives in `.nebula/`, the folder the Galaxy owns and git does not track.

**When the Galaxy collapse moved compiling into the build container and replaced the push to Stars with each Star's own pull (2026-08-28), the ontology half was left broken, to be fixed later, and later is now.** The build still compiles the ontology, but the Galaxy answers a Star's request from a folder only an unused method writes. So the dev Star gets `null`, and the preview runs with no data types. The personas task needs the fix first, because provisioning hands the dev Star the Galaxy's current row. The fix reaches every app's preview, not only personas, so it is a task of its own.

**How it should work.** One handshake serves every Star, `.dev` or not, and the page drives it:

1. **A build, or later a publish, produces a version**, and every page the Galaxy serves carries it in its `nebula-scope` meta, which the Galaxy writes into the HTML as it serves it. A page here is the user-developer's app with our Client, `NebulaClient`, running inside it.
2. **Every op the page sends on data the ontology types carries that version**, whether a read, a subscribe or a transaction, and the Star compares it with the version it has installed. The org tree is not typed by the ontology, so its ops carry none.
3. **If they match, the op runs.** An op never runs at any other version: the Star refuses it until the page and the Star match, either by the Star installing or by the page reloading.
4. **If they differ, the Star refuses the op as a version mismatch and calls `Galaxy.getCurrentOntology()`.** The refusal goes to our Client, never to the app's code.
   - **The refusal is the op's returned value**, an `ontology-stale` error carrying the version the page sent and the version the Star has installed. It is flagged as temporary, because the Star has just called its Galaxy and does not yet know what it will install. Today that flag is named `installing`, which overclaims, since the Star installs nothing when the page is the old one; this task renames it `checking`.
   - **The Star makes the call with `lmz.call`, naming `resourcesResults.onOntologyPulled` as its result handler.** `getCurrentOntology()` returns the whole row: the version, the types and the validator bundle. The row reaches the handler as a message of its own, because nothing waits on a reply across a hop ([ADR-003](../../docs/adr/003-continuation-messaging.md)), and the handler installs it unless the Star already holds that version.
   - **The Star makes one call at a time.** It remembers that it has asked, so ops that mismatch while the answer is on its way wait on the same call; an eviction mid-call costs one extra.
   - **The Star installs what the Galaxy calls current, never the version the page sent**, so one tab on an old build cannot move a Star. In the product a Star is `getCurrentOntology()`'s only caller; harness scenarios also call it as a probe.
5. **Our Client waits the mismatch out.** Each op answered `checking` is sent again a moment later, up to a few times.
   - **If a retry runs, the page is current.** The Star's call to its Galaxy takes tens of milliseconds and a round trip to the Star a few hundred, so the first op after a version change waits about a second, longer when the Galaxy or the validator starts cold, which a spinner or a placeholder already covers.
   - **If the retries run out, the page is on an old build, and it reloads.** It may reload sooner: installing a version sends every page subscribed to the Star a stale notice, which drops their subscriptions. A notice naming another version reloads the page, and the fresh page carries the current version. A notice naming the page's own version, or none, as a wipe's does, means only that its subscriptions were dropped, so the Client subscribes again.
   - **If no reload happens, the wait still ends.** A reload can be skipped when it would repeat one for the same version, or when the app installed its own `onShouldRefreshUI`. Then each op whose retries run out resolves as `ontology-stale`, the outcome `transaction()` already documents, so the app's spinner stops and it can say the page is out of date.
   - **No step needs to know which version is newer,** because a version is a content hash and hashes have no order; only migration will need one (step 7).
6. **What counts as current depends on whether the Star is the `.dev` Star.** The `.dev` Star runs the version of the last build that landed. Nothing piles up there: each build that lands replaces its compiled row. Every other Star runs the last published version, which fast-follow Item 4 builds; until then there is none.
7. **Data that no longer fits is wiped on the `.dev` Star, when a person asks, and migrated everywhere else.** Migration is later work: a resource read at a newer version than it was last written is migrated forward in place, one published version at a time ([nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path*).

The rest of this file covers what the change adds, adapts and removes, and how it keeps a build's row away from a Star with real users.

## Goals

1. **What the old models left behind goes, so nobody builds on it again.** The code is half old and half new: `applyOntology` and its folder of versions, the wipe-on-install path, `getOntologyVersion`, the flag named `installing`, and the comments and guidance that describe a separate Apply. Each goes, or is rewritten to the handshake above. Today the scenarios that need data types call `applyOntology` themselves, which is why the old half never showed up red.
2. **The preview runs what was just built.** Jennifer adds `dueDate?: string` to `Deal` in chat, the build runs, and her preview can write a `Deal` with a due date. Today the preview runs no types at all.
3. **Personas' provisioning has a row to hand its dev Star.** Today the Galaxy's current row is `null` for every real Galaxy.
4. **Nothing a build compiles reaches a tenant Star before something is published.** Today `getCurrentOntology` answers every descendant Star, and the one fence on a breaking row, `#install` failing to wipe off `.dev`, goes with `wipeOnInstall`.
5. **The model tells the user what actually happens.** Today the `define-ontology` skill's step 6 says applying the ontology is the user-developer's own step, outside the chat, and no such step exists.

## Relationships

- **It gates [nebula-testing-with-personas.md](../nebula-testing-with-personas.md)**, whose provisioning hands the dev Star the last build's compiled row.
- **[nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 4* and § *Item 5* own the published half.** This file owns the `.dev` Star's current row, `getCurrentOntology` answering by kind, and the deletions; Item 4 owns the order of published versions, where they and their migrations live, and where a published row is compiled; Item 5 owns serving a published Star's pages. The file that once held the history, [icebox/nebula-ontology-history-file.md](../icebox/nebula-ontology-history-file.md), was iceboxed on 2026-10-11.
- **Nothing open gates it.**

## What changes

**New:**

1. **The dev Star's current row, kept in the Galaxy's own storage.** When a build lands, the Galaxy copies the row it compiled into its Durable Object storage under `galaxy:devOntologyRow`, with the same `kv.put` a Star's install uses, where nothing a build runs can write. One synchronous helper reads it, for three callers: `getCurrentOntology`'s answer to the `.dev` Star, the version written into the served page, and personas' hand-off.
2. **`getCurrentOntology` answers each Star by kind.** The `.dev` Star gets the last landed build's row; every other caller gets the last published one, and there is none until `publish()` exists. Today it is `@mesh()`-decorated with no guard and answers every descendant Star with the same row.
3. **The `.dev` Star's own validator cache key.** Today `star.ts` keys every Star's facet `${galaxyId}/${version}`, so all the Stars in a Galaxy share one cached bundle per version.
4. **The Client reads a stale notice by the version it names** (§ *Design intent*). Today the default `onShouldRefreshUI` in `create-nebula-client.ts` reloads behind a `sessionStorage` flag it sets once and never clears, so a tab never auto-reloads twice in a session, and a notice that only dropped its subscriptions reloads it too.
5. **The Star's version check has two entry points: one for a Client's op, whose version is required, and one for the Star's own writes, which have no page.** Today `Resources.#gate` takes an optional version, and three Client ops pass none: a list subscription, a roster subscription and a node invite. So once anything is installed they run at whatever version the Star holds.

**Adapted:**

- **The build job skips `vite build` when the ontology compile it ran failed,** and says why in words the model can act on. Today `job.ts` runs the compile, the type check and `vite build` regardless of each other's results, and its header, `#buildOnce`'s JSDoc and `codegen-loop.ts`'s `build` tool description all say so. `decidePreview`'s branch for a failed compile becomes unreachable and goes.
- **`#buildAndAnnounce`** passes the job a version when the file's hash differs from the current row's version; today it checks the folder of versions. It makes the compiled row current once the build lands.
- **`#serveBuiltApp`** writes the current row's version into the served page through the one helper; today it reads `#appliedHead()`.
- **The Client sends its version on every op on typed data**, list, roster and invite included, and **handles every stale answer in one place.** Today a stale answer reaches it at six intake points, handled three ways: `#meshSubmit` returns it, `read` and `#inviteToNode` throw it, and `handleResourceUpdate`, `handleQueryUpdate` and `handleQuerySubscribersUpdate` receive it pushed.
- **`NebulaClient`'s retry becomes a gate.** Today each op that gets the temporary mismatch retries on its own, up to four times 400 ms apart (`client-resources.ts`). After, the first temporary mismatch holds the Client's other ops while one op retries, and ops refused before the gate closed are sent again when it opens. When retries run out and no reload happens, the gate opens and the held ops resolve as `ontology-stale`.
- **The Star asks its Galaxy once per version change, not once per op.** Today `#gate` fires a fresh `getCurrentOntology()` call for every mismatched op and keeps no record of one on its way, so a page's first burst of ten subscriptions costs ten calls.
- **Studio's Wipe button reports a refusal.** Today `wipe()` in `App.vue` logs *"Wiped the development test data."* before the result, and a refusal reaches only a console handler.
- **The `.dev` Star's install logs how many existing rows fail the new validator.**
- **The reload guard moves into the Client**, around whatever handler the app installed. Today it lives inside the default `onShouldRefreshUI`, so an app's own handler has none.
- **The docs that teach `ontology-stale`:** `api-reference.md`'s `onShouldRefreshUI` row, which describes the set-once guard, and its `TransactionOutcome` table; `resources.md`'s `case 'ontology-stale'`; and `ontology.md`'s lock-step bullet.
- **`OntologyStaleError`'s `installing` flag is renamed `checking`** (§ *Context*, step 4); the Client's retry reads it.
- **Everything that describes the old path.** A phase runs `git grep -nwE 'applyOntology|getOntologyVersion|listOntologyVersions|wipeOnInstall|WIPE_ON_INSTALL|REGISTRY_DIR|registryPath|VERSION_RE|appliedHead|installing|isInstalling|INSTALLING_RETRY'` over `apps packages website/docs .claude docs`, plus the prose words `Apply`, `applied` and `install's wipe`, and judges each hit: changed, or kept on purpose. Known among them, so the phases plan for them:
  - `define-ontology`'s step 6, and the model-facing docs `api-reference.md`, `nebula-client.md`, `using-vue.md` and `ontology.md`, which say `ontologyVersion` is absent until an Apply, or that a version bump is coordinated by hand.
  - The scaffold's `container/app/src/nebula.ts`, whose comment says the same and which `gen-scaffold.mjs` regenerates.
  - The headers of `galaxy.ts` and `codegen-loop.ts`, and the JSDoc of `#buildAndAnnounce`, `getCurrentOntology`, `REGISTRY_DIR`, `#chatOntologySource`, `star.ts`'s `#ontologySource` and `galaxyId`, `requireChatWrite`, `assertModelPath`, and `resources.ts`'s header and `#install`. `getCurrentOntology`'s also says a tenant Star gets nothing until `publish()` exists, and that tenant-Star tests come back with it.
  - `security.md`'s list of the Galaxy's source entries.
  - The reason `mesh.md` § *A gate the RESPONSE leg reaches* and the JSDoc of `star.ts`'s and `resources.ts`'s `resourcesResults` give for carrying no `@mesh()`: it names the install's wipe, which goes. The conclusion stands on the validator alone, so re-derive it there.

**Removed:**

- **`Galaxy.applyOntology`**, with its `wipe` flag and the dominion check behind it. Nothing in Studio calls it. What its callers become:
  - `node-invite-roundtrip` and `grant-reveals-denied`, the only live witnesses of node invites and of ADR-008's denied-node disclosure, move to the `.dev` Star after a real build.
  - `star-serves-current-ontology`'s tenant limbs invert, so the tenant installs nothing; its stale-tab limb moves to `.dev` with a collaborator's old tab; its revert limb builds after reverting; and its limb that reads the current row from Studio's client asserts it through what the `.dev` Star installs.
  - `dev-studio.test.ts`'s case that the current row follows the working file becomes one that it moves only when a build lands.
  - Vitest cases that need a tenant Star with an ontology use `StarTest.applyOntologyForTest`, except those that test the pull: `version-rule.test.ts`'s pull and retry cases, built on `emptyStarUnderGalaxy`, move to the `.dev` Star under a Galaxy whose faked build landed.
  - `source-chat-floor.test.ts`'s F2 reads the served meta or the `.dev` Star instead of `getCurrentOntology()`, and F3, the wipe bit's dominion check, goes with the bit.
  - `codegen-loop.test.ts`'s case that a hostile ontology write never installs on the `.dev` Star is rewritten to the line in § *Design intent*.
  - The install-wipe cases go.
- **The folder of versions**, `.nebula/ontology/<version>.json`, with its `appliedAt` stamps, and `#appliedHead`, whose lookup by the file's hash and fallback to the newest version the one helper replaces.
- **`getOntologyVersion(version)`**, which reads that folder by label. No Star calls it. Two scenarios probe with it, and move to read-only members that already exist: `mesh-entry-reach` nests its payloads in `getCurrentOntology(...)` or `getGalaxyConfig(...)`, since the nested-argument refusal fires before the outer method runs, and `client-routes` uses `getCurrentOntology()` as its placeholder op in limbs 3–6. The exact-surface lists in `scope-isolation.test.ts`, `galaxy-resource-surface.test.ts` and `resources-door.test.ts` drop it.
- **`wipeOnInstall` everywhere:** the build job's input, the field on `OntologyVersionConfig` and `OntologyVersionRow`, the compile's copy of it, the test Galaxies' `wipe` option, `#install`'s wipe branch and `#wipe`'s `install` cause, and the wipe-on-install tests. `plane-wipe` keeps its reset path.
- **`listOntologyVersions` and `VERSION_RE`**, which read only the folder of versions.

**Kept as they are:** `src/ontology.d.ts` and its version, the file's `git.hashBlob`; the Star's lazy pull through `resourcesResults.onOntologyPulled`; `#serveBuiltApp`'s 404 on every Star but `.dev` until something is published; the preview's arrival check, `report.bundle.ok` and `#distArrived`; and `StarTest.applyOntologyForTest`, which fast-follow Item 4 wants skipped tests to use, minus the sentence in its JSDoc promising such a row wipes.

## Design intent

**The dev Star runs the last landed build's compiled row.** Jennifer adds `dueDate?: string` to `Deal`; the build compiles version `3f2a9c…`, `vite build` succeeds, and the `dist` arrives with the digest the job reported; `3f2a9c…` becomes the current row. Her preview's first op pins `3f2a9c…`, the dev Star still holds the previous version, so it refuses the op as a temporary mismatch, pulls the current row and installs it, and the Client's retry runs the op.

- **A build lands when the page it serves changes**: its bundle succeeded and arrived, `bundle.ok` and `#distArrived`, whatever the preview refresh decided. A build whose ontology compile failed runs no bundle, so it never lands. Each landing therefore moves the page and the types together, and the model fixes its types before its page moves.
- **A landing checks the row it stores against the version the Galaxy asked for.** The Galaxy hashes `src/ontology.d.ts` before the build and passes that version in; a chat write can change the file before the compile reads it, and a stale row file can survive from an earlier build. So the row lands only when `git.hashBlob(row.types)` is the version passed in, which is the whole check, since a version is that hash; the stored row is built from its named fields, never by spreading the file. A mismatch lands nothing and is logged. The check `applyOntology` made goes with it, and this replaces it.
- **A page served while a build's output arrives can carry the new code under the old version.** On `.dev` that window is accepted: the landing's install sends the page a notice naming the new version, and it reloads onto the current app. It costs test data at most, which the personas task's risk test accepts.
- **The current row lives in the Galaxy's storage, never on the build's mount.** The compile writes `.nebula/ontology-row.json` before `vite build` runs, where the user's own `vite.config.ts` could also write it, so the Galaxy copies the row into its own storage at landing and reads only that copy.
- **An unchanged ontology changes nothing.** The version is the file's hash, so a build that did not touch the file compiles nothing.
- **Nothing accumulates during development.** The current row is a cache, recompiled from the file by the next build that changes it.
- **Installing never wipes, and the agent's workflow is built to keep that from biting.** Step 6 tells the model to say when a change removes or retypes a field existing data uses, that the existing test data will need a reset, and to ask for one, without naming how the reset happens. That is the model's judgment, so it can miss. When it does, the preview may misbehave on old test data until someone says *"looks like we need a data wipe"*, or, once the agent drives the persona tabs in testing, until it notices. That costs test data and nothing more, and the personas task's risk test, which guards only against lateral movement and production risk, accepts it.
- **Resetting is a person's act.** Until the personas task lands, the reset is Studio's Wipe button, `resetDevData`, which only a Galaxy admin can use: Studio's page gives a collaborator such as Austen no passage into `.dev`. The button reports her refusal rather than claiming success. After personas, the reset is provisioning.
- **The app's code never sees the temporary refusal, and the wait always ends.** When no reload happens, each op whose retries run out resolves as `ontology-stale`, so nothing waits forever. Calls to the Galaxy stay one per version change, because the Star shares one call among the ops that arrive while it is asking.
- **The Star remembers its ask until the answer lands, and no longer.** It records the ask, with its ISO timestamp, when its source answers that the row will come later. Every answer clears it, whether a row, none, an error or a refused install, and an ask older than a stated bound is made again, so a lost answer costs one wait rather than a wedge. A source that answers at once, as the Galaxy's own chat source does, never records one.
- **A stale answer is read by its kind and the version it names.** It is either a notice the Star pushes after an install or a wipe, or the refusal of one of the page's own ops; a refused subscribe arrives on the push channel too, so the kind rides the error rather than the intake. Anything naming another version means the page is on an old build, so the Client reloads, once per version: the guard records the version it reloaded for, so it stops only a loop on that same version. A notice naming the page's own version, or none, means its subscriptions were dropped by an install or a wipe, so the Client subscribes again with `#restoreSubscriptions()`. A refusal naming none, on a Star with nothing installed, restores nothing, or every tenant Star would be asked again every couple of seconds. One handler decides this for all six intake points, so the six cannot drift apart.
- **A Client's op cannot leave out its version.** The Star's check for a Client's op requires one, so an op that forgets fails to compile, and an op arriving with none is answered stale, since mesh arguments are typed but not checked on the wire. The Star's own writes go through the other entry point, which has no page to check against. The org tree, `subscribeTree` and every `unsubscribe` pass neither, because nothing in them is typed by the ontology.
- **The model's judgment is the breaking-change detector, as an interim.** TEMP → target: [backlog.md](../backlog.md)'s *Studio: breaking-ontology-change → deterministic Reset-data/Revert prompt*, whose rule that detection never goes through the LLM stands. Meanwhile one deterministic signal: when the `.dev` Star installs a new version, it counts the existing rows that fail the new validator and logs the count, so a turn spent debugging correct code against old rows can be diagnosed. The count runs after the install commits, handed to `ctx.waitUntil`, because the validator is an RPC into the facet and the install is synchronous; it is capped at a stated number of rows, and a failure only logs.

**The Galaxy answers each Star by kind.** The asking Star is the last entry of the call's `callChain`, which the framework extends every hop. It is the `.dev` Star only when that entry is on the `STAR` binding and named exactly `${galaxy}.dev`, `acme.crm.dev` for the Galaxy `acme.crm`; a Star such as `acme.crm.devops`, a Client whose address starts `acme.crm.dev/`, another Galaxy's `.dev`, and a call with no context all get the published row. The `.dev` Star gets the last landed build's row; every other caller gets the last published one, and until `publish()` exists there is none, so a tenant Star installs nothing. The `.dev` Star keys its validator cache on its own name, `acme.crm.dev/3f2a9c…`, against a tenant's `acme.crm/3f2a9c…`. That matters because the build job runs the Workspace's own `vite.config.ts` after the compile, so a chat collaborator can shape the validator bundle a build hands back, and no bundle the `.dev` Star cached may ever be the one a tenant loads. Before alpha a user sees no difference, since `#serveBuiltApp` answers 404 on every Star but `.dev`.

**So a tenant Star runs no data operation until something is published.** With no ontology installed, its reads, writes and subscriptions are refused, and a node invite cannot run, since it writes a status row through the same pipeline. Peer invites through the Registry are unaffected. Tenant-Star coverage comes back as part of building `publish()`, and `getCurrentOntology`'s JSDoc says so in plain words.

**The line the loop may not cross, restated.** An autonomous tool reads, writes and builds. A build that lands changes the types the `.dev` Star runs, which touches only test data. Only a person wipes. Nothing a build compiles reaches a Star with real users. `codegen-loop.ts`'s header says this in place of today's guarantee that a tool never installs, with no task-file handle and no mention of `compileAndInstallOntology`, a method that does not exist.

## Constraints

- **[ADR-024](../../docs/adr/024-two-versions-keep-an-app-in-step.md)** is the commitment this task builds the `.dev` half of: the Galaxy decides each Star's version, the `.dev` Star's from the last build and every other Star's from the last publish, a Star installs what its Galaxy calls current, and page and Star compare by equality alone.
- **[ADR-003](../../docs/adr/003-continuation-messaging.md)**: the Star's call to its Galaxy is one-way, with a result handler, so the op it refused never waits on it.
- **[ADR-001](../../docs/adr/001-typescript-as-schema.md)**: the row is compiled from `src/ontology.d.ts`, the one schema.
- **`durable-objects.md` § *Dynamic Worker Loader cache***: a `bundleId` must be scoped by something globally unique, which the `.dev` Star's own key satisfies.
- **`containers.md`**: build behavior is verified under `wrangler dev` with Docker, and arrival is a digest check, never a presence check.
- **`studio-guidance.md`**: step 6 and the docs are platform guidance, so the embed is regenerated after each edit, and the scaffold's own comment is regenerated by `gen-scaffold.mjs`.
- **`live.md`**: a `/live` scenario first, and a deployed pass at close, because the job's input changes and the job ships in the build-box image.
- **Milestone:** pre-alpha, before the personas task.

## Future state

- ⚠️ Design consideration: **where a published version's compiled validator lives is [nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path*'s to decide**, with a Galaxy compile-cache keyed by version among its candidates: a cache, never the truth, recompilable from the published source. This task's current row is the development half of that idea.
- ⚠️ Design consideration: **a publish promotes the build's compiled row as it is** (Larry, 2026-10-12). A chat collaborator can shape what a build hands back (§ *Design intent*), and [ADR-024](../../docs/adr/024-two-versions-keep-an-app-in-step.md) § *Consequences* accepts that: the risk sits with the user-developer, directly or through whomever they invite, and those same people can already change the page.
- **The deterministic detector replaces step 6's judgment** when the backlog row above is built.

## Open questions

None.

## Decisions

Started at the Pass 1 gate; only settled rows.

| Decision | Why, and what it beat |
|---|---|
| **The dev Star runs the last landed build's compiled row, and `applyOntology` and its folder of versions go.** | 2026-10-10 (Larry). The preview should run what was just built, with no step for anyone to take, and during development nothing needs more than the last build's row. Beat: `provision` as the one Apply, which makes even an added field wait for a wipe; `applyOntology` as a loop tool, another confirmation for a step whose only destructive part, the wipe, has moved to a person's act; and this file's first draft, which kept the folder and appended each build to it, so rows would pile up that nothing reads once tenants wait for a published version. |
| **The Galaxy answers the `.dev` Star with the last build's row and every other Star with the last published one, there is none until `publish()` exists, and the `.dev` Star keeps its own validator cache key.** | 2026-10-10 (Larry), from [nebula-testing-with-personas.md](../nebula-testing-with-personas.md)'s third Stage 1 pass; the split by kind 2026-10-11. Two small changes make "a build reaches a tenant" impossible rather than guarded (`calibration.md` §2), and `publish()` later fills in the published row rather than replacing a refusal. Beat: answering non-`.dev` Stars nothing, which `publish()` would have to undo; every Star following the build, with the exposure accepted until Item 4 restores a fence, a property guarded later; and a build-computed "breaking" bit refusing installs off `.dev`, a fence keyed on judging breakage that still lets a non-breaking row a collaborator shaped reach tenants. |
| **The ontology's history is the file's git history during development.** | 2026-10-10 (Larry). There are no migrations during development; the dev Star is wiped instead, so a history entry per build would record versions nothing ever migrates between. How published versions and their migrations are recorded is [nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path*'s to design. Beat: an entry per build. |
| **Every op from a Client carries its page's version, and a stale notice is read by the version it names.** The Star's check splits into an entry point for a Client's op, with the version required, and one for the Star's own writes; the Client routes every stale answer through one handler, which reloads once per version for a notice naming another version and subscribes again for one naming its own version or none. | 2026-10-11 (Larry), from Stage 1's blocker. Three Client ops passed no version and ran at whatever the Star held, so a page's list stopped updating after a build, and a set-once reload guard skipped every wipe after the first. An optional parameter is how they diverged, so the fix makes the divergence fail to compile rather than adding checks. Beat: narrowing the text to the ops that pin a version, which leaves three ops running at the wrong version; and the set-once guard, which leaves a long-lived tab on an old build. |
| **Our Client absorbs a version mismatch: each op answered `checking` retries on its own, the Star shares one call to its Galaxy, and the app's code sees `ontology-stale` only when a stale page was not reloaded.** When an op's retries run out and no reload happens, it resolves as `ontology-stale`; the reload guard wraps whatever handler the app installed. | 2026-10-11 (Larry); the shared call and the exit from Stage 1. The gate that held every other op behind one probing op went on 2026-10-12 (Larry, at the retro, Phase 6): the Star's shared call already holds the Galaxy to one call per version change, and the write queue already keeps one write per resource in flight, so the gate saved only retries, at the price of four ways to open, a 30 s bound, a record of owed resends and two defects. The handshake is the platform's business, and the wait is short enough that a spinner or placeholder, which Larry's apps show while reactive data loads anyway, covers it. A page's first burst reaches the Star before any answer can close the Client's gate, so only the Star can make the calls one per version change. Beat: the gate, above; the Client sending its first op alone, which adds a round trip to every page load to save one on the rare load after a change; the Star holding each mismatched op until its install lands, which puts a queue of waiting continuations on every Star, lost if it is evicted; a gate that never opens, which hangs the app; and hiding `ontology-stale` from the app's code entirely, which takes away the banner an app may want to show. |
| **A build lands only if every step it ran succeeded, and the current row lives in the Galaxy's own storage.** The job skips `vite build` when the ontology compile it ran failed; at landing, the Galaxy copies the compiled row into its Durable Object storage, and one helper reads it for every caller. | 2026-10-11 (Larry), from Stage 1. The build replaced the served page whenever its bundle succeeded, so a failed compile served new code over old types; gating the bundle makes the page and its types move together by construction. Larry's folder outside git, kept where a build's own code cannot write it. Beat: accepting new code over old types on `.dev`, which breaks ADR-024's "never meet"; tying landing to the preview refresh, which can be withheld while the page still changes; and a file of its own under `.nebula/`, which the next build's `vite.config.ts` could overwrite. Pass 2 checks that a large validator bundle fits the storage's limits. |
| **A tenant Star runs no data operation until something is published, and its tests come back with `publish()`.** The live witnesses of node invites and ADR-008's disclosure move to the `.dev` Star after a real build. | 2026-10-11 (Larry), following from answering each Star by kind. Before alpha every tenant Star's pages answer 404, so the cut costs no user anything, and witnesses on the `.dev` Star run the path a real user takes. Fast-follow Item 4 carries the obligation to add tenant-Star tests when `publish()` is built. Beat: a test-only way to install a row on a tenant Star in `/live`, a stand-in every test written against would have to unlearn (`workflow.md` § *Evaluating alternatives*). |
| **Until the backlog's deterministic detector is built, the model's judgment detects a breaking change, backed by a logged count of rows that fail the new validator; the Wipe button reports a refusal.** | 2026-10-11 (Larry), from Stage 1. A missed breaking change makes no noise: the agent may spend turns debugging correct code against old rows, so the count is there to diagnose it. The detector's design, its hook and where it shows its notice, belongs to the backlog row. Until personas replaces the button, a collaborator's reset is refused, and the button saying so beats telling her it worked. Beat: building the detector now, about doubling this task; designing it here, which conflicted with the row's hook at the turn's commit; loosening `resetDevData`'s guard, work personas deletes; and leaving the button claiming success. |
| **`getOntologyVersion` goes with no replacement member, and the scenarios that probed with it use read-only members that already exist.** | 2026-10-11, from Stage 2. The probes test routing and nested-argument refusal, and the refusal fires before the outer method runs, so the method's own arity does not matter. Beat: a new `@mesh()`-decorated member whose only caller is a test (`calibration.md` §3(d)); and a member that writes, which the deployed run would execute. |
| **On `.dev`, a page served while a build's output arrives may carry the new code under the old version, until the landing's notice reloads it.** | 2026-10-11, from Stage 2, under the personas task's risk test: it costs test data at most and heals itself. Beat: storing the page's digest with the row and withholding the version until the served page matches it, which leaves that page with no version, so it cannot reach typed data and never gets the notice that would reload it. |
| **Each scenario that drives the `.dev` Star claims its own app with `testSlug`.** | 2026-10-11, from Stage 2. A Galaxy has one `.dev` Star, and these scenarios rewrite its ontology, build, and wipe it, so on the shared app they undo each other, and they race outright under `--concurrency`. Deployed, each costs one certificate pack and a wait of two and a half to four minutes for it. Beat: the shared app; and folding the moved limbs into `dev-star-follows-the-build`, which keeps the cost down but buries the two witnesses ADR-008 and node invites have now. |

## Phases

Each phase leaves `npm run type-check`, `npm test`, `drive.ts all --fast` and the container scenarios it touches green, and its changed source files clean of task-file handles under `grep -nE '\b[SD](1[0-9]|[1-9])\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b'`. The witness is one `/live` scenario, `dev-star-follows-the-build`, which declares `needsContainer`, claims its own app with `testSlug`, and gains limbs as the phases land. It drives the build directly, writing its own `src/ontology.d.ts`, with a `Deal` type the scaffold does not have, through the Galaxy's source entry and calling `buildNow`, so no model turn makes it flaky. A page in it reads its version from the served `nebula-scope` meta, never from a value the scenario computed. A limb that asserts a refusal matches its message. `live-scenarios.md` governs how the scenario reads the stack's logs.

1. **The `.dev` Star runs the last landed build's row, and the old Apply path is gone.**
   - **The row.** The Galaxy stores the current row under `galaxy:devOntologyRow` with `kv.put`, and one synchronous helper reads it for `getCurrentOntology`, which becomes synchronous, for the served page's `nebula-scope` meta, and later for personas' hand-off.
   - **Landing.** A pure `decideLanding(report, arrived)` beside `decidePreview` decides it: the bundle succeeded and arrived, and when the build passed an ontology version, the compile ran and succeeded too. Arrival is checked whether or not a container ran, so both fakes, `GalaxyTest.build` and `GalaxyLoopProbe.build`, mirror the job: they skip the bundle after a failed compile, take a knob that fails the bundle, and write `dist/index.html` and report its digest. The stored row passes the checks § *Design intent* lists.
   - **The job.** `job.ts` skips `vite build` when the compile it ran failed, with the `why` *"skipped: src/ontology.d.ts did not compile — fix it, then build again"*. Its header, `#buildOnce`'s JSDoc, and `codegen-loop.ts`'s `build` tool description and build-cycle JSDoc say so, and `decidePreview`'s failed-compile branch goes.
   - **Answering by kind.** `getCurrentOntology` answers through a pure predicate on the call's last hop, pinned as § *Design intent* pins it, and answers none with no call context. The `.dev` Star's facet `bundleId` is `${galaxy}.dev/${version}`; a tenant's stays `${galaxy}/${version}`.
   - **Removals.** Everything § *What changes* lists as removed goes, and every caller moves as that section lists. A comment naming a removed identifier is rewritten here, since nothing later changes it. Each scenario moved to `.dev` claims its own app.
   - **The Wipe button** logs success only when `resetDevData` answers, and shows a refusal by its message.
   - **Success criteria (capable of failing):**
     - Limb 1: after a build adds `dueDate?: string` to `Deal`, a page loaded afterwards writes a `Deal` with a due date that commits, with no other step. The Star's `facet cold load` marker names the `bundleId` `${galaxy}.dev/${version}` exactly, and an op on `.dev` sent from Studio's client, which connects at the Galaxy's host, also runs.
     - Limb 2: a build whose ontology does not compile, and which also changes a visible string in `App.vue`, leaves the served HTML and its `nebula-scope` version as they were, and an op on `.dev` at the old version still runs. Then the types are fixed and a rebuild lands: the version changes and the string appears.
     - Limb 3: a page on `{galaxy}.tenant1`, pinned to the version read from `.dev`'s served meta, has its op end `ontology-stale`. Locally, the tenant Star logs its own `ask` and then no install; deployed, where the logs cannot be read, the op half stands alone.
     - Limb 4, in the scenario's Playwright half: a collaborator with no passage into `.dev` clicks Wipe and sees the refusal by its message, with no success line; the owner's click reports success.
     - Vitest, a table over `decideLanding`: a failed compile, a failed bundle, a bundle that did not arrive, one that did, and a build that passed no ontology version.
     - Vitest, landing: a planted `ROW_PATH` row for another version lands nothing; a fake that compiles different content under the passed version lands nothing; a failed bundle and then a rebuild with unchanged types lands.
     - Vitest, the cache key: in one isolate, a `.dev` Star and a tenant each run `applyOntologyForTest` with the same version label and different types, and each validates by its own types.
     - Vitest, a table over the predicate: `acme.crm.dev` passes for the Galaxy `acme.crm`; `acme.crm.devops`, a Client at `acme.crm.dev/alice.x`, `acme.other.dev`, a chain whose last hop is a Client, and no call context do not.
     - A Node test in `apps/nebula/test/offline/` runs the exported `runJob` on a temporary workspace whose ontology does not compile, and the report has `bundle.ran === false` with the `why` above.
     - The stored row's size: the compiled rows for the scaffold's ontology and for a 20-type ontology are measured and recorded in the phase's note, against the 2 MB value cap a Star's install already lives under. Past half of it, a backlog row records that both nodes need to chunk the bundle.
     - `node-invite-roundtrip`, `grant-reveals-denied`, `star-serves-current-ontology`, `mesh-entry-reach` and `client-routes` pass, moved as § *What changes* lists, and the surface lists in `scope-isolation.test.ts`, `galaxy-resource-surface.test.ts` and `resources-door.test.ts` no longer name `getOntologyVersion`.
     - `git grep -nwE 'applyOntology|getOntologyVersion|listOntologyVersions|wipeOnInstall|WIPE_ON_INSTALL|REGISTRY_DIR|registryPath|appliedHead|VERSION_RE' -- apps packages` returns nothing. `-w` keeps `applyOntologyForTest` out of it.
   - **Mutation note:** limb 1 reds when landing stores no row, when the `.dev` key reverts to the shared one, or when the predicate reads `callChain[0]` instead of the last hop; limb 2 reds when `job.ts` runs `vite build` after a failed compile; limb 3 reds when `getCurrentOntology` answers every caller with the `.dev` row; limb 4 reds when the button logs before the result. The landing table reds when arrival is ignored; the landing cases red when the version or hash check is dropped, or the row is spread from the file; the cache-key case reds with a shared key; the predicate table reds under a prefix match or an origin match.

2. **Every op on typed data carries its page's version, and the Star asks its Galaxy once per version change.**
   - **The version.** `Resources.#gate` splits into an entry for a Client's op, whose version is a required parameter, and one for the Star's own writes. `ResourcesRequests`' `subscribeQuery`, `subscribeQuerySubscribers` and `invite` take the version, and `client-resources.ts` sends it. The org tree, `subscribeTree` and every `unsubscribe` stay outside the check. In `#restoreSubscriptions`, the query and roster loops now pin the version beside the resource loop, the org-tree restore runs with or without one, and the comment warning against an early return says which loops need a version and why.
   - **One ask.** The plane remembers its ask under the rules § *Design intent* gives, and `version-rule.test.ts`'s assertion of one ask per op becomes one ask per version change.
   - **The rename.** `OntologyStaleError`'s `installing` flag becomes `checking`. The same commit fixes what type-check cannot see: `node-invite-roundtrip` and `grant-reveals-denied` read the flag through a cast, and `passage-not-dominion` declares its own `subscribeQuerySubscribers(query: unknown)`, where the query would land in the version's slot.
   - **The count.** On the `.dev` Star, after an install commits, the plane counts the existing rows that fail the new validator, as § *Design intent* describes, and logs `instanceName`, `version`, the count, how many rows it checked, and the cap.
   - **Success criteria (capable of failing):**
     - A type test over `ResourcesRequests['subscribeQuery' | 'subscribeQuerySubscribers' | 'invite']`: each call without the version is marked `// @ts-expect-error`, beside a twin with the version that compiles, so no other error can satisfy the marker.
     - Vitest: a raw op arriving with no version, on a Star that has an ontology, is answered stale.
     - `no-ontology-still-boots.test.ts`: on a client with no version, the three newly versioned ops throw `NoOntologyInstalledError`.
     - Vitest, one ask: with the Galaxy's answer held, ten mismatched ops on the Star produce one `getCurrentOntology` marker on the Galaxy's side, filtered by `callChain.at(-1)`. It runs in the vitest lane because only there can the answer be held until all ten have arrived; live, the count would depend on timing.
     - Vitest, the memory: after an answer of none, and after an error, a mismatched op asks again; with no answer and `vi.setSystemTime` moved past the bound, a mismatched op asks again; a Galaxy installs two successive chat-seed bumps.
     - Limb 5: the scenario seeds N `Deal`s, exactly M of which set a field, and a build retypes that field; the count line says M of N. A control build that adds an optional field logs 0.
   - **Mutation note:** the type test reds when any of the three parameters turns optional; the raw-op case reds when the Client-op entry accepts a missing version; the one-ask case reds when the plane forgets its ask; each memory case reds when its clear or its bound is dropped; limb 5 reds when the count covers every row or every type.

3. **The Client reads every stale answer in one place, and its wait always ends.**
   - **The decision.** One named function, as `calibration.md` §12 asks, takes the stale's kind, the version it names, the page's own version and the guard's state, and returns reload, restore, retry, or resolve as `ontology-stale`. The Star marks a notice apart from a refusal on the error itself, and one handler calls the function for all six intake points.
   - **The guard.** It lives in the Client, around whatever `onShouldRefreshUI` the app installed, and records in `sessionStorage` the version it reloaded for.
   - **The gate.** The first `checking` answer holds the Client's other ops and its own resends; ops sent before it closed are sent again when it opens; when retries run out with no reload, it opens and every held op resolves as `ontology-stale`.
   - **The scenario's page.** The scenario writes an `App.vue` that imports `{ client, store }` from `nebula.ts` and holds a list subscription, so the built page runs a client.
   - **Success criteria (capable of failing):**
     - A vitest table over the decision function, one row per pairing, including a refusal naming none on an empty Star, which restores nothing. It is pure, which is why it needs no running system.
     - Vitest, the guard: two `NebulaClient`s share one injected `sessionStorage`, with an app-installed handler that counts its calls. Two notices naming the same other version call it once; a third, naming a new version, calls it again.
     - Vitest, the gate: a reconnect while the gate is closed sends each op once.
     - Limb 6, headless: a page current at the new version, which took a list subscription and row subscriptions during the version change, records no `onShouldRefreshUI` call; the Star's markers for its subscribes come after the Star's `installed` marker; and it sees a `Deal` another client writes after the install.
     - Limb 7, headless: two wipes of the `.dev` Star in one session; after each, the page records no `onShouldRefreshUI` call, and its subscription sees data written afterwards.
     - Limb 8, in the Playwright half: a top-level page on the `.dev` host, neither framed in Studio nor the build's requester, so the requester's own reload cannot stand in for the guard. After each of two builds, a second client reads the served meta and sends one op on `.dev`, so the Star installs, and the page reloads once per build, each reload tied to a console marker the app's `onShouldRefreshUI` writes.
     - Limb 9: on the tenant Star, an op ends `ontology-stale` within the retry window, an op sent while it waited ends the same way, and the tenant Star logs no further `ask` in a window after both end.
   - **Mutation note:** the decision table reds when a refusal naming none routes to restore; the guard case reds with the guard kept only in the default handler, kept only in memory, or removed; the reconnect case reds when the Client's own resends skip the gate; limb 6 reds when refused ops are not sent again when the gate opens, and when the pinning from the phase before is reverted; limb 7 reds when the guard records an empty version; limb 8 reds with a set-once guard; limb 9 reds when the gate stays closed after the retries run out, or when a refusal restarts the restore.

4. **What describes the old path is rewritten, last, after everything it describes has changed.** The grep in § *What changes* runs over `apps packages website/docs .claude docs`, and every hit is changed or kept on purpose. The known sites named there are rewritten, `define-ontology`'s step 6 asks for a reset without naming a mechanism, and the docs teach `ontology-stale` as Phase 3 built it. ADR-024's *Today's code differs* blockquote keeps only the bullets still true, each checked against the code: *nothing is published, and no migration exists* stays, and the cache-key bullet says the tenants of a Galaxy still share an entry per version while `.dev` has its own. Its Evidence line names where the reload guard now lives. The platform embed and the scaffold are regenerated. `codegen-loop.ts`'s header states the line from § *Design intent*. The reason `mesh.md` and the `resourcesResults` JSDoc give for carrying no `@mesh()` is re-derived from the validator alone.
   - **Success criteria (capable of failing):**
     - `gen-platform.mjs --check` and `gen-scaffold.mjs --check` pass, so a stale embed reds before vitest runs.
     - The grep's hits, and each bullet of ADR-024's blockquote, carry a verdict in the phase's note.
     - `codegen-loop.ts`'s header no longer names `compileAndInstallOntology`, and the task-handle grep finds nothing in the changed source files.
     - `studio-guidance-loop`, `first-app-built` and `four-party-chat` stay green.
   - **Mutation note:** skipping the regenerate reds the drift checks. No test can red stale prose, so the verdicts are the witness for every prose site, and `/build-task`'s verifiers check them one by one.

5. **The close-out: a full sweep, then a deployed pass.** The build job's input changed, and the job ships in the build-box image, so `live.md` requires a deployed pass of the scenarios this task wrote or touched.
   - **Success criteria (capable of failing):**
     - `drive.ts all`, container scenarios included, is green locally.
     - The deployed list is derived, not remembered: every scenario file the diff touches, plus every scenario that calls `getCurrentOntology` or loads a served page. It includes at least `dev-star-follows-the-build`, `node-invite-roundtrip`, `grant-reveals-denied`, `star-serves-current-ontology`, `mesh-entry-reach`, `client-routes`, `passage-not-dominion` and `session-survives-token-lapse`. After `deploy-test.sh` they pass with `HARNESS_TARGET_URL`, beside a `wrangler tail` capture, at `--concurrency=2`, which is safe because the scenarios that drive `.dev` each claim their own app. Each claimed app waits two and a half to four minutes for its certificate.
     - Before deploying, the harness's deployed-only branches are checked against the changed refusals, as `live.md` asks.
   - **Mutation note:** the deployed pass is the witness for what no local run can show: the build-box image carrying the new job.

6. **The Client's version gate goes, and each op answered `checking` retries on its own.** Added at the retro (Larry, 2026-10-12), for the reason in § *Decisions*. `StaleGate` and everything that opened it leave `client-resources.ts`: a request and a push channel each retry their own `checking` answers up to the same limit, and no op waits on another.
   - **Success criteria (capable of failing):**
     - `stale-guard-and-retry.test.ts`, renamed from `stale-guard-and-gate.test.ts`, keeps the guard case and drops the four gate cases. A subscription let go still reloads nothing, and an established subscription a restore sent is sent again.
     - `version-rule.test.ts` and the full baseline stay green.
     - Limbs 6, 7 and 9 read no gate line, and each reds under its own mutation.
     - `drive.ts all` stays green, since every scenario's pages run this Client.
   - **Mutation note:** the let-go case reds when a `checking` answer on a channel nothing holds is decided as any other stale answer; the restore case reds when a resource subscription is sent again only while it awaits its first answer; limb 6 reds when a subscription answered `checking` is not sent again; limb 7 reds when an established list is not sent again; limb 9 reds when a request keeps retrying past its limit.

## Build notes

### Phase 1, 2026-10-11

**For Larry:** nothing needs a decision. Three things the build settled inside Phase 1's text, each recorded so a verifier can check it:

- **The `.dev` predicate reads the binding and the whole name, not the node type.** A Client's instance name always carries a `/`, so the type check could never decide anything; its mutation survived the table, and it was deleted (`isDevStarCall`'s JSDoc says why).
- **The landing checks only the hash of the row's types.** A version is that hash, so the label the row file carries added nothing; its mutation survived, and it was deleted. The stale-file and mislabeled-compile cases both red under the hash check alone.
- **The build job's entry moved to `container/compiler/main.ts`**, and the Dockerfile bundles it to `/build/job.cjs` as before, so a test can import `runJob` without running a job. The offline Node project (`vitest --project offline`) is new, in `npm test`.

**What else landed beside the phase's text:**

- `NoOntologyInstalledError`'s message told the user to "Run Apply in Studio"; it now says to define the types in `src/ontology.d.ts` and build. Model-facing, so it could not wait for Phase 4.
- The no-`@mesh()` reason in `mesh.md`, `resources.ts` and `star.ts` no longer names the install's wipe, and `security.md`'s source-entry list drops `applyOntology`. Nothing in a later phase changes either, so they moved here from Phase 4's list.
- `#onOntologyPulled`'s log lines carry `instanceName`, so limb 3 can tell the tenant's empty answer from another Star's.
- `harness/lib/own-app.ts` gives the two moved scenarios an app of their own (`ownApp`) and reads a page's served version (`servedOntologyVersion`). Every step is one a person takes.

**Evidence:**

- `dev-star-follows-the-build` limbs 1–4 green locally, 64.6 s. Each limb then reds alone under its own live mutation, the others staying green: limb 1's op half with the predicate reading `callChain[0]` (Studio's op on `.dev` is answered stale), its log half with a shared cache key (the `bundleId` names the Galaxy); limb 2 with `job.ts`'s gate removed ("page CHANGED"); limb 3 with every caller answered the `.dev` row (the tenant commits and installs once); limb 4 with the success line logged before the answer (the collaborator sees both).
- `node-invite-roundtrip` 32.5 s, `star-serves-current-ontology` 25.4 s, `mesh-entry-reach` 4.0 s and `client-routes` 5.0 s green on their first run. `grant-reveals-denied` failed once waiting 60 s for its invite mail, which never reached the mail provider, and passed unchanged on the rerun (9.8 s): a delivery flake rather than a code path, since its sibling sends the same node invite on `.dev` and its mail arrived.
- The stored row's size: the scaffold's ontology compiles to 20.9 KiB (validator 19.3 KiB), a 20-type ontology with a relationship chain to 122.7 KiB (110.6 KiB), about 6% of the 2 MB value cap a Star's install already lives under. No backlog row.
- Vitest mutations, each caught by exactly the named case: the three `decideLanding` conjuncts; the predicate's prefix match, `callChain[0]` and binding check; answering every caller with the `.dev` row; skipping the store; dropping the hash check; a shared cache key; an install that wipes; `runJob` without its gate; the path rule switched off (F2 reds). Two survived and were deleted, as above.
- `git grep -nwE 'applyOntology|getOntologyVersion|listOntologyVersions|wipeOnInstall|WIPE_ON_INSTALL|REGISTRY_DIR|registryPath|appliedHead|VERSION_RE' -- apps packages` returns nothing.
- `npm run type-check` green. `apps/nebula`, project by project: `unit` 117, `offline` 2, `frontend` 237, `dev-studio` 115, `browser` 4 (2 skipped), `baseline` 554 of 555. The one is `resubscribe-on-signal`'s token-rotation case, which fails only under the full project's load and passes alone; it tests a reconnect and a 20-minute clock jump this build did not touch, so it is reported rather than fixed here. The combined `npm test` and two `baseline` runs hung at 0% CPU after their last output, the exit hang `workerd-zombie-hang` describes; every project completes on its own.
- `drive.ts all --fast`: 55 of 55, one parked by design, 26.8 min. The container scenarios this phase touches: `dev-star-follows-the-build` 67.0 s, `build-box` 109.5 s, `dev-tab-frame` 21.5 s, `node-invite-roundtrip`, `grant-reveals-denied` and `star-serves-current-ontology` as above.

**Retro:** the first live run was green on every limb, which is why each limb then got its own live mutation rather than trusting the run. Batching mutations that land on different limbs worked because each limb records rather than asserts, though the predicate mutation stopped `.dev` installing at all and hid the cache-key half, which then needed a run of its own. One vitest mutation run (the path rule) hung after F2 reddened; interrupting `mutate.mjs` restored the source. The first full `apps/nebula` suite then hung at 0% CPU behind six `workerd-nebula` proxy containers that the interrupted stacks had left up, the failure `live.md` already names; reaping them first is now this build's habit before any suite.

**Close-out:** `security.md`'s source-entry list and the no-`@mesh()` reason are done here, so Phase 4's grep will find them already clean.

### Phase 2, 2026-10-11

**For Larry:** nothing needs a decision. What the build settled inside Phase 2's text:

- **The ask memory is an in-memory ISO timestamp with a 10-second bound** (`ASK_BOUND_MS`). Every answer clears it, at the top of `#onOntologyPulled`, so a row, none, an Error and a refused install all end the ask. A source that answers at once never sets it, so the Galaxy's chat plane is unaffected.
- **The count runs only on a replacing install on the `.dev` Star**, capped at 1,000 rows (`FAILING_ROW_CAP`). A first install, after a wipe, has no rows to check. It reads the rows through a new `Snapshots.liveValues`, which checks no permission and is reachable from nothing on the wire.
- **The test seam that holds an answer sits at the Star's fire-back door** (`StarTest.holdOntologyAnswersForTest`), not at the Galaxy, because `getCurrentOntology` is synchronous; the Galaxy still logs every ask it answers, which is what the one-ask case counts.
- **The type test passes `undefined` where the version goes.** The form Stage 2 described, a call that drops the version, cannot fail: its query lands in the version's slot, which fails to compile whether or not the version is required. Each of the three widenings to `string | undefined` reds exactly its own line.

**What else changed:** the subscriber-list fixture gives a client on a Galaxy's host the chat version, and three raw test calls needed one. Before this phase the roster op carried no version, so a Galaxy-host client pinned to a Star's test version passed by accident.

**Evidence:**

- Vitest mutations, each caught by its named case: a missing version treated as current; the memory removed; the memory cleared only for a row, then only for a row or none; the age bound removed; every ask remembered (the second chat-seed bump reds); and each of the three Client ops sending without `requireOntologyVersion`.
- `dev-star-follows-the-build` limbs 1–5 green, 85.7 s; limb 5 reads "0 of 5" for an added optional field and "2 of 5" for the retyped `stage`, and reds alone ("5 of 5") with the count covering every row.
- `frontend` 237, `dev-studio` 115, `unit` 117, `packages/resources` 2; `baseline`'s three failures in the first run were the fixture versions above, and both files pass after (34 of 34). The full `baseline` run stalled at exit again, as in Phase 1.
- The scenarios this phase touches pass: `node-invite-roundtrip` 11.1 s, `grant-reveals-denied` 10.4 s, `star-serves-current-ontology` 29.7 s, `passage-not-dominion` 5.5 s, `four-party-chat` 20.8 s. `drive.ts all --fast`: 55 of 55, one parked by design, 22.9 min.
- The task-handle grep over the changed files finds nothing; `snapshots.ts`'s older `Child 2`, `D15` and `D8` went with this phase's edit there.

**Retro:** the type test was the one Stage 2 called vacuous, rebuilt, and it was still vacuous in the shape Stage 2 proposed; reasoning about what the mutation leaves compiling, before running anything, is what caught it.

### Phase 3, 2026-10-11

**The verifier panel later found two defects in this phase's gate**, a wait that could last forever and established subscriptions it never resent; § *The verifier panel, 2026-10-12* has both and their fixes.

**For Larry:** nothing needs a decision. What the build settled inside Phase 3's text:

- **The guard lives in the `sessionStorage` the Client already took for its tab id.** `MeshClient` has a `sessionStorage` option, and the guard reads and writes the same storage under `lmz.ontology-reloaded-for`, so the page after a reload finds what the page before it recorded. No new option.
- **The org tree's restore never waits behind the gate.** The tree is typed by no ontology, and waiting would lose its restore whenever the gate opens stale. Only the resource, query and roster subscribes wait.
- **The conflict-outcome engine's `onShouldRefreshUI` option is gone.** `ClientResources` was its one production caller and now decides every stale answer itself, so only the engine's unit test still supplied it.
- **The default `onShouldRefreshUI` is a plain reload.** Its set-once flag, and the jsdom test that pinned the flag, are gone; the Client's guard replaces both.
- **Two version-rule cases flipped.** They expected the refresh hook when a subscribe's retries run out on a Star with nothing installed. That answer names no version, so a reload would serve the same page; the op now ends stale and the hook is not called.
- **Limb 8's `App.vue` imports `{ client }` only.** It holds the list subscription through the client, and `store` would be an unused import.

**What else landed beside the phase's text:**

- Each subscribe that reaches a host logs one `nebula.Resources.subscribe` `arrived` line, with its kind, topic, client and whether it was refused. Limbs 6 and 9 and the gate test read them.
- The Client logs `version gate closed` and `version gate opened` with its instance name. Limbs 6 and 9 wait on the first, read in the harness's own process, so they wait the same way deployed.
- The scenario's pages wait for their first connection before any op, as an app waits on the factory's `ready`. Sent sooner, each subscribe went out twice, once queued and once in the first connection's restore, and the second copy answered every subscribe the gate held.

**Close-out notes for Phase 4:** the docs still teach the old reload, in `website/docs/nebula/api-reference.md` (the `onShouldRefreshUI` row and the outcome table), `resources.md`'s `ontology-stale` comment, `coding-your-ui.md` on a new app version, and `ontology.md`'s lock-step bullet. Phase 4's grep will find them; they are listed here as a floor.

**Evidence:**

- Vitest, the decision table: 15 rows. Five mutations each red exactly their own rows: a refusal naming none restores; the page's own version taken as another; a notice retried; the guard ignored; a set-once guard.
- Vitest, `stale-guard-and-gate.test.ts`: the guard case reds with the guard ignored, kept per Client in memory, or set once; the gate case reds when the Client's resends skip the gate and when a subscribe is sent at once while it is closed.
- `dev-star-follows-the-build` limbs 1–9 green, 191.1 s after the last scenario edit. Each new limb reds under its own live mutation, every other limb staying green:
  - limb 6, when the gate's opening sends nothing (the held rows never acknowledged) and when the Star does not check a list subscription's version (the list is refused at the old version, admitted before the install);
  - limb 7, when a notice naming no version takes the reload path (one `onShouldRefreshUI` call at the first wipe, and the second wipe's list never answered);
  - limb 8, with a set-once guard (one reload line for two builds), which also showed the build image vendors the Client under test;
  - limb 9, when the gate stays closed after the retries run out (the read never answered) and when a refusal naming none restores (9 asks in the six seconds after, against 0).
- Suites: `packages/resources` 17 (2 before, plus the 15 rows); `apps/nebula` unit 117, offline 2, frontend 236 (the reload-flag test deleted), dev-studio 115, browser 4 with 2 skipped. `baseline` reported every test of its 76 files, 564 passed and none failed, then stalled at exit before printing its summary, the hang Phases 1 and 2 met. A first full run stalled and failed eleven tests: version-rule's two flipped cases, and nine that pass alone, `plane-wipe` beside version-rule and the other eight files 56 of 56.
- `drive.ts all --fast`: 55 of 55, one parked by design, 24.7 min. The two container scenarios whose pages run a client through reloads are green too: `dev-tab-frame` 20.3 s, which asserts the dev tab takes a change as a push and never a reload, and `first-app-built` 72.6 s.

**Retro:** the gate's flush survived its first live mutation, because the scenario subscribed before its page connected and the first connection's restore re-sent everything. A real app subscribes after `ready`. The same runs showed timing deciding which ops the Star refused, so limb 6 now sends its list subscription, waits for the Client's own `version gate closed` line, and only then sends the rows. The vacuity here was in a limb's premise, not its assertion, and first-run green was the only sign.

### Phase 4, 2026-10-11

**For Larry — ADR-024 is not edited.** Your pen round is open in it (two `[bracket]` notes, saved 17:12), and a write from here could clobber an unsaved edit. The verdicts the phase asks for, each checked against the code, ready to apply or to hand back:

- *"The Galaxy answers every Star with the same row…"* — false since Phase 1; it answers by kind, and the version moves only when a build lands. Delete.
- *"Rows live in a folder only `applyOntology` writes…"* — false since Phase 1; both are gone. Delete.
- *"A list subscription, a roster subscription and a node invite carry no version."* — false since Phase 2. Delete.
- *"The Stars of one Galaxy share a validator cache entry per version."* — half true. Rewrite: *The tenant Stars of one Galaxy share a validator cache entry per version; the `.dev` Star keys its own.*
- *"A tab reloads for staleness only once per session."* — false since Phase 3; it reloads once per version. Delete.
- *"Nothing is published, and no migration exists."* — true. Keep.
- **Evidence:** `Resources.#gate` becomes `Resources.#gateClientOp`, and the reload moves from `create-nebula-client.ts`'s `defaultOnShouldRefreshUI` to `client-resources.ts`'s `#handleStale`, which decides through `stale-decision.ts`'s `decideStale` and keeps the reload guard.

**The grep's verdicts.** The identifier half finds 15 hits, every one the verb *installing* (a Dockerfile package install, scenario and test comments, benchmark logs); none names the retired flag, so all are kept. The prose half, widened to *applying* and *apply* beside an ontology word, since `-w Apply` misses the step-6 sentence's own *Applying*:

- **Changed:**
  - `define-ontology`'s step 6, which now asks for a reset of test data without naming how.
  - The docs: `api-reference.md`'s `ontologyVersion` and `onShouldRefreshUI` rows, its `nebula.ts` example comment and its `ontology-stale` outcome row; `resources.md`'s `ontology-stale` case; `coding-your-ui.md`'s new-version sentence; `ontology.md`'s lock-step and breaking-change bullets and its *deploy time*; `nebula-client.md`; `using-vue.md`.
  - The scaffold's `nebula.ts` comment and `ontology.d.ts` header, regenerated.
  - Source: `codegen-loop.ts`'s header; `galaxy.ts`'s `assertModelPath`, `#chatOntologySource` and `#readOntology`; `chat-ontology.ts`'s header; `star.ts`'s `galaxyId`; `resources.ts`'s header; three `client-resources.ts` JSDocs; `create-nebula-client.ts`'s two; `client-index.ts`.
  - `drive.ts`'s two scenario comments, and five test comments and headers.
- **Kept on purpose:** `dev-star-data-lifecycle.test.ts`'s six *apply* comments and one in `nebula-client-ontology-stale.test.ts` name the test door `applyOntologyForTest`, which the task keeps; `devstudio-resources-e2e.test.ts`'s *no apply step* is true; every other *apply* means something else, such as a migration, a codegen write or a merge patch.
- **Already current**, from Phase 1: `galaxy.ts`'s header, `getCurrentOntology`, `#buildAndAnnounce` and `requireChatWrite`; `star.ts`'s `#ontologySource`; `resources.ts`'s `#install`; `security.md`; and the no-`@mesh()` reason in `mesh.md` and the `resourcesResults` JSDoc, which cites only the validator. `REGISTRY_DIR` is gone.

**Found beside the list:**

- `assertModelPath` defended `.nebula/` with a registry row `#registryRows()` parses, both gone since Phase 1. The rule stands for another reason, which it now gives: the build writes its compiled row there.
- `#chatOntologySource` and `chat-ontology.ts` said chat version labels are *duplicate-rejected*. That was the deleted registry; `gen-validator-seeds.ts`'s header is right that the label is bumped by hand.
- `resources.ts`'s header pointed at `#gate`, split in Phase 2.
- `create-nebula-client.ts`'s config JSDoc still called the default reload *once-guarded*, which Phase 3's diff walk missed.

**Evidence:** `gen-scaffold.mjs --check` and `gen-platform.mjs --check` pass after regenerating; `check-examples` 176 of 176; unit 117 and dev-studio 115; the task-handle grep over the changed source finds nothing, and `codegen-loop.ts`'s header no longer names `compileAndInstallOntology` or a task-file phase. `studio-guidance-loop` 125.4 s and `four-party-chat` 78.8 s are green. `first-app-built` went green on its fourth run, 245.0 s, after three failures with three different causes: a WebSocket timeout on the first boot after the image rebuilt for the new scaffold; a build turn whose model made no tool calls in three rounds; and a login mail that never reached Resend, while the next scenario's mail arrived. None traces to the edited guidance, but the no-tool-calls turn is one sample against one pass, so it is noted here rather than recorded as a finding in `nebula-pre-alpha.md` § *Data-bound generation*.

**Retro:** the prose grep the task wrote, `-w` on `Apply|applied`, cannot see *Applying*, the very word in the step-6 sentence it existed to find; the list named that site, which is the only reason it was caught. A first widened grep using `\b` printed nothing, because git grep's ERE has no `\b`; checking it against the known step-6 hit is what showed it was blind.

### Phase 5, 2026-10-12

**For Larry:** nothing needs a decision. The deployed pass found one real defect, in the harness: the two scenarios Phase 1 moved to `.dev` armed their 60 s email waiter before a build, which deployed takes longer than that.

**Evidence:**

- **Local, `drive.ts all`.**
  - The first sweep was 63 of 65. `studio-overlays-by-url` timed out on its first page load, and `first-app-built`'s model returned a Workers AI 400. Both passed alone.
  - After the verifier fixes: 65 of 65, one parked by design, 35.1 min.
- **Deployed-only branches.** Checked before deploying, as `live.md` asks. Only two read an answer this task changed, and both read `getCurrentOntology`. `session-survives-token-lapse` takes any answer, and `client-routes`' deployed branches are log halves.
- **The deployed list, derived.** 20 scenarios: the 8 the task's diff touches, joined with the 19 that call `getCurrentOntology` or load a served page. That covers all eight the phase names.
- **First deploy, at `7dedb1f`:** 17 of 20.
  - `grant-reveals-denied` and `node-invite-roundtrip` timed out waiting for their invite mail. Resend's webhook shows each invite sent and delivered within a second, and the email-test Worker received it with the right instance tag. The waiter had simply expired: both scenarios armed it before their build, and since Phase 1 that build runs first. This also explains Phase 1's one-off local *never reached Resend*. Each now arms its waiter just before its invite.
  - `four-party-chat` waited 240 s for a reply that never came. The tail capture dropped 60–97 s windows exactly then, so it says nothing more; the scenario passed on the next deploy.
- **Second deploy, at `04a33a1`, with the verifier fixes:** 18 of 20, then 20 of 20 once the invite scenarios armed their waiters late. The two pass in 169.7 s and 230.2 s, and locally in 11.1 s and 9.1 s. Deployed, limb 7's lists answer again in 614 and 507 ms.
- **A `wrangler tail --format json` capture ran beside both deploys.** Under the load of two scenarios at once it reconnected and lost windows, which is why the silent turn stays unexplained.

**Retro:** a waiter armed early is the email-waiter rule's second shape, a filter that cannot match, in a new costume: a deadline that cannot be met. Every local tier was green because the local build is fast. Only the deployed venue's slower build exposed it, and the waiter's own message, *"Resend reported nothing"*, pointed at the mail. Resend's events said otherwise within a minute of asking.

### The verifier panel, 2026-10-12

Four read-only verifiers, one per phase. Phase 2 conformed; Phases 1, 3 and 4 did not. Every finding is fixed or recorded below.

**For Larry:** nothing needs a decision. Two findings were real defects in Phase 3, and the panel caught them because the scenario's fixture was the safe shape:

- **The gate could stay closed forever.** Only the probing op opened it. After a wipe, the restore's first row subscription became the probe, and once the Star installed, its retry was refused *not found*, because the wipe had deleted the row. That is not a stale answer, so nothing opened the gate and every op on the page waited forever. Limb 7 missed it because the scenario let go of its row subscriptions before the wipes. Now a probe that ends any way at all opens the gate: answered, refused for another reason, or let go. As a backstop, a gate still closed after 30 s opens anyway (`GATE_BOUND_MS`), which covers a probe whose answer was lost with its socket.
- **The gate's opening resent only first subscribes.** A subscription a restore had re-sent, refused `checking` while another op probed, was never sent again, so the page silently stopped hearing it. The gate now keeps each such channel's resend and sends it when it opens.
- **Smaller, in the same code:** a `checking` refusal on a subscription the page had already let go named the version being replaced, and reloaded a current page; it is now dropped.

**Fixed, with the evidence:**

- `stale-guard-and-gate.test.ts` gains five cases, each red under its own mutation and green otherwise:
  - a `checking` answer on a let-go subscription reloads nothing;
  - a probe let go opens the gate;
  - a probe refused for another reason opens it;
  - a probe whose answers stop opens it at the bound, on a real 30 s wait;
  - established subscriptions refused behind the gate are sent again.
- Limb 7 now holds two rows and two lists across both wipes, and requires both lists answered within 15 s, well inside the bound. Clean, both lists answer in about 505 ms. Live, it reds alone under a probe refused for another reason that keeps the gate closed, and under an opening that resends only first subscribes.
- *Rejected on the way:* opening the gate on any admitted answer, not only the prober's, saved at most one 400 ms retry, and no mutation could red it, so it was removed.
- **Phase 1:** the landing's named-field rule had no test. The fake build can now dress the row file with another label and an extra key, and spreading the file into the stored row reds that case. A `decideLanding` row with a failed bundle counted as arrived now pins the bundle check on `lands` itself.
- **Phase 1, the race:** two overlapping builds with a revert between them could leave the newer row current over the older source, since the second build compared the file with the row before the first had landed. `#buildAndAnnounce` now queues the whole build-and-land. The case holds the first build after its compile and reverts the file meanwhile; dropping the queue reds it.
- **Phase 2:** nothing checked a roster or list subscription's version on the Star. The no-version case now asserts the Star's own `arrived` line refused both, and running either through `#gateServer` reds it. The every-type half of limb 5's mutation note is struck: the count already validates each row against its own type, and limb 5 holds only `Deal`s.
- **Stale prose of the deleted registry**, which no grep for *Apply* could see, is rewritten in `star.ts`'s header, `build-box.ts`, `passage-not-dominion.ts`, `smoke.test.ts`, two benchmark comments, `dev-star-data-lifecycle.test.ts` and `path-guard.test.ts`. `node-invite-roundtrip.ts`'s `appended` became `landed`, and `ontology.md`'s three *deploy time* lines now say a build compiles the file.
- `conflict-outcome.test.ts`'s `D16/D17` handle is gone, and `chat-ontology.ts` no longer reads as a contradiction.
- The no-tool-calls build turn, and one model error, are logged in `nebula-pre-alpha.md` § *Data-bound generation*, as `studio-guidance.md` requires.
- The scenario's pages each mint a fresh token, so a deployed run past one access token's 15 minutes cannot strand them.

**Suites on the final tree:** `packages/resources` 17; `apps/nebula` unit 118 and dev-studio 116, each up by its new case; offline 2, frontend 236, browser 4 with 2 skipped. `baseline` ran all 569, the 564 before plus the 5 new cases: 568 passed, and `set-union-merge` timed out at 30 s under the load and passes alone twice. The run then stalled at exit, as before. `drive.ts all`, container scenarios included: 65 of 65, one parked by design, 35.1 min.

**Recorded, not changed:**

- `star-serves-current-ontology`'s stale tab is the owner's own old tab, not a collaborator's. The Star treats both alike.
- `source-chat-floor.test.ts`'s F2 reads the compiled row through `readSource` rather than the served meta. It is a direct check, and it reds with the path rule off.
- Limb 7's mutation note named "the guard records an empty version". The mutation run was the one that produces that: a notice naming no version taking the reload path.
- The identifier grep finds 16 hits, not 15. The two left out of the count are `workflow.md`'s *installing any npm package* and an RPC comment; all are kept.

### Phase 6, 2026-10-12

- **What it did.** The Client's version gate is gone. `StaleGate`, its 30 s bound, its record of owed resends and the four ways it opened leave `client-resources.ts`, which shrinks by about 130 lines. `#versioned` retries its own `checking` answers, and a push channel resends its own. `#onPushAnswered` and `#onPushEnded` became one `#clearRetries`, since without the gate both only reset a channel's count. `#versioned`'s `name` parameter existed only to name the probe, and `#resendVersioned`'s `skip` set only to leave out the gate's owed channels; both go.
- **Tests.** `stale-guard-and-gate.test.ts` is now `stale-guard-and-retry.test.ts`. The guard case is unchanged. The four gate cases are deleted, since each guarded a part of the gate: a reconnect while it was closed, a probe let go, a probe refused for another reason, and a probe at the bound. The let-go case now waits for the second subscription's retry rather than the gate's line. The owed-resend case now asserts that a restore's established subscriptions are each sent again. Both red under their own mutations: deciding a let-go channel's `checking` answer like any other stale answer reloads the page, and resending a resource subscription only while it awaits its first answer leaves the restored ones unadmitted.
- **Live.** Limbs 6, 7 and 9 read no gate line, and the scenario's debug sink, which existed only for that line, is gone. Clean, every limb is green: both lists answered again 505 and 503 ms after each wipe, and limb 9's three ops ended in 1,635 ms. A push channel whose `checking` answer is never resent reds limbs 6, 7 and 9; an established list never resent reds limb 7 alone; a request retrying to ten times its limit reds limb 9 alone, at 16 s.
- **Verification.** `apps/nebula`: unit 118, offline 2, frontend 236, dev-studio 116, browser 4 with 2 skipped, and baseline 565, the earlier 569 less the four deleted cases, counted from its lines because it still stalls at exit. `packages/resources` 17. `drive.ts all` passed 64 of 65 in 33.8 min, with one scenario skipped by design. `first-app-built` failed once, when Workers AI answered the turn's fifth model call with HTTP 400, and passed alone straight after, in 14 rounds and 4 builds. `galaxy.ts` cuts the 400's body to 300 characters before any log sees it, so its cause is unknown. No deployed pass: the phase changes how the Client handles what it hears, not what it hears, which is the line `live.md` draws.
- **For the human:** on a tenant Star with nothing published, each op's retry asks the Galaxy again, because the Galaxy's answer of no row clears the Star's ask. Limb 9 counted 9 asks from three ops in 1.6 s, where the gate let one op ask. It is the one case where the Star's shared call does not hold the Galaxy to one call, and before alpha such a Star's pages answer 404.
- **Retro:** two defects in one mechanism are the trigger `calibration.md` §2 names, and neither the verifier round nor the phase-end walk asked what the gate was still for. Larry's *"should we do anything about this?"* at the retro did.
- **Close-out:** a grep for `version gate`, `StaleGate`, `GATE_BOUND` and `gateClosedFor` over `packages apps website .claude docs` finds only `live-scenarios.md`'s dated example of a backstop rescuing a mutation, which stays as history.

## Phase Retro

Written 2026-10-12, before the archive move; Larry reads it first.

1. **What did we learn?**
   - **A limb's premise can be vacuous when its assertion is not.** Twice a live limb went green under a mutation for reasons in its setup, not its check:
     - Pages that subscribed before connecting had every subscribe re-sent by the first connection's restore, which answered the subscribes the gate was holding.
     - Timing decided which ops the Star refused.
     - The fix both times was to wait on the Client's own line (`version gate closed`) before acting, the way a real app waits on `ready`.
   - **A backstop can rescue a mutation.** The gate's 30 s bound opened a stranded gate inside limb 7's 30 s wait, so a real wedge passed. A limb's wait has to sit well inside any bound the code has.
   - **The panel found what the builder's mutations could not:** a scenario that let go of its row subscriptions before wiping, which is the safe shape of the very path the gate failed on.
   - **"Passes alone, fails under load" named no cause.** Two of the three timeouts blamed on load were real bugs (item 3).
   - **A mechanism's second defect is the moment to ask what it is for.** The gate had two, and its reason had already moved to the Star; it went in Phase 6, prompted by Larry's question at the retro rather than by the verifier round.
2. **What did we struggle with?**
   - The full `baseline` run stalls at exit, and sometimes before printing its summary, so its totals have to be counted from `✓`/`×` lines.
   - `wrangler tail` lost 60–97 s windows with two scenarios running, exactly when a silent turn needed explaining.
   - Instruments that read as clean while blind: `git grep -w Apply` cannot see *Applying*, and git grep's ERE has no `\b`, so the first widened grep printed nothing at all.
3. **Did any tests fail unexpectedly?**
   - **The gate wedge.** Only the probe could open the gate, and a probe can end without a stale answer: refused *not found*, let go, or never answered. Each now ends the wait.
   - **Owed resends.** The gate's opening resent only first subscribes, so established ones refused behind it were lost.
   - **The deployed invite waits.** Each waiter was armed before a build longer than its 60 s. Resend's own events showed the mail delivered within a second.
   - **Timeouts blamed on load.** A separate session found two were bugs. `resubscribe-on-signal`'s Client opened a second socket during a token rotation and lost its queued call (`18e9b07`, `8937c8b`). An alarm wait timed out because a Mesh alarm delivered a millisecond early ran nothing and was never armed again (`b8d3734`). `set-union-merge`'s is unexplained; that session's commits do not mention it.
4. **Impact on follow-on work?**
   - **ADR-024 now names two versions, the ontology version and the build version** (2026-10-12), and is renamed [024-two-versions-keep-an-app-in-step.md](../../docs/adr/024-two-versions-keep-an-app-in-step.md). The build version's `.dev` half becomes a small task file, *a page knows which build it runs*, drafted once Larry finishes reviewing ADR-024. It absorbs fast-follow Item 8, and personas will consume it. Its published half becomes a paragraph in fast-follow Items 4 and 5.
   - **A publish promotes the build whole, validator included** (Larry, 2026-10-12). Fast-follow Item 4 no longer has to compile a published validator apart from the app's own code.
   - Personas can now hand its `.dev` Star a landed row (this task's goal 3).
5. **Process changes**, made in the close-out commit:
   - `testing.md` § *An email waiter MUST name whose mail it is waiting for*: a third shape, a waiter armed before a step whose length differs by venue. Arm it just before the send.
   - `testing.md` § *An INSTRUMENT is an assertion too*: `git grep`'s ERE has no `\b`, and `-w` matches a stem's exact form only.
   - `live-scenarios.md`: a limb's page acts only after its connection, as an app waits on `ready`; and a limb's wait sits well inside any bound the code under test has.
   - From the timeout session (`b36160d`): `testing.md` no longer explains an alarm wait's timeout as CPU starvation, and says to read what the Durable Object held first.

**Close-out, still to do:**
- Archive this file once Larry has read the retro.
- Repoint its links in `backlog.md`, `nebula-pre-alpha.md`, `nebula-pre-alpha-fast-follow.md` and `nebula-testing-with-personas.md`, with their statuses: the personas task now waits on one sibling, not two.
- Leave `nebula-agent-posts-as-itself.md` to its own session, and tell that session the path moved.
- Commit ADR-024, its `workflow.md` line and its repointed links once Larry's review ends.
- `backlog.md` line 281 already says this task settled its item; check the rest of the `.dev`-ontology rows there for anything this task closed.

## Non-goals

- **`publish()`, the order and storage of published versions, and migration.** Fast-follow Item 4.
- **The deterministic breaking-change detector.** [backlog.md](../backlog.md)'s *Studio: breaking-ontology-change → deterministic Reset-data/Revert prompt*.
- **Provisioning as the `.dev` Star's reset.** [nebula-testing-with-personas.md](../nebula-testing-with-personas.md).
- **One shared intake for query and resource subscriptions.** [backlog.md](../backlog.md)'s *Query and resource subscriptions share one intake*.

## Review progress

Recorded as it happens, so a later session can pick up where this one stopped.

- **2026-10-11, `/review-task` Stage 1 launched** as workflow run `wf_419d6fe4-881` on this phase-less file, with ADR-024 on the reading list. Its synthesis lands here when it returns. If it never does, re-run Stage 1 from scratch: a workflow's cached results do not cross sessions.
- **2026-10-11, Stage 1 returned** (run `wf_419d6fe4-881`): 49 raised, 48 survived, all four lenses ran; one blocker, eleven majors. Most land in § *Design intent* and § *What changes*, and several in ADR-024. The queue follows.
- **2026-10-11, Stage 1 item 1 resolved (Larry): every op from a Client carries its page's version, and a stale notice is read by the version it names** (§ *Decisions*). It settles B1 and M2. Larry asked that query and resource subscriptions share code so they cannot drift; the split version check and the single stale handler are this task's part, and the broader merge is a backlog row.
- **2026-10-11, Stage 1 item 2 resolved (Larry): the Star shares one call to its Galaxy, the Client's gate opens when retries run out with no reload, and the reload guard wraps any handler** (§ *Decisions*). It settles M3 and M4.
- **2026-10-11, Stage 1 item 3 resolved (Larry): a build lands only if every step it ran succeeded, and the current row lives in the Galaxy's own storage** (§ *Decisions*). It settles M1.
- **2026-10-11, Stage 1 item 4 resolved (Larry): a tenant Star runs no data operation until something is published; its tests come back with `publish()`, recorded in fast-follow Item 4 and in `getCurrentOntology`'s JSDoc** (§ *Decisions*). It settles M5.
- **2026-10-11, Stage 1 item 5 resolved (Larry): the model's judgment stays the interim detector, backed by a logged count of rows the new validator refuses, and the Wipe button reports a refusal** (§ *Decisions*). It settles M8 and S3; the install-time notice idea moved to the backlog row.
- **2026-10-11, Stage 1 item 6 resolved (Larry): ⑤ is iceboxed** with a status update; its migration strategy, what `publish()` must record and the open question about a history file moved to fast-follow Item 4. It settles S2 and M6. Every item needing Larry is decided; the author's findings follow: ADR-024 trimmed to commitments and its blockquote corrected (S4, M10, M11, m1, m2), the hand-made lists replaced by a grep (S5, M7), the Studio branch cut (S6), the sibling files brought up to date (M9), and the minors and nits.
- **2026-10-11, the author's findings applied.** ADR-024 trimmed to commitments, with its blockquote a list of today's real divergences and environment Stars, in-flight writes and reload herds under § *Deliberately open*; its index line now 60 words. In this file: the old-path inventory is a grep a phase runs and judges, with the known sites named; the Studio branch is cut; the line the loop may not cross is stated positively; repeated points are trimmed; the collapse is named as the change that left the ontology broken. Personas, fast-follow Items 4 and 5, the master plan and the backlog now describe the new model. Every claim in these edits that came from the review was checked against the code. **Next: Pass 2.** The edits since Stage 1 filled in mechanism inside the shape Larry approved, and he made each decision, so `/review-task` § *Gate* calls for re-scouting and Stage 2 rather than another Stage 1; Stage 2 needs the phases first.
- **2026-10-11, Pass 2 written and `/review-task` Stage 2 launched** as workflow run `wf_cd1fb859-0fb`. Larry no longer reads phases, so this stage is their only review; at its gate only a decision Pass 1 lacks goes to him. If the run never returns, re-run Stage 2 from scratch.
- **2026-10-11, Stage 2 returned** (run `wf_cd1fb859-0fb`): 66 raised, 65 survived, all three lenses ran; no blocker, 17 major, 13 minor, 3 nits. None is a decision Pass 1 lacks, so none goes to Larry: each tightens a mechanism inside his decisions or fixes a criterion that could not fail under its own mutation. The author applies all of them; the queue follows the Stage 1 record.
- **2026-10-11, Stage 2 applied.** All 33 items landed in § *Context*, § *What changes*, § *Design intent*, § *Phases* and ADR-024, each code claim checked against the source first. Three became § *Decisions* rows: `getOntologyVersion` goes with no replacement member; a `.dev` page served while a build's output arrives is accepted under the personas task's risk test, and ADR-024 lists the published case as open; and each scenario that drives `.dev` claims its own app. The limbs are renumbered in phase order: the Wipe button became limb 4, and the shared ask moved to the vitest lane, because only there can the Galaxy's answer be held until all ten ops arrive. ADR-024 stays Proposed, since no ADR is ratified before pre-alpha launches.

### Stage 1 findings, 2026-10-11

The 48 verified findings reduce to 18 items after deduplication: 1 blocker, 11 major, 5 minor and 1 nit. Almost every blocker and major item lands in § *Design intent* and § *What changes*. Larry said he had not yet checked those sections against the rewritten Context and Goals, so that alignment pass is needed before Stage 2.

#### Structural recommendations (rewrite, cut, defer)

- **S1. Rewrite § *Design intent* around three decisions it leaves open. Most of the major items follow from them.** Give each decision one home in § *Design intent*, and point to it from § *What changes* and § *Decisions*.
  - (a) Where the current row lives, and what "a build lands" means (M1).
  - (b) Whether every plane op carries the page's version (B1).
  - (c) What a stale notice means to the Client (M2).

  Rewrite the rest of § *Design intent* against those three answers.
- **S2. Move ⑤ (nebula-ontology-history-file.md) or re-derive its timing.**
  - Decision row 3 says a history entry is written "only when a version is published". Publish is fast-follow Item 4, which is alpha work.
  - So nothing writes that file before the wipe, and ⑤'s § *Why this timing* no longer holds.
  - This task also removes most of ⑤'s "What dies" list.
  - Propose moving ⑤ beside fast-follow Item 4. Update nebula-pre-alpha.md row ⑤ and decision 2 to match. (M6)
- **S3. Cut the breaking-change-detector design out of § *Design intent*.**
  - Keep only the pointer: "TEMP → target: backlog.md's deterministic detector".
  - Move the install-time hook and the Studio notice into the backlog row, and reconcile them with that row's design there.
  - Record the interim, where the model's judgment is the only detector, as a § *Decisions* row for Larry to rule on. (M8)
- **S4. Cut mechanism out of ADR-024 and keep only its commitments.**
  - The commitments to keep:
    - The Galaxy decides which version runs, by kind of Star.
    - A Star installs only what its Galaxy calls current.
    - A page and a Star compare versions by equality alone.
    - A page that is behind reloads; it is never served across versions.
    - Data moves forward only.
    - Nothing compiled for `.dev` is loaded by a Star with real users.
  - Move to the task file or ⑤: the retries, the reload guard, the "temporary mismatch" refusal, the typia facet, and the migrate-on-read candidate. (M10)
- **S5. Replace the hand-made inventories in § *What changes* with a grep that a phase runs and judges hit by hit.** (M7)
- **S6. Cut the "page on the Galaxy's own host" branch from "The Galaxy answers each Star by kind".** Only test fixtures call it. (m3)
- **S7. State the scope cut outright: tenant Stars run no Resources op, node invites included, until publish exists.** (M5)

---

#### BLOCKER

**B1. Not every op carries the page's version. Under the new skip rule, a V2 page's list subscription dies silently.**
- **Location:**
  - Context steps 2–3.
  - § *Design intent*, "A tab reloads once for each version it does not run".
  - § *What changes* → Kept (`Resources.#gate`).
  - ADR-024 § *How the page and the Star catch up*, step 1.
- **Finding:**
  - `subscribeQuery`, `subscribeQuerySubscribers` and `invite` call `#gate(undefined)`, and the Client's `subscribeQuery` sends no version. Once anything is installed, these three ops run at whatever version the Star holds.
  - Goal 2's own example then fails, deterministically:
    1. The V2 page's list query runs unpinned at V1.
    2. Its pinned row subscribes are answered `checking`.
    3. The pull installs V2. `#install` clears every resource, query and roster subscriber and sends a notice naming V2.
    4. `#dispatchOntologyStale` fills in the tab's own version, so the new rule skips the notice.
    5. Nothing re-subscribes the list.
  - Today's set-once reload hides this.
  - The refusal also reaches the Client three ways: `transaction` returns it, `read` and `invite` throw it, and the subscribes push it.
- **Suggestion:**
  - Record the choice in § *Decisions*. The recommended option is that every plane op carries the version: the Client sends it on query, roster and invite, and the plane gates on it. That makes Context and ADR-024 true and removes M2 case (b) (calibration §2).
  - The fallback is to narrow Context and the ADR to "every op that pins a version", and have a notice naming the tab's own version restore subscriptions instead of being skipped.
  - Move `#gate` out of "Kept as they are".
  - In the Adapted gate bullet, name the six Client intake sites: `#meshSubmit`, `read`, `#inviteToNode`, `handleResourceUpdate`, `handleQueryUpdate` and `handleQuerySubscribersUpdate`.
  - Add a /live limb in which a list subscription survives a version change.
- **Lenses:** spec-hygiene, scope-discipline, prose-voice.

#### MAJOR

**M1. The current row has no named home, and the stated rule for when a build lands is wrong.**
- **Location:**
  - Objective.
  - § *Design intent*, "The current row changes only when a build lands".
  - § *What changes*: New 1, Adapted `#buildAndAnnounce`, Removed (`#appliedHead`'s fallback), Kept (`#serveBuiltApp`).
  - ADR-024 § *What a version names*.
- **Finding:**
  - **No home is named.**
    - `ROW_PATH` (`.nebula/ontology-row.json`) is rewritten by every successful compile, before `vite build` runs. If it serves as the current row, a failed bundle still moves it.
    - `#appliedHead` looks up a row by the working file's hash. Removing only its fallback leaves a lookup that answers null whenever the working file differs from the last landed build.
  - **"The same two checks the preview refresh makes" is wrong.**
    - `decidePreview` also withholds on a failed ontology step, on type findings and on the model's override.
    - `#buildOnce` replaces `/dist` whenever `bundle.ok` and `#distArrived` both hold, whatever the preview decided.
    - So a row tied to `preview.refreshed` lags the dist being served.
  - **A dist pins no version.** `#serveBuiltApp` writes the version into the page when it serves it, from the current row.
  - **A build can land with a failed ontology step.**
    - job.ts runs the ontology step, the type check and vite unconditionally.
    - So a build whose ontology step fails but whose bundle succeeds serves new page code under the old row.
    - That falsifies "always come from the same build" and ADR-024's "never meet".
  - **Other gaps:**
    - `#pendingOntology`'s trigger ("no row in the folder") has no replacement.
    - The Objective says "last build", while the body says "last landed build".
  - **These still state the old model and are not listed:**
    - `getCurrentOntology`'s JSDoc ("never by trusting a stored pointer").
    - ⑤'s "no stored latest pointer" line.
    - dev-studio.test.ts's file-first fallback test.
- **Suggestion:**
  - The current row is a designation that host code writes at landing. Store it at its own path under `.nebula/`, or in Galaxy DO KV, which keeps it out of reach of the collaborator-editable `vite.config.ts`. Never use `ROW_PATH`.
  - One helper reads it. `getCurrentOntology`'s `.dev` branch, `#serveBuiltApp`'s meta and personas' hand-off all call that helper.
  - "Lands" means `bundle.ok && #distArrived(indexSha256)`, independent of the preview decision.
  - Decide the case where the ontology step fails and the bundle succeeds:
    - either it does not count as landed (require `ontology.ok`, or gate vite on it),
    - or accept the skew on `.dev` test data and soften the ADR.
  - `#pendingOntology` compares the file's hash with the current row's version.
  - Move `#serveBuiltApp` to Adapted, and give `#appliedHead` a stated fate.
  - Change the Objective to "last landed build".
  - List the stale JSDoc, the ⑤ line and the test under "What describes the old path".
- **Lenses:** all four (five findings).

**M2. A stale notice also means "your subscriptions were dropped", not only "your version is old", and the per-version guard strands tabs.**
- **Location:** § *Design intent*, "A tab reloads once for each version it does not run"; New 4; Decisions row 4.
- **Finding:**
  - **(a) Resets.**
    - `Resources.wipe()` notifies with `currentVersion` `''`.
    - The guard records `''` on the first reset, then skips every later reset in that session, even though each wipe dropped all the tab's subscriptions.
    - Personas' provisioning wipes on every run, and "Provisioning twice" is a tested scenario.
    - So a persona's phone tab goes dead on the second provision, and that tab is New 4's own motivation.
  - **(b) Installs:** the same failure as B1.
  - The rule is stated three times: New 4, § *Design intent* and Decisions row 4.
- **Suggestion:**
  - Pin the meaning of a notice:
    - A notice naming the tab's own version, or naming `''`, makes the Client run the existing `#restoreSubscriptions()` instead of reloading.
    - The Client reloads only for a notice naming another version.
  - The alternative is to key the guard on something unique per drop, or to clear it once an op succeeds after the reload.
  - State the rule once, in § *Design intent*, and point to it from the other two places.
- **Lenses:** spec-hygiene, prose-voice.

**M3. The Client gate does not deliver "one call per page".**
- **Location:** § *Design intent*, "The version check stays inside our Client"; Adapted "NebulaClient's retry becomes a gate".
- **Finding:**
  - The gate closes on the first `checking` answer, but a page's mount burst reaches the Star before any answer returns.
  - The Star's `#ontologySource().current()` makes a fresh `lmz.call` for every mismatched op, and `#gate` keeps no record of an ask already in flight.
  - So the burst still costs one Galaxy call per op, and so does the resubscribe after a reconnect.
  - Nothing says that ops refused before the gate closed are sent again.
- **Suggestion:** pin one mechanism, or correct the claim.
  - Option 1: the Star remembers an ask in flight, in memory, so concurrent mismatches share one call. An eviction costs one extra ask.
  - Option 2: the Client sends its first plane op alone and opens the gate on the answer. That costs one round trip per page load.
  - Either way, add that ops refused before the gate closed queue behind it and are sent again when it opens.

**M4. "App code never sees a version refusal" overclaims, and the stuck state has no stated exit.**
- **Location:**
  - Context steps 4–5.
  - § *Design intent*: the Client bullet, and the reload bullet's "stays put".
  - § *Decisions*, "Our Client absorbs a version mismatch".
- **Finding:**
  - **The public API still delivers the final stale to app code:**
    - `TransactionOutcome` has `{ kind: 'ontology-stale' }` (conflict-outcome.ts:73, set at :227).
    - `#readResource` rethrows the error.
    - An app may supply its own `onShouldRefreshUI`; it is documented with a `() => {}` opt-out. Such a handler bypasses the per-version guard, which lives only in `defaultOnShouldRefreshUI`.
  - **The docs teach apps to handle it:**
    - api-reference.md's outcome table.
    - api-reference.md's `onShouldRefreshUI` row, which describes the sessionStorage once-guard that New 4 replaces.
    - resources.md's `case 'ontology-stale'`.
    - ontology.md's lock-step bullet.
  - **Undecided:** when the retries run out and no reload happens, does the gate hold every op forever (the "thinking… forever" class, calibration §12 and §13), or open and fail ops to app code?
- **Suggestion:**
  - State the exit: whether the gate opens, what held and later ops resolve with, and what a persona tab shows in Studio.
  - Then choose one:
    - narrow the claim to the temporary `checking` mismatch, and add the four doc sites to § *What changes*;
    - or make the reload the Client's own, with the guard wrapping any handler and `onShouldRefreshUI` kept for admin and scripting, and list that as a public-API change.
- **Lenses:** scope-discipline, prose-voice, product-vision.

**M5. Tenant Stars run no Resources op until publish. The file never says so, and "build instead" cannot work for the tests that drive a tenant Star.**
- **Location:** § *Design intent*, "a tenant Star installs nothing"; Removed, `Galaxy.applyOntology` ("build instead, or go").
- **Finding:**
  - Under answer-by-kind, a build never gives a tenant Star a row. `invite` needs an installed ontology to write `_InviteStatus`.
  - The callers that break:
    - `node-invite-roundtrip.ts` and `grant-reveals-denied.ts`, the only live witnesses of node invites and ADR-008 visibility.
    - `star-serves-current-ontology`, limb 1 (a tenant Star) and limb 2 (a revert with no Apply, which relies on the file-first lookup).
    - version-rule.test.ts's `emptyStarUnderGalaxy`.
    - plane-wipe.test.ts:225.
    - dev-studio.test.ts's file-first case.
  - The /live scenarios cannot reach `applyOntologyForTest`.
  - These changes are right (calibration §3(b)), but a cold implementer will read the red tests as a design bug, or delete the witnesses.
- **Suggestion:**
  - In § *Design intent*, state the accepted cut: tenant Stars run no Resources op until publish exists. Before alpha, every tenant Star's pages answer 404 anyway.
  - In Removed, say what each caller becomes:
    - The invite and visibility scenarios move to the `.dev` Star, after a real build.
    - In `star-serves-current-ontology`, the tenant limbs invert (the tenant is answered `checking` and installs nothing). The stale-tab limb moves to `.dev` with a collaborator's old tab. The revert limb builds after reverting.
    - dev-studio's file-first case becomes "current moves only at landing".
    - The vitest tenant cases use `applyOntologyForTest`.
    - The install-wipe cases in plane-wipe and the `{ wipe: true }` cases in source-chat-floor go.
- **Lenses:** scope-discipline, spec-hygiene.

**M6. ⑤'s reason to run before the wipe is gone (see S2).**
- **Location:**
  - this file's § *Relationships* ("Nothing open gates it") and Decisions row 3.
  - nebula-ontology-history-file.md § *Why this timing*, *What dies*, *What stays* and *Tabled here*.
  - nebula-pre-alpha.md row ⑤, and decision 2 under § *What remains*.
- **Suggestion:**
  - Add a § *Relationships* bullet: this task moves ⑤'s first writer to `publish()`.
  - Propose moving ⑤ beside fast-follow Item 4, or re-deriving its timing.
  - Update pre-alpha row ⑤, and decision 2, which this task's current row partly settles.

**M7. The inventories in § *What changes* miss sites, including guidance the model reads every turn.**
- **Location:** § *What changes*: Removed, Adapted "What describes the old path", Kept; § *Constraints* (the studio-guidance embed).
- **Finding:**
  - **Code: `wipeOnInstall` survives, so "nothing will write that bit" is false.**
    - The field is on `OntologyVersionConfig` and `OntologyVersionRow` (packages/resources/src/ontology-version.ts), and ontology-compile.ts:112 copies it.
    - The kept `applyOntologyForTest` writes it, and its JSDoc promises that such a row wipes.
    - The test Galaxies write it through `opts.ontology.wipe` (baseline/index.ts:543, dev-studio/index.ts:73).
    - Tests assert it: plane-wipe.test.ts (the `it.each` install path, :201 and :222, `setChatSourceForTest` at :263) and dev-studio.test.ts:173.
    - Personas' grep criterion cannot pass while the field stays.
  - **Code: dead readers.** `listOntologyVersions` and `VERSION_RE` read only the folder this task removes.
  - **Expired justification (calibration §4).**
    - mesh.md § *A gate the RESPONSE leg reaches*, star.ts's `resourcesResults` JSDoc and resources.ts's `ResourcesResults` JSDoc each say "on a `.dev` Star, runs the install's wipe" as part of why there is no `@mesh()`.
    - The conclusion still holds, for the validator reason. Re-derive it there.
  - **JSDoc and comments:**
    - `requireChatWrite`, and `assertModelPath` (which cites `#registryRows()`).
    - galaxy.ts: `ontologySource()`, `#chatOntologySource`, `REGISTRY_DIR`.
    - star.ts: `#ontologySource` ("told `installing`", "sibling Stars share one bundle keyed on the Galaxy") and `galaxyId`.
    - resources.ts: the header and `#install`.
    - codegen-loop.test.ts, the SECURE-BY-DEFAULT comment.
  - **Docs the model reads (Goal 5's own defect):**
    - ontology.md: "coordinated `ontologyVersion` bump", and the bundle "ships alongside".
    - nebula-client.md:22 and using-vue.md:44: "absent until an Apply".
    - api-reference.md's `onShouldRefreshUI` row.
  - **Scaffold:** `container/app/src/nebula.ts` says "ABSENT until an ontology is applied". Fixing it needs `gen-scaffold.mjs` and the scaffold-seed drift check, not only the platform embed.
  - **Probes:**
    - mesh-entry-reach needs a `@mesh()` member that takes an argument; `getCurrentOntology` takes none.
    - client-routes uses `getOntologyVersion` as limb 6's positive control.
  - **Kept list:**
    - It lists `#serveBuiltApp`, whose meta changes, and `applyOntologyForTest`, whose JSDoc has the wipe sentence.
    - It restates fast-follow's count of "six skipped tests".
- **Suggestion:**
  - State the property the lists stand for, then add a grep that a phase runs and judges hit by hit:
    - over `apps packages website/docs .claude docs`: `git grep -nwE 'applyOntology|getOntologyVersion|listOntologyVersions|wipeOnInstall|WIPE_ON_INSTALL|REGISTRY_DIR|registryPath|appliedHead|INSTALLING_RETRY|isInstalling'`
    - plus prose hits for `installing|Apply|applied|install's wipe`.
  - Add to Removed: the field on both types, the compile's copy, the test subclasses' `wipe` option, and the wipe-on-install tests. plane-wipe keeps its reset path.
  - Keep `applyOntologyForTest`, minus the wipe sentence in its JSDoc.
  - Name the replacement probe member.
  - Name `gen-scaffold` beside the embed in § *Constraints*.
  - Drop the count.
- **Lenses:** all four.

**M8. The breaking-change-detector bullet designs the target, conflicts with the backlog, and leaves its interim unpriced (see S3).**
- **Location:** § *Design intent*, "The model's judgment is the breaking-change detector, as an interim"; Context step 6.
- **Finding:**
  - **Conflicting designs.**
    - The bullet detects at the `.dev` install and shows the notice "in Studio, above the persona tabs".
    - That install happens lazily, so detection would not fire until a tab is open.
    - backlog.md:649, re-derived 2026-10-10, hooks at the Galaxy's codegen-turn commit, and the agent posts a revert-or-provision choice in chat.
  - **An unpriced interim.**
    - The interim is the case the backlog row calls a footgun.
    - It is priced with personas' guard test, which prices guards, not a missed detection that makes no noise (calibration §9): the agent ends up debugging correct code against stale rows.
  - **A reset that does nothing.**
    - Until personas lands, step 6's "ask for a reset" means Studio's Wipe button.
    - For a non-admin collaborator such as Austen, that button logs success and does nothing (App.vue's optimistic log; `resetDevData` calls `requireDominionHere`). That is the defect Goal 5 names.
- **Suggestion:**
  - Cut the bullet to the TEMP → target pointer, and reconcile the hook and the surface in the backlog row.
  - Add a § *Decisions* row for the interim.
  - Write step 6 without naming a mechanism ("existing test data will need a reset; ask"), so personas can add `provision` without rewriting it.
  - Optionally, have the `.dev` install log how many existing rows fail the new validator. That check is deterministic and sits on a path this task already touches.
- **Lenses:** all four.

**M9. Sibling files still describe the retired model.**
- **Location:** this file's § *Relationships*, which names only personas; and the last Adapted bullet, which points at ⑤'s already-annotated child bullet rather than its stale parent.
- **Finding:**
  - **personas:**
    - § *Current state*: "appends its row", "installs the row that build appended", and `installing` (lines 65 and 123).
    - § *Relationships*: "append chokepoint becomes the build" and "moves the ontology's append".
    - Item 12 and the criterion at line 263 claim the `applyOntology` deletion that this file owns.
    - "every build applying its ontology" (line 32).
  - **nebula-pre-alpha.md** § ②: "every build applying its ontology" (line 106).
  - **Fast-follow Item 4:**
    - § *Current state* says "the applied row … published or not".
    - It says "D23 fences it … replaces the fence", but this task deletes that fence.
    - Its candidate shape keeps "a triggered pull promotes".
    - It lacks the requirement § *Future state* sends it: a published row is compiled where the user's build config cannot reach.
  - **Fast-follow Item 5:** "the ontology label is baked into the build (serve.ts does no VERSION templating)" contradicts ADR-024 and `#serveBuiltApp`.
  - **⑤ § *The scheme*:**
    - The parent bullet ("`applyOntology`'s dominion check", `wipeOnInstall`) is the stale one.
    - "What stays" says there is no stored latest pointer.
    - "What dies" overlaps this task (`getOntologyVersion`).
    - § *Tabled here* is stale too.
  - **backlog.md:281 (ii):** the `applyOntologyChange` / `setAppVersion` ordering worry is settled by serve-time injection.
  - **ADR-024 Alternatives** reject "the Galaxy pushes each new version", and personas' hand-off carries a row to the dev Star.
- **Suggestion:**
  - Add § *Relationships* bullets for ⑤, fast-follow Items 4 and 5, and pre-alpha.
    - This file owns the `.dev` current row, `getCurrentOntology` answering by kind, and the deletions.
    - ⑤ and Item 4 keep the published order, its storage, and the published row's source.
  - Rewrite the sibling sentences now. They are prose, and Goal 1 asks for it.
  - Turn personas' bullets into pointers, and drop item 12 and the append bullet.
  - Mark backlog (ii) settled.
  - Add one clause to ADR-024: handing a Star its Galaxy's current row is not the rejected push.
- **Lenses:** spec-hygiene, scope-discipline, prose-voice, product-vision.

**M10. ADR-024's headlines overclaim, and the ADR carries mechanism (see S4).**
- **Location:**
  - The title and § *Decision*'s bold line.
  - § *What a version names*; § *How the page and the Star catch up*, steps 3–4.
  - § *Data moves forward only*; § *Consequences*; § *Deliberately open*.
  - workflow.md's ADR-024 index line.
- **Finding:**
  - **Overclaims:**
    - "One version names one whole app" is contradicted two sentences later.
    - "A page and a validator from different builds never meet" is false when the ontology is unchanged, and in M1's failed-compile case.
    - "One version at a time", in the title and the index line, is never defined in the body. It reads as stepwise migration, which the body calls only a candidate.
    - "Only forward" is false on `.dev`, where a revert makes an older hash current.
    - "Each version it falls behind" implies an order that hashes do not have.
  - **Mechanism in the ADR:**
    - Retries, the "temporary mismatch" refusal, the per-version reload guard, the typia facet, and the migrate-on-read candidate (which clashes with *Deliberately open*'s "When migration runs") all belong in the task file, per docs/adr/README.md.
    - Step 3 as written forbids the hold-each-op alternative that the § *Decisions* table weighed.
  - **Repetition:** § *Consequences* restates steps 3–4, which prose-voice says MUST NOT happen.
  - **ADR-004:** the ADR wipes `.dev` without saying why that sits outside ADR-004's no-destructive-writes commitment.
- **Suggestion:**
  - Open the Decision with what a version guards: one data shape, and a page runs only against the validator its version names.
  - Define "one version at a time" in the body, or retitle, and fix the index line to match.
  - Scope "forward" to migrated data off `.dev`, and write "each version it does not run".
  - Move the mechanism out, putting the migration candidate under § *Deliberately open*.
  - Drop the restated Consequences.
  - Add one clause saying `.dev` test data sits outside ADR-004's history.
  - Leave "is ever" alone, since it is house voice. The Evidence link to a live task file is a weak point.

**M11. ADR-024's "Today's code differs" blockquote misstates today's code.**
- **Location:** the blockquote, under § *Who decides* and § *Data moves forward only*.
- **Finding:**
  - It omits the biggest divergence. `getCurrentOntology` is a bare `@mesh()` that returns `#appliedHead()` to every descendant Star (galaxy.ts:528–531), so any applied row reaches a tenant.
  - "No Star but `.dev` has a version to run" states the target as today's fact, and contradicts the blockquote's own first sentence.
  - "Nothing calls it" should say no product path does: harness scenarios and about 20 tests call `applyOntology`.
  - It also omits that some ops pin no version, and that the current version derives from the working file, so a revert changes it without a build.
  - A validator cache entry is shared per Galaxy per version (`bundleId` is `${galaxyId}/${version}`), not by every Star.
- **Suggestion:**
  - Rewrite the blockquote as a list:
    - The Galaxy answers every Star with the same row.
    - The current version derives from the working file.
    - Rows live in a folder only `applyOntology` writes, and no product path calls it.
    - Query, roster and invite pin no version.
    - The Stars of one Galaxy share a cache entry per version.
    - A tab reloads once per session.
  - Do not list retries or the wipe as divergences: the ADR commits to neither.
  - (One lens rated this major, three minor.)

#### MINOR

**m1. ADR-024 closes off ADR-021's environment Stars.**
- **Location:** ADR-024 § *Context* ("two kinds of Star") and § *Who decides*; task Context step 6.
- **Finding:** ADR-021 reserves `staging`, `test`, `preview` and other environment slugs. Personas expects a `test` Star with no real users. ADR-024 commits every Star but `.dev` to the published version without saying so.
- **Suggestion:**
  - Reword the split as "a Star with real users runs only a published version".
  - Put environment Stars under § *Deliberately open*, or say they follow the build as `.dev` does.
  - Keep the `.dev` check a named constant.

**m2. ADR-024 leaves out what a reload costs on a published Star.**
- **Location:** ADR-024 § *Consequences* → Negative, and § *Deliberately open*.
- **Finding:**
  - The install notice reloads every open tab on a Star at once, all fetching `index.html` from one Galaxy. Fast-follow Item 5 records Larry's 2026-08-26 constraint that this needs jitter or a measurement.
  - The reload can also lose an end user's in-flight write. ADR-017 restores the view, not the write.
- **Suggestion:** add two § *Deliberately open* entries: keeping or deferring an in-flight write across a version reload, and herd control for a published Star's install notice (cite Item 5).

**m3. The branch for a page on the Galaxy's own host serves only test fixtures (S6).**
- **Location:** § *Design intent*, "The Galaxy answers each Star by kind".
- **Finding:** only test probes need that branch. Only `star-serves-current-ontology`'s `studio.client` limb uses the row it returns; the other probes accept null.
- **Suggestion:**
  - Answer by the last entry of `callChain` alone: the `.dev` Star gets the dev row, and every other caller gets the published row.
  - Have the scenario assert the dev row through what the `.dev` Star installs.
  - Or name the product use the branch serves.

**m4. The old-Apply paragraph re-derives the old guarantee instead of stating the new one.**
- **Location:** § *Design intent*'s last paragraph; § *Open questions*.
- **Finding:** the `codegen-loop.ts` header cites the task handle "D2" and a method that does not exist (`compileAndInstallOntology`), and its "never install" stops being true after this task.
- **Suggestion:**
  - State the invariant positively:
    - An autonomous tool reads, writes and builds.
    - A landed build changes the types the `.dev` Star runs, which touches only test data.
    - Only a person wipes.
    - Nothing a build compiles reaches a Star with real users.
  - Give that as the header's new text, without D2 or the dead method name.
  - Reduce § *Open questions* to "None."

**m5. The timings cite no source, and a cold start contradicts them.**
- **Location:** Context step 5.
- **Finding:** RESULTS.md measures a cold Galaxy hop at about 1,225 ms and a cold facet load at about 262 ms. Add the 400 ms `INSTALLING_RETRY_DELAY_MS` and a Workspace read, and "well under a second" fails when anything is cold.
- **Suggestion:** cite a measurement, or say "about a second or more, behind a spinner", which is the claim the Decision actually rests on.

#### NIT

**n1. Backward restatements and an editor note.**
- **Location:** Context, Goals, § *What changes*, § *Design intent*.
- **Finding:**
  - "The app's code never hears" appears three times (lines 22, 26, 83), and "history is git's" three times (lines 11, 30, 80).
  - Step 1's close repeats step 2's opening. The `installing`→`checking` rationale appears twice (lines 23, 61). The reload-once rule appears in both § *What changes* and § *Design intent*.
  - Goal 1 carries an editor note.
  - Context paragraph 3 names no change.
  - "The personas task's risk test" is used without being stated.
- **Suggestion:**
  - Keep each point at its first home and cut the copies.
  - Delete the editor note, and name the change paragraph 3 means.
  - State the risk test in a clause: guard only lateral movement and production risk.

---

**Biggest risks**
- **Silent dead subscriptions.** As written, the per-version skip rule, the unpinned query/roster/invite ops and the `''` reset notice together stop list and persona tabs from updating, with no error. That is the class of failure that leaves every suite green. The fix is to pin every op and have own-version or empty notices restore subscriptions.
- **Page and row skew.** The current row has no named home and the "lands" rule is wrong, so ADR-024's central invariant fails when the ontology compile fails but the bundle lands. An implementer following the text would gate on `preview.refreshed` or reuse `ROW_PATH`.
- **Surfaces still describing the old model.** JSDoc, model-read docs, the scaffold and sibling task files (⑤, fast-follow Items 4 and 5, personas) would keep stating the Apply model this task exists to retire. ⑤ may now be a pre-alpha row with no pre-alpha reason.

### Stage 2 findings, 2026-10-11

The panel verified 65 findings. After merging duplicates there are 33: no blockers, 17 major, 13 minor and 3 nits. Each item takes the highest severity any verifier gave it. Where the lenses disagreed, the item says so. Lenses: arch = architecture, sec = security, test = test-strategy.

#### Blockers

None.

#### Major (17)

**1. A landing build stores a row that nothing checks.** major · arch, sec, test
- **Where:** § Phases, Phase 1 ("writes it when a build lands"); § What changes, New 1.
- **Finding:**
  - Deleting `applyOntology` also deletes its `row.version !== version` check (galaxy.ts:715-720), and nothing replaces it.
  - A stale `.nebula/ontology-row.json` can land under new page code. Three things leave one there: a lost pull, a build that compiled nothing, or the user's `vite.config.ts`, which runs after the compile.
  - A chat-floor `writeSource` that lands between the host's hash and the job's compile produces `types` that do not hash to their `version`. The `.dev` loader cache then keeps the wrong bundle under that key.
  - `GalaxyLoopProbe.build` reports `bundle: { ran: true, ok: true }` even after a failed compile.
- **Fix:**
  - Land only when `report.ontology.ran && ok`, `row.version === opts.ontology.version` and `hashBlob(row.types) === version`. Refuse loudly on any mismatch.
  - Build the stored row from named fields using the host's version, never by spreading the file's row.
  - Add vitest cases for a planted stale `ROW_PATH`, and for a fake that compiles different content under the passed label. In both, nothing lands.
  - Make the probe skip the bundle after a failed compile.

**2. Nothing pins how `getCurrentOntology` recognises the `.dev` Star.** major · arch, sec, test
- **Where:** Phase 1 (answering by kind); limbs 1 and 3; § Design intent "The Galaxy answers each Star by kind".
- **Finding:**
  - `RESERVED_STAR_SLUGS` reserves only the exact slug `dev`, so open signup can found `acme.crm.devops`.
  - A Client address such as `acme.crm.dev/alice.x` also carries `bindingName: 'STAR'`.
  - A prefix match or an origin-keyed match therefore hands a stranger's Star the row a collaborator can shape, cached under the tenant key.
  - Limb 3 uses `acme.crm.tenant1`, and its mutation covers only "answers every caller", so a predicate that is too wide passes.
  - The answer with no call context is unspecified, and in-DO tests call `s.getCurrentOntology()` directly.
  - Deployed, limb 3's op half cannot fail unless the tenant pins `.dev`'s version, and its log half cannot be observed.
  - A check keyed on `callChain[0]` instead of the last hop passes limb 1.
- **Fix:**
  - Pin the predicate in Phase 1: the last hop has `type === 'LumenizeDO'`, `bindingName === 'STAR'` and `instanceName === `${this.lmz.instanceName}.dev``. With no call context, answer none.
  - Add a pure vitest table of near-misses: `acme.crm.devops`, `acme.crm.dev/alice.x`, another Galaxy's `.dev`, and a chain whose last hop is a Client.
  - In limb 3, the tenant pins the version read from `.dev`'s served meta, and waits for its own `ask` before counting zero installs.
  - Send one `.dev` op from Studio's Galaxy-hosted client, so a check keyed on origin goes red.

**3. On an empty Star, a refusal restarts the subscription restore in a loop.** major · arch
- **Where:** Phase 3 (the one stale handler and its vitest table); limb 9.
- **Finding:**
  - A wipe notice is `OntologyStaleError('', '')`. An exhausted `checking` refusal on an empty Star is `OntologyStaleError(pinned, '', { installing: true })`.
  - Neither names a current version, and Phase 3 routes "names none" to `#restoreSubscriptions()`.
  - A refused list subscribe keeps its `#queryEntries` entry, so the restore sends it again.
  - On every tenant Star, until `publish()` exists, this repeats every ~1.6 s forever. Limb 9 only checks that the ops end.
- **Fix:**
  - Add the stale's kind to the decision inputs: a push notice versus a refusal of the page's own op. Restore only for the notice.
  - Add those rows to the decision table.
  - In limb 9, assert that the tenant Star logs no further `ask` markers in a window after the ops end.

**4. The in-flight ask memory has no rule for when it is set or cleared.** major · arch, sec, test
- **Where:** Phase 2 ("While a call to `getCurrentOntology` is on its way, the plane remembers it"); § Context step 4.
- **Finding:**
  - `#onOntologyPulled` returns early on `null` and on an Error, and `#install` returns early when the row is already installed.
  - So a clear placed in the install path never runs for a `null` answer (every Star before its first landed build), for an Error, or for a matching row.
  - The Galaxy's chat source answers synchronously and never fires `onOntologyPulled`.
  - A fire-back lost after the early ack is never asked for again.
  - In each case the Star answers `checking` to every mismatched op until it is evicted. The phase's only mutation ("forgets its call") covers none of these.
- **Fix:**
  - Set the memory only when `current()` returns `null`.
  - Clear it on every `onOntologyPulled` outcome: a row, `null`, an Error, or a refused install.
  - Bound it by age, by holding the ask's ISO timestamp.
  - Add vitest cases: a `null` answer, and an Error answer, each followed by a mismatched op that asks again; no answer, with `vi.setSystemTime` moved past the bound, followed by a new ask; a Galaxy that installs two successive chat-seed bumps.

**5. The failing-row count cannot run inside `#install`.** major · arch, sec
- **Where:** Phase 2 ("counts the existing rows that fail the new validator"); limb 5.
- **Finding:**
  - `#install` is synchronous and commits in `transactionSync`.
  - `parseBatch` is an RPC into the facet and returns a Promise (facet-helper.ts:56).
  - Making the install async opens input gates in the middle of the install, and breaks the fire-back handler's never-rethrow contract.
  - Limb 5 waits for `installed`, which is logged before any count could finish.
- **Fix:**
  - Run the count detached, after the commit, handed to `ctx.waitUntil`.
  - Wrap it so a failure only logs, and bound it with a row cap or sampling, logging the bound.
  - Stamp `instanceName` and `version` on the log line, and have limb 5 wait for that count line.

**6. No test checks the `.dev` validator cache key.** major · arch, sec, test
- **Where:** Phase 1 ("keys its validator cache on its own name"); § Design intent.
- **Finding:**
  - This key is half of Goal 4's fence between the `.dev` build and tenants.
  - Leaving `star.ts:51`'s `${galaxyId}/${version}` in place turns nothing red, because no tenant installs anything before `publish()`.
  - So the regression would ship silently and only matter once publish lands.
- **Fix:**
  - In limb 1, assert that the `facet cold load` marker's `bundleId` is exactly `${galaxy}.dev/${version}`. resources.ts:421 already logs it.
  - Add a vitest case: in one isolate, a `*.dev` Star and a tenant each run `applyOntologyForTest` with the same version label and different types. The tenant must validate by its own types.
  - Mutation: share the key, and the case goes red.

**7. No test checks the reload guard.** major · test
- **Where:** Phase 3 (the guard "lives in the Client and records the version it reloaded for"); the § Decisions row on the guard wrapping any handler.
- **Finding:**
  - Limb 8 uses the default handler, so a guard left inside `defaultOnShouldRefreshUI` (create-nebula-client.ts:818) still passes.
  - Limb 8 also passes with no guard at all, or with a guard kept only in memory, because a freshly reloaded page is current.
  - A real reload loop exists whenever the Star never installs.
- **Fix:**
  - Add a headless case: two `NebulaClient`s share one injected `sessionStorage`, with an app-installed handler that counts calls.
  - Two notices naming the same other version call the handler once. A third, naming a new version, calls it again.
  - Mutations: guard only in the default handler, guard kept in memory only, and no guard.

**8. Limb 6 cannot go red, so Phase 2's pinning fix has nothing that tests its behaviour.** major · arch, test
- **Where:** Phase 3, limb 6 and its mutation note; Phase 2 (the Stage 1 B1 fix).
- **Finding:**
  - After Phase 2, a page already at V2 has its subscribes refused `checking` until the install.
  - It never holds a subscription for the install to drop, and never gets a notice naming its own version.
  - Deleting the own-version branch leaves limb 6 green.
  - Reverting Phase 2's pinning also leaves it green: the unpinned subscribe registers at V1, the install drops it, and Phase 3's restore re-subscribes it. The end state heals itself.
- **Fix:**
  - Give the page a `WatchingClient`-style override and assert zero stale notices across the version change. Alternatively, assert through `debugLines` that the `subscribe` marker comes after `installed`.
  - Re-attribute the pinning mutation to Phase 2. Relabel limb 6's mutation to "refused ops are not re-sent when the gate opens".
  - Leave the own-version branch to the decision table.

**9. Phase 2's type test cannot fail.** major · arch, sec, test
- **Where:** Phase 2, "A type test … marked `// @ts-expect-error`".
- **Finding:**
  - The Client-op entry stays `#`-private, so calling it from a test is error TS18013.
  - That error satisfies `@ts-expect-error` whether or not the version parameter is optional. This was reproduced with the repo's tsc.
  - A required TypeScript parameter also does not bind the wire, because mesh arguments are not checked at runtime (resources.ts:108-109).
- **Fix:**
  - Type-test `ResourcesRequests['subscribeQuery' | 'subscribeQuerySubscribers' | 'invite']`. Pair each `@ts-expect-error` call with a twin that passes the version and compiles.
  - Add a runtime case: a raw op with an `undefined` version, on a host that has an ontology, is answered stale.
  - Extend `no-ontology-still-boots.test.ts` so the three newly versioned Client ops throw `NoOntologyInstalledError`.

**10. Limb 2 still passes when its own mutation is applied.** major · arch, test
- **Where:** Phase 1, limb 2 and its mutation note. Phase 5 relies on this limb as its deployed check.
- **Finding:**
  - The limb's build changes only `src/ontology.d.ts`, which holds only types.
  - So `vite build` after a failed compile emits a byte-identical `dist/index.html`, and the failed compile writes no row. Every conjunct holds on the mutated tree.
  - After Phase 1, a client's `getCurrentOntology` answers none, so "the current row's version" cannot be read that way.
  - Nothing tests `runJob` directly.
- **Fix:**
  - Have the failing build also change a page file (a visible string in `App.vue`), and assert the served HTML is unchanged.
  - Observe the row through the served `nebula-scope` meta and an op on `.dev`.
  - Add a positive control in which the fixed types land.
  - Unit-test the exported `runJob` on a temp workspace with a broken ontology, asserting `bundle.ran === false`.

**11. Nothing tests the "arrived" half of a landing, and the fakes cannot produce one.** major · arch, sec, test
- **Where:** Phase 1's vitest criterion and its mutation note.
- **Finding:**
  - The vitest lane has no `ctx.container`, and `#distArrived` runs only when one exists (galaxy.ts:884).
  - Both fakes, `GalaxyTest.build` and `GalaxyLoopProbe.build`, hard-code `bundle: { ran: true, ok: true }`. They write no dist and report no `indexSha256`.
  - The case can only catch "landing ignores `bundle.ok`". The stated mutation, "row written before the arrival check", cannot turn it red.
  - Nothing says whether landing checks arrival when there is no container.
  - Nothing covers recovery: a rebuild with unchanged types after a failed bundle must still land.
- **Fix:**
  - Write a pure `decideLanding(report, arrived)` beside `decidePreview`, with a table test.
  - Make both fakes mirror the job: skip the bundle after a failed compile, add a knob that fails the bundle, and write `dist/index.html` with its digest.
  - State what happens when there is no container, and relabel the mutation.
  - Add a second build to the case that must land.

**12. Existing vitest cases become vacuous or contradict the new rules.** major · test
- **Where:** § What changes, Removed (the blanket `applyOntologyForTest` rule); Phases 1–2.
- **Finding:**
  - `version-rule.test.ts`'s `emptyStarUnderGalaxy` (lines 253-269) tests a retry that `applyOntologyForTest` never triggers.
  - `version-rule.test.ts:194-232` asserts one ask per op, which Phase 2 contradicts.
  - `source-chat-floor.test.ts` F2 (lines 117 and 129) asserts null from `getCurrentOntology()`, which is null on every tree after Phase 1.
  - `codegen-loop.test.ts:805`'s title still names the retired "NEVER installs/wipes the `.dev` Star" invariant.
- **Fix:**
  - In Phase 1, list these cases:
    - Move the version-rule pull and retry cases to `.dev`, under a Galaxy whose faked build landed.
    - Base F2 on the served meta or the `.dev` Star instead, planting at `.nebula/ontology-row.json`.
    - Rewrite the codegen-loop case to the new invariant.
  - In Phase 2, rewrite version-rule's per-op ask assertion to one ask per version change.

**13. Limb 8 cannot be reached as written.** major · arch, test
- **Where:** Phase 3, limb 8; also limb 1's "page loaded afterwards".
- **Finding:**
  - A build alone never moves the `.dev` Star.
  - The seed `App.vue` does not import `nebula.ts`, so the built page runs no client at all.
  - If the page is the requester's preview, `announceBuildToRequester` reloads it without the guard, which hides the set-once mutation.
- **Fix:**
  - The scenario writes an `App.vue` that imports `{ client, store }` and holds a list subscription before the build.
  - The limb-8 page is top-level, and is neither framed in Studio nor the requester.
  - After each `buildNow`, a second client reads the served meta and sends one op.
  - Tie each reload to `onShouldRefreshUI` with a console marker or a navigation count.

**14. Nothing names the replacement for `getOntologyVersion`.** major · arch, sec, test
- **Where:** § What changes, Removed ("Pass 2 names it"); Phase 1, which points back to § What changes.
- **Finding:**
  - The two sections point at each other, so the decision is never made.
  - Callers: `mesh-entry-reach.ts:70,80`, and `client-routes.ts` lines 191, 234, 240, 245, 249 and 268, which are limbs 3–6 and not only limb 6.
  - Exact-surface lists: `scope-isolation.test.ts:420,428`, `galaxy-resource-surface.test.ts:73` and `resources-door.test.ts:156`.
  - The premise that the probe needs "a member that takes one" argument is false: `resolveNestedOperations` refuses the nested chain before the outer method runs, and arity is not checked.
  - Left open, the builder will add a bare `@mesh()` member for a test, or use a writing member on the deployed run.
- **Fix:**
  - Decide it in Phase 1, with no new member.
  - `mesh-entry-reach` nests its payloads in the read-only `getCurrentOntology(...)` or `getGalaxyConfig(...)`.
  - `client-routes` uses `getCurrentOntology()` as both its placeholder op and its positive control.
  - Update the exact-surface lists, and re-run the limbs to confirm the nested-argument refusal still fires.

**15. The Wipe button change has no live criterion.** major · arch, sec, test
- **Where:** Phase 1 ("Studio's Wipe button reports a refusal").
- **Finding:**
  - The change is user-facing. `App.vue:507-510` logs "Wiped the development test data." before the one-way `resetDevData` call answers.
  - No criterion, mutation or later phase covers it, yet `live.md` requires the flow to be driven and evidenced.
- **Fix:**
  - Add a Playwright limb: a collaborator with no passage into `.dev` clicks Wipe and sees the refusal, matched by message, with no success line. The owner's click succeeds.
  - Mutation: log before the result, and the collaborator half goes red.

**16. Phases 1–3 break scenarios they do not name, and nothing sweeps until Phase 5.** major · test (arch and sec rated it minor)
- **Where:** § Phases preamble; Phases 1–3 criteria.
- **Finding:**
  - These breaks happen at runtime, where type-check cannot see them:
    - `installing`→`checking`: `node-invite-roundtrip.ts:100` and `grant-reveals-denied.ts:45` read the flag through casts and silently stop retrying. These are Phase 1's own witnesses.
    - `passage-not-dominion.ts:59-70` declares its own `subscribeQuerySubscribers(query: unknown)`, so the query lands in the version slot.
    - `passage-not-dominion` and `session-survives-token-lapse` probe the changed `getCurrentOntology`.
  - `#restoreSubscriptions`' comment says the query and roster loops "need no ontology version". Phase 2 makes that false, which invites the early-return regression `first-app-built` caught on 2026-09-25.
- **Fix:**
  - Add `drive.ts all --fast`, plus the container scenarios each phase touches, to the criteria of Phases 1, 2 and 3.
  - Phase 2 fixes the three runtime breaks in its own commit.
  - State that the org-tree restore and other unversioned restores stay outside the version gate.

**17. The `.dev` scenarios do not say whose app they run on.** major · test (arch and sec rated it minor)
- **Where:** § What changes, Removed; Phase 1 criteria; Phase 5.
- **Finding:**
  - A Galaxy has exactly one `.dev` Star. On the shared app, the moved scenarios rewrite `src/ontology.d.ts` and build against each other.
  - `dev-star-follows-the-build`'s limb 7 wipes erase their grants, and limb 5 can count rows another scenario left behind.
  - `--concurrency=N` races them outright.
  - `node-invite-roundtrip`'s limb 1 assumes a fresh Star, and that premise fails even when the scenarios run one after another.
  - The scaffold defines `Item`, not `Deal`.
- **Fix:**
  - In Phase 1, each of the three scenarios claims its own app with `testSlug`, as `star-serves-current-ontology` does.
  - State the deployed cost: one certificate pack and a 2.5–4 minute TLS wait per scenario.
  - Alternatively, fold the moved limbs into `dev-star-follows-the-build`.
  - Phase 5 states whether these run concurrently.

#### Minor (13)

**18. Phase 1 cannot leave the tree green, because the wipe branch moves only in Phase 2.** minor · arch, sec, test
- **Where:** Phase 1 (`wipeOnInstall` goes, and its grep criterion) vs Phase 2 ("`#install` drops its wipe branch").
- **Finding:** `#install` reads `row.wipeOnInstall` at resources.ts:470, so removing the field fails both type-check and Phase 1's grep.
- **Fix:** Move the wipe branch and `#wipe`'s `{ cause: 'install' }` arm (resources.ts:530) into Phase 1. Phase 2 keeps only the count.

**19. Limb 4 counts a marker logged per op, not per call to the Galaxy.** minor · arch, sec, test
- **Where:** Phase 2, limb 4.
- **Finding:**
  - The `ask` marker is logged before `current()` runs (resources.ts:441).
  - Left where it is, the marker shows ten asks on correct code. Moved behind the memory, it counts only what the code under test chose to log.
  - Under the mutation, the count depends on timing.
- **Fix:**
  - Count a marker that the Galaxy's `getCurrentOntology` logs, filtered by `callChain.at(-1)`.
  - Wait for a later line before counting.
  - Make sure all ten ops arrive before the answer, or check it in the vitest lane with a held `GalaxyTest` answer and say why that lane suffices.

**20. ADR-024's "Today's code differs" list goes stale.** minor · sec, test (arch rated it major)
- **Where:** Phase 4's known sites; ADR-024 § *Decision* blockquote and its Evidence line.
- **Finding:**
  - Phases 1–3 make five of its six bullets false.
  - Phase 4's grep finds only the `applyOntology` bullet.
  - `/build-task` already greps for the blockquote (SKILL.md:97), which is why two lenses rated this minor.
- **Fix:**
  - Name the blockquote in Phase 4.
  - Keep only "Nothing is published, and no migration exists", and reword the cache-key bullet: only the `.dev` key changes, so tenants still share entries.
  - Check each bullet against the code.

**21. Gating the bundle on the compile makes guidance false in places the grep cannot find.** minor · arch
- **Where:** Phase 1 (`job.ts` skips `vite build`).
- **Finding:**
  - These statements become false: job.ts:8, galaxy.ts:914 (`#buildOnce` JSDoc), codegen-loop.ts:138 (the model-facing `build` description), and codegen-loop.ts:295.
  - `decidePreview`'s "ontology compile failed" branch at galaxy.ts:178 becomes dead code.
  - Nothing says what the skipped bundle's `why` tells the model.
- **Fix:**
  - Rewrite those sites and delete the dead branch in Phase 1.
  - Specify the `why`, for example "skipped: the ontology did not compile — fix src/ontology.d.ts, then build again", following studio-guidance.md.

**22. "Every op carries its version" is broader than what gets built.** minor · arch, sec, test
- **Where:** the § Decisions row; § Context step 2; § Design intent's "a tenant Star runs no data operation"; ADR-024.
- **Finding:**
  - `orgTree.*`, `subscribeTree` and every `unsubscribe*` never pass `#gate`.
  - `resubscribe-when-lost` limb 7 depends on that.
  - A new `requests` member that skips the gate still compiles.
- **Fix:**
  - Narrow the wording to ops on data the ontology types, and add a one-clause carve-out: the org tree is not typed by the ontology.
  - Optionally, add a structural test that lists every `requests` member and its versioning.

**23. The row-size fallback guards the wrong node.** minor · arch, test
- **Where:** Phase 1's size criterion; the § Decisions row on large bundles.
- **Finding:**
  - The Star's `#install` already `kv.put`s the whole row (resources.ts:478).
  - Both nodes share the same ~2 MB cap, so moving the Galaxy's copy to SQL gains nothing.
- **Fix:**
  - Use the same API the Star uses.
  - If size really matters, test a large-ontology install on the Star, and either chunk the bundle or refuse at compile with an error the model can read.

**24. "Move together or not at all" holds per landing, not per request.** minor · arch
- **Where:** § Design intent.
- **Finding:**
  - Deployed, vite writes onto the live mount, so a page served mid-build gets the new HTML with the old meta.
  - If vite fails after writing its output, the mismatch persists until the next build.
- **Fix:** Either list this window in ADR-024 § *Deliberately open*, or store `indexSha256` with the row and emit the meta only when the served HTML matches it.

**25. Nothing tests the meta that `#serveBuiltApp` now serves.** minor · test
- **Where:** Phase 1, limbs 1 and 2.
- **Finding:** If the client pins a version the scenario computed itself, the meta change goes untested, and limb 2's "unchanged" check passes even when the meta is absent.
- **Fix:** Read the version from the served `nebula-scope` meta.

**26. Phase 1's grep cannot print what it says it prints.** minor · test (arch rated it a nit)
- **Where:** Phase 1's `git grep -nwE` criterion.
- **Finding:**
  - The pattern omits `VERSION_RE`, which is still live at galaxy.ts:112 and 537.
  - Under `-w`, the `applyOntologyForTest` exception can never match, which shows the grep was never run.
  - "Comments the last phase rewrites" names Phase 5, but Phase 4 does the rewriting.
- **Fix:** Add `VERSION_RE`, drop the exception, run the grep, and state its real output, listing by file the comment hits Phase 4 owns.

**27. Phase 5's deployed list misses scenarios Phase 1 edits.** minor · sec
- **Where:** Phase 5.
- **Finding:** `mesh-entry-reach` and `client-routes` are edited in Phase 1, and both run deployed.
- **Fix:** Derive the list from the scenario files the diff touches, plus callers of the Galaxy members whose answers changed. At minimum, add those two.

**28. Limbs 6 and 7 can heal themselves in Playwright.** minor · test
- **Where:** Phase 3, limbs 6 and 7.
- **Finding:** A wipe notice wrongly routed to a reload re-subscribes on load, so the limb still sees later data.
- **Fix:** Run both limbs headless, with an `onShouldRefreshUI` that records its calls. Assert it was not called and that the subscriptions were restored.

**29. Limb 5's "nonzero" accepts a count that covers the wrong rows.** minor · test
- **Where:** Phase 2, limb 5.
- **Finding:** Counting every row, or rows of every type, also passes.
- **Fix:** Seed N rows and retype a field that exactly M of them use, then assert exactly M. Add a control build that adds an optional field and logs 0.

**30. The Client's internal resends bypass its gate.** minor · test
- **Where:** Phase 3 (the gate).
- **Finding:**
  - `#restoreSubscriptions` and `#resendPendingSubscribes` call `#hostCall` directly.
  - A reconnect while the gate is closed therefore sends them past it, and held subscribes go out twice.
  - A `checking` answer received while the gate is closed has no stated handling.
- **Fix:** State whether the internal resends wait behind the gate. Add a reconnect-while-closed case (the vitest lane fits) in which each op goes out once.

#### Nits (3)

**31. The Galaxy's row key should carry the Galaxy's own prefix.** nit · arch
- **Where:** New 1; Phase 1.
- **Finding:** The composed chat `Resources` plane already owns the `ontology:` prefix in the Galaxy's storage.
- **Fix:** Name the key in Phase 1, for example `galaxy:devOntologyRow`.

**32. `getCurrentOntology` and its helper can become synchronous.** nit · arch
- **Where:** Phase 1.
- **Finding:** They are `async` only because they read the VFS.
- **Fix:** Say they become synchronous KV reads.

**33. Run the task-handle grep in every phase that writes source.** nit · test
- **Where:** Phases 1–3. The grep appears only in Phase 4.
- **Finding:** `workflow.md` requires the check when code is written, and a test header noting "added in Phase 2" is the likely slip.
- **Fix:** Add the grep to the criteria of Phases 1–3.

#### Biggest risks

- **Wrong data can reach a Star silently.** It happens at the landing step (item 1) and through the `.dev` predicate and cache key (items 2 and 6). No criterion as written can fail on any of the three, and two stay dormant until `publish()` lands.
- **Each liveness rule has a loop or wedge its limbs cannot catch.** A refusal restarts the restore every ~1.6 s (item 3), the Star can answer `checking` forever (item 4), and the reload guard is untested (item 7).
- **About a third of the major findings are criteria that cannot fail under their own mutation** (items 8–11 and 13). You no longer read the phases yourself, so the build's verifiers would be checking against tests that cannot catch what they claim to.

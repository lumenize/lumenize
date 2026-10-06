# Mesh is built on the scope tree

**Status:** Pass 1, drafted 2026-10-06 for Larry's pen round; no phases yet. Stage 1 `/review-task` waits until Phase 1 of [nebula-clients-connect-to-their-scope.md](nebula-clients-connect-to-their-scope.md) completes and Larry approves its ADR and vision changes. Task-file-first, because the rewrite of the Mesh and auth website docs is deferred (D5).

**Objective — `@lumenize/mesh` 1.0-alpha is the one MIT package for everything Nebula layers on Mesh today except Resources: the scope tree, passage and dominion, sessions, the Registry, and the Client's session. Resources, and the Vue store built on it, ship beside it as UNLICENSED packages.**

A Star today is `class Star extends NebulaDO`. `NebulaDO` lives in `apps/nebula` and adds passage to `LumenizeDO`, which lives in `@lumenize/mesh`, using predicates from a third package, `@lumenize/nebula-auth`. After this task a Star is `class Star extends LumenizeDO`, and one MIT package holds all three. [Both this paragraph and the one before might be best illustrated with a table or even a diagram showing the new split for @lumenize/resources and the existing packages all merging into @lumenize/mesh^1.0.0-alpha. Thoughts?]

[This may all go in the Context section instead of here. Regardless of where we put it, I feel like we should say something about how the separation between mesh and Nebula as well as @lumenize/auth and @lumenize/nebula-auth were useful for a time, but the reasons for that separation has been erroding for some time. nebula-auth made a hard split a few months back. We haven't released a new version of mesh since we started focusing on Nebula. 

Our theory that mesh would be useful on its own hasn't proven true looking at adoption. Maybe continuations and a richer/more-consistent types over the wire and all the way to the browser weren't enough of an addition to justify a layer on top of Workers RPC. Cloudflare came out with Cap'n Web since mesh launched which covered the last leg to the browser, although no where near as well or as consistently as mesh. Cloudflare fixed some problems with Errors not maintaining fiedelity over Workers RPC. Etc. The new theory is that a flexible robust built-in multi-tenant structure and an auth-n and coarse-grained auth-z will be enough to make some interested in adoption. Those were differentiators for our unlicensed and potentially money-making Nebula but we'll keep Resources as that differentiator.

Maybe we should split Context out of the section below up to here. Maybe Objective is its own h2 section. Then Context as another. Then Goals as a third. Leaving Current state where it is.

Heck, even the split between current state and future state doesn't feel right for this task file. Maybe we need to rethink the general outline for pass 1. Design intent can be it's own section. Constraints also.

]

**Goals**: Each goal below says how today's design misses it.

[

My reaction to these goals are, "meh". Here's what I would say are the goals:

1. Eliminate a layer of indirection that wasn't serving any purpose. [This is mosly just a new headline for your front-door goal 1 so those sub-bullets move into here.]
2. Take one more crack at finding a niche for offering an MIT licensed platform that is useful enough on its own to achieve adoption that will provide more lift to the success of the commercial product than it bleeds potential customers. Although Lumenize's commercial success centers around doing agentic app development securely, so even keeping Resources unlicensed might not be necessary.
3. [I don't think your test run on the auth that production runs is a goal, but...] Consolidate test coverage into the one layer that is key to Lumenize commercial success.
4. Serves as a forcing function to finally deprecate some things that are already basically deprecated including @lumenize/fetc

]

1. **Nebula reaches the framework through its front door.** Today it reaches around it.
   - `NebulaClient` cannot hand an impersonation child its own refresh through any public seam of `LumenizeClient`, so `impersonation.ts` passes it through two symbol keys, `INTERNAL_REFRESH` and `INTERNAL_PARENT`, which the constructor reads back with a cast.
   - `create-nebula-test-token.ts` exists in `nebula-auth` partly because Mesh's `createTestRefreshFunction` was never exported from `@lumenize/mesh/client`.
   - Each is a workaround the package line made cheaper than fixing the package. With the line gone, there is no around.
2. **Mesh's own tests run on the auth that production runs.** Today 6 files under `packages/mesh/test`, the for-docs mini-apps among them, import `@lumenize/auth`, which no deployed Worker uses. Another 28 use `LumenizeClientGateway`, which Nebula stops binding in the gateway task. A green Mesh suite says nothing about the auth Nebula ships.
3. **Which code is MIT follows the security layers.** Coarse-grained access control is MIT and open to audit; the fine-grained half is UNLICENSED.
   - Alice saves an order on `tenant1.crm.acme.lumenize.dev`. The Worker verifying her token, the Registry that minted it, and the Star's passage check are MIT. Whether she may write at the org-tree node `sales`, which `OrgTree.requirePermission` decides inside Resources, is UNLICENSED.
   - Today the line runs between a generic Mesh and Nebula instead, so passage and dominion are UNLICENSED, and the MIT auth is one Nebula has never used.

## Relationships

- **Builds after [nebula-clients-connect-to-their-scope.md](nebula-clients-connect-to-their-scope.md),** and inherits three things from it:
  - the split and join of a Client's address, `STAR/acme.crm.tenant1/alice.9f2c41aa`, exported from `@lumenize/mesh` on a client-safe subpath (its Phase 2);
  - `NebulaDO` composing `ClientGateway` (its Phase 4), which this task folds into `LumenizeDO`;
  - its D4, under which `LumenizeClientGateway` stays in `packages/mesh` until this task deletes it.
- **Gates ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, as a `data` item. Every generated app's `src/nebula.ts`, which the scaffold seeds into its Workspace, imports `createNebulaClient` from `@lumenize/nebula/frontend`. The wipe rebuilds every app, so a new import path costs nothing before it, and after it costs a migration of every user's app or an alias kept for good.
- **Gates the rewrite of `website/docs/mesh` and `website/docs/auth`,** which waits for this task and may be its own task file (D5).
- **Gates the npm publish** in nebula-pre-alpha.md's close-out. 1.0.0-alpha is the first release in the new shape.

## Context and current state

**Three packages hold what this task puts in one, and the Resources code moves out of the app into two more.** Each part below opens with its fate: **Carried over** moves as it is, **Adapted** moves and changes, **Replaced** gives way to something else, and **Left behind** stays where it is.

**`@lumenize/nebula-auth`** (`packages/nebula-auth`, UNLICENSED, 0.24.0):
- **Carried over into Mesh as a subpath — all of it.** The Registry, `NebulaAuthRegistry`, with its router and HTTP routes; `worker-token.ts`, which verifies and mints tokens; the scope grammar and the predicates `parseId`, `hasPassageInto` and `hasDominionOver`; the host grammar in `hosts.ts`; the facade base, `NebulaAuthFacade`; `Profile`; `NebulaEmailSender`; and the package's tests.
- **Its four subpaths stay subpaths:** `./claims`, `./profile`, `./facade` and `./testing`. `./claims` lets a browser import the predicates without the main barrel's `DurableObject` (`impersonation.ts`'s header), and `./facade` keeps a mesh-composing class out of an index that pure unit tests import (the facade's header). Both reasons hold inside Mesh.
- **Its identifiers are spelled `Nebula…`:** `NebulaAuthRegistry`, `NebulaJwtPayload`, the `NEBULA_AUTH_REGISTRY` binding. Whether the move renames them is open question 3.

**`apps/nebula`** (`@lumenize/nebula`, UNLICENSED, 0.24.0):
- **Adapted — `NebulaDO`** (`nebula-do.ts`), folded into `LumenizeDO`: `requirePassage` and `claimsForPassage` in `onBeforeCall`, `requireDominionHere`, `teardown` and `beforeTeardown`, and, once the gateway task's Phase 4 lands, the composed `ClientGateway` with its socket handlers.
- **Adapted — `NebulaClient`** (`nebula-client.ts`, 2,417 lines), split three ways by open question 1:
  - **its session goes into `LumenizeClient`, MIT:** `claims`, `activeScope`, `impersonate` with all of `impersonation.ts`, `logout`, `invite`, `scopes`, the refresh it configures, and `page-origin.ts`. The Profile channel, `subscribeProfile` and `handleProfileUpdate`, goes with it, since `Profile` is MIT;
  - **Resources goes into an UNLICENSED client package:** `transaction`, the resource, query and roster subscriptions, the org tree, `bindStore`, and the `handle…` methods Resources calls back on;
  - **Studio's chat stays in `apps/nebula`:** `postUserMessage`, `handlePreviewReady` and `#chatHost`.
- **Carried over into an UNLICENSED Resources package:** `resources.ts`, `subscriptions.ts`, `snapshots.ts`, `org-tree.ts`, `org-ops.ts` and `query-hash.ts`. `Star` and `Galaxy` compose them today behind `@mesh() get resources`, so they move without changing how a host uses them; only their imports of `@lumenize/nebula-auth` change.
- **Carried over into the UNLICENSED client package:** `frontend/`, which is `createNebulaClient`, `conflict-outcome.ts`, `debounce.ts`, `deep-equals.ts` and `text-merge.ts`. Today it is exported as `@lumenize/nebula/frontend`, which generated apps and `apps/nebula-studio-ui` import.
- **Left behind:** `Universe`, `Galaxy`, `Star`, the entrypoint, `PlatformHost`, the certificate machine, the codegen loop, and the facade subclass that supplies `scopeLifecycleHooks`. Each changes only what it imports and extends.

**`@lumenize/mesh`** (`packages/mesh`, MIT, 0.26.0):
- **Carried over:** the comms core every node composes (`ComposedMeshDO` and `lmz-api.ts`), `LumenizeWorker`, `ClientGateway`, the operation-chain executor, alarms, broadcast and `@rawRpc`.
- **Adapted:** `LumenizeDO` takes in `NebulaDO`, and `LumenizeClient` takes in the session.
- **Replaced — `LumenizeClientGateway`,** deleted under the gateway task's D4. The 28 test files that use it move onto a host node.
- **Adapted — the 6 test files that import `@lumenize/auth`** move onto Mesh's own auth.
- **Replaced — one of two test-token helpers.** Mesh's `createTestRefreshFunction` and `nebula-auth`'s `create-nebula-test-token.ts` do one job twice, and one survives.

**Elsewhere:**
- **Left behind — `@lumenize/auth`** (`packages/auth`, MIT, 0.26.0). Nebula has never used it, and what becomes of it is open question 4.
- **Left behind — `@lumenize/fetch`.** It depends on Mesh. Nothing is built to keep it working, and a suite of its that this task breaks is skipped with its reason, never deleted (Larry, 2026-09-24).
- **Left behind until the docs rewrite — `website/docs/mesh` and `website/docs/auth`** (D5).

**Missing**, in the order the sections below answer them:

1. A seam on `LumenizeClient` that lets a part composed beside it hear a reconnect and a new token, and lets `impersonate` build a child with the same parts (open question 1).
2. A base for a Durable Object whose name is not a scope (open question 2).
3. The two UNLICENSED packages and their names (open question 3), with every import of `@lumenize/nebula/frontend` repointed: the scaffold's `src/nebula.ts`, the platform guidance, `website/docs/nebula`, and `apps/nebula-studio-ui`.
4. Mesh's package: its auth subpaths, the two dependencies `nebula-auth` brings, `@lumenize/email` and `@lumenize/sql-migrations`, and version 1.0.0-alpha.0.
5. Mesh's test suites on its own auth and on a host node.
6. Standing guidance that describes one MIT package and two UNLICENSED ones (§ *What changes in standing guidance*).

The design intent below shows the package line by example, then takes the Client, then the nodes no scope names, then the guidance that changes.

## Design intent, constraints, and future state

### The package line, by example

**Every import that crosses the line points from UNLICENSED code to MIT code.** A Star, after this task:

```ts
// apps/nebula/src/star.ts — UNLICENSED, the app
import { LumenizeDO, mesh, requireDominionHere } from '@lumenize/mesh';
// passage and dominion: MIT, in Mesh
import { Resources } from '<the Resources package>';   // open question 3
// the data plane: UNLICENSED, its own package

export class Star extends LumenizeDO { /* … */ }
```

And a generated app, whose one framework file keeps its shape and changes one line:

```ts
// a generated app's src/nebula.ts, seeded by the scaffold
import { createNebulaClient } from '<the client package>';   // today: '@lumenize/nebula/frontend'
export const { client, store, ready } = createNebulaClient({ ontologyVersion });
```

**A generated app still calls one factory and gets one `client`.** Components import `{ client, store }` from `src/nebula.ts`, as they do today, so how the Client is assembled is invisible to them and to Studio's model.

**Mesh imports nothing from the UNLICENSED packages or from `apps/`.** That is today's `mesh.md` § *Package dependency direction* with the line moved; the Resources packages import Mesh, and the app imports both.

### The Client splits along the same line

**The session belongs to everyone; Resources belongs to us.** `LumenizeClient` takes the session from `NebulaClient`, so any Mesh Client can log out, impersonate, read its claims and subscribe to a profile. Resources' half moves into the client package, and Studio's chat stays with Studio.

**The parts have to meet at runtime in three places,** and today they meet inside one class, which is why open question 1 is the riskiest call here:
- **Server pushes.** Resources calls back with `ctn<NebulaClient>().handleResourceUpdate(…)` and ten more like it. The Client runs an incoming chain with the same `executeOperationChain` a Durable Object uses (`LumenizeClient`'s `#handleIncomingCall`), so a `@mesh()`-decorated getter on the Client can gate a part the way `@mesh() get resources` gates a Star's.
- **Reconnects and new tokens.** On a reconnect, `NebulaClient` re-subscribes resources, queries, rosters, profiles and the org tree from one place (`#afterReconnect`, `#restoreSubscriptions`, `#resendPendingSubscribes`). `LumenizeClient` gives a subclass one override for it, `onSubscriptionRequired()`.
- **The impersonation child.** `impersonate` builds a second Client acting as Carol, and that Client needs the same parts as its parent, or Carol's page has no store.

### Nodes no scope names

**Passage becomes `LumenizeDO`'s default, and it reads every callee's name as a scope.** `requirePassage` runs `parseId` on the name, with two outcomes:
- **A name the grammar refuses is refused outright.** A `profileId` is a 36-character UUID, past the 30-character slug cap.
- **A name the grammar accepts is a scope, whether or not anyone meant one.** A test Durable Object named `room-1` is the Universe `room-1`, and a caller reaches it only with passage into that Universe.

Three kinds of node have names like these:
- **`Profile`,** named by its `profileId`. It composes the core by hand today, `ComposedMeshDO(DurableObject, 'Profile')`, because it reads the raw Registry mid-call.
- **The facade,** a `LumenizeWorker`, which has no instance name and whose `onBeforeCall` refuses only a call with no claims.
- **Mesh's own test Durable Objects,** which take whatever names their tests chose.

Open question 2 says what such a node extends.

### What changes in standing guidance

**Four files encode the package line itself, and their content changes:**
- `CLAUDE.md`'s opening says Lumenize is MIT packages plus Nebula; the MIT half now includes the scope tree and auth.
- `.claude/rules/workers-projects.md`'s layer map loses `nebula-auth`'s dual-layer row and `NebulaDO`.
- `.claude/rules/mesh.md` § *Package dependency direction* names the UNLICENSED packages as what Mesh never imports, and its carve-out for the wire protocol has nothing left to separate.
- `.claude/rules/raw-comm.md` says which package holds raw-DO infrastructure, which is now a subpath of Mesh.

**Many more name `nebula-auth` or `NebulaDO` as a path and change mechanically.** `grep -rl 'nebula-auth\|NebulaDO\|LumenizeClientGateway\|@lumenize/auth' CLAUDE.md .claude/rules docs/adr docs/vision` lists them, most of the ADRs among them.

### Constraints

- **ADR-007:** one narrow core, composed by every node. `LumenizeDO` absorbing passage keeps it one core, and a node no scope names composes the same one.
- **ADR-023:** the facade stays the bridge into the Registry unless open question 5 makes the Registry a mesh node. **ADR-018:** a call the facade refuses still never wakes the Registry.
- **ADR-015 and ADR-022:** moving the predicates changes no verdict.
- **`workflow.md`:** § *Dependencies*, since Mesh gains workspace dependencies only; § *Sequential implementation*; § *Releases*, whose breaking changes collect in `tasks/backlog.md`'s row "Flag in the next release notes, as BREAKING".
- **`packaging.md` § *Startup cost is work at import, not bytes*:** a Worker importing only Mesh's root must not pay for the Registry's import graph.
- **`live.md`:** `/live` first. This task touches every scenario's imports, so the whole registry is swept, containers included, and a deployed pass runs if a bound class is renamed.

### Future state

- ⚠️ Design consideration: `Profile` cannot move onto Resources while `Profile` is MIT and Resources is not. That answers the `Profile` half of `tasks/backlog.md`'s row "OPEN QUESTION — `Resources` with a pluggable access-control model"; Studio's Session and Messages half is unaffected, since both sides of it are UNLICENSED.
- ⚠️ Design consideration: if open question 5 defers it, making the Registry a mesh node stays available. The facade would stop being a bridge, though it stays a Worker, since invite emails, impersonation tokens and a deletion's fan-out run there to keep work off the singleton (ADR-018). `@rawRpc` would keep three of its four sites, which HTTP routes reach with no mesh chain: `Profile.readDisplayNames`, `Profile.setDisplayNames` and `Galaxy.orderCertificate`.
- **`@lumenize/fetch`, if revived for streaming, targets Mesh 1.x.**

### Open questions

In dependency order, each with a recommendation.

1. **How does `NebulaClient` split?** (§ *The Client splits along the same line*)
   - **(A) Parts composed beside `LumenizeClient`** *(recommended)*. Each part sits behind a `@mesh()`-decorated getter, so Resources calls back with `ctn<…>().resources.handleResourceUpdate(…)`, the same shape a Star's callers use. `LumenizeClient` gains a seam where parts hear a reconnect and a new token, and `impersonate` builds the child through the same factory that built its parent. Resources and Studio's chat compose independently.
   - **(B) A subclass chain.** An UNLICENSED `ResourcesClient extends LumenizeClient`, and Studio's chat a further subclass in `apps/nebula`. `LumenizeClient` gives protected hooks, and `impersonate` builds `new this.constructor(…)`. It is today's shape with the line moved, at the price of a three-level chain whose parts cannot be picked apart.
   - **Why A:** it matches the server side, which already composes Resources behind a gate, and it is the riskiest part of the task, so Pass 2 makes it the first phase.
2. **What does a Durable Object whose name is not a scope extend?** (§ *Nodes no scope names*)
   - **(A) `ComposedMeshDO`, as `Profile` does today** *(recommended)*. `LumenizeDO` always checks passage. Mesh's own test Durable Objects take scope-shaped names and real tokens, so they test what Nebula runs.
   - **(B) A second exported base, `LumenizeDO` without passage.** Two bases a caller must choose between, and a node that picks the wrong one is open to every caller.
3. **What are the new names?** Three choices, each Larry's (`prose-voice.md` on coining a term):
   - **Mesh's auth subpath,** with `@lumenize/mesh/auth` the obvious candidate.
   - **The two UNLICENSED packages.** Candidates: `@lumenize/resources` and `@lumenize/resources-client`.
   - **Whether a `Nebula…` identifier that moves into Mesh is renamed.** The 2026-09-13 brand decision keeps code identifiers' code name; moving into an MIT package named Mesh may be reason enough. A bound class renamed before the wipe costs no migration.
4. **Does `@lumenize/auth` retire?**
   - **(A) Deprecate it on npm, pointing at Mesh's auth, and `git rm` it here** *(recommended)*. It had 31 downloads in the 30 days to 2026-10-04 (npm's API), and deleting it ends the fork `tasks/backlog.md`'s orchestration-body de-fork row describes. What goes with it has no counterpart in `nebula-auth`: the approval flow, the admin notification on self-signup, delegated tokens with `authorizedActors`, and the Hono integration. `website/docs/auth` describes it until the docs rewrite.
   - **(B) Leave it published and in the repo, unmaintained.**
5. **Does this task make the Registry a mesh node?**
   - **(A) Yes.** The facade's raw stub goes, along with the `claims` argument passed by hand into `issueInvites`, `createGalaxy`, `expandScope` and the deletion calls, and `Profile` can extend the base for nodes no scope names.
   - **(B) No; a follow-on after this lands** *(recommended)*. It changes nothing about the package shape, the task is already the widest in the plan, and it deserves its own review against ADR-018 and ADR-023.

## Decisions

Started at the Pass 1 gate, holding only what is settled. Each row is Larry's call.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **One MIT package: `@lumenize/mesh` takes in `nebula-auth` as a subpath** (Larry, 2026-10-06). | **Two MIT packages, the scope grammar and predicates in Mesh and the session lifecycle in `@lumenize/auth`** — Mesh would need auth's predicates while auth already needs Mesh, so the two would always release together and neither would run without the other. **A third leaf package both depend on** — it adds a package in a change meant to remove them. |
| D2 | **Mesh 1.0-alpha is built on the scope tree: `NebulaDO` folds into `LumenizeDO`, and `NebulaClient`'s session into `LumenizeClient`** (Larry, 2026-10-06). | **Keeping a generic Mesh beside Nebula** — `@lumenize/mesh` had 46 downloads in the 30 days to 2026-10-04, so its compatibility promises are kept for nobody, while Nebula works around the line (goal 1). |
| D3 | **Resources and its Vue store are UNLICENSED packages; everything else Nebula layers on Mesh is MIT** (Larry, 2026-10-06). | **The line between a generic Mesh and Nebula** — it makes passage and dominion UNLICENSED and leaves MIT with an auth Nebula has never used (goal 3). |
| D4 | **Builds after nebula-clients-connect-to-their-scope, and lands before ⑥ the wipe as a `data` item** (Larry, 2026-10-06, for the order against the gateway task; the slot before the wipe is the author's). | **Before the gateway task** — that task's open question 1, which class composes `ClientGateway`, is answered by D2, and building it first leaves this task less to move. **After the wipe** — a new import path for generated apps would then mean migrating every user's `src/nebula.ts` or keeping an alias for good. |
| D5 | **The rewrite of `website/docs/mesh` and `website/docs/auth` waits until this lands, possibly as its own task file. `website/docs/nebula/*`, which Studio's model reads every turn, is fixed line by line in the phase that makes a line false, and `platform-embed.ts` regenerated** (Larry, 2026-10-06). | **Docs-first**, the route `/task-management` takes for a change to a package's public surface — Larry deferred it. |

## Criteria to carry into Pass 2

Settled behaviour a phase must prove, collected during the Pass 1 gate.

- **`drive.ts all` passes, containers included, and so does the deployed pass on `test-nebula`.**
- **Mesh imports nothing from the UNLICENSED packages or `apps/`,** checked by a script under `scripts/audit-*` rather than by review.
- **A generated app built after the change boots on its new import,** on the `build-box` scenario.
- **A Worker that imports only Mesh's root does no more work at import than before,** measured with `packaging.md`'s two commands.
- **No passage or dominion verdict changes:** their tests move with their assertions untouched.

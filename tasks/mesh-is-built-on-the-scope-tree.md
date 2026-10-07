# Mesh is built on the scope tree

**Status:** Pass 1, with D1–D23 decided 2026-10-06 and 07. Stage 1 `/review-task` ran twice on 2026-10-07, and this version applies the second gate's decisions. Lands before ⑥ the wipe; what can wait for adopters is in [mesh-1-alpha.md](mesh-1-alpha.md). Task-file-first, because the Mesh and auth website docs are rewritten later (D5).

## Objective

**`@lumenize/mesh` 1.0-alpha takes in the scope tree, passage and dominion, the Registry with its sessions, and the Client's session, all MIT. Resources and its Vue store become `@lumenize/resources`, UNLICENSED. Studio and the scope nodes stay in `apps/nebula`.**

| Today | License | After this task | License |
|---|---|---|---|
| `@lumenize/mesh` (`packages/mesh`) | MIT | `@lumenize/mesh` 1.0 alpha, versioned and published by [mesh-1-alpha.md](mesh-1-alpha.md) | MIT |
| `@lumenize/nebula-auth` (`packages/nebula-auth`) | UNLICENSED | `@lumenize/mesh/auth` and three entry points under it, its predicates in Mesh's root and `/client` (D11) | MIT |
| `NebulaDO`, and `NebulaClient`'s session (`apps/nebula`) | UNLICENSED | `ScopedMeshDO` and `MeshClient` (D2, D16) | MIT |
| Resources' server side (`apps/nebula`) | UNLICENSED | `@lumenize/resources` (D10) | UNLICENSED |
| Resources' client side, exported today as `@lumenize/nebula/frontend` | UNLICENSED | `@lumenize/resources/client` and `/frontend` (D10) | UNLICENSED |
| Studio, `Universe`, `Galaxy`, `Star` and the Worker (`apps/nebula`) | UNLICENSED | `apps/nebula`, importing both | UNLICENSED |
| The auth pages Mesh's routes serve (`apps/nebula-studio-ui/src/auth/`) | UNLICENSED | stay with Studio; [mesh-1-alpha.md](mesh-1-alpha.md) has each route serve what the app supplies (D17) | UNLICENSED |
| `@lumenize/auth` (`packages/auth`) | MIT | imported by nothing outside itself; deleted from the repo and deprecated on npm by [mesh-1-alpha.md](mesh-1-alpha.md) (D9) | MIT |
| `@lumenize/fetch` (`packages/fetch`) | MIT | deprecated on npm by [mesh-1-alpha.md](mesh-1-alpha.md) | MIT |

## Context

**The line between Mesh and Nebula, and the one between `@lumenize/auth` and `nebula-auth`, were useful for a time, and their reasons have been eroding.**

- **Mesh was meant to be useful on its own, and adoption says it is not.** It was first published on 2026-02-11 and had 46 downloads in the 30 days to 2026-10-04 (npm's API). What it adds over Workers RPC is continuations, and the full structured-clone value space carried consistently all the way to the browser. That has not been enough to justify a layer on top. Meanwhile, Cloudflare hasn't been standing still:
  - Cloudflare released Cap'n Web days before `@lumenize/rpc`, the RPC package that evolved into Mesh, was due to ship. Cap'n Web covers the last leg to the browser, though not as well or as consistently as Mesh.
  - `RpcTarget`, in Workers RPC and Cap'n Web alike, passes an object as a capability, and promise pipelining sends dependent calls in one round trip. Those are the two things Mesh's continuations provide.
  - Cap'n Web's type support has improved significantly, largely from our own work. Larry's capnweb#99 proposed `ArrayBuffer` and typed arrays, `URL` and `RegExp`, which later landed as #201, #224 and #225, between July and September 2026.
  - Even Workers RPC carries more of an Error now. Since compatibility date 2026-04-21, one keeps its `name`, `message`, `cause` and custom properties.
- **Mesh has had no release since the focus moved to Nebula.** 0.26.0, on 2026-06-03, is the last.
- **`nebula-auth` already split from `@lumenize/auth`,** on 2026-07-31 ([archive/nebula-auth-decouple-from-auth.md](archive/nebula-auth-decouple-from-auth.md)), so nothing Nebula runs imports `@lumenize/auth`.

**The new bet is that most of what made Nebula different is what makes an MIT package worth adopting:** a robust multi-tenant tree built in, up to three tiers deep, with authentication and coarse-grained authorization on it that refuse lateral movement by construction. Those were differentiators for the commercial product. Resources stays one, but the main differentiator for the commercial product is agentic development of apps that are secure by default. `docs/vision/enterprise.md` § *Identity is a commodity* draws the buyer's line at the front door, the part anyone can buy and so the part to align on; this task's line sits one step further in, after the coarse-grained isolation between tenants.

The goals below say what that bet asks of this task, and § *Design intent* how the code changes to meet them.

## Goals

Each goal says how today's design misses it.

1. **Eliminate a layer of indirection that serves no purpose.** A Star today is `class Star extends NebulaDO`. `NebulaDO` lives in `apps/nebula` and adds passage to `LumenizeDO`, which lives in `@lumenize/mesh`, using predicates from a third package, `@lumenize/nebula-auth`. After this task a Star is `class Star extends ScopedMeshDO`, and one package holds all three. Today the layers duplicate each other rather than build on each other:
   - **Two test-token helpers.** `create-nebula-test-token.ts` exists in `nebula-auth` because Mesh's `createTestRefreshFunction` signs `@lumenize/auth`'s claims (`emailVerified`, `adminApproved`, `isAdmin`), with no `access` claim for passage to read, and was never exported from `@lumenize/mesh/client`.
   - **Two auth packages.** `packages/auth` and `nebula-auth` fork the handler orchestration, as `tasks/backlog.md`'s orchestration-body de-fork row records, and Nebula runs only one of them. This task leaves nothing importing `packages/auth`, so [mesh-1-alpha.md](mesh-1-alpha.md) can delete it.
2. **Take one more shot at an MIT platform useful enough on its own to be adopted.** The adoption has to lift the commercial product more than it costs it in customers who stop at the MIT part. Today the MIT half is a generic Mesh and an auth Nebula does not run, while the multi-tenant structure, sessions and coarse-grained authorization are UNLICENSED.
3. **Consolidate test coverage into Mesh, the one layer Lumenize's commercial success rests on.** Today Mesh's suites test a stack Nebula does not ship: `git grep -l "@lumenize/auth'" -- packages/mesh/test` lists the files, the for-docs mini-apps among them, that run on `@lumenize/auth`, and `git grep -l LumenizeClientGateway -- packages/mesh/test` those that run on a Gateway no Nebula page uses. Passage and dominion, meanwhile, are tested in `apps/nebula` and `nebula-auth`, out of Mesh's sight.
4. **Clear the way to deprecate what is already all but deprecated.** `@lumenize/auth` has 31 downloads a month and no counterpart left in Nebula, yet Mesh's suites run on it. `@lumenize/fetch` depends on Mesh, and nobody runs it in production, so nothing is built to keep it working. [mesh-1-alpha.md](mesh-1-alpha.md) deprecates both.

## Relationships

- **Builds after [nebula-clients-connect-to-their-scope.md](archive/nebula-clients-connect-to-their-scope.md),** and inherits three things from it:
  - the split and join of a Client's address, `STAR/acme.crm.tenant1/alice.9f2c41aa`, exported from `@lumenize/mesh/client` as `splitAddress` and `addressOf` (its Phase 2);
  - `NebulaDO` composing `ClientGateway` (its Phase 4), which this task folds into `ScopedMeshDO`;
  - its D4, under which `LumenizeClientGateway` stays in `packages/mesh` until this task deletes it.
- **Gates ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, as a `data` item (§ *What waits for mesh-1-alpha*). It lands after every pre-wipe row above it there that edits a file it moves or repoints, because those are product work riskier than a move: ② Personas (`container/app/src/nebula.ts`, `AGENTS.md`), ③ Capture live (the scaffold's `src/nebula.ts`), ⑤ The ontology history, which may reshape the ontology-version row `resources.ts` reads, *A `computed()` misses its subscription* (`frontend/create-nebula-client.ts`), *Generated apps are pure Vapor* (`scaffold-seed.ts`, `AGENTS.md`), *Denied access shows in the app* (`AGENTS.md`, `api-reference.md`), and *Shared pages* (`nebula-auth`'s claim paths).
- **Gates [mesh-1-alpha.md](mesh-1-alpha.md),** which comes before the npm publish and holds what can land after pre-alpha launches without breaking anything Nebula runs.
- **Comes before the backlog row *A Client resends a call its socket lost*** (`tasks/backlog.md` § *Lumenize Mesh*, decided 2026-10-07), which builds on two seams this task moves: the gateway's message types and the Client's send queue, `#sendOrQueue`. This task keeps both intact under their new names.

## Current state

**Three packages hold what this task puts in one, and the Resources code moves out of the app.** Each part below opens with its fate: **Carried over** moves as it is, **Adapted** moves and changes, **Replaced** gives way to something else, **Deleted** goes with nothing in its place, and **Left behind** stays where it is. § *Design intent* gives the reasons.

**`@lumenize/nebula-auth`** (`packages/nebula-auth`, UNLICENSED, 0.24.0):
- **Adapted — its code moves into Mesh** (D11), renamed (D12): the Registry, `NebulaAuthRegistry`, with its router and HTTP routes; `worker-token.ts`, which verifies and mints tokens; the scope grammar and the predicates `parseId`, `hasPassageInto` and `hasDominionOver`; the host grammar in `hosts.ts`; the facade base, `NebulaAuthFacade`; `Profile`, onto `UnscopedMeshDO` (D7); `NebulaEmailSender`; and the package's tests.
- **Adapted — its entry points** (D11): `./facade`, `./profile` and `./testing` move under `@lumenize/mesh/auth`, and `./claims` into Mesh's root and `/client`.
- **Carried over until [mesh-1-alpha.md](mesh-1-alpha.md) — what is Nebula's product, not auth** (D17): the page each of six GET routes serves, `/auth/coming-soon`, the agent's profile seed, and the email sender's app name and `from` address. They move into Mesh as they are, and mesh-1-alpha makes each one configuration the app supplies. The agent's `sub` changes value here (D19).
- **Deleted — the `admin-notification` and `approval-confirmation` email types**, with their templates and their test (D17).

**`apps/nebula`** (`@lumenize/nebula`, UNLICENSED, 0.24.0):
- **Adapted — `NebulaDO`** (`nebula-do.ts`), folded into `ScopedMeshDO`: `requirePassage` and `claimsForPassage`, moved from `onBeforeCall` into a passage step that runs before it (D22), `requireDominionHere`, `teardown` and `beforeTeardown`, and the composed `ClientGateway` with its socket handlers.
- **Adapted — `NebulaClient`** (`nebula-client.ts`, 2,442 lines), split three ways (D6, D15, D20):
  - **its session goes into `MeshClient`, MIT:** `claims`, `activeScope`, `impersonate` with all of `impersonation.ts`, `logout`, `invite`, `scopes`, the refresh it configures, and the Profile channel, `subscribeProfile`, `handleProfileUpdate` and `updateMyProfile`;
  - **Resources goes into `@lumenize/resources/client`:** `transaction`, the resource, query and roster subscriptions, the org tree, `bindStore`, and the five push methods Resources calls;
  - **Studio's methods go into `StudioClient`,** in `apps/nebula`: `postUserMessage` with the chat host pair only it reads (`chatHostBinding`, `chatScope`), `handlePreviewReady` with `onPreviewReady`, and `uploadProfilePicture`, which posts to Nebula's own `/pictures`.
- **Adapted — the Resources plane, into `@lumenize/resources`** (D10): `resources.ts`, `subscriptions.ts`, `snapshots.ts`, `org-tree.ts`, `org-ops.ts`, `query-hash.ts`, and `errors.ts`, whose errors are all Resources' (`OntologyStaleError`, `PermissionDeniedError` and the rest). `resources.ts` names the facade's binding, which D12 renames.
- **Adapted — `frontend/` and the two client entries,** into three homes (§ *The package line, by example*).
- **Adapted — the Galaxy's preview push,** which names `StudioClient` (D20).
- **Left behind:** `Universe`, `Star`, the entrypoint, `PlatformHost`, the certificate machine, the codegen loop, and the facade subclass that supplies `scopeLifecycleHooks`. Each changes only what it imports and extends.

**`@lumenize/mesh`** (`packages/mesh`, MIT, 0.26.0):
- **Carried over:** the call core in `lmz-api.ts`, `ClientGateway`, the operation-chain executor, alarms, broadcast and `@rawRpc`.
- **Adapted — the node classes** (D16): `LumenizeDO` becomes `ScopedMeshDO`, `LumenizeClient` becomes `MeshClient`, and `LumenizeWorker` becomes `MeshWorker`.
- **Adapted — `ComposedMeshDO`,** the mixin `LumenizeDO` and `Profile` are built on today, which stops being exported (D7).
- **Replaced — `LumenizeClientGateway`,** which no Nebula page connects through now that every page's Client connects to its scope's node, deleted with the tests that use it moved onto a host node.
- **Replaced — `createTestRefreshFunction`,** by `nebula-auth`'s `create-nebula-test-token.ts` (§ *Packages, tests and checks*).

**Elsewhere:**
- **Left behind until [mesh-1-alpha.md](mesh-1-alpha.md) — `@lumenize/auth`** (`packages/auth`, MIT, 0.26.0), which nothing outside it imports once Mesh's suites move onto Mesh's auth. mesh-1-alpha deletes it and deprecates it on npm in favour of Mesh's auth (D9).
- **Left behind — `@lumenize/fetch`.** Nothing is built to keep it working; a suite of its that this task breaks is skipped with its reason, never deleted, so a revival for streaming has something to prove itself against (Larry, 2026-09-24).
- **Left behind — `@lumenize/rpc` and `@lumenize/testing`,** which do not depend on Mesh. `@lumenize/rpc` stays deprecated on lumenize.com only, since `@lumenize/testing`'s `createTestingClient` and `instrumentDOProject` build on it.
- **Left behind until [mesh-1-alpha.md](mesh-1-alpha.md):** the website docs outside `website/docs/nebula` (D5), and the package table in `website/docs/introduction.md`.

**Missing:**

1. `@lumenize/resources` at `packages/resources`: the whole plane, server and client, with the Client's 31 `ctn<Star>()` calls typed against `ResourcesRequests` and every importer repointed (§ *The package line, by example*).
2. `nebula-auth` inside Mesh, and Mesh's `/auth` entry points (D11).
3. The renames of D12 and D16, with the audits, preflights and deploy scripts that name them (§ *What gets renamed*).
4. The platform agent's `sub` value, `'agent:lumenize'` (D19).
5. `ScopedMeshDO`, with passage in a step no subclass can override, `UnscopedMeshDO`, `MeshWorker` and `MeshClient` (D7, D16, D22).
6. The Client split: `ClientResources`, `onClaimsChange()`, the address in `connection_status`, and `StudioClient`, which `createNebulaClient` builds when passed the class (D6, D15, D20).
7. Mesh's suites on its own auth and on a host node, with `LumenizeClientGateway` and `createTestRefreshFunction` deleted (§ *Packages, tests and checks*).
8. Standing guidance that describes one MIT package beside the UNLICENSED code (§ *What changes in standing guidance*).

The design intent below opens with what waits for mesh-1-alpha, then shows the package line by example, then takes the Client, scoped and unscoped nodes, the renames, what stays Nebula's, the Registry, packaging and tests, and the guidance that changes.

## Design intent

### What waits for mesh-1-alpha

**Anything that risks needing a schema change lands in this task, before ⑥ the wipe; [mesh-1-alpha.md](mesh-1-alpha.md) holds docs, configuration and the rest of what carries no such risk.** Changing the agent's `sub` rewrites a value stored on every Message the agent writes, so it lands here. Letting an app supply its own login page changes what a route serves and nothing anyone stores, so it waits. The renames and removals below land here too, so each happens once. Two schemas may change after the wipe all the same: the Registry's, since it is one object (D13), and Mesh's alarm table, which a coming refactor of alarms revisits (D21).

**Three of this task's changes reach past the repo,** and after ⑥ the wipe each would cost a migration, since every user's app, stored row and deployed secret outlives a change; before it, the wipe rebuilds them:
- **The import path generated code uses.** Every app's `src/nebula.ts`, which the scaffold seeds into its Workspace, imports `createNebulaClient` from `@lumenize/nebula/frontend`, and `platform/AGENTS.md` teaches imports from it too. This task creates `@lumenize/resources` and repoints every importer: the scaffold, the platform guidance, `website/docs/nebula`, `apps/nebula-studio-ui`, the harness, and the container image, whose `Dockerfile` copies each vendored package's `package.json` and `src` and whose root `.dockerignore` lets each through, alongside `container/app/src/nebula.ts` and `vite.config.ts`. `git grep -l "@lumenize/nebula/\(frontend\|client\)"` lists them.
- **The names a stored row, a built app or a deployed secret holds** (§ *What gets renamed*).
- **The platform agent's `sub`,** `'agent:nebula'` today, stored on every Message the agent writes (D19).

The rest change only code in this repo.

**What waits is docs, configuration, and adopter-facing work Nebula does not need,** such as each auth route serving a page the app supplies (D17), Mesh verifying a socket's claims before a host node accepts it, and deleting `packages/auth` (D9). Until then Nebula's values stay hard-wired in Mesh, which nobody outside the repo sees before the publish.

### The package line, by example

**Every import that crosses the line between MIT and UNLICENSED code points from UNLICENSED code to MIT code.** A Star, after this task:

```ts
// apps/nebula/src/star.ts: UNLICENSED, the app
// passage and dominion, MIT, in Mesh:
import { ScopedMeshDO, mesh, requireDominionHere } from '@lumenize/mesh';
// the data plane, UNLICENSED, its own package (D10):
import { Resources } from '@lumenize/resources';

export class Star extends ScopedMeshDO { /* … */ }
```

**The line falls between the coarse-grained and fine-grained layers of access control.** Alice saves an order on `tenant1.crm.acme.lumenize.dev`:
- **MIT:** the Worker verifying her token, the Registry that minted it, and the Star's passage check.
- **UNLICENSED:** whether she may write at the org-tree node `sales`, which `OrgTree.requirePermission` decides inside Resources.

**A generated app still calls one factory and gets one `client`.** Its one framework file keeps its shape and changes one word:

```ts
// a generated app's src/nebula.ts, seeded by the scaffold
// today '@lumenize/nebula/frontend' (D10):
import { createNebulaClient } from '@lumenize/resources/frontend';
export const { client, store, ready } = createNebulaClient({ ontologyVersion });
```

Components import `{ client, store }` from `src/nebula.ts`, as they do today, so how the Client is assembled is invisible to them and to Studio's model.

**What `@lumenize/nebula`'s two client entries carry today goes to three homes.** `client-index.ts` re-exports `nebula-client`, `snapshots`, `org-ops`, `chat-constants`, `participants`, `turn-liveness` and Galaxy's ontology-version types, and `frontend-index.ts` adds `page-origin`, the host grammar from `nebula-auth/claims`, and `frontend/`:
- **Mesh's `/client`:** `page-origin` and the host grammar (`parseHost`, `hostOrigin`, `checkedReturnTo`, `isAtOrAbove`), since they are the session's.
- **`@lumenize/resources`:** `NebulaClient`, `snapshots`, `org-ops` and `frontend/`, and the ontology-version row `resources.ts` takes from Galaxy's `ontology-compile.ts` today.
- **`apps/nebula`:** `chat-constants`, `participants` and `turn-liveness`, which are Studio's, and `StudioClient`.

**A package the app depends on cannot import the app.** `nebula-client.ts` calls `ctn<Star>().resources…` 31 times through `import type { Star }`, so `@lumenize/resources/client` types those calls against the plane's own request surface, `ResourcesRequests`, rather than a host class.

**Mesh imports nothing from `@lumenize/resources` or from `apps/`.** That is today's `mesh.md` § *Package dependency direction* with the line moved: the Resources package imports Mesh, and the app imports both.

### The Client splits along the same line

**The session belongs to everyone; Resources belongs to us.** `MeshClient` takes the session from `NebulaClient`, so any Mesh Client can log out, impersonate, read its claims and subscribe to a profile.

```ts
// MIT, @lumenize/mesh/client: the session
class MeshClient { /* claims, activeScope, impersonate, logout, profiles */ }
// UNLICENSED, @lumenize/resources/client: composes ClientResources
class NebulaClient extends MeshClient {
  readonly #resources = new ClientResources(this);  // tested alone (D6)
  get resources() { return this.#resources.api; }    // what apps call; no @mesh()
  @mesh() handleResourceUpdate(…) { this.#resources.handleResourceUpdate(…); }
}
// UNLICENSED, apps/nebula: Studio's own
class StudioClient extends NebulaClient { @mesh() handlePreviewReady(…) { … } }
```

**A thin `NebulaClient` composes `ClientResources` (D6),** the Client's half of the plane the server composes as `Resources`, which can be tested alone. It holds the `resources` and `orgTree` APIs, `bindStore`, `flush`, `subscribeQuerySubscribers`, the resource, query and roster refusal hooks, and the state behind the five push methods. `NebulaClient`'s members delegate to it, so an app's calls do not change. The two meet in four places:
- **Server pushes.** Resources calls back with `ctn<NebulaClient>().handleResourceUpdate(…)` and ten more like it, reaching five push methods. They stay top-level `@mesh()`-decorated methods on `NebulaClient`, each forwarding to `ClientResources`, so the wire does not change. That is the shape `LumenizeClient`'s class JSDoc teaches an adopter for a Client's incoming calls: `@mesh()`-decorated methods on a subclass. `client.resources`, the API apps call (`client.resources.transaction(…)`), stays undecorated, so nothing local reaches the wire.
- **New tokens and reconnects (D15).** On each new token today's `NebulaClient` records `activeScope`, the scope its host spells, and when the admin bit flips it re-subscribes resources, queries, rosters, profiles and the org tree. After the split `MeshClient` owns the refresh, records `activeScope`, re-subscribes its own Profile channel on `onSubscriptionRequired()`, and calls an override, `onClaimsChange()`, after every new token. `NebulaClient` hands that, `onConnectionStateChange` and `onSubscriptionRequired()` to `ClientResources`, which restores the rest. `refresh` stays public on `MeshClientConfig`, where Mesh's own tests pass one, and stays left out of `NebulaClientConfig`, so no app builds a Client whose token and scope disagree.
- **The impersonation child.** `impersonate` builds a second Client acting as Carol, which needs a `ClientResources` of its own, as its parent has, or Carol's page has no store. Living in `MeshClient`, it builds the child with `new this.constructor(…)`. The child's refresh, backed by the impersonation mint, and its link to its parent travel through two symbols private to `MeshClient`'s module, which replace `INTERNAL_REFRESH` and `INTERNAL_PARENT`.
- **Its own address (D15).** A hosted Client's `#selfIdentity()` reports `gatewayBindingName`, by default `LUMENIZE_CLIENT_GATEWAY`, a binding no Nebula Worker has, so a Client calling itself through the mesh is refused as a peer: it compares the last hop with its bare id, `alice.9f2c41aa`, where its host stamps `acme.crm.tenant1/alice.9f2c41aa`. `connection_status` carries the address instead, and `#selfIdentity()` reports it.

**Studio's methods live on `StudioClient`, in `apps/nebula` (D20),** because the Galaxy, in `apps/nebula`, names the class it pushes to, and `apps/nebula-studio-ui` depends on `apps/nebula`, not the reverse. Studio gets one from the factory a generated app calls, by passing the class:

```ts
// apps/nebula-studio-ui/src/App.vue; Client defaults to NebulaClient
const { client, store, ready } = createNebulaClient({
  Client: StudioClient, ontologyVersion, ...chatPair(activeScope), onPreviewReady,
});
```

The config and the returned `client` are typed by the class passed, so a generated app's call does not change, and Studio keeps the factory's `ready`, login redirect and store. Chat itself is Resources already: Studio reads a thread with `client.resources.subscribeQuery`, and `handleStreamChunk` is the Client's end of Resources' `streamProgress`.

### Scoped and unscoped nodes

**A scoped node's name is a scope, and passage guards it; an unscoped node's name is not, and its own methods carry its policy (D14).** The Star `acme.crm.tenant1` is a scoped node. `Profile`, named by a `profileId` such as `1a9d…`, is the first unscoped node, and the facade, a `MeshWorker` with no instance name, is another. `auth.md` already describes the second kind without naming it: a node with no scope of its own checks the claims at the top of each method that needs them.

**`ScopedMeshDO` checks passage on every call, reading the called node's name as the target scope.** The check is a step of the base's own, keyed by a symbol private to Mesh, that runs before the subclass's `onBeforeCall`. An override adds checks, and one that never calls `super` still leaves passage in place (D22). `requirePassage` runs `parseId` on the name, with two outcomes:
- **A name the grammar refuses is refused outright.** A `profileId` is a 36-character UUID, past the 30-character slug cap.
- **A name the grammar accepts is a scope, whether or not anyone meant one.** A test Durable Object named `room-1` is the Universe `room-1`, and a call to it needs passage into that Universe.

**An unscoped Durable Object extends `UnscopedMeshDO` (D7).** It carries what `ScopedMeshDO` carries, `svc`, alarms and `onStart`, except the passage step, so each `@mesh()` method decides with a guard or a check at its top, as `Profile`'s writes do today and its public reads deliberately do not. Its base refuses to run under a name that parses as a scope, which `Profile` checks by hand today in its own `onBeforeCall`. Passage reads a claimless chain's scope from the name of the node that started it (`claimsForPassage`), which is sound only while every object under a scope-shaped name checks passage. The two bases hold that structurally: `UnscopedMeshDO` refuses such a name, and no subclass of `ScopedMeshDO` can remove its passage step.

**An unscoped node that holds anyone's data is its own gatekeeper, in both directions.** A host lets a sender whose name is no scope push to any of its tabs, so the receiving side checks nothing for it (`requirePassageIntoSender` in `nebula-do.ts`). A document node `5e0f0a2c-8d1b-4c6e-9f7a-2b3c4d5e6f70`, owned at acme and shared with a user at globex, shows the rule:
- **Calls in:** a guard on `subscribe` checks the caller against the document's own share list.
- **Pushes out:** the node checks that list again before each push, so a user unshared while subscribed stops receiving at the next update.

The receiving side's check could not express that share anyway: from a scoped sender, it would refuse the push to a tab on globex's host as lateral. This rule replaces the one that `nebula-do.ts`'s JSDoc and `auth.md` state today, that a node not named by a scope holds no tenant's data.

**A Mesh test Durable Object either takes a scope-shaped name and a token the Registry issues, or extends `UnscopedMeshDO`.** The for-docs mini-apps' document nodes extend `UnscopedMeshDO`, each with a share list and a name the scope grammar refuses. Today `calls/index.test.ts` names one `'collab-doc-1'`, which parses as a Universe.

### What gets renamed

**A name that moves into Mesh drops `Nebula` wherever the shorter name collides with nothing (D12), a base class names the guard it enforces (D16), and Universe, Galaxy and Star stay (D18).**

| Today | After | What the old name reaches |
|---|---|---|
| `NebulaAuthRegistry` | `AuthRegistry` (D12) | a Durable Object class; renamed after the wipe, it would move the data of the one object holding every identity |
| `NEBULA_AUTH_FACADE` | `AUTH_FACADE` (D12) | a binding a browser Client names in `lmz.call`, so a built app depends on it |
| the other `NEBULA_AUTH_*` bindings and variables | `AUTH_*` (D12) | deployed secrets, which the wipe sets once, under their new names |
| `NEBULA_SUB`, `'agent:nebula'` | `'agent:lumenize'` (D19) | every Message the agent writes |
| `NebulaAuthFacade`, `NebulaEmailSender`, `NebulaJwtPayload`, `NEBULA_AUTH_PREFIX`, and every other exported `Nebula…` name, such as `routeNebulaAuthRequest` | `AuthFacade`, `AuthEmailSender`, `AuthClaims`, `AUTH_PREFIX`, and the rest without `Nebula` (D12) | code only |
| `LumenizeDO`, `LumenizeWorker`, `LumenizeClient` | `ScopedMeshDO`, `MeshWorker`, `MeshClient` (D16) | code only; the `NodeType` strings on the wire keep today's values |

**The variable renames switch off two checks unless those checks move with them.** `scripts/audit-test-mode.sh` matches the old variable names literally, so a committed `AUTH_TEST_MODE` would pass it, and `apps/nebula/scripts/required-secrets.mjs` lists `NEBULA_AUTH_BOOTSTRAP_EMAIL`, so the preflight would pass with the new secret missing and the wipe would seed no superuser. Both are renamed with the variables, along with the deploy scripts that name them and the secrets list in `nebula-pre-alpha.md` § *⑥ The wipe*. Until the wipe only `test-nebula` needs its secrets set again; the deployed `nebula` gets them from the wipe.

### What stays Nebula's

**Mesh owns what each auth route does; the app owns how its page looks (D17).** Six GET routes run `serveAuthApp` today, `/` and, under `/auth`, `/login`, `/signup`, `/emails`, `/magic-link` and `/logout`. It fetches `/auth-app.html` from the Worker's assets, built from `apps/nebula-studio-ui/src/auth/`. This task moves the router into Mesh with that step as it is. [mesh-1-alpha.md](mesh-1-alpha.md) has each route's page come from a step the app supplies, the way the facade subclass supplies `scopeLifecycleHooks`, with Nebula's step serving Studio's auth app. The seam is permanent: an app that wants its own pages keeps supplying them after Mesh ships a default.

**mesh-1-alpha makes Nebula's product content configuration the app supplies too:** `POST /auth/coming-soon` and its tags, the agent's profile seed and `sub` (D19), and the email sender's app name and `from` address. **`uploadProfilePicture`, which posts to Nebula's own `/pictures`, goes to `StudioClient` (D20).** The `admin-notification` and `approval-confirmation` email types, which only a test calls, are deleted here, because they describe an approval flow open self-signup rules out.

### The Registry stays raw

**The Registry stays raw infrastructure, reached through the facade, and does not become a mesh node (D13).** Its storage is the part of the system most likely to move:
- **Read replicas for Durable Objects** would make its Workers KV copies unnecessary.
- **A Cloudflare Postgres offering** could hold it.
- **PlanetScale** could, if the singleton runs short of throughput or of its 10 GB, or its cold starts grow.

The facade is a Worker, so it survives each of those moves, where a mesh node would tie identity storage to a Durable Object. Because the Registry is a singleton, a schema migration there touches one object, so its schema may change after the wipe.

**As a mesh node, it would also wake for calls it must refuse.** A host relays a Client's call to whatever binding the Client names: `ClientGateway` hands the frame's `binding` and `instance` to `resolveStub`, which reads `env[binding]` with no list of allowed bindings. The Registry's `@mesh()` methods would be reachable by every authenticated Client past the facade, and the singleton would wake to refuse them, which ADR-018 rules out.

### Packages, tests and checks

- **`@lumenize/resources` lives at `packages/resources` and is `private`.** It is vendored into the container image, as `@lumenize/nebula` is today, and never published, so Lerna skips it.
- **One test-token helper survives:** `create-nebula-test-token.ts`, which mints the `access` claim passage reads, exported from `/auth/testing` under a name without `Nebula` (D12). Mesh's `createTestRefreshFunction` goes.
- **Mesh's suites move onto Mesh's auth and onto a host node.** The files goal 3's two commands list are rewritten to log in through Mesh's own Registry in test mode, which returns the magic link instead of mailing it (ADR-009 rung 2, D23). A suite that tests login itself logs in through real mail (rung 1), and a minted token (rung 3) is only for a shape no login can produce, justified where it is used. The for-docs mini-apps' code is among them; their pages wait for the docs rewrite (D8).
- **Nothing outside `packages/auth` imports `@lumenize/auth` when this task ends** (D9): `git grep -lE "from '@lumenize/auth(/[a-z-]+)?'|\"@lumenize/auth\"" -- packages apps` lists only `packages/auth`. The pattern matches imports and manifests, not the comments in `@lumenize/crypto` and `@lumenize/email` that mention it. [mesh-1-alpha.md](mesh-1-alpha.md) then deletes the package.
- **Pages tied to moved or deleted files leave the `@check-example` checker** (D8), and `website/docs/nebula/api-reference.md`'s block is fixed in the phase that moves its file.

### What changes in standing guidance

**Four files encode the old Mesh/Nebula line itself, and their content changes:**
- `CLAUDE.md`'s opening says Lumenize is MIT packages plus Nebula; the MIT half now includes the scope tree and auth.
- `.claude/rules/workers-projects.md`'s layer map loses `nebula-auth`'s dual-layer row and `NebulaDO`.
- `.claude/rules/mesh.md` § *Package dependency direction* names `@lumenize/resources` as what Mesh never imports, and its carve-out for the wire protocol has nothing left to separate.
- `.claude/rules/raw-comm.md` says which package holds raw-DO infrastructure, which is now a subpath of Mesh.

**Every rule that loads for a file today loads for it at its new path.** The rules encode the line in their `paths:` globs too:
- `security.md` loads for `packages/nebula-auth/**` and `apps/nebula/**`, and says nothing in it binds the MIT packages. After this task the Registry, `worker-token.ts`, `Profile` and `requirePassage` sit in `packages/mesh`, and `OrgTree.requirePermission`, which it names, sits in `packages/resources`.
- `mesh.md`, `raw-comm.md` and `containers.md` reach Resources only through `apps/nebula/**`; `mesh.md` still names a `packages/nebula-frontend` that does not exist.
- `packaging.md` calls `packages/nebula-auth` UNLICENSED, and ADR-023's exemption for "a raw object its own package owns" covers more once the Registry is in Mesh.

**`auth.md`, `enterprise.md`, ADR-007, ADR-009, ADR-014, ADR-015 and ADR-023 took this task's decisions at the Stage 1 gate, approved in `7fa359f`.** `auth.md` now names the two kinds of node (D14), states the gatekeeper rule for an unscoped node that holds anyone's data, and runs passage as a step ahead of `onBeforeCall()` (D22), and the ADRs follow it. The phase that builds what a `> **Today's code differs.**` block in those docs describes removes the block. The rules that describe nodes, such as `security.md`'s node with no scope of its own, take the same words when this task builds them.

**Many more name an old path or name and change mechanically.** `grep -rlE 'nebula-auth|NebulaDO|LumenizeClientGateway|NEBULA_AUTH_|NebulaAuthRegistry|NEBULA_SUB|agent:nebula|createTestRefreshFunction|@lumenize/nebula/|\bLumenize(DO|Worker|Client)\b' CLAUDE.md .claude docs/adr docs/vision` lists them; `.claude/skills/live/SKILL.md`, `workflow.md` and ADR-003 are among them. The `@lumenize/auth` and `LUMENIZE_AUTH_` names go with `packages/auth`, in [mesh-1-alpha.md](mesh-1-alpha.md).

## Constraints

- **ADR-007:** one narrow core, composed by every node. `ScopedMeshDO` absorbing passage keeps it one core, and an unscoped node composes the same one.
- **ADR-023:** the facade stays the bridge into the Registry, which stays raw (D13). **ADR-018:** a call the facade refuses still never wakes the Registry.
- **ADR-015 and ADR-022:** moving the predicates changes no verdict.
- **`workflow.md`:** § *Dependencies*, since Mesh gains workspace dependencies only, `@lumenize/email` and `@lumenize/sql-migrations`; § *Sequential implementation — no parallel worktrees*; § *Releases*, whose breaking changes collect in `tasks/backlog.md`'s "Flag in the next release notes, as BREAKING" rows.
- **`packaging.md` § *Startup cost is work at import, not bytes*:** a Worker importing only Mesh's root must not pay for the Registry's import graph.
- **`live.md`:** `/live` first. The task touches every scenario's imports, so the whole registry is swept, containers included, and a deployed pass runs at its end, since it changes the container image and renames bound classes.

## Future state

- ⚠️ Design consideration: Resources may not need to stay UNLICENSED (Larry, 2026-10-06), since the main differentiator is agentic development of apps that are secure by default (§ *Context*). A package of its own makes that a license change later, not a move. Weigh it against `strategy.md`'s walled garden and `enterprise.md`'s exit story: an MIT Resources lowers the barrier to running a Nebula app off the platform, though a Star still takes its ontology from a Galaxy, which stays UNLICENSED.
- **What an adopter needs before the npm publish** is in [mesh-1-alpha.md](mesh-1-alpha.md).
- **`@lumenize/fetch`, if revived for streaming, targets Mesh 1.x.**

## Open questions

None remain. Every question Pass 1 raised is a row in § *Decisions*, and what is decided for later lives in [mesh-1-alpha.md](mesh-1-alpha.md).

## Decisions

Each row records who decided it and when; § *Design intent* carries the reasons.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **One MIT package: `@lumenize/mesh` takes in `nebula-auth`** (Larry, 2026-10-06). | **Two MIT packages, the predicates in Mesh and the session lifecycle in `@lumenize/auth`** — each would need the other, so they would always release together. **A third leaf package both depend on** — it adds a package in a change meant to remove them. |
| D2 | **Mesh 1.0 is built on the scope tree: `NebulaDO` folds into the scoped base, and `NebulaClient`'s session into the Client base** (Larry, 2026-10-06). § *Context*. | **Keeping a generic Mesh beside Nebula** — § *Context* says why its reasons have eroded. |
| D3 | **Resources and its Vue store are UNLICENSED, outside Mesh; the auth and scope layers Nebula built on Mesh are MIT** (Larry, 2026-10-06). § *The package line, by example*. | **The old line between a generic Mesh and Nebula** — it makes passage and dominion UNLICENSED and leaves MIT with an auth Nebula does not run. |
| D4 | **Builds after `nebula-clients-connect-to-their-scope` and lands before ⑥ the wipe as a `data` item; what carries no risk of a schema change, such as docs and configuration, waits for [mesh-1-alpha.md](mesh-1-alpha.md)** (Larry: the order against the gateway task 2026-10-06, the line with mesh-1-alpha 2026-10-07). § *What waits for mesh-1-alpha*. | **Two parts split at the wipe, the second holding what no app, row or secret sees** — it scheduled breaking changes for after the wipe, when every built app carries the Client's code, and kept on the wipe's path adopter work that mesh-1-alpha can take. **All of it after the wipe** — a new import path, a renamed Registry or a new agent `sub` would then each cost a migration. |
| D5 | **The website docs outside `website/docs/nebula` are rewritten in [mesh-1-alpha.md](mesh-1-alpha.md); `website/docs/nebula/*`, which Studio's model reads every turn, is fixed line by line in the phase that makes a line false, and `platform-embed.ts` regenerated** (Larry, 2026-10-06). | **Docs-first**, the route `/task-management` takes for a change to a package's public surface — the website docs describe the 0.26 packages until 1.0 alpha publishes, so rewriting them first would describe a package nobody can install. |
| D6 | **A thin `NebulaClient` composes `ClientResources`, and the server's pushes stay top-level `@mesh()` methods on it** (Larry, 2026-10-06; the push methods and the name 2026-10-07). § *The Client splits along the same line*. | **Every Resources method on `NebulaClient` itself** — the class keeps mixing its concerns, and Resources' half cannot be tested alone. **Naming it `ResourcesClient`** — it would read as a fourth kind of Client beside `MeshClient`, `NebulaClient` and `StudioClient`. **A registry of parts behind one gate that takes a name, `ctn<…>().part('resources')`** — a name-keyed surface in MIT Mesh that only we would use, and TypeScript cannot check a call through it. **A `@mesh()` getter named `resources`, as on `Star`** — `client.resources` is the local API apps call, so decorating it would put `transaction`, `setPermission` and `invite` on the wire under the user's token. **A separate push gate, `resourcesPushes`** — it changes the wire, so apps built before it lose their pushes, and calibration §11's warning is about forwarders copied onto several hosts, where this is one. |
| D7 | **An unscoped Durable Object extends `UnscopedMeshDO`, which carries what `ScopedMeshDO` carries except passage** (Larry: the name 2026-10-06, the rest 2026-10-07). § *Scoped and unscoped nodes*. | **An abstract method each subclass writes to decide who may call** — `Profile`'s would be empty, and an empty one plus an unguarded `@mesh()` method is the same open method. **Requiring a guard on every `@mesh()` method** — on a scoped node passage is often enough, as `auth.md`'s M5 says of reads. **Addresses such as `acme.crm.tenant1/doc-17` that the scoped base checks passage on** — they confine a document to one tenant, where an unscoped document node can be shared across organizations, as a Google Doc can, checking its own share list when called and when it pushes. **The bare mesh core, with no `svc`, alarms or `onStart`** — the scope-name refusal already makes a wrong choice of base fail loudly, so withholding them protects nothing. **Two exported bases with nothing tying a node's name to its base** — a scope-named node that picks the one without passage is open to every caller; `UnscopedMeshDO`'s refusal of a scope-shaped name is what ties them. **One base whose subclass overrides `onBeforeCall` to replace passage** — a scoped node that forgets `super.onBeforeCall()` silently loses passage. **`IdNamedMeshDO`, `GlobalMeshDO`** — every Durable Object has an id, and ADR-018 uses "global" for a singleton. |
| D8 | **Every page outside `website/docs/nebula` whose `@check-example` names a file this task moves or deletes leaves the checker until the docs rewrite** (Larry, 2026-10-06; the set derived 2026-10-07). `grep -rl -e "@check-example('packages/mesh/" -e "@check-example('packages/nebula-auth/" website/docs` lists them: today pages under `docs/mesh`, plus `docs/nebula/api-reference.md`, which D5 fixes in place instead. `docs/auth` and `docs/debug/index.mdx` name `packages/auth`'s files, which this task leaves as they are. Both `exclude` lists gain the pages, `website/scripts/check-examples.mjs` and the plugin in `website/docusaurus.config.ts`, in the phase that first breaks one, labelled `TEMP → target: the Mesh 1.0-alpha docs rewrite`. | **Accepting the failing run** — every session's `npm test` fails for a known reason and learns to read past a failure. **`@skip-check` on each block** — about a hundred blocks edited, the docs work D5 defers. **Excluding whole directories** — `docs/mesh/creating-plugins.mdx` names only `@lumenize/fetch`'s files, which nothing changes, and would lose its check for nothing. |
| D9 | **This task leaves nothing outside `packages/auth` importing it; [mesh-1-alpha.md](mesh-1-alpha.md) deletes it from the repo, after its real-mail test moves onto Mesh's auth, and deprecates it on npm** (Larry, 2026-10-06; the deletion moved to mesh-1-alpha 2026-10-07). What goes with it has no direct counterpart in Mesh's auth: the approval flow, delegated tokens with an `authorizedActors` list, and the Hono integration. | **Keeping it frozen, as `@lumenize/fetch` is kept** — its suite would keep running, and nothing would revive a package Mesh's auth replaced. **Deleting it in this task** — it breaks no caller, so it waits beside its deprecation. |
| D10 | **One UNLICENSED package, `@lumenize/resources`, keeping `@lumenize/nebula`'s entry-point names, `/client` and `/frontend`** (Larry, 2026-10-07). | **Subpaths named for what they need, `/client` and `/vue`** — the import every generated app makes would gain a new word. **Two packages** — the server and client halves share one wire contract and always release together, D1's reason for one package. |
| D11 | **`nebula-auth`'s entry points nest under `@lumenize/mesh/auth`, and its `./claims` folds into Mesh's root and `/client`** (Larry, 2026-10-07). | **Flat entry points, `/claims`, `/facade`, `/profile`** — `/facade` and `/profile` would lose any sign that they belong to auth. **`/auth/claims`** — code that checks passage would import it from auth, though Mesh's own base class runs those checks. |
| D12 | **A `Nebula…` name that moves into Mesh drops the prefix wherever the shorter name collides with nothing; `NebulaJwtPayload` becomes `AuthClaims`** (Larry, 2026-10-07). § *What gets renamed*. In an MIT package the exported names and the bindings an adopter types are the public surface goal 2 bets on. | **Keeping the code names, per the 2026-09-13 brand decision** — it kept them because the code was internal. **Swapping the prefix to `Lumenize…`** — longer where nothing collides. **Renaming crypto's `JwtPayload` to free the bare name** — it would put the generic name on the specific type. |
| D13 | **The Registry stays raw infrastructure, reached through the facade, and does not become a mesh node; as a singleton, it is the one place a schema migration after the wipe is livable** (Larry, 2026-10-07). § *The Registry stays raw*. | **Making it a mesh node here** — it opens the singleton to every Client before a host node can refuse them. **Making it a mesh node later, once a host node refuses a binding no Client may name** — its storage may leave Durable Objects, for replicas, a Cloudflare Postgres or PlanetScale, and the facade is the seam that survives that move. |
| D14 | **Mesh has two named kinds of node, scoped and unscoped** (Larry, 2026-10-07). § *Scoped and unscoped nodes*. | **Leaving `Profile` described as not a full node** — it is a full node whose policy sits in its methods. **"Id-named node"** — every Durable Object has an id. |
| D15 | **`MeshClient` calls `onClaimsChange()` after every new token, and `connection_status` carries a hosted Client's address** (Larry, 2026-10-07). This settles the backlog row *A Client learns the name its host node holds it under*. | **No new override, with the default refresh exported for a subclass to wrap** — every subclass that cares about tokens would carry refresh plumbing. **The Client working out its address from its hostname** — it would need a table from tier to binding, which `nebula-clients-connect-to-their-scope`'s D1 avoided. |
| D16 | **`LumenizeDO`, `LumenizeWorker` and `LumenizeClient` become `ScopedMeshDO`, `MeshWorker` and `MeshClient`, beside `UnscopedMeshDO`; the `NodeType` strings keep today's values, and `this.lmz` stays** (Larry, 2026-10-07). Every import already reads `@lumenize/…`, and `class Star extends ScopedMeshDO` states the guard its base enforces. | **Renaming only the Durable Object pair** — reads half-renamed. **`LumenizeUnscopedDO` beside `LumenizeDO`** — the default class would say nothing about its guard. **Renaming the `NodeType` strings too** — a wire change a reader never sees. |
| D17 | **The auth pages stay with Studio, each of Mesh's page routes serves what the app supplies, and Nebula's product content becomes app configuration; [mesh-1-alpha.md](mesh-1-alpha.md) builds the seam and the configuration** (Larry, 2026-10-07). § *What stays Nebula's*. | **The pages going MIT now, as Mesh's reference UI** — Mesh would ship a Vue front end, its build and Nebula's theme (ADR-020) before any adopter exists; [mesh-1-alpha.md](mesh-1-alpha.md) builds the default. |
| D18 | **Universe, Galaxy and Star, with `universeGalaxyStarId`, stay Mesh's names in code** (Larry, 2026-10-07). They collide with nothing, where Account, App and Tenant collide with a person's login account, with `apps/nebula`, and with a generated app; the labels people see are [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 3*'s. | **Renaming only Mesh's public surface** — two vocabularies for one tree. **Renaming everything** — the collisions in every sentence, and a migration for stored Client addresses such as `STAR/acme.crm.tenant1/alice.9f2c41aa`. |
| D19 | **The platform agent's `sub` is configuration the app supplies, and Nebula's becomes `'agent:lumenize'`** (Larry, 2026-10-07). The value changes in this task; [mesh-1-alpha.md](mesh-1-alpha.md) builds the configuration. Any value keeps a `:`, which the slug grammar refuses, so `UnscopedMeshDO`'s scope-name refusal never refuses the agent's Profile. | **Keeping `'agent:nebula'`** — the codename would stay in stored records for good. **A Mesh constant renamed `AGENT_SUB`** — it would bake Nebula's agent into MIT Mesh. |
| D20 | **Studio's Client methods, `postUserMessage`, `handlePreviewReady` and `uploadProfilePicture`, live on `StudioClient extends NebulaClient`, in `apps/nebula`, and Studio builds one by passing the class to `createNebulaClient`** (Larry, 2026-10-07). § *The Client splits along the same line*. `nebula-pre-alpha-fast-follow.md` § *Item 8* fans the same push to every collaborator. | **Announcing a build through Resources** — a new platform resource type and a write into history per build, where Item 8 settled on fanning the push. **Studio's methods on `NebulaClient`** — every generated app would carry three methods it never calls. **Studio building its `StudioClient` itself** — a second way to assemble a client, repeating the factory's `ready`, login and host-deleted wiring. |

## Criteria to carry into Pass 2

Settled behaviour a phase must prove, collected at the Pass 1 gate.

- **`drive.ts all` passes, containers included, and so does the deployed pass on `test-nebula`,** at the end of the task.
- **Mesh imports nothing from `@lumenize/resources` or `apps/`,** checked by a script under `scripts/audit-*` rather than by review.
- **A generated app built after this task boots on its new import,** on the `build-box` scenario.
- **A Worker that imports only Mesh's root does no more work at import than before,** measured with `packaging.md`'s two commands.
- **No passage or dominion verdict changes:** their tests move with their assertions untouched.
- **After this task, `git grep -nE "agent:nebula|NEBULA_SUB" -- apps packages docs .claude` finds nothing,** the literal in `nebula-auth-registry.ts`'s superseded-claims record among what it catches.
- **A `ScopedMeshDO` subclass whose `onBeforeCall` never calls `super` still refuses a call with no passage** (D22). Mutation check: move the passage step back into `onBeforeCall`, and the test goes red.
- **`npm run test:doc` passes after every phase,** with D8's exclusion in both entry points from the phase that first breaks a block.
- **After this task, `grep -rnE 'NEBULA_AUTH_' scripts apps/nebula/scripts .github .claude docs/adr` finds only dated history,** and committing `AUTH_TEST_MODE`, then separately `AUTH_BOOTSTRAP_EMAIL`, to a `wrangler.jsonc` turns `npm run audit:test-mode` red. The `LUMENIZE_AUTH_` names go with `packages/auth`, in [mesh-1-alpha.md](mesh-1-alpha.md).
- **Every rule whose `paths:` match a moved file before the move still matches it after,** and a rule that newly matches one is listed as intended. **Every `scripts/audit-*` and `check-*` that scans a moved file today scans it at its new path,** `audit-do-http.mjs` among them, which pins `packages/nebula-auth/src/router.ts`.
- **A hosted Client knows the name its host holds it under** (Larry, 2026-10-07, deferred here from `nebula-clients-connect-to-their-scope`): a phase proves both the `callee` its handlers see and that a Client can call itself.

| D21 | **Mesh's alarm table, `__lmz_alarms`, keeps `time` and `created_at` as epoch seconds, documented at its `CREATE TABLE` in `alarms.ts` as a local exception to ADR-011** (Larry, 2026-10-07). Alarms may be refactored soon, and that refactor revisits both. | **Converting both to ISO text in this task** — a rewrite of every Galaxy's table is free before the wipe, but a refactor of alarms may replace the table anyway. **Adding the retry row's `retryCount` and `status` columns now** — they are additive with defaults, so they can wait for that refactor. |

| D22 | **`ScopedMeshDO` runs passage in a step of its own, keyed by a symbol private to Mesh, before the subclass's `onBeforeCall`, which stays every node's hook for a check every call must meet** (Larry, 2026-10-07). § *Scoped and unscoped nodes*. | **Removing `onBeforeCall`** — the facade refuses a call with no verified claims there, every Client refuses a peer's call there, Mesh's mini-apps put their authentication checks there, and ADR-007 lists it in the core every node composes. **Passage in `onBeforeCall`, with `super.onBeforeCall()` taught** — Mesh's own examples override that hook, and one forgotten line drops passage silently, the hazard D7 cites. **An audit that fails an override never calling `super`** — it catches this repo's code and no adopter's. |

| D23 | **Mesh's suites log in through Mesh's own Registry in test mode, ADR-009 rung 2; real mail only where a suite tests login itself** (Larry, 2026-10-07). § *Packages, tests and checks*. | **Real mail by default, rung 1** — 70 to 150 messages a Mesh run, on a Resend plan of 50,000 a month that testing already nears (11,000 in the 7 days to 2026-10-07), for an email hop Mesh's browser suites and `/live` already cover. **A minted token for the port, rung 3** — ADR-009 justifies each mint where it is used, never a suite at a time. |

## Relationships to complete in Pass 2

Rows in `tasks/backlog.md` this task changes, each edited in the phase that changes it:

- **"The Registry as a mesh node, deleting the facade and the hook seam"** closes, declined by D13.
- **"OPEN QUESTION — `Resources` with a pluggable access-control model"** loses its `Profile` half: `Profile` cannot move onto Resources while it is MIT and Resources is not.
- **"Mesh product feedback: there is no supported way to construct a client with a caller-supplied `refresh`"** is answered by D15, and its premise that `LumenizeClientConfig` omits `refresh` is false.
- **"Add retry + skip logic for alarm handler failures"** (§ *Lumenize Mesh*) gains a pointer to D21, so the refactor of alarms sees the epoch columns too.
- **"`createTestRefreshFunction` is still not exported from `@lumenize/mesh/client`"** closes: the surviving helper is exported from `/auth/testing`.
- **"Adopt hono in `nebula-auth`'s router"** becomes a question about Mesh's `/auth` dependencies.
- **"DECIDE: does `nebula-auth`'s test-mode gate get a second factor?"** holds only while `audit-test-mode.sh` does, so its row records that the audit moved with the renames.
- **"A Client learns the name its host node holds it under"** closes with D15.
- **"Admin notification controls"** (§ *Nebula Auth*) closes with the `admin-notification` email type this task deletes (D17).
- **"A Client resends a call its socket lost"** records that, landing after the wipe, its receipt is a frame an older Client ignores (`onUnknownMessage`), since every built app carries the Client's code.
- **A new "Flag in the next release notes, as BREAKING" row** for this task's breaks to Mesh's public surface, filled in phase by phase: D16's renames, `ComposedMeshDO` unexported, `LumenizeClientGateway` and `createTestRefreshFunction` deleted, and the session moving into `MeshClient`. [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 5* carries it into the release notes.

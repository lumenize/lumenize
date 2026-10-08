# Mesh is built on the scope tree

**Status:** Pass 2 written 2026-10-07, with D1–D23 decided 2026-10-06 and 07. Stage 1 `/review-task` ran twice on 2026-10-07; Stage 2 is next. Lands before ⑥ the wipe; what can wait for adopters is in [mesh-1-alpha.md](mesh-1-alpha.md). Task-file-first, because the Mesh and auth website docs are rewritten later (D5).

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

1. **Eliminate a layer of indirection that serves no additional purpose.** A Star today is `class Star extends NebulaDO`. `NebulaDO` lives in `apps/nebula` and adds passage to `LumenizeDO`, which lives in `@lumenize/mesh`, using predicates from a third package, `@lumenize/nebula-auth`. After this task a Star is `class Star extends ScopedMeshDO`, and one package holds all three. Today the layers duplicate each other rather than build on each other:
   - **Two test-token helpers.** `create-nebula-test-token.ts` exists in `nebula-auth` because Mesh's `createTestRefreshFunction` signs `@lumenize/auth`'s claims (`emailVerified`, `adminApproved`, `isAdmin`), with no `access` claim for passage to read, and was never exported from `@lumenize/mesh/client`.
   - **Two auth packages.** `packages/auth` and `nebula-auth` fork the handler orchestration, as `tasks/backlog.md`'s orchestration-body de-fork row records, and Nebula runs only one of them. This task leaves nothing importing `packages/auth`, so [mesh-1-alpha.md](mesh-1-alpha.md) can delete it.
2. **Take one more shot at an MIT platform useful enough on its own to be adopted.** The adoption has to lift the commercial product more than it costs it in customers who stop at the MIT part. Today the MIT half is a generic Mesh and an auth Nebula does not run, while the multi-tenant structure, sessions and coarse-grained authorization are UNLICENSED.
3. **Consolidate test coverage into a single layer that Lumenize's commercial success rests on.** Today Mesh's suites test a stack Nebula does not ship: `git grep -l "@lumenize/auth'" -- packages/mesh/test` lists the files, the for-docs mini-apps among them, that run on `@lumenize/auth`, and `git grep -l LumenizeClientGateway -- packages/mesh/test` those that run on a Gateway no Nebula page uses. Passage and dominion, meanwhile, are tested in `apps/nebula` and `nebula-auth`, out of Mesh's sight.
4. **Clear the way to deprecate what is already all but deprecated.** `@lumenize/auth` has 31 downloads a month and no counterpart left in Nebula, yet Mesh's suites run on it. `@lumenize/fetch` depends on Mesh, and nobody runs it in production, so nothing is built to keep it working. [mesh-1-alpha.md](mesh-1-alpha.md) deprecates both.

## Relationships

- **Builds after [nebula-clients-connect-to-their-scope.md](archive/nebula-clients-connect-to-their-scope.md),** and inherits three things from it:
  - the split and join of a Client's address, `STAR/acme.crm.tenant1/alice.9f2c41aa`, exported from `@lumenize/mesh/client` as `splitAddress` and `addressOf` (its Phase 2);
  - `NebulaDO` composing `ClientGateway` (its Phase 4), which this task folds into `ScopedMeshDO`;
  - its D4, under which `LumenizeClientGateway` stays in `packages/mesh` until this task deletes it.
- **Gates ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, as a `data` item (§ *What waits for mesh-1-alpha*). It lands after every pre-wipe row above it there that edits a file it moves or repoints, because those are product work riskier than a move: ② Personas (`container/app/src/nebula.ts`, `AGENTS.md`), ③ Capture live (the scaffold's `src/nebula.ts`), ⑤ The ontology history, which may reshape the ontology-version row `resources.ts` reads, *A `computed()` misses its subscription* (`frontend/create-nebula-client.ts`), *Generated apps are pure Vapor* (`scaffold-seed.ts`, `AGENTS.md`), *Denied access shows in the app* (`AGENTS.md`, `api-reference.md`), and *Shared pages* (`nebula-auth`'s claim paths).
- **Gates [mesh-1-alpha.md](mesh-1-alpha.md),** which comes before the npm publish and holds what can land after pre-alpha launches without breaking anything Nebula runs.
- **Comes before the backlog row *A Client resends a call its socket lost*** (`tasks/backlog.md` § *Lumenize Mesh*, decided 2026-10-07), which builds on two seams this task moves: the gateway's message types and the Client's send queue, `#sendOrQueue`. This task keeps both intact under their new names.
- **Rows in `tasks/backlog.md` this task changes, each in the phase named:**
  - *The Registry as a mesh node, deleting the facade and the hook seam* closes, declined by D13 (Phase 3).
  - *Adopt hono in `nebula-auth`'s router* becomes a question about Mesh's `/auth` dependencies (Phase 3).
  - *Admin notification controls* (§ *Nebula Auth*) closes with the email type Phase 3 deletes.
  - *DECIDE: does `nebula-auth`'s test-mode gate get a second factor?* records that the audit moved with the renames (Phase 2).
  - *`createTestRefreshFunction` is still not exported from `@lumenize/mesh/client`* closes, since the surviving helper is exported from `/auth/testing` (Phase 5).
  - A new *Flag in the next release notes, as BREAKING* row opens in Phase 5 and gains each break to Mesh's public surface through Phase 7. [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 5* carries it into the release notes.
  - *OPEN QUESTION — `Resources` with a pluggable access-control model* loses its `Profile` half, since `Profile` cannot move onto Resources while it is MIT and Resources is not (Phase 6).
  - *Add retry + skip logic for alarm handler failures* gains a pointer to D21 (Phase 6).
  - *Mesh product feedback: there is no supported way to construct a client with a caller-supplied `refresh`* is answered by D15, and its premise that `LumenizeClientConfig` omits `refresh` is false (Phase 7).
  - *A Client learns the name its host node holds it under* closes with D15 (Phase 7).
  - *A Client resends a call its socket lost* records that, landing after the wipe, its receipt is a frame an older Client ignores (`onUnknownMessage`), since every built app carries the Client's code (Phase 7).
- **`@lumenize/fetch`'s suites, which Phase 6 skips, have no un-skip owner here:** a revival for streaming (§ *Future state*) un-skips them.

## Current state

**Three packages hold what this task puts in one, and the Resources code moves out of the app.** Each part below opens with its fate: **Carried over** moves as it is, **Adapted** moves and changes, **Replaced** gives way to something else, **Deleted** goes with nothing in its place, and **Left behind** stays where it is. § *Design intent* gives the reasons.

**`@lumenize/nebula-auth`** (`packages/nebula-auth`, UNLICENSED, 0.24.0):
- **Adapted — its code moves into Mesh** (D11), renamed (D12): the Registry, `NebulaAuthRegistry`, with its router and HTTP routes; `worker-token.ts`, which verifies and mints tokens; the scope grammar and the predicates `parseId`, `hasPassageInto` and `hasDominionOver`; the host grammar in `hosts.ts`; the facade base, `NebulaAuthFacade`; `Profile`, onto `UnscopedMeshDO` (D7); `NebulaEmailSender`; and the package's tests.
- **Adapted — its entry points** (D11): `./facade`, `./profile` and `./testing` move under `@lumenize/mesh/auth`, and `./claims` into Mesh's root and `/client`.
- **Carried over until [mesh-1-alpha.md](mesh-1-alpha.md) — what is Nebula's product, not auth** (D17): the page each of six GET routes serves, `/auth/coming-soon`, the agent's profile seed, the email sender's app name and `from` address, and the galaxy cap, `MAX_GALAXIES_PER_OWNER` with `GALAXY_CAP_MESSAGE`. They move into Mesh as they are, and mesh-1-alpha makes each one configuration the app supplies. The agent's `sub` changes value here (D19).
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
- **Adapted — the entrypoint's `hostedUpgrade`,** whose checks port into Mesh's auth layer with its tier-to-binding table as a parameter, so Mesh's own test Workers verify a socket the way Nebula's Worker does (Phase 5).
- **Left behind:** `Universe`, `Star`, the rest of the entrypoint, `PlatformHost`, the certificate machine, the codegen loop, and the facade subclass that supplies `scopeLifecycleHooks`. Each changes only what it imports and extends.

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

**What waits is docs, configuration, and adopter-facing work Nebula does not need,** such as each auth route serving a page the app supplies (D17), Mesh running a scope's teardown itself, and deleting `packages/auth` (D9). Until then Nebula's values stay hard-wired in Mesh, which nobody outside the repo sees before the publish.

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
- **The impersonation child.** `impersonate` builds a second Client acting as Carol, which needs a `ClientResources` of its own, as its parent has, or Carol's page has no store. Living in `MeshClient`, it builds the child with `new this.constructor(…)`, from a protected `childConfig()` each layer extends with its own fields, so a `StudioClient`'s child carries the chat host pair and a `NebulaClient`'s the ontology version. The child's refresh, backed by the impersonation mint, and its link to its parent travel through two symbols private to `MeshClient`'s module, which replace `INTERNAL_REFRESH` and `INTERNAL_PARENT`.
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

**An unscoped Durable Object extends `UnscopedMeshDO` (D7).** It carries what `ScopedMeshDO` carries, `svc`, alarms and `onStart`, except the passage step, so each `@mesh()` method decides with a guard or a check at its top, as `Profile`'s writes do today and its public reads deliberately do not. Its base refuses to run under a name that parses as a scope, at the identity stamp every entry reaches, which `Profile` checks by hand today in its own `onBeforeCall`. Passage reads a claimless chain's scope from the name of the node that started it (`claimsForPassage`), which is sound only while every object under a scope-shaped name checks passage. The two bases hold that structurally: `UnscopedMeshDO` refuses such a name, and no subclass of `ScopedMeshDO` can remove its passage step.

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
| D21 | **Mesh's alarm table, `__lmz_alarms`, keeps `time` and `created_at` as epoch seconds, documented at its `CREATE TABLE` in `alarms.ts` as a local exception to ADR-011** (Larry, 2026-10-07). Alarms may be refactored soon, and that refactor revisits both. | **Converting both to ISO text in this task** — a rewrite of every Galaxy's table is free before the wipe, but a refactor of alarms may replace the table anyway. **Adding the retry row's `retryCount` and `status` columns now** — they are additive with defaults, so they can wait for that refactor. |
| D22 | **`ScopedMeshDO` runs passage in a step of its own, keyed by a symbol private to Mesh, before the subclass's `onBeforeCall`, which stays every node's hook for a check every call must meet** (Larry, 2026-10-07). § *Scoped and unscoped nodes*. | **Removing `onBeforeCall`** — the facade refuses a call with no verified claims there, every Client refuses a peer's call there, Mesh's mini-apps put their authentication checks there, and ADR-007 lists it in the core every node composes. **Passage in `onBeforeCall`, with `super.onBeforeCall()` taught** — Mesh's own examples override that hook, and one forgotten line drops passage silently, the hazard D7 cites. **An audit that fails an override never calling `super`** — it catches this repo's code and no adopter's. |
| D23 | **Mesh's suites log in through Mesh's own Registry in test mode, ADR-009 rung 2; real mail only where a suite tests login itself** (Larry, 2026-10-07). § *Packages, tests and checks*. | **Real mail by default, rung 1** — 70 to 150 messages a Mesh run, on a Resend plan of 50,000 a month that testing already nears (11,000 in the 7 days to 2026-10-07), for an email hop Mesh's browser suites and `/live` already cover. **A minted token for the port, rung 3** — ADR-009 justifies each mint where it is used, never a suite at a time. |

## Phases

**Every phase ends green on the same checks,** so each commit is a working system:
- `npm test` in every workspace the phase touches, `npm run type-check`, and `npm run test:doc`, with D8's exclusion in both entry points from the phase that first breaks a block.
- `npm run audit:test-mode`, `audit:do-http`, `audit:email-isolation` and `audit:test-assertions`, and `audit:dep-direction` from Phase 4. Workspace `npm test` runs none of them. `audit:do-http`'s counts, recorded before Phase 2, stay the same, or the phase names each change.
- `npx tsx apps/nebula/harness/drive.ts all --fast`, since every phase touches imports a scenario rides (`live.md`). Phases 3, 4, 7 and 8 change the container image or the module graph it vendors, so they also run `build-box` and `first-app-built`.
- **A phase that moves a file keeps every check on it.** Every rule whose `paths:` match a moved file before the move still matches it after, and a rule that newly matches one is named as intended. CLAUDE.md's "Loads when" cell for that rule follows. Every `scripts/audit-*` and `check-*`, and every grep a rule gives as its instrument, that covers a moved file covers it at its new path.
- **A phase that changes a backlog row's premise edits the row** (§ *Relationships*).
- **Source cites an ADR, a rule, or nothing,** never this file's handles: `grep -nE '\b[SD][0-9]{1,2}\b|\bPhase[ -][0-9]+\b|\bItem [0-9]+\b'` over the phase's changed source finds none (`workflow.md` § *Referring to things across files*). A temporary site says its target in prose, `TEMP → target: …`.
- **Debug namespaces keep today's strings,** as D16 keeps the `NodeType` strings, so no zero-count assertion on one goes vacuous. [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 7* renames them.

1. **Studio's three Client methods live on `StudioClient`, and Studio builds one through the factory (D20).** This empties `NebulaClient` of everything only Studio uses, so Phase 4 can move it out of the app.
   - `StudioClient extends NebulaClient`, in `apps/nebula/src/studio-client.ts`, takes `postUserMessage` with the chat host pair only it reads (`chatHostBinding`, `chatScope`, `#chatHost`), `handlePreviewReady` with `onPreviewReady`, and `uploadProfilePicture`. The private members those methods read, `#requireOntologyVersion` and `#baseUrl` among them, become protected on `NebulaClient`.
   - `createNebulaClient` takes `Client`, defaulting to `NebulaClient`, and types its config and returned `client` by the class passed. `App.vue` passes `StudioClient`. The Galaxy's preview push names `ctn<StudioClient>()`. The harness builds a `StudioClient` for the scenarios that post to chat or upload a picture.
   - The baseline fixture splits: `NebulaClientTest extends NebulaClient` for the Resources suites, and `StudioClientTest extends StudioClient` for the files that post, so the Resources suites keep running on the class a generated app builds.
   - **Success criteria:**
     - `NebulaClient.prototype` has none of the three methods and `StudioClient.prototype` has all three. *Mutation:* leave `uploadProfilePicture` on `NebulaClient`.
     - A client built as `createNebulaClient({ Client: StudioClient, … })` is a `StudioClient`, and its `onPreviewReady` fires on the build reply, beside `nebula-client-preview-ready.test.ts` and `build-reply.test.ts`, which pass. *Mutation:* the factory ignores `Client`.
     - `signup-to-first-app`, whose limbs post through Studio's composer and upload a picture, passes, with `four-party-chat`, `studio-guidance-loop`, `resubscribe-when-lost`, `hosts-and-frames` and `studio-codegen-rest`. *Mutation:* `App.vue` omits `Client: StudioClient`.

2. **The names a deployed worker, a built app and a stored row hold take their new values (D12, D19).** These are the first four rows of § *What gets renamed*.
   - `NebulaAuthRegistry` becomes `AuthRegistry`. `apps/nebula/wrangler.jsonc` and `apps/nebula/test/browser/worker/wrangler.jsonc` keep a `"state": "deleted"` tombstone for the old class while a deployed worker holds it, and `audit-migrations.mjs` names the new class.
   - `NEBULA_AUTH_FACADE` becomes `AUTH_FACADE`, and every other `NEBULA_AUTH_*` binding and variable becomes `AUTH_*`, wherever code, config, scripts, the harness, rules or ADRs name one. ADR-009's "Today's code differs" block drops its `NEBULA_AUTH_TEST_MODE` clause, and `nebula-pre-alpha.md` § *⑥ The wipe*'s secrets list follows. The keys in the local, gitignored `.dev.vars` are renamed too.
   - `bootDevStack` refuses a boot variable the generated `Env` does not declare, so a stale name fails at boot instead of falling back silently.
   - `NEBULA_SUB` becomes `'agent:lumenize'`, and so does the literal in the Registry's superseded-claims record. The constant keeps its name, labelled `TEMP → target: configuration the app supplies`, which [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 7* builds. `auth.md` § *When Nebula is the actor* and ADR-016 name the new value.
   - **Success criteria:**
     - After `npm run types`, `git grep -nE 'NEBULA_AUTH_' -- . ':!tasks' ':!experiments' ':!**/worker-configuration.d.ts'` finds only `NEBULA_AUTH_PREFIX`, which Phase 3 renames. Task files are history and experiments are never fixed (`workflow.md` § *Experiments*).
     - The connection rate limiter is bound: a local stack's logs show no `nebula-auth.Registry.protections` error. *Mutation:* rename only `router.ts`'s literal.
     - Committing `AUTH_TEST_MODE`, then `AUTH_BOOTSTRAP_EMAIL`, then `AUTH_TURNSTILE_BYPASS_TOKEN`, each alone, to `apps/nebula/wrangler.jsonc` turns `npm run audit:test-mode` red. *Mutation:* the audit keeps the old names.
     - `required-secrets.mjs`'s selftest exits 1 for a list holding every other required secret plus `NEBULA_AUTH_BOOTSTRAP_EMAIL`, with stderr matching `/(^|[^_A-Z])AUTH_BOOTSTRAP_EMAIL/`.
     - `npm run audit:migrations` and its selftest pass.
     - `git grep -n "agent:nebula" -- apps packages docs .claude` finds nothing, and `four-party-chat` still finds the agent as the stamped actor. *Mutation:* `participants.ts` compares against the old literal.

3. **`nebula-auth`'s code lives in Mesh under `/auth`, with its tests (D11, D12, D17).**
   - `packages/nebula-auth/src` moves to `packages/mesh/src/auth/`. `@lumenize/mesh/auth` takes the old root (the Registry, router, email sender and types), beside `/auth/facade`, `/auth/profile` and `/auth/testing`. `./claims` folds into Mesh's root and `/client`: the scope grammar, the predicates and the host grammar. The route runner stays unexported, as `raw-comm.md` § *Route pattern* keeps it, and `apps/nebula`'s entrypoint keeps a runner of its own.
   - The code names drop `Nebula` (D12), and the wrangler configs whose `entrypoint` names the email sender, with `audit-migrations.mjs`'s rule for it, follow. The app's own facade subclass, `apps/nebula/src/nebula-auth-facade.ts`, keeps its name, and its JSDoc gives the reason that still holds. `Profile` stays on `ComposedMeshDO` until Phase 6.
   - The `admin-notification` and `approval-confirmation` email types go, with their templates and their test.
   - Mesh's manifest gains `@lumenize/email` and `@lumenize/sql-migrations`. `packages/nebula-auth` leaves the workspaces, and its lockfile entries are removed by a JSON parse and stringify (`packaging.md` § *`package-lock.json`*) before `npm install` adds the new ones. Every importer repoints, and the container image loses `nebula-auth`'s `COPY` and `.dockerignore` pairs.
   - Its 34 test files become Mesh's `auth` vitest project, with the renamed bindings and a coverage include, and Mesh's catch-all projects exclude that directory.
   - `security.md`'s scope paragraph, its disclaimer (narrowed to `@lumenize/auth` and `@lumenize/crypto`) and its two instruments' paths change here, the phase that makes them false. `audit-do-http.mjs` states its scan structurally, as `raw-comm.md` does: apps' sources and Mesh's `src/auth/` for its checks 1, 2 and 4, with the Registry-stub exemption confined to `src/auth/` (ADR-023), and for check 3 every class in `packages/mesh/src` that declares `HTTP_PREFIXES`.
   - A new `scripts/check-mesh-graph.mjs`, modelled on `check-worker-graph.mjs` and run by Mesh's `test` script, bundles Mesh's root and `/client` and fails if the graph holds the Registry, router, token or email-sender modules, `@lumenize/email` or `@lumenize/sql-migrations`.
   - ADR-023's "Today's code differs" block goes.
   - **Success criteria:**
     - No passage or dominion verdict changes: `git diff -M --word-diff` over `parse-id.test.ts` and the other predicate tests shows only import lines and renamed identifiers. *Mutation:* flip `hasPassageInto`'s upward arm.
     - `check-mesh-graph.mjs` passes. *Mutation:* export `AuthRegistry` from Mesh's root. `packaging.md` § *Startup cost is work at import, not bytes*'s two commands, run before and after, are recorded here as supporting evidence.
     - Mesh's `auth` project runs 34 test files with nebula-auth's case count, and a full Mesh run counts no file twice.
     - `git grep -l "@lumenize/nebula-auth" -- apps packages` finds nothing, and the lockfile holds no `nebula-auth` key.
     - `security.md`'s opening names no package the Registry is not in.

4. **`@lumenize/resources` holds the plane, server and client, and every importer reads it (D10).**
   - `packages/resources`, `private` and UNLICENSED, takes `resources.ts`, `subscriptions.ts`, `snapshots.ts`, `org-tree.ts`, `org-ops.ts`, `query-hash.ts` and `errors.ts`. It also takes `nebula-client.ts` with `impersonation.ts` (Phase 7 moves the session on to Mesh), `frontend/`, and the ontology-version types from `ontology-compile.ts`. Its entry points are `.`, `/client` and `/frontend`.
   - Its manifest pins `@vue/reactivity` and `@vue/runtime-core` to exactly `3.6.0-rc.10`, and the `vue-36-rc-pin` memory lists it as a pin site.
   - `nebula-client.ts`'s `ctn<Star>()` and `ctn<Galaxy>()` calls are typed against `ResourcesRequests`.
   - `page-origin.ts` and `page-meta.ts` move to Mesh's `/client`, beside the host grammar.
   - `@lumenize/nebula` keeps `/client` for Studio (`StudioClient`, `chat-constants`, `participants`, `turn-liveness`), and `/frontend` goes.
   - Every importer repoints: the scaffold through `gen-scaffold.mjs`, the platform guidance through `gen-platform.mjs`, `website/docs/nebula` (D5), Studio, the harness, the app's tests, and the container image. The image's `Dockerfile` and `.dockerignore` pairs for `@lumenize/resources` replace `@lumenize/nebula`'s vendor pair, alongside `container/app/src/nebula.ts` and `vite.config.ts`. `.dockerignore` keeps letting the compiler stage through to `ontology-compile.ts`, `sfc-contract.ts` and `build-report.ts`.
   - `apps/nebula`'s coverage sets `allowExternal` and includes `packages/resources/src/**`, so the moved plane stays in a coverage report.
   - A new `scripts/audit-dep-direction.mjs`, run as `npm run audit:dep-direction`, fails on any import from Mesh into `@lumenize/resources` or `apps/`, and from `@lumenize/resources` into `apps/`. It parses `import type`, `export … from` and dynamic `import()`, resolves package names and relative paths to their workspace, and covers test files.
   - **Success criteria:**
     - `build-box` builds and boots a generated app on `@lumenize/resources/frontend`. *Mutation:* leave the image's `COPY` pair out.
     - `npm run audit:dep-direction` passes. *Mutation:* `import type { Star } from '@lumenize/nebula'` in `packages/resources/src`, then an import of `@lumenize/resources` in `packages/mesh/src`.
     - `git grep -n "@lumenize/nebula/frontend" -- apps packages website/docs` finds nothing.
     - `apps/nebula`'s `npm test`, whose `gen-scaffold` and `gen-platform` checks fail on a stale scaffold or embed, passes.
     - The moved files' statement and branch coverage, before and after, are recorded here, and the single-copy check finds one copy of each Vue package.

5. **Mesh's suites run on Mesh's own auth and on host nodes, and `LumenizeClientGateway` and `createTestRefreshFunction` go (D9, D23).**
   - **Nebula's `hostedUpgrade` ports into Mesh's auth layer** with its tier-to-binding table as a parameter: the upgrade and id-shape checks, token verification, the `aud` and `sub`-prefix checks, and the `x-lumenize-*` scrub. Nebula's entrypoint and every Mesh test Worker call it.
   - The files goal 3's two commands list are rewritten. Each test Worker binds Mesh's Registry, router and facade, and logs in through test mode (ADR-009 rung 2). The browser suites keep real mail (rung 1), and a minted token (rung 3) is justified where it is used.
   - **Every test Durable Object class takes a base Phase 6 gives it, recorded here.** A claimless chain reaches a scoped node only where passage admits it: the callee is at or above the node that started the chain, so `acme.app.t1` calling `acme.app`, and a chain a Worker starts reaches only unscoped nodes. The for-docs mini-apps' document nodes take ids the scope grammar refuses, and keep a share list, checked on `subscribe` and again before each push.
   - `LumenizeClientGateway` goes, with its exports and test bindings, and `node-import.test.mjs` keeps its check with only its comment changed. `createTestRefreshFunction` goes with its own test, and so does Mesh's dev dependency on `@lumenize/auth`.
   - ADR-009's "Today's code differs" block keeps only its `LUMENIZE_AUTH_TEST_MODE` clause, which leaves with `packages/auth` in mesh-1-alpha.
   - **Success criteria:**
     - A test Worker refuses a `/gateway/` upgrade carrying a forged token (403) and one carrying none (401), in a named Mesh test. *Mutation:* skip the verify call.
     - `git grep -lE "from '@lumenize/auth(/[a-z-]+)?'|\"@lumenize/auth\"" -- packages apps` lists only `packages/auth`. *Mutation:* leave Mesh's dev dependency.
     - `git grep -nE "LumenizeClientGateway|createTestRefreshFunction" -- packages apps` finds only `node-import.test.mjs`'s comment.
     - Each Mesh vitest project's `Test Files` and `Tests` counts, before and after, match, or each case the phase drops is named with its reason. `LumenizeClientGateway`'s 4403 case may go.
     - A document node refuses a subscribe from a user off its share list, and stops pushing to a user unshared mid-subscription, each with its refusal message matched. *Mutations:* drop the `subscribe` guard, then skip the push-time check.

6. **`ScopedMeshDO` and `UnscopedMeshDO` are Mesh's Durable Object bases, and passage runs in a step no subclass removes (D7, D14, D16, D22).**
   - `LumenizeDO` becomes `ScopedMeshDO` and absorbs `NebulaDO`. The passage step (`requirePassage`, `claimsForPassage`), keyed by a symbol private to Mesh, runs in the core before `onBeforeCall` on both entries, and emits a debug marker carrying the node's `instanceName`. `requireDominionHere`, `teardown`, `beforeTeardown`, `onRequest` with `HTTP_PREFIXES`, and the composed `ClientGateway` with `requirePassageIntoSender` move too.
   - `UnscopedMeshDO` carries `svc`, alarms and `onStart`, and composes neither `ClientGateway` nor `teardown`. It refuses to run under a name that parses as a scope, at the identity stamp every entry reaches, `lmz.__init`. That check sits in neither `onBeforeCall`, which a subclass can override, nor the constructor, since a throwing Durable Object constructor hangs the test pool. `Profile` moves onto it, and its hand check goes.
   - `ComposedMeshDO` stops being exported, and `LumenizeWorker` becomes `MeshWorker`, in code and in `audit-do-http.mjs`'s list of bases.
   - `Universe`, `Galaxy` and `Star` extend `ScopedMeshDO`, and `nebula-do.ts` goes. `scope-isolation.test.ts`'s T-local-skip and `certificate-wake`'s limb 4 read the passage step's marker, and T-local-skip asserts it fired on the scheduling call before it clears the window.
   - Mesh gains tests for what moved into it: `requirePassage`'s matrix beside the function, and `requireDominionHere` and `teardown` on a test node that logs in at rung 2.
   - `alarms.ts`'s `CREATE TABLE` records its exception to ADR-011, epoch seconds kept until alarms are refactored (D21).
   - `@lumenize/fetch` leaves the run, since the renames break it at load (§ *Current state*): its `test` script is renamed and it joins `SKIP_PACKAGES` in `scripts/type-check.sh`, with the reason recorded in its README.
   - `auth.md`'s block above its M-list (*"Passage runs inside `onBeforeCall()` itself…"*) and ADR-007's block go. `auth.md`'s other blocks stay.
   - **Success criteria:**
     - A `ScopedMeshDO` subclass whose `onBeforeCall` never calls `super` refuses a call with no passage, matching `No passage from`, and runs the method for a token that has passage. *Mutation:* move the passage step back into `onBeforeCall`.
     - `UnscopedMeshDO` refuses to run as `room-1`, both for a subclass whose `onBeforeCall` skips `super` and on a first touch through `rawRpcStub`, and runs as a UUID. *Mutation:* move the check into `onBeforeCall`.
     - The suites Phase 5 ported pass unchanged now that passage runs, which shows their tokens carry it, and so do `apps/nebula`'s passage tests, `node-chain-passage.test.ts` among them. Each Mesh project's counts match Phase 5's. *Mutation:* a ported test's token without `access`.
     - T-local-skip goes red when the passage step runs from the local executor.
     - `audit-do-http`'s surface count is unchanged. *Mutation:* compare a path outside `HTTP_PREFIXES` in `ScopedMeshDO.onRequest`.
     - Mesh's coverage of the files moved into it, before and after, is recorded here against the repo's targets (branch over 80%, statement over 90%).
     - Mesh's root and `/client` export no `ComposedMeshDO`, `LumenizeDO` or `LumenizeWorker`.

7. **`MeshClient` holds the session, `NebulaClient` composes `ClientResources`, and a hosted Client knows its own address (D6, D15, D16).**
   - `LumenizeClient` becomes `MeshClient` and takes the session from `NebulaClient`, all of it as § *The Client splits along the same line* sets out.
   - That covers: `claims`, `activeScope`, `impersonate` with `impersonation.ts`, `logout`, `invite`, `scopes`, the refresh, the Profile channel restored on `onSubscriptionRequired()`, `onClaimsChange()`, and the two private symbols that replace `INTERNAL_REFRESH` and `INTERNAL_PARENT`. The impersonated child takes its config from a protected `childConfig()` each layer extends, the base leaving out `onLoginRequired`.
   - `ClientResources` lives in `@lumenize/resources/client`. `NebulaClient`'s members delegate to it, and its five push methods stay top-level `@mesh()`-decorated methods that forward.
   - The host's `connection_status` carries the Client's address, and `#selfIdentity()` reports it.
   - `packages/resources` gains a test scaffold of its own: package scripts, a test `wrangler.jsonc` with `LOADER`, and a minimal ontology it compiles itself.
   - Mesh gains tests for `impersonate` and `logout`.
   - **Success criteria:**
     - A hosted Client's handlers see its address, `STAR/acme.crm.tenant1/alice.9f2c41aa` in shape, as the `callee`, and the Client can call itself through its host, both in a Mesh test. `client-sender-passage`'s limb 2, another tab of the same `sub` on the same Star, is still refused. *Mutations:* drop the address from `connection_status`, then loosen `onBeforeCall`'s comparison to the host part.
     - `impersonation-lifecycle` gains a limb in which the child subscribes through `child.resources` and gets a snapshot and a later push, and a `StudioClient`'s child is a `StudioClient` that can call `postUserMessage`. *Mutation:* `impersonate` builds a bare `MeshClient`, and both go red.
     - `resubscribe-when-lost` gains a Profile limb. *Mutation:* `MeshClient.onSubscriptionRequired` skips the Profile channel.
     - `resubscribe-on-signal.test.ts`, `impersonation-expiry`, `session-survives-token-lapse` and `push-survives-token-lapse` pass unchanged.
     - `ClientResources`'s suite, whose header says why it sits below `/live`, asserts that `onSubscriptionRequired()` restores resources, queries, rosters and the org tree, and that `onClaimsChange()` re-subscribes when the admin bit flips. *Mutation:* each restore skipped in turn.
     - Mesh's root, `/client` and the moved session exports, `MeshClient`, `parseHost`, `hostOrigin` and `hasPassageInto` among them, load in Node, asserted by `node-import.test.mjs`.

8. **Standing guidance describes one MIT package beside the UNLICENSED code, and the whole system passes, locally and deployed.**
   - The content changes in § *What changes in standing guidance* land here, in the last phase that changes what they describe. That includes `security.md`'s words for the two kinds of node (D14) and the control sites it names, each at its new path.
   - The release-notes row this task opened records every break to Mesh's public surface.
   - **Before the deploy:**
     - From a checkout of `8b81924`, against the old worker, the harness's account sweep runs with `isStaleTestAccount` at a zero-day window, so the renamed Registry starts with nothing orphaned. The `refresh:*` keys in `test-nebula`'s Workers KV are emptied, and its secrets are set again under the new names.
     - `grep -rlnE 'HARNESS_TARGET_URL|stack\.logs' apps/nebula/harness` lists the deployed-only paths, and each is checked against Phase 2's renames and Phase 7's `connection_status`, recorded here (`live.md` § *Two venues, one registry*).
   - **Success criteria:**
     - No guidance file names an old path: every file `git diff -M --name-status 8b81924..HEAD` lists as renamed or deleted is cited by no file in `CLAUDE.md`, `.claude`, `docs/adr` or `docs/vision`, and § *What changes in standing guidance*'s grep lists only dated history and the `NodeType` strings D16 keeps.
     - `security.md`'s two instruments return every file they returned at `8b81924`, at its new path.
     - `grep -rn '^> \*\*Today' docs/adr docs/vision/auth.md` lists no block describing what this task built.
     - `drive.ts all` passes, containers included.
     - After the sweep and before the deploy, the old worker's Registry lists no test universe, and after the deploy a refresh with a cookie from before the rename returns 401.
     - `bash apps/nebula/scripts/deploy-test.sh`, then `HARNESS_TARGET_URL=<test-nebula> npx tsx apps/nebula/harness/drive.ts all --concurrency=2` beside `wrangler tail test-nebula --format json`, passes.

## Non-goals

- **What waits for adopters,** in [mesh-1-alpha.md](mesh-1-alpha.md): the docs rewrite, the auth pages' seam and Nebula's product configuration, scope teardown in Mesh, test-mode and Turnstile defaults, hosts and certificates, the deprecations, `packages/auth`'s deletion, the version and the dist-tag.
- **The Registry as a mesh node** (D13).
- **`__lmz_alarms` in ISO text, and the retry row's columns** (D21).
- **Keeping `@lumenize/fetch` working** (§ *Current state*).
- **Moving `nebula-auth`'s own suites off ADR-009 rung 2.** They already log in through test mode and move with their assertions untouched.

## Build notes

### Phase 1 — Studio's methods live on `StudioClient`

**For the human:**
- **Pulled forward from Phase 7: the impersonation child is built from its parent's own class.** `NebulaClient.impersonate` now builds `new this.constructor(…)` from a protected `childConfig()`, and `StudioClient` extends that with its chat pair. Without it, a Studio client's child would have lost the chat pair it inherits today until Phase 7. Phase 7 moves the same shape into `MeshClient` instead of introducing it.
- **`#baseUrl` moved to `StudioClient` rather than becoming protected.** `uploadProfilePicture` was its only reader; the comment calling it "captured for `logout()`" was stale. Only `requireOntologyVersion` became protected on `NebulaClient`.
- **The harness's driver takes a class, as the factory does.** `connectDriver({ Client: StudioClient })` builds Studio's client and gives it its scope's chat pair (`chatPairOf`); `constructionPairs` now returns only the resource pair. Five scenarios pass `StudioClient`: `four-party-chat`, `studio-guidance-loop`, `studio-codegen-rest`, `resubscribe-when-lost` (its writer), and `hosts-and-frames` (its uploader).
- **Dead chat pairs dropped.** Nine baseline files and three scenarios handed a chat pair to a client that never posts; each now carries only its resource pair.

**Retro notes:**
- The fixture split is a mixin, `withClientTestCaptures(Base)`, applied to both classes. It surfaced an override wider than its base, `handleOrgTreeUpdate(envelope: { value: unknown })`, which the continuation types of two instantiations rejected; narrowed to `OrgTreeState`.
- `createNebulaClient` is generic over the class (`K extends NebulaClientClass`), inferring the config from the constructor, so `onPreviewReady` type-checks only when `Client: StudioClient` is passed.
- **Gate, as run:** `apps/nebula` `npm test` passed 119 files (1 skipped) and 1032 tests in 61 minutes, its one unhandled rejection from `invite-facade.test.ts`, which this phase did not touch. `drive.ts all --fast` passed 53 of 53 in 21.5 minutes. The two new tests and `App.vue`'s `Client` each reddened under their mutation; the last stalls `signup-to-first-app` at the composer's post.
- **`audit:do-http`'s counts before Phase 2:** 5 member `.fetch(` sites, 1 `routeDORequest` call under `apps/`, 2 mesh-node HTTP surfaces comparing 4 paths, and 5 stub-making calls.
- An orphaned `wrangler dev` from 20:06, parented by launchd, was still up from the earlier session's run and was killed before the sweep.

**Close-out notes:** no backlog row or sibling line changes in this phase.

### Phase 2 — the names a deployed worker, a built app and a stored row hold

**For the human:**
- **The rename criterion's grep finds one thing besides `NEBULA_AUTH_PREFIX`: the old name inside `required-secrets.selftest.mjs`.** That selftest is the next criterion, and it needs the old literal to prove a secret set under it does not count. The two criteria pull against each other; the probe keeps the literal.
- **`bootDevStack` checks only a scenario's `bootVars` against the generated `Env`.** The harness's own `--var`s pass unchecked, because `TURNSTILE_SECRET_KEY`, which `turnstile-canary` sets, is not in the generated `Env`: the Worker reads it through a cast in `checkTurnstile`.
- **`tasks/backlog.md`'s rows now name the new bindings, variables and class** (nine binding or variable mentions, three of the class), and the second-factor row records that the binding and the audit moved together. `tasks/reference/nebula-dev-flows.md` was left alone: it carries uncommitted edits that are not this build's.
- **The Registry's superseded-claims record writes the literal `'agent:lumenize'`,** as the phase says, rather than reading `NEBULA_SUB`.

**Retro notes:**
- The renamed audit patterns are unanchored, so a committed `NEBULA_AUTH_TEST_MODE` still matches `AUTH_TEST_MODE`; the old spellings stay caught for free.
- **Gate, as run:** each of the three variables, committed alone to `apps/nebula/wrangler.jsonc`, reddened `audit:test-mode`, and the audit with the old patterns stayed green on all three. `scope-teardown`'s limb 8 passed and reddened when only `router.ts` kept the old limiter name. The selftest reddened when `required-secrets.mjs` kept the old name, and a scenario booting with `NEBULA_AUTH_BOOTSTRAP_EMAIL` stopped before the boot. `audit:do-http`'s counts are unchanged.
- The local `.dev.vars` had two keys to rename, `AUTH_BOOTSTRAP_EMAIL` and `AUTH_TURNSTILE_BYPASS_TOKEN`.
- **Suites:** `nebula-auth` 34 files, 496 tests passed and 4 skipped, its 15 unhandled rejections the typed `RegistryError` refusals its tests assert; `apps/nebula` 119 files and 1032 tests, unchanged from Phase 1; `drive.ts all --fast` 53 of 53.

**Close-out notes:** the backlog's *DECIDE: does `nebula-auth`'s test-mode gate get a second factor?* row records the move, as § *Relationships* says.

### Phase 3 — `nebula-auth`'s code lives in Mesh under `/auth`

**For the human:**
- **Three names did not simply drop `Nebula`.** `buildNebulaJwtPayload` became `buildAuthClaims`, matching the type it builds, rather than `buildJwtPayload`. The email templates became `defaultMagicLinkHtml`, `defaultInviteNewHtml` and `defaultInviteExistingHtml`, since the bare names are the sender's own method names, and `@lumenize/auth` uses the same `default…Html` convention. `verifyNebulaTurnstileToken` took the bare `verifyTurnstileToken`, though `@lumenize/auth` still has a copy of that name, as D12 already accepted for `AuthClaims`; `turnstile.ts`'s header now says so.
- **The test files dropped their `nebula-` prefixes too** (`auth-registry.test.ts`, `auth-routes.test.ts`, `auth-email-sender.test.ts`, and three more), and the auth test Worker is named `mesh-auth`.
- **`@lumenize/mesh/auth` still exports the scope grammar and the verdicts the old root exported,** beside the same names on Mesh's root and `/client`. Importers rewritten from `@lumenize/nebula-auth` reach them there; nothing forces the one path yet.
- **Guidance prose that names `nebula-auth` as a package** — `raw-comm.md`, `mesh.md`, `workers-projects.md`, `coding-style.md`, `security.md`'s bullets, `auth-flows.md` — waits for Phase 8's content pass, as § *What changes in standing guidance* says. This phase changed only paths, the rules' `paths:` globs, CLAUDE.md's "Loads when" cells, `security.md`'s opening, its disclaimer and its two instruments, and `raw-comm.md`'s description of the audit this phase widened.
- **`website/docs/introduction.md`'s package table still lists `@lumenize/nebula-auth`;** [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 1*, which rewrites that table, now says so.

**Retro notes:**
- The path rewrite hit four lines that only looked like paths, all caught in the diff walk: the Dockerfile's `COPY` pair and the `.dockerignore` pair it turned into `packages/mesh/src/auth`, ADR-023's "Today's code differs" block (deleted, as the phase says), and ADR-010's dated history line, restored to `@lumenize/nebula-auth`. A comment in `packages/auth` it had renamed was restored too.
- Two test comments in `auth-email-sender.test.ts` said `invite-existing` is never sent; `buildInviteMessage` sends it to an invitee who already accepted. Corrected while removing the two deleted types' rows.
- Stale generated `worker-configuration.d.ts` files typed every `rawRpcStub` call `never` after the move, through an import of the renamed email sender that `skipLibCheck` hid. `npm run types` cleared it.
- **Startup, `packaging.md`'s two commands:** the Worker bundle went from 2807.19 to 2806.23 KiB. Active startup measured 19.3 to 20.5 ms before and 19.7 to 22.7 ms after, over three alternating runs of each; the first after-run's 38.4 ms did not repeat.
- **Gate, as run so far:** Mesh's `auth` project runs 34 files, 494 passed and 4 skipped, which is `nebula-auth`'s 500 less the two deleted email rows; `vitest list` puts all 34 in `[auth]` alone. Flipping `hasPassageInto`'s upward arm reddened 4 tests in `parse-id.test.ts`. `check-mesh-graph.mjs` passed, and reddened when Mesh's root exported `AuthRegistry`. A Mesh class declaring `HTTP_PREFIXES` and dispatching on an unregistered path now fails `audit:do-http`, whose counts are unchanged. `security.md`'s two instruments return the same files as at `8b81924`, at their new paths.
- **Suites:** Mesh 75 files, 967 passed and 4 skipped; `apps/nebula` 119 files and 1032 tests, unchanged, its second unhandled rejection a vitest teardown race in `update-identity.test.ts`; `drive.ts all --fast` 53 of 53; `build-box` and `first-app-built` pass on the image without `nebula-auth`'s vendor pair; `test:doc` passes.

**Close-out notes:** the backlog's *The Registry as a mesh node* row closes, declined by D13; *Admin notification controls* closes with the deleted email types; *Adopt hono* now names Mesh's router and says its question is a Mesh dependency.

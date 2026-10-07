# Mesh is built on the scope tree

**Status:** Pass 1, with D1–D20 decided 2026-10-06 and 07. Stage 1 `/review-task` ran once on 2026-10-07; this version applies it and reshapes the file into two parts, so Stage 1 runs again before Pass 2 writes phases. Part 1 lands before ⑥ the wipe; Part 2 after it, before [mesh-1-alpha.md](mesh-1-alpha.md). Task-file-first, because the Mesh and auth website docs are rewritten later (D5).

## Objective

**`@lumenize/mesh` 1.0-alpha takes in the scope tree, passage and dominion, the Registry with its sessions, and the Client's session, all MIT. Resources and its Vue store become `@lumenize/resources`, UNLICENSED. Studio and the scope nodes stay in `apps/nebula`.**

| Today | License | After this task | License |
|---|---|---|---|
| `@lumenize/mesh` (`packages/mesh`) | MIT | `@lumenize/mesh` 1.0 alpha | MIT |
| `@lumenize/nebula-auth` (`packages/nebula-auth`) | UNLICENSED | `@lumenize/mesh/auth` and three entry points under it, its predicates in Mesh's root and `/client` (D11) | MIT |
| `NebulaDO`, and `NebulaClient`'s session (`apps/nebula`) | UNLICENSED | `ScopedMeshDO` and `MeshClient` (D2, D16) | MIT |
| Resources' server side (`apps/nebula`) | UNLICENSED | `@lumenize/resources` (D10) | UNLICENSED |
| Resources' client side, exported today as `@lumenize/nebula/frontend` | UNLICENSED | `@lumenize/resources/client` and `/frontend` (D10) | UNLICENSED |
| Studio, `Universe`, `Galaxy`, `Star` and the Worker (`apps/nebula`) | UNLICENSED | `apps/nebula`, importing both | UNLICENSED |
| The auth pages Mesh's routes serve (`apps/nebula-studio-ui/src/auth/`) | UNLICENSED | stay with Studio, supplied to each route by the app (D17) | UNLICENSED |
| `@lumenize/auth` (`packages/auth`) | MIT | deleted from the repo (D9); deprecated on npm by [mesh-1-alpha.md](mesh-1-alpha.md) | MIT |
| `@lumenize/fetch` (`packages/fetch`) | MIT | deprecated on npm by [mesh-1-alpha.md](mesh-1-alpha.md) | MIT |

## Context

**The line between Mesh and Nebula, and the one between `@lumenize/auth` and `nebula-auth`, were useful for a time, and their reasons have been eroding.**

- **Mesh was meant to be useful on its own, and adoption says it is not.** It was first published on 2026-02-11 and had 46 downloads in the 30 days to 2026-10-04 (npm's API). What it adds over Workers RPC is continuations, and the full structured-clone value space carried consistently all the way to the browser. That has not been enough to justify a layer on top. Meanwhile, Cloudflare hasn't been standing still:
  - Cloudflare released Cap'n Web days before `@lumenize/rpc`, the RPC package that evolved into Mesh, was due to ship. Cap'n Web covers the last leg to the browser, though not as well or as consistently as Mesh.
  - `RpcTarget`, in Workers RPC and Cap'n Web alike, passes an object as a capability, and promise pipelining sends dependent calls in one round trip. Those are the two things Mesh's continuations provide.
  - Cap'n Web's type support has improved significantly, largely from our own work. Larry's capnweb#99 proposed `ArrayBuffer` and typed arrays, `URL` and `RegExp`, which later landed as #201, #224 and #225, between July and September 2026.
  - Even Workers RPC carries more of an Error now. Since compatibility date 2026-04-21, one keeps its `name`, `message`, `cause` and custom properties.
- **Mesh has had no release since the focus moved to Nebula.** 0.26.0, on 2026-06-03, is the last.
- **`nebula-auth` already split from `@lumenize/auth`,** on 2026-07-31 ([archive/nebula-auth-decouple-from-auth.md](archive/nebula-auth-decouple-from-auth.md)).

**The new bet is that most of what made Nebula different is what makes an MIT package worth adopting:** a robust multi-tenant tree built in, up to three tiers deep, with authentication and coarse-grained authorization on it that refuse lateral movement by construction. Those were differentiators for the commercial product. Resources stays one, but the main differentiator for the commercial product is agentic development of apps that are secure by default. `docs/vision/enterprise.md` § *Identity is a commodity* draws the same line from the buyer's side: the front door is the part anyone can buy, so it is the part to align on.

## Goals

Each goal says how today's design misses it.

1. **Eliminate a layer of indirection that serves no purpose.** A Star today is `class Star extends NebulaDO`. `NebulaDO` lives in `apps/nebula` and adds passage to `LumenizeDO`, which lives in `@lumenize/mesh`, using predicates from a third package, `@lumenize/nebula-auth`. After this task a Star is `class Star extends ScopedMeshDO`, and one package holds all three. Today the layers duplicate each other rather than build on each other:
   - **Two test-token helpers.** `create-nebula-test-token.ts` exists in `nebula-auth` because Mesh's `createTestRefreshFunction` signs `@lumenize/auth`'s claims (`emailVerified`, `adminApproved`, `isAdmin`), with no `access` claim for passage to read, and was never exported from `@lumenize/mesh/client`.
   - **Two auth packages.** `packages/auth` and `nebula-auth` fork the handler orchestration, as `tasks/backlog.md`'s orchestration-body de-fork row records, and Nebula runs only one of them.
2. **Take one more shot at an MIT platform useful enough on its own to be adopted.** The adoption has to lift the commercial product more than it costs it in customers who stop at the MIT part. Today the MIT half is a generic Mesh and an auth Nebula does not run, while the multi-tenant structure, sessions and coarse-grained authorization are UNLICENSED.
3. **Consolidate test coverage into Mesh, the one layer Lumenize's commercial success rests on.** Today Mesh's suites test a stack Nebula does not ship: `git grep -l "@lumenize/auth'" -- packages/mesh/test` lists the files, the for-docs mini-apps among them, that run on `@lumenize/auth`, and `git grep -l LumenizeClientGateway -- packages/mesh/test` those that run on a Gateway no Nebula page uses. Passage and dominion, meanwhile, are tested in `apps/nebula` and `nebula-auth`, out of Mesh's sight.
4. **Force the deprecation of what is already all but deprecated.** `@lumenize/fetch` depends on Mesh, and nobody runs it in production. `@lumenize/auth` has 31 downloads a month and no counterpart left in Nebula.

## Relationships

- **Builds after [nebula-clients-connect-to-their-scope.md](archive/nebula-clients-connect-to-their-scope.md),** and inherits three things from it:
  - the split and join of a Client's address, `STAR/acme.crm.tenant1/alice.9f2c41aa`, exported from `@lumenize/mesh/client` as `splitAddress` and `addressOf` (its Phase 2);
  - `NebulaDO` composing `ClientGateway` (its Phase 4), which Part 2 folds into `ScopedMeshDO`;
  - its D4, under which `LumenizeClientGateway` stays in `packages/mesh` until Part 2 deletes it.
- **Part 1 gates ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, as a `data` item (§ *Two parts, split at the wipe*). It lands after the four pre-wipe rows there that edit files it moves, because they are product work riskier than a move: *A `computed()` misses its subscription* (`frontend/create-nebula-client.ts`), *Generated apps are pure Vapor* (`scaffold-seed.ts`, `AGENTS.md`), *Denied access shows in the app* (`AGENTS.md`, `api-reference.md`), and *Shared pages* (`nebula-auth`'s claim paths).
- **Part 2 gates [mesh-1-alpha.md](mesh-1-alpha.md),** which comes before the npm publish and holds what an adopter needs that Nebula does not: the website docs rewrite (D5), which deletes D8's checker exclusion; Mesh's default auth UI (D17); tier labels (D18); the deprecations; and the version and dist-tag.
- **Part 2 comes before the backlog row *A Client resends a call its socket lost*** (`tasks/backlog.md` § *Lumenize Mesh*, decided 2026-10-07), which builds on two seams Part 2 moves: the gateway's message types and the Client's send queue, `#sendOrQueue`. Part 2 keeps both intact under their new names.

## Current state

**Three packages hold what this task puts in one, and the Resources code moves out of the app.** Each part below opens with its fate: **Carried over** moves as it is, **Adapted** moves and changes, **Replaced** gives way to something else, and **Left behind** stays where it is. § *Design intent* gives the reasons.

**`@lumenize/nebula-auth`** (`packages/nebula-auth`, UNLICENSED, 0.24.0):
- **Adapted — all of it moves into Mesh** (D11), renamed (D12): the Registry, `NebulaAuthRegistry`, with its router and HTTP routes; `worker-token.ts`, which verifies and mints tokens; the scope grammar and the predicates `parseId`, `hasPassageInto` and `hasDominionOver`; the host grammar in `hosts.ts`; the facade base, `NebulaAuthFacade`; `Profile`, onto `UnscopedMeshDO` (D7); `NebulaEmailSender`; and the package's tests.
- **Adapted — its entry points** (D11): `./facade`, `./profile` and `./testing` move under `@lumenize/mesh/auth`, and `./claims` into Mesh's root and `/client`.
- **Adapted — what is Nebula's product, not auth, becomes the app's** (D17): the page each of six GET routes serves, `/auth/coming-soon`, the agent's profile seed and `sub` (D19), and the email sender's app name and `from` address.
- **Replaced — the `admin-notification` and `approval-confirmation` email types**, with their templates and their test, deleted (D17).

**`apps/nebula`** (`@lumenize/nebula`, UNLICENSED, 0.24.0):
- **Adapted — `NebulaDO`** (`nebula-do.ts`), folded into `ScopedMeshDO`: `requirePassage` and `claimsForPassage` in `onBeforeCall`, `requireDominionHere`, `teardown` and `beforeTeardown`, and the composed `ClientGateway` with its socket handlers.
- **Adapted — `NebulaClient`** (`nebula-client.ts`, 2,442 lines), split three ways (D6, D15, D20):
  - **its session goes into `MeshClient`, MIT:** `claims`, `activeScope`, `impersonate` with all of `impersonation.ts`, `logout`, `invite`, `scopes`, the refresh it configures, and the Profile channel, `subscribeProfile` and `handleProfileUpdate`;
  - **Resources goes into `@lumenize/resources/client`:** `transaction`, the resource, query and roster subscriptions, the org tree, `bindStore`, chat, and the five push methods Resources calls; `uploadProfilePicture` stays with it;
  - **Studio's two methods go into `StudioClient`,** in `apps/nebula`: `postUserMessage` and `handlePreviewReady`.
- **Adapted — the Resources plane, into `@lumenize/resources`** (D10): `resources.ts`, `subscriptions.ts`, `snapshots.ts`, `org-tree.ts`, `org-ops.ts`, `query-hash.ts`, and `errors.ts`, whose errors are all Resources' (`OntologyStaleError`, `PermissionDeniedError` and the rest). `resources.ts` names the facade's binding, which D12 renames.
- **Adapted — `frontend/` and the two client entries,** into three homes (§ *The package line, by example*).
- **Adapted — the Galaxy's preview push,** which names `StudioClient` (D20).
- **Left behind:** `Universe`, `Star`, the entrypoint, `PlatformHost`, the certificate machine, the codegen loop, and the facade subclass that supplies `scopeLifecycleHooks`. Each changes only what it imports and extends.

**`@lumenize/mesh`** (`packages/mesh`, MIT, 0.26.0):
- **Carried over:** the call core in `lmz-api.ts`, `ClientGateway`, the operation-chain executor, alarms, broadcast and `@rawRpc`.
- **Adapted — the node classes** (D16): `LumenizeDO` becomes `ScopedMeshDO`, `LumenizeClient` becomes `MeshClient`, and `LumenizeWorker` becomes `MeshWorker`.
- **Adapted — `ComposedMeshDO`,** the mixin `LumenizeDO` and `Profile` are built on today, which stops being exported (D7).
- **Replaced — `LumenizeClientGateway`,** which no Nebula page connects through once the gateway task is built, deleted with the tests that use it moved onto a host node.
- **Replaced — `createTestRefreshFunction`,** by `nebula-auth`'s `create-nebula-test-token.ts` (§ *Packages, tests and checks*).

**Elsewhere:**
- **Replaced — `@lumenize/auth`** (`packages/auth`, MIT, 0.26.0), by Mesh's auth (D9). Its npm deprecation sends its users there, which is what makes it replaced, where `@lumenize/fetch`, with no successor, is left behind.
- **Left behind — `@lumenize/fetch`.** Nothing is built to keep it working; a suite of its that this task breaks is skipped with its reason, never deleted, so a revival for streaming has something to prove itself against (Larry, 2026-09-24).
- **Left behind — `@lumenize/rpc` and `@lumenize/testing`,** which do not depend on Mesh. `@lumenize/rpc` stays deprecated on lumenize.com only, since `@lumenize/testing`'s `createTestingClient` and `instrumentDOProject` build on it.
- **Left behind until [mesh-1-alpha.md](mesh-1-alpha.md):** the website docs D8 excludes, and the package table in `website/docs/introduction.md`.

**Missing, grouped by part:**

- **Part 1**
  1. `@lumenize/resources` at `packages/resources`, with every importer repointed (§ *Two parts, split at the wipe*).
  2. The renames of D12 that the wire, a stored row or a deployed secret sees, with the audits and preflights that name them (§ *What gets renamed*).
  3. The platform agent's `sub` as app configuration, `'agent:lumenize'` for Nebula (D19).
- **Part 2**
  4. `nebula-auth` inside Mesh, and Mesh's `/auth` entry points (D11).
  5. `ScopedMeshDO`, `UnscopedMeshDO`, `MeshWorker` and `MeshClient` (D7, D16).
  6. The Client split: the Resources part, `onClaimsChange()`, the address in `connection_status`, and `StudioClient` (D6, D15, D20).
  7. The auth pages' seam and the app's configuration (D17).
  8. Mesh's suites on its own auth and on a host node, then `packages/auth` deleted (D9).
  9. Standing guidance that describes one MIT package beside the UNLICENSED code (§ *What changes in standing guidance*).

The design intent below opens with how the work splits at the wipe, then shows the package line by example, then takes the Client, scoped and unscoped nodes, the renames, what stays Nebula's, the Registry, packaging and tests, and the guidance that changes.

## Design intent

### Two parts, split at the wipe

**Part 1 holds only what costs a migration if it lands after the wipe.** After ⑥, every user's app, every stored row and every deployed secret outlives a change; before it, the wipe rebuilds them. Three things are in that set:
- **The import path generated code uses.** Every app's `src/nebula.ts`, which the scaffold seeds into its Workspace, imports `createNebulaClient` from `@lumenize/nebula/frontend`, and `platform/AGENTS.md` teaches imports from it too. Part 1 creates `@lumenize/resources` and repoints every importer: the scaffold, the platform guidance, `website/docs/nebula`, `apps/nebula-studio-ui`, the harness, and the container image, whose `Dockerfile` copies each vendored package's `package.json` and `src` and whose root `.dockerignore` lets each through, alongside `container/app/src/nebula.ts` and `vite.config.ts`. `git grep -l "@lumenize/nebula/\(frontend\|client\)"` lists them. For now `/client` carries all of today's `NebulaClient`; Part 2 splits it.
- **The names a stored row, a built app or a deployed secret holds** (§ *What gets renamed*).
- **The platform agent's `sub`,** `'agent:nebula'` today, stored on every Message the agent writes (D19).

**Part 2 holds everything else,** none of which an app, a row or a secret can see: `nebula-auth` into Mesh, the node classes, the Client split, the auth pages' seam, Mesh's tests, `packages/auth`'s deletion, and the guidance. It lands after the wipe and before [mesh-1-alpha.md](mesh-1-alpha.md).

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
// UNLICENSED, @lumenize/resources/client: composes the Resources part
class NebulaClient extends MeshClient { @mesh() handleResourceUpdate(…) { … } }
// UNLICENSED, apps/nebula: Studio's own
class StudioClient extends NebulaClient { @mesh() handlePreviewReady(…) { … } }
```

**A thin `NebulaClient` composes a Resources part (D6).** Resources' half becomes an object of its own, which can be tested alone, and the parts meet in four places:
- **Server pushes.** Resources calls back with `ctn<NebulaClient>().handleResourceUpdate(…)` and ten more like it, reaching five push methods. They stay top-level `@mesh()`-decorated methods on `NebulaClient`, each forwarding to the part, so the wire does not change. That is the shape `LumenizeClient`'s class JSDoc teaches an adopter for a Client's incoming calls: `@mesh()`-decorated methods on a subclass. `client.resources`, the API apps call (`client.resources.transaction(…)`), stays undecorated, so nothing local reaches the wire.
- **New tokens and reconnects (D15).** On each new token today's `NebulaClient` records the page's scope and, when the admin bit flips, re-subscribes resources, queries, rosters, profiles and the org tree. After the split `MeshClient` owns the refresh, records the scope, and calls an override, `onClaimsChange()`, after every new token. `NebulaClient` hands that, `onConnectionStateChange` and `onSubscriptionRequired()` to the part. `refresh` stays public on `MeshClientConfig`, where Mesh's own tests pass one, and stays left out of `NebulaClientConfig`, so no app builds a Client whose token and scope disagree.
- **The impersonation child.** `impersonate` builds a second Client acting as Carol, which needs the same part as its parent or Carol's page has no store. Living in `MeshClient`, it builds the child with `new this.constructor(…)`. The child's refresh, backed by the impersonation mint, and its link to its parent travel through two symbols private to `MeshClient`'s module, which replace `INTERNAL_REFRESH` and `INTERNAL_PARENT`.
- **Its own address (D15).** A hosted Client's `#selfIdentity()` reports `gatewayBindingName`, by default `LUMENIZE_CLIENT_GATEWAY`, a binding no Nebula Worker has, so a Client calling itself through the mesh is refused as a peer: it compares the last hop with its bare id, `alice.9f2c41aa`, where its host stamps `acme.crm.tenant1/alice.9f2c41aa`. `connection_status` carries the address instead, and `#selfIdentity()` reports it.

**Studio's two methods live on `StudioClient`, in `apps/nebula` (D20),** because the Galaxy, in `apps/nebula`, names the class it pushes to, and `apps/nebula-studio-ui` depends on `apps/nebula`, not the reverse. Chat itself is Resources already: Studio reads a thread with `client.resources.subscribeQuery`, and `handleStreamChunk` is the Client's end of Resources' `streamProgress`.

### Scoped and unscoped nodes

**A scoped node's name is a scope, and passage guards it; an unscoped node's name is not, and its own methods carry its policy (D14).** The Star `acme.crm.tenant1` is a scoped node. `Profile`, named by a `profileId` such as `1a9d…`, is the first unscoped node, and the facade, a `MeshWorker` with no instance name, is another. `auth.md` already describes the second kind without naming it: a node with no scope of its own checks the claims at the top of each method that needs them.

**Passage is `ScopedMeshDO`'s default, and it reads the called node's name as the target scope.** `requirePassage` runs `parseId` on the name, with two outcomes:
- **A name the grammar refuses is refused outright.** A `profileId` is a 36-character UUID, past the 30-character slug cap.
- **A name the grammar accepts is a scope, whether or not anyone meant one.** A test Durable Object named `room-1` is the Universe `room-1`, and a caller reaches it only with passage into that Universe.

**An unscoped Durable Object extends `UnscopedMeshDO` (D7).** It carries what `ScopedMeshDO` carries, `svc`, alarms and `onStart`, except passage: its `onBeforeCall` admits every caller, so each `@mesh()` method decides with a guard or a check at its top, as `Profile`'s writes do today and its public reads deliberately do not. Its base refuses to run under a name that parses as a scope, which `Profile` checks by hand today in its own `onBeforeCall`. Passage reads a claimless chain's scope from the name of the node that started it (`claimsForPassage`), which is sound only while every object under a scope-shaped name checks passage, and with the refusal in the base no exported class can break that. `nebula-do.ts`'s JSDoc says a node not named by a scope must hold no tenant's data, because a scope node lets an unscoped sender push to any of its tabs. An adopter's per-document node does hold one, so the rule becomes that such a node checks passage into its tenant in its own guards.

**A Mesh test Durable Object either takes a scope-shaped name and a real token, or extends `UnscopedMeshDO`.**

### What gets renamed

**Mesh's public names say the layer and what they promise, and drop `Nebula`; Universe, Galaxy and Star stay.**

| Today | After | Part | Why that part |
|---|---|---|---|
| `NebulaAuthRegistry` | `AuthRegistry` (D12) | 1 | a Durable Object class; renamed later, it would move the data of the one object holding every identity |
| `NEBULA_AUTH_FACADE` | `AUTH_FACADE` (D12) | 1 | a binding a browser Client names in `lmz.call`, so a built app depends on it |
| the other `NEBULA_AUTH_*` bindings and variables | `AUTH_*` (D12) | 1 | the wipe sets the deployed secrets, once, under their new names |
| `NEBULA_SUB`, `'agent:nebula'` | app configuration, `'agent:lumenize'` (D19) | 1 | stored on every Message the agent writes |
| `NebulaAuthFacade`, `NebulaEmailSender`, `NebulaJwtPayload`, `NEBULA_AUTH_PREFIX` | `AuthFacade`, `AuthEmailSender`, `AuthClaims`, `AUTH_PREFIX` (D12) | 2 | code only |
| `LumenizeDO`, `LumenizeWorker`, `LumenizeClient` | `ScopedMeshDO`, `MeshWorker`, `MeshClient` (D16) | 2 | code only; the `NodeType` strings on the wire keep today's values |

**Part 1's renames switch off two checks unless those checks move with them.** `scripts/audit-test-mode.sh` matches the old variable names literally, so a committed `AUTH_TEST_MODE` would pass it, and `apps/nebula/scripts/required-secrets.mjs` lists `NEBULA_AUTH_BOOTSTRAP_EMAIL`, so the preflight would pass with the new secret missing and the wipe would seed no superuser. Both are renamed in Part 1, with the deploy scripts that name the variables and the secrets list in `nebula-pre-alpha.md` § *⑥ The wipe*. Until the wipe only `test-nebula` needs its secrets set again; the deployed `nebula` gets them from the wipe.

### What stays Nebula's

**Mesh owns what each auth route does; the app owns how its page looks (D17).** Six GET routes run `serveAuthApp` today, `/auth/home`, `/login`, `/signup`, `/emails`, `/magic-link` and `/logout`, which fetches `/auth-app.html` from the Worker's assets, built from `apps/nebula-studio-ui/src/auth/`. After Part 2 each route's page comes from a step the app supplies, the way the facade subclass supplies `scopeLifecycleHooks`, and Nebula's step serves Studio's auth app. The seam is permanent: an app that wants its own pages keeps supplying them after Mesh ships a default in [mesh-1-alpha.md](mesh-1-alpha.md).

**Nebula's product content becomes configuration the app supplies:** `POST /auth/coming-soon` and its tags, the agent's profile seed and `sub` (D19), and the email sender's app name and `from` address. **`uploadProfilePicture`, which calls the app Worker's `/pictures`, stays with Resources' client.** The `admin-notification` and `approval-confirmation` email types, which only a test calls, are deleted, because they describe an approval flow open self-signup rules out.

### The Registry stays raw

**The Registry stays raw infrastructure in this task, reached through the facade (D13).** A host relays a Client's call to whatever binding the Client names: `ClientGateway` hands the frame's `binding` and `instance` to `resolveStub`, which reads `env[binding]` with no list of allowed bindings. As a mesh node, the Registry's `@mesh()` methods would be reachable by every authenticated Client past the facade, and the singleton would wake to refuse them, which ADR-018 rules out. [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 6* holds the follow-on.

### Packages, tests and checks

- **`@lumenize/resources` lives at `packages/resources` and is `private`.** It is vendored into the container image, as `@lumenize/nebula` is today, and never published, so Lerna skips it.
- **One test-token helper survives:** `create-nebula-test-token.ts`, which mints the `access` claim passage reads, exported from `/auth/testing` under a name without `Nebula` (D12). Mesh's `createTestRefreshFunction` goes.
- **Mesh's suites move onto Mesh's auth and onto a host node.** The files goal 3's two commands list are rewritten with real tokens.
- **`packages/auth` is deleted once nothing else imports it** (D9): `git grep -l "@lumenize/auth" -- packages apps` lists only `packages/auth`. Its `test/e2e-email` is the only test that sends real mail through Cloudflare Email Sending, since Nebula and Mesh's browser Worker both use Resend, so it moves onto Mesh's auth with a `send_email` binding before the deletion.
- **Pages tied to moved or deleted files leave the `@check-example` checker** (D8), and `website/docs/nebula/api-reference.md`'s block is fixed in the phase that moves its file.

### What changes in standing guidance

**Four files encode the old Mesh/Nebula line itself, and their content changes:**
- `CLAUDE.md`'s opening says Lumenize is MIT packages plus Nebula; the MIT half now includes the scope tree and auth.
- `.claude/rules/workers-projects.md`'s layer map loses `nebula-auth`'s dual-layer row and `NebulaDO`.
- `.claude/rules/mesh.md` § *Package dependency direction* names `@lumenize/resources` as what Mesh never imports, and its carve-out for the wire protocol has nothing left to separate.
- `.claude/rules/raw-comm.md` says which package holds raw-DO infrastructure, which is now a subpath of Mesh.

**Every rule that loads for a file today loads for it at its new path.** The rules encode the line in their `paths:` globs too:
- `security.md` loads for `packages/nebula-auth/**` and `apps/nebula/**`, and says nothing in it binds the MIT packages. After Part 2 the Registry, `worker-token.ts`, `Profile` and `requirePassage` sit in `packages/mesh`, and `OrgTree.requirePermission`, which it names, sits in `packages/resources`.
- `mesh.md`, `raw-comm.md` and `containers.md` reach Resources only through `apps/nebula/**`; `mesh.md` still names a `packages/nebula-frontend` that does not exist.
- `packaging.md` calls `packages/nebula-auth` UNLICENSED, and ADR-023's exemption for "a raw object its own package owns" covers more once the Registry is in Mesh.

**`auth.md` and what follows it name the two kinds of node (D14).** § *Lumenize Nebula mesh* says the Profile is a node but "best not thought of as a full one", and § *Profiles* gives that as a reason. Both become the definition: an unscoped node is a full mesh node whose name is not a scope, so its own methods carry its policy. The ADRs and rules that describe nodes, such as ADR-015's passage and `security.md`'s node with no scope of its own, take the same words. These are docs-first rows, for Larry's review.

**Many more name an old path or name and change mechanically.** `grep -rlE 'nebula-auth|NebulaDO|LumenizeClientGateway|@lumenize/auth|NEBULA_AUTH_|LUMENIZE_AUTH_' CLAUDE.md .claude docs/adr docs/vision` lists them; `.claude/skills/live/SKILL.md`, `critical.md` and ADR-009's second rung are among them.

## Constraints

- **ADR-007:** one narrow core, composed by every node. `ScopedMeshDO` absorbing passage keeps it one core, and an unscoped node composes the same one.
- **ADR-023:** the facade stays the bridge into the Registry, which stays raw (D13). **ADR-018:** a call the facade refuses still never wakes the Registry.
- **ADR-015 and ADR-022:** moving the predicates changes no verdict.
- **`workflow.md`:** § *Dependencies*, since Mesh gains workspace dependencies only, `@lumenize/email` and `@lumenize/sql-migrations`; § *Sequential implementation — no parallel worktrees*; § *Releases*, whose breaking changes collect in `tasks/backlog.md`'s "Flag in the next release notes, as BREAKING" rows.
- **`packaging.md` § *Startup cost is work at import, not bytes*:** a Worker importing only Mesh's root must not pay for the Registry's import graph.
- **`live.md`:** `/live` first. Both parts touch every scenario's imports, so the whole registry is swept, containers included, and a deployed pass runs after each, since Part 1 changes the container image and both rename bound classes.

## Future state

- ⚠️ Design consideration: Resources may not need to stay UNLICENSED (Larry, 2026-10-06), since the main differentiator is agentic development of apps that are secure by default (§ *Context*). A package of its own makes that a license change later, not a move. Weigh it against `strategy.md`'s walled garden and `enterprise.md`'s exit story: an MIT Resources lowers the barrier to running a Nebula app off the platform, though a Star still takes its ontology from a Galaxy, which stays UNLICENSED.
- **Mesh's default auth UI, tier labels, and the Registry as a mesh node** are in [mesh-1-alpha.md](mesh-1-alpha.md).
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
| D4 | **Builds after `nebula-clients-connect-to-their-scope`; Part 1 lands before ⑥ the wipe as a `data` item, and Part 2 after it, before [mesh-1-alpha.md](mesh-1-alpha.md)** (Larry, 2026-10-06, for the order against the gateway task; the split is the author's, 2026-10-07). § *Two parts, split at the wipe*. | **All of it before the wipe** — most of it touches nothing an app, a row or a secret holds, and it would delay the wipe for no migration saved. **All of it after the wipe** — a new import path, a renamed Registry or a new agent `sub` would then each cost a migration. |
| D5 | **The website docs outside `website/docs/nebula` are rewritten in [mesh-1-alpha.md](mesh-1-alpha.md); `website/docs/nebula/*`, which Studio's model reads every turn, is fixed line by line in the phase that makes a line false, and `platform-embed.ts` regenerated** (Larry, 2026-10-06). | **Docs-first**, the route `/task-management` takes for a change to a package's public surface — the website docs describe the 0.26 packages until 1.0 alpha publishes, so rewriting them first would describe a package nobody can install. |
| D6 | **A thin `NebulaClient` composes a Resources part, and the server's pushes stay top-level `@mesh()` methods on it** (Larry, 2026-10-06; the push methods 2026-10-07). § *The Client splits along the same line*. | **Every Resources method on `NebulaClient` itself** — the class keeps mixing its concerns, and Resources' half cannot be tested alone. **A registry of parts behind one gate that takes a name, `ctn<…>().part('resources')`** — a name-keyed surface in MIT Mesh that only we would use, and TypeScript cannot check a call through it. **A `@mesh()` getter named `resources`, as on `Star`** — `client.resources` is the local API apps call, so decorating it would put `transaction`, `setPermission` and `invite` on the wire under the user's token. **A separate push gate, `resourcesPushes`** — it changes the wire, so apps built before it lose their pushes, and calibration §11's warning is about forwarders copied onto several hosts, where this is one. |
| D7 | **An unscoped Durable Object extends `UnscopedMeshDO`, which carries what `ScopedMeshDO` carries except passage** (Larry: the name 2026-10-06, the rest 2026-10-07). § *Scoped and unscoped nodes*. | **An abstract admission method each subclass must write** — `Profile`'s would be empty, and an empty admission plus an unguarded `@mesh()` method is the same open method. **Requiring a guard on every `@mesh()` method** — on a scoped node passage is often enough, as `auth.md`'s M5 says of reads. **Addresses such as `acme.crm.tenant1/doc-17` that the scoped base checks passage on** — a `@mesh()` guard gives an adopter's per-document node the same. **The bare mesh core, with no `svc`, alarms or `onStart`** — the scope-name refusal already makes a wrong choice of base fail loudly, so withholding them protects nothing. **Two exported bases, one with passage and one without** — one that picks wrong is open to every caller. **One base whose subclass overrides `onBeforeCall` to replace passage** — a scoped node that forgets `super.onBeforeCall()` silently loses passage. **`IdNamedMeshDO`, `GlobalMeshDO`** — every Durable Object has an id, and ADR-018 uses "global" for a singleton. |
| D8 | **Every page outside `website/docs/nebula` whose `@check-example` names a file this task moves or deletes leaves the checker until the docs rewrite** (Larry, 2026-10-06; the set derived 2026-10-07). `grep -rn "@check-example('packages/\(mesh/test\|auth\|nebula-auth\)" website/docs` lists them: today `docs/mesh`, `docs/auth` and `docs/debug/index.mdx`. Both `exclude` lists gain them, `website/scripts/check-examples.mjs` and the plugin in `website/docusaurus.config.ts`, in the phase that first breaks one, labelled `TEMP → target: the Mesh 1.0-alpha docs rewrite`. | **Accepting the failing run** — every session's `npm test` fails for a known reason and learns to read past a failure. **`@skip-check` on each block** — about a hundred blocks edited, the docs work D5 defers. **Excluding only `docs/mesh` and `docs/auth`** — D9 would break `docs/debug/index.mdx`. |
| D9 | **`packages/auth` is deleted from the repo once nothing else imports it, after its real-mail test moves onto Mesh's auth** (Larry, 2026-10-06). Its npm deprecation is [mesh-1-alpha.md](mesh-1-alpha.md)'s. What goes with it has no direct counterpart in Mesh's auth: the approval flow, delegated tokens with an `authorizedActors` list, and the Hono integration. | **Keeping it frozen, as `@lumenize/fetch` is kept** — its suite would keep running, and nothing would revive a package Mesh's auth replaced. |
| D10 | **One UNLICENSED package, `@lumenize/resources`, keeping `@lumenize/nebula`'s entry-point names, `/client` and `/frontend`** (Larry, 2026-10-07). | **Subpaths named for what they need, `/client` and `/vue`** — the import every generated app makes would gain a new word. **Two packages** — the server and client halves share one wire contract and always release together, D1's reason for one package. |
| D11 | **`nebula-auth`'s entry points nest under `@lumenize/mesh/auth`, and its `./claims` folds into Mesh's root and `/client`** (Larry, 2026-10-07). | **Flat entry points, `/claims`, `/facade`, `/profile`** — `/facade` and `/profile` would lose any sign that they belong to auth. **`/auth/claims`** — code that checks passage would import it from auth, though Mesh's own base class runs those checks. |
| D12 | **A `Nebula…` name that moves into Mesh drops the prefix wherever the shorter name collides with nothing; `NebulaJwtPayload` becomes `AuthClaims`** (Larry, 2026-10-07). § *What gets renamed*. In an MIT package the exported names and the bindings an adopter types are the public surface goal 2 bets on. | **Keeping the code names, per the 2026-09-13 brand decision** — it kept them because the code was internal. **Swapping the prefix to `Lumenize…`** — longer where nothing collides. **Renaming crypto's `JwtPayload` to free the bare name** — it would put the generic name on the specific type. |
| D13 | **The Registry stays raw infrastructure in this task; making it a mesh node is a follow-on** (Larry, 2026-10-07). § *The Registry stays raw*. | **Making it a mesh node here** — it opens the singleton to every Client before the relay can refuse them. **Never** — nothing yet says the follow-on is wrong once the relay refuses unknown bindings. |
| D14 | **Mesh has two named kinds of node, scoped and unscoped** (Larry, 2026-10-07). § *Scoped and unscoped nodes*. | **Leaving `Profile` described as not a full node** — it is a full node whose policy sits in its methods. **"Id-named node"** — every Durable Object has an id. |
| D15 | **`MeshClient` calls `onClaimsChange()` after every new token, and `connection_status` carries a hosted Client's address** (Larry, 2026-10-07). This settles the backlog row *A Client learns the name its host node holds it under*. | **No new override, with the default refresh exported for a subclass to wrap** — every subclass that cares about tokens would carry refresh plumbing. **The Client working out its address from its hostname** — it would need a table from tier to binding, which the gateway task's D1 avoided. |
| D16 | **`LumenizeDO`, `LumenizeWorker` and `LumenizeClient` become `ScopedMeshDO`, `MeshWorker` and `MeshClient`, beside `UnscopedMeshDO`; the `NodeType` strings keep today's values, and `this.lmz` stays** (Larry, 2026-10-07). Every import already reads `@lumenize/…`, and `class Star extends ScopedMeshDO` states the guard its base enforces. | **Renaming only the Durable Object pair** — reads half-renamed. **`LumenizeUnscopedDO` beside `LumenizeDO`** — the default class would say nothing about its guard. **Renaming the `NodeType` strings too** — a wire change a reader never sees. |
| D17 | **The auth pages stay with Studio, each of Mesh's page routes serves what the app supplies, and Nebula's product content becomes app configuration** (Larry, 2026-10-07). § *What stays Nebula's*. | **The pages going MIT now, as Mesh's reference UI** — Mesh would ship a Vue front end, its build and Nebula's theme (ADR-020) before any adopter exists; [mesh-1-alpha.md](mesh-1-alpha.md) builds the default. |
| D18 | **Universe, Galaxy and Star, with `universeGalaxyStarId`, stay Mesh's names in code** (Larry, 2026-10-07). They collide with nothing, where Account, App and Tenant collide with a person's login account, with `apps/nebula`, and with a generated app; the labels people see are [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 3*'s. | **Renaming only Mesh's public surface** — two vocabularies for one tree. **Renaming everything** — the collisions in every sentence, and a migration for stored Client addresses such as `STAR/acme.crm.tenant1/alice.9f2c41aa`. |
| D19 | **The platform agent's `sub` is configuration the app supplies, and Nebula's becomes `'agent:lumenize'`** (Larry, 2026-10-07). Any value keeps a `:`, which the slug grammar refuses, so D7's base still admits the agent's Profile. | **Keeping `'agent:nebula'`** — the codename would stay in stored records for good. **A Mesh constant renamed `AGENT_SUB`** — it would bake Nebula's agent into MIT Mesh. |
| D20 | **Studio's two Client methods live on `StudioClient extends NebulaClient`, in `apps/nebula`** (Larry, 2026-10-07). `nebula-pre-alpha-fast-follow.md` § *Item 8* fans the same push to every collaborator. | **Announcing a build through Resources** — a new platform resource type and a write into history per build, where Item 8 settled on fanning the push. **Both methods on `NebulaClient`** — every generated app would carry two methods it never calls. |

## Criteria to carry into Pass 2

Settled behaviour a phase must prove, collected at the Pass 1 gate.

- **`drive.ts all` passes, containers included, and so does the deployed pass on `test-nebula`,** after each part.
- **Mesh imports nothing from `@lumenize/resources` or `apps/`,** checked by a script under `scripts/audit-*` rather than by review.
- **A generated app built after Part 1 boots on its new import,** on the `build-box` scenario.
- **A Worker that imports only Mesh's root does no more work at import than before,** measured with `packaging.md`'s two commands.
- **No passage or dominion verdict changes:** their tests move with their assertions untouched.
- **`npm run test:doc` passes after every phase,** with D8's exclusion in both entry points from the phase that first breaks a block.
- **After Part 1, `grep -rnE 'NEBULA_AUTH_|LUMENIZE_AUTH_' scripts apps/nebula/scripts .github .claude docs/adr` finds only dated history,** and committing `AUTH_TEST_MODE`, then separately `AUTH_BOOTSTRAP_EMAIL`, to a `wrangler.jsonc` turns `npm run audit:test-mode` red.
- **For each moved file, the set of rules whose `paths:` match it is the same before and after the move.**
- **A hosted Client knows the name its host holds it under** (Larry, 2026-10-07, deferred here from `nebula-clients-connect-to-their-scope`): a phase proves both the `callee` its handlers see and that a Client can call itself.

## Relationships to complete in Pass 2

Rows in `tasks/backlog.md` this task changes, each edited in the phase that changes it:

- **The `## @lumenize/auth` section** loses its package (D9). Each row moves to Mesh's auth or is deleted with the package, among them the MCP OAuth row, the OIDC row, the verified-claims header row, the rotation-policy question, and *#sendEmail swallows a failed send*.
- **"The Registry as a mesh node, deleting the facade and the hook seam"** is stale: it lists the facade among what it deletes, and its trigger assumes `nebula-auth` merges into `apps/nebula`. Its trigger becomes D13's precondition, the relay refusing a binding no Client may name, and the facade stays a Worker.
- **"OPEN QUESTION — `Resources` with a pluggable access-control model"** loses its `Profile` half: `Profile` cannot move onto Resources while it is MIT and Resources is not.
- **"Mesh product feedback: there is no supported way to construct a client with a caller-supplied `refresh`"** is answered by D15, and its premise that `LumenizeClientConfig` omits `refresh` is false.
- **"`createTestRefreshFunction` is still not exported from `@lumenize/mesh/client`"** closes: the surviving helper is exported from `/auth/testing`.
- **"Adopt hono in `nebula-auth`'s router"** becomes a question about Mesh's `/auth` dependencies.
- **"DECIDE: does `nebula-auth`'s test-mode gate get a second factor?"** holds only while `audit-test-mode.sh` does, so its row records that the audit moved with the renames.
- **"A Client learns the name its host node holds it under"** closes with D15.

# A Client connects to its scope's node

**Status:** Pass 2, with Stage 2 `/review-task` run 2026-10-06 and its findings applied; `/build-task` is next. D1–D7 are Larry's. Stage 1 ran twice, on 2026-10-05 and on 2026-10-06 against mesh-calls as built, and Larry settled what it raised one item at a time. This file decides [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Open decisions*, item 4, and is a deliberate exception to one child task file at a time: it outgrew the master plan while [mesh-calls-to-and-from-clients.md](archive/mesh-calls-to-and-from-clients.md) built.

**Objective — a `NebulaClient` opens its one socket on the Durable Object (DO) its page's host spells, and that object hosts the Client's server-side half, so no Client needs a Durable Object of its own.**

A page on `crm.acme.lumenize.dev` connects to the Galaxy `acme.crm`. A page on `tenant1.crm.acme.lumenize.dev` connects to the Star `acme.crm.tenant1`. A persona's page on `manny--dev.crm.acme.lumenize.dev` connects to the Star `acme.crm.dev`, the Star its token already names; ADR-022 § *A persona's host* already gives that page a token, so a persona needs nothing beyond § *Worked examples*, example 5.

## The words this file uses

**A Client is one instance of `LumenizeClient` or `NebulaClient`.** A browser tab can run more than one: an admin's page and the impersonation child it opens are two Clients in one tab. A Client is a mesh node too, so this file calls Durable Objects and Workers **server-side nodes** when it needs to tell them apart from a Client.

**A Client's server-side half** is the code that holds its socket: it builds the context of every call the Client makes, checks passage on every call that goes down to it, and keeps its grace period. That code is `ClientGateway`. Today it runs inside a Durable Object of the Client's own, named `alice.9f2c41aa`; after this task it is composed into the Star `acme.crm.tenant1`. This file says **Gateway** only for that per-Client Durable Object.

**Two kinds of host.** A page's *host* is its hostname, `tenant1.crm.acme.lumenize.dev`, as ADR-021 uses the word. A Client's **host node** is the server-side node that holds its socket. Today that is the Client's own Gateway. After this task it is the node its page's host spells, here the Star `acme.crm.tenant1`.

**A Client's address is its host node plus its id there.** Alice's Client on that page has the id `alice.9f2c41aa`, her `sub` and a `tabId` (a `sub` is a UUID, written `alice` in this file). Today its address is one name, its Gateway's: (`NEBULA_CLIENT_GATEWAY`, `alice.9f2c41aa`). After this task it is the Star's binding and scope plus that id, written as one string, `STAR/acme.crm.tenant1/alice.9f2c41aa` (§ *What the examples settle*).

**A door is a method a node receives mesh messages at.** Every node has two: the request door, `__executeOperation`, and the fire-back door, `__handleResponse`, which takes the answer to a call the node made. `mesh.md` and `auth.md` call them doors, and this file follows them; ADR-007 calls them entries.

## Goals

Each goal says how today's design misses it.

1. **A Client's calls to its host node take one hop.** Today each one goes Client → Gateway → server-side node. Measured, the hop adds 7–18 ms per call at p50 ([experiments/gateway-vs-hosted/RESULTS.md](../experiments/gateway-vs-hosted/RESULTS.md)).
2. **A server-side node pushes to the Clients it hosts directly.** Today every push to a Client is an RPC to that Client's Gateway.
   - **What users feel in pre-alpha is the chat stream.** `Resources.streamProgress` pushes each chunk of a model's reply to every subscribed Client, one RPC per Client per chunk. Hosted on the Galaxy, each push is a `ws.send`.
   - **At scale it is broadcast.** A broadcast to 1,000 subscribing Clients reached them in 1.1–1.2 s at p50 through Gateways, against 93–113 ms when the node held the sockets, with a hosted p99 of 102–138 ms. Those are arrival times, recorded by each Client's handler as it ran, from the moment the publisher called `publish`. All 1,000 ran in one Node process, so browsers spread across the internet add their own latency; the server's share is what the two numbers compare.
   - **The publisher waited too:** about 2 s for its own `publish` call through Gateways, against about 0.1 s hosted. That was measured on the Gateway before mesh-calls' D11, which held a push's RPC open until the Client answered. D11's Gateway acks at once, so the gap is smaller now, but each subscriber still costs the publisher one RPC (the RESULTS file's § *Faithfulness notes*).
3. **A Client's server-side half lives in the node its token names.** Alice's token carries `aud: acme.crm.tenant1`, and passage and dominion are computed from it. Yet the code that checks passage on what goes down to her runs in a Durable Object named `alice.9f2c41aa`, which exists only for her tab. That object is why every tab reserves a Durable Object name for good, and why mesh-calls' D25 needs a Gateway name check.
4. **A Client costs fewer billed requests.** Computed from Cloudflare's published pricing rather than measured, for a call to the host node itself and a push from it: about 2.05 billed requests per call through a Gateway against 0.05 hosted (~40x), since an incoming socket message bills at 1/20 and an outgoing one is free. A push drops from about 1.05 to 0.05 (~20x). A relayed call (example 2) and a Profile's push (example 4) cost what they cost today.
   - **Duration changes too.** A push waiting on a Client's answer keeps whatever holds the wait resident for up to 30 s, since D11 hands each wait to `ctx.waitUntil`. So N pushes waiting on N Clients keep one host node resident, where today they keep N Gateways.

## Relationships

- **Builds after [mesh-calls-to-and-from-clients.md](archive/mesh-calls-to-and-from-clients.md), built 2026-10-05.** Its D23 extracts a Client's server-side half as `ClientGateway`, code a Durable Object composes, with `LumenizeClientGateway` as its first host node. This task moves that code onto a scope's node; § *What mesh-calls handed this file* rules on what it left open.
- **The package merge comes after it** (Larry, 2026-10-06), as a task file not yet written. It builds `@lumenize/mesh` 1.0-alpha on the Universe/Galaxy/Star tree, folds `NebulaDO` into `LumenizeDO`, moves `nebula-auth` into Mesh as a subpath, and deletes `LumenizeClientGateway` (D4).
- **Its gate is `deploy`.** Every generated app bundles the Client, and the wipe rebuilds them all. The subscription rows need not be kept (§ *What the examples settle*).
- **Leaves `tasks/on-hold/mesh-origin-request.md`'s `locationHint` half on hold.** A Galaxy created through its Universe lands beside it (D3), and the hint is the lever if a far Galaxy ever matters.
- **Backlog rows in `tasks/backlog.md` it changes**, each edited in Phase 6:
  - **"A TTL sweep for subscriber rows"** — becomes possible for a host node's own Clients, since it holds both their rows and their sockets, but is not built here. Rows other nodes hold, such as a Profile's, still need the sweep.
  - **"A `/gateway/` instance is claimable by whoever knows its name"** — the claim moves to a tag on the host node, and the upgrade's `sub` check still refuses anyone else's id.
  - **"A per-`sub` limit at the Gateway"** — moves to the host node, which sees every frame of every Client it hosts.
  - **"One verified-claims HEADER on the edge→DO hop"** — the upgrade forward to a host node becomes its next consumer.
  - **"Build a broadcast tier when a real workload needs one"** — a hosted subscriber no longer costs an RPC, which answers most of it; subscribers hosted elsewhere still do.
  - **"Anonymous read-only users"** — such visitors would hold sockets on a Star too (§ *The load a host node carries*).
  - **"EU data residency for Stars (DO `jurisdiction`)"** — its list of the sites that resolve a Star's name gains the upgrade's route from hostname to host node and a sender's split of a Client's address at the `/`. `ClientGateway.getDOStub` stays on it.
- **Backlog rows Phase 6 adds**, for what this file considered and does not build:
  - **A Client fails its pending calls when its host node resets.** Trigger: a host-node reset seen in a pre-alpha session or on the deployed pass (§ *What a reset costs*).
  - **A host node checks a Client's passage before relaying to a target whose name is a scope,** so a stranger cannot touch a name someone will create later and fix where it lives. Trigger: public signup, beside the Turnstile rows (§ *How a host node checks a call*).
  - **mesh-calls' D17, a Web Lock on `tabId`.** Trigger: a 4409 loop seen in a session (§ *What mesh-calls handed this file*). No row holds it today; the nearest, `tasks/on-hold/mesh-resilience-testing.md` § *Phase 4: Supersession (4409)*, tests the close, not the lock.
  - **Flag in the next release notes, as BREAKING, what this changes in `@lumenize/mesh`**, beside mesh-calls' row: a `/` in an instance name now addresses a Client its host node holds, and `LumenizeClient` can upgrade at `/gateway/{instanceName}`.

## Context and current state

**Built already**, and what becomes of each part. Each bullet opens with its fate: **Carried over** moves as it is, **Adapted** moves and changes, **Replaced** gives way to something new, and **Left behind** stays where it is, unused by Nebula.

- **Adapted — `ClientGateway`** (`packages/mesh/src/client-gateway.ts`). mesh-calls' D23 factored it out of `LumenizeClientGateway` so that any Durable Object can compose a Client's server-side half. It accepts and supersedes a Client's socket, builds every call's context from the socket's verified attachment, forwards a server-side node's call down and pairs the answer, and keeps each Client's grace period. What changes: it is composed by a scope's node, it receives from a branch in each of the host node's two doors (§ *How a host node checks a call*), and it reads Client addresses in the new form.
  - **It tags each socket with its Client's id,** and finds that Client's socket again by the tag, so one host node can hold the sockets of many Clients.
  - **A tag does not have to be unique to one socket,** so before it accepts a socket it closes any socket already holding that tag, which is how a reconnect replaces the old connection. It then picks a Client's socket by tag only if that socket is open, so one still closing is never chosen, whether or not the runtime has dropped it from the list yet. Today's test `routes mesh calls to the new socket after supersession` covers that for one Client per Gateway; Phase 5 extends it to many Clients on one host node.
- **Left behind by Nebula — `LumenizeClientGateway`**, which hosts one `ClientGateway` per Client in a DO named `{sub}.{tabId}`. It stays in `packages/mesh` through this task, since 28 files under `packages/mesh/test` use it, and the package merge deletes it with them (D4).
- **Carried over — `NebulaClientGateway`'s passage check on what it sends down** (mesh-calls D12, built), which stops a lateral sender (example 4). Under hosting it runs in the host node.
- **Left behind — the `NebulaClientGateway` class**, a `LumenizeClientGateway` that adds that check. Nebula stops binding it, and `apps/nebula/wrangler.jsonc` lists it twice, as a binding and as an export, so retiring it changes what a deploy reconciles (Missing 10).
- **Replaced — the `/gateway/*` route in `apps/nebula/src/entrypoint.ts`.** Today a Client upgrades at `wss://tenant1.crm.acme.lumenize.dev/gateway/NEBULA_CLIENT_GATEWAY/alice.9f2c41aa`, and the Worker verifies the token and hands the upgrade to that Gateway through `routeDORequest`. Hosted, it upgrades at `wss://tenant1.crm.acme.lumenize.dev/gateway/alice.9f2c41aa`, naming only its id (D7). The Worker reads the binding and scope from the hostname, rewrites the path to `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa`, and hands it to `routeDORequest` with today's `prefix: 'gateway'` and `onBeforeConnect`, its `bindings` naming `UNIVERSE`, `GALAXY` and `STAR` where today it names `NEBULA_CLIENT_GATEWAY`. `routeDORequest` forwards that path unchanged, so the host node reads the id from the segment after its own name (§ *The trust boundary*).
- **Adapted — `NebulaClient`.** It connects with `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` and takes `{sub}.{tabId}` as its id. An impersonation child shares its parent's config and takes `{subjectSub}.{parentTabId}.{scope with dashes}`. Each connects to its page's host node instead and keeps its id.
- **Adapted — every place that stores or reads a Client's address.** Today each address is a Gateway's binding plus a Client's id. Each gains its host node, which is what makes this change wide; it is also mechanical.
  - **Readers:** Resources' `#caller()` takes the binding from `callChain.at(-1)` and the id from `callChain[0]`; the Galaxy's `#clientOrigin()` and `Profile.subscribe` read `callChain[0]`; the Galaxy's preview-ready call names `NEBULA_CLIENT_GATEWAY` and a Client id.
  - **Stored:** the `Subscriptions` table (`apps/nebula/src/subscriptions.ts`) and the Profile's `Subscribers` table, and the `DroppedAddress` type that carries one.
  - **Finding them all:** `grep -rn "callChain\[0\]\|callChain.at(-1)\|subscriberBinding\|CLIENT_GATEWAY\|callee?*\.instanceName" apps/nebula/src packages/nebula-auth/src` lists every site, for triage rather than as a tripwire, since it also matches comments.
- **Carried over, its reasons shifted — `packages/mesh/src/tab-id.ts`**, which keeps a tab's id across reloads.
  - **Today, for two reasons.** Each `{sub}.{tabId}` reserves a Gateway DO name for good, so a new id per reload would leak names. And a reload that comes back within the grace period keeps its subscriptions.
  - **Hosted, for one.** No name is reserved, but the id is how the host node knows which socket a Client already has: a reconnect under the same id closes the old socket, and within the grace period keeps its subscriptions.
- **Adapted — `NebulaDO`**, which `Universe`, `Galaxy` and `Star` extend. Its `onBeforeCall` checks passage through `requirePassage`, which fits a call addressed to the node itself but would refuse pushes its Clients should get (example 4).

**Missing**, in the order of the sections that answer them:

1. A server-side node that accepts a Client's upgrade, holds its socket and dispatches its frames (§ *A server-side node hosts Clients with no code of its own*).
2. An upgrade at `/gateway/{id}` that the Worker routes to the host node its hostname spells, refused when the token's `aud` is not that scope or the id is not one segment starting with the token's `sub` (§ *The trust boundary*).
3. A track for a Client's upgrade in `.claude/rules/raw-comm.md` § *What reaches a Durable Object's `fetch`*, and in `npm run audit:do-http` (§ *The trust boundary*).
4. A Client address that names its host node, everywhere one is stored or read (the inventory above), with the subscription tables keyed on it (§ *What the examples settle*).
5. A sender's framework that resolves a Client's address to its host node. Today `resolveStub` calls `getDOStub(env[binding], instance)`, which for `acme.crm.tenant1/alice.9f2c41aa` would address an empty object.
6. A host node whose two doors branch on the address called (§ *How a host node checks a call*).
7. A host node that pushes to a Client it hosts with a `ws.send`, without an RPC to itself.
8. A call from a Client to its own host node that runs in place rather than as an RPC to itself.
9. A teardown that tells the Clients it hosts that their scope is gone (§ *What deleting a scope does to the Clients it hosts*).
10. The `NebulaClientGateway` class retired: its export kept with `"state": "deleted"`, because `test-nebula` is redeployed in place, and `apps/nebula/scripts/audit-migrations.mjs` updated for the class count and for a deleted export.

The design intent below works seven examples and states what they settle. Then come three mechanisms: how a host node checks a call, how it hosts Clients with no code of its own, and the trust boundary, with what mesh-calls handed over. Then four costs: where a new Galaxy is placed, what deleting a scope does, what a reset costs, and the load a host node carries. It ends on the guidance that changes.

## Design intent, constraints, and future state

### Worked examples

Alice is a member of the Star `acme.crm.tenant1`, on its page, and her Client's address is `STAR/acme.crm.tenant1/alice.9f2c41aa`. Bob's public profile lives in the Profile `bob-profile` (a UUID too), and Dana is another member on the same Star's page.

1. **A call to the host node itself.** Alice saves an order: `resources.transaction(…)` on her Star.
   - **Today:** Client → Gateway → Star, then the Star fires the result back to the Gateway, which writes it to her socket. Two RPCs.
   - **Hosted:** Client → Star, which runs the call in place and answers on her socket. No RPC.
   - **Checked by** the Star's `onBeforeCall`: passage from her `aud`, `acme.crm.tenant1`, into `acme.crm.tenant1`.
2. **A call to another server-side node.** Alice reads the Galaxy `acme.crm`, which her `aud` has passage into because upward is free.
   - **Today:** Client → Gateway → Galaxy, and the result comes back through the Gateway.
   - **Hosted:** Client → Star → Galaxy, and the Galaxy fires the result to her address, which lands at the Star and goes down her socket. Same hops as today.
   - **Checked by** the Galaxy's own `onBeforeCall`, as today. The Star builds the call's context from her socket and relays it without a check of its own (§ *How a host node checks a call*).
3. **A subscription on the host node.** Alice subscribes to an order on her Star.
   - **The row stores** her address. Today that is (`NEBULA_CLIENT_GATEWAY`, `alice.9f2c41aa`); hosted, it is `STAR/acme.crm.tenant1/alice.9f2c41aa`, which names the Star itself.
   - **A push** is then a `ws.send` on the socket with that tag, with no RPC, where today it is an RPC to her Gateway.
4. **A push from another node.** Alice subscribes to `bob-profile`, and her Galaxy has something to push to her too.
   - **The call** goes Client → Star → Profile, which stores her address in its row, as today.
   - **A push,** when Bob renames himself, goes Profile → Star → her socket. D12's check in the Star asks for her passage into the sender's scope; a Profile names no scope, so it passes. The Star's own `onBeforeCall` must not run on this push, since it would refuse it (§ *How a host node checks a call*).
   - **A push from the Galaxy `acme.crm`** passes D12 too, since her passage runs up into the Galaxy.
   - **A lateral push is refused.** If the Star `acme.crm.tenant2` sends to Alice's address, the call lands at her Star, and D12's check refuses it: `acme.crm.tenant1` has no passage into `acme.crm.tenant2`.
   - **No push reads the Registry.** The check reads only Alice's claims, verified at the upgrade and kept on her socket, and the sender's name. `hasPassageInto` computes the verdict from a token and a scope, as it does today in `NebulaClientGateway`.
5. **A persona.** Studio frames `manny--dev.crm.acme.lumenize.dev`. Manny's `sub` is a name-based UUID computed from that hostname (ADR-022), and his Client's address is `STAR/acme.crm.dev/manny.4d1e88b0`. The Worker maps the persona's hostname to that Star for the upgrade, the way the refresh already maps its `Origin`. Everything after that is examples 1–4.
6. **An impersonation child.** Alice, an admin, impersonates Carol from the same page. The child is a second Client on the same host node, with Carol's token, its own socket and the id mesh-calls' D7 gives a child: `STAR/acme.crm.tenant1/carol.9f2c41aa.acme-crm-tenant1`. Two Clients, two tags, one Star.
7. **A call from one Client to another.** Alice's Client calls Dana's.
   - **The call** reaches Dana's address the way a call to any Client does: Dana's host node, here the same Star, delivers it to her socket.
   - **Checked by** Dana's Client, which refuses it, as every Client refuses a call whose immediate caller is another Client (mesh-calls' D24). The host node runs no passage check for a Client sender, as the Gateway runs none today.

### What the examples settle

**A Client's address is one string, `{binding}/{scope}/{id}`** (Larry, 2026-10-05), such as `STAR/acme.crm.tenant1/alice.9f2c41aa`. The same string is the socket's tag and a subscription row's one column, and it goes wherever an address is stored or read: subscriber rows (examples 3 and 4), the return address a fire-back follows (example 2), and the Galaxy's preview-ready call.
- **In `lmz.call` terms** the Client's identity is the binding `STAR` and the instance name `acme.crm.tenant1/alice.9f2c41aa`. A sender's framework splits that instance name at the `/`, sends to the object the part before it names, and calls that object's doors as it would any node's (§ *How a host node checks a call*).
- **The binding is in it** even though a scope's depth names its binding today, one segment a `UNIVERSE`, two a `GALAXY`, three a `STAR`. Helper Durable Objects at the same scope under another binding are in view, and the string costs a few characters to stay ready for them.
- **It fits a tag.** A scope is at most three 30-character slugs, 92 characters with its dots. The longest id is an impersonation child's, at 138 characters with the longest scope, so the longest address, `STAR/` plus a scope, a `/` and that id, is 236. Cloudflare allows each tag 256 characters, and a socket 10 tags.
- **`/` separates the three parts,** since a binding, a slug, a UUID and a `tabId` never contain one.

**A Client's id has three jobs, and today's shape does all three.**
- **It is unique within its host node**, because it is the socket's tag, and a tag that two Clients shared would let one replace the other's socket.
- **It starts with its token's `sub`**, which is how the upgrade checks that a Client claims only its own identity.
- **It stays the same across a reload**, so a reconnect within the grace period finds its subscriptions.

**An impersonation child keeps D7's id,** `{subjectSub}.{parentTabId}.{scope with dashes}`, such as `carol.9f2c41aa.acme-crm-tenant1`. Its last segment now repeats the address's scope, but mesh-calls' D7 keeps the shape (Larry, 2026-09-30), and nothing forces a change: with the longest scope, the address still fits a tag under a binding of up to 24 characters.

**The subscription tables change shape.** `Subscriptions` keeps a `clientId` and a `subscriberBinding` and is keyed on `(kind, topic, clientId)`; the Profile's `Subscribers` keeps the same pair, keyed on `clientId`. Each pair becomes one column holding the address string, named for what it holds, such as `clientAddress`, and that column takes `clientId`'s place in the key. The rows need not survive the change: every Client re-subscribes after a deploy, because a reset host node has no grace period to report.

**Every page that runs a Client has a host node,** which is what lets one design cover them all:
- **Studio connects only on a scope's host.** `App.vue`'s `onMounted` returns before connecting when the page's `activeScope` is unset. The platform host runs no Client.
- **A persona's page has its `.dev` Star**, by ADR-022 § *A persona's host*.
- **A generated app runs on a Star's host.**
- **An impersonation child shares its parent's host node**, under its own id.

### How a host node checks a call

**A host node cannot check what arrives for its Clients with its own `onBeforeCall`.** In example 4 the Star `acme.crm.tenant1` receives a push from `bob-profile` addressed to Alice, and its `onBeforeCall` would refuse it: a Profile's chain carries no claims and no scope, so `requirePassage` has nothing to compute passage from. A push from the Galaxy fails the same way, since a chain the Galaxy starts has no passage down into the Star. Yet running no check would admit a push from `acme.crm.tenant2`, the lateral sender D12 exists to refuse.

**So each of its two doors branches on the address called** (D5). A sender calls a host node's request door or fire-back door exactly as it calls any node's, splitting the address at the `/` only to find the object. The door then reads `metadata.callee`, the address the sender was asked to call:
- **`STAR/acme.crm.tenant1`, the host node itself:** the door does what it does today.
- **`STAR/acme.crm.tenant1/alice.9f2c41aa`, a Client it hosts:** the door hands the message to `ClientGateway`, which runs D12's check on a call, then sends the call or answer down the socket with that tag. That branch runs nothing on the host node, so a continuation a Client wrote (mesh-calls' D11) never runs there.

**Which door is called still decides request or answer, as ADR-007 requires; the branch decides only whether a message runs here or goes down a socket.** `metadata.callee` is the address the sender's framework was asked to call, and no Client writes an envelope: the host node builds hers from her socket's verified attachment.

**Only a `/` now separates a Client's address from its host's, so four properties keep them apart:**
- **The branch reads only the `/`** in `metadata.callee.instanceName`, never the host's stamped name, which a teardown's `deleteAll()` can have erased.
- **It runs before the identity stamp,** so a message addressed to a Client never stamps a node's name. A node that composes `ClientGateway` hands it over unstamped, and one that composes none refuses it, so no Client address can brick a scope not yet created.
- **A hosted Client always has an id.** A composed `ClientGateway` accepts an upgrade only when the id is exactly one segment, so no Client is named by its host's bare scope, whose answers would take the host's own branch with the `@mesh()` check off.
- **A Client's call that runs in place passes the same request door as one that arrives by RPC:** `onBeforeCall` once, and the `@mesh()` check on.

| What arrives | Door, branch | Example | Checked by |
|---|---|---|---|
| A call to the host node itself | request, host | 1 | its own `onBeforeCall`, as today |
| A call to a Client it hosts, from a server-side node | request, Client | 4 | D12's check alone: the Client's passage into the sender's scope |
| A call to a Client it hosts, from another Client | request, Client | 7 | the receiving Client, which refuses it (mesh-calls' D24) |
| An answer to a call a Client it hosts made | fire-back, Client | 2 | nothing on the host node; the Client runs the answer with no `onBeforeCall` (mesh-calls' D27) and drops one it did not ask for (D21) |
| A Client's own frame, for another node | its socket | 2 | the destination, as today; the host node builds the call's context and relays it |

**A host node relays a Client's frame without checking passage first, as today's Gateway does.** A relay-time check was considered, so that no Client could make its host node the first to touch a name it has no passage into, such as `acme.crm2` before anyone creates it, and so fix where that object lives. It is not built, for three reasons (Larry, 2026-10-06):
- **It would refuse what the design needs.** `hasPassageInto` refuses a Profile and the facade, which name no scope, so it would refuse example 4's subscribe and every `client.scopes` call.
- **It would not stop the likely case.** A fellow Universe admin, the person most likely to touch a new name early, passes it by dominion.
- **Hosting does not create the problem.** A stranger's Gateway relays the same way today: the target refuses, but it has already been touched.

### What mesh-calls handed this file

- **D7, an impersonation child's id, survives** (Larry, 2026-10-06). Two children impersonating the same subject from one parent would share a tag, and the host node would replace one with the other, so a second live child must be refused, keyed on the tag (§ *What the examples settle*). mesh-calls parked that refusal and `impersonate()` has none yet, so Phase 5 builds it.
- **D17, a Web Lock on `tabId`, is not built here** (Larry, 2026-10-05: a "may"; 2026-10-06: not here). Its blocking reason, that a reload losing its lock would leak a Gateway name, goes with the Gateway. Two tabs sharing an id still replace each other's socket, with or without hosting, and the 50 ms duplicated-tab probe in `tab-id.ts` covers that.
- **D25's Gateway name check is moot for Nebula,** which binds no Gateway. What it protected is now the doors' branch for a Client (§ *How a host node checks a call*).
- **Persisting a held continuation on an alarm is not taken** (Larry, 2026-10-06). A host node that resets loses a continuation waiting on a Client's answer, so the sending node's handler never hears back; the Client re-subscribes when it reconnects (mesh-calls' D4), which is what recovers the state. Persisting it would cost a storage write for every push to every Client, one per chunk of a chat stream.
- **D3's and D20's Gateway wording** is taken up in § *What changes in standing guidance*.

### A server-side node hosts Clients with no code of its own

**The base class composes `ClientGateway` once, and `Universe`, `Galaxy` and `Star` add nothing.** It is `NebulaDO` (D4). The runtime delivers a socket's events to Durable Object methods by fixed names: the upgrade to `fetch`, then `webSocketMessage`, `webSocketClose` and `webSocketError`. Mesh delivers to a hosted Client through the same two doors, which branch on the address. So those methods and the branch have to exist on the class, and they are wired once, in the base class, rather than as a forwarding method per node type, the way a node's data plane arrives by composition (`.claude/rules/calibration.md` § 11).

⚠️ Design consideration (Larry, 2026-10-05), guidance for whoever builds Phase 2 rather than a decision (Larry, 2026-10-06): `ClientGateway` could hand out one object per Client from a factory that takes the Client's tag. That object would gather what today rests on a Gateway having one connection: the socket, the grace period, and the calls waiting on that Client's answer. Two things shape it:
- **It is rebuilt, never kept.** The host node can hibernate, so each event would rebuild the object from the tagged socket and its attachment, which is where `ClientGateway` already finds a Client's socket and claims. Its grace period and waiting calls live in memory only while the node stays resident, which mesh-calls' D23 holds it to by handing each wait to `ctx.waitUntil`.
- **It needs a name other than `Client`,** which this file uses for the browser-side instance.

### The trust boundary

**A Client still cannot name who it is or add to its chain.** `ClientGateway` builds every call's `callContext` from the socket's verified attachment. The decoding of a Client's bytes moves with it: `refuseContinuation` and `#handleIncomingCallResponse` each `postprocess` what a Client sent, as they do in a Gateway today. Hosting adds no decoding, but a defect in either now reaches every Client on the host node rather than one.

**The upgrade is accepted only when the token's `aud` is the scope the request's hostname spells,** with a persona's hostname mapped to its Star (example 5). ADR-022 already makes every real page's `aud` its hostname's scope, so no real page notices. Without it, anyone holding a token for any scope, which open Universe self-signup gives to anyone, could hold sockets on another tenant's Star and relay through it. Today the Worker checks no hostname, because the Gateway's name is the tab's own. Hosted, the Worker writes the binding and scope into the path from the hostname (D7), so a Client names only its id, and every refusal happens before routing, so a refused upgrade wakes no host node.

**The upgrade arrives at a mesh node's `fetch`,** which today hears only pages under `/_public/`, its own container, and nothing of our own code. The upgrade needs a track of its own, and its forward must strip every client-sent `x-lumenize-*` header, because mesh stamps a node's name from those headers. `ClientGateway.acceptUpgrade` decodes the token without verifying it, trusting the Worker that did, so `NebulaDO.fetch` hands it only a request under its registered `/gateway` prefix, never one it recognizes by an `Upgrade` header: the build-box's own dial-back to `/api` is a WebSocket upgrade carrying a Bearer, from a container running code a user-developer wrote.

### Where a new Galaxy is placed

**A Galaxy created from the account page lands beside its Universe, and that is accepted** (D3). Bob, an admin of `acme`, creates the app `crm` on `acme.lumenize.dev`.
- **Today** his call goes through his Gateway, which the Worker at his PoP placed near him. The facade runs in the Gateway's colo, so `createGalaxy`'s wipe, its first touch of `acme.crm`, places the app near Bob.
- **Hosted,** the same call goes through the Universe's own object, and the facade runs in that object's colo. Measured, 33 of 36 objects first touched by an object's call landed in the caller's own colo, and the rest one colo over ([experiments/do-placement-probe/RESULTS.md](../experiments/do-placement-probe/RESULTS.md)). So `acme.crm` and its `.dev` Star land beside `acme`, and a wipe, a reset or an eviction never moves them.

**Beside the Universe is nearly always where a first touch by the creator would put it anyway** (Larry, 2026-10-06):
- **Most Galaxies are created by the Universe's founder,** 90 to 99 percent in Larry's estimate, and the first is created with the Universe itself, by the HTTP claim at the founder's own PoP. Only a founder away from home, or a second admin elsewhere, sees a difference.
- **A Galaxy's people are mostly its user-developers,** who are most likely near the founder. Its tenants reach it for page loads, which browser caching softens.
- **What must sit near its users is a Star, and hosting moves no Star.** A tenant Star is founded by an HTTP route at its founder's own PoP. `createGalaxy` is the only relayed call that founds a scope, and the only Star it founds is the `.dev` Star, whose users are the user-developers.
- **Cloudflare has read replication for Durable Objects on its backlog,** which would soften a far Galaxy for its readers.

**So nothing changes in creation.** The wipe and the Galaxy's own certificate machine stay as they are.

### What deleting a scope does to the Clients it hosts

**Today Studio deletes an app from the app's own page, and the answer arrives because the deleter's Gateway outlives the app.** Alice opens the app's settings on `crm.acme.lumenize.dev` and confirms. `ConfirmDelete` awaits `scopes.delete('acme.crm')`, the facade's `executeScopeDeletion` tears down the Galaxy and every Star under it, and `onAppDeleted` takes her to the account page.

**Hosted, the deleter's socket is on the node being deleted.**
- **Her answer is lost.** `NebulaDO.teardown` ends in `deleteAll()` and `ctx.abort('scope-deleted')`, which drops every socket on the Galaxy. The facade's answer then goes to `GALAXY/acme.crm/alice.9f2c41aa`, which builds a fresh object at the deleted name and finds no socket and no grace period there. `ConfirmDelete` waits out its timeout.
- **Every Client on the deleted scopes reconnects,** and each upgrade builds a deleted scope's object again, since its members' tokens are still live.

**So a teardown tells the Clients it hosts that their scope is gone** (D6):
- **Before its `deleteAll()`,** `NebulaDO.teardown` closes every socket it hosts with a close code of its own meaning the scope was deleted. It lets the close frames go out before the abort, the way a write must land before one (`.claude/rules/durable-objects.md`).
- **A Client closed with that code does not reconnect.** It rejects its pending calls with an error naming the deletion and tells its page, which leaves for the account page or Home, as `onAppDeleted` does.
- **A pending delete of that scope counts as done,** so `ConfirmDelete` treats that error as success.
- **The facade's answer still builds an empty object at the deleted name,** as any call to that name does today. The orphan-sweep row in `tasks/backlog.md` covers what such objects accumulate.

### What a reset costs

**When a host node resets, every Client on it reconnects together,** each socket closing with code 1006.
- **What triggers it.** Cloudflare's runtime reset objects that kept running hot JavaScript in a slow state: 6 of 16 fresh instances ran a JavaScript loop about 10× slower, and sustained work in that state ended in a reset 13–50 s in ([experiments/do-socket-drop-probe/RESULTS.md](../experiments/do-socket-drop-probe/RESULTS.md)). Larry expects Cloudflare to make that rarer, not to end it, and an exception that breaks the object, the memory limit and a deploy reset it too.
- **What a Client loses.** The answer to every call it had in flight on the host node, whether the call ran there or was relayed. A relayed call's answer still reaches the Client if it lands after the Client reconnects, since the Client keeps its pending calls across a reconnect; one that lands sooner finds no socket and no grace period on the rebuilt host node, and is dropped.
- **What it waits for.** Each lost call waits out its 30 s timeout. A reset of a call's target loses the same answers today, since a Gateway acks a call before the target runs it; what hosting adds is that a host node's reset reaches every Client on it at once. Subscriptions come back as § *What the examples settle* says, with `subscriptionRequired: true` (mesh-calls' D4).
- **Failing pending calls at once was considered and is not built** (Larry, 2026-10-06). The boot id it would compare is minted at construction, so it changes on every wake from hibernation as well as on a reset, and a Client would reject relayed calls whose answers were still coming.
- ⚠️ Design consideration: a write whose `callAsync` timed out may or may not have committed. Re-issuing it under the same `newETag` is safe (ADR-005), but nothing here builds that.

### The load a host node carries

**A Star holds every connected user's socket and relays their other calls.** Those go to Profiles and the facade. The largest relay load in view, an estimate rather than a measurement, is a Client subscribing to about half a dozen Profiles: a few calls per page load and a push when a profile changes.
- **The ceiling does not move.** At a Star transaction's weight the ceiling is set by the transaction's own work, the same as behind Gateways, so hosting neither raises nor lowers how many writes a Star absorbs.
- **Where to watch.** The reset above follows sustained hot JavaScript, and two places run it on a host node: the codegen loop, `runCodegenLoop`, in the Galaxy's own Durable Object, and generated validators on every Star write. A Galaxy's heaviest work, the compiles, runs in its container (`ontology-compile.ts`).

### What changes in standing guidance

**A Client and its server-side half together are the equivalent of a server-side node; the half is composed into the host node, which is a node in its own right.** That sentence succeeds mesh-calls' D20, which says the same of a Client and its Gateway. The files below say otherwise today.

| File | Sections | Change | Lands |
|---|---|---|---|
| `docs/adr/007-shared-node-security-core.md` | § *Decision*: "No node type accepts its own application WebSocket"; "JWT verified once, at the Gateway trust boundary"; "One gated path, selected by address not content"; the identity-stamp clause; "the guard covers the mesh path only"; the **Evidence** line and the client-divergence paragraph, both naming the Gateway | Reword: a node hosts its Clients' sockets by composition; the token is verified once, at the edge Worker, before the upgrade; on a host node each door branches on the address called, and the branch for a Client runs nothing on the host node and stamps no identity; a hosted Client's frames are on the mesh path | Phase 1 |
| `docs/adr/003-continuation-messaging.md` | § *Context*'s example flow; the early-ack sentence and "Delivery re-resolves" in § *When awaiting is OK* | Reword: delivery re-resolves to the Client's current socket on its host node, which holds a wait for the Client's answer for at most 30 s under `ctx.waitUntil` | Phase 1 |
| `docs/adr/012-global-profile-visibility.md` | each mention of the Gateway's authN as the only check | Reword: the mesh admits no anonymous caller, since its only way in from outside is a Client's authenticated connection | Phase 1 |
| `docs/adr/015-passage-and-dominion.md` | the call-to-a-client bullet | Reword: the host node checks it | Phase 1 |
| `docs/vision/auth.md` | § *Lumenize Nebula mesh*; § *The layers a call passes*, M3 and M4 included; § *How the claims travel*; § *Founding a Star*; the facade paragraph's per-`sub` limit; the `/pictures` route's "through the Gateway" | Rewrite to the sentence above; § *Founding a Star* keeps the claim flow and moves the placement mechanism to `durable-objects.md` | Phase 1 |
| `docs/vision/_ai-security.md` | the attribution paragraph: a client's `instanceName` begins with its `sub`, and the Gateway builds `callChain[0]` and keeps what a client supplied past it | Reword: the host node builds it | Phase 1 |
| `.claude/rules/durable-objects.md` | a new § *A named object is placed by the first code that touches it, for good* | Takes the placement mechanism from `auth.md`, with `experiments/do-placement-probe`'s measurements and D3's relayed Galaxy | Phase 1 |
| `.claude/rules/security.md` | the "client → Gateway → DO" example; "the Gateway verifies a stateless JWT" | Reword | Phase 1 |
| `.claude/rules/mesh.md` | § *`LumenizeClientGateway` is the server-side half of a Client*; § *A client's `instanceName` MUST start with its `sub`*; § *A broadcast target's `bindingName` comes from a source the client cannot write*; § *Nebula platform code never drops to raw primitives*; § *Node identity is stamped on every first-contact entry (not just mesh calls)* | Rewrite for the host node and the trust boundary as built, and say nothing about when plain Mesh would use a per-Client DO, which the package merge would only unlearn | Phase 5 |
| `.claude/rules/workers-projects.md` | the Gateway as one of `mesh`'s raw internals | Reword: `ClientGateway` is the raw internal, composed by `NebulaDO` (D4) | Phase 4 |
| `.claude/rules/raw-comm.md` | § *What reaches a Durable Object's `fetch`*; the Mesh-world note that app DOs never accept their own sockets; the line naming the `/gateway/` upgrade to the client Gateway | Add the upgrade's track in Phase 4, beside the Gateway's; drop the Gateway's in Phase 5 | Phases 4, 5 |
| `scripts/audit-do-http.mjs` | its header's list of forwards into a node's `fetch` | Add the upgrade's forward | Phase 4 |
| `.claude/rules/testing.md` | the integration path Client → Worker → auth hooks → Gateway → DO; the `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` instructions; the sentence saying `NebulaClientConfig` omits only `refresh` and `gatewayBindingName` | Rewrite for the host node | Phase 5 |
| `.claude/rules/live-scenarios.md` | "the Gateway stamps the upgrade's origin" | Reword | Phase 5 |
| `packages/mesh/src/tab-id.ts` | the JSDoc calling a storage-less Gateway load-bearing | Rewrite for the tag | Phase 5 |
| `apps/nebula/src/nebula-do.ts`, `packages/mesh/src/lmz-api.ts` | `claimsForPassage`'s JSDoc, "a Gateway under one can accept no socket"; the comment beside `startedHere` | State the invariant: a hosted Client's instance name always contains a `/` | Phase 5 |
| `website/docs/nebula/auth-flows.md`, `website/docs/nebula/nebula-client.md` | each line this task makes false, such as "own WebSocket, own Gateway instance", then regenerate `apps/nebula/src/platform-embed.ts` | Rewrite only those lines: Studio's model reads these every turn | Phase 5 |

**How the list was made, and when it lands:**
- **The inventory** is `grep -il gateway docs/adr docs/vision .claude/rules`, plus the source and website files above. Every hit not listed mentions Cloudflare's AI Gateway, a dated incident, or a gateway in general.
- **The Phase 1 rows land first**, each with a *Today's code differs* block, which mirrors mesh-calls' D18. Every other row lands in the phase that makes it true, so a `/build-task` verifier never judges a phase against guidance it has already made false.
- **Each file keeps its own word** for a door: ADR-007's "entry", `mesh.md`'s and `auth.md`'s "door".
- **`website/docs/mesh/gateway.mdx` stays as it is** (Larry, 2026-10-04). The website docs rewrite waits until this task lands, and may be a task file of its own (Larry, 2026-10-06). The two `website/docs/nebula` rows are the exception (Larry, 2026-10-06): Studio's model reads them every turn, so the phase that makes a line false rewrites just that line and regenerates the bundle, with no wider cleanup.

### Constraints

- **ADR-003:** no node holds a reply open across a hop. A host node waiting on a Client's answer holds the wait for at most 30 s under `ctx.waitUntil`, loses it on a reset, and recovers through the Client's re-subscribe; the ADR-003 row names that bounded wait.
- **ADR-007:** this task rewords it (§ *What changes in standing guidance*). Its narrow core, composed by every node, binds as it stands, and so does its rule that which door is called decides request or answer (§ *How a host node checks a call*).
- **ADR-015 and ADR-022:** a Client's `aud` is its page's scope, and passage and dominion read it.
- **ADR-023:** a Client's upgrade is page traffic. It reaches no operation only our own code may invoke.
- **mesh-calls' D25:** a scope-shaped name belongs only to an object that checks passage. A `NebulaDO` host node does.
- **mesh-calls' D10:** a claimless chain whose `callChain[0]` names a scope acts as a plain member of that scope (`claimsForPassage` in `apps/nebula/src/nebula-do.ts`). A Client never reads as one: every call it makes carries its claims, and its instance name, `acme.crm.tenant1/alice.9f2c41aa`, contains a `/` that `parseId` rejects. A composed `ClientGateway` refuses an upgrade with no id, so a Client's instance name is never its host node's bare scope, which a claimless chain would read as the Star itself.
- **`.claude/rules/raw-comm.md` § *What reaches a Durable Object's `fetch`*:** the fourth track, and the audit that proves it.
- **`.claude/rules/live.md`:** the `/live` scenario is written first.

### Future state

- **A customer's own domain** (ADR-022 § *A customer's own domain*) already turns a host into a scope; its Clients connect to that scope's node like any other.
- **A helper Durable Object at a scope** can host Clients under its own binding, which is the seam D1's binding slot keeps open.
- ⚠️ Design consideration: ADR-018's single-object ceiling and Cloudflare's practical sockets-per-object cap bound the largest tenant a Star can host. Cloudflare's docs name no number beyond "thousands of clients per instance". Pre-alpha tenants are far below either.

### Open questions

1. ✅ **Decided — `NebulaDO` composes `ClientGateway`** (D4).
2. ✅ **Decided — a Galaxy created through its Universe lands beside it** (D3).
3. ✅ **Moot — a host node adds no doors** (D5).

## Decisions

Started during the Pass 1 gate, holding only what is settled. Each row is Larry's call.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **A Client's address is one string, `{binding}/{scope}/{id}`, used as its socket's tag and stored in one column** (Larry, 2026-10-05). § *What the examples settle* carries the shape and its length. | **Deriving the host node from the Client's `aud` instead of storing it** — it saves a column, but every reader would need the call's claims, and a chain a node starts carries none (mesh-calls' D10). **Leaving the binding out, since a scope's depth names it today** — § *What the examples settle* says why it stays in (Larry, 2026-10-05). **Storing the binding, the scope and the id in separate columns** — three values to keep in step where one string does, and a tag can hold only one string anyway. |
| D2 | **Build it in pre-alpha, right after mesh-calls lands** (Larry, 2026-10-05, for pre-alpha; the timing is the author's call, which Larry deferred to). mesh-calls moves the same code and changes the same wire, so building next moves `ClientGateway` while its design is fresh. And it lands before personas' phases, whose Clients connect to host nodes (example 5), so no persona scenario is written twice. | **Keeping a Gateway per Client** — every goal above is a cost of it. **Building after launch** — the change would then reach users' apps, and every Client-facing scenario written in between would be written again. |
| D3 | **A Galaxy created through its Universe lands beside it, and nothing is built to place it elsewhere** (Larry, 2026-10-06, reversing his 2026-10-05 decision to have the creator's own request place it). § *Where a new Galaxy is placed* carries the reasons and the measurements. | **Placing it by its creator's own request** — a relayed `createGalaxy` would touch neither object, a certificate object per Galaxy would order its pack, and creation would stop wiping. That buys a better place for perhaps 1 to 10 percent of Galaxies, at the cost of one more Durable Object class, a re-created name able to carry its earlier life's data until public signup, and a minute or two in which anyone could place a waiting Galaxy. **`createGalaxy` as an HTTP request the Worker at the creator's PoP serves** — only a route that stops at the Worker places the Galaxy there, while the HTTP bridge Larry wants for MCP and HTTP Resources reaches a Durable Object's `fetch`, so the route would be a one-off that bridge replaces. It would also rewrite `auth.md`'s "an access token authenticates a mesh call". **A `locationHint`** — it names a region, and measured, a region spans cities thousands of kilometres apart: `apac` placed objects in Singapore, Tokyo and Hong Kong, and `oc` in Brisbane, Sydney and Melbourne. It stays on hold as the lever if a far Galaxy ever matters. **Creating objects in bulk and pooling them by where they land** — works only for unnamed objects, and a Galaxy is named. |
| D4 | **`NebulaDO` composes `ClientGateway`, and Nebula stops binding `LumenizeClientGateway`** (Larry, 2026-10-06). The package merge that follows folds `NebulaDO` into `LumenizeDO` and deletes `LumenizeClientGateway`, since every page that runs a Client then has a host node (§ *What the examples settle*). This task deletes nothing from `packages/mesh`. The sender's side lands in Mesh core either way: resolving `{binding}/{scope}/{id}` in `lmz-api.ts`, the doors' branch on a Client's address, and running a Client's call in place. `ClientGateway` stays in Mesh, the Client's trusted server-side half, and the browser-side Client stays untrusted. | **Mesh composes it, in `LumenizeDO`, now** — it would serve a Mesh app whose Clients talk to one node, such as a room, but `@lumenize/mesh` 1.0-alpha is built on the Universe/Galaxy/Star tree, so the merge makes `NebulaDO` and `LumenizeDO` one class anyway. **Keeping `LumenizeClientGateway` as Mesh's way to host a Client** — it rested on Mesh keeping an audience with no scope nodes, which the merge ends. |
| D5 | **A host node's two doors branch on the address called, and a host node adds no doors** (Larry, 2026-10-06). A sender calls a host node exactly as it calls any node; the request door and the fire-back door each read `metadata.callee`, and an address naming a hosted Client goes to `ClientGateway`, which runs nothing on the host node. The host node is the one node that is both an intermediary and a receiver, so it is the one place that needs to know. | **Four RPC methods, the sender picking one by the address** — every sender would have to know its receiver is a Client, which today none does. It buys no safety: both read the same address, and both would run a Client's answer on the host node if a bug dropped the `/alice.9f2c41aa` part. |
| D6 | **Before its `deleteAll()`, a deletion's teardown closes every socket its node hosts with a close code meaning the scope was deleted. A Client closed with it does not reconnect, rejects its pending calls with an error naming the deletion, and its page leaves; a pending delete of that scope counts as done** (Larry, 2026-10-06). Deleting an app from its own page keeps working, for the deleter and for every member. | **Moving the delete to the account page** — it fixes only the deleter, since every member still reconnects into an empty object at the deleted name, and a Galaxy admin holding nothing at the account could no longer delete their own app. **Accepting it** — the deleter sees a false error for a delete that succeeded, and members sit in an empty app until their tokens lapse. |
| D7 | **A Client upgrades at `/gateway/{id}`, naming only its id; the Worker writes the binding and scope into the path from the hostname and hands it to `routeDORequest`** (Larry, 2026-10-06). The host is the scope (ADR-021), so a Client cannot name a node other than its page's host, and keeps `{sub}.{tabId}` as its id. The `/gateway` prefix stays: a scope host's other paths belong to the app's pages (ADR-017), and the host node's `fetch` dispatches on it. | **The Client writing `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa`** — the Worker would have to check a path it could have written, the Client would prefix its id with its host and break `#followSub` and `parentTabIdFrom`, and `NebulaClient` learns its scope from its first token, too late for its constructor. **Forwarding with headers, as `forwardPage` does** — it would drop `routeDORequest`, which Larry wants as the bridge that later carries CORS and MCP and HTTP Resources. |

## Phases

Each phase lands as its own commit, and every suite stays green between them. Phases 2–4 build hosting beside today's Gateways, Phase 4 opening the hosted route to real logins, Phase 5 moves every Nebula page onto it, and Phase 6 runs the deployed pass. Every phase from 2 on ends with `grep -nE '\b[SD][0-9]+\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b'` over its changed source finding no handle from this file (`workflow.md` § *Referring to things across files*).

### Phase 1 — The accepted documents describe a Client hosted by its scope's node

The rows of § *What changes in standing guidance* that land in Phase 1 are rewritten to the hosted model. Each changed section carries a *Today's code differs* block naming the phase that makes it true, as mesh-calls' D18 did. None says when plain Mesh would use a per-Client Durable Object (D4). Larry reviews this phase's diff, since it is ADR and vision prose.

**Success criteria:**

- Every Phase 1 row's section places a Client's socket on its host node. Where the new wording is not yet true, the section carries a *Today's code differs* block that Phase 6 deletes; wording that holds today, because today's host node is the Client's own Gateway, needs none. *Mutation:* leave one row's section unedited; Phase 6's grep finds it.
- `node scripts/check-prose.mjs` passes on every file the phase touches.

### Phase 2 — Mesh can host a Client on any node that composes `ClientGateway`

Mesh core learns the address D1 settles and the branch D5 settles, while `LumenizeClientGateway` keeps working unchanged:
- **One split, exported.** The function that turns `acme.crm.tenant1/alice.9f2c41aa` into the object `acme.crm.tenant1` is exported beside `resolveStub`, with its inverse that joins `callChain[0]` into an address, on a client-safe subpath that `apps/nebula` and `packages/nebula-auth` both import. `resolveStub` and `ClientGateway.#handleClientCall`, which builds its own stub today, both use it.
- **Both doors branch on `metadata.callee`,** keeping the four properties in § *How a host node checks a call*. A Client's call to a peer on the same host goes to `ClientGateway.executeOperation` in place, where the receiving Client refuses it (mesh-calls' D24).
- **`ClientGateway` takes the Client's id from the path.** Behind a Worker that rewrote it, the path is `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa`; the Client's instance name is the host's instance name, a `/`, and the one segment after it. A composed `ClientGateway` refuses an empty, multi-segment, or over-256-character result; only `LumenizeClientGateway` opts into the no-id form.
- **A host node and its Clients reach each other with no RPC, and with no check skipped.** A hosted Client's call to its own host runs through that host's `executeEnvelope` with the `@mesh()` check on and the context built from the socket attachment, never `__localChainExecutor`. A push to a Client the node hosts, and the answer to a hosted Client's in-place call, go to `ClientGateway` directly.
- **`LumenizeClient` can upgrade at `/gateway/{instanceName}`** when its config says its Worker derives the host (D7), keeping `{sub}.{tabId}` as its id, so `#followSub` and `parentTabIdFrom` are untouched.

`ClientGateway`'s internal shape is the builder's; § *A server-side node hosts Clients with no code of its own* carries Larry's factory note as guidance.

**Success criteria** (vitest-plugin in `packages/mesh`, with a test Durable Object that composes `ClientGateway`, since no Nebula route reaches a host node until Phase 4):

- Two Clients on one host are each reached at their own address and no other. *Mutation:* make `resolveStub` pass the whole instance name to `getDOStub`.
- The answer to a hosted Client's call to another node reaches that Client, and the host runs no chain for it. *Mutation:* send the fire-back door's Client branch to the host's own `executeEnvelope`; the host runs the Client's handler.
- A hosted Client's in-place call to an undecorated host member is refused, a guarded `@mesh()` method refuses it with the guard's message, and `onBeforeCall` runs exactly once. *Mutation:* run the chain through `__localChainExecutor`, or with the decorator check off.
- The host's push to its own Client, the Client's call to its host, and that call's answer invoke neither door over RPC, asserted from the debug sink. *Mutation:* route any of the three through a stub.
- On a never-stamped object that composes `ClientGateway`, one that composes none, and a host whose `teardown` just ran, a message addressed to `{name}/{id}` leaves the name unstamped, and a following call to `{name}` succeeds. *Mutation:* branch after the stamp, or decide "a Client it hosts" by comparing against `this.lmz.instanceName`.
- An upgrade whose path has no id, two id segments, or an id that makes the tag longer than 256 characters is refused. *Mutation:* accept the empty id; a fire-back to that Client runs an undecorated member on the host.
- A Client's call to a second Client, on the same host and on another, is refused with "Direct client-to-client calls are disabled by default". *Mutation:* keep `#handleClientCall`'s own `getDOStub`.
- With a call pending to Dana, Alice reconnects under her own id; Alice never receives Dana's frame, and Dana receives it when she answers again. *Mutation:* drop `#resendPendingCalls`' `instanceName` filter.
- `parse-id.test.ts` gains rows for `acme/…`, `acme.crm/…`, `acme.crm.tenant1/…` and the child form, each asserting `parseId` throws.
- Every test under `packages/mesh/test` that uses `LumenizeClientGateway` stays green without edits, and `drive.ts all --fast` passes. *Mutation:* build the Client's instance name from an empty rest of the path; the Gateway's Client gains a trailing `/`.

### Phase 3 — Every reader and store of a Client's address uses the one string

A Client's address becomes the exported join of `callChain[0]`'s binding and instance name everywhere Nebula reads or stores one: Resources' `#caller()`, which stops taking the binding from `callChain.at(-1)`, the Galaxy's `#clientOrigin()`, `Profile.subscribe`, the Galaxy's preview-ready call and the `DroppedAddress` type. The reapers that name their victim from `callContext.callee`, Resources' `gone()` and the reapers using it, and the Profile's `onProfileBroadcastResult`, rebuild it with the same join. `Subscriptions` and the Profile's `Subscribers` replace `clientId` and `subscriberBinding` with one `clientAddress` column, which takes `clientId`'s place in the key. `Subscriptions` appends a new migration that drops and recreates its table; the Profile drops its table only while `PRAGMA table_info` still shows `clientId`. The rows are disposable (§ *What the examples settle*), and today's Gateway addresses take the same form, `NEBULA_CLIENT_GATEWAY/alice.9f2c41aa`, so this lands while every page is still on its Gateway. The triage grep in § *Context and current state* gains `callee`, and is run once against an unconverted reaper to show it prints.

**Success criteria:**

- Subscribe, push and reap behave as before, in the existing suites and in `drive.ts all --fast`, with each row holding the address string. *Mutation:* store only the id; a push to the row resolves no object.
- For both Resources and the Profile, the row a reaper deletes is the exact address the failed push went to, and `nebula-client-disconnect-cleanup.test.ts` compares the full address. *Mutation:* delete by the bare id.
- Seeded with each table's old shape, a node constructed once has the new column and no old rows; constructed a second time, it keeps the rows written in between. *Mutation:* an unguarded drop, or a reused migration id.
- The grep finds no site that builds a Client's address but the join, and the join's test covers a chain with a second hop. *Mutation:* take the binding from `callChain.at(-1)`.

### Phase 4 — A scope's node hosts the Clients on its pages

`NebulaDO` composes `ClientGateway` (D4), and the Worker opens the hosted route beside the Gateway's, while `NebulaClient` still connects to its Gateway:
- **The hooks.** `onBeforeAccept` refuses an id that does not start with the token's `sub`; `onBeforeCallToClient` carries D12's check over from `NebulaClientGateway`; `onBeforeCallToMesh` builds the context as the Gateway's does.
- **The upgrade's track.** `/gateway` joins `NebulaDO`'s `HTTP_PREFIXES`, and its `fetch` hands a request under it to `ClientGateway` after `__initFromHeaders`, never one it recognizes by its `Upgrade` header. `webSocketMessage`, `webSocketClose` and `webSocketError` are wired once, in `NebulaDO`.
- **The route (D7).** `/gateway/{id}` on a scope's host: the Worker strips client-sent `x-lumenize-*` headers, refuses unless the id is one segment starting with the token's `sub` and the token's `aud` is the scope the hostname spells, with a persona's host mapped to its `.dev` Star, then rewrites the path and hands it to `routeDORequest`. Every refusal happens before routing.
- **Teardown (D6).** A deletion's teardown closes every socket it hosts with 4410, after HTTP's 410 Gone, beside 4401, 4408 and 4409, and yields so the close frames go out before the abort. A creation's teardown sends no close of its own: its abort drops a socket as any reset does, and the Client reconnects.
- **The guidance it makes true.** `raw-comm.md` § *What reaches a Durable Object's `fetch`* gains the fourth track and drops "app/platform DOs never accept their own" sockets, naming Phase 5 as where the Gateway's route leaves; `workers-projects.md` names `ClientGateway`; `audit-do-http.mjs`'s header lists the forward.

**Success criteria** (`/live`, written first, driving a `LumenizeClient` that upgrades at `/gateway/{id}` with a real login's token, unless a limb says otherwise):

- An upgrade is refused, and no host node starts, as its `onStart` marker shows, for each operand alone: a token whose `aud` is not the hostname's scope, an id not starting with the token's `sub`, a missing id, and two id segments. `gateway-one-binding` inverts into this scenario. *Mutation:* drop each operand's check in turn, then make the checks after `routeDORequest` builds the stub; the marker fires.
- On a persona's host, the same upgrade reaches the `.dev` Star.
- A push from a Profile and one from the Galaxy above reach a hosted Client, though the Star's own `onBeforeCall` would refuse both chains. *Mutation:* run `onBeforeCall` in the Client branch.
- A push from the Star `acme.crm.tenant2` to a Client on `acme.crm.tenant1` is refused at the host node with `noPassageMessage`'s wording. This limb is vitest-plugin for good, and the test says why: no production path makes one Star push to another's member. `client-gateway-passage.test.ts` and `client-gateway-passage-delivery.test.ts` retarget onto it. *Mutation:* drop D12's check from `onBeforeCallToClient`.
- Deleting the hosted Client's scope closes its socket with 4410, and wiping it at creation drops it without 4410, after which the Client reconnects and is told `subscriptionRequired: true`. *Mutation:* drop the close before `deleteAll()`, or send 4410 whatever the cause.
- `npm run audit:do-http` passes. *Mutation:* dispatch on an unregistered prefix; the audit reds.
- `drive.ts all` passes with its container scenarios, whose build-box dials back to `/api` with an upgrade carrying a Bearer. *Mutation:* dispatch on the `Upgrade` header; `build-box` reds.

### Phase 5 — Every Nebula page connects to its scope's node

The switch, in one commit:
- **The Client.** `NebulaClient` upgrades at `/gateway/{id}` (D7) and needs no knowledge of its host. An impersonation child connects to the same host node under D7's id, and `impersonate()` refuses, before minting, when `childrenOf` the parent holds a live child at the same address: mesh-calls parked that refusal, so it is built here.
- **Deletion (D6).** `LumenizeClient`'s `#handleClose` treats 4410 as final: no reconnect, and every pending call rejected with an error naming the deletion. `createNebulaClient`'s default leaves a generated app's page for Home. Studio leaves for the account page when an app is deleted, and for Home when the account itself is, and `ConfirmDelete` treats that error as success.
- **The Gateway's retirement.** `NEBULA_CLIENT_GATEWAY` is unbound, and `NebulaClientGateway`'s export stays with `"state": "deleted"`. `apps/nebula/scripts/audit-migrations.mjs` excludes a deleted export from its counts and its re-export check, and refuses one still bound, with selftest cases for both.
- **The tests the Gateway named.** `forged-continuation` gains a limb whose forger is hosted on a `.dev` Star and names `onOntologyPulled`. `gateway-stamps-the-chain`, `client-sender-passage` and `late-answer-dropped` move to hosted addresses, `gateway-abuse.test.ts` retargets with titles that say the host node, and every other test naming the Gateway's binding moves to a hosted address.
- **The guidance it makes true.** The rows of § *What changes in standing guidance* that land in Phase 5, and the regenerated `apps/nebula/src/platform-embed.ts`.

**Success criteria** (`/live`, written first):

- On `tenant1.crm.acme.lumenize.dev`, Alice saves an order and reads the Galaxy, and both answers arrive; the save runs in place on the Star, as its log line says. `mesh-entry-reach`, `four-party-chat` and `push-survives-token-lapse`'s second limb witness in-place admission. *Mutation:* send the Client's call to its host by RPC.
- A chat-stream chunk reaches a Studio Client by `ws.send`, as the Galaxy's log shows, never through `__executeOperation`. *Mutation:* route a hosted push through a stub.
- With Alice and Dana on one Star, Alice reconnects under the same id, and every later push reaches each on their own socket; with Dana's tab paused by CDP `Debugger.pause`, her pending push never reaches Alice. *Mutation:* close every socket at accept rather than those holding the tag.
- Bob renames himself, and Alice's page shows it. *Mutation:* run `onBeforeCall` in the Client branch.
- `forged-continuation`'s hosted limb is refused. *Mutation:* send the fire-back door's Client branch to `executeEnvelope`.
- Alice deletes `crm` from its own Studio page and lands on the account page, and `[data-testid=confirm-delete-error]` never renders between the click and the navigation; Dana, on a tenant page of `crm`, is told the app is gone and does not reconnect. An account deleted from its own page lands on Home. *Mutation:* let the Client reconnect on 4410; Dana's page rebuilds an empty Star, as its construction log shows. Remove the success mapping; the error renders. Always navigate to the account page; the account limb reds.
- An impersonation child connects to its parent's host node, and a second child of the same subject from that parent is refused. *Mutation:* drop the check; the second child closes the first with 4409.
- `npm run audit:migrations` and `npm run audit:migrations:selftest` pass. *Mutation:* count the deleted export; the audit reds before any deploy.
- `drive.ts all` passes, container scenarios included, and `npm test` passes in every workspace, the platform embed's drift check included.

### Phase 6 — The deployed pass, and the last of the guidance

- **Phase 1's *Today's code differs* blocks** are deleted.
- **The backlog rows** in § *Relationships* are edited and added.
- **The deployed pass:** `bash apps/nebula/scripts/deploy-test.sh`, then `drive.ts all` with `HARNESS_TARGET_URL` set to `test-nebula`.

**Success criteria:**

- `grep -n Gateway` over the files of the rows that land in Phases 4 and 5 finds only lines true as built: `ClientGateway`, `LumenizeClientGateway` as Mesh's class until the merge, Cloudflare's AI Gateway, and dated history. *Mutation:* leave one row unedited.
- The deploy to `test-nebula` succeeds with `NEBULA_CLIENT_GATEWAY` unbound, and the deployed sweep passes.
- **A deployed-only scenario:** Alice and Dana hold sockets on a Star, the Worker is redeployed unchanged, and each Client's connection reports `subscriptionRequired: true` and calls `onSubscriptionRequired` once, after which a later push arrives. *Mutation:* report `subscriptionRequired: false` after a reset; the scenario reds on the report, not the push, since the rows survive a redeploy.
- The task-handle grep, run over everything this file changed, finds nothing.

## Build notes

### Phase 1

- **For Larry — this phase's diff is yours to review:** ADR-003, ADR-007, ADR-012, ADR-015, `docs/vision/auth.md`, `docs/vision/_ai-security.md` and `.claude/rules/security.md`.
  - **Blocks only where the wording is not yet true.** ADR-003, ADR-007 and `auth.md`'s § *Lumenize Nebula mesh* carry a *Today's code differs* block. The rest says "the node hosting the client", which is the Client's own Gateway today, so it is true now and after.
  - **One change goes past the hosted model.** `_ai-security.md` said the Gateway "preserves whatever the client supplied beyond" `callChain[0]`. That has been false since mesh-calls, whose Client frame carries no chain at all, so the caveat paragraph now says every entry is framework-built.
  - **Placement left `auth.md`** (Larry, in review: an auth document need not explain it). § *Founding a Star* keeps the claim flow and the fact that nothing enforces placement; the mechanism, the measurements and what would move a first touch are now `.claude/rules/durable-objects.md` § *A named object is placed by the first code that touches it, for good*, which every agent writing a Durable Object loads.
  - **Two paragraphs of § *How the claims travel* were cut** (Larry, in review): the client-to-client refusal keeps only its claim and where such traffic goes, and the point that no client can start a fresh chain joins the fresh-chain paragraph.
  - **ADR-012's § *Decision* opening is information-outlined** (Larry, in review), its dated re-weighting note is cut with `calibration.md` §1's pointer to it, and its first safeguard now reads "the mesh admits no anonymous caller": a Profile has no HTTP path, so the upgrade's authN was a holdover from when it did. No route in `entrypoint.ts`, `worker.ts`, `router.ts` or `worker-token.ts` makes a mesh call.
- **Retro:** ADR-012 sat at its 13 KB budget before this phase; the outline and the cuts brought it to 12.7 KB.
- **Close-out:** Larry reviewed the ADRs and vision docs; the rules were mine to review. While there, three rules lost text that no longer earned its tokens: `calibration.md` §6's dated inventory of `.dev.vars` lines and scenario counts, `durable-objects.md`'s count of legacy `migrations` configs and its story of a root `node_modules/wrangler` that no longer exists, and two paragraphs of `security.md` history, one defending a deleted wording and one recounting who once got the refresh path wrong.

### Phase 2

- **For Larry — names the phase chose, all open to change:** `LumenizeClient`'s `hostFromHostname` (D7's URL), `ClientGateway`'s `hostNode` option, `ComposedMeshDO`'s `__clientGateway` getter a host overrides, and the address helpers `isClientInstanceName`, `hostInstanceOf`, `addressOf` and `splitAddress`, exported from `@lumenize/mesh` and `@lumenize/mesh/client`.
- **For Larry — one detail differs from D1's wording.** D1 says the address string is also the socket's tag. The tag is the Client's instance name, `acme.crm.tenant1/alice.9f2c41aa`, without the binding: every socket on one host shares the binding, so the shorter tag is just as unique, and `ClientGateway` already tagged by instance name.
- **For Phase 5:** under `hostFromHostname` a Client's own `lmz.instanceName` is its id, `alice.9f2c41aa`, not its address. `LumenizeClient.onBeforeCall` exempts a call whose last hop is the Client itself by comparing against that id, so a hosted Client calling itself through the mesh would be refused as a peer. Nothing does that today.
- **Retro:** eight of nine tests passed on first write, so every one was mutation-checked: twelve mutations, each caught by the test it targets. The one first-run failure was the test's own fixture, a node whose stamped name differed from the name it was reached by, so its answers went elsewhere.
- **Verified:** mesh 40 files and 467 tests, `nebula-auth` 491, `apps/nebula` 1023, all green. `drive.ts all --fast` passed 51 of 52; `studio-overlays-by-url` failed when the email-test socket closed before its mail arrived, and passed alone on the rerun.
- **Close-out:** nothing closed. The mesh test Worker now rewrites `/gateway/{id}` on `*.hosted.test` the way Phase 4's Worker will, and `ClientHostDO` is its host node.

### Phase 3

- **For Larry — a latent bug this fixes.** Resources' `#caller()` joined the client's id from `callChain[0]` with the binding from `callChain.at(-1)`. On a chain a node relays for a client, such as the codegen loop writing under the poster's call, that stored the relaying node's binding beside the client's id, an address that reaches nothing. The one join from `callChain[0]` removes it, and `resources-door.test.ts`'s relayed-chain test pins it.
- **For Larry — the Galaxy's `#clientOrigin()` now requires a client at `callChain[0]`.** Before, any origin's instance name counted, so a build a node started would have aimed its preview-ready nudge at a Gateway named after that node.
- **For Larry — the Profile's table setup moved into an exported `ensureSubscribersTable`**, so a test can run it over a seeded old table; the constructor calls it as before.
- **Retro:** about twenty test files read the old columns and changed mechanically, through a new `addressOfClient` in `test-helpers.ts`. Four `/live` scenarios read `clientId` off the host's log lines; `harness/lib/stdio.ts` gains `clientIdIn`, which takes the id off the address, so they survive Phase 5's address change unedited. Every mutation was caught: storing only the id, the binding from `callChain.at(-1)`, each reaper deleting by the bare id, the drop reusing the baseline's id, and an unguarded drop.
- **Verified:** `apps/nebula` 1026 tests in 119 files and `nebula-auth` 491, green; the type-check passes; `drive.ts all --fast` passed 52 of 52. Two `nebula-client-denied` tests failed on the first full run, keying a row read on the bare id; they read the address now.
- **Close-out:** `mesh.md`'s reaper example and § *A broadcast target's `bindingName` comes from a source the client cannot write* now describe the stored address; Phase 5's row for that section still renames it.

## Non-goals

- **Deleting `LumenizeClientGateway` and its tests** — the package merge does it (D4).
- **Rewriting the website docs** beyond the two `website/docs/nebula` rows — Larry's docs task, after this lands; `website/docs/mesh/gateway.mdx` stays as it is.
- **Placing a Galaxy anywhere but beside its Universe** — D3. `tasks/on-hold/mesh-origin-request.md`'s `locationHint` half is the lever if that ever matters.
- **Checking passage before relaying, and failing pending calls on a host-node reset** — backlog rows with triggers (§ *Relationships*).
- **A Web Lock on `tabId`, and persisting a held continuation** — § *What mesh-calls handed this file*.
- **A TTL sweep of a host node's own subscriber rows** — this makes it possible; the backlog row keeps it.

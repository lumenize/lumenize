# A Client connects to its scope's node

**Status:** Pass 1, design intent only, in Larry's hand review (2026-10-05). It decides
[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Open decisions*, item 4. It is a deliberate
exception to one child task file at a time: it was reasoned out in detail while
[mesh-calls-to-and-from-clients.md](mesh-calls-to-and-from-clients.md) builds, and outgrew the
master plan. Stage 1, then Stage 2's architecture and security lenses, run after mesh-calls lands.
No phases are written until Larry decides to build.

**Objective — a `NebulaClient` opens its one socket on the Durable Object (DO) its page's host spells,
and that object hosts the Client's server-side half, so Gateways stop using a dedicated DO.**

A page on `crm.acme.lumenize.dev` connects to the Galaxy `acme.crm`. A page on
`tenant1.crm.acme.lumenize.dev` connects to the Star `acme.crm.tenant1`. A persona's page on
`manny--dev.crm.acme.lumenize.dev` connects to the Star `acme.crm.dev`, the Star its token already
names; ADR-022 § *A persona's host* already gives that page a token, so a persona needs nothing
beyond § *Worked examples*, example 5.

## The words this file uses

**A Client is one instance of `LumenizeClient` or `NebulaClient`.** A browser tab can run more than
one: an admin's page and the impersonation child it opens are two Clients in one tab. A Client is a
mesh node too, so this file calls Durable Objects and Workers **server-side nodes** when it needs
to tell them apart from a Client.

**Two kinds of host.** A page's *host* is its hostname, `tenant1.crm.acme.lumenize.dev`, as
ADR-021 uses the word. A Client's **host node** is the server-side node that holds its socket.
Today that is the Client's own Gateway DO. After this task it is the node its page's host spells,
here the Star `acme.crm.tenant1`.

**A Client's address is its host node plus its id there.** Alice's Client on that page has the id
`alice.9f2c41aa`, her `sub` and a `tabId` (a `sub` is a UUID, written `alice` in this file). Today
its address is one name, its Gateway's: (`NEBULA_CLIENT_GATEWAY`, `alice.9f2c41aa`). After this task
it is the Star `acme.crm.tenant1` plus that id, written as one string,
`acme.crm.tenant1/alice.9f2c41aa` (§ *What the examples settle*) [Why no binding name encoded in the string?]. Every place that stores or reads a Client's address carries
the host node, which is what makes this change wide; it is also mechanical.

Each goal says how today's design misses it.

1. **A Client's calls to its host node take one hop.** Today each one goes Client → Gateway →
   server-side node. Measured, the hop adds 7–18 ms per call at p50
   ([experiments/gateway-vs-hosted/RESULTS.md](../experiments/gateway-vs-hosted/RESULTS.md)).
2. **A server-side node pushes to the Clients it hosts directly.** Today every push to a Client is
   an RPC to that Client's Gateway. A broadcast to 1,000 subscribing Clients reached them in
   1.1–1.2 s at p50 through Gateways, against 93–113 ms when the node held the sockets. Those are
   arrival times, recorded by each Client's handler as it ran, from the moment the publisher called
   `publish`; hosted, the last of the 1,000 got it within 0.42 s in every publish. All 1,000 ran in one Node
   process, so browsers spread across the internet add their own latency, but the server's share
   is what the two numbers compare. The publisher's own `publish` call also came back in about 2 s
   through Gateways, against about 0.1 s hosted.
3. **A Client's server-side half lives where its authority is judged.** A Client's token names one
   scope as `aud` (ADR-022), and passage and dominion read it, yet the half that checks them lives
   in an object named `{sub}.{tabId}` that knows nothing of that scope. That object is why every tab
   reserves a Durable Object name for good, and why mesh-calls' D7, D17 and D25's Gateway check
   exist at all.
4. **A Client costs fewer billed requests.** Computed from Cloudflare's published pricing rather
   than measured: about 2.05 billed requests per call through a Gateway against 0.05 hosted (~40x),
   since an incoming socket message bills at 1/20 and an outgoing one is free. A push drops from
   about 1.05 to 0.05 (~20x), plus the Gateway's time awake waiting on the Client.

## Relationships

- **Builds after [mesh-calls-to-and-from-clients.md](mesh-calls-to-and-from-clients.md).** Its
  D23 extracts a Client's server-side half as `ClientGateway`, code a Durable Object composes, with
  `LumenizeClientGateway` as its first host node. This task moves that code onto a scope's node.
- **Takes up what mesh-calls parks on this decision:** D7 (an impersonation child's Gateway name),
  D17 (the Web Lock on `tabId`) and D25's Gateway name check. All three are about Gateway names, so
  hosting makes each moot or rewrites it. mesh-calls' Phase 9 writes a pointer to them.
- **Replaces [nebula-pre-alpha.md](nebula-pre-alpha.md) § *A Client connects to its scope's
  node*,** which becomes one line pointing here once this file passes Larry's read.
- **If built in pre-alpha, it lands before ⑥ the wipe.** Every generated app bundles the Client, so
  a change to what it connects to needs the rebuild the wipe already does; after the wipe it would
  mean rebuilding users' apps. Two smaller costs also grow after the wipe:
  - **The subscription tables change shape**, since a Client's address gains its host node. That
    is cheap either way: every Client re-subscribes after a deploy, so a table can be dropped and
    recreated.
  - **Nebula stops binding `NebulaClientGateway`.** After the wipe, deleting a deployed class needs
    a tombstone in `exports`; the post-wipe deploy itself declares only live classes
    (`.claude/rules/durable-objects.md` § *DO class registration*).

## Context and current state

**Built already**, and what becomes of each part. Each bullet opens with its fate: **Carried over**
moves as it is, **Adapted** moves and changes, **Replaced** gives way to something new, and **Left
behind** stays where it is, unused by Nebula.

- **Carried over, adapted for addresses — `ClientGateway`** (`packages/mesh/src/client-gateway.ts`).
  mesh-calls' D23 factored it out of `LumenizeClientGateway` so that any Durable Object can compose
  a Client's server-side half. It accepts and supersedes a Client's socket, builds every call's
  context from the socket's verified attachment, forwards a server-side node's call down and pairs
  the answer, and keeps each Client's grace period. It tags each socket with its Client's id, and
  finds that Client's socket again by the tag, so one host node can hold the sockets of many
  Clients. A tag does not have to be unique to one socket, so before it accepts a socket it closes
  any socket already holding that tag, which is how a reconnect replaces the old connection. [We may need to do some testing to confirm that the socket disappears from the list immediately so a call to getSocket doesn't get two back.]
- **Left behind by Nebula — `LumenizeClientGateway`**, which hosts one `ClientGateway` per Client
  in a DO named `{sub}.{tabId}`. Whether Mesh keeps it is § *Open questions*, item 1.
- **Carried over — `NebulaClientGateway`'s passage check on what it sends down.** Before a
  server-side node's call goes down to a Client, it checks that the Client's token has passage into
  the sender's scope (mesh-calls D12, built). Alice's Client accepts a push from the Galaxy
  `acme.crm`, since upward is free, and refuses one from the Star `acme.crm.tenant2`, which is
  lateral. A server-side node can address any Client it can name, so this check is what stops a
  lateral one. Under hosting the same check runs in the host node (§ *How a host node checks a
  call*).
- **Left behind — the `NebulaClientGateway` class**, a `LumenizeClientGateway` that adds that
  check. Nebula stops binding it.
- **Replaced — the `/gateway/*` route in `apps/nebula/src/entrypoint.ts`.** Today the Worker hands
  a Client's upgrade request to `NEBULA_CLIENT_GATEWAY` through `routeDORequest`, allow-listing
  that one binding. Instead it hands the upgrade to the host node its page's host spells.
- **Adapted — `NebulaClient`.** It connects with `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` and
  takes `{sub}.{tabId}` as its id. An impersonation child shares its parent's config and takes
  `{subjectSub}.{parentTabId}.{scope with dashes}`. Each connects to its page's host node instead,
  and keeps an id of the same shape (§ *What the examples settle*).
- **Adapted — subscriber addresses.** Today each is a Gateway's binding plus a Client's id.
  Resources' `#caller()` takes the binding from `callChain.at(-1)` and the id from `callChain[0]`;
  `Profile.subscribe` takes both from `callChain[0]`; the Galaxy's preview-ready call names
  `NEBULA_CLIENT_GATEWAY` and a Client id. Each gains its host node.
- **Carried over, its reasons shifted — `packages/mesh/src/tab-id.ts`**, which keeps a tab's id
  across reloads.
  - **Today, for two reasons.** Each `{sub}.{tabId}` reserves a Gateway DO name for good, so a new
    id per reload would leak names. And a reload that comes back within the grace period keeps its
    subscriptions.
  - **Hosted, for one.** No name is reserved, but the id is how the host node knows which socket a
    Client already has: a reconnect under the same id closes the old socket, and within the grace
    period keeps its subscriptions.
  - **Two tabs sharing an id** would replace each other's socket, so the duplicated-tab probe stays.
    Its 50 ms `BroadcastChannel` wait is still the mechanism, since mesh-calls parked D17's Web Lock
    on this decision. ⚠️ Design consideration: this task may take D17's lock; nothing requires it.
- **Adapted — `NebulaDO`**, which `Universe`, `Galaxy` and `Star` extend. Its `onBeforeCall` checks
  passage through `requirePassage`, which fits a call addressed to the node itself and refuses
  most calls addressed to a Client it hosts (§ *How a host node checks a call*). It composes
  `ClientGateway` (§ *A server-side node hosts Clients with no code of its own*).

**Missing:**

1. A server-side node that accepts a Client's upgrade, holds its socket and dispatches its frames.
2. A Client address that names its host node, everywhere one is stored or read; § *Worked
   examples* lists where.
3. A host node that checks each call by where it is going.
4. A call from a Client to its own host node that runs in place rather than as an RPC to itself.
5. A track for a Client's upgrade in `.claude/rules/raw-comm.md` § *What reaches a Durable
   Object's `fetch`*, and in `npm run audit:do-http`.
6. A Client that knows its host node was rebuilt, and fails its calls in flight at once.

## Design intent, constraints, and future state

### Worked examples

Alice is a member of the Star `acme.crm.tenant1`, on its page, and her Client's address is
`acme.crm.tenant1/alice.9f2c41aa`. Bob's public profile lives in the Profile `bob-profile` (a UUID
too), and Dana is another member on the same Star's page.

1. **A call to the host node itself.** Alice saves an order: `resources.transaction(…)` on her
   Star.
   - **Today:** Client → Gateway → Star, then the Star fires the result back to the Gateway, which
     writes it to her socket. Two RPCs.
   - **Hosted:** Client → Star, which runs the call in place and answers on her socket. No RPC.
   - **Checked by** the Star's `onBeforeCall`: passage from her `aud`, `acme.crm.tenant1`, into
     `acme.crm.tenant1`.
2. **A call to another server-side node.** Alice reads the Galaxy `acme.crm`, which her `aud` has
   passage into because upward is free.
   - **Today:** Client → Gateway → Galaxy, and the result comes back through the Gateway.
   - **Hosted:** Client → Star → Galaxy, and the Galaxy fires the result to her address, which
     lands at the Star and goes down her socket. Same hops as today.
   - **Checked by** the Galaxy's own `onBeforeCall`. The Star relays the call and checks nothing
     of its own.
3. **A subscription on the host node.** Alice subscribes to an order on her Star.
   - **The row stores** her address. Today that is (`NEBULA_CLIENT_GATEWAY`, `alice.9f2c41aa`);
     hosted, it is `acme.crm.tenant1/alice.9f2c41aa`, which names the Star itself.
   - **A push** is then a `ws.send` on the socket with that tag, with no RPC, where today it is an
     RPC to her Gateway.
4. **A subscription on a node with no scope.** Alice subscribes to `bob-profile`.
   - **The call** goes Client → Star → Profile, which stores her address in its row, as today.
   - **A push,** when Bob renames himself, goes Profile → Star → her socket.
   - **Checked by** D12's check in the Star: her passage into the sender's scope. A Profile names
     no scope, so it passes. The Star's own `onBeforeCall` must not run on this push: a Profile's
     chain carries no claims and no scope, so `requirePassage` would refuse it.
   - **A lateral push is refused.** If the Star `acme.crm.tenant2` sends to Alice's address, the
     call lands at her Star, and D12's check refuses it: `acme.crm.tenant1` has no passage into
     `acme.crm.tenant2`.
   - **No push reads the Registry.** The check reads only Alice's claims, verified at the upgrade
     and kept on her socket, and the sender's name. `hasPassageInto` computes the verdict from a
     token and a scope, as it does today in `NebulaClientGateway`.
5. **A persona.** Studio frames `manny--dev.crm.acme.lumenize.dev`. Manny's `sub` is a name-based
   UUID computed from that hostname (ADR-022), and his Client takes the id `manny.4d1e88b0` on the
   host node `STAR` `acme.crm.dev`. The Worker maps the persona's hostname to that Star for the
   upgrade, the way the refresh already maps its `Origin`. Everything after that is examples 1–4.
6. **An impersonation child.** Alice, an admin, impersonates Carol from the same page. The child is
   a second Client on the same host node, with Carol's token, its own socket and an id of the child
   shape. Two Clients, two tags, one Star.
7. **A call from one Client to another.** Alice's Client calls Dana's.
   - **The call** reaches Dana's address the way a call to any Client does: Alice's host node
     delivers it, here to a socket it holds itself.
   - **Checked by** Dana's Client, which refuses it, as every Client refuses a call whose immediate
     caller is another Client (mesh-calls' D24). The host node runs no passage check for a Client
     sender, as the Gateway runs none today.

### What the examples settle

**A Client's address is one string, `{scope}/{id}`** (Larry, 2026-10-05), such as
`acme.crm.tenant1/alice.9f2c41aa`. The same string is the socket's tag and a subscription row's one
column, and it goes wherever an address is stored or read: subscriber rows (examples 3 and 4), the
return address a fire-back follows (example 2), and the Galaxy's preview-ready call.
- **The binding needs no room in it.** A scope's depth names its binding [That's true today, but we envision helper DOs sitting at the same scope but with a different binding name. If it fits, I'd rather include the binding name now also just in case.]: one segment is a
  `UNIVERSE`, two a `GALAXY`, three a `STAR`.
- **It fits a tag with room to spare.** A scope is at most three 30-character slugs, 92 characters
  with its dots, so `{scope}/{sub}.{tabId}` is at most 138. An impersonation child under today's id
  shape reaches 231, and spelling out the binding would add at most 5 more. Cloudflare allows each
  tag 256 characters, and a socket 10 tags.
- **`/` separates the two halves,** since a slug, a UUID and a `tabId` never contain one.

**A Client's id has three jobs, and today's shape does all three.**
- **It is unique within its host node**, because it is the socket's tag, and a tag that two
  Clients shared would let one replace the other's socket.
- **It starts with its token's `sub`**, which is how the upgrade checks that a Client claims only
  its own identity.
- **It stays the same across a reload**, so a reconnect within the grace period finds its
  subscriptions.

`{sub}.{tabId}` meets all three. An impersonation child's
`{subjectSub}.{parentTabId}.{scope with dashes}` still fits, but its scope segment now repeats the
address's first half. ⚠️ Design consideration: the child
needs only a shape that differs from a tab's own, which D7 wants so the two cannot collide, and a
short fixed marker in place of the scope gives that.

### How a host node checks a call

**A host node checks each call by where it is going**, because these kinds of call arrive at it
and passage means something different for each:

| The call | Example | Checked by |
|---|---|---|
| To the host node itself | 1 | its own `onBeforeCall`, as today |
| To a Client it hosts, from a server-side node | 4 | D12's check alone: the Client's passage into the sender's scope |
| To a Client it hosts, from another Client | 7 | the receiving Client, which refuses it (mesh-calls' D24) |
| From a Client it hosts, to another node | 2 | the destination's own checks; the host node only relays |

So the host node decides where a call is going before any check runs, and `onBeforeCall` runs only
on the first row.

**Every page that runs a Client has a host node.** That is what lets one design cover them all.
Each of these is a claim review should check:

- **Studio connects only on a scope's host.** `App.vue` returns before connecting otherwise, with
  the comment "not a scope's host: nothing to connect to". The platform host runs no Client.
- **A persona's page has its `.dev` Star**, by ADR-022 § *A persona's host*.
- **A generated app runs on a Star's host.**
- **An impersonation child shares its parent's host node**, under its own id.

### A server-side node hosts Clients with no code of its own

**`NebulaDO` composes `ClientGateway` once, and `Universe`, `Galaxy` and `Star` add nothing.** The
runtime delivers a socket's events to Durable Object methods by fixed names: the upgrade to
`fetch`, then `webSocketMessage`, `webSocketClose` and `webSocketError`. Mesh delivers a call to a
hosted Client at the node's `__executeOperation`, and its answer at the node's response door. So
those entry points have to exist on the class, and they are wired in one place, the base class,
rather than as a forwarding method per node type. That is the same rule the data plane follows,
where each node's one `@mesh()` gate hands back a surface and every capability arrives by
composition (`.claude/rules/calibration.md` § 11). A Client's half has no `@mesh()` surface of its
own to gate: everything it does starts from a socket event or a mesh door, never from a caller's
chain.

⚠️ Design consideration (Larry, 2026-10-05): `ClientGateway` could hand out one object per Client
from a factory that takes the Client's tag. That object would gather what today rests on a Gateway
having one connection: the socket, the grace period, and the calls waiting on that Client's answer.
Two things shape it:
- **It is rebuilt, never kept.** The host node can hibernate, so each event would rebuild the object
  from the tagged socket and its attachment, which is where `ClientGateway` already finds a
  Client's socket and claims. Its grace period and waiting calls live in memory only while the
  node stays resident, which mesh-calls' D23 holds it to by handing each wait to `ctx.waitUntil`.
- **It needs a name other than `Client`,** which this file uses for the browser-side instance.

### The boundaries that hold

**The trust boundary keeps its substance.** `ClientGateway` builds every call's `callContext` from
the socket's verified attachment, so a Client still cannot name who it is or add to its chain. The
callee already decodes a Client's chain itself (`executeEnvelope`'s `postprocess(envelope.chain)`),
so hosting moves no new client-controlled decoding into the node; it adds the frame parse and the
attachment check. What does change is where the upgrade arrives: a mesh node's `fetch`, which
today hears only pages under `/_public/`, its own container, and nothing of our own code. The
upgrade needs a track of its own, and its forward must strip every client-sent `x-lumenize-*`
header and set its own, as `forwardPage` does, because mesh stamps a node's name from those
headers.

**A reset of the host node costs its Clients a reconnect, never a silent loss.** When the host
node resets, every Client on it reconnects together and the calls in flight are gone, since
nothing outlives the reset to deliver them. That is measured, along with today's trigger:
Cloudflare's runtime resets an object that keeps running hot JavaScript in a slow state some
instances are born in
([experiments/do-socket-drop-probe/RESULTS.md](../experiments/do-socket-drop-probe/RESULTS.md)).
Larry expects Cloudflare to make that rarer, not to end it, and an exception that breaks the
object, the memory limit and a deploy reset it too. So a Client learns when its host node is new,
by an id the node reports on connect, and then fails every call in flight at once, re-issuing only
what ADR-005's eTags make idempotent. Its subscriptions come back the way they do after any longer
drop. Today's Client would instead wait out its 30 s timeout for a result that never comes.

**The host node carries its Clients' load.** A Star holds every connected user's socket, relays
their calls to Profiles and the facade, and stays resident while a push waits for a Client's
answer (mesh-calls' D11 hands each such wait to `ctx.waitUntil`). The largest relay load in view is
a Client subscribing to about half a dozen Profiles: a few calls per page load and a push when a
profile changes. At a Star transaction's weight the ceiling is set by the transaction's own work,
the same as behind Gateways, so hosting neither raises nor lowers how many writes a Star absorbs.

**Constraints.** Cite, rather than restate:

- **ADR-003:** no node holds a reply open across a hop. mesh-calls' D11 already meets it in the
  code this task moves.
- **ADR-007:** a Client's half is a capability a node composes, never a node type or base class.
- **ADR-015 and ADR-022:** a Client's `aud` is its page's scope, and passage and dominion read it.
- **ADR-023:** a Client's upgrade is page traffic. It reaches no operation only our own code may
  invoke.
- **mesh-calls' D25:** a scope-shaped name belongs only to an object that checks passage. A
  `NebulaDO` host node does.
- **`.claude/rules/raw-comm.md` § *What reaches a Durable Object's `fetch`*:** the fourth track,
  and the audit that proves it.
- **`.claude/rules/live.md`:** the `/live` scenario is written first.

**Future state.**

- **A customer's own domain** (ADR-022 § *A customer's own domain*) already turns a host into a
  scope; its Clients connect to that scope's node like any other.
- **More than one Client per tab stays open.** An impersonation child and a framed page on another
  host each have their own Client today, and each lands on its own page's host node.
- ⚠️ Design consideration: ADR-018's single-object ceiling and Cloudflare's practical
  sockets-per-object cap bound the largest tenant a Star can host. Cloudflare's docs no longer name
  a number beyond "thousands of clients per instance". Pre-alpha tenants are far below either.

**Open questions.**

1. **Does the Client's server-side half stay in Mesh, or become Nebula's?** If it stays,
   `NebulaDO` composes Mesh's `ClientGateway` and Mesh gains the hosted address. If it moves,
   Mesh keeps `LumenizeClientGateway` as it is and Nebula owns the hosted half. Larry, 2026-10-04:
   Mesh becoming legacy may count in this change's favor, since the separation has grown
   artificial. It gates where the code lands and which public docs change.

## Decisions

Started during the Pass 1 gate, holding only what is settled. Each row is Larry's call.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **A Client's address is one string, `{scope}/{id}`, used as its socket's tag and stored in one column** (Larry, 2026-10-05). § *What the examples settle* carries the shape and its length. | **Deriving the host node from the Client's `aud` instead of storing it** — it saves a column, but every reader would need the call's claims, and a chain a node starts carries none (mesh-calls' D10). **Storing the binding, the scope and the id in separate columns** — three values to keep in step where one string does, and a tag can hold only one string anyway. |

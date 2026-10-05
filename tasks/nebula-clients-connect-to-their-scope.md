# A Client connects to its scope's node

**Status:** Pass 1, design intent only, for Larry's hand read (2026-10-05). It decides
[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Open decisions*, item 4. It is a deliberate
exception to one child task file at a time: it was reasoned out in detail while
[mesh-calls-to-and-from-clients.md](mesh-calls-to-and-from-clients.md) builds, and outgrew the
master plan. Stage 1, then Stage 2's architecture and security lenses, run after mesh-calls lands.
No phases are written until Larry decides to build.

**Objective — a `NebulaClient` opens its one socket on the Durable Object its page's host spells,
and that object hosts the Client's server-side half, so no tab has a Gateway of its own.**

A page on `crm.acme.lumenize.dev` connects to the Galaxy `acme.crm`. A page on
`tenant1.crm.acme.lumenize.dev` connects to the Star `acme.crm.tenant1`. A persona tab on
`manny--dev.crm.acme.lumenize.dev` connects to the Star `acme.crm.dev`, which its token already
names.

Four goals, in the order they matter. Each says how today's design misses it.

1. **A tab's calls to its own scope take one hop.** Today each one goes client → Gateway → node.
   Measured, the hop adds 7–18 ms per call at p50
   ([experiments/gateway-vs-hosted/RESULTS.md](../experiments/gateway-vs-hosted/RESULTS.md)).
2. **A node pushes to its own tabs directly.** Today every push to a tab is an RPC to that tab's
   Gateway. A broadcast to 1,000 subscribers reached them in 1.1–1.2 s at p50, against about
   0.1 s when the node held the sockets, and it held the writer's own call for about 2 s.
3. **A tab's server-side half lives where its authority is judged.** A tab's token names one scope
   as `aud` (ADR-022), and passage and dominion read it, yet the half that checks them lives in an
   object named `{sub}.{tabId}` that knows nothing of that scope. That name is why a tab keeps its
   id across reloads, why a subscriber row made on one host can still reach the tab after it moves
   to another, and why mesh-calls' D7, D17 and D25's Gateway check exist at all.
4. **A tab costs fewer billed requests.** Computed from Cloudflare's published pricing rather than
   measured: about 2.05 billed requests per call through a Gateway against 0.05 hosted, since an
   incoming socket message bills at 1/20 and an outgoing one is free. A push drops from about 1.05
   to 0.05, plus the Gateway's time awake waiting on the tab.

## Relationships

- **Builds after [mesh-calls-to-and-from-clients.md](mesh-calls-to-and-from-clients.md).** Its
  D23 extracts a Client's server-side half as `ClientGateway`, code a Durable Object composes, with
  `LumenizeClientGateway` as its first host. This task moves that code onto a scope's node.
- **Takes up what mesh-calls parks on this decision:** D7 (an impersonation child's Gateway name),
  D17 (the Web Lock on `tabId`) and D25's Gateway name check. All three are about Gateway names, so
  hosting makes each moot or rewrites it. mesh-calls' Phase 9 writes a pointer to them.
- **Replaces [nebula-pre-alpha.md](nebula-pre-alpha.md) § *A Client connects to its scope's
  node*,** which becomes one line pointing here once this file passes Larry's read.
- **If built in pre-alpha, it lands before ⑥ the wipe.** Every generated app bundles the Client,
  so a change to what it connects to needs the rebuild the wipe already does.

## Context and current state

**Built already**, and what becomes of each part:

- **`ClientGateway`** (`packages/mesh/src/client-gateway.ts`, landing with mesh-calls) accepts and
  supersedes a Client's socket, builds every call's context from the socket's verified attachment,
  forwards a node's call down and pairs the answer, and keeps each Client's grace period. It tags
  each socket with its Client's `instanceName`, and its JSDoc says one host "can hold many
  Clients". **Carried over**, hosted by the scope's node, and adapted where a client's address
  changes.
- **`LumenizeClientGateway`** hosts one `ClientGateway` per tab, named `{sub}.{tabId}`. **Left
  behind by Nebula.** Whether Mesh keeps it is § *Open questions*, item 1.
- **`NebulaClientGateway`** checks the tab's passage into the sender's scope on every call it sends
  down (mesh-calls D12, built). **The check is carried into the host; the class is left behind.**
  Its JSDoc keeps the check because a subscriber row outlives the page it was made on. Under
  hosting that row addresses the old host, which holds no socket for the tab, so the check remains
  for every sender other than the host while that case disappears.
- **The `/gateway/*` route in `apps/nebula/src/entrypoint.ts`** sends an upgrade to
  `NEBULA_CLIENT_GATEWAY` through `routeDORequest`, allow-listing that one binding. **Replaced** by
  a forward to the node the page's host spells.
- **`NebulaClient`** connects with `gatewayBindingName: 'NEBULA_CLIENT_GATEWAY'` and names itself
  `{sub}.{tabId}`. An impersonation child shares its parent's config and names itself
  `{subjectSub}.{parentTabId}.{scope}`. **Adapted:** each connects to its page's host, and keeps its
  name as its id within that host.
- **Subscriber addresses** are a Gateway's binding plus the client's name. Resources'
  `#caller()` takes the binding from `callChain.at(-1)` and the client from `callChain[0]`;
  `Profile.subscribe` takes both from `callChain[0]`; the Galaxy's preview-ready call names
  `NEBULA_CLIENT_GATEWAY` and a client id. **Adapted:** each address gains its host.
- **`packages/mesh/src/tab-id.ts`** keeps a tab's id across reloads because each `{sub}.{tabId}`
  reserves a Durable Object name for good. **The reason goes;** the duplicated-tab case stays.
- **`NebulaDO`**, which `Universe`, `Galaxy` and `Star` extend, already checks passage in
  `onBeforeCall` through `requirePassage`. **Carried over**, and it composes `ClientGateway`.

**Missing:**

1. A node that accepts a Client's upgrade, holds its socket and dispatches its frames.
2. A client address that names its host, everywhere one is stored or read.
3. A call from a tab to its own host that runs in place rather than as an RPC to itself.
4. A track for a Client's upgrade in `.claude/rules/raw-comm.md` § *What reaches a Durable
   Object's `fetch`*, and in `npm run audit:do-http`.
5. A Client that knows its host was rebuilt, and fails its calls in flight at once.

## Design intent, constraints, and future state

**The node a tab's host spells hosts that tab.** Every page that runs a Client already has such a
node, which is what lets one design cover them all. Each of these is a claim review should check:

- **Studio connects only on a scope's host.** `App.vue` returns before connecting otherwise, with
  the comment "not a scope's host: nothing to connect to". The platform host runs no Client.
- **A persona tab's `aud` is its `.dev` Star**, by ADR-022 § *A persona's host*.
- **A generated app runs on a Star's host.**
- **An impersonation child shares its parent's host**, so it lands on the same node under its own
  id.

**A tab's address is its host plus its id within that host.** The host is the scope's node, such as
`STAR` / `acme.crm.tenant1`, and the id is today's `{sub}.{tabId}`. Every place that stores a
client's address or reads one from a `callChain` carries the host. Today the address is a Gateway
name, so a client is one name and the change is wide; it is also mechanical. ⚠️ Design
consideration: a field on `NodeIdentity` lets the compiler list every site that must change.

**The host serves its tab's calls to itself in place and forwards the rest.** A call to anything
else, such as a `Profile`, the auth facade or a scope the tab has passage into, is forwarded exactly
as a Gateway forwards it today. Such a call costs the same hops either way:

| | Today | Hosted |
|---|---|---|
| A tab reads a Profile | client → Gateway → `Profile` | client → Star → `Profile` |
| The Profile pushes back | `Profile` → Gateway → client | `Profile` → Star → client |

A push from another node arrives at the host and goes down the tab's socket after the passage check
mesh-calls' D12 runs today.

**The trust boundary keeps its substance.** `ClientGateway` builds every call's `callContext` from
the socket's verified attachment, so a client still cannot name who it is or add to its chain. The
callee already decodes a client's chain itself (`executeEnvelope`'s `postprocess(envelope.chain)`),
so hosting moves no new client-controlled decoding into the node; it adds the frame parse and the
attachment check. What does change is where the upgrade arrives: a mesh node's `fetch`, which
today hears only pages under `/_public/`, its own container, and nothing of our own code. The
upgrade needs a track of its own, and its forward must strip every client-sent `x-lumenize-*`
header and set its own, as `forwardPage` does, because mesh stamps a node's name from those
headers.

**A reset of the host costs its tabs a reconnect, never a silent loss.** When the host resets,
every tab on it reconnects together and the calls in flight are gone, since nothing outlives the
reset to deliver them. That is measured, along with today's trigger: Cloudflare's runtime resets
an object that keeps running hot JavaScript in a slow state some instances are born in
([experiments/do-socket-drop-probe/RESULTS.md](../experiments/do-socket-drop-probe/RESULTS.md)).
Larry expects Cloudflare to fix that; an exception that breaks the object, the memory limit and a
deploy would still reset it. So a Client learns when its host is new, by an id the host reports on
connect, and then fails every call in flight at once, re-issuing only what ADR-005's eTags make
idempotent. Its subscriptions come back the way they do after any longer drop. Today's client
would instead wait out its 30 s timeout for a result that never comes.

**The host carries its tabs' load.** A Star holds every connected user's socket, relays their calls
to Profiles and the facade, and stays resident while a push waits for a tab's answer (mesh-calls'
D11 hands each such wait to `ctx.waitUntil`). The largest relay load in view is a tab subscribing to
about half a dozen Profiles: a few calls per page load and a push when a profile changes. At a Star
transaction's weight the host's ceiling is set by the transaction's own work, the same as behind
Gateways, so hosting neither raises nor lowers how many writes a Star absorbs.

**Constraints.** Cite, rather than restate:

- **ADR-003:** no node holds a reply open across a hop. mesh-calls' D11 already meets it in the
  code this task moves.
- **ADR-007:** the client half is a capability a node composes, never a node type or base class.
- **ADR-015 and ADR-022:** a tab's `aud` is its host's scope, and passage and dominion read it.
- **ADR-023:** a Client's upgrade is page traffic. It reaches no operation only our own code may
  invoke.
- **mesh-calls' D25:** a scope-shaped name belongs only to an object that checks passage. A
  `NebulaDO` host does.
- **`.claude/rules/raw-comm.md` § *What reaches a Durable Object's `fetch`*:** the fourth track,
  and the audit that proves it.
- **`.claude/rules/live.md`:** the `/live` scenario is written first.

**Future state.**

- **A customer's own domain** (ADR-022 § *A customer's own domain*) already turns a host into a
  scope; its Clients connect to that scope's node like any other.
- **More than one Client per tab stays open.** An impersonation child and a framed page on another
  host each have their own Client today, and each lands on its own page's host.
- ⚠️ Design consideration: ADR-018's single-object ceiling and Cloudflare's practical
  sockets-per-object cap bound the largest tenant a Star can host. Cloudflare's docs no longer name
  a number beyond "thousands of clients per instance". Pre-alpha tenants are far below either.

**Open questions.**

1. **Does the Client's server-side half stay in Mesh, or become Nebula's?** If it stays,
   `NebulaDO` composes Mesh's `ClientGateway` and Mesh gains the hosting address. If it moves,
   Mesh keeps `LumenizeClientGateway` as it is and Nebula owns the hosted half. Larry, 2026-10-04:
   Mesh becoming legacy may count in this change's favor, since the separation has grown
   artificial. It gates where the code lands and which public docs change.
2. **Is a tab's host carried in its address, or derived from its `aud`?** The token already names
   the host's scope, and a scope names its binding. Deriving it adds no field, but every reader
   would need the claims, and a chain a node starts carries none (mesh-calls' D10). It gates the
   shape of the address change.

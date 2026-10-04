# Calls to and from a Client behave like calls between nodes

**Status:** Pass 1, with every decision Larry's, 2026-09-30. Stage 1 `/review-task` ran 2026-10-04,
and this file was reshaped from it the same day. Every item it raised is settled, and the vision
doc, the ADRs and `security.md` changed docs-first the same day (→ D18). Stage 1 runs again next.
Pass 2's phases follow once the master plan's Open decision 4 is settled (§ *Relationships*).

## Goals

**Overall objective:** make calls to and from a Client behave as much like calls between server-side
mesh nodes as security allows, knowing that whoever controls a browser can change the Client's code.

Five goals serve it, most important first. Each says how today's code misses it.

1. **A tab never silently stops getting the updates it is entitled to.** Today a tab paused for more
   than 30 s is dropped from each subscription that pushed to it during the pause, and keeps the
   socket that would have told it so. An
   update that meets a socket whose token has just lapsed is lost, though the tab is back in
   moments (→ D4, D5).
2. **No node waits on a tab, and a tab's answer arrives the way a node's does.** Today the Gateway
   holds the calling node's RPC open for up to 30 s while its tab answers, which is the late-ack
   transport ADR-003 rejects, and a value the tab returns is thrown away (→ D11, with D10 and D6).
3. **A refused call reaches its caller right away, not when a timer gives up.** Today a tab's
   subscribe names no handler, so when passage refuses it the tab learns only when `#subscribeVia`'s
   timer expires (→ D15).
4. **No Client ever chooses code that a node or another Client runs.** It holds today because no
   result handler continuation ever crosses the socket, and it must keep holding once they travel
   (→ D11).
5. **A tab is protected by the same layers as a node: passage at its Gateway and guards on its
   methods.** Today a tab refuses every call from another tab outright, which also turns away the
   peers a feature such as cursors needs, and its update handlers have no guard of their own
   (→ D12, D13, D14).

D7, D8 and D17 ride along: D7 refuses a second live impersonation child of one subject from the
same parent, D8 deletes a dead method, and D17 replaces the duplicated-tab probe. Every goal rests
on one model: a Client and its Gateway together are the equivalent of a server-side node (→ D20).

### Accepted limitations

- **A Client can start or end a chain, never sit in the middle, and its calls carry nothing of its own context** (→ D19). Its Gateway starts every call a Client makes with `callChain: [thatClient]`, the Client's claims and an empty `state`. So a call the Client makes while handling another carries over nothing of it, and a Client can neither start a chain without its token, as a node does with `newChain: true`, nor pass `state` along; its options offer neither.

## Relationships

- **Builds after [archive/nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md), built 2026-10-04.** Its 30-character slug cap is what lets D10 tell a scope's name from an id. Its fresh-chain default for `lmz.broadcast` keeps a writer's tab address off every update, the bonus D13 names. It also built D9 and D12.
- **Builds after the toolchain row of [nebula-pre-alpha.md](nebula-pre-alpha.md)**, the move to `@cloudflare/vitest-plugin` and compatibility date 2026-10-01. D11 rewrites the transport between a Client and its Gateway, and a test runtime changing underneath it would give every new failure two suspects.
- **Pass 2 waits on [nebula-pre-alpha.md](nebula-pre-alpha.md) § *A Client connects to its scope's node*, and this file says how each decision fares under it.** If a Client's socket moves from a Gateway of its own to its scope's node, the server-side half of D20's pair moves rather than changes. Pass 2 is written after it settles, so every phase knows where that half lives.
  - **Unaffected:** D6, D8, D10, D14, D15, D16, D18 and D19, and D9 and D12, which are built.
  - **Moves with the server-side half:** D4, D5 and D11. D11's rule carries over; how the continuation is held while the Client answers is chosen with the open decision (→ D11).
  - **Tied to Gateway names, so parked until it settles:** D7 and D17, and the Gateway-specific wording in D3, D13 and D20.
- **Lands before ⑥ the wipe.** D11 changes the wire between a Client and its Gateway, and every generated app bundles the Client, so apps built before it must be rebuilt, which the wipe does anyway.
- **Closes one row in `tasks/backlog.md` § *Lumenize Mesh* and narrows another.** D11 does what the row proposing that broadcast-to-client go fully async asks. D10 answers the row saying a chain a node starts carries no `originAuth` only for passage into that node and its ancestors, so a Galaxy's alarm calling one of its Stars stays refused, and the build narrows the row to that.
- **Owes the next release its BREAKING notes, written into `tasks/backlog.md`'s unreleased BREAKING rows as a Pass 2 criterion,** because this file archives and those rows carry the obligation:
  - the Client↔Gateway wire, including the `lmz.2` protocol name and the exported `CallResponseMessage` going (D11);
  - the three-argument `lmz.call`, and `lmz.broadcast`'s `onResult` becoming required (D15);
  - a Client accepting calls from other Clients, naming `requireServerSideCaller` for push handlers (D13);
  - the Client's options losing `newChain` and `state` (D19).

  The same edit strikes what those rows will then get wrong: `ClientTokenExpiredError` listed as new, though D5 deletes it before any release; `lmz.broadcast`'s `newChain` and `state` called additive; the CALL frame keeping only `state`; and `ClientResultEnvelope.clientInstanceName` staying.
- **`tasks/on-hold/mesh-resilience-testing.md` drives the grace period and reconnect paths D4 and D5 change**, so its phases need re-reading against this file's Gateway when it resumes.

## Constraints

- **ADR-003:** no node holds a reply open across a hop. Today's downstream hop does, and D11 is the fix.
- **ADR-007:** every node type shares one comms and guards core, so the Gateway fills a continuation with `fireResponse`'s code rather than a copy (D11).
- **ADR-015 and ADR-022:** passage and dominion read `activeScope`, which D10 widens to a chain a node started.
- **ADR-023 § *What this does not cover*:** the Gateway builds envelopes by hand because it is part of what the mesh is built from, which is what lets D11 add its call to a node's `__handleResponse`.

## What's true today?

This section walks today's code: the token, the call context, then the Gateway upstream and downstream. Each place a decision changes is marked (→ Dn). The design section after it rewrites the downstream hop and both response paths.

### Access token claims

This is the token a Galaxy admin holds today while working on one of their tenants. The type
`NebulaJwtPayload` in `packages/nebula-auth/src/types.ts` defines it, and each comment names the ADR
that decides the claim:

```jsonc
{
  "iss": "https://platform.lumenize.dev",  // the deployment's platform host. The verifier refuses
                              // any other, so each deployment accepts only its own tokens
  "sub": "8f3c…",             // the membership, a dotless UUID, and the only key (ADR-013)
  "aud": "acme.crm.bigco",    // activeScope: the scope its host spells, bigco.crm.acme.lumenize.dev,
                              // which the refresh reads from Origin, so no script sets it (ADR-022)
  "access": {
    "authScope": "acme.crm",  // the membership the token rests on: the broadest admin membership
                              // among the browser's cookies at or above the host (ADR-022)
    "scopeAdmin": true        // omitted when false. Dominion is this bit AND aud at or above
                              // the target, never the bit alone (ADR-015)
  },
  "profileId": "1a9d…",       // the person's public profile address, display-only (ADR-012, ADR-013)
  // "act": { "sub": "…", "profileId": "…" },
                              // only on an impersonation token, naming who is driving. It is
                              // traceability, never an input to authorization (security.md)
  "exp": 1790693100,          // iat + 900: a token lives 15 minutes
  "iat": 1790692200,
  "jti": "…"                  // a UUID
}
```

**Passage and dominion read `aud`** (`requirePassage` in `apps/nebula/src/nebula-do.ts`), and take
only `scopeAdmin` from the membership. So a tab's `aud` bounds both what its calls may reach and
which updates its Gateway lets through (§ *Gateway*, below).

### `callContext`

Every mesh call carries a `callContext` beside its chain of operations. The type `CallContext` in
`packages/mesh/src/types.ts` defines it; no ADR does, and `docs/vision/auth.md` § *How the claims
travel* describes how it moves. Below is an example of what a Star sees when called by a Client. With two exceptions, this is generated by the Gateway using data stored in the attachment that was associated with the WebSocket connection when the Client last connected/reconnected. The exceptions are `state`, which can be provided by the Client, and `callee`, which is added once the call reaches the callee.

```ts
{
  callChain: [                     // [origin, …, immediate caller]. The framework appends each
    {                              // sender; the Gateway writes a client's entry
      type: 'LumenizeClient',
      bindingName: 'NEBULA_CLIENT_GATEWAY',  // a client's address is its Gateway's
      instanceName: '8f3c….a1b2c3d4',        // {sub}.{tabId}
    },
  ],
  originAuth: {                    // the origin's verified token, unchanged across hops
    sub: '8f3c…',                  // claims.sub again. OriginAuth is mesh's type, where sub is
                                   // required and claims optional, so any node can rely on sub
    claims: { /* the whole token above */ },
  },
  originRequest: {                 // the WebSocket upgrade's HTTP facts, unchanged across hops,
                                   // and potentially useful as a location hint for DO creation.
                                   // Server-side only, because these are the ORIGIN's IP and
                                   // place, which no other client should see
    origin: 'https://bigco.crm.acme.lumenize.dev',
    ip: '203.0.113.7',
    cf: { country: 'US', city: 'Austin', colo: 'DFW' /* … */ },
    userAgent: 'Mozilla/5.0 …',
    acceptLanguage: 'en-US',
  },
  callee: {                        // the node this hop reached. The receiver overwrites it from
    type: 'LumenizeDO',            // its own identity, so no caller can set it
    bindingName: 'STAR',
    instanceName: 'acme.crm.bigco',
  },
  state: {},                       // the one mutable field: any hop, or onBeforeCall, may change it
}
```

- **A fresh chain carries only the sender.** A call made with `newChain: true`, or with no incoming
  call to inherit from, such as one made from an alarm, gets `callChain: [thisNode]` and no
  `originAuth` or `originRequest`. Every subscription update starts one, because each goes through
  `lmz.broadcast`, which passes `newChain: true` unless told otherwise. The Profile's first snapshot
  to a new subscriber is the exception: it rides that subscriber's own call.
- **A client sees three of the five fields.** A call arriving at a client carries `callChain`,
  `originAuth` and `state`. The Gateway leaves `originRequest` behind deliberately, for the reason
  in its comment above.
- **Leaving `callee` behind was never decided.** Every server-side node stamps `callee` itself,
  from its own identity, as a call arrives, and the client's receive path never got the same line.
  So the fix is on the client rather than in the Gateway (→ D6).
- **The one field a Client writes is `state`.** Its call WS message has no place for the others, so
  the Gateway builds them. A node that caches an authorization decision in `state`, as
  `.claude/rules/mesh.md` recommends, can therefore meet a value a Client chose (→ D19).

### Gateway

The Gateway is a Durable Object that holds one tab's WebSocket. With its client it makes the
equivalent of one server-side node (→ D20). Nebula's is `NebulaClientGateway`, at the binding
`NEBULA_CLIENT_GATEWAY`. A call going **upstream** is a client calling a node through
its Gateway; one going **downstream** is a node calling a client.

- **Connecting**
  - **Every tab gets its own Gateway, named `{sub}.{tabId}`**, such as `8f3c….a1b2c3d4`. The client
    picks the name: `sub` from its token, and `tabId` an 8-character id kept in the tab's
    `sessionStorage`, so a reload reaches the same Gateway. A duplicated tab inherits that
    `sessionStorage`, so on load the client asks over a `BroadcastChannel` whether another tab
    already holds the id, and mints a new one if so (`packages/mesh/src/tab-id.ts`; → D17). An
    impersonation client in the same tab gets a Gateway of its own,
    `{subjectSub}.{parentTabId}.{scope with dashes}`, such as `5d2e….a1b2c3d4.acme-crm-bigco` (→ D7). A persona's tab is not one of these: it is
    an ordinary Client with a token of its own, named `{personaSub}.{tabId}`.
  - **The Gateway accepts a name only if it starts with the token's `sub`.** The text before the
    first `.` must equal it, or the upgrade gets a 403.
  - **A new connection replaces the old one.** The Gateway closes the existing socket with code 4409
    before accepting the new one, so it never holds two.
  - **The Worker verifies the token, and the Gateway only decodes it.** The client sends its token
    as a WebSocket subprotocol, `lmz.access-token.{token}`, beside the protocol name `lmz`.
    Nebula's Worker runs `verifyNebulaAccessToken` from `onBeforeConnect` in
    `apps/nebula/src/entrypoint.ts`: the signature, `exp`, `iss`, that `aud` sits at or below
    `authScope`, and that a plain membership's `aud` equals its `authScope`. It then forwards the
    upgrade with the token as `Authorization: Bearer`.
  - **The decoded claims live in the socket's attachment for the life of the socket.** An
    attachment is a small value, at most 2 KB, stored with a hibernatable WebSocket, so it survives
    the Gateway hibernating. It holds `sub`, the Gateway's own `bindingName` and `instanceName`,
    `claims`, and `originRequest`. A new token therefore means a new socket. Before sending on a
    socket whose token has under 30 s left, the client reconnects with a fresh one.
  - **An expired token closes the socket.** The Gateway checks `claims.exp` on every message the
    client sends. Once it has passed, the Gateway closes the socket with code 4401 and drops that
    message unanswered, and the client reconnects with a fresh token.
  - **A closed socket starts a 5 s grace period**, during which a call or an answer heading down to
    the client waits for it to come back. A reconnect inside it is told
    `connection_status { subscriptionRequired: false }`, and one after it `true`. `NebulaClient`
    ignores the flag and re-subscribes on every reconnect.
  
- **Upstream calls** — a client calls a node
  - **A client makes a call in one of three forms**, and each gets a fresh `callId`:
    - `lmz.call(binding, instance, remote)` fires and forgets. The client keeps nothing, sends
      `expectsResult: false`, and the node discards its result. D15 removes this form (→ D15).
    - `lmz.call(binding, instance, remote, handler)` provides a result handler continuation. The
      client keeps the handler continuation in memory under the `callId`, and sends `expectsResult: true`. Between two server-side nodes, the continuation travels with the call instead (→ D11).
    - `await lmz.callAsync(binding, instance, remote)` returns a Promise. The client keeps the
      Promise's `resolve` and `reject` in memory under the `callId`, and also sends
      `expectsResult: true`. Between server-side nodes this form does not exist. D16 keeps it (→ D16).
  - **Neither a handler continuation nor a Promise is ever sent; both stay in the tab.** So on the wire the last
    two forms are the same message:
    ```ts
    { type: 'call', callId: '5e0b…', binding: 'STAR', instance: 'acme.crm.bigco',
      chain /* serialized operations */, expectsResult: true, callContext: { state: {} } }
    ```
  - **`callAsync` is the one awaitable `.claude/rules/mesh.md` allows**, and only on a client,
    because a tab's memory survives a reconnect while a Durable Object's does not survive
    hibernation.
  - **The instance name becomes the client's address.** It goes into the call as
    `callChain[0].instanceName`, as `metadata.caller`, and as the return address for the answer. A
    node that keeps the caller, as a subscribe does, later reaches the tab with
    `lmz.call('NEBULA_CLIENT_GATEWAY', '8f3c….a1b2c3d4', …)`. The name carries no authority;
    authorization reads `originAuth`.
  - **To the node, the call came from the client, not the Gateway.** `callChain` is the client
    alone, addressed by the Gateway's binding, and the Gateway itself appears nowhere in it. From
    here on it is an ordinary mesh call, and each hop appends itself.
  - **The Gateway forwards to whatever binding and instance the client names**, checking neither.
    The node's own layers, from `onBeforeCall` (M3) on, are the whole defence.
  - **The envelope carries no result handler continuation, because the client's never leaves the tab.** In its
    place the envelope's `response` tells the node where to send the bare answer:
    
    ```ts
    {
      version: 1,
      chain,               // passed through as the client serialized it
      callContext,         // as in § callContext above
      metadata: {
        caller: { type: 'LumenizeClient', bindingName: 'NEBULA_CLIENT_GATEWAY', instanceName: '8f3c….a1b2c3d4' },
        callee: { type: 'LumenizeDO', bindingName: 'STAR', instanceName: 'acme.crm.bigco' },
      },
      response: {          // present only when expectsResult is true
        kind: 'client',
        returnAddr: { type: 'LumenizeClient', bindingName: 'NEBULA_CLIENT_GATEWAY', instanceName: '8f3c….a1b2c3d4' },
        callId: '5e0b…',
      },
    }
    ```
  - **The Gateway waits only for the node's early ack**, and is then free to hibernate or be
    evicted. The answer arrives later as a separate Workers RPC, which wakes it.
  
- **Responses to upstream calls**
  - **The early ack carries every refusal made before the call's OCAN chain is executed.** Cloudflare's
    own failures land here, such as the Durable Object being overloaded or reset, and so do ours:
    
    - a binding the Worker does not declare, or a Durable Object with no `__executeOperation`, such
      as the auth Registry;
    - a chain that fails to deserialize;
    - a throw from the node's `onBeforeCall`. In Nebula that is passage, whose refusal names both
      scopes, as in `No passage from "acme.crm.bigco" into "acme.crm.other"`. The reserved platform
      name and an unparseable name are refused with messages of their own (→ D9).
    
    The Gateway turns any of them into a `call_response` with `success: false` for that `callId`.
    
  - **Everything after the ack comes from the node's own code**, which answers with a second Workers
    RPC, to the Gateway's `__handleResponse`:
    - **`@mesh()` refusals**, such as `"Member 'x' is not mesh-callable…"` or
      `"No member named 'x' exists on this node…"`, and the refusal of a chain naming
      `constructor` or `__proto__`.
    - **Guard refusals**, whatever each guard throws. `requireDominionHere` throws
      `'Admin access required'` to a caller who is no admin at all. A Star's admin calling its
      Galaxy gets past passage, since upward is free, and is then refused with
      `'Admin access required for acme.crm — the calling host's scope is acme.crm.bigco, and the token rests on the membership at acme.crm.bigco'`.
    - **Errors the method throws.** A single Resources read without the grant throws
      `PermissionDeniedError`, carrying `tier: 'read'` and the `nodeId`. `NodeNotFoundError` and
      `OntologyStaleError` come back the same way (`apps/nebula/src/errors.ts`).
    - **A value, most of the time, and a refusal can be one.** A transaction catches each
      `PermissionDeniedError` and returns
      `{ ok: false, errors: { [resourceId]: { type: 'permission', requiredTier: 'write', nodeId } } }`,
      which the mesh delivers as a success.
    
  - **The node serializes the answer with `@lumenize/structured-clone`**, Errors included, and
    sends it bare: `{ callId, clientInstanceName, $result }` or `{ callId, clientInstanceName,
    $error }`. No continuation and no `callContext` travel with it. This is the one branch in the node's
    `fireResponse` that depends on who called: for a node caller it fills the handler continuation with
    the result and fires the filled chain back.
    
  - **The Gateway sends it down the client's current socket without deserializing it**, as
    `{ type: 'call_response', callId, success, result }` or `{ …, success: false, error }`. With no
    socket, it waits out whatever is left of the grace period, then drops the answer with a log line
    and still replies `{ $ack: true }` to the node, the same reply as for a delivered answer. The
    node never learns the answer was lost.
    
  - **The Gateway changes no `callContext` here, because the answer carries none.** Its passage
    check on calls heading down to a client does not run on this leg either (→ D12).
    
  - **The client matches the answer to its call by `callId`.** It minted the `callId` with
    `crypto.randomUUID()` and stored the handler continuation or the Promise under it, as in the second and
    third forms above. An answer settles the Promise, or runs the handler.
  - **A handler runs under the `callContext` the client had when it made the call.** That is none,
    unless the client made the call while handling a call a node made to it; then it is that
    incoming call's context.
  - **Delivery deletes the stored entry, and an answer that finds no entry is dropped.** That
    happens in two cases. A second copy of an answer already delivered finds its entry gone. And a
    fire-and-forget call never had an entry: the node sends it no answer, but the Gateway still
    sends one down when the call is refused at the early ack.
  - **An answer the Gateway dropped is never sent again.** A `callAsync` Promise rejects at its
    default 30 s timeout. A result handler never runs, and its continuation stays in memory until the client is
    explicitly disconnected.
  
- **Downstream calls** — a node calls a client
  - **A node calls a tab the way it calls any node**, by the tab's address:
    `lmz.call('NEBULA_CLIENT_GATEWAY', '8f3c….a1b2c3d4', ctn<NebulaClient>().x(…))`. Most such calls
    come from `lmz.broadcast`, which makes one `lmz.call` per subscriber.
  - **The node's own `lmz.call` builds the envelope.** A subscription update starts a fresh chain,
    since `lmz.broadcast` defaults to it, so it carries the sending node in `callChain` and no
    `originAuth`. Any other call to a tab inherits the call the node is running, with the node
    appended, unless it asks for `newChain: true`.
  - **The Gateway's `__executeOperation` is its own code, not the shared receive path.** Nothing
    stamps its identity, and no `onBeforeCall` runs. In order, it:
    1. refuses an envelope whose version is not 1;
    2. finds the open socket. With none, it waits for a reconnect if the grace period is running,
       and otherwise answers `ClientDisconnectedError`;
    3. answers `ClientTokenExpiredError` if the connection's token has expired, closing the socket
       with 4401 (→ D5);
    4. runs `onBeforeCallToClient`. Nebula's checks the tab's passage into the sender's scope, the
       sender being `callChain.at(-1)`. A client sender's scope is its claims' `aud`, and a node's is
       its name when that parses as a scope. A sender named by an id, such as the Profile `1a9d…`,
       is not checked. A refusal reads `No passage from "acme.crm.bigco" into "acme.crm.other"`
       (→ D12);
    5. sends the client `{ type: 'incoming_call', callId, chain, callContext: { callChain,
       originAuth, state } }`, under a `callId` the Gateway mints for this call.
  - **This is the one hop that does not ack early.** The Gateway holds the node's RPC open until the
    client answers, for up to 30 s after sending, and the node stays awake for as long (→ D11).
  - **The client asks only who made the last hop.** Its default `onBeforeCall` refuses a call whose
    `callChain.at(-1)` is another client, and never reads `originAuth`. D13 drops that refusal,
    and D14 guards `NebulaClient`'s update handlers instead (→ D13, D14). The chain's first operation must then be
    `@mesh()`-decorated, and its guard runs.
  
- **Responses to downstream calls**
  - **The node's result handler continuation never leaves the node.** Here the node is still awake, awaiting the
    Gateway's reply, when the answer arrives, so the envelope's `response` goes unused and the node
    runs its handler itself (→ D11).
  - The client answers `{ type: 'incoming_call_response', callId, success, result }` or
    `{ …, success: false, error }`, serialized with `@lumenize/structured-clone`.
  - **The Gateway returns that answer as its reply to `__executeOperation`**, `{ $result: value }`
    or `{ $error }`. It ignores the envelope's `response`, so nothing is fired back later.
  - **The node's dispatch reads the reply as an ack.** `{ $error }` runs the node's handler on the
    spot, with `callContext.callee` naming the tab it called, which is how a subscription reaper knows whom to
    drop. `{ $result }` looks like an ordinary ack, so the value is thrown away and the handler
    never runs (→ D11, D3).
  - **A returned Error is dropped with the values.** A client method that throws answers
    `success: false`, and the Gateway replies `{ $error }`. One that returns an Error answers
    `success: true` with the Error as its value, and the Gateway replies `{ $result }`. Between
    server-side nodes both reach the handler, which cannot tell them apart, except that a handler
    asking for errors only skips the returned one (→ D11).
  - **These errors can come back:** `ClientDisconnectedError`, for no socket, a missed reconnect or
    a 30 s timeout; `ClientTokenExpiredError`; the Gateway's passage refusal; the client's
    `'Direct client-to-client calls are disabled by default…'`; a `@mesh()` refusal; and whatever
    the client's method throws.
  - **A slow client reads as a dead one.** The 30 s timeout answers `ClientDisconnectedError`, the
    class every reaper drops a subscriber on, so a tab that takes 31 s to handle an update loses its
    subscription. D11 keeps that verdict (→ D11).
  - **The Gateway leaves the slow tab's socket open.** A tab whose JavaScript was paused, as a
    browser may pause a background tab, wakes with the same socket, so it never reconnects.
    `NebulaClient` re-subscribes only on a reconnect, so that tab stops receiving the updates it was
    dropped from, with nothing to show it (→ D4).
  - **No `callContext` comes back, and none needs to.** The handler runs under the node's own
    outgoing `callContext`, with `callee` set to the tab. That is the context any server-side
    node's handler gets when it runs locally, as it does after a refusal at the early ack.

## A result handler continuation travels with every call

A Client and its Gateway together are the equivalent of a server-side node (→ D20). The Gateway, a
Durable Object, decides passage and does the transport work a node's framework does inside a node;
the Client, in the browser, does the rest. So a Client's result handler continuation travels with
its call, as a node's does, and a Gateway that receives a call keeps that call's continuation
(→ D11). One rule holds the design together: **a result handler continuation is never seen by a
Client other than the one that wrote it.** A filled continuation runs at its author's fire-back
door, `__handleResponse`, with the `@mesh()` check off, so whoever can change it on the way chooses
code its author runs.

The three directions come first, then the two changes they need where a node receives its own
fire-back, then the messages on the wire.

### A Client calls a node

- **The continuation goes to the node and comes back to the Client that wrote it.** The Client
  sends its result handler continuation in the `call` message. The Gateway puts it in the envelope as
  `response: { kind: 'mesh', returnAddr: <this Client>, handler }`. The node fills it with the
  result and fires it back to the Gateway's `__handleResponse`, which sends it down to the Client.
- **It is safe because the Gateway writes `kind` and `returnAddr`, and the Client writes only the
  continuation.** A hostile Client can put any chain in its continuation, but it can only aim that chain at
  itself. The node never runs the handler: `fireResponse` fills the continuation and sends it on.
- **A refusal at the early ack takes the same road back.** Where a node's dispatch would run its
  own handler with the Error, the Gateway fills the Client's continuation with it and sends it down.
- **The node answers a Client exactly as it answers a node.** `kind: 'client'`,
  `ClientResultEnvelope` and the `call_response` message go, and `fireResponse` loses its one
  branch that depends on who called.
- **The continuation leaves the tab's memory.** Its handler runs under the fire-back's `callContext`, as a
  node's does, so the Client's saved call-site context goes too. A result that lands after a reload
  runs on the reloaded Client, the way a Durable Object's handler runs on a cold instance.
- **`callAsync` keeps only its Promise in the tab** (§ *On the wire*, → D16).

### A node calls a Client

- **The Gateway keeps the node's continuation, and the Client never sees it.** Sending it down and back
  instead would let a hostile Client swap it for any chain, which the node would run with the
  `@mesh()` check off: `.claude/rules/mesh.md` names `resourcesResults.onOntologyPulled` as the
  member that would then install a validator of the caller's choosing.
- **The Gateway acks once the envelope's version checks out, before it looks for a socket.** Every
  later outcome ends in a fire-back to the node's `__handleResponse`: a missed reconnect, D5's
  reconnect after an expired token, D12's passage refusal, the 30 s timeout, and the Client's
  answer, which the Gateway fills into the continuation the way `fireResponse` does. So a refusal and an
  answer reach the node by the same road.
- **The Client's side does not change.** The Gateway still sends `incoming_call` under a `callId` it
  mints, and pairs the Client's `incoming_call_response` by that `callId`.
- **The Gateway holds the continuation in memory while the Client answers, up to the 30 s timeout,
  and while it waits within the grace period for a reconnect (D5).** It already holds each pending
  call that long, under a timer that keeps it resident; the grace-period wait sets no timer of its
  own. If it is evicted mid-wait, the node's handler never runs, where today the node's call fails and its handler runs
  with the error. For a reaper that means a dead subscriber's row lasts until the next update finds
  no socket. (Two other 30 s values are unrelated: `callAsync`'s default timeout, and how early a
  client refreshes its token.)
- **A returned Error now reaches the node's handler, as it does between nodes,** because the Gateway
  fills the continuation the way `fireResponse` does.
- ⚠️ **Design consideration:** build the keep, fill, time-out and 4408 logic as code a Durable Object
  composes, so the master plan's Open decision 4 would move it rather than rewrite it.

### A Client calls another Client

- **The callee's Gateway keeps the continuation, exactly as when a node calls a Client.** Gateway 1
  builds the envelope with Client 1 as `returnAddr`. Gateway 2 keeps the continuation, asks Client 2,
  fills it and fires it to Gateway 1, which sends it down to Client 1. If Client 2 saw the continuation,
  it could make Client 1 run any of Client 1's own methods with the `@mesh()` check off.
- **So one rule covers both: a Gateway that receives a call keeps its continuation, whoever sent it.**
  Client 2 no longer refuses a call from another Client by default, and guards its own methods
  (→ D13).

### What changes where a node receives its own fire-back

Two things must change at a node's fire-back door, `__handleResponse`, before a fire-back from a
Gateway can work.

1. **`callee` on the response leg names the node that answered.** At `__handleResponse`,
   `executeEnvelope` sets `callee` to the receiving node itself, so a reaper would read the
   broadcaster's own name and delete nothing. The old broadcast tier failed exactly this way
   (`tasks/backlog.md`'s row on rebuilding a broadcast tier). The fix takes `callee` from the
   fire-back's last hop, which the answering node's framework writes, or its Gateway for a Client.
   Five reapers depend on it: the Resources plane's `onBroadcastResult`, `onQueryBroadcastResult`,
   `onQuerySubscriberListBroadcastResult` and `onTreeBroadcastResult`, and the Profile's
   `onProfileBroadcastResult`. D6 is the Client's half, and the change retires `broadcast.ts`'s
   warning that the two paths differ.
2. **A chain a node started has an `activeScope`, so its fire-back is admitted** (→ D10). Every
   subscription update now starts a fresh chain, so its fire-back carries no claims, and
   `NebulaDO`'s `onBeforeCall` refuses a call with none. The rule covers any call on a chain a node
   started, an alarm's included; the fire-back is just the first caller that needs it. Passage reads one derived value, the
   call's `activeScope`, *where it is acting right now*:
   - **A call carrying claims:** the claims' `aud`. A tab on `https://bigco.crm.acme.lumenize.dev/`
     calls with `aud: 'acme.crm.bigco'`.
   - **A chain a node named by a scope started:** that name, held as a plain member. The Star
     `acme.crm.bigco` broadcasting from an alarm has passage into `acme.crm.bigco`, `acme.crm` and
     `acme`, and dominion over nothing. Its fire-back's `callChain` is
     `[Star acme.crm.bigco, the tab]`, so it is the Star calling itself, and it passes.
   - **A chain a node named by an id started:** none. The Profile `1a9d…` starts its updates fresh,
     and its name does not parse as a scope, so a `NebulaDO` refuses a call on that chain, as it
     refuses one with no claims today.
   - **A Client never starts a claimless chain.** Its Gateway puts the Client first and stamps its
     claims, so a Client cannot borrow a node's scope.

### On the wire

The messages between a Client and its Gateway, after D11 and D15:

```ts
// Client → Gateway: a call. expectsResult goes, and every call names a handler (D15).
// callId stays: the onSent option hands it to instrumentation, and callAsync keys on it
// It carries no callContext: the Gateway builds all of it, with state empty (D19)
{ type: 'call', callId: '5e0b…', binding: 'STAR', instance: 'acme.crm.bigco',
  chain, handler, onErrorOnly /* optional */ }

// Gateway → node: the envelope's response, which the Gateway writes, never the Client
response: { kind: 'mesh', returnAddr: <this Client's identity>, handler, onErrorOnly }

// Gateway → Client: a filled continuation, from a node's fire-back or a refusal at
// the early ack. The Client runs it as a node runs __handleResponse: onBeforeCall
// on, the @mesh() check off, and callee set from the chain's last hop (D6).
// No state reaches a Client (D19)
{ type: 'response', chain, callContext: { callChain, originAuth } }

// Gateway → Client and back: unchanged but for state. The Gateway keeps the node's
// continuation under this callId
{ type: 'incoming_call', callId, chain, callContext: { callChain, originAuth } }
{ type: 'incoming_call_response', callId, success, result /* or error */ }
```

- **What goes:** `call_response`, `ClientResultEnvelope`, `kind: 'client'`, the `call` message's
  `expectsResult` and `callContext`, and `state` on every message down to a Client.
- **`callAsync` keys its Promise by the call's `callId`.** It keeps the Promise under that id, and
  sends as its continuation a call to a `LumenizeClient` method with no `@mesh()`, taking the id and the
  result. A `response` that finds no Promise under its id, after a reload or a timeout, is
  dropped.
- **The protocol name becomes `lmz.2`.** A Client bundled before the change offers only `lmz`, so
  its upgrade fails and it retries with backoff until its page reloads. The wipe rebuilds every
  app, so no stale bundle survives this change.
- ⚠️ **Design consideration:** that hard break is licensed only by the wipe. After launch, a wire
  change needs a Gateway that speaks both versions for a window, or a platform-run rebuild of every
  app, because nothing in a new client reaches bundles already shipped.

### What it costs

- **Bytes.** A Client's continuation crosses the wire twice, out with the call and back in the
  fire-back.
- **A wire change.** A generated app bundles the Client, so an app built before the change must be
  rebuilt to talk to a new Gateway.
- **A held Gateway.** A Gateway stays resident while it holds a continuation: up to 30 s for its
  Client's answer, plus any grace-period wait. Under Open decision 4 that hold would land on a
  scope's node.
- **A wider door.** `NebulaDO` admits a call with no claims when `callChain[0]` is a node named by a
  scope, with passage into that scope and its ancestors and no `scopeAdmin` (→ D10).

## What changes in standing guidance

The vision doc, the ADRs and `security.md` already describe the target, each with a *Today's code
differs* block where the code lags (→ D18). The build does two things to standing guidance.

**It removes these blocks, each in the phase that closes it:**

- `docs/vision/auth.md` § *Lumenize Nebula mesh*, opening "On a call to a client, the Gateway holds" (D11).
- `docs/vision/auth.md` § *How the claims travel*, opening "A chain a node started carries no claims", cut sentence by sentence as D10, D13 with D14, and D19 land.
- `docs/adr/003-continuation-messaging.md` § *When awaiting is OK*, opening "On a call to a client, the Gateway returns" (D11, D15).
- `docs/adr/015-passage-and-dominion.md` § *Predicate pair*, opening "A chain a node started carries no token" (D10).
- `.claude/rules/security.md`'s ⏳ line under the JWT bullet (D10).

The `_platform` blocks in `auth.md` § *Coarse-grained access control* and ADR-015 § *Context* stay,
because a different change closes them. ADR-022 carries none.

**It fixes everything else the code makes false, in the phase whose code makes it false.** That
phase's criterion is a grep across `.claude/rules/`, `website/docs/`, `packages/mesh/src`,
`apps/nebula/src` and `packages/nebula-auth/src` that comes back clean for the terms its decision
retires: a call with no handler or an `undefined` one (D15), `client-to-client` (D13), a client
passing `state` or `newChain` (D19), the `lmz` protocol name and "answers inside its ack" (D11),
`ClientTokenExpiredError` (D5), and the 30 s wait and `subscriptionRequired` (D4, D5). At the time
of writing those greps would find:

- **`.claude/rules/mesh.md`:** § *`call()` + a continuation is the ONLY cross-node call surface*, § *Passing data to the callee*, § *Object-capability access: gate once, then chain*, § *`lmz.call` 4-arg — the result-handler mechanics*, § *Fire-and-forget error delivery*, and § *`LumenizeClientGateway` is NOT a mesh participant* (D3).
- **`website/docs/mesh/`:** `calls.mdx`, `lumenize-client.mdx`, `protocol.mdx`, `mesh-api.mdx`, `broadcast.mdx`, `managing-context.mdx`, `gateway.mdx` (its "simply forwards", and its timeout, token-expiry, resubscribing and connection-state sections), `index.mdx` and `lumenize-worker.mdx` (three-argument calls inside `@skip-check-approved` blocks, which the example checker never reads), `getting-started.mdx`, and `security.mdx` (the protocol name).
- **`website/docs/nebula/nebula-client.md`**, which Studio's model reads as `.platform/docs/nebula-client.md`. Its override paragraph tells the model a subclass override needs a bare `@mesh()`, which after D13 leaves the override open to pushes from peer tabs, so it must say what D14 requires.
- **JSDoc:** `requirePassage`; the Client's and `broadcast.ts`'s broadcast warnings; the Gateway's class comment; and the reaper comments in `apps/nebula/src/resources.ts` and `packages/nebula-auth/src/profile.ts` that say a Gateway answers inside its ack.

## Decisions

Every row is Larry's call. The D-numbers are append-only, and the prose above points at them with (→ Dn) where it describes the problem each one fixes. D1 and D2 were withdrawn; D11 replaced both.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D3 | **`.claude/rules/mesh.md` is corrected in the same change as D11** (Larry, 2026-09-30). § *`lmz.call` 4-arg — the result-handler mechanics* says a Client's result handler continuation travels as a node's does, and its line calling the Gateway "the one deliberately-awaited hop" goes. Its Gateway section is retitled *`LumenizeClientGateway` is the server-side half of a Client* and opens with two requirements (Larry, 2026-10-04). The Gateway honors every transport rule a node's framework honors, on its Client's behalf: it acks early, keeps the continuation, fills it and fires the answer back. And it never appears in a `callChain`, holds no `@mesh()` members, and decides nothing that belongs to the Client, its one check being passage on what it sends down (→ D20). | **Correcting it first** — it would describe a Gateway that does not exist yet. **Leaving it** — it tells every session a Client's own error never arrives, which is false today and stays false. |
| D4 | **The Gateway closes the socket with code 4408 when a Client misses the 30 s wait** (Larry, 2026-09-30), so the tab reconnects and re-subscribes when it wakes. 4408 echoes HTTP 408 Request Timeout, as 4401 and 4409 echo 401 and 409. Since the miss has already dropped the tab's subscriptions, its next connection must be told `subscriptionRequired: true`, even when it arrives within the grace period. | **Leaving the socket open, as today** — a paused tab wakes with the same socket and never re-subscribes, so it stops receiving updates with nothing to show it. **Re-subscribing on `visibilitychange`** — the tab would re-subscribe every time someone returns to it, dropped or not, and only the Gateway knows it gave up. |
| D5 | **On a downstream call to a socket whose token has expired, the Gateway closes the socket with 4401, waits within the grace period for the Client to reconnect with a fresh token, and delivers on the new socket.** A missed reconnect answers `ClientDisconnectedError`, and `ClientTokenExpiredError` is deleted, since this path is its only source (Larry, 2026-09-30). | **Answering at once, as today** — the update is lost though the Client is back in moments. **Dropping the expiry check** — it is what keeps a revoked user's open socket from receiving updates after their token expires, since a revoked user cannot refresh and so cannot reconnect. |
| D6 | **A Client stamps `callContext.callee` itself, as every server-side node does** (Larry, 2026-09-30): its own identity on an incoming call, and the node that answered when a result handler runs, from the fire-back's last hop as D11 has every node do. | **The Gateway sending `callee` down with the call** — every other receiver takes `callee` from its own identity, never from the wire, and the Client already knows its own. |
| D7 | **`NebulaClient.impersonate` refuses a child whose Gateway name a live child of the same parent already holds, and the name keeps today's shape, `{subjectSub}.{parentTabId}.{scope with dashes}`** (Larry, 2026-09-30; re-derived 2026-10-04). One parent has one scope, the one its host spells, so a name repeats only when the same subject is impersonated twice from one parent, and the second socket would replace the first with 4409. The scope segment no longer tells children apart. What it does now is give a child's name a different shape from any real tab's, `{sub}.{tabId}`, so a child cannot collide with the subject's own tab and a Gateway log tells an impersonation apart. **Parked until the master plan's Open decision 4 settles**, since it is about Gateway names; if a Gateway per tab survives it, first check whether one change to how a client reacts to 4409 covers both this and D17. | **Handing back the existing child** — the second caller would get a session the first can end. **Joining the scope's slugs with `--`** — it separated two scopes that spell the same name, and one parent can no longer produce two. **Dropping the scope segment** — a child's name takes a real tab's shape, so it collides with the subject's own tab on a 1-in-2³² draw, the two sockets then replace each other with 4409 in a loop, and a log cannot tell them apart. |
| D8 | **The Gateway's `#getInstanceName` is deleted** (Larry, 2026-09-30). Nothing calls it. | **Keeping it** — every reader of the trust boundary's source would have to work out that it is unused. |
| D9 | **`requirePassage`'s refusal names passage and both scopes, and the reserved platform name gets a refusal of its own** (Larry, 2026-09-30). Built 2026-10-04 by `archive/nebula-scope-moves-to-subdomain.md`, which carries the rejected alternatives. | — |
| D10 | **A call chain started by a node whose name is a scope acts as a plain member of that scope** (Larry, 2026-09-30): passage into the node and its ancestors, and no `scopeAdmin`. The key is that the name is a scope, not which binding the node has, so a future helper node named by a scope is covered. It applies only to a call carrying no claims, which no Client can make, since its Gateway stamps claims on every call. `parseId` decides whether a name is a scope, and it refuses every id-shaped name because a slug is capped at 30 characters and a UUID is 36; `packages/nebula-auth/test/parse-id.test.ts` pins that for a `profileId`, a persona's id and a Gateway's `{sub}.{tabId}`. It grants nothing a caller did not already have, since anyone with passage into a node has it into the node's ancestors. ADR-015 and `auth.md` widen `activeScope` to say so, and every definition of it says host, never page (Larry, 2026-10-04). Nothing writes a synthetic `aud` into `originAuth`. The cases are in § *What changes where a node receives its own fire-back*. | **Admitting only a chain the node started itself** — it covers the fire-back and nothing else, for the same code as the general rule. **Adding dominion over the node's own subtree** — a real grant of power nothing asks for yet. **Keying on the binding, Universe, Galaxy or Star** — a list a new node named by a scope would fall off. **Changing nothing, so the Gateway keeps answering inside its ack** — the late-ack transport ADR-003 rejects. **Keeping `activeScope` as the token's `aud` alone, with D10 as a second admission rule** — passage would read two inputs, described in two places, for the same code. **A new term for the derived value** — new vocabulary for a value that equals `activeScope` whenever a token is present. **Writing the node's scope into `originAuth` as a synthetic `aud`** — `originAuth` means claims a verified token carried, and ADR-016 would record a principal who never held one. `OriginAuth` would need a made-up `sub`, the one key ADR-013 allows. And mesh cannot tell which names are scopes, so node code would need a way to set `originAuth`, which the old broadcast tier's design deliberately avoided: it carried the broadcaster's identity as data so that nothing could set `originAuth` (`tasks/backlog.md`'s row on rebuilding a broadcast tier). |
| D11 | **A Client's result handler continuation travels with its call, as a node's does, and a Gateway that receives a call keeps that call's continuation** (Larry, 2026-09-30). No Client ever sees a continuation it did not write; a Client that misses the 30 s is treated as gone. `kind: 'client'`, `ClientResultEnvelope`, the `call_response` message and the late-ack wait all go. The Gateway fills a continuation with the code `fireResponse` uses, factored out of it so a class extending `DurableObject` can call it, never a copy (ADR-007). How the continuation is held while the Client answers, in memory under a timer as today's pending calls are or persisted and timed out on an alarm, is chosen together with the master plan's Open decision 4, which may move the hold onto a scope's node. The mechanics are in § *A result handler continuation travels with every call*. | **The Gateway answering inside its ack, plus a fix for the value it drops** — the late-ack transport ADR-003 rejects, holding the node awake for the tab's round trip. **Upstream only** — keeps that conflict on every call to a tab. **Amending ADR-003 to carve out the Gateway's hop** — keeps the cost and adds an exception. **Sending the node's continuation down to the tab, signed by the Gateway** — a signing key and a check on every answer, to avoid holding what the Gateway already holds today. |
| D12 | **The Gateway checks the tab's passage into the sender's scope on every call it sends its Client, replacing the `aud` fence** (Larry, 2026-09-30). Built 2026-10-04 by `archive/nebula-scope-moves-to-subdomain.md`'s phase *A push speaks for the node, not the writer*, which carries its example and rejected alternatives. **No check runs on answers** (Larry, 2026-10-04). An answer goes only to the tab whose call it answers, at the `returnAddr` that tab's own Gateway wrote, in that tab's own continuation, and its passage was decided on the request. For a node's answer the check would repeat the node's own `requirePassage`, and for another Client's answer the fire-back carries the asking tab's claims, so it would compare the tab with itself. | **Checking answers too** — it could never refuse one. **Checking that a fire-back's chain is a continuation the Gateway wrote** — the Gateway would keep a copy of every continuation sent upstream, the in-tab state D11 removes. |
| D13 | **A Client accepts calls from other Clients, and defends itself by composing guard functions, as a server-side node does** (Larry, 2026-09-30). `LumenizeClient.onBeforeCall`'s default refusal goes, so it is a no-op like a node's, and the mesh docs' class-wide opt-in example goes with it. **What protects a tab is what protects a node** (Larry, 2026-10-04). In Nebula that is passage at its Gateway, and `@mesh()` and guards on its methods. In the MIT package it is `@mesh()` and guards, as for a Durable Object, whose base `onBeforeCall` is also a no-op. A tab's address being hard to come by is a bonus, not a layer: a roster carries `sub` and `profileId` and no `tabId`, a `tabId` is 8 random hex characters, and since every subscription update starts a fresh chain, no update hands the writer's tab address to its subscribers. MIT clients have written unguarded push handlers while peers were refused, so the mesh docs' client access-control section leads with `@mesh(requireServerSideCaller)` on a push handler, and the BREAKING note names that guard. | **Keeping the default refusal** — too defensive, and all-or-nothing: overriding it to allow cursors also opens `handleResourceUpdate`. **A per-method opt-in on `@mesh()`** — it widens the decorator from a guard function to an options object. **A second decorator for peers** — new vocabulary for a job a guard function already does. **Keeping the refusal as the MIT default, with `NebulaClient` opening it** — one Client-only default unlike any node's, so calls between Clients would behave like calls between nodes only in Nebula. **An MIT Gateway refusing Client senders unless the Client opts in** — a second opt-in doing a guard function's job. |
| D14 | **Mesh exports a guard, `requireServerSideCaller`, that throws when a call's immediate caller is a Client, and each of `NebulaClient`'s update handlers composes it** (Larry, 2026-09-30). The seven are `handleResourceUpdate`, `handleProfileUpdate`, `handleOrgTreeUpdate`, `handleQueryUpdate`, `handleQuerySubscribersUpdate`, `handleStreamChunk` and `handlePreviewReady`, each becoming `@mesh(requireServerSideCaller)`. Under D13's model they keep exactly today's protection against a tab in the same scope spoofing an update. | **Leaving them unguarded** — they would rest on another tab not having the address, less than today's protection on the one surface where spoofing matters. **`requireNodeCaller`** — a Client is a node too. **`refuseClientCaller`** — `coding-style.md` makes `require*` the verb for a guard that throws. **`requireTrustedCaller`** — "trusted" is vague in an MIT package, where a user's own server-side node is not necessarily trusted. **`requireDOOrWorkerCaller`** — a list a new server-side node type would fall off. |
| D15 | **The three-argument `lmz.call` goes, for every node type: every call names a result handler, and fire-and-forget is a handler with `onErrorOnly`** (Larry, 2026-09-30). Every `lmz.call` or `lmz.broadcast` that passes no handler gains one, including those made through a wrapper. At the time of writing that is `NebulaClient`'s subscribes and unsubscribes, through `#hostCall` or straight to the Profile; `Galaxy`'s preview-ready nudge; the Profile's first snapshot to a new subscriber; and the six `Resources` sends whose `#send` passes no `onResult` (a refused subscribe's stale notice, `#notifyStale`, a stream chunk, the tree's first snapshot, and a resource's first snapshot and its error). A first snapshot takes the reaper its broadcasts already use, so a subscriber whose tab is gone is dropped; a stream chunk takes a logging `onErrorOnly`. `#send`'s `onResult` becomes required, and so does `lmz.broadcast`'s, so a site the build misses fails to compile. A refused subscribe reaches the tab at once as its Error, and `#subscribeVia`'s timer stays for a host that never answers. The `discard` kind of fire-back, the no-handler branches in `dispatchEnvelope` and `fireResponse`, the Client's `expectsResult` flag and the Gateway's branch for a call without one all go. `packages/fetch`'s two source sites, in `fetch.ts` and `fetch-executor-entrypoint.ts`, get an error handler that logs, and any of its tests that break are skipped rather than fixed, since that package is headed for deprecation. | **Keeping it, and adding the Client's missing log line** — a refused subscribe would still be noticed only when a timer gives up, and the Profile's row would still leak. **Keeping it as shorthand whose errors go to one hook per node** — new API and vocabulary, and it takes the handling away from the call site that knows what the call was for. |
| D16 | **`callAsync` stays public on `client.lmz`, built on D11's travelling continuation: one message on the wire, two spellings in code** (Larry, 2026-09-30). Only the Promise and its timeout differ from a result-handler call (§ *On the wire*). `callAsync`'s JSDoc in `packages/mesh/src/lumenize-client.ts` states this, since it is already true today. The code Studio's model writes never calls it: the platform docs teach `await client.resources…` and mention `callAsync` nowhere, and every `callAsync` call sits inside `NebulaClient`. | **Only inside a Client subclass, for building an SDK** — it would narrow ADR-003's user-land awaiting to SDK methods, and third-party mesh users would lose the awaitable. **Removing it, so SDK methods take callbacks** — it fights the training wherever the platform docs teach `await client.…`, and amends ADR-003. |
| D17 | **A tab keeps its `tabId` in `sessionStorage`, and a Web Lock on the id replaces the 50 ms `BroadcastChannel` probe for a duplicated tab, in a late phase** (Larry, 2026-09-30). A tab holds its id's lock until it closes, including while paused, so a duplicate finds the lock taken and mints a new id with no race. The phase's first criterion is a measurement: a reloaded page must get the lock its previous page held, or every reload would mint a new Gateway name, the leak `tab-id.ts` exists to prevent. If a reload can lose its lock, the phase is dropped rather than worked around. **Parked until the master plan's Open decision 4 settles**, since it is about Gateway names. | **Reusing ids across tabs from `localStorage`, each claimed by a lock** — it saves Gateway names that cost nothing, and a new tab could land on a Gateway closed seconds earlier and receive updates for rows it never made. **A fixed pool of lock names with no storage** — the `tabId` becomes a small, guessable number, which gives up the bonus D13 names. **Leaving the probe** — a paused original misses the 50 ms window, and the two tabs then close each other's connection with 4409 over and over. |
| D18 | **The vision doc, the ADRs and `.claude/rules/security.md` change docs-first, each with a *Today's code differs* block the build removes; `mesh.md`, the website and JSDoc change in the phase whose code makes them true** (Larry, 2026-10-04). § *What changes in standing guidance* lists both. | **Everything in the build's first phase** — until then every review pass reads accepted docs that contradict this file, and the security lens takes `auth.md` as the model wherever the two disagree. **Everything with the code** — the same, for the whole build. **`mesh.md` docs-first too** — D3's reason: every session reads it, and it would describe a Gateway that does not exist yet. |
| D19 | **A Client writes nothing into a call's context and receives no `state`** (Larry, 2026-10-04). The `call` message loses its `callContext`, and the Gateway builds all of it with `state` empty. The Client's call and broadcast options lose `newChain` and `state`, so a caller passing either fails to compile. A Client's handler sees `callChain`, `originAuth` and the `callee` it stamps itself (D6). Server-side `state` between nodes is unchanged; whether mesh keeps it is a separate question. | **Keeping `newChain` on the Client and documenting it** — on a Client it can only drop inherited `state`, since the Gateway starts every chain at the Client and no Client may shed its token; nothing in Nebula passes it. **Dropping only `newChain`** — leaves client-written `state` landing in a node's `callContext`, where a node caching an authorization decision there could meet a value the Client chose. **Removing `state` from mesh altogether** — it is published MIT surface the mesh docs teach, and Nebula's not using it does not settle whether others need it. |
| D20 | **A Client and its Gateway together are the equivalent of a server-side node, with its responsibilities split between two execution environments** (Larry, 2026-10-04). The Gateway decides passage and does the transport work a node's framework does inside a node; the Client does everything after passage, dominion's override included. Anything that must not depend on the browser's honesty lives in the Gateway half, which is why the Gateway builds a call's context (D19) and keeps a node's continuation (D11). `docs/vision/auth.md` § *Lumenize Nebula mesh* says so, and `mesh.md`'s Gateway section will (D3). | **Making the Gateway a node** — a hop between the Client and every node, which breaks every receiver reading `callChain[0]` as the verified Client and `callChain.at(-1)` as where to send updates. **Calling the Gateway "mesh mechanics, not a mesh node"** — true of what the mesh sees, but it read as an exemption from the transport rules, which is how the late-ack hop survived. |

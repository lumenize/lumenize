# Calls to and from a Client behave like calls between nodes

**Status:** Pass 2 written 2026-10-05, with every decision Larry's. Stage 1 `/review-task` ran
twice on 2026-10-04 and Stage 2 once on the phase-less file, and every item from all three runs is
settled; the vision doc, the ADRs and `security.md` changed docs-first (→ D18). Stage 2 runs again
on the phases before `/build-task`. The master plan's Open decision 4, where a Client's
server-side half is hosted, no longer gates this file (→ D23).

## Goals

**Overall objective:** make calls to and from a Client behave as much like calls between server-side
mesh nodes as security allows, knowing that whoever controls a browser can change the Client's code.

Five goals serve it, most important first. Each says how today's code misses it.

1. **A tab never silently stops getting the updates it is entitled to.** Today a tab paused for more
   than 30 s is dropped from each subscription that pushed to it during the pause, and keeps the
   socket that would have told it so. An
   update that meets a socket whose token has just lapsed is lost, though the tab is back in
   moments (→ D4, D5). What holds the goal afterwards: a client re-subscribes exactly when the
   Gateway says it lost something.
2. **No node waits on a tab, and a tab's answer arrives the way a node's does.** Today the Gateway
   holds the calling node's RPC open for up to 30 s while its tab answers, which is the late-ack
   transport ADR-003 rejects, and a value the tab returns is thrown away (→ D11, with D10 and D6).
3. **A refused call reaches its caller right away, not when a timer gives up.** Today a tab's
   subscribe names no handler, so when passage refuses it the tab learns only when `#subscribeVia`'s
   timer expires (→ D15).
4. **No Client ever chooses code that a node or another Client runs.** It holds today because no
   result handler continuation ever crosses the socket, and it must keep holding once they travel
   (→ D11).
5. **A tab is protected the way a node is: passage at its Gateway, then its own checks.** A tab's own
   check is its refusal of any call from another tab, which stays (→ D24). Today the Gateway also
   checks a call from another tab as if the receiving tab's `aud` were a scope; it stops, since a
   tab offers no scope to check (→ D24).

D7, D8 and D17 ride along: D7 refuses a second live impersonation child of one subject from the
same parent, D8 deletes a dead method, and D17 replaces the duplicated-tab probe. Every goal rests
on one model: a Client and its Gateway together are the equivalent of a server-side node (→ D20).

### Accepted limitations

- **A Client can start or end a chain, never sit in the middle, and its calls carry nothing of its own context** (→ D19). Its Gateway starts every call a Client makes with `callChain: [thatClient]` and the Client's claims. So a call the Client makes while handling another carries over nothing of it, and a Client cannot start a chain without its token, as a node does with `newChain: true`; its options do not offer `newChain`.
- **A Client does not accept calls from other Clients** (→ D24). A peer feature goes through a node: a two-person chat is a room on the server, which brings history and presence with it.

## Relationships

- **Builds after [archive/nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md), built 2026-10-04.** Its 30-character slug cap is what lets D10 tell a scope's name from an id. Its fresh-chain default for `lmz.broadcast` keeps a writer's tab address off every update. It also built D9 and D12.
- **Builds on the toolchain row of [nebula-pre-alpha.md](nebula-pre-alpha.md), built 2026-10-04**: `@cloudflare/vitest-plugin` and compatibility date 2026-10-01. D11 rewrites the transport between a Client and its Gateway, so the test runtime had to stop moving first. The new date is also what lets `ctx.waitUntil` hold a Durable Object resident, which D11's and D5's waits rely on (→ D23).
- **Hands [nebula-pre-alpha.md](nebula-pre-alpha.md) § *A Client connects to its scope's node* a server-side half it can move.** That open decision gates a later hosting task, not this file (Larry, 2026-10-04). This build writes the server-side half as code a Durable Object composes, with the Gateway as its first host (→ D23), so if a Client's socket later moves to its scope's node, that code moves rather than being rewritten. The two experiments the decision rests on, `experiments/gateway-vs-hosted/RESULTS.md` and `experiments/do-socket-drop-probe/RESULTS.md`, belong to that task. How each decision fares under the move:
  - **Unaffected:** D6, D8, D10, D15, D16, D18, D19, D21, D22 and D24, and D9, which is built.
  - **Moves with the server-side half, as D23's code:** D4, D5, D11 and D12.
  - **Built now and revisited if the hosting moves, since they name the Gateway:** D25's Gateway check, and the Gateway-specific wording in D3 and D20.
  - **Parked until the hosting decision:** D7 and D17.
- **Lands before ⑥ the wipe.** D11 changes the wire between a Client and its Gateway, and every generated app bundles the Client, so apps built before it must be rebuilt, which the wipe does anyway.
- **Makes `subscriptionRequired` honest, which answers most of `tasks/backlog.md`'s row saying it is broken** (§ *Lumenize Mesh*). After D4 a row is dropped only when the Gateway gives up on a delivery, and the client is told every time. The build rewrites the row to what stays open: re-checking a subscriber's admin verdict on each push instead of pinning it at subscribe, which a client that ignores the flag would otherwise escape.
- **Closes `tasks/backlog.md`'s row on whether mesh keeps `callContext.state`** (§ *Lumenize Mesh*): D22 removes it.
- **Closes one row in `tasks/backlog.md` § *Lumenize Mesh* and narrows another.** D11 does what the row proposing that broadcast-to-client go fully async asks. D10 answers the row saying a chain a node starts carries no `originAuth` only for passage into that node and its ancestors, so a Galaxy's alarm calling one of its Stars stays refused, and the build narrows the row to that.
- **Owes the next release its BREAKING notes, written into `tasks/backlog.md`'s unreleased BREAKING rows as a Pass 2 criterion,** because this file archives and those rows carry the obligation:
  - the Client↔Gateway wire, including the `lmz.2` protocol name and the exported `CallResponseMessage` going (D11);
  - the three-argument `lmz.call`, and `lmz.broadcast`'s `onResult` becoming required (D15);
  - the Client's options losing `newChain` (D19);
  - a Client's bound continuation arguments crossing the wire, so a function cannot be bound and a reactive object comes back as a copy (D11);
  - `callContext.state` and `CallOptions.state` leaving mesh for every node type (D22).

  The same edit strikes what those rows will then get wrong: `ClientTokenExpiredError` listed as new, though D5 deletes it before any release; `lmz.broadcast`'s `newChain` and `state` called additive; the CALL frame keeping only `state`; and `ClientResultEnvelope.clientInstanceName` staying.
- **Takes over Phases 1, 2, 4 and 5 of `tasks/on-hold/mesh-resilience-testing.md`**, which drive the grace period and reconnect paths D4 and D5 change. Phase 9 re-derives them for this Gateway, `/live` first, and trims that file to Phases 3, 6 and 7.
- **Hands D7 and D17 to [nebula-pre-alpha.md](nebula-pre-alpha.md) § *A Client connects to its scope's node***, since both are about Gateway names and wait on Open decision 4. Phase 9 writes the pointer.

## Constraints

- **ADR-003:** no node holds a reply open across a hop. Today's downstream hop does, and D11 is the fix.
- **ADR-007:** every node type shares one comms and guards core, so the Gateway fills a continuation with `fireResponse`'s code rather than a copy (D11).
- **ADR-015 and ADR-022:** passage and dominion read `activeScope`, which D10 widens to a chain a node started.
- **ADR-005:** its "no dedupe ledger" is about resource writes. D4's record of answered `callId`s is in the tab's memory, bounded, and about delivering a push once.
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
  `.claude/rules/mesh.md` recommends, can therefore meet a value a Client chose (→ D19, D22).

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
    ignores the flag and re-subscribes on every reconnect, a token rotation included, which for an
    active tab is about every 15 minutes (→ D4).
  
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
    `callChain.at(-1)` is another client, and never reads `originAuth`. That refusal stays
    (→ D24).
  
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
  node's does, so the Client's saved call-site context goes too. A result that lands after the page
  reloads is dropped: every call carries an id the Client minted when it was constructed, the
  fire-back echoes it, and the Client drops one that is not its own (→ D21).
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
  and while it waits within the grace period for a reconnect (D5).** Today a pending call's own
  timer keeps it resident and the grace-period wait sets no timer of its own; after this build
  each wait is handed to `ctx.waitUntil`, as `durable-objects.md` now requires, and its timer only
  times it out (→ D23). If it is evicted mid-wait, the node's handler never runs, where today the node's call fails and its handler runs
  with the error. For a reaper that means a dead subscriber's row lasts until the next update finds
  no socket. (Two other 30 s values are unrelated: `callAsync`'s default timeout, and how early a
  client refreshes its token.)
- **A returned Error now reaches the node's handler, as it does between nodes,** because the Gateway
  fills the continuation the way `fireResponse` does.
- **The Gateway runs all of this as code a Durable Object composes**, so a later host, such as a
  Client's scope node, takes it over unchanged (→ D23).

### A Client calls another Client

- **The callee's Gateway keeps the continuation, exactly as when a node calls a Client.** Gateway 1
  builds the envelope with Client 1 as `returnAddr`. Gateway 2 keeps the continuation, asks Client 2,
  fills it and fires it to Gateway 1, which sends it down to Client 1. If Client 2 saw the continuation,
  it could make Client 1 run any of Client 1's own methods with the `@mesh()` check off.
- **So one rule covers both: a Gateway that receives a call keeps its continuation, whoever sent it.**
  A Client refuses a call from another Client by default (→ D24), so this path runs only for an app
  that opts in; the rule holds for it all the same.

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
   - **No object of a class named by an id runs under a scope-shaped name** (→ D25). So a
     scope-shaped `callChain[0]` always names an object that checks passage into that scope.

### On the wire

The messages between a Client and its Gateway, after D11 and D15:

```ts
// Client → Gateway: a call. expectsResult goes, and every call names a handler (D15).
// loadId is minted once per Client, and the fire-back echoes it (D21). callId stays
// for onSent, and so the Gateway can name a call in its logs
// It carries no callContext: the Gateway builds all of it (D19), and there is no
// state (D22)
{ type: 'call', callId: '5e0b…', loadId: '9c41…', binding: 'STAR',
  instance: 'acme.crm.bigco', chain, handler, onErrorOnly /* optional */ }

// Gateway → node: the envelope's response, which the Gateway writes, never the Client
response: { kind: 'mesh', returnAddr: <this Client's identity>, handler, onErrorOnly,
  callId, loadId }

// Gateway → Client: a filled continuation, from a node's fire-back or a refusal at
// the early ack. The Client runs it through the filled-chain entry, so a
// marker-shaped answer stays data (D11), with the @mesh() check off and callee set
// from the chain's last hop (D6). It runs no onBeforeCall (D27)
// No state reaches a Client, since none exists (D22)
{ type: 'response', callId, loadId, chain, callContext: { callChain, originAuth } }

// Gateway → Client and back: unchanged but for state. The Gateway keeps the node's
// continuation under this callId
{ type: 'incoming_call', callId, chain, callContext: { callChain, originAuth } }
{ type: 'incoming_call_response', callId, success, result /* or error */ }
```

- **What goes:** `call_response`, `ClientResultEnvelope`, `kind: 'client'`, the `call` message's
  `expectsResult` and `callContext`, and `state` everywhere (D22).
- **The Client drops a `response` whose `loadId` is not its own**, which covers one meant for a
  previous page load or a disposed Client (→ D21). `callAsync` keys its Promise by the `callId`: it
  sends as its continuation a call to a `LumenizeClient` method with no `@mesh()`, taking the id and
  the result, and a `response` arriving after its timeout finds nothing to settle.
- **The protocol name becomes `lmz.2`.** A Client bundled before the change offers only `lmz`, so
  the Gateway answers 426 before any side effect, leaving any open socket alone, and the stale
  Client retries with backoff until its page reloads. The wipe rebuilds every
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
  Client's answer, plus any grace-period wait. If a later task hosts D23's code on a scope's
  node, that hold lands there.
- **A wider door.** `NebulaDO` admits a call with no claims when `callChain[0]` is a node named by a
  scope, with passage into that scope and its ancestors and no `scopeAdmin` (→ D10).

## What changes in standing guidance

The vision doc, the ADRs and `security.md` already describe the target, each with a *Today's code
differs* block where the code lags (→ D18). The build does two things to standing guidance.

**It removes these blocks, each in the phase that closes it:**

- `docs/vision/auth.md` § *Lumenize Nebula mesh*, opening "On a call to a client, the Gateway holds" (D11).
- `docs/vision/auth.md` § *How the claims travel*, opening "A chain a node started carries no claims", cut sentence by sentence as D19, D24 and D10 land.
- `docs/adr/003-continuation-messaging.md` § *When awaiting is OK*, opening "On a call to a client, the Gateway returns" (D11, D15).
- `docs/adr/007-shared-node-security-core.md`, opening "The client keeps its result handler continuation in the tab" (D11).
- `docs/adr/015-passage-and-dominion.md` § *Predicate pair*, opening "A chain a node started carries no token" (D10).
- `.claude/rules/security.md`'s ⏳ line under the JWT bullet (D10).

The `_platform` blocks in `auth.md` § *Coarse-grained access control* and ADR-015 § *Context* stay,
because a different change closes them. ADR-022 carries none.

**It fixes everything else the code makes false, in the phase whose code makes it false.** That
phase's criterion is a grep across `.claude/rules/`, `website/docs/`, `docs/adr/`, `docs/vision/`,
`packages/mesh/src`, `packages/auth/src`, `apps/nebula/src`, `packages/nebula-auth/src`,
`apps/nebula/harness/` and the test trees that comes back clean for the terms its decision
retires. Each term is a literal pattern whose count Pass 2 records when it writes the phase, and
the compiler stands in for "a call with no handler", which D15 makes required. The terms: a call with no handler or an `undefined` one (D15), a client
passing `newChain` (D19), `state` in a call context or call options (D22), the `lmz` protocol name and "answers inside its ack" (D11),
`ClientTokenExpiredError` (D5), the 30 s wait, `subscriptionRequired`, `#resubscribeAll` and
"re-issues every subscription" (D4, D5), and "never from the reply" and "cannot name a victim"
(D11). At the time of writing those greps would find:

- **`.claude/rules/mesh.md`:** § *`call()` + a continuation is the ONLY cross-node call surface*, § *Passing data to the callee*, § *Object-capability access: gate once, then chain*, § *`lmz.call` 4-arg — the result-handler mechanics*, § *Fire-and-forget error delivery*, and § *`LumenizeClientGateway` is NOT a mesh participant* (D3).
- **`website/docs/mesh/`:** `calls.mdx`, `lumenize-client.mdx`, `protocol.mdx`, `mesh-api.mdx`, `broadcast.mdx`, `managing-context.mdx` (§ *Using `state`*, D22), `gateway.mdx` (its "simply forwards", and its timeout, token-expiry, resubscribing and connection-state sections), `index.mdx` and `lumenize-worker.mdx` (three-argument calls inside `@skip-check-approved` blocks, which the example checker never reads), `getting-started.mdx`, and `security.mdx` (the protocol name, and § *Call Context State* with its source, `packages/mesh/test/for-docs/security/team-doc-do.ts`, D22).
- **`website/docs/mesh/lumenize-client.mdx` § *Access Control*:** its opt-in example gains one sentence: an app that opens peer calls must guard its own push handlers, which the default refusal was protecting (D24).
- **Elsewhere in the docs:** `website/docs/auth/index.mdx`, and `FetchExecutorEntrypoint.md` with its source comment in `packages/mesh/src/lumenize-worker.ts`.
- **JSDoc and comments:** `requirePassage`; the Client's and `broadcast.ts`'s broadcast warnings; the Gateway's class comment; the reaper comments in `apps/nebula/src/resources.ts` and `packages/nebula-auth/src/profile.ts` that say a Gateway answers inside its ack; every comment stating where `callee` comes from (`CallContext.callee` in `packages/mesh/src/types.ts`, `executeEnvelope`, `fireResponse`, the reapers, and the `reaper-victim-is-the-address` scenario's header), restated as: the receiver's own identity at the request door, the address dispatched to on a local dispatch, and the last hop at the fire-back door (D11); `apps/nebula/src/subscriptions.ts`'s two blocks naming the blanket re-subscribe as the convergence mechanism (D4); and `packages/auth/src/hooks.ts` (D11).

## Decisions

Every row is Larry's call. The D-numbers are append-only, and the prose above points at them with (→ Dn) where it describes the problem each one fixes. D1 and D2 were withdrawn; D11 replaced both. D13 and D14, which opened Client-to-Client calls and guarded each push handler, were withdrawn 2026-10-05; D24 replaced them.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D3 | **`.claude/rules/mesh.md` is corrected in the same change as D11** (Larry, 2026-09-30). § *`lmz.call` 4-arg — the result-handler mechanics* says a Client's result handler continuation travels as a node's does, and its line calling the Gateway "the one deliberately-awaited hop" goes. Its Gateway section is retitled *`LumenizeClientGateway` is the server-side half of a Client* and opens with two requirements (Larry, 2026-10-04). The Gateway honors every transport rule a node's framework honors, on its Client's behalf: it acks early, keeps the continuation, fills it and fires the answer back. And it never appears in a `callChain`, holds no `@mesh()` members, and decides nothing that belongs to the Client: every check it makes is one that must not depend on the browser's honesty, such as who connects, whether the token is live and whether the tab has passage into what is sent down (→ D20). | **Correcting it first** — it would describe a Gateway that does not exist yet. **Leaving it** — it tells every session a Client's own error never arrives, which is false today and stays false. |
| D4 | **A Client re-subscribes exactly when the Gateway says it lost something, never on a network blip or a token rotation** (Larry, 2026-09-30; revised 2026-10-04). The Gateway closes the socket with code 4408 when a Client misses the 30 s wait, so a paused tab reconnects when it wakes; 4408 echoes HTTP 408 Request Timeout, as 4401 and 4409 echo 401 and 409. A row is dropped only when the Gateway gives up on a delivery, so the Client re-subscribes in three cases, none of which needs the Gateway to store anything. First, after a 4408 close, which the Client sees itself. Second, when `connection_status` reports `subscriptionRequired: true` because the Client stayed away past its grace period. D23's code tracks that per client rather than deriving it from the Gateway's own alarm, so a host holding many Clients needs no redesign. Third, when a Client's new token changes what it rests on (revised 2026-10-05). The Client compares each new token with the previous one, on every path a token arrives by. A changed `sub` makes it reconnect as `{newSub}.{tabId}`, a fresh Gateway that reports `subscriptionRequired: true`, and the old Gateway's rows are reaped when their next push finds no socket; today the Client keeps its first name, so the Gateway answers 403 "identity mismatch" and the tab loops on backoff until a reload. A changed `scopeAdmin` under the same `sub` makes `NebulaClient` re-subscribe. `authScope` needs no comparison, because a membership never changes scope: a different scope is a different membership with a new `sub`. JSDoc on the Registry's `#mintIdentity` and on the Memberships schema says so and names moving a membership in place as the change that would break the Client's check, and the Client's comparison points there. Besides those, a subscribe whose first snapshot has not arrived is re-sent on any reconnect, and a push still in flight on a socket that closes is re-sent on its successor rather than left to time out, so a rotation causes no spurious 4408. The re-send keeps the original `callId`, and the Client keeps a small, bounded record of the `callId`s it recently answered with their answers, so a repeat re-sends the stored answer without running the handler again (Larry, 2026-10-05). Seven push handlers replace state idempotently, but four of their side effects do not: a stream chunk appends, preview-ready reloads, `#askAgain` re-bills a write per denied subscription, and `#retryInstalling` counts an extra attempt. `NebulaClient` stops re-subscribing on every `reconnecting → connected` transition. A host with neither an open socket nor a record for a reconnecting Client reports `subscriptionRequired: true`. `NebulaClient`'s org-tree subscribe is gated on the same signal and joins the re-subscribe walk. Every branch that answers `ClientDisconnectedError` closes with 4408, since that error is what a reaper drops a row on. | **Leaving the socket open, as today** — a paused tab wakes with the same socket and never re-subscribes, so it stops receiving updates with nothing to show it. **Re-subscribing on `visibilitychange`** — the tab would re-subscribe every time someone returns to it, dropped or not, and only the Gateway knows it gave up. **Deleting `subscriptionRequired`, so every reconnect re-subscribes** — a blanket re-subscribe on every token rotation, about every 15 minutes for an active tab, each costing a billed write per subscription. **Telling the next connection `true` after a 4408 from the Gateway's own state** — the Gateway stores nothing, so the miss would be lost if it were evicted, and the close code already tells the Client. **The Gateway comparing the old and new sockets' claims at a rotation (this row's first form)** — only a rotation keeps the old socket open, so a lapse or a dropped connection, the commoner way new claims arrive, has nothing to compare, and a changed `sub` is refused 403 before any comparison runs. **Making each push handler safe to run twice** — four separate fixes today, and every future handler's author would have to know to make the fifth. **Not re-sending, so the push times out** — a spurious 4408 and a full re-subscribe on every rotation, several times in one long codegen turn. **Re-checking the admin verdict on every push instead of pinning it** — the real fix for a client that ignores the flag, but a change to how `Resources` decides who may read a push, so it stays in the backlog row. |
| D5 | **On a downstream call to a socket whose token has expired, the Gateway closes the socket with 4401, waits within the grace period for the Client to reconnect with a fresh token, and delivers on the new socket.** A missed reconnect answers `ClientDisconnectedError`, and `ClientTokenExpiredError` is deleted, since this path is its only source (Larry, 2026-09-30). The Gateway starts the grace period at its own 4401 close, so a held push waits for the reconnect rather than failing at once. | **Answering at once, as today** — the update is lost though the Client is back in moments. **Dropping the expiry check** — it is what keeps a revoked user's open socket from receiving updates after their token expires, since a revoked user cannot refresh and so cannot reconnect. |
| D6 | **A Client stamps `callContext.callee` itself, as every server-side node does** (Larry, 2026-09-30): its own identity on an incoming call, and the node that answered when a result handler runs, from the fire-back's last hop as D11 has every node do. | **The Gateway sending `callee` down with the call** — every other receiver takes `callee` from its own identity, never from the wire, and the Client already knows its own. |
| D7 | **`NebulaClient.impersonate` refuses a child whose Gateway name a live child of the same parent already holds, and the name keeps today's shape, `{subjectSub}.{parentTabId}.{scope with dashes}`** (Larry, 2026-09-30; re-derived 2026-10-04). One parent has one scope, the one its host spells, so a name repeats only when the same subject is impersonated twice from one parent, and the second socket would replace the first with 4409. The scope segment no longer tells children apart. What it does now is give a child's name a different shape from any real tab's, `{sub}.{tabId}`, so a child cannot collide with the subject's own tab and a Gateway log tells an impersonation apart. **Parked until the master plan's Open decision 4 settles**, since it is about Gateway names; if a Gateway per tab survives it, first check whether one change to how a client reacts to 4409 covers both this and D17. | **Handing back the existing child** — the second caller would get a session the first can end. **Joining the scope's slugs with `--`** — it separated two scopes that spell the same name, and one parent can no longer produce two. **Dropping the scope segment** — a child's name takes a real tab's shape, so it collides with the subject's own tab on a 1-in-2³² draw, the two sockets then replace each other with 4409 in a loop, and a log cannot tell them apart. |
| D8 | **The Gateway's `#getInstanceName` is deleted** (Larry, 2026-09-30). Nothing calls it. | **Keeping it** — every reader of the trust boundary's source would have to work out that it is unused. |
| D9 | **`requirePassage`'s refusal names passage and both scopes, and the reserved platform name gets a refusal of its own** (Larry, 2026-09-30). Built 2026-10-04 by `archive/nebula-scope-moves-to-subdomain.md`, which carries the rejected alternatives. | — |
| D10 | **A call chain started by a node whose name is a scope acts as a plain member of that scope** (Larry, 2026-09-30): passage into the node and its ancestors, and no `scopeAdmin`. The key is that the name is a scope, not which binding the node has, so a future helper node named by a scope is covered. It applies only to a call carrying no claims, which no Client can make, since its Gateway stamps claims on every call. `parseId` decides whether a name is a scope, and it refuses every id-shaped name because a slug is capped at 30 characters and a UUID is 36; `packages/nebula-auth/test/parse-id.test.ts` pins that for a `profileId`, a persona's id and a Gateway's `{sub}.{tabId}`. It grants nothing a caller did not already have, since anyone with passage into a node has it into the node's ancestors, and D25 makes sure a scope-shaped name belongs to an object that checks passage into it. ADR-015 and `auth.md` widen `activeScope` to say so, and every definition of it says host, never page (Larry, 2026-10-04). Nothing writes a synthetic `aud` into `originAuth`. The cases are in § *What changes where a node receives its own fire-back*. | **Admitting only a chain the node started itself** — it covers the fire-back and nothing else, for the same code as the general rule. **Adding dominion over the node's own subtree** — a real grant of power nothing asks for yet. **Keying on the binding, Universe, Galaxy or Star** — a list a new node named by a scope would fall off. **Changing nothing, so the Gateway keeps answering inside its ack** — the late-ack transport ADR-003 rejects. **Keeping `activeScope` as the token's `aud` alone, with D10 as a second admission rule** — passage would read two inputs, described in two places, for the same code. **A new term for the derived value** — new vocabulary for a value that equals `activeScope` whenever a token is present. **Writing the node's scope into `originAuth` as a synthetic `aud`** — `originAuth` means claims a verified token carried, and ADR-016 would record a principal who never held one. `OriginAuth` would need a made-up `sub`, the one key ADR-013 allows. And mesh cannot tell which names are scopes, so node code would need a way to set `originAuth`, which the old broadcast tier's design deliberately avoided: it carried the broadcaster's identity as data so that nothing could set `originAuth` (`tasks/backlog.md`'s row on rebuilding a broadcast tier). |
| D11 | **A Client's result handler continuation travels with its call, as a node's does, and a Gateway that receives a call keeps that call's continuation** (Larry, 2026-09-30). No Client ever sees a continuation it did not write; a Client that misses the 30 s is treated as gone. `kind: 'client'`, `ClientResultEnvelope`, the `call_response` message and the late-ack wait all go. The Gateway fills a continuation with the code `fireResponse` uses, factored out of it so a class extending `DurableObject` can call it, never a copy (ADR-007). This build holds the continuation in memory while the Client answers, under `ctx.waitUntil` (D23); the hosting task that moves D23's code may persist it and time it out on an alarm instead. The mechanics are in § *A result handler continuation travels with every call*. Where it is held, the Gateway is the node's stand-in in three ways. It appends its Client's identity as the fire-back's last hop, from the socket's attachment or from the envelope's `metadata.callee` when there is no socket; on a refusal at the early ack it appends the node it dispatched to, so `callee` names who refused. It refuses a Client-written continuation that fails `validateOperationChain` or does not end in an apply. And it renames a Client-authored Error called `ClientDisconnectedError` before filling the node's continuation, so no Client can get itself reaped. A Client runs a `response` chain through the filled-chain entry, `executeFilledChain`, so a marker-shaped answer stays data, and runs no `onBeforeCall` there (D27). A Client's answer is untrusted input from the Client `callee` names, never from `originAuth`'s principal, and every value crossing either way round-trips at full fidelity (ADR-002); a bound function fails loudly at the call site. | **The Gateway answering inside its ack, plus a fix for the value it drops** — the late-ack transport ADR-003 rejects, holding the node awake for the tab's round trip. **Upstream only** — keeps that conflict on every call to a tab. **Amending ADR-003 to carve out the Gateway's hop** — keeps the cost and adds an exception. **Sending the node's continuation down to the tab, signed by the Gateway** — a signing key and a check on every answer, to avoid holding what the Gateway already holds today. |
| D12 | **The Gateway checks the tab's passage into the sender's scope on every call it sends its Client, replacing the `aud` fence** (Larry, 2026-09-30). Built 2026-10-04 by `archive/nebula-scope-moves-to-subdomain.md`'s phase *A push speaks for the node, not the writer*, which carries its example and rejected alternatives. **No check runs on answers** (Larry, 2026-10-04). An answer goes only to the tab whose call it answers, at the `returnAddr` that tab's own Gateway wrote, in that tab's own continuation, and its passage was decided on the request. For a node's answer the check would repeat the node's own `requirePassage`, and for another Client's answer the fire-back carries the asking tab's claims, so it would compare the tab with itself. | **Checking answers too** — it would repeat a decision made on the request, within revocation's accepted window. **Checking that a fire-back's chain is a continuation the Gateway wrote** — the Gateway would keep a copy of every continuation sent upstream, the in-tab state D11 removes. |
| D15 | **The three-argument `lmz.call` goes, for every node type: every call names a result handler, and fire-and-forget is a handler with `onErrorOnly`** (Larry, 2026-09-30). Every `lmz.call` or `lmz.broadcast` that passes no handler gains one, including those made through a wrapper. At the time of writing that is `NebulaClient`'s subscribes and unsubscribes, through `#hostCall` or straight to the Profile; `Galaxy`'s preview-ready nudge; the Profile's first snapshot to a new subscriber; and the six `Resources` sends whose `#send` passes no `onResult` (a refused subscribe's stale notice, `#notifyStale`, a stream chunk, the tree's first snapshot, and a resource's first snapshot and its error). A first snapshot takes the reaper its broadcasts already use, so a subscriber whose tab is gone is dropped; a stream chunk takes a logging `onErrorOnly`. `#send`'s `onResult` becomes required, and so does `lmz.broadcast`'s, so a site the build misses fails to compile. A refused subscribe reaches the tab at once as its Error, and `#subscribeVia`'s timer stays for a host that never answers. The `discard` kind of fire-back, `dispatchEnvelope`'s branch for a call with no handler, the Client's `expectsResult` flag and the Gateway's branch for a call without one all go; `fireResponse`'s arm for an envelope with no `response` stays, because it is the only place a continuation that throws at the fire-back door is logged. Every `NebulaClient` subscribe and unsubscribe handler is `onErrorOnly`. `packages/fetch`'s two source sites, in `fetch.ts` and `fetch-executor-entrypoint.ts`, get an error handler that logs, and any of its tests that break are skipped rather than fixed, since that package is headed for deprecation. | **Keeping it, and adding the Client's missing log line** — a refused subscribe would still be noticed only when a timer gives up, and the Profile's row would still leak. **Keeping it as shorthand whose errors go to one hook per node** — new API and vocabulary, and it takes the handling away from the call site that knows what the call was for. |
| D16 | **`callAsync` stays public on `client.lmz`, built on D11's travelling continuation: one message on the wire, two spellings in code** (Larry, 2026-09-30). Only the Promise and its timeout differ from a result-handler call (§ *On the wire*). `callAsync`'s JSDoc in `packages/mesh/src/lumenize-client.ts` states this, since it is already true today. The code Studio's model writes never calls it: the platform docs teach `await client.resources…` and mention `callAsync` nowhere, and every `callAsync` call sits inside `NebulaClient`. | **Only inside a Client subclass, for building an SDK** — it would narrow ADR-003's user-land awaiting to SDK methods, and third-party mesh users would lose the awaitable. **Removing it, so SDK methods take callbacks** — it fights the training wherever the platform docs teach `await client.…`, and amends ADR-003. |
| D17 | **A tab keeps its `tabId` in `sessionStorage`, and a Web Lock on the id replaces the 50 ms `BroadcastChannel` probe for a duplicated tab, in a late phase** (Larry, 2026-09-30). A tab holds its id's lock until it closes, including while paused, so a duplicate finds the lock taken and mints a new id with no race. The phase's first criterion is a measurement: a reloaded page must get the lock its previous page held, or every reload would mint a new Gateway name, the leak `tab-id.ts` exists to prevent. If a reload can lose its lock, the phase is dropped rather than worked around. **Parked until the master plan's Open decision 4 settles**, since it is about Gateway names. | **Reusing ids across tabs from `localStorage`, each claimed by a lock** — it saves Gateway names that cost nothing, and a new tab could land on a Gateway closed seconds earlier and receive updates for rows it never made. **A fixed pool of lock names with no storage** — the `tabId` becomes a small, guessable number. **Leaving the probe** — a paused original misses the 50 ms window, and the two tabs then close each other's connection with 4409 over and over. |
| D18 | **The vision doc, the ADRs and `.claude/rules/security.md` change docs-first, each with a *Today's code differs* block the build removes; `mesh.md`, the website and JSDoc change in the phase whose code makes them true** (Larry, 2026-10-04). § *What changes in standing guidance* lists both. | **Everything in the build's first phase** — until then every review pass reads accepted docs that contradict this file, and the security lens takes `auth.md` as the model wherever the two disagree. **Everything with the code** — the same, for the whole build. **`mesh.md` docs-first too** — D3's reason: every session reads it, and it would describe a Gateway that does not exist yet. |
| D19 | **A Client writes nothing into a call's context and receives no `state`** (Larry, 2026-10-04). The `call` message loses its `callContext`, and the Gateway builds all of it with `state` empty. The Client's call and broadcast options lose `newChain`, so a caller passing it fails to compile, and D22 takes `state` out of every node's options. A Client's handler sees `callChain`, `originAuth` and the `callee` it stamps itself (D6). D22 then removed `state` between server-side nodes too. | **Keeping `newChain` on the Client and documenting it** — on a Client it can only drop inherited `state`, since the Gateway starts every chain at the Client and no Client may shed its token; nothing in Nebula passes it. **Dropping only `newChain`** — leaves client-written `state` landing in a node's `callContext`, where a node caching an authorization decision there could meet a value the Client chose. |
| D20 | **A Client and its Gateway together are the equivalent of a server-side node, with its responsibilities split between two execution environments** (Larry, 2026-10-04). The Gateway decides passage and does the transport work a node's framework does inside a node; the Client does everything after passage, dominion's override included. Anything that must not depend on the browser's honesty lives in the Gateway half, which is why the Gateway builds a call's context (D19) and keeps a node's continuation (D11). `docs/vision/auth.md` § *Lumenize Nebula mesh* says so, and `mesh.md`'s Gateway section will (D3). | **Making the Gateway a node** — a hop between the Client and every node, which breaks every receiver reading `callChain[0]` as the verified Client and `callChain.at(-1)` as where to send updates. **Calling the Gateway "mesh mechanics, not a mesh node"** — true of what the mesh sees, but it read as an exemption from the transport rules, which is how the late-ack hop survived. |
| D21 | **A fire-back echoes an id the Client minted when it was constructed, and a Client drops one that is not its own** (Larry, 2026-10-04; revised 2026-10-05). The Client mints a random `loadId` once, when it is constructed, and stamps it on every `call`; the name pairs with `tabId`, which survives a reload where `loadId` does not, and its JSDoc says a new Client is a new load. The Gateway copies it and the `callId` into the envelope's `response` descriptor, and `fireResponse` echoes both on the fire-back, generic fields a node caller can use or ignore. The Client drops a `response` whose `loadId` is not its own, so a reloaded page, or a new Client on the same tab, drops every late answer meant for the one before, as `callAsync` already drops one it has no Promise for. The Client keeps nothing per call for this. `callAsync` keeps its Promises by `callId`, a map its timeout bounds, and the `callId` also lets the Gateway name a call in the log line when it drops an answer. | **Running it on the reloaded page** — a Durable Object's handler runs on a cold instance because its state is in storage, and a reloaded page has none of the old page's state and may run a newer bundle; an old page's late refusal could land on the new page's pending subscribe for the same resource. **Requiring every handler to be safe on a later page load** — a rule each author must remember, for a case rare enough to be forgotten. **Each handler checking the `loadId` by hand** — the same check as this row, rebuilt in every handler. **Keeping the set of `callId`s still outstanding (this row's first form)** — an `onErrorOnly` call that succeeds gets no fire-back, so its id is never retired, and D15 makes every subscribe and unsubscribe such a call; a Studio tab open all day would grow the set without bound (Stage 2). **Retiring an `onErrorOnly` id with a small success message** — a message back for every subscribe, which is what `onErrorOnly` exists to avoid. **Expiring outstanding ids after a fixed time** — a real refusal can arrive arbitrarily late, after a wait in the grace period, and would be dropped as stale. |
| D22 | **`callContext.state` and `CallOptions.state` leave mesh, for every node type** (Larry, 2026-10-04). `state` began as what `callChain` became, and nothing in this repo's production code reads or writes it. Its one documented security use, an `onBeforeCall` caching `isEditor` for a guard, saves a single recomputation, since only the guard on a chain's first operation runs; carried across a hop, it hands the next node a verdict computed for a different one. The merge in `lmz-api.ts` goes with the two fields, in the phase where D19 touches the same code. The docs say instead: read `callChain` for tracing, pass a value a later hop needs as a continuation argument, and compute an authorization decision in the guard of the node it is about. | **Keeping it, with the backlog row's trigger rewritten** — a side channel `mesh.md` recommends for exactly the cross-hop authorization caching that misleads. **Deciding it after this release** — the next chance to break it costs a separate major. **A per-node, per-call scratch that does not cross hops** — new surface for the one recomputation it would save. |
| D23 | **A Client's server-side half is code a Durable Object composes, and `LumenizeClientGateway` is its first host** (Larry, 2026-10-04). That code keeps, fills and times out a continuation (D11), waits within the grace period (D5), closes with 4408 and decides when a Client must re-subscribe, tracking that per client (D4), and checks passage on what it sends down (D12). Extracting it changes no behaviour of its own. A later task may host it on a Client's scope node, the master plan's Open decision 4, which no longer gates this file. The composed code owns no `alarm()` and calls no `ctx.storage.*Alarm`, since a `LumenizeDO` host owns its alarm; each Client's grace period is an in-memory deadline of at most 5 s. Every wait it keeps in memory, a continuation awaiting its Client's answer or a push awaiting a reconnect, is handed to `ctx.waitUntil`, which from compatibility date 2026-10-01 holds the object resident; a timer only times it out (`durable-objects.md` § *Wall-clock billing*). Its fire-back entry is its own, apart from the host's `__handleResponse`, and nothing it receives runs on the host. Passage and expiry are checked immediately before each send, against the attachment of the socket actually sent on, after any wait or re-send. The extraction lands as its own first phase, before any behaviour changes. | **Building it into the Gateway class** — a later hosting switch would rewrite it, and D4's derivation from one Gateway's alarm would need a redesign for a host holding many Clients. **Settling the hosting decision first** — it would hold this file on two questions pre-alpha's scale does not need answered, the load a hosting node forwards and the concentration of a tenant's sockets on one object. |
| D24 | **A Client keeps refusing every call whose immediate caller is another Client, in the MIT package and in Nebula, and the Gateway does not check passage for a Client sender** (Larry, 2026-10-05). The refusal lives in `LumenizeClient.onBeforeCall`, so it covers every method an override replaces and needs no per-handler guard; its JSDoc carries Larry's instruction not to remove it again. Passage has nothing to decide for a Client sender: a tab is named `{sub}.{tabId}`, not by a scope, so it offers no `targetScope`, and the receiving tab's `aud` says where its person is acting, not what the tab is. So the receiving Client decides, refusing by default; an MIT app that opts in keeps today's documented override and decides in its own guards from the caller's claims, which the Gateway has stamped. For a node sender the Gateway keeps checking the tab's passage into the sender's scope, which catches a subscriber row that outlived its page. | **Opening Client-to-Client calls and guarding each push handler (D13 and D14, withdrawn)** — one review found seven defects that existed only because peers were open, and every earlier attempt also ended in a restriction; a peer feature works through a node. **Checking the sender's passage into the receiving tab's `aud` (the first form of this row)** — it uses a tab's `aud` as if it were a scope the call targets, which it is not; it fixed the direction of today's check without a model that justifies checking at all. **Keeping today's Client-sender check** — it asks the receiving tab's passage into the sender's scope, which admits a plain `acme.crm` member reaching down into a tenant's tab and refuses a tenant reaching up. **Refusing Client senders at the Gateway as well** — a second refusal of what the Client already refuses, and it would take the decision away from an app that opts in. |
| D25 | **A scope-shaped name belongs only to an object that checks passage into it** (Larry, 2026-10-05). `Profile.onBeforeCall` refuses to run under a name that is not a profile id, and the Gateway's `__executeOperation` refuses a name that does not start with a dotless UUID, as its upgrade path already does. With `packages/nebula-auth/test/parse-id.test.ts` pinning that no id parses as a scope, a scope-shaped `callChain[0]` always names a `NebulaDO`, so D10's admission of a claimless chain grants nothing a caller lacked. Today a tab can bring a Profile object into existence at `acme.crm.bigco`; nothing it does reaches a Star, which is why this was latent rather than live. | **Stating the invariant in JSDoc on `requirePassage`, `Profile` and the Gateway** — safe only while nobody adds a Profile feature that calls a scoped node on a fresh chain, and the reminder sits where that author would not look. **Keying D10 on the starter's binding** — rejected in D10: a list a new scoped node would fall off, and a binding's class cannot be read from a call. |
| D26 | **`onBeforeCallToMesh` stays as it is: a Gateway subclass may still return whatever context it likes** (Larry, 2026-10-05). Only server code the Gateway's author writes runs there, trusted as any node's code is, and no Client can reach it. It was added in February 2026 for Nebula's planned stamp of `universeGalaxyStarId`, a design that moved to the token's `aud` before it was built, so Nebula has never overridden it; an MIT app's subclass may still want it. A change to what it does is made safe when it is made. D22 takes `state`, so the hook's test in `packages/mesh/test/lumenize-client-gateway.test.ts` stamps a top-level field instead of `state._auth`, and the capability keeps a test. | **Deleting it (Stage 2)** — takes a capability from every other subclass to close a channel only that subclass's author can write. **Making it observe-only** — the same loss, for the same reason. **Documenting what a subclass must not change** — a rule against a risk we already control. |
| D27 | **A Client's `response` door runs no `onBeforeCall`** (Larry, 2026-10-05). The Client runs a returned continuation through `executeFilledChain`, with the `@mesh()` check off and `callee` from the last hop, as today's in-heap handler already runs without the hook. On a node, `onBeforeCall` at `__handleResponse` is the passage check; on a Client, passage is its Gateway's job (D20), and D12 already decided that no check runs on answers. The chain at that door is always the Client's own continuation: its Gateway wrote the return address and validated the continuation on the way out, and the answer inside it is data. So `LumenizeClient.onBeforeCall`'s refusal of a Client sender (D24) stays a rule of the request door, and a peer's answer or refusal reaches the tab that called. Phase 8's rewrite of `mesh.md` § *`lmz.call` 4-arg — the result-handler mechanics* says so, because that section says a response is re-gated by `onBeforeCall`, which is right for a node. | **Running it at both doors, with the default skipping its peer refusal on a `response`** — the hook would need to know which door it is on, and so would every override of it. **Running it as the wire block first said** — a peer's answer and refusal never arrive, and a `callAsync` to a peer waits out its 30 s timeout (Stage 2, on the phases). |

## Phases

**Every phase ends the same way.** `npm run type-check` and the root `npm test` pass, which run
every workspace's suite and the `@check-example` checker, and
`npx tsx apps/nebula/harness/drive.ts all --fast` sweeps the registry green. Phases 7 and 8 run
the full `drive.ts all`, container scenarios included, because they rewrite the transport every
scenario rides. The type-check is what makes each `// @ts-expect-error` criterion able to fail,
since vitest does not type-check.

**Tests.** A new `/live` scenario is written first and is red before its phase's code; where
today's code already has the property by another mechanism, its mutation is what shows it can
fail, and the criterion says *mutation-only*. Each limb names the mutation that isolates it
(`live-scenarios.md`), a refusal is matched by its message, and a read of `DevStack.logs` is
guarded and waits for its own request's line first. A test in `packages/mesh` runs in-lane
because mesh has no `/live` harness and the property is the transport's own, the reason
`filled-chain-is-data.test.ts`'s header gives; any other in-lane test says why it needed no
running system.

**Standing guidance moves with the code that makes it false** (§ *What changes in standing
guidance*). A phase that retires a term greps the trees named there and comes back clean outside
`tasks/`; each count below is today's. The phase's BREAKING note goes into `tasks/backlog.md`
§ *Lumenize Mesh* in the same commit. No task-file handle, `Dn` or `Phase N`, goes into source
(`workflow.md`).

### Phase 1 — The Client's server-side half becomes `ClientGateway`, which the Gateway composes

The code `LumenizeClientGateway` runs for its Client moves into `ClientGateway`, a class in
`packages/mesh/src` that a Durable Object composes, as `ComposedMeshDO` composes the comms core
(D23; the name is Larry's, 2026-10-05). `LumenizeClientGateway` becomes the Durable Object that
hosts one `ClientGateway`, and its JSDoc says so in those words. It keeps its entry points
(`fetch`, `webSocketMessage`, `webSocketClose`, `__executeOperation`, `__handleResponse`) and its
three hooks, and each entry delegates. `ClientGateway` reaches its host only through what it is
handed: the host's `ctx`, its `env` and its hooks.

- **The grace period becomes an in-memory deadline per Client**, so `ClientGateway` owns no
  `alarm()` and calls no `ctx.storage.*Alarm`, and the Gateway's public `alarm()` goes. Two
  behaviours change, both only after an eviction, and both the way D4 wants. A Client
  reconnecting within 5 s to a Gateway evicted since its close is told `subscriptionRequired:
  true`, where the alarm said `false`. A push arriving there answers `ClientDisconnectedError` at
  once rather than waiting.
- **Each socket is tagged with its Client's name**, `acceptWebSocket(server, [instanceName])`, and
  every lookup and supersede uses `getWebSockets(tag)`. Today an upgrade closes every socket the
  object holds, which a host holding many Clients cannot do.
- **`#getInstanceName` is deleted** (D8).
- **The test-mode overrides keep working**: `LUMENIZE_MESH_GRACE_PERIOD_MS`,
  `LUMENIZE_MESH_TEST_MODE`'s 60 s grace period, and `LUMENIZE_MESH_CLIENT_CALL_TIMEOUT_MS`.
- **A `packages/mesh` vitest project for timing tests** is created, excluded from `main`, with a
  short `LUMENIZE_MESH_GRACE_PERIOD_MS`. Every `main` project keeps the 60 s grace period its
  2 s `testTimeout` relies on.

**Success criteria:**

- Both suites pass with the same test files and tests, apart from the four grace-period tests in
  `lumenize-client-gateway.test.ts`, which is this phase's test churn:
  - *reconnect within grace period reports subscriptionRequired: false* and *__executeOperation
    during grace period resolves when client reconnects in time* poll `getAlarm()`. They wait
    instead on a debug-sink marker `webSocketClose` logs.
  - *reports subscriptionRequired: true after grace period expires* and *__executeOperation
    during grace-period expiry returns ClientDisconnectedError with class preserved* fire
    `runDurableObjectAlarm`. They move to the timing project and let its short grace period
    lapse. *Mutation:* never act at the deadline, and each hangs to its timeout.
- **An eviction inside the grace period.** A Gateway aborted inside the grace period tells the
  reconnecting Client `subscriptionRequired: true`, and a push to it answers
  `ClientDisconnectedError` at once. *Mutation:* default to `false`; wait anyway.
- `grep -nE "getAlarm|setAlarm|deleteAlarm|alarm\(|ctx\.storage"` finds no line of code in
  `ClientGateway` or the Gateway, which has 9 code lines and 4 comment lines today.
  *Mutation:* restore `setAlarm` in `webSocketClose`.
- Every `getWebSockets(` call in `ClientGateway` passes a tag. *Mutation:* an untagged
  supersede.
- `website/docs/mesh/gateway.mdx` describes the grace period as an in-memory deadline in its three
  places that name `getAlarm()` or "Alarm status", and so does the Gateway's class comment with
  its connection-state table. `mesh.md`'s and the Gateway hook JSDoc's pointers at
  `#handleClientCall` point into `ClientGateway`.
- **BREAKING note:** `LumenizeClientGateway`'s public `alarm()` goes.

### Phase 2 — A Client writes nothing into a call's context, and `state` leaves mesh

`CallContext.state` and `CallOptions.state` leave mesh for every node type, with
`buildOutgoingCallContext`'s merge and the Client's `outgoingClientState` (D22). The Client's
`call` message loses `callContext`, and the Gateway builds the whole context from the socket's
attachment (D19). `incoming_call` carries `callChain` and `originAuth` only.

- **The Client's `call`, `callAsync` and `broadcast` options lose `newChain`**, through option
  types of the Client's own, so a Client caller passing it fails to compile. A node's options
  keep it.
- **`onBeforeCallToMesh`'s test stamps a top-level field** rather than `state._auth`, so the hook
  keeps a test (D26).
- **The docs teach the replacements** D22 names: `callChain` for tracing, a continuation argument
  for a value a later hop needs, and an authorization decision computed in the guard of the node
  it is about. The places: `managing-context.mdx` § *Using `state`*; `security.mdx` § *Call
  Context State* with its source `packages/mesh/test/for-docs/security/team-doc-do.ts`;
  `mesh-api.mdx`, whose `state` lines include a `@check-example` block; `broadcast.mdx`; and
  `mesh.md`, both § *Passing data to the callee* and its other mentions.
- **`auth.md` § *How the claims travel* loses its *Today's code differs* sentence** about a Client
  writing `state`.

**Success criteria:**

- A hand-built `call` frame carrying `callContext: { state: { isEditor: true } }` reaches its node
  with no `state` key in `callContext`. *Mutation:* the Gateway copies the frame's `state` again.
- `// @ts-expect-error` lines passing `{ newChain: true }` to a Client's `lmz.call`,
  `lmz.callAsync` and `lmz.broadcast` all compile. *Mutation:* give the Client's broadcast the
  node's `BroadcastOptions`, and its directive reports itself unused.
- The `onBeforeCallToMesh` test's callee reads the field its hook stamped. *Mutation:* the
  Gateway ignores the hook's return.
- `callContext\.state` (36 hits in 19 files) and `CallOptions\.state` (3 hits in 2 files) find
  nothing in the trees. `\bstate\b` over the five docs above (29 hits today) is read by eye, and
  every remaining hit means something other than a call context's `state`.
- **BREAKING notes:** the Client's options lose `newChain`, and `callContext.state` and
  `CallOptions.state` leave mesh. The 2026-09-27 row stops calling `lmz.broadcast`'s `newChain`
  and `state` options additive for a Client, and stops saying the CALL frame keeps `state`.
- **`tasks/backlog.md`:** the row proposing a Saga pattern built on `callContext.state` is
  rewritten to carry a saga's context as continuation arguments, per D22.

### Phase 3 — The receiving Client decides a call from another Client

`NebulaClientGateway.onBeforeCallToClient` checks nothing when the sender, `callChain.at(-1)`, is
a `LumenizeClient`; the receiving Client's own `onBeforeCall` refuses it (D24). It keeps checking
a node sender's passage.

- **The Client runs `onBeforeCall` before it decodes the chain**, in `#handleIncomingCall`.
  `onBeforeCall` reads only the plain `callChain`, so nothing a refused sender wrote is ever
  decoded. Passage kept a sibling tenant's tab away from the decoder until this phase.
- **The text follows:** `nebula-client-gateway.ts`'s file comment loses its sentence on a Client
  sender's scope; `auth.md` § *How the claims travel* loses its *Today's code differs* sentence on
  the same check; `gateway.mdx`'s "simply forwards … true peers" is rewritten; and
  `lumenize-client.mdx` § *Access Control*'s opt-in example gains one sentence, that an app
  opening peer calls must guard its own push handlers, which the default refusal was protecting.
- **`tasks/backlog.md`:** the `originRequest` BREAKING row's *Unchanged* sentence, which says
  `LumenizeClient.onBeforeCall` authorizes from `originAuth`, is rewritten: it reads only the
  last hop.

**Success criteria:**

- **`client-sender-passage`, limb 1, inverts.** A tab on Star B calling a tab on Star A reaches
  A's Client and is refused there, matched on *Direct client-to-client calls are disabled by
  default*, never a passage message. *Mutation:* restore the Gateway's Client branch, and the
  passage refusal arrives instead. Limb 2, a second tab on Star A, stays as the positive control,
  and the scenario's header says the Gateway no longer decides.
- **`client-sender-passage`, new limb 3.** A call from another tab whose chain cannot be decoded is
  still refused with the same message. *Mutation:* decode before `onBeforeCall`, as today.
- `client-gateway-passage.test.ts`'s Client-sender block inverts in the two tests that expect the
  Gateway's refusal. The tests `archive/nebula-scope-moves-to-subdomain.md` built for a node
  sender's passage stay green, and `peer-guard.test.ts` keeps asserting the default refusal.

### Phase 4 — A chain a node started has an `activeScope`

Passage reads one derived value, the call's `activeScope` (D10). It is the claims' `aud` when the
call carries claims. With no claims, it is `callChain[0]`'s name when that node's name parses as a
scope, held as a plain member with no `scopeAdmin`; otherwise there is none. A Client's chain
always carries claims, so only a claimless chain is affected. `noPassageMessage` names the
starting node's scope where it says `(no scope)` today. Nothing writes a synthetic `aud` into
`originAuth`.

D25 lands in the same phase, because D10 is sound only with it:

- **`Profile.onBeforeCall` refuses to run under a name that parses as a scope.** Every profile id
  passes, including `NEBULA_SUB`, `'agent:nebula'`, which is no UUID.
- **`ClientGateway` checks the name it is addressed by first in `__executeOperation`**, before it
  acks and before it looks for a socket, through a hook. Mesh's default requires a `.`, as
  `onBeforeAccept`'s does. `NebulaClientGateway` overrides it to require a dotless UUID followed by
  a `.`. The hook's name is agreed with Larry before the phase starts. `mesh.md` § *Nebula platform
  code never drops to raw primitives* names it beside `onBeforeCallToClient`.

**Success criteria:**

- **In-lane in `apps/nebula/test/test-apps/baseline/`, each starting a fresh chain on a real
  node.** No product path makes a Star call its sibling or a Profile start a chain into a Star,
  and a harness helper that made one would be a fixture (`live-scenarios.md`):
  - The Star `acme.crm.bigco` calling `acme.crm.other` is refused with
    `No passage from "acme.crm.bigco" into "acme.crm.other"`. *Mutation:* drop the derived value,
    and the message reads `(no scope)`.
  - A chain the Profile started is refused at a Star with `(no scope)`. *Mutation:* admit any
    claimless chain, and it passes.
  - A Galaxy's chain into one of its Stars is refused. *Mutation:* give the derived member
    `scopeAdmin`, and dominion admits it.
  - Positive controls: the Star calling itself, and calling its Galaxy, both pass.
- **`node-chain-passage`, a new `/live` scenario.** A tab calls `PROFILE`, then
  `NEBULA_CLIENT_GATEWAY`, at a sibling Star's name, and each is refused with its own message.
  *Mutation:* drop each check in turn. A positive control subscribes to the `NEBULA_SUB` Profile
  and receives its snapshot. *Mutation:* refuse every name that is not a UUID. Phase 8 makes every
  subscription push's fire-back a chain its Star started, so from then on every subscription
  scenario covers D10's admission too.
- **Standing guidance:** ADR-015 § *Predicate pair* and `security.md`'s ⏳ line under the JWT
  bullet lose their *Today's code differs* text. So does `auth.md` § *How the claims travel*,
  whose block is then empty and goes. `requirePassage`'s JSDoc describes the derived value.
- **`tasks/backlog.md`:** the row saying a chain a node starts carries no `originAuth` narrows to
  a Galaxy's alarm calling one of its Stars.

### Phase 5 — At a fire-back door, `callee` names the node that answered

At `__handleResponse`, `executeEnvelope` sets `callee` from the fire-back's last hop,
`callChain.at(-1)`, which the answering side appended (§ *What changes where a node receives its
own fire-back*). The request door still stamps the receiver's own identity, and a local dispatch
still stamps the address dispatched to. `broadcast.ts`'s warning that the two paths differ goes,
and so does the Client's matching warning on its own `lmz.broadcast`. Every comment saying where
`callee` comes from says those three sources, in the places § *What changes in standing
guidance* lists, and names the last hop's writer structurally: the answering side's own
framework, never the caller.

**Success criteria:**

- `broadcast.test.ts`'s *a DO target that throws after acking* asserts `callee` names the target
  that threw, not the broadcaster, and the `@see` in `broadcast.ts` follows.
  `callee-from-the-address.test.ts`'s *the FIRE-BACK leg shows the receiving node* inverts, and
  its ⚠️ comment arguing against the change goes. *Mutation:* stamp the receiver's own identity
  at the fire-back door again.
- Kept green as witnesses until Phase 8: `reaper-victim-is-the-address`,
  `profile-subscribe.test.ts`, and the forged-reply test in `profile-do.test.ts`. Phase 8 inverts
  the first and third.

### Phase 6 — Every call names a result handler

The three-argument `lmz.call` goes for every node type, and fire-and-forget becomes a handler
with `onErrorOnly` (D15). `lmz.call`'s handler, `lmz.broadcast`'s `onResult` and `Resources`'
`#send`'s `onResult` become required, so a site the build misses fails to compile.

- **The sites D15 names gain a handler**: `NebulaClient`'s subscribes and unsubscribes, through
  `#hostCall` or straight to the Profile, each `onErrorOnly`; `Galaxy`'s preview-ready nudge; the
  Profile's first snapshot to a new subscriber; and the six `Resources` sends without one. A first
  snapshot takes the reaper its broadcasts use, and a stream chunk a logging `onErrorOnly`.
- **Studio's *Wipe test data* button gains one too**, at `apps/nebula-studio-ui/src/App.vue:500`.
  Nothing type-checks `nebula-studio-ui`, so the compiler cannot find it.
- **A refused subscribe reaches the tab at once as its Error**, and `#subscribeVia`'s timer stays
  for a host that never answers.
- **What goes:** the `discard` kind, `dispatchEnvelope`'s branch for a call with no handler, the
  Client's `expectsResult` and the Gateway's branch for a call without one. `fireResponse`'s arm
  for an envelope with no `response` stays, because it logs a continuation that throws at the
  fire-back door.
- **`packages/fetch`'s two sites**, in `fetch.ts` and `fetch-executor-entrypoint.ts`, get an error
  handler that logs. A `packages/fetch` test this breaks is skipped with a reason, not fixed.
- **The text follows:**
  - ADR-003's *Today's code differs* block loses its last sentence, on a three-argument call;
    Phase 8 removes the rest.
  - `mesh.md`'s three-argument forms go from § *`call()` + a continuation is the ONLY cross-node
    call surface*, § *Passing data to the callee*, § *Object-capability access* and § *Fire-and-
    forget error delivery*. Its requirement that a result depending on a downstream node use
    "3-arg multi-hop" becomes an `onErrorOnly` multi-hop or a subscription.
  - The docs lose their three-argument calls, including those inside `@skip-check-approved` blocks
    in `index.mdx` and `lumenize-worker.mdx`, which the example checker never reads, and
    `FetchExecutorEntrypoint.md` with its source comment in `packages/mesh/src/lumenize-worker.ts`.

**Success criteria:**

- **`subscribe-refusal-arrives`, a new `/live` scenario.** A client subscribes only at its own
  token's `aud`, which passage always admits, and a host it reaches reports a stale or denied
  resource as a push. So each limb drives the refusal a user-developer meets in practice: a
  `NebulaClient` whose `resourceHostBinding` names the wrong binding.
  - Limb 1: with `'PROFILE'`, the Profile refuses the Star-shaped name at the early ack (Phase 4),
    and the subscribe gets that refusal within 5 s. *Mutation:* drop the subscribe's handler, and
    the refusal arrives only when `#subscribeVia`'s 30 s timer gives up.
  - Limb 2: with `'UNIVERSE'`, the Universe admits the call, then refuses it after the ack with
    `No member named …`, since it has no `resources`, and the subscribe gets that within 5 s.
    *Mutation:* the same, on the road after the ack.
- A `// @ts-expect-error` three-argument `lmz.call` compiles for a DO, a Worker and a Client.
  *Mutation:* make the handler optional again.
- A continuation that throws at the fire-back door logs, on the debug sink, namespace
  `lmz.mesh.lmzApi.fireResponse` and the message *post-ack chain threw with no handler to receive
  the error*. *Mutation:* delete `fireResponse`'s arm for an envelope with no `response`, and only
  `executeEnvelope`'s generic line remains.
- `'discard'` (3 hits in 1 file), `expectsResult` (32 hits in 5 files) and `3-arg|three-argument`
  in `.claude/rules` and `website/docs` (4 hits in 2 files) find nothing. `lmz.call(` in
  `apps/nebula-studio-ui/src` (1 hit today) names a handler at every hit, and a handler-less
  `lmz.call(` read by eye in `.claude/rules` and `website/docs` finds none.
- **BREAKING note:** the three-argument `lmz.call` goes, and `lmz.broadcast`'s `onResult` is
  required.

### Phase 7 — A Client's result handler continuation travels with its call

A Client sends its result handler continuation with its call, and it comes back filled (D11,
§ *A Client calls a node*). The `call` message gains `handler`, `onErrorOnly` and `loadId`. The
Gateway writes the envelope's
`response: { kind: 'mesh', returnAddr: <this Client>, handler, onErrorOnly, callId, loadId }`.

- **The Gateway refuses a Client-written continuation** that fails `validateOperationChain` or
  does not end in an apply, with a message, before dispatch.
- **`fireResponse` echoes the descriptor's `callId` and `loadId`** onto the fire-back envelope
  beside its `chain`, for any caller that set them; its client branch goes. It fires to the
  Gateway's `__handleResponse`, which hands the envelope to `ClientGateway`'s own fire-back entry
  (D23). `ClientGateway` sends
  `{ type: 'response', callId, loadId, chain, callContext: { callChain, originAuth } }` down the
  current socket.
- **A refusal at the early ack takes the same road.** `ClientGateway` fills the Client's
  continuation with the Error and appends the node it dispatched to as the last hop. It uses
  `fireResponse`'s fill code, factored out so a class extending `DurableObject` can call it
  (ADR-007).
- **The Client runs a `response` through `executeFilledChain`**, with the `@mesh()` check off and
  `callee` set from the chain's last hop. On an incoming call it stamps its own identity (D6).
  It runs no `onBeforeCall` there (D27).
- **The Client mints `loadId` once, when constructed, and drops a `response` whose `loadId` is not
  its own** (D21). Its in-heap handlers and their captured call-site context go.
- **`callAsync` keeps only its Promise**, keyed by `callId`. Its continuation is a call to a
  `LumenizeClient` method with no `@mesh()`, taking the id and the result (D16).
- **What goes:** `kind: 'client'`, `ClientResultEnvelope`, the `call_response` message and the
  exported `CallResponseMessage`.
- **The protocol name becomes `lmz.2`.** The Gateway answers 426 to an upgrade offering only
  `lmz`, before any side effect, and leaves an open socket alone. `packages/auth/src/hooks.ts`
  accepts it too; it is the known second copy (`mesh.md` § *Package dependency direction*).
- **The text follows:** ADR-007's *Today's code differs* block goes. The sentences in ADR-003's
  and `auth.md`'s blocks, and in `mesh.md`, saying a Client keeps its continuation in the tab go
  now, since this phase makes them false.

**Success criteria:**

- **`forged-continuation`, a new `/live` scenario.**
  - Limb 1: a raw socket sends a `call` whose frame names a `.dev` Star as `returnAddr`, with a
    continuation calling `resourcesResults.onOntologyPulled`. The forger has passage into that
    Star. Its continuation comes back to the forger alone, and the Star's guarded log marker for
    `onOntologyPulled` never fires. *Mutation:* the Gateway copies the frame's response fields
    into the envelope. *Mutation-only*, since today's frame has no such fields.
  - Limb 2: an upgrade offering only `lmz` gets a 426, and the tab's open socket stays open.
    *Mutation:* accept `lmz`.
- **`late-answer-dropped`, a new `/live` scenario.** A Client's call is held past its socket's
  close: a scenario-local socket under the Client's name closes as soon as it sends, so the answer
  waits out the gap in the Gateway's grace period. A second Client, built from the first one's
  `instanceName` in the same browser context, connects and receives it. It does not run it, and
  its debug marker names the foreign `loadId`. A positive control: an answer carrying the second
  Client's own `loadId` runs. *Mutation:* skip the `loadId` check.
- In-lane in `packages/mesh`:
  - A Client's call binds a Map, a Date, a cyclic object, an aliased reference and a custom Error
    subclass with its own properties into its continuation; each arrives intact, and binding a
    function fails at the call site. *Mutation:* send the handler without `preprocess`.
  - A `callAsync` call and a handler call whose node returns a marker-shaped value each receive it
    intact, and the injected chain never runs; a template's genuine nesting still resolves.
    *Mutation:* run the `response` with `executeOperationChain`. *Mutation-only*, since today's
    door runs the Client's own in-heap chain.
  - A continuation `validateOperationChain` rejects, and a valid one ending in a `get`, are each
    refused with their own message. *Mutation:* drop each check in turn.
  - `callee` names who answered on both refusal roads. *Mutation:* `ClientGateway` does not append
    the node it dispatched to.
  - A `response` carrying the Client's `loadId` and a `callId` it never sent still runs, so the
    Client keeps nothing per call. *Mutation:* drop answers whose `callId` it does not hold.
- `ClientResultEnvelope` (5 hits in 2 files), `CALL_RESPONSE|call_response` (68 hits in 10 files),
  `kind: 'client'` (2 hits in 2 files) and `#inHeapHandlers` (11 hits in 2 files) find nothing.
  `in-heap|in the tab` (31 hits in 11 files) is read by eye, and only `callAsync`'s Promise
  survives. No site outside `dist/` offers or answers the bare `lmz` subprotocol; today this
  finds 13 hits in 10 files, among them `website/docs/auth/index.mdx`:

  ```sh
  grep -rnE --exclude-dir=dist "Sec-WebSocket-Protocol['\"]?:? *['\"]lmz['\"]|\['lmz', *.lmz\.access-token|protocols = \['lmz'\]|protocol = 'lmz'|toContain\('lmz'\)|'lmz' and 'lmz\.access-token" .claude/rules website/docs docs packages apps
  ```
- **BREAKING notes:** the Client↔Gateway wire, including `lmz.2` and `CallResponseMessage`; and a
  Client's bound continuation arguments crossing the wire, so a function cannot be bound and a
  reactive object comes back as a copy. The rows stop saying
  `ClientResultEnvelope.clientInstanceName` stays.

### Phase 8 — A node's call to a Client acks early, and the Gateway keeps its continuation

The Gateway acks once the envelope's version and name check out, before it looks for a socket
(D11, § *A node calls a Client*). Every later outcome fires back to the node's
`__handleResponse`: a missed reconnect, the expired-token answer until Phase 10 replaces it,
D12's passage refusal, the 30 s timeout, and the Client's answer.

- **`ClientGateway` builds the fire-back itself.** Its chain is the node's continuation, filled
  with `fireResponse`'s fill code, honouring `onErrorOnly`. Its `callContext` is the envelope's
  own, with `{ type: 'LumenizeClient', bindingName, instanceName }` appended as the last hop:
  `ClientGateway` writes the `type` itself, and the names come from the socket's attachment, or
  from the envelope's `metadata.callee` when there is no socket. `originAuth` and `originRequest`
  come from the envelope, never the attachment. Its `metadata.callee` is `response.returnAddr`.
- **A Client-authored Error named `ClientDisconnectedError` is renamed before filling**, whether
  thrown or returned, so no Client can get itself reaped. A returned Error now reaches the node's
  handler.
- **Each wait `ClientGateway` keeps in memory is handed to `ctx.waitUntil`**, and its timer only
  times it out (D23).
- **Passage and expiry are checked immediately before each send**, against the attachment of the
  socket actually sent on.
- **`mesh.md` changes as D3 says.** § *`lmz.call` 4-arg — the result-handler mechanics* says a
  Client's continuation travels as a node's does. The Gateway section becomes
  *`LumenizeClientGateway` is the server-side half of a Client* and opens with D3's two
  requirements.
- **The last two *Today's code differs* blocks on this go**: `auth.md` § *Lumenize Nebula mesh*'s
  and ADR-003 § *When awaiting is OK*'s. So do the reaper comments in `apps/nebula/src/resources.ts`
  and `packages/nebula-auth/src/profile.ts` that say a Gateway answers inside its ack.
- **`mesh.md` § *`lmz.call` 4-arg — the result-handler mechanics* also says a Client's `response`
  door runs no `onBeforeCall`** (D27). Today it says a response is re-gated by `onBeforeCall`,
  which is right for a node and would read as a bypassed guard on a Client.

**Success criteria:**

- **`reaper-victim-is-the-address`, limb 1, inverts.** A forger's reply naming another tab as dead
  now leaves both the forger's row and the named victim's, since the forger's
  `ClientDisconnectedError` arrives renamed. The scenario's header says so, and the forged-reply
  test in `profile-do.test.ts` inverts the same way. *Mutation:* skip the rename on a thrown
  Error.
- **A returned Error named `ClientDisconnectedError`** reaches a handler that is not `onErrorOnly`
  renamed. In-lane, since no product handler asks for a Client's success value. *Mutation:* rename
  only thrown Errors.
- **`forged-continuation`, limb 3.** A hostile Client answers a push with an Error whose fields
  are shaped like an operation marker naming `resourcesResults.onOntologyPulled`. The reaper's
  receipt marker logs first, and the `.dev` Star's marker for `onOntologyPulled` never fires.
  *Mutation:* drop `filled: true` at `__handleResponse`. *Mutation-only*, since today the answer
  never reaches a fire-back door.
- `broadcast-120-subscribers` stays green, now reaping at the fire-back door.
- **`client-sender-passage` stays green through this phase.** After it, a peer's refusal comes back
  with the peer as its last hop, and the calling tab receives it because its `response` door runs
  no `onBeforeCall` (D27). *Mutation:* run `onBeforeCall` at that door, and both limbs wait out
  their timeout.
- In-lane in `packages/mesh`:
  - A Client push handler returns a Map, a Date, a cyclic object, an aliased reference and a
    custom Error subclass, and each reaches the node's handler intact. Today the value is thrown
    away. *Mutation:* `ClientGateway` reports the answer as an ack.
  - With a socket, a Client handler holds its answer until the test releases it, and
    `{ $ack: true }` resolves first, the `slowEcho` pattern. *Mutation:* await the Client before
    acking.
  - With no socket, `__executeOperation` returns `{ $ack: true }`, and the handler later receives
    `ClientDisconnectedError` whose last hop has `type: 'LumenizeClient'` and whose `originAuth` is
    the envelope's. *Mutation:* copy `metadata.callee` verbatim; take the attachment's claims.
  - Every wait `ClientGateway` holds reaches `ctx.waitUntil`, read through a spy. It cannot show
    the object stays resident; the deployed pass at the wipe gate is that check. *Mutation:* drop
    one `waitUntil`.
  - The direct `__executeOperation` tests in `lumenize-client-gateway.test.ts` invert to expect
    `{ $ack: true }`, with a real node as `returnAddr` receiving the outcome.
- `answers inside its ack` (5 hits in 5 files), `never from the reply` (2 hits in 2 files),
  `cannot name a victim` (1 hit) and `deliberately-awaited` (1 hit) find nothing.
  `grep -n "replaceNestedOperationMarkers(" packages/mesh/src` lists only the shared fill helper,
  its definition in `ocan/`, and `dispatchEnvelope`'s local path if that path does not call the
  helper.
- **`tasks/backlog.md`:** the row proposing that broadcast-to-client go fully async closes.

### Phase 9 — A Client re-subscribes exactly when the Gateway says it lost something

D4 in full. `ClientGateway` closes the socket with 4408 when its Client misses the 30 s wait, and
on every branch that answers `ClientDisconnectedError`.

- **`LumenizeClient` raises `onSubscriptionRequired` on its first connection after a 4408 close**,
  whatever `connection_status` says, from its own close handling. The Gateway starts its grace
  period at a 4408 as at any close, so a tab back within 5 s is told `false`; the close code is
  what tells it.
- **The Client compares each new token with the previous one**, on every path a token arrives by.
  A changed `sub` makes it reconnect as `{newSub}.{tabId}`; a changed `scopeAdmin` makes
  `NebulaClient` re-subscribe.
- **JSDoc on the Registry's `#mintIdentity` and the Memberships schema** says a membership never
  changes scope, and names moving one in place as the change that would break this comparison.
- **On any reconnect, a subscribe whose first snapshot has not arrived is re-sent.** A push in
  flight on a closing socket is re-sent on its successor with its original `callId`.
- **The Client keeps a small, bounded record of the `callId`s it recently answered**, with their
  answers, and answers a repeat from it without running the handler.
- **`NebulaClient` stops re-subscribing on every `reconnecting → connected` transition.** Its
  org-tree subscribe is gated on the same signal and joins the re-subscribe walk.
- **`packages/mesh/vitest.config.js`'s 500 ms call timeout moves** from `main` into Phase 1's
  timing project, with the tests that need it, or every slow push in `main` becomes a reconnect.
- **The text follows:** `lumenize-client.mdx`, including § *Grace Period*; `getting-started.mdx`;
  both for-docs `editor-client.ts` files; and `gateway.mdx` § *Resubscribing* and § *Client Call
  Timeout*.

This phase also takes over Phases 1, 2, 4 and 5 of `tasks/on-hold/mesh-resilience-testing.md`,
as limbs 3 to 5 below.

**Success criteria:**

- **`resubscribe-when-lost`, a new `/live` scenario.** Each limb drives a product path, never a
  test hook on the client:
  1. Studio in Chromium, frozen through Playwright's CDP session past 30 s, gets 4408,
     re-subscribes and receives the next write. *Mutation:* no 4408 close.
  2. With the boot's short `NEBULA_AUTH_ACCESS_TOKEN_TTL` (`bootVars`, as
     `session-survives-token-lapse` sets it), a call past the refresh-ahead point rotates the
     token. The rotation re-subscribes nothing, counted on the debug sink, and the next write
     arrives. *Mutation:* restore the blanket re-subscribe on reconnect.
  3. A scenario-local socket that holds the tab's reconnect for 2 s: the tab receives the push
     sent during the gap, is told `false`, and re-subscribes nothing. *Mutation:* answer at once
     instead of waiting.
  4. The same, held for 8 s: the tab is told `true`, re-subscribes and receives the next write,
     and the reaper's guarded marker shows the push sent while it was away reaped its row.
     *Mutation:* report `false`.
  5. A second connection under the same name closes the first with 4409, is told `false`, and
     the next push arrives on it. *Mutation:* report `true` on a supersede.
  6. A member promoted to admin while subscribed sees an admin-only resource once the tab's token
     refreshes, with no reload. *Mutation:* skip the `scopeAdmin` comparison.
  7. Accepting a broader membership in another tab reconnects this tab under its new `sub`, and
     it keeps receiving updates. *Mutation:* keep the first name, and the tab loops on 403.
- In-lane in `packages/mesh`:
  - A plain `LumenizeClient` closed with 4408 and back within 5 s still gets
    `onSubscriptionRequired`. *Mutation:* rely on the flag alone.
  - A push answered on one socket and re-sent on its successor runs its handler once, and the
    repeat is answered with the stored answer. *Mutation:* drop the record; answer a repeat with
    nothing, and the node's handler gets `ClientDisconnectedError`.
  - After N+k distinct answered `callId`s, the record holds N. *Mutation:* make it unbounded.
  - A subscribe sent just before a socket closes gets its snapshot after the reconnect.
    *Mutation:* drop the re-send.
  - A push in flight across a token rotation is delivered with no 4408 and no reap. *Mutation:*
    stop re-sending in-flight pushes.
  - `lumenize-client-gateway.test.ts`'s call-timeout test also asserts 4408.
- In-lane in `apps/nebula`:
  - A new token whose `scopeAdmin` drops under the same `sub` makes `NebulaClient` re-subscribe,
    in-lane because no product path demotes yet.
  - `NebulaClient`'s org-tree subscribe is re-sent on a `subscriptionRequired` reconnect and not
    on a rotation. *Mutation:* leave it out of the walk.
  - `nebula-client-reconnect.test.ts`'s blanket re-subscribe on supersede inverts.
  - `grep -nE "UPDATE Memberships|INTO Memberships" packages/nebula-auth/src` lists one insert and
    two updates, setting only `acceptedAt` and `scopeAdmin`, so no write moves a membership's
    scope.
- `#resubscribeAll` (12 hits in 6 files) and `re-issues every subscription` (2 hits in 1 file)
  find nothing; `apps/nebula/src/subscriptions.ts`'s two blocks are among them.
  `grep -rni subscriptionrequired` (66 hits in 9 files today) is read by eye, and every remaining
  hit describes this phase.
- **`tasks/backlog.md`:** the `subscriptionRequired` row is rewritten to what stays open,
  re-checking a subscriber's admin verdict on each push.
- **BREAKING note:** a Gateway closes a socket with 4408 when its Client misses an answer.
- **Hand-offs:** `tasks/on-hold/mesh-resilience-testing.md` keeps Phases 3, 6 and 7 and says this
  file took the rest. `nebula-pre-alpha.md` § *A Client connects to its scope's node* says D7 and
  D17 resume from this file's archive if a Gateway per tab survives.

### Phase 10 — A push that meets an expired token waits for the reconnect

On a call to a socket whose token has expired, `ClientGateway` closes it with 4401, starts the
grace period at its own close, and delivers on the new socket once the Client reconnects with a
fresh token (D5). A missed reconnect answers `ClientDisconnectedError`. `ClientTokenExpiredError`
is deleted, since this path is its only source. It lands after Phase 9 because until then a
reconnect re-subscribes everything, and the snapshot would hide a lost push.

**Success criteria:**

- **`push-survives-token-lapse`, a new `/live` scenario**, using the boot's short
  `NEBULA_AUTH_ACCESS_TOKEN_TTL` for a real lapse in about two minutes:
  - Limb 1: with a subscription open, a write's push arrives as a push on the new socket, and a
    later write arrives too. *Mutation:* answer at once, as today; with Phase 9 in place the
    reconnect re-subscribes nothing, so the push is lost.
  - Limb 2: with the session revoked before the lapse, the next write never arrives.
    *Mutation:* drop the expiry check, and the push reaches the revoked socket.
- In-lane: a push held by the 4401 path is checked against the new socket, with two sockets whose
  tokens differ in `scopeAdmin`. In-lane because no product path changes `scopeAdmin` inside one
  grace period. *Mutation:* check against the socket the call found.
- `lumenize-client-gateway.test.ts`'s expired-token test inverts: the call waits and is delivered
  after the reconnect.
- `ClientTokenExpiredError` (10 hits in 5 files) finds nothing.
- **`tasks/backlog.md`:** the BREAKING row stops listing `ClientTokenExpiredError` as new.

## Non-goals

- **D7 and D17**, parked until the master plan's Open decision 4 settles. Phase 9 hands them to
  it.
- **Hosting `ClientGateway` on a scope's node**, and persisting a held continuation on an alarm
  there: the later task that takes up Open decision 4.
- **Re-checking a subscriber's admin verdict on each push**, which stays in `tasks/backlog.md`'s
  `subscriptionRequired` row.
- **Calls between Clients**, which stay refused (D24).
- **`tasks/on-hold/mesh-resilience-testing.md`'s Phases 3, 6 and 7**, which stay on hold.
- **The structured-clone decoder's `globalThis` constructor lookup**, a separate fix spun off
  from Stage 2's second run; Phase 3 keeps a refused peer away from it on the Client.

# Calls to and from a client

**Status:** Pass 1, with every decision Larry's, 2026-09-30; a Stage 1 `/review-task` is next, then
Pass 2's phases. It builds after [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md).

## Goals

**Overall objective**: Make calls to/from Clients as close to any other mesh node as securly possible while recognizing that the Client code could be under the control of and modified by a bad actor. 

- Upstream and downstream calls and their responses pass through the Gateway and are processed in the same way as other calls between mesh nodes.
- Calls made with `newChain: true` to/from a Client behave as they would if they were to/from a server-side mesh node.
- To a server-side mesh node, a Client appears to behave like another server-side mesh node.
- Calls between Clients behave like calls between other mesh nodes.
- At one point, we switched calls between server-side nodes to always use a two one-way Workers RPC call pattern under the covers whenever there is a result handler continuation. The result handler continuation travels with the call so the caller doesn't need to store anything in case it hibernates before the response. Make sure the Gateway behaves as expected in this circumstance. Remove any vestigial code in the Gateway supporting the old mode from before, when the call was awaited on the caller's side (→ D8). Note, two waits remain:
  - **Up to 5 s for a reconnect.** The Gateway waits out a grace period for a Client in the middle of a reconnection.
  - **Up to 30 s for the Client's answer to a downstream call.** WebSocket messages are one-way, but the Gateway pairs the Client's answer with the call by a `callId` it mints and keeps in memory, and it holds the calling node's RPC open until the answer arrives or 30 s pass. This is the old awaited mode, kept on this one hop deliberately: `.claude/rules/mesh.md` calls it "the one deliberately-awaited hop". § *Gateway* says what it costs. D11 keeps the 30 s but moves it inside the Gateway, after an early ack, so the node no longer waits.
  - Two other 30 s values are unrelated: `callAsync`'s default timeout, and how early a client refreshes a token before it expires.

### Accepted limitations

- Multi-hop chains of calls cannot pass through a Client. The Client can appear at the beginning and/or the end of a call chain but never in the middle. The Gateway already makes this true: it starts every call a Client makes with `callChain: [thatClient]`, so a call the Client makes while handling another carries over only `state`.

## Relationships

- **Builds after [nebula-scope-moves-to-subdomain.md](nebula-scope-moves-to-subdomain.md), which rests three decisions here on its phases.** D10 relies on its phase *Every scope name is a legal host label*, whose 30-character slug cap stops a UUID-named node's name parsing as a scope. D13 relies on its phase *A push speaks for the node, not the writer*, which keeps a writer's tab address off every update. That same phase replaces the Gateway's fence with D12's passage check, built there.
- **Hands D9 and the call half of D12 to that file.** Its phase *Passage and dominion read the page's scope* already rewrites `requirePassage`, and its phase *A push speaks for the node, not the writer* already edits the fence. The answer half of D12 stays here, with D11.
- **Lands before ⑥ the wipe** ([nebula-pre-alpha.md](nebula-pre-alpha.md)). D11 changes the wire between a Client and its Gateway, and every generated app bundles the Client, so apps built before it must be rebuilt, which the wipe does anyway.

## What's true today?

### Access token claims

This is the token a Galaxy admin holds today while working on one of their tenants. The type
`NebulaJwtPayload` in `packages/nebula-auth/src/types.ts` defines it, and each comment names the ADR
that decides the claim:

```jsonc
{
  "iss": "https://nebula.lumenize.com",  // NEBULA_AUTH_ISSUER; the verifier refuses any other.
                              // nebula-scope-moves-to-subdomain.md derives it per deployment
  "sub": "8f3c…",             // the membership, a dotless UUID, and the only key (ADR-013)
  "aud": "acme.crm.bigco",    // activeScope. Today the client names it when it refreshes, and
                              // the refresh mints it only at or below authScope (ADR-022)
  "access": {
    "authScope": "acme.crm",  // the membership the token rests on. Today that is the scope in
                              // the refresh cookie's path, /auth/acme.crm (ADR-022)
    "scopeAdmin": true        // omitted when false. Dominion is this bit AND a scope covering
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

Two differences from ADR-022's target matter to this file. ADR-022's *Today's code differs* block
states both, and so does `docs/vision/auth.md` § *`activeScope`*'s:

- **Passage and dominion read `authScope` today, not `aud`** (`requirePassage` in
  `apps/nebula/src/nebula-do.ts`). `nebula-scope-moves-to-subdomain.md` § *Passage and dominion
  read the page's scope* moves them onto `aud`.
- **So a tab's `aud` decides which updates it receives, and nothing about what its calls may do.**
  After the WebSocket upgrade, the one thing on the call path that reads `aud` is the Gateway's
  fence on calls heading down to a client (§ *Gateway*, below). ADR-022 makes `aud` bound what a
  page's calls may do, and `nebula-scope-moves-to-subdomain.md` moves passage onto it and deletes
  the fence. That is the known ADR-022 gap, not a new one.

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
                                   // place: an update that inherits the writer's chain would
                                   // hand them to every subscriber
    origin: 'https://nebula.lumenize.com',
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
  `originAuth` or `originRequest`. Of today's subscription updates, only the Profile's start a
  fresh chain; a Resources update inherits the writer's (§ *Gateway*, *Downstream calls*).
  `nebula-scope-moves-to-subdomain.md` § *A push speaks for the node, not the writer* flips
  `lmz.broadcast`'s default, so after it every subscription update starts fresh.
- **A client sees three of the five fields.** A call arriving at a client carries `callChain`,
  `originAuth` and `state`. The Gateway leaves `originRequest` behind deliberately, for the reason
  in its comment above.
- **Leaving `callee` behind was never decided.** Every server-side node stamps `callee` itself,
  from its own identity, as a call arrives, and the client's receive path never got the same line.
  So the fix is on the client rather than in the Gateway (→ D6).
- **The one field a Client writes is `state`.** Its call WS message has no place for the others, so
  the Gateway builds them.

### Gateway

The Gateway is a Durable Object that holds one tab's WebSocket. Nebula's is `NebulaClientGateway`,
at the binding `NEBULA_CLIENT_GATEWAY`.

- **Connecting**
  - **Every tab gets its own Gateway, named `{sub}.{tabId}`**, such as `8f3c….a1b2c3d4`. The client
    picks the name: `sub` from its token, and `tabId` an 8-character id kept in the tab's
    `sessionStorage`, so a reload reaches the same Gateway. A duplicated tab inherits that
    `sessionStorage`, so on load the client asks over a `BroadcastChannel` whether another tab
    already holds the id, and mints a new one if so (`packages/mesh/src/tab-id.ts`; → D17). An
    impersonation client in the same tab gets a Gateway of its own,
    `{subjectSub}.{tabId}.{scope with dashes}` (→ D7). A persona's tab is not one of these: it is
    an ordinary Client with a token of its own, named `{personaSub}.{tabId}`.
  - **The Gateway accepts a name only if it starts with the token's `sub`.** The text before the
    first `.` must equal it, or the upgrade gets a 403.
  - **A new connection replaces the old one.** The Gateway closes the existing socket with code 4409
    before accepting the new one, so it never holds two.
  - **The Worker verifies the token, and the Gateway only decodes it.** The client sends its token
    as a WebSocket subprotocol, `lmz.access-token.{token}`. Nebula's Worker checks the signature,
    `exp`, `iss`, and that `aud` sits at or below `authScope` (`onBeforeConnect` in
    `apps/nebula/src/entrypoint.ts`), then forwards the upgrade with the token as
    `Authorization: Bearer`.
  - **The decoded claims live in the socket's attachment for the life of the socket.** An
    attachment is a small value, at most 2 KB, stored with a hibernatable WebSocket, so it survives
    the Gateway hibernating. It holds `sub`, the Gateway's own `bindingName` and `instanceName`,
    `claims`, and `originRequest`. A new token therefore means a new socket. Before sending on a
    socket whose token has under 30 s left, the client reconnects with a fresh one.
  - **An expired token closes the socket.** The Gateway checks `claims.exp` on every message the
    client sends. Once it has passed, the Gateway closes the socket with code 4401 and drops that
    message unanswered, and the client reconnects with a fresh token.
  - **A closed socket starts a 5 s grace period**, during which a call or an answer heading down to
    the client waits for it to come back.
  
- **Upstream calls** — a client calls a node
  - **A client makes a call in one of three forms**, and each gets a fresh `callId`:
    - `lmz.call(binding, instance, remote)` fires and forgets. The client keeps nothing, sends
      `expectsResult: false`, and the node discards its result. D15 removes this form (→ D15).
    - `lmz.call(binding, instance, remote, handler)` provides a result handler continuation. The
      client keeps the handler in memory under the `callId`, and sends `expectsResult: true`. Note, this is different from how it works between two server-side mesh nodes. In those cases, the handler continuation travels with the call. § *Can a result handler travel with a Client's call?* asks whether it should here too.
    - `await lmz.callAsync(binding, instance, remote)` returns a Promise. The client keeps the
      Promise's `resolve` and `reject` in memory under the `callId`, and also sends
      `expectsResult: true`. This is also different from how it work between two server-side mesh nodes where this form is not allowed. D16 keeps it (→ D16).
  - **Neither a handler nor a Promise is ever sent; both stay in the tab.** So on the wire the last
    two forms are the same message:
    ```ts
    { type: 'call', callId: '5e0b…', binding: 'STAR', instance: 'acme.crm.bigco',
      chain /* serialized operations */, expectsResult: true, callContext: { state: {} } }
    ```
  - **None of the three is vestigial.** `callAsync` is the one awaitable `.claude/rules/mesh.md`
    allows, and only on a client, because a tab's memory survives a reconnect while a Durable
    Object's does not survive hibernation.
  - **Nothing in the message says who is calling.** The Gateway
    builds `callChain`, `originAuth` and `originRequest` from the attachment, and takes only
    `state` from the client. `callee` is added once the call reaches the callee.
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
  - **The envelope carries no result handler, because the client's never leaves the tab.** Between
    server-side nodes the handler travels with the call, since the caller may hibernate and lose
    its memory before the answer comes. A tab keeps its handler in memory, so in its place the
    envelope's `response` tells the node where to send the bare answer:
    
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
    - a throw from the node's `onBeforeCall`. In Nebula that is passage, which refuses with a plain
      `Error` whose message is `'Active-scope mismatch'`, the same message it uses for the reserved
      platform name (→ D9). An unparseable scope name lands here too.
    
    The Gateway turns any of them into a `call_response` with `success: false` for that `callId`.
    
  - **Everything after the ack comes from the node's own code**, which answers with a second Workers
    RPC, to the Gateway's `__handleResponse`:
    - **`@mesh()` refusals**, such as `"Member 'x' is not mesh-callable…"` or
      `"No member named 'x' exists on this node…"`, and the refusal of a chain naming
      `constructor` or `__proto__`.
    - **Guard refusals**, whatever each guard throws. `requireDominionHere` throws
      `'Admin access required'` to a caller who is no admin at all. A Star's admin calling its
      Galaxy gets past passage, since upward is free, and is then refused with
      `'Admin access required for acme.crm — your admin scope is acme.crm.bigco'`.
    - **Errors the method throws.** A single Resources read without the grant throws
      `PermissionDeniedError`, carrying `tier: 'read'` and the `nodeId`. `NodeNotFoundError` and
      `OntologyStaleError` come back the same way (`apps/nebula/src/errors.ts`).
    - **A value, most of the time, and a refusal can be one.** A transaction catches each
      `PermissionDeniedError` and returns
      `{ ok: false, errors: { [resourceId]: { type: 'permission', requiredTier: 'write', nodeId } } }`,
      which the mesh delivers as a success.
    
  - **The node serializes the answer with `@lumenize/structured-clone`**, Errors included, and
    sends it bare: `{ callId, clientInstanceName, $result }` or `{ callId, clientInstanceName,
    $error }`. No handler and no `callContext` travel with it. This is the one branch in the node's
    `fireResponse` that depends on who called: for a node caller it already fills the handler with
    the result and fires the filled chain back. No task file changes that today.
    
  - **The Gateway sends it down the client's current socket without deserializing it**, as
    `{ type: 'call_response', callId, success, result }` or `{ …, success: false, error }`. With no
    socket, it waits out whatever is left of the grace period, then drops the answer with a log line
    and still replies `{ $ack: true }` to the node, the same reply as for a delivered answer. The
    node never learns the answer was lost.
    
  - **The Gateway changes no `callContext` here, because the answer carries none.** The fence on
    calls to a client does not run on this leg either, since the answer goes only to the tab that
    asked.
    
  - **The client matches the answer to its call by `callId`.** It minted the `callId` with
    `crypto.randomUUID()` and stored the handler or the Promise under it, as in the second and
    third forms above. An answer settles the Promise, or runs the handler.
  - **A handler runs under the `callContext` the client had when it made the call.** That is none,
    unless the client made the call while handling a call a node made to it; then it is that
    incoming call's context. The accepted limitation above does not change this, since the Gateway
    starts the new call's chain fresh either way.
  - **Delivery deletes the stored entry, and an answer that finds no entry is dropped.** That
    happens in two cases. A second copy of an answer already delivered finds its entry gone. And a
    fire-and-forget call never had an entry: the node sends it no answer, but the Gateway still
    sends one down when the call is refused at the early ack.
  - **An answer the Gateway dropped is never sent again.** A `callAsync` Promise rejects at its
    default 30 s timeout. A result handler never runs, and stays in memory until the client is
    explicitly disconnected. Under D11 the handler no longer waits in the tab, and one that never
    runs is the same best-effort outcome a node's handler has (→ D11).
  
- **Downstream calls** — a node calls a client
  - **A node calls a tab the way it calls any node**, by the tab's address:
    `lmz.call('NEBULA_CLIENT_GATEWAY', '8f3c….a1b2c3d4', ctn<NebulaClient>().x(…))`. Most such calls
    come from `lmz.broadcast`, which makes one `lmz.call` per subscriber.
  - **The node's own `lmz.call` builds the envelope**, so `callContext` inherits whatever call the
    node is running, with the node appended, unless the call asks for `newChain: true`.
  - **`lmz.broadcast` inherits by default today, and the sibling task flips it.**
    `nebula-scope-moves-to-subdomain.md` § *A push speaks for the node, not the writer* makes a
    fresh chain the default, which `docs/vision/auth.md` § *How the claims travel* already
    describes. It deletes the fence below in the same phase, since the fence would refuse every
    fresh update.
  - **Until then, a Resources update carries the writer's `originAuth`, `aud` included, to every
    subscriber.** The Resources plane calls `lmz.broadcast` without `newChain`. The Profile passes
    `newChain: true`, so a Profile update carries none.
  - **The Gateway's `__executeOperation` is its own code, not the shared receive path.** Nothing
    stamps its identity, and no `onBeforeCall` runs. In order, it:
    1. refuses an envelope whose version is not 1;
    2. finds the open socket. With none, it waits for a reconnect if the grace period is running,
       and otherwise answers `ClientDisconnectedError`;
    3. answers `ClientTokenExpiredError` if the connection's token has expired, closing the socket
       with 4401 (→ D5);
    4. runs `onBeforeCallToClient`. Nebula's is the `aud` fence, which throws
       `'Active-scope mismatch on call to client'` unless the call's `originAuth.claims.aud` equals
       the connection's. It skips the check for a call from the `PROFILE` binding. A call on a
       fresh chain carries no `aud`, so anything else sending one is refused (→ D12);
    5. sends the client `{ type: 'incoming_call', callId, chain, callContext: { callChain,
       originAuth, state } }`, under a `callId` the Gateway mints for this call.
  - **The fence checks the writer, not the sender.** A call reaches a tab only if the token at the
    start of its chain carries the tab's `aud`. For an update that token is the writer's, not the
    node's that sends it, because `lmz.broadcast` inherits the writer's chain today, so the only
    token on the update is the writer's. The fence dates from 2026-03, five
    months before passage existed. Passage would ask a different question: whether a caller may
    arrive at a node named by a scope. A tab is named `{sub}.{tabId}` rather than by a scope, and it
    already passed passage at the node when it subscribed. D12 replaces the fence with a check of
    the tab's passage into the sender's scope (→ D12).
  - **This is the one hop that does not ack early.** The Gateway holds the node's RPC open until the
    client answers, for up to 30 s after sending, and the node stays awake for as long (→ D11).
  - **The client asks only who made the last hop.** Its default `onBeforeCall` refuses a call whose
    `callChain.at(-1)` is another client, and never reads `originAuth`. D13 drops that refusal,
    and D14 guards `NebulaClient`'s update handlers instead (→ D13, D14). The chain's first operation must then be
    `@mesh()`-decorated, and its guard runs.
  
- **Responses to downstream calls**
  - **The node's result handler never leaves the node, and does not need to.** Between server-side nodes it
    travels with the call because the caller may hibernate before the answer comes. Here the node is
    still awake, awaiting the Gateway's reply, when the answer arrives, so the envelope's `response`
    goes unused and the node runs its handler itself (→ D11).
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
    asking for errors only skips the returned one (→ D11). If the Gateway fills the node's handler
    itself, as § *Can a result handler travel with a Client's call?* proposes, the two behave as
    between nodes because they go through the same filling code.
  - **These errors can come back:** `ClientDisconnectedError`, for no socket, a missed reconnect or
    a 30 s timeout; `ClientTokenExpiredError`; the fence's `'Active-scope mismatch on call to
    client'`; the client's `'Direct client-to-client calls are disabled by default…'`; a `@mesh()`
    refusal; and whatever the client's method throws.
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

## Can a result handler travel with a Client's call?

**Yes, in all three directions, under one rule: a result handler is never seen by a Client other
than the one that wrote it** (→ D11). Server-side nodes and Gateways are our code, and any Client may be
hostile. The rule matters because a filled handler runs at its author's response door with the
`@mesh()` check off, so whoever can change it on the way chooses code its author runs.

### A Client calls a node

- **The handler goes to the node and comes back to the Client that wrote it.** The Client sends
  its handler in the `call` message. The Gateway puts it in the envelope as
  `response: { kind: 'mesh', returnAddr: <this Client>, handler }`. The node fills it with the
  result and fires it back to the Gateway, which sends it down to the Client's response door.
- **It is safe because the Gateway writes `kind` and `returnAddr`, and the Client writes only the
  handler.** A hostile Client can put any chain in its handler, but it can only aim that chain at
  itself. The node never runs the handler: `fireResponse` fills it and sends it on.
- **The node answers a Client exactly as it answers a node.** `kind: 'client'`,
  `ClientResultEnvelope` and the `call_response` message go, and `fireResponse` loses its one
  branch that depends on who called.
- **The handler leaves the tab's memory.** It runs under the fire-back's `callContext`, as a
  node's does, so the Client's saved call-site context goes too. A result that lands after a reload
  runs on the reloaded Client, the way a Durable Object's handler runs on a cold instance.
- **`callAsync` keeps only its Promise in the tab.** It becomes a travelling handler naming a local
  method, with no `@mesh()`, that settles the Promise, so both forms send the same message.

### A node calls a Client

- **The Gateway keeps the node's handler, and the Client never sees it.** The Gateway acks the
  node at once, as any callee does, sends the Client only the chain, fills the handler with the
  Client's answer, and fires it back to the node's `__handleResponse`. Sending the handler down and
  back instead would let a hostile Client swap it for any chain, which the node would run with the
  `@mesh()` check off: `.claude/rules/mesh.md` names `resourcesResults.onOntologyPulled` as the
  member that would then install a validator of the caller's choosing.
- **The Gateway holds the handler in memory while the Client answers, up to the 30 s timeout.** It
  already holds each pending call that long, under a timer that keeps it resident. If it is evicted
  mid-wait, the node's handler never runs, where today the node's call fails and its handler runs
  with the error. For a reaper that means a dead subscriber's row lasts until the next update finds
  no socket.
- **It fixes three things at once.** The node no longer waits on the tab, which is the late-ack
  transport ADR-003 rejects: an awaited hop that "returns the callee's result instead of acking at
  admission", and today's code does exactly that. A successful answer reaches the handler with no
  special case in the node's dispatch. And a returned Error behaves as it does between nodes, because the Gateway fills
  the handler the way `fireResponse` does.

Two things must change first, both at the node's own response door:

1. **A reaper must still learn which tab failed.** At `__handleResponse`, `executeEnvelope` sets
   `callee` to the receiving node itself, so a reaper would read the broadcaster's own name and
   delete nothing. `tasks/backlog.md` records the old broadcast tier failing exactly this way. The
   fix is for `callee` on the response leg to name the node that answered, taken from the
   fire-back's last hop, which the answering node's framework writes (or its Gateway, for a Client).
   That makes D6's rule true of every node, and retires `broadcast.ts`'s warning that the two paths
   differ.
2. **The broadcaster must admit its own fire-back.** Once the sibling task makes every update start
   a fresh chain, the fire-back carries no claims, and `NebulaDO`'s `onBeforeCall` refuses a call
   with none. That is `tasks/backlog.md`'s row on fresh chains, and Larry's point that a fresh chain
   still needs an `aud`, taken from the node's own address, answers it: passage for a chain a node
   started is decided from that node's scope, which M2 pins (→ D10). No Client can start such a chain,
   because its Gateway always puts the Client first. The fire-back is the node's scope calling
   itself, so it passes. Whether a chain a node started also gets dominion below the node's
   scope, so a Galaxy could call its own Stars from an alarm, is a separate question the fire-back does
   not need.

### A Client calls another Client

- **The callee's Gateway keeps the handler, exactly as when a node calls a Client.** Gateway 1
  builds the envelope with Client 1 as `returnAddr`. Gateway 2 keeps the handler, asks Client 2,
  fills it and fires it to Gateway 1, which sends it down to Client 1's response door. If Client 2
  saw the handler, it could make Client 1 run any of Client 1's own methods with the `@mesh()`
  check off.
- **So one rule covers both: a Gateway that receives a call keeps its handler, whoever sent it.**
  Client 2 no longer refuses a call from another Client by default, and guards its own methods (→ D13).

### What it costs, and what it changes here

- **Bytes.** A Client's handler crosses the wire twice, out with the call and back in the
  fire-back.
- **A wire change.** A generated app bundles the Client, so an app built before the change must be
  rebuilt to talk to a new Gateway.
- **A wider door.** The second prerequisite has `NebulaDO` admit chains a node started, not only
  calls carrying a token's claims. That is a trust-boundary change for `/review-task`'s security
  lens to check.
- **What it replaced here.** D11 took the place of two earlier rows: the Gateway waiting inside its
  ack, and a fix for the value that wait drops. D4 and D5 stay, and D5 gets simpler, because the
  Gateway has already acked. D6 is the Client's half of the first prerequisite.
- **The open question about a dropped upstream answer closed with it.** A Client's handler no longer
  waits in the tab's memory, and one that never runs is the same best-effort outcome a node's
  handler has. `callAsync` already times out.

## Decisions

Every row is Larry's call. The D-numbers are append-only, and the prose above points at them with (→ Dn) where it describes the problem each one fixes.

| # | Decision | Rejected alternative — why |
|---|---|---|
| D3 | **`.claude/rules/mesh.md` § *`lmz.call` 4-arg — the result-handler mechanics* is corrected in the same change as D11** (Larry, 2026-09-30), to say a Client's handler travels as a node's does, and its line calling the Gateway "the one deliberately-awaited hop" goes. | **Correcting it first** — it would describe a Gateway that does not exist yet. **Leaving it** — it tells every session a Client's own error never arrives, which is false today and stays false. |
| D4 | **The Gateway closes the socket with code 4408 when a Client misses the 30 s wait** (Larry, 2026-09-30), so the tab reconnects and re-subscribes when it wakes. 4408 echoes HTTP 408 Request Timeout, as 4401 and 4409 echo 401 and 409. | **Leaving the socket open, as today** — a paused tab wakes with the same socket and never re-subscribes, so it stops receiving updates with nothing to show it. **Re-subscribing on `visibilitychange`** — the tab would re-subscribe every time someone returns to it, dropped or not, and only the Gateway knows it gave up. |
| D5 | **On a downstream call to a socket whose token has expired, the Gateway closes the socket with 4401, waits within the grace period for the Client to reconnect with a fresh token, and delivers on the new socket.** A missed reconnect answers `ClientDisconnectedError`, and `ClientTokenExpiredError` is deleted, since this path is its only source (Larry, 2026-09-30). | **Answering at once, as today** — the update is lost though the Client is back in moments. **Dropping the expiry check** — it is what keeps a revoked user's open socket from receiving updates after their token expires, since a revoked user cannot refresh and so cannot reconnect. |
| D6 | **A Client stamps `callContext.callee` itself, as every server-side node does** (Larry, 2026-09-30): its own identity on an incoming call, and the node that answered when a result handler runs, from the fire-back's last hop as D11 has every node do. | **The Gateway sending `callee` down with the call** — every other receiver takes `callee` from its own identity, never from the wire, and the Client already knows its own. |
| D7 | **An impersonation child's Gateway name joins its scope's slugs with `--`, and `NebulaClient.impersonate` refuses a child whose name a live child of the same parent already holds.** (Larry, 2026-09-30) No slug contains `--`, since `isValidSlug` refuses a doubled hyphen, so `acme.crm-x` becomes `acme--crm-x` and `acme.crm.x` becomes `acme--crm--x`, where single dashes made both `acme-crm-x`. ADR-021 joins a persona to its Star's label with `--` for the same reason. The refusal covers the one repeat left, the same subject at the same scope twice. | **Handing back the existing child** — the second caller would get a session the first can end. **Single dashes plus the refusal** — the refusal would also turn away two different scopes that happen to spell the same. **Dropping the scope from the name** — until `nebula-scope-moves-to-subdomain.md` takes a child's `aud` from the page, one subject's children at two scopes need two Gateways. |
| D8 | **The Gateway's `#getInstanceName` is deleted** (Larry, 2026-09-30). Nothing calls it, and it is the only dead code the Goals' sweep has found so far. | **Keeping it** — every reader of the trust boundary's source would have to work out that it is unused. |
| D9 | **`requirePassage`'s refusal names passage and both scopes, and the reserved platform name gets a refusal of its own** (Larry, 2026-09-30). It lands in `nebula-scope-moves-to-subdomain.md` § *Passage and dominion read the page's scope*, whose phase already rewrites `requirePassage` and makes `requireDominionHere`'s refusal name the page's scope. | **Keeping `'Active-scope mismatch'`** — once passage reads `aud` the words are accurate, but they are not the defined term, and they also refuse the platform name, where a superuser holds passage and is still refused. **Changing it in this file's build** — that phase rewrites the function, and the three baseline tests and two `/live` scenarios that match on the message, so doing it here edits them twice. |
| D10 | **A call chain started by a node whose name is a scope acts as a plain member of that scope** (Larry, 2026-09-30). When a call carries no claims and `callChain[0]` names such a node, passage is decided from that name: the node itself and its ancestors, with no `scopeAdmin`. The key is that the name is a scope, not which binding the node has, so a future helper node named by a scope is covered. `parseId` is the test, and it depends on `nebula-scope-moves-to-subdomain.md`'s phase *Every scope name is a legal host label*, which caps a slug at 30 characters: no id-named node's name parses after that, since a UUID is 36. That phase pins the invariant in a test, for a `profileId`, a persona's id and a Gateway's `{sub}.{tabId}`, all of which parse today. It grants nothing a caller did not already have, since anyone with passage into a node has it into the node's ancestors, and its chain carries no claims for dominion or a grant to read. Every passage check reads one derived value, the call's active scope: the claims' `aud` when the call carries claims, otherwise the scope of `callChain[0]`. Nothing writes a synthetic `aud` into `originAuth`. | **Admitting only a chain the node started itself** — it covers the fire-back and nothing else, for the same code as the general rule. **Adding dominion over the node's own subtree** — a real grant of power nothing asks for yet. **Keying on the binding, Universe, Galaxy or Star** — a list a new node named by a scope would fall off. **Changing nothing, so the Gateway keeps answering inside its ack** — the late-ack transport ADR-003 rejects. **Writing the node's scope into `originAuth` as a synthetic `aud`** — `originAuth` means claims a verified token carried, and ADR-016 would record a principal who never held one. `OriginAuth` would need a made-up `sub`, the one key ADR-013 allows. And mesh cannot tell which names are scopes, so node code would need a way to set `originAuth`, which the old broadcast tier's lesson in `tasks/backlog.md` rules out. |
| D11 | **A Client's result handler travels with its call, as a node's does, and a Gateway that receives a call keeps that call's handler** (Larry, 2026-09-30). Upstream, the Client sends its handler, the Gateway writes `response: { kind: 'mesh', returnAddr: <this Client>, handler }`, and the node fills it and fires it back as it does for a node caller. Downstream and between Clients, the callee's Gateway acks at once, keeps the handler in memory until its Client answers or 30 s pass, fills it and fires it back; a Client that misses the 30 s is treated as gone. No Client ever sees a handler it did not write. On the response leg `callee` names whoever answered, from the fire-back's last hop, which the two reapers need. `kind: 'client'`, `ClientResultEnvelope`, the `call_response` message and the late-ack wait all go. | **The Gateway answering inside its ack, plus a fix for the value it drops** — the late-ack transport ADR-003 rejects, holding the node awake for the tab's round trip. **Upstream only** — keeps that conflict on every call to a tab. **Amending ADR-003 to carve out the Gateway's hop** — keeps the cost and adds an exception. **Sending the node's handler down to the tab, signed by the Gateway** — a signing key and a check on every answer, to avoid holding what the Gateway already holds today. |
| D12 | **The Gateway checks the tab's passage into the sender's scope on what it sends its Client, replacing the `aud` fence** (Larry, 2026-09-30). Moved the same day to `nebula-scope-moves-to-subdomain.md`, whose phase *A push speaks for the node, not the writer* builds it on calls, where the fence was. The decision, its example and its rejected alternatives live there. **What stays here:** extending the check to answers. An answer to a Client's own call carries no sender today, `{ callId, clientInstanceName, $result }`, so it can be checked only once D11's fire-back names who answered. | **Building both halves here, after that file deletes the fence** — the branch would carry a few commits with no check on what reaches a tab. |
| D13 | **A Client accepts calls from other Clients, and defends itself by composing guard functions, as a server-side node does** (Larry, 2026-09-30). `LumenizeClient.onBeforeCall`'s default refusal goes, so it is a no-op like a node's, and the mesh docs' class-wide opt-in example goes with it. What protects a tab by default is that another tab rarely has its address, `{sub}.{tabId}`: a roster carries `sub` and `profileId` and no `tabId`, and guessing a `tabId` means guessing 8 random hex characters. That holds only once `nebula-scope-moves-to-subdomain.md`'s phase *A push speaks for the node, not the writer* makes updates start fresh; today an update inherits the writer's chain and hands the writer's tab address to every subscriber in `callChain[0]`. So this lands with that phase or after it. | **Keeping the default refusal** — too defensive, and all-or-nothing: overriding it to allow cursors also opens `handleResourceUpdate`. **A per-method opt-in on `@mesh()`** — it widens the decorator from a guard function to an options object. **A second decorator for peers** — new vocabulary for a job a guard function already does. |
| D14 | **Mesh exports a guard, `requireServerSideCaller`, that throws when a call's immediate caller is a Client, and each of `NebulaClient`'s update handlers composes it** (Larry, 2026-09-30). The seven are `handleResourceUpdate`, `handleProfileUpdate`, `handleOrgTreeUpdate`, `handleQueryUpdate`, `handleQuerySubscribersUpdate`, `handleStreamChunk` and `handlePreviewReady`, each becoming `@mesh(requireServerSideCaller)`. Under D13's model they keep exactly today's protection against a tab in the same scope spoofing an update. | **Leaving them unguarded** — they would rest on another tab not having the address, less than today's protection on the one surface where spoofing matters. **`requireNodeCaller`** — a Client is a node too. **`refuseClientCaller`** — `coding-style.md` makes `require*` the verb for a guard that throws. **`requireTrustedCaller`** — "trusted" is vague in an MIT package, where a user's own server-side node is not necessarily trusted. **`requireDOOrWorkerCaller`** — a list a new server-side node type would fall off. |
| D15 | **The three-argument `lmz.call` goes, for every node type: every call names a result handler, and fire-and-forget is a handler with `onErrorOnly`** (Larry, 2026-09-30). The 20 live sites each name an error handler: `NebulaClient`'s 18 subscribes and unsubscribes, `Galaxy`'s preview-ready nudge, and the Profile's first snapshot to a new subscriber, which then reaps a subscriber whose tab is gone. A refused subscribe reaches the tab at once as its Error, and `#subscribeVia`'s timer stays for a host that never answers. The `discard` kind of fire-back, the no-handler branches in `dispatchEnvelope` and `fireResponse`, the Client's `expectsResult` flag and the Gateway's branch for a call without one all go, and `lmz.broadcast`'s `onResult` becomes required. `.claude/rules/mesh.md`'s three-argument bullet and `website/docs/mesh/` change with it. `packages/fetch`'s two sites have their tests skipped rather than fixed, since that package is headed for deprecation. | **Keeping it, and adding the Client's missing log line** — a refused subscribe would still be noticed only when a timer gives up, and the Profile's row would still leak. **Keeping it as shorthand whose errors go to one hook per node** — new API and vocabulary, and it takes the handling away from the call site that knows what the call was for. |
| D16 | **`callAsync` stays public on `client.lmz`, built on D11's travelling handler: one message on the wire, two spellings in code** (Larry, 2026-09-30). Its handler names a local method, with no `@mesh()`, that settles a Promise kept in the tab, so it sends exactly what a result-handler call sends, and only the Promise and its timeout differ. `callAsync`'s JSDoc in `packages/mesh/src/lumenize-client.ts` states this, since it is already true today. The code Studio's model writes never calls it: the platform docs teach `await client.resources…` and mention `callAsync` nowhere, and its six calls all sit inside `NebulaClient`. | **Only inside a Client subclass, for building an SDK** — it would narrow ADR-003's user-land awaiting to SDK methods, and third-party mesh users would lose the awaitable. **Removing it, so SDK methods take callbacks** — it fights the training in the 39 places the model's docs teach `await`, and amends ADR-003. |
| D17 | **A tab keeps its `tabId` in `sessionStorage`, and a Web Lock on the id replaces the 50 ms `BroadcastChannel` probe for a duplicated tab, in a late phase** (Larry, 2026-09-30). A tab holds its id's lock until it closes, including while paused, so a duplicate finds the lock taken and mints a new id with no race. The phase's first criterion is a measurement: a reloaded page must get the lock its previous page held, or every reload would mint a new Gateway name, the leak `tab-id.ts` exists to prevent. If a reload can lose its lock, the phase is dropped rather than worked around. | **Reusing ids across tabs from `localStorage`, each claimed by a lock** — it saves Gateway names that cost nothing, and a new tab could land on a Gateway closed seconds earlier and receive updates for rows it never made. **A fixed pool of lock names with no storage** — the `tabId` becomes a small, guessable number, which undercuts D13. **Leaving the probe** — a paused original misses the 50 ms window, and the two tabs then close each other's connection with 4409 over and over. |

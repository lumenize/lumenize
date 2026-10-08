---
paths:
  - "packages/mesh/**/*.ts"
  - "packages/fetch/**/*.ts"
  - "packages/nebula-frontend/**/*.ts"
  - "apps/nebula/**/*.ts"
  - "packages/resources/**/*.ts"
---

# Mesh Patterns

Applies to **mesh-based code** — `LumenizeDO` subclasses / `this.lmz` / `this.svc`: `packages/mesh`, `packages/fetch`, `apps/nebula`, `packages/nebula-frontend`. Communication MUST go through the Mesh abstraction and MUST NOT use raw DO primitives — the most common mistake is dropping to raw Workers RPC where a mesh call belongs. (Raw-DO infrastructure like `auth`/`testing` is a different layer → [raw-comm.md](raw-comm.md); to tell which layer you're in → [workers-projects.md](workers-projects.md). Local DO correctness → [durable-objects.md](durable-objects.md).)

## Prefer `lmz.call()` / `ctn()` over raw RPC — always
- Cross-node communication MUST go through `this.lmz.call(...)`; **raw Workers RPC** (`stub.method()`, `env.X.get(id).method()`) MUST NOT be used in application code without explicit human approval. Raw RPC **bypasses the Mesh security model** (callContext-based auth/identity propagation and the declared `@mesh()` call surface) and also holds a stub open (wall-clock billing). Framework code like `ClientGateway` is the rare approved exception — see § *`ClientGateway` is the server-side half of a Client* below.
- Continuations (`this.ctn()`) propagate **`callContext`** across every hop automatically — identity (`originAuth`) and provenance (`callChain`) — which raw RPC drops entirely. Identity MUST NOT be threaded by hand; for what rides in `callContext` vs. travels as continuation parameters, see § *Passing data to the callee*.
- **You MUST flag any pseudo-code or implementation that uses `stub.method()` directly instead of `lmz.call(binding, instance, continuation)`.** The sanctioned exceptions are [ADR-023](../../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)'s two bridges, in § *Nebula platform code never drops to raw primitives*: a facade's one raw hop, and `rawRpcStub`.

## `call()` + a continuation is the ONLY cross-node call surface
There is **no awaited request/response form.** `callRaw` was removed (`mesh-continuation-only-calls`, 2026-07-03) — it now throws a loud deprecation error and is deleted next release. `this.lmz.call(binding, instance, remote, handler, options?)` never returns a value to the left of `=`; it delivers the outcome to a **result handler**, which every call MUST name. The single awaited hop survives ONLY as private framework transport (the early-acking `#dispatchEnvelope`), which ADR-003 blesses as "transport, not architecture." **App/platform/client code MUST NOT await a cross-node call — grep-able bright line — with ONE sanctioned exception: the client's `callAsync` (below).**
- **Every call names a handler.** No call omits it; the type refuses one. A call whose answer nobody needs passes `{ onErrorOnly: true }`, so its handler hears only a failure — a refusal at admission or a throw after it — and logs it, retries, or cleans up. That is also the form for genuine multi-hop: each hop fires an onward `call()` naming the next node, and hears only that hop's failure.
- **The handler** (`lmz.call(binding, instance, remote, this.ctn().handler(remote))`) — the callee **acks early** (before running the chain), does the work (may be long / hibernate freely), then **fires the outcome back** into your `handler`: the value on success, the Error on a chain throw. The caller holds **ZERO state** — a DO/Worker's handler *travels* with the call (runs on a cold, storage-restored instance if the caller was evicted); a client's handler travels too, and its host node hands the filled continuation down to **whatever socket the client is on now.**
- **The handler is RESILIENT by construction** — this inverts the old advice. It survives WS reconnect, tab sleep, and DO hibernation, so the old "thinking… forever" bug (an awaited result bound to a dead socket) is gone *by construction*. The old carve-out — "keep awaited `callRaw` for short reliable DO↔DO/Worker hops, fire-and-forget only for client-facing/long" — is **retired**: `call()`+continuation is the one path, and a handler is the *safe* choice for exactly the client-crossing/long calls it used to be a workaround for. (The `[[client-calls-use-direct-delivery]]` memory's "callRaw fine for short hops" is stale — retire it.)
- **A target whose answer a handler waits for MUST be cross-node-self-contained:** it produces its result with local sync/async only (no *further* cross-node call). A result that depends on a downstream node MUST use an `onErrorOnly` multi-hop or a **subscription** (for live UI data, a subscription SHOULD be preferred outright — see the Nebula reactive-UI note).
- **`onErrorOnly` (5th arg)** skips the success fire-back callee-side, for a call whose answer nobody needs and for a fan-out, so a broadcast to N targets doesn't fire N discarded success handlers. Canonical: `lmz.broadcast`, whose `onResult` is required and which adds it to every call, for drop-a-dead-subscriber cleanup.
- **`client.lmz.callAsync(binding, instance, remote, opts?)` — the ONE sanctioned awaitable, client-only** (`mesh-client-callasync`, 2026-07-03). `callAsync<T>(): Promise<Awaited<T>>` wraps the same one-way fire and re-resolvable fire-back as a *client* `call` with a handler.
  - **It survives what the removed `callRaw` did not.** The client keeps only its Promise, **keyed by `callId`**; its continuation travels like any client call's, and the client's host node re-resolves delivery to whatever socket the client is on now, so the Promise survives tab freeze and WS reconnect instead of stranding on a dead socket. It *realizes* ADR-003 rather than violating it.
  - **It is bounded.** A built-in default `timeoutMs` (30 s; `0`/`Infinity` disables) is composed with an optional caller `AbortSignal` via `AbortSignal.any`. ⚠️ Abort cancels the WAIT, not the server OP, so only idempotent ops MAY be retried (client-supplied UUID / ADR-005 eTag).
  - **The greppable rule: the only awaitable on `client.lmz` is `callAsync`; `lmz.call` stays `void`** — a `grep 'lmz\.call\b'` hit MUST NOT be `await`ed. **DOs/Workers MUST NOT get `callAsync`**: a held heap Promise dies on hibernation, so they use the traveling handler.
  - **It is the escape hatch, not the default.** A `subscribe` SHOULD be preferred for live UI data, as SHOULD higher-level SDK methods (`client.resources.*`) when they exist; `callAsync` is for a one-shot read or mutation.
  - **Callee side:** a method reached by `callAsync` **returns its value** and the framework fires it back, the same as any call's target. It MUST NOT explicitly invoke a named handler by `requestId`; that pre-`callAsync` hand-roll is retired. Canonical consumers: `packages/resources/src/nebula-client.ts` `orgTree.*` / `#readResource` / `#meshSubmit`.

## DO vs Worker routing rule
`lmz.call(bindingName, instanceName, remoteContinuation, ...)` decides DO vs Worker entirely by **whether `instanceName` is `undefined`**. From `packages/mesh/src/lmz-api.ts` `callRawImpl`: `calleeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker'`.
- A **DO** binding MUST be given an instance name.
- A **Worker** (service) binding MUST be given `undefined`.
- **An instance name holding a `/` addresses a Client a node hosts.** `lmz.call('STAR', 'acme.crm.tenant1/alice.9f2c41aa', …)` reaches the Star `acme.crm.tenant1`, whose doors hand it to the `ClientGateway` it composes (`hostInstanceOf` in `packages/mesh/src/client-address.ts`). A node that composes none refuses it.

The call path validates the binding against its actual shape **synchronously, before dispatch** (`assertCallTarget` + `isDONamespace` from `@lumenize/routing`), so a mismatch **throws a clear error at the `lmz.call(...)` site**, before the handler could hear of it. Passing a label string for a Worker call (e.g. for tracing) throws *"binding '…' is a Worker/service binding but an instance name was supplied"*; a DO binding with no instance name throws *"requires an instance name"*. The instance-name slot is for DO routing only and MUST NOT be used as a data or label channel; to pass data to the callee, see § *Passing data to the callee* below.

## Node identity is stamped on every first-contact entry (not just mesh calls)
The framework populates a node's persistent identity — `this.lmz.bindingName` / `this.lmz.instanceName`, the basis for return addresses, tracing, and anything derived server-side from *which instance this is* — from routing metadata on **every** entry that can be first-contact, not only the mesh receive path. If a node serves its **own** HTTP/WebSocket `fetch()` surface, identity is stamped from the `x-lumenize-do-*` headers the Worker's forward sets — for a page, `forwardPage` in `apps/nebula/src/page-forward.ts`, and for a Client's upgrade, `routeDORequest` behind `hostedUpgrade` in `apps/nebula/src/entrypoint.ts`, each of which drops any the client sent first — at `fetch()`/accept time — because hibernation `webSocketMessage`/`webSocketClose` handlers can't re-derive routing metadata. So `instanceName` is populated on the non-mesh path too; relying on the mesh path alone leaves it `undefined` on a cold non-mesh entry (e.g. a container node injecting its server-derived scope into the shell it serves — an empty value mis-routes silently). The third source is the `@rawRpc()` entry, `__rawRpc`, which stamps the binding and instance name `rawRpcStub` passes once it has checked they name this object — so `Profile.setDisplayNames`, the first touch of a new person's Profile, finds its name stamped. First-write-wins keeps the paths consistent. (Rationale: ADR-007.)

## A client's `instanceName` MUST start with its `sub` — its upgrade is refused otherwise
A client's `instanceName` is its id on the node that hosts it, the one path segment after
`/gateway/`. The Worker's `hostedUpgrade` (`apps/nebula/src/entrypoint.ts`) refuses the upgrade before
routing unless the id has a `.` and `id.substring(0, indexOf('.'))` equals the `sub` of the
**verified JWT** (403 *"identity mismatch"*). The node does not check again: it only decodes the
token, so it could not tell a forged `sub` from a real one.

⇒ **The subject's `sub` comes FIRST; everything after the first `.` is free.** Put a tab id, a scope,
or anything else in the leading segment and you get a 403 that reads as a *token* problem — the
message says "identity mismatch", so the natural next move is to go debug minting, which is the wrong
file. ⚠️ This works at all only because a surrogate `sub` is a **dotless** UUID; a `sub` containing a
dot would break the parse rather than the comparison. Canonical: `childInstanceName` in
`packages/mesh/src/impersonation.ts`, which appends `${tabId}.${scope}` after the subject's `sub`.

## Passing data to the callee
**Default: whatever the callee needs SHOULD be passed as arguments to the continuation method.** The callee declares them as ordinary parameters and they cross the wire — explicit, typed, and visible at the call site:
```typescript
this.lmz.call('DOCUMENT_DO', documentId,
  this.ctn<DocumentDO>().update(content, extraContext1, extraContext2),
  this.ctn().handleCallFailed('update'), { onErrorOnly: true });
// callee: update(content, extraContext1, extraContext2) { ... }   — params come across as-is
```
**The call context has no field for your own data.** Each need that might reach for one has a home of its own:
- **Raw identity/claims** → `callContext.originAuth`, verified from the origin's JWT and filled automatically.
- **An authorization decision** MUST be computed in the node it is about — its `onBeforeCall`, a guard, or a gate — from `originAuth` and that node's own storage, and MUST NOT be cached in or carried by the context. Only the guard on a chain's first operation runs, so a cached decision saves nothing, and one carried to another node was computed for a different node. Canonical: `editAsEditor`'s guard in `packages/mesh/test/for-docs/security/team-doc-do.ts`.
- **Tracing/provenance** → `callContext.callChain`, the immutable `[origin, …, caller]` path, extended every hop. Reset with `CallOptions.newChain: true` when a node should become a fresh origin; a client's calls take no `newChain`, since each starts at the client.

## Object-capability access: gate once, then chain
The `@mesh()` member-level check runs **only on a chain's entry op** (`operations[0]` — the first member NAMED, which for `ctn<T>().admin.addUser(u)` is `admin`, not `addUser`); later calls in the same chain run on whatever that returned, un-re-checked. Beyond per-method `@mesh(guard)`, this enables an **object-capability** model: a gate method returns a **class instance whose methods *are* the capability** — they need no `@mesh` of their own and are reachable **only by first passing the gate**, in one round trip, so holding the returned instance *is* the authorization.

```typescript
// Callee — onlyAdmins() is the ONLY @mesh door; it returns a capability instance
@mesh(requireDominionHere)
onlyAdmins(): AdminOps {
  return new AdminOps(this);                 // you only get an AdminOps by passing requireDominionHere
}
// The capability surface — a plain class; NO @mesh on its methods
class AdminOps {
  #node: MyDO;
  constructor(node: MyDO) { this.#node = node; }
  resetTenant(id: string): void { /* privileged work via this.#node */ }
}

// Caller — one hop: the gate runs (requireDominionHere), then resetTenant on what it returned
this.lmz.call('MY_DO', instanceName, this.ctn<MyDO>().onlyAdmins().resetTenant(tenantId),
  this.ctn().handleCallFailed('reset'), { onErrorOnly: true });
```

A caller can't shortcut the gate: `ctn<MyDO>().resetTenant(...)` fails the member-level `@mesh` check (`resetTenant` isn't `@mesh` — it isn't even on `MyDO`). Reach for this when a **cluster** of privileged ops sits behind one check (gate once instead of `@mesh(requireDominionHere)` on each), or when the capability should carry scoped state (the returned instance can close over *what* the caller may touch). It's powerful but **underused** — the per-method `@mesh(guard)` shape is the default reflex (and what LLM training knows); use whichever is clearer, but know this exists. Rationale: ADR-007; entry-only mechanism lives in `packages/mesh/src/ocan/execute.ts`. ⚠️ **`svc.*` is NOT a built-in version of this** — it used to be exempt from the member-level check and is not any more, so a chain arriving off the wire that opens on `svc` is refused at its first op. A chain the NODE authored may still open there.

**A gate is a GETTER when it takes no arguments, a method when it does.** `@mesh(requireAdmin) get admin()` reads at the call site as the thing it hands back — `ctn<Galaxy>().admin.addUser(u)` — which is how the caller thinks of it, and it matches the SDK spelling a generated app already uses. The method form is not deprecated and nothing refuses it; what changed is which one an example should show. ⚠️ Scope this to GATES, not to arity: `Star.resetDevData()` takes no arguments and **destroys and rebuilds data**, so a getter there would turn an action into a mutation on property read.

**What a gate hands back is the whole of what the caller may then read and call, and the framework does not police it.** Past the entry op nothing is checked except the walk rules, so:

- **Hand back only methods** (including getters). A returned object is a surface, and every member on it is reachable.
- **Take care not to hand back `this`, `this.ctx`, `this.env` or `this.svc` by accident** — `@mesh() get self() { return this }` is a foot-gun, visible in your own source, and deliberately not refused: the carve-out that lets a node's own continuation root at `ctx` is the same mechanism.
- **A GETTER entry owes four things**: side-effect-free, synchronous, cheap, idempotent. Nothing at the call site says code runs, which is the whole reason the discipline is worth stating — a gate returns a surface and does nothing else.

**A gate the RESPONSE leg reaches MUST carry no `@mesh()` at all.** Its members are what the node's own continuations name as result handlers — reapers, a fire-back's answer — and both paths that reach them run with the member-level check off: the fire-back door, and the local dispatch when a target refuses at admission. Nothing is passed there, so the "holding it is the authorization" property above does not hold; what leaving off `@mesh()` buys is that a REQUEST naming the gate is refused as not mesh-callable. Canonical: each Nebula host's `get resourcesResults()`, returning the Resources plane's `results` surface (`packages/resources/src/resources.ts`) — the reapers, the node invite's answer, and a Star's ontology pull. It sits beside the `@mesh()`-decorated `get resources()` and looks like an oversight; decorating it for symmetry would let any caller with passage call `onOntologyPulled`, which checks no permission and installs whatever validator bundle it is handed — and on a `.dev` Star, runs the install's wipe. (`onInviteResult` is the usual example and not the reason: a forged call runs under the forger's own claims, and `setPermission` re-checks `admin`.)

## Multi-hop / direct delivery
A continuation names its *final* destination, so a call can hop client → Star → Worker → **directly back to the client** without unwinding through the intermediate hops — each hop fires a one-way call to the next node instead of awaiting and backtracking. This is architecturally motivated (skip the backtrack), independent of any cost argument, and is the pattern to reach for. Canonical: a spell-check kicked off by a doc edit reports straight to the client, not back through the document DO. See [calls.mdx](../../website/docs/mesh/calls.mdx) § Direct Delivery.

## Two one-way calls for external I/O (cost angle — not a default)
The bare pattern is sound and alarm-free: a DO fires a one-way call to a Worker, the Worker does the external `fetch()`, then fires the result back (analytics example in calls.mdx). It keeps the DO out of wall-clock billing while the CPU-billed Worker waits. But it is **no longer a slam dunk for external I/O** — the extra hop, added latency, and per-call storage writes erode the savings, so the old "worth it above ~5 s" breakeven is soft and unverified. Reach for it only for genuinely long calls where you've confirmed the win; otherwise a result handler that waits for the answer is simpler (and, now that it's early-ack + resilient, fine even for long work). `@lumenize/fetch` adds a *delivery guarantee* on top via an alarm backstop, and **that add-on is experimental with a known flaw** (one alarm timer double-duties as both the fetch timeout and the executor-liveness backstop, so long fetches, past-budget deliveries, and concurrent in-flight requests are unproven). `@lumenize/fetch` MUST NOT be used in product/Nebula code without human sign-off.

## Alarms
Mesh code MUST schedule with `this.svc.alarms.schedule(delaySeconds, this.ctn().handler(...))` — the alarm carries an OCAN continuation, so the scheduled work runs as a mesh call with callContext intact. `ctx.storage.setAlarm` MUST NOT be hand-rolled in mesh code (that's the raw-DO path — see [raw-comm.md](raw-comm.md)).

## `lmz.call` — the result-handler mechanics
(The handler and `onErrorOnly` basics are in the surface section above; this is *how* the outcome reaches your handler.)
- **The outcome rides a fire-back, not an awaited return.** The callee acks early, runs the chain, then fires the filled handler back one-way. Your handler receives the success value OR the Error in its `$result` slot — a remote `@mesh` throw arrives as that Error (structured errors like `ClientDisconnectedError` keep `name` + custom props). On a node it runs at the caller's `__handleResponse` sink under the naturally-propagated response-leg `callContext`, re-gated by `onBeforeCall`/`requirePassage` (member-level-check-off, **scope-check-ON**) — except on a chain the caller itself started, where the hook does not run. There is **no `callRaw` rethrow** — the Error is delivered *to* the handler.
- **The handler is NOT necessarily local.** DO/Worker: it *travels* in the envelope and runs on the callee's fire-back (on a cold, storage-restored caller if the caller was evicted). Client: it travels too, and the client's host node delivers the filled continuation to the client's current socket, where it runs with the `@mesh()` check off and no `onBeforeCall`, because passage is the host node's job and the answer inside the Client's own continuation is data; a client drops an answer carrying another load's `loadId`. Either way you never `await` it.
- **A call to a client is answered as a node answers it.** The client's host node acks early, keeps your continuation, and fires it back filled: with `ClientDisconnectedError` when the client has no socket, misses its reconnect or does not answer within 30 s; with the host node's own refusal; or with the client's answer, thrown or returned. A client's own Error named `ClientDisconnectedError` arrives renamed, so only a client's host node can say a client is gone, and a reaper matching that name never reaps on a client's word.

Use the handler for reactive cleanup, retry, and observability — anything that reacts to "did it land?" without `await`ing. A result handler needs **no** `@mesh()`. It runs either at the caller's fire-back door, for any target that acked and then answered, a client's host node included, or locally on the caller's own dispatch, for a target that refused at admission — and neither checks for `@mesh()`. The handler MUST carry `@mesh()` **only** if it must ALSO be dispatched as an ordinary request — and ⚠️ weigh what that costs, because `@mesh()` makes it callable by any caller who can reach the node, with arguments of their choosing. The "not remotely callable" boundary is the **absence of `@mesh`**, never visibility. A `this.ctn()` handler MUST be **`public`** (TS only surfaces `public` members on `Continuation<this>`; the modifier is erased at runtime, so non-public buys nothing while forcing an untyped `(this.ctn() as any)` cast). Canonical local-only handlers: the members of a Resources plane's `results` surface, reached through each Nebula host's `resourcesResults` getter, which has no `@mesh()` (`packages/resources/src/resources.ts`). (User docs: [continuations.mdx](../../website/docs/mesh/continuations.mdx).)

**A node's `onBeforeCall` does not run at its fire-back door on a chain the node started**, so a class-wide guard that requires claims needs no exception for the answers to its own broadcasts and alarms, whose chains carry no `originAuth`. `executeEnvelope` compares `callChain[0]` with the receiving node. That costs nothing: the envelope's `callChain` is the sender's to write at either door, and only code holding the node's binding can send a fire-back. Before 2026-10-06 every such guard had to admit the node's own chain itself, and one that forgot refused every reaper's answer with only the answerer's error log saying so.

```typescript
// lmz.broadcast (broadcast.ts) — fire each push, react only to failures
lmz.call(t.bindingName, t.instanceName, remote, onResult, { onErrorOnly: true });

// The Resources plane's reaper, on its `results` surface — drop a subscriber whose host node
// reported it disconnected. The victim is the address the push went to, never a field of the reply.
// It is reached through the host's `resourcesResults` getter, which has no `@mesh()`: the client's
// host node fires the failed push back to the plane's fire-back door, where the decorator is not checked.
// `sentAt` rides the continuation from the broadcast: only a row no newer than the push goes,
// so a re-subscribe that lands before this reaper keeps its row.
onBroadcastResult: (resourceId: string, sentAt: string, result?: unknown): void => {
  if (result instanceof Error && result.name === 'ClientDisconnectedError') {
    const callee = this.#lmz().callContext.callee;
    if (callee?.instanceName) this.removeSubscriber(resourceId, addressOf(callee), sentAt);
  }
},
```
Application code rarely writes this per-target call by hand — it gets the same drop-on-failed-broadcast cleanup for free via `lmz.broadcast(targets, remote, { onResult })`. Canonical: `lmz.broadcast` in `packages/mesh/src/broadcast.ts` + the plane's `results.onBroadcastResult` in `packages/resources/src/resources.ts`.

## "`@mesh()`-decorated", never "marked" (naming)
`@mesh()` decorates a method or a getter; a field or an `accessor` fails to compile under it. Prose and comments MUST call such a member "`@mesh()`-decorated", or say it has no `@mesh()`, and MUST NOT call it "marked" or "unmarked" or refer to "the mark": other decorators exist, and the TC39 proposal says "decorated". `npm run audit:mesh-vocab` checks the tree, and `scripts/mesh-vocab-hook.sh` reports any line an edit adds.

## "broadcast" vs "fanout" (naming — don't flip-flop)
`broadcast` is the Lumenize primitive (`this.lmz.broadcast`), its API symbols (`onBroadcastResult`, `BroadcastTarget`), and the user-facing concept — it MUST be used everywhere those apply. `fanout` MAY be used **only** for the generic technique, in the two names that carry it: the *drop-on-failed-fanout* cleanup pattern, and the Profile's private `#fanout()`, which calls `lmz.broadcast`. The recursive tier whose tree dispatch the word once named is gone. You MUST NOT "correct" either name to `broadcast`, and MUST NOT reintroduce `fanout` for the primitive. (The `fanout-scaling-benchmark` files + `bench:fanout` scripts predate this split and are a known straggler — not a counter-example.)

## A broadcast target's `bindingName` comes from a source the client cannot write
**For a client subscriber, the stored address MUST come from the host-stamped chain, and MUST NOT
come from a parameter or anything else the client sends.** A client's host node builds its call's
`callChain` from the socket's verified identity alone, so `addressOf(callChain[0])` is the client's own
address, binding included; the Profile's `subscribe` and the Resources plane both build it there.

⚠️ **The reason is that one unroutable row fails a write that has already landed.** `lmz.broadcast`
checks each target synchronously and has no per-target catch, so the first row naming a binding the
Worker does not declare throws out of the loop. Inside the fan-out that runs after a commit, that
fails the writer's call and skips every target after the row. Measured 2026-09-05: a throw in that
fan-out brought the commit back `infrastructure-error`. The `/live` scenario
`gateway-stamps-the-chain` drives the forged-row case, and `broadcast-120-subscribers` is the one
test anywhere that puts more than a hundred targets on one fan-out.

## Explicit-callback error delivery
When a handler delivers results via an explicit callback (e.g. `lmz.call('GATEWAY', clientId, ctn().handleResult(result), ctn().logFailure(), { onErrorOnly: true })`), the **entire handler body** MUST be wrapped in try/catch. Uncaught exceptions are silently lost — the client never gets a response and `callCompleted` never becomes true.

## Errors across mesh calls
Errors thrown across a mesh call (DO ↔ Client, DO ↔ DO) are pre/post-processed by `@lumenize/structured-clone`, which preserves `name`, `message`, `stack`, `cause`, and all custom own properties. Built-in `Error` subclasses round-trip with `instanceof` intact; **custom Error classes do NOT keep `instanceof` by default** — postprocess reconstructs with the `globalThis` global the error's `name` names, only when that global is an Error class, and a non-built-in subclass isn't on `globalThis` unless you register it there.

- **Structured signals MUST be detected by `err.name === 'MyTypedError'` + a property-presence check**, never `err instanceof MyTypedError`. Canonical: `packages/resources/src/errors.ts` (`OntologyStaleError` + `isOntologyStaleError`).
- To restore `instanceof`, the class MAY be registered on `globalThis`. Full mechanics in [website/docs/structured-clone/index.mdx](../../website/docs/structured-clone/index.mdx) § "Error Subclass Preservation" / "Custom Error Classes".
- **Designing typed errors**: when consolidating a throw-based path into typed errors, you MUST enumerate *every* case the inner code can throw, not just the one you're typing — a too-broad catch silently swallows unrelated failures (e.g. a permission refactor that swallowed a `"Node X not found"` malformed-request error as a permission failure). One typed Error per case, or string-match the message and mark the site with a TODO.

## `ClientGateway` is the server-side half of a Client
A client and its server-side half together are the equivalent of a mesh node. The half is `ClientGateway`, composed into the node that hosts the client, which is a node in its own right: in Nebula every scope's node composes it through `NebulaDO`, so the Star `acme.crm.tenant1` holds a tab's socket as `acme.crm.tenant1/alice.9f2c41aa`. The half carries two requirements on the client's behalf:

1. **It MUST honor every transport rule a node's framework honors.** It acks a node's call early, keeps that call's continuation, fills it with the client's answer using `fireResponse`'s code, and fires it back. It hands the client's own filled continuation down to whatever socket the client is on now.
2. **It MUST NOT act as a node of its own.** It never appears in a `callChain`, holds no `@mesh()` members, and decides nothing that belongs to the client: every check it makes is one that must not depend on the browser's honesty — who connects, whether the token is live, and whether the tab has passage into what is sent down.

`ClientGateway` (`packages/mesh/src/client-gateway.ts`) keeps no storage and is handed only its host's `ctx`, `env` and the hooks of `ClientGatewayHost`, so **`this.lmz.call(...)` is unavailable** to it. It builds each client call's mesh envelope itself and dispatches it in one of two ways (`#handleClientCall`): a call to the host, or to another Client on it, runs in place through the host's own request door, and any other goes by `resolveStub(...).__executeOperation(envelope)`.

For cleanup after a client leaves, **reactive** patterns (e.g. drop-on-failed-broadcast via the result handler above, run on the *broadcaster's* side) SHOULD be preferred over **proactive** ones (alarm-driven calls into the mesh). Much simpler given the constraint. Canonical example: the Resources plane's broadcast and its `results.onBroadcastResult` — cleanup runs where the push started, though "user closed the tab" is something only the client's host node observes.

## Nebula platform code never drops to raw primitives
`apps/nebula` business logic (Galaxy, Star, Universe, Resources) MUST stay on the Mesh surface, and MUST NOT use raw Workers RPC, raw `acceptWebSocket`, or `extends DurableObject`. When a raw-level capability is genuinely needed, it MUST be solved **architecturally, not inline** — and code crosses the mesh boundary only at one of [ADR-023](../../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)'s two bridges, a facade or `@rawRpc()`:
- **A hook MAY be added at the mesh layer**, with the Nebula class then using only that hook. Canonical: `NebulaDO` hosts its pages' Clients with no raw DO code of its own — it composes `ClientGateway` and implements its hooks, `onBeforeCallToClient` refusing a sender its holder has no passage into.
- **The raw-DO part MAY be factored into an infrastructure package.** Canonical: `nebula-auth` was forked from `auth` (both raw-DO infra — see [raw-comm.md](raw-comm.md)) rather than embedding raw auth DOs in the platform. **The same shape runs in the consuming direction:** when platform code needs to *call into* raw-DO infrastructure, the infrastructure package SHOULD expose a mesh-speaking facade — a `LumenizeWorker` entrypoint it owns, wired as a service binding — so the platform side never leaves `lmz.call` and the one raw hop lives inside the facade, next to the invariants the facade enforces (`callContext.originAuth` arrives verified there; identity is never hand-threaded). Canonical instance: `NebulaAuthFacade` (`@lumenize/mesh/auth/facade`, bound as the self-referencing `AUTH_FACADE` service binding) — the entry for what a session does with the Registry, whose claims-only verdicts and ADR-016 projection live beside its one raw Registry hop. ⚠️ **They no longer share code**: `nebula-auth` dropped `@lumenize/auth` from its manifest entirely on 2026-07-31, and the two are now free to diverge. What they share is *extracted* (`@lumenize/crypto`), never a dependency on the auth product — any future sharing MUST follow that shape.

- **Our own code MAY reach a mesh node through `@rawRpc()` for an operation no client may call.** This is ADR-023's second bridge, running the other way from a facade: raw-DO infrastructure, or a hook it hands the platform, reaches a mesh node.
  - The node decorates the method `@rawRpc()`, never `@mesh()`. The caller uses `rawRpcStub(binding, instanceName)` from `@lumenize/mesh/raw-rpc`, which only code holding the binding can call. The node's one `__rawRpc` entry verifies the pair, refuses any undecorated name, and stamps identity.
  - The shape that rides it is a **hook seam**: the infrastructure package declares what it needs done to objects it cannot name, as a required property (`ScopeLifecycleHooks` on `NebulaAuthFacade`), and the platform supplies it from one module, `apps/nebula/src/scope-lifecycle-hooks.ts`, which holds every `rawRpcStub` call the platform makes.
  - Canonical: `NebulaDO.teardown()`, which a deletion's hook calls and which `@mesh()` would open to any admin wanting to wipe a live app; and `Profile.readDisplayNames`/`setDisplayNames`, which the consent route calls.

If neither fits, that's a signal to extend Mesh itself — you MUST ask before dropping down. **Ergonomic friction counts too**: Nebula is Mesh's first (and only) consumer, so "this API is awkward to use from Nebula" is Mesh product feedback — you MUST flag it (backlog item or proposal), and MUST NOT silently absorb it with app-side contortions.

## Package dependency direction
`@lumenize/mesh` is the MIT foundation. Nebula packages extend mesh but **never the reverse** — mesh MUST NOT import nebula/nebula-auth/apps. When deciding where code belongs: generic DO/Worker mesh plumbing → `mesh`; product/ontology/resource logic → `nebula`; auth/identity → `auth`/`nebula-auth`. You MUST flag any import that points "up" the graph (mesh → nebula).

⚠️ **Carve-out — mesh owns the WIRE PROTOCOL; auth owns what the token MEANS.** The
"auth/identity → `auth`/`nebula-auth`" clause is about verification, gating and key handling, not
about the bytes on the socket. **Producing and parsing the `lmz.access-token.` WebSocket
subprotocol lives in `mesh`** (`src/gateway-messages.ts`, exported from `@lumenize/mesh/client` —
`WS_TOKEN_PREFIX`, `extractWebSocketToken`), because mesh's `MeshClient` is the **producer**:
splitting the two ends across packages made them a never-re-sync copy of a live protocol, whose
failure mode is a silent 401 on upgrade. Verification of the extracted token stays in
`auth`/`nebula-auth`. Without this note a future session helpfully moves it back.

- Nebula consumers MUST import from **`@lumenize/mesh/client`, not the root barrel** — `nebula-auth`'s
  `router.ts` is re-exported from a widely-imported index, so the barrel would drag
  `cloudflare:workers` through it (`packaging.md`'s bare-`SyntaxError`).
- ⚠️ **`packages/auth/src/hooks.ts` keeps a KNOWN second copy, deliberately.** `auth` MUST NOT
  depend on `mesh`, yet mesh routes its own e2e WebSocket upgrades through auth's hooks — so the
  property is "defined once **on the Nebula path**", never "defined once repo-wide". Both sites
  carry reciprocal comments; `mesh/test/browser/ws-roundtrip-browser.test.ts` covers that coupling
  in CI. The prefix is additionally a **published wire convention**
  (`website/docs/mesh/security.mdx` teaches third parties to hand-write it), so its value is pinned
  as a literal in `mesh/test/ws-token-subprotocol.test.ts` — changing it is a breaking protocol
  change, not a rename.

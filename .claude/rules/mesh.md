---
paths:
  - "packages/mesh/**/*.ts"
  - "packages/fetch/**/*.ts"
  - "packages/nebula-frontend/**/*.ts"
  - "apps/nebula/**/*.ts"
  - "packages/nebula-auth/src/worker-token.ts"
---

# Mesh Patterns

Applies to **mesh-based code** — `LumenizeDO` subclasses / `this.lmz` / `this.svc`: `packages/mesh`, `packages/fetch`, `apps/nebula`, `packages/nebula-frontend`. Communication MUST go through the Mesh abstraction and MUST NOT use raw DO primitives — the most common mistake is dropping to raw Workers RPC where a mesh call belongs. (Raw-DO infrastructure like `auth`/`testing` is a different layer → [raw-comm.md](raw-comm.md); to tell which layer you're in → [workers-projects.md](workers-projects.md). Local DO correctness → [durable-objects.md](durable-objects.md).)

## Prefer `lmz.call()` / `ctn()` over raw RPC — always
- Cross-node communication MUST go through `this.lmz.call(...)`; **raw Workers RPC** (`stub.method()`, `env.X.get(id).method()`) MUST NOT be used in application code without explicit human approval. Raw RPC **bypasses the Mesh security model** (callContext-based auth/identity propagation and the declared `@mesh()` call surface) and also holds a stub open (wall-clock billing). Framework code like the Gateway is the rare approved exception — see *`LumenizeClientGateway` is NOT a mesh participant* below.
- Continuations (`this.ctn()`) propagate **`callContext`** across every hop automatically — identity (`originAuth`), provenance (`callChain`), and `state` — which raw RPC drops entirely. Identity MUST NOT be threaded by hand; for what rides in `callContext` vs. travels as continuation parameters, see § *Passing data to the callee*.
- **You MUST flag any pseudo-code or implementation that uses `stub.method()` directly instead of `lmz.call(binding, instance, continuation)`.** The sanctioned exceptions are [ADR-023](../../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)'s two bridges, in § *Nebula platform code never drops to raw primitives*: a facade's one raw hop, and `rawRpcStub`.

## `call()` + a continuation is the ONLY cross-node call surface
There is **no awaited request/response form.** `callRaw` was removed (`mesh-continuation-only-calls`, 2026-07-03) — it now throws a loud deprecation error and is deleted next release. `this.lmz.call(binding, instance, remote, handler?)` never returns a value to the left of `=`; it fires-and-forgets or delivers the outcome to a **handler**. The single awaited hop survives ONLY as private framework transport (the early-acking `#dispatchEnvelope`), which ADR-003 blesses as "transport, not architecture." **App/platform/client code MUST NOT await a cross-node call — grep-able bright line — with ONE sanctioned exception: the client's `callAsync` (below).**
- **3-arg** (`lmz.call(binding, instance, remote)`) — fire-and-forget / genuine multi-hop (user code fires explicit onward `call()`s naming each next node). No local awareness of the outcome; a dispatch/admission failure is logged, not thrown async.
- **4-arg** (`lmz.call(binding, instance, remote, this.ctn().handler(remote))`) — the callee **acks early** (before running the chain), does the work (may be long / hibernate freely), then **fires the outcome back** into your `handler`: the value on success, the Error on a chain throw. The caller holds **ZERO state** — a DO/Worker's handler *travels* with the call (runs on a cold, storage-restored instance if the caller was evicted); a client's handler stays *in-heap* keyed by callId and **delivery re-resolves to whatever socket the client is on now.**
- **4-arg is RESILIENT by construction** — this inverts the old advice. It survives WS reconnect, tab sleep, and DO hibernation, so the old "thinking… forever" bug (an awaited result bound to a dead socket) is gone *by construction*. The old carve-out — "keep awaited `callRaw` for short reliable DO↔DO/Worker hops, fire-and-forget only for client-facing/long" — is **retired**: `call()`+continuation is the one path, and 4-arg is now the *safe* choice for exactly the client-crossing/long calls it used to be a workaround for. (The `[[client-calls-use-direct-delivery]]` memory's "callRaw fine for short hops" is stale — retire it.)
- **A 4-arg target MUST be cross-node-self-contained:** it produces its result with local sync/async only (no *further* cross-node call). A result that depends on a downstream node MUST use 3-arg multi-hop or a **subscription** (for live UI data, a subscription SHOULD be preferred outright — see the Nebula reactive-UI note).
- **`onErrorOnly` (5th arg) is the fanout tier**, not a single-call default: it skips the success fire-back callee-side, so a broadcast to N targets doesn't fire N discarded success handlers. Canonical: `lmz.broadcast`, which adds it whenever an `onResult` is given, for drop-a-dead-subscriber cleanup.
- **`client.lmz.callAsync(binding, instance, remote, opts?)` — the ONE sanctioned awaitable, client-only** (`mesh-client-callasync`, 2026-07-03). `callAsync<T>(): Promise<Awaited<T>>` is a resilient Promise wrapper over the same one-way-fire + re-resolvable fire-back as a 4-arg *client* `call`: the client keeps its handler **in-heap keyed by `callId`** rather than travelling it, and the Gateway re-resolves delivery to whatever socket the client is on now — so the Promise survives tab freeze + WS reconnect, and does NOT strand on a dead socket the way the removed `callRaw` did — it *realizes* ADR-003, doesn't violate it. Bounded by a built-in default `timeoutMs` (30s; `0`/`Infinity` disables) composed with an optional caller `AbortSignal` via `AbortSignal.any`. **The greppable rule: the only awaitable on `client.lmz` is `callAsync`; `lmz.call` stays `void`** — a `grep 'lmz\.call\b'` hit MUST NOT be `await`ed. **DOs/Workers MUST NOT get `callAsync`** — a held heap Promise dies on hibernation, so they use the traveling handler. ⚠️ Abort cancels the WAIT, not the server OP, so only idempotent ops MAY be retried (client-supplied UUID / ADR-005 eTag). A `subscribe` SHOULD be preferred for live UI data, as SHOULD higher-level SDK methods (`client.resources.*`) when they exist; `callAsync` is the one-shot read/mutation escape hatch. Callee side: a method reached by `callAsync` **returns its value** and the framework fires it back — it MUST NOT explicitly invoke a named handler by `requestId` (that pre-`callAsync` hand-roll is retired), the same as a 4-arg target. Canonical consumers: `apps/nebula/src/nebula-client.ts` `orgTree.*` / `#readResource` / `#meshSubmit`.

## DO vs Worker routing rule
`lmz.call(bindingName, instanceName, remoteContinuation, ...)` decides DO vs Worker entirely by **whether `instanceName` is `undefined`**. From `packages/mesh/src/lmz-api.ts` `callRawImpl`: `calleeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker'`.
- A **DO** binding MUST be given an instance name.
- A **Worker** (service) binding MUST be given `undefined`.

The call path validates the binding against its actual shape **synchronously, before dispatch** (`assertCallTarget` + `isDONamespace` from `@lumenize/routing`), so a mismatch **throws a clear error at the `lmz.call(...)` site — even for fire-and-forget calls** (previously such mistakes were silently dropped). Passing a label string for a Worker call (e.g. for tracing) throws *"binding '…' is a Worker/service binding but an instance name was supplied"*; a DO binding with no instance name throws *"requires an instance name"*. The instance-name slot is for DO routing only and MUST NOT be used as a data or label channel; to pass data to the callee, see § *Passing data to the callee* below.

## Node identity is stamped on every first-contact entry (not just mesh calls)
The framework populates a node's persistent identity — `this.lmz.bindingName` / `this.lmz.instanceName`, the basis for return addresses, tracing, and anything derived server-side from *which instance this is* — from routing metadata on **every** entry that can be first-contact, not only the mesh receive path. If a node serves its **own** HTTP/WebSocket `fetch()` surface, identity is stamped from the `x-lumenize-do-*` headers the Worker's forward sets — for a page, `forwardPage` in `apps/nebula/src/page-forward.ts`, which drops any the client sent first — at `fetch()`/accept time — because hibernation `webSocketMessage`/`webSocketClose` handlers can't re-derive routing metadata. So `instanceName` is populated on the non-mesh path too; relying on the mesh path alone leaves it `undefined` on a cold non-mesh entry (e.g. a container node injecting its server-derived scope into the shell it serves — an empty value mis-routes silently). The third source is the `@rawRpc()` entry, `__rawRpc`, which stamps the binding and instance name `rawRpcStub` passes once it has checked they name this object — so `Profile.setDisplayNames`, the first touch of a new person's Profile, finds its name stamped. First-write-wins keeps the paths consistent. (Rationale: ADR-007.)

## A client's `instanceName` MUST start with its `sub` — the Gateway enforces it
`LumenizeClientGateway.onBeforeAccept` (`packages/mesh/src/lumenize-client-gateway.ts`) validates the
name before accepting the socket, in two steps: it rejects a name with **no `.`** (403 *"invalid
instance name format (expected sub.tabId)"*), then requires `instanceName.substring(0, indexOf('.'))`
to equal the `sub` of the **verified JWT** (403 *"identity mismatch"*). `NebulaClientGateway` does
**not** override it, so this binds every Nebula client too.

⇒ **The subject's `sub` comes FIRST; everything after the first `.` is free.** Put a tab id, a scope,
or anything else in the leading segment and you get a 403 that reads as a *token* problem — the
message says "identity mismatch", so the natural next move is to go debug minting, which is the wrong
file. ⚠️ This works at all only because a surrogate `sub` is a **dotless** UUID; a `sub` containing a
dot would break the parse rather than the comparison. Canonical: `childInstanceName` in
`apps/nebula/src/impersonation.ts`, which appends `${tabId}.${scope}` after the subject's `sub`.

## Passing data to the callee
**Default: whatever the callee needs SHOULD be passed as arguments to the continuation method.** The callee declares them as ordinary parameters and they cross the wire — explicit, typed, and visible at the call site:
```typescript
this.lmz.call('DOCUMENT_DO', documentId,
  this.ctn<DocumentDO>().update(content, extraContext1, extraContext2));
// callee: update(content, extraContext1, extraContext2) { ... }   — params come across as-is
```
`callContext.state` is a **side channel** — like HTTP headers, for *cross-cutting, app-defined* context meant to ride along implicitly across hops. It's the one **mutable** part of callContext (a handler or `onBeforeCall` anywhere along the path can modify it); seed it via `CallOptions.state`, read it via `this.lmz.callContext.state`.

The canonical use: **cache a value computed once for downstream reuse** — e.g. resolve a permission/authorization decision in an early hop (or an earlier method on the same DO) and stash it in `state` so later hops/methods reuse it instead of recomputing. The *misuse* is reaching for `state` to pass a value a continuation parameter could carry — it MUST NOT be used that way; an explicit parameter is almost always better.

Two adjacent callContext fields are **immutable** and filled automatically, and MUST NOT be reimplemented in `state`:
- **Raw identity/claims** → `callContext.originAuth` (verified from the origin's JWT). Note the split: `originAuth` is the *input*, `state` holds the authorization decision you *derive* from it (above).
- **Tracing/provenance** → `callContext.callChain` (the immutable `[origin, …, caller]` path, extended every hop). It *is* the tracing mechanism — trace markers MUST NOT go in `state`. Reset with `CallOptions.newChain: true` when a node should become a fresh origin.

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
this.lmz.call('MY_DO', instanceName, this.ctn<MyDO>().onlyAdmins().resetTenant(tenantId));
```

A caller can't shortcut the gate: `ctn<MyDO>().resetTenant(...)` fails the member-level `@mesh` check (`resetTenant` isn't `@mesh` — it isn't even on `MyDO`). Reach for this when a **cluster** of privileged ops sits behind one check (gate once instead of `@mesh(requireDominionHere)` on each), or when the capability should carry scoped state (the returned instance can close over *what* the caller may touch). It's powerful but **underused** — the per-method `@mesh(guard)` shape is the default reflex (and what LLM training knows); use whichever is clearer, but know this exists. Rationale: ADR-007; entry-only mechanism lives in `packages/mesh/src/ocan/execute.ts`. ⚠️ **`svc.*` is NOT a built-in version of this** — it used to be exempt from the member-level check and is not any more, so a chain arriving off the wire that opens on `svc` is refused at its first op. A chain the NODE authored may still open there.

**A gate is a GETTER when it takes no arguments, a method when it does.** `@mesh(requireAdmin) get admin()` reads at the call site as the thing it hands back — `ctn<Galaxy>().admin.addUser(u)` — which is how the caller thinks of it, and it matches the SDK spelling a generated app already uses. The method form is not deprecated and nothing refuses it; what changed is which one an example should show. ⚠️ Scope this to GATES, not to arity: `Star.resetDevData()` takes no arguments and **destroys and rebuilds data**, so a getter there would turn an action into a mutation on property read.

**What a gate hands back is the whole of what the caller may then read and call, and the framework does not police it.** Past the entry op nothing is checked except the walk rules, so:

- **Hand back only methods** (including getters). A returned object is a surface, and every member on it is reachable.
- **Take care not to hand back `this`, `this.ctx`, `this.env` or `this.svc` by accident** — `@mesh() get self() { return this }` is a foot-gun, visible in your own source, and deliberately not refused: the carve-out that lets a node's own continuation root at `ctx` is the same mechanism.
- **A GETTER entry owes four things**: side-effect-free, synchronous, cheap, idempotent. Nothing at the call site says code runs, which is the whole reason the discipline is worth stating — a gate returns a surface and does nothing else.

**A gate the RESPONSE leg reaches MUST carry no `@mesh()` at all.** Its members are what the node's own continuations name as result handlers — reapers, a fire-back's answer — and both paths that reach them run with the member-level check off: the fire-back door, and the local dispatch when a Gateway answers inside its ack. Nothing is passed there, so the "holding it is the authorization" property above does not hold; what leaving off `@mesh()` buys is that a REQUEST naming the gate is refused as not mesh-callable. Canonical: each Nebula host's `get resourcesResults()`, returning the Resources plane's `results` surface (`apps/nebula/src/resources.ts`) — the reapers, the node invite's answer, and a Star's ontology pull. It sits beside the `@mesh()`-decorated `get resources()` and looks like an oversight; decorating it for symmetry would let any caller with passage call `onOntologyPulled`, which checks no permission and installs whatever validator bundle it is handed — and on a `.dev` Star, runs the install's wipe. (`onInviteResult` is the usual example and not the reason: a forged call runs under the forger's own claims, and `setPermission` re-checks `admin`.)

## Multi-hop / direct delivery
A continuation names its *final* destination, so a call can hop client → Star → Worker → **directly back to the client** without unwinding through the intermediate hops — each hop fires a one-way call to the next node instead of awaiting and backtracking. This is architecturally motivated (skip the backtrack), independent of any cost argument, and is the pattern to reach for. Canonical: a spell-check kicked off by a doc edit reports straight to the client, not back through the document DO. See [calls.mdx](../../website/docs/mesh/calls.mdx) § Direct Delivery.

## Two one-way calls for external I/O (cost angle — not a default)
The bare pattern is sound and alarm-free: a DO fires a one-way call to a Worker, the Worker does the external `fetch()`, then fires the result back (analytics example in calls.mdx). It keeps the DO out of wall-clock billing while the CPU-billed Worker waits. But it is **no longer a slam dunk for external I/O** — the extra hop, added latency, and per-call storage writes erode the savings, so the old "worth it above ~5 s" breakeven is soft and unverified. Reach for it only for genuinely long calls where you've confirmed the win; otherwise a 4-arg result handler is simpler (and, now that it's early-ack + resilient, fine even for long work). `@lumenize/fetch` adds a *delivery guarantee* on top via an alarm backstop, and **that add-on is experimental with a known flaw** (one alarm timer double-duties as both the fetch timeout and the executor-liveness backstop, so long fetches, past-budget deliveries, and concurrent in-flight requests are unproven). `@lumenize/fetch` MUST NOT be used in product/Nebula code without human sign-off.

## Alarms
Mesh code MUST schedule with `this.svc.alarms.schedule(delaySeconds, this.ctn().handler(...))` — the alarm carries an OCAN continuation, so the scheduled work runs as a mesh call with callContext intact. `ctx.storage.setAlarm` MUST NOT be hand-rolled in mesh code (that's the raw-DO path — see [raw-comm.md](raw-comm.md)).

## `lmz.call` 4-arg — the result-handler mechanics
(The 3-arg/4-arg/`onErrorOnly` basics are in the surface section above; this is *how* the outcome reaches your handler.)
- **The outcome rides a fire-back, not an awaited return.** The callee acks early, runs the chain, then fires the filled handler back one-way. Your handler receives the success value OR the Error in its `$result` slot — a remote `@mesh` throw arrives as that Error (structured errors like `ClientDisconnectedError` keep `name` + custom props). It runs at the caller's `__handleResponse` sink under the naturally-propagated response-leg `callContext`, re-gated by `onBeforeCall`/`requirePassage` (member-level-check-off, **scope-check-ON**). There is **no `callRaw` rethrow** — the Error is delivered *to* the handler.
- **The handler is NOT necessarily local.** DO/Worker: it *travels* in the envelope and runs on the callee's fire-back (on a cold, storage-restored caller if the caller was evicted). Client: it stays *in-heap* keyed by callId and delivery re-resolves to the current socket. Either way you never `await` it.
- **`onErrorOnly` + broadcast-to-clients:** the error path is only *delivery* failures — the Gateway (NOT a mesh node; it does not early-ack — the one deliberately-awaited hop) awaits the bounded client delivery and returns `ClientDisconnectedError`, routed to your handler locally as a *delivered* error rather than a sync throw. Never the client's own app error (delivery to the client is one-way). So `onErrorOnly` is for delivery reactions (drop a dead subscriber), not catching the callee's app errors.

Use the 4-arg form for reactive cleanup, retry, and observability — anything that reacts to "did it land?" without `await`ing. A result handler needs **no** `@mesh()`. It runs either at the caller's fire-back door, for a DO or Worker that acked and then answered, or locally on the caller's own dispatch, for a Gateway or any target that refused at admission — and neither checks for `@mesh()`. The handler MUST carry `@mesh()` **only** if it must ALSO be dispatched as an ordinary request — and ⚠️ weigh what that costs, because `@mesh()` makes it callable by any caller who can reach the node, with arguments of their choosing. The "not remotely callable" boundary is the **absence of `@mesh`**, never visibility. A `this.ctn()` handler MUST be **`public`** (TS only surfaces `public` members on `Continuation<this>`; the modifier is erased at runtime, so non-public buys nothing while forcing an untyped `(this.ctn() as any)` cast). Canonical local-only handlers: the members of a Resources plane's `results` surface, reached through each Nebula host's `resourcesResults` getter, which has no `@mesh()` (`apps/nebula/src/resources.ts`). (User docs: [continuations.mdx](../../website/docs/mesh/continuations.mdx).)

```typescript
// lmz.broadcast (broadcast.ts) — fire each push, react only to failures
lmz.call(t.bindingName, t.instanceName, remote, onResult, { onErrorOnly: true });

// The Resources plane's reaper, on its `results` surface — drop a subscriber whose Gateway reported
// it disconnected. The victim is the address the push went to, never a field of the reply. It is
// reached through the host's `resourcesResults` getter, which has no `@mesh()`: a Gateway answers
// inside its ack, so this runs locally, where the decorator is not checked.
onBroadcastResult: (resourceId: string, result?: unknown): void => {
  if (result instanceof Error && result.name === 'ClientDisconnectedError') {
    const clientId = this.#lmz().callContext.callee?.instanceName;
    if (clientId) this.removeSubscriber(resourceId, clientId);
  }
},
```
Application code rarely writes the raw 4-arg form — it gets the same drop-on-failed-broadcast cleanup for free via `lmz.broadcast(targets, remote, { onResult })`. Canonical: `lmz.broadcast` in `packages/mesh/src/broadcast.ts` + the plane's `results.onBroadcastResult` in `apps/nebula/src/resources.ts`.

## "`@mesh()`-decorated", never "marked" (naming)
`@mesh()` decorates a method or a getter; a field or an `accessor` fails to compile under it. Prose and comments MUST call such a member "`@mesh()`-decorated", or say it has no `@mesh()`, and MUST NOT call it "marked" or "unmarked" or refer to "the mark": other decorators exist, and the TC39 proposal says "decorated". `npm run audit:mesh-vocab` checks the tree, and `scripts/mesh-vocab-hook.sh` reports any line an edit adds.

## "broadcast" vs "fanout" (naming — don't flip-flop)
`broadcast` is the Lumenize primitive (`this.lmz.broadcast`), its API symbols (`onBroadcastResult`, `BroadcastTarget`), and the user-facing concept — it MUST be used everywhere those apply. `fanout` MAY be used **only** for the generic technique, in the two names that carry it: the *drop-on-failed-fanout* cleanup pattern, and the Profile's private `#fanout()`, which calls `lmz.broadcast`. The recursive tier whose tree dispatch the word once named is gone. You MUST NOT "correct" either name to `broadcast`, and MUST NOT reintroduce `fanout` for the primitive. (The `fanout-scaling-benchmark` files + `bench:fanout` scripts predate this split and are a known straggler — not a counter-example.)

## A broadcast target's `bindingName` comes from a source the client cannot write
**For a client subscriber, the stored binding MUST come from the Gateway-stamped chain, and MUST NOT
come from a parameter or anything else the client sends.** The Gateway builds a client call's
`callChain` from the socket's verified identity alone, so `callChain[0].bindingName` is its own
binding; the Profile's `subscribe` reads it there.

⚠️ **The reason is that one unroutable row fails a write that has already landed.** `lmz.broadcast`
checks each target synchronously and has no per-target catch, so the first row naming a binding the
Worker does not declare throws out of the loop. Inside the fan-out that runs after a commit, that
fails the writer's call and skips every target after the row. Measured 2026-09-05: a throw in that
fan-out brought the commit back `infrastructure-error`. The `/live` scenario
`gateway-stamps-the-chain` drives the forged-row case, and `broadcast-120-subscribers` is the one
test anywhere that puts more than a hundred targets on one fan-out.

## Fire-and-forget error delivery
When a handler delivers results via an explicit callback (e.g. `lmz.call('GATEWAY', clientId, ctn().handleResult(result))`), the **entire handler body** MUST be wrapped in try/catch. Uncaught exceptions are silently lost — the client never gets a response and `callCompleted` never becomes true.

## Errors across mesh calls
Errors thrown across a mesh call (DO ↔ Client, DO ↔ DO) are pre/post-processed by `@lumenize/structured-clone`, which preserves `name`, `message`, `stack`, `cause`, and all custom own properties. Built-in `Error` subclasses round-trip with `instanceof` intact; **custom Error classes do NOT keep `instanceof` by default** — postprocess reconstructs via `(globalThis as any)[name] || Error`, and a non-built-in subclass isn't on `globalThis` unless you register it there.

- **Structured signals MUST be detected by `err.name === 'MyTypedError'` + a property-presence check**, never `err instanceof MyTypedError`. Canonical: `apps/nebula/src/errors.ts` (`OntologyStaleError` + `isOntologyStaleError`).
- To restore `instanceof`, the class MAY be registered on `globalThis`. Full mechanics in [website/docs/structured-clone/index.mdx](../../website/docs/structured-clone/index.mdx) § "Error Subclass Preservation" / "Custom Error Classes".
- **Designing typed errors**: when consolidating a throw-based path into typed errors, you MUST enumerate *every* case the inner code can throw, not just the one you're typing — a too-broad catch silently swallows unrelated failures (e.g. a permission refactor that swallowed a `"Node X not found"` malformed-request error as a permission failure). One typed Error per case, or string-match the message and mark the site with a TODO.

## `LumenizeClientGateway` is NOT a mesh participant
It extends `DurableObject` directly (not `LumenizeDO`) to keep its "zero storage" design, so **`this.lmz.call(...)` is unavailable**. Subclasses (`NebulaClientGateway`, etc.) inherit this. Outbound calls from a Gateway MUST either build mesh envelopes manually and call `stub.__executeOperation(envelope)` (see `packages/mesh/src/lumenize-client-gateway.ts` `#handleClientCall`), or use direct Workers RPC (`env.X.get(env.X.idFromName(name)).method(args)`) — bypassing mesh.

For Gateway-originated cleanup, **reactive** patterns (e.g. drop-on-failed-broadcast via the 4-arg result handler above, run on the *callee's* side) SHOULD be preferred over **proactive** ones (alarm-driven calls into the mesh). Much simpler given the constraint. Canonical example: the Resources plane's broadcast and its `results.onBroadcastResult` — cleanup runs on the host that broadcast, a Star or a Galaxy, not the Gateway, even though "user closed the tab" is a Gateway-observed event.

## Nebula platform code never drops to raw primitives
`apps/nebula` business logic (Galaxy, Star, Universe, Resources) MUST stay on the Mesh surface, and MUST NOT use raw Workers RPC, raw `acceptWebSocket`, or `extends DurableObject`. When a raw-level capability is genuinely needed, it MUST be solved **architecturally, not inline** — and code crosses the mesh boundary only at one of [ADR-023](../../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)'s two bridges, a facade or `@rawRpc()`:
- **A hook MAY be added at the mesh layer**, with the Nebula subclass then using only that hook. Canonical: `NebulaClientGateway` adds no raw DO code — it overrides `LumenizeClientGateway` hooks (`onBeforeCallToMesh`, instance-name validation, …).
- **The raw-DO part MAY be factored into an infrastructure package.** Canonical: `nebula-auth` was forked from `auth` (both raw-DO infra — see [raw-comm.md](raw-comm.md)) rather than embedding raw auth DOs in the platform. **The same shape runs in the consuming direction:** when platform code needs to *call into* raw-DO infrastructure, the infrastructure package SHOULD expose a mesh-speaking facade — a `LumenizeWorker` entrypoint it owns, wired as a service binding — so the platform side never leaves `lmz.call` and the one raw hop lives inside the facade, next to the invariants the facade enforces (`callContext.originAuth` arrives verified there; identity is never hand-threaded). Canonical instance: `NebulaAuthFacade` (`@lumenize/nebula-auth/facade`, bound as the self-referencing `NEBULA_AUTH_FACADE` service binding) — the entry for what a session does with the Registry, whose claims-only verdicts and ADR-016 projection live beside its one raw Registry hop. ⚠️ **They no longer share code**: `nebula-auth` dropped `@lumenize/auth` from its manifest entirely on 2026-07-31, and the two are now free to diverge. What they share is *extracted* (`@lumenize/crypto`), never a dependency on the auth product — any future sharing MUST follow that shape.

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
`WS_TOKEN_PREFIX`, `extractWebSocketToken`), because mesh's `LumenizeClient` is the **producer**:
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

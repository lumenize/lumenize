---
paths:
  - "packages/mesh/**/*.ts"
  - "packages/fetch/**/*.ts"
  - "packages/nebula-frontend/**/*.ts"
  - "apps/nebula/**/*.ts"
---

# Mesh Patterns

Applies to **mesh-based code** — `LumenizeDO` subclasses / `this.lmz` / `this.svc`: `packages/mesh`, `packages/fetch`, `apps/nebula`, `packages/nebula-frontend`. Communicate through the Mesh abstraction, never raw DO primitives — the most common mistake is dropping to raw Workers RPC where a mesh call belongs. (Raw-DO infrastructure like `auth`/`testing` is a different layer → [raw-comm.md](raw-comm.md); to tell which layer you're in → [workers-projects.md](workers-projects.md). Local DO correctness → [durable-objects.md](durable-objects.md).)

## Prefer `lmz.call()` / `lmz.ctn()` over raw RPC — always
- Cross-node communication goes through `this.lmz.call(...)` — **never raw Workers RPC** (`stub.method()`, `env.X.get(id).method()`) in application code without explicit human approval. Raw RPC **bypasses the Mesh security model** (callContext-based auth/identity propagation and the declared `@mesh()` call surface) and also holds a stub open (wall-clock billing). Framework code like the Gateway is the rare approved exception — see *`LumenizeClientGateway` is NOT a mesh participant* below.
- Continuations (`this.lmz.ctn()`) propagate **`callContext`** across every hop automatically — identity (`originAuth`), provenance (`callChain`), and `state` — which raw RPC drops entirely. Don't thread identity by hand; for what rides in `callContext` vs. travels as continuation parameters, see *Passing data to the callee*.
- **Flag any pseudo-code or implementation that uses `stub.method()` directly instead of `lmz.call(binding, instance, continuation)`.**

## `call()` + a continuation is the ONLY cross-node call surface
There is **no awaited request/response form.** `callRaw` was removed (`mesh-continuation-only-calls`, 2026-07-03) — it now throws a loud deprecation error and is deleted next release. `this.lmz.call(binding, instance, remote, handler?)` never returns a value to the left of `=`; it fires-and-forgets or delivers the outcome to a **handler**. The single awaited hop survives ONLY as private framework transport (the early-acking `#dispatchEnvelope`), which ADR-003 blesses as "transport, not architecture." **App/platform/client code never awaits a cross-node call — grep-able bright line — with ONE sanctioned exception: the client's `callAsync` (below).**
- **3-arg** (`lmz.call(binding, instance, remote)`) — fire-and-forget / genuine multi-hop (user code fires explicit onward `call()`s naming each next node). No local awareness of the outcome; a dispatch/admission failure is logged, not thrown async.
- **4-arg** (`lmz.call(binding, instance, remote, this.ctn().handler(remote))`) — the callee **acks early** (before running the chain), does the work (may be long / hibernate freely), then **fires the outcome back** into your `handler`: the value on success, the Error on a chain throw. The caller holds **ZERO state** — a DO/Worker's handler *travels* with the call (runs on a cold, storage-restored instance if the caller was evicted); a client's handler stays *in-heap* keyed by callId and **delivery re-resolves to whatever socket the client is on now.**
- **4-arg is RESILIENT by construction** — this inverts the old advice. It survives WS reconnect, tab sleep, and DO hibernation, so the old "thinking… forever" bug (an awaited result bound to a dead socket) is gone *by construction*. The old carve-out — "keep awaited `callRaw` for short reliable DO↔DO/Worker hops, fire-and-forget only for client-facing/long" — is **retired**: `call()`+continuation is the one path, and 4-arg is now the *safe* choice for exactly the client-crossing/long calls it used to be a workaround for. (The `[[client-calls-use-direct-delivery]]` memory's "callRaw fine for short hops" is stale — retire it.)
- **A 4-arg target must be cross-node-self-contained (D12):** it produces its result with local sync/async only (no *further* cross-node call). A result that depends on a downstream node → 3-arg multi-hop or a **subscription** (for live UI data, prefer a subscription outright — see the Nebula reactive-UI note).
- **`onErrorOnly` (5th arg) is the fanout tier**, not a single-call default: it skips the success fire-back callee-side, so a broadcast to N targets doesn't fire N discarded success handlers. Canonical: `svc.broadcast` drop-a-dead-subscriber cleanup.
- **`client.lmz.callAsync(binding, instance, remote, opts?)` — the ONE sanctioned awaitable, client-only** (`mesh-client-callasync`, 2026-07-03). `callAsync<T>(): Promise<Awaited<T>>` is a resilient Promise wrapper over the same one-way-fire + re-resolvable fire-back as a 4-arg *client* `call` (D16/D17): the in-heap Promise survives tab freeze + WS reconnect (delivery re-resolves to the current socket), so it does NOT strand on a dead socket the way the removed `callRaw` did — it *realizes* ADR-003, doesn't violate it. Bounded by a built-in default `timeoutMs` (30s; `0`/`Infinity` disables) composed with an optional caller `AbortSignal` via `AbortSignal.any`. **The greppable rule: the only awaitable on `client.lmz` is `callAsync`; `lmz.call` stays `void`** — `grep 'lmz\.call\b'` must never be `await`ed. **DOs/Workers never get `callAsync`** — a held heap Promise dies on hibernation, so they use the traveling handler. ⚠️ Abort cancels the WAIT, not the server OP, so retry only idempotent ops (client-supplied UUID / ADR-005 eTag). Prefer a `subscribe` for live UI data and higher-level SDK methods (`client.resources.*`) when they exist; `callAsync` is the one-shot read/mutation escape hatch. Callee side: a method reached by `callAsync` **returns its value** (framework fire-back, D5 pattern (a)) — the same as a 4-arg target (D12). Canonical consumers: `apps/nebula/src/nebula-client.ts` `orgTree.*` / `#readResource` / `#meshSubmit`.

## DO vs Worker routing rule
`lmz.call(bindingName, instanceName, remoteContinuation, ...)` decides DO vs Worker entirely by **whether `instanceName` is `undefined`**. From `packages/mesh/src/lmz-api.ts` `callRawImpl`: `calleeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker'`.
- A **DO** binding always needs an instance name.
- A **Worker** (service) binding always needs `undefined`.

The call path validates the binding against its actual shape **synchronously, before dispatch** (`assertCallTarget` + `isDONamespace` from `@lumenize/routing`), so a mismatch **throws a clear error at the `lmz.call(...)` site — even for fire-and-forget calls** (previously such mistakes were silently dropped). Passing a label string for a Worker call (e.g. for tracing) throws *"binding '…' is a Worker/service binding but an instance name was supplied"*; a DO binding with no instance name throws *"requires an instance name"*. The instance-name slot is for DO routing only — never a data or label channel; to pass data to the callee, see *Passing data to the callee* below.

## Node identity is stamped on every first-contact entry (not just mesh calls)
The framework populates a node's persistent identity — `this.lmz.bindingName` / `this.lmz.instanceName`, the basis for return addresses, tracing, and anything derived server-side from *which instance this is* — from routing metadata on **every** entry that can be first-contact, not only the mesh receive path. If a node serves its **own** HTTP/WebSocket `fetch()` surface, identity is stamped from the `x-lumenize-do-*` headers `routeDORequest` sets, at `fetch()`/accept time — because hibernation `webSocketMessage`/`webSocketClose` handlers can't re-derive routing metadata. So `instanceName` is populated on the non-mesh path too; relying on the mesh path alone leaves it `undefined` on a cold non-mesh entry (e.g. a container node injecting its server-derived scope into the shell it serves — an empty value mis-routes silently). First-write-wins keeps the paths consistent. (Rationale: ADR-007.)

## Passing data to the callee
**Default: pass whatever the callee needs as arguments to the continuation method.** The callee declares them as ordinary parameters and they cross the wire — explicit, typed, and visible at the call site:
```typescript
this.lmz.call('DOCUMENT_DO', documentId,
  this.ctn<DocumentDO>().update(content, extraContext1, extraContext2));
// callee: update(content, extraContext1, extraContext2) { ... }   — params come across as-is
```
`callContext.state` is a **side channel** — like HTTP headers, for *cross-cutting, app-defined* context meant to ride along implicitly across hops. It's the one **mutable** part of callContext (a handler or `onBeforeCall` anywhere along the path can modify it); seed it via `CallOptions.state`, read it via `this.lmz.callContext.state`.

The canonical use: **cache a value computed once for downstream reuse** — e.g. resolve a permission/authorization decision in an early hop (or an earlier method on the same DO) and stash it in `state` so later hops/methods reuse it instead of recomputing. The *misuse* is reaching for `state` to pass a value a continuation parameter could carry — don't; an explicit parameter is almost always better.

Two adjacent callContext fields are **immutable** and filled automatically — don't reimplement them in `state`:
- **Raw identity/claims** → `callContext.originAuth` (verified from the origin's JWT). Note the split: `originAuth` is the *input*, `state` holds the authorization decision you *derive* from it (above).
- **Tracing/provenance** → `callContext.callChain` (the immutable `[origin, …, caller]` path, extended every hop). It *is* the tracing mechanism — don't put trace markers in `state`. Reset with `CallOptions.newChain: true` when a node should become a fresh origin.

## Object-capability access: gate once, then chain
The `@mesh()` allowlist is checked **only on a chain's entry op** (the first method invoked on the node); later calls in the same chain run on whatever that returned, un-re-checked. Beyond per-method `@mesh(guard)`, this enables an **object-capability** model: a gate method returns a **class instance whose methods *are* the capability** — they need no `@mesh` of their own and are reachable **only by first passing the gate**, in one round trip, so holding the returned instance *is* the authorization.

```typescript
// Callee — onlyAdmins() is the ONLY @mesh door; it returns a capability instance
@mesh(requireAdmin)
onlyAdmins(): AdminOps {
  return new AdminOps(this);                 // you only get an AdminOps by passing requireAdmin
}
// The capability surface — a plain class; NO @mesh on its methods
class AdminOps {
  #node: MyDO;
  constructor(node: MyDO) { this.#node = node; }
  resetTenant(id: string): void { /* privileged work via this.#node */ }
}

// Caller — one hop: the gate runs (requireAdmin), then resetTenant on what it returned
this.lmz.call('MY_DO', instanceName, this.ctn<MyDO>().onlyAdmins().resetTenant(tenantId));
```

A caller can't shortcut the gate: `ctn<MyDO>().resetTenant(...)` fails the entry `@mesh` check (`resetTenant` isn't `@mesh` — it isn't even on `MyDO`). Reach for this when a **cluster** of privileged ops sits behind one check (gate once instead of `@mesh(requireAdmin)` on each), or when the capability should carry scoped state (the returned instance can close over *what* the caller may touch). It's powerful but **underused** — the per-method `@mesh(guard)` shape is the default reflex (and what LLM training knows); use whichever is clearer, but know this exists. Rationale: ADR-007; entry-only mechanism lives in `packages/mesh/src/ocan/execute.ts`. (`svc.*` chains are the framework's built-in version — they skip the entry check entirely.)

## Multi-hop / direct delivery
A continuation names its *final* destination, so a call can hop client → Star → Worker → **directly back to the client** without unwinding through the intermediate hops — each hop fires a one-way call to the next node instead of awaiting and backtracking. This is architecturally motivated (skip the backtrack), independent of any cost argument, and is the pattern to reach for. Canonical: a spell-check kicked off by a doc edit reports straight to the client, not back through the document DO. See [calls.mdx](../../website/docs/mesh/calls.mdx) § Direct Delivery.

## Two one-way calls for external I/O (cost angle — not a default)
The bare pattern is sound and alarm-free: a DO fires a one-way call to a Worker, the Worker does the external `fetch()`, then fires the result back (analytics example in calls.mdx). It keeps the DO out of wall-clock billing while the CPU-billed Worker waits. But it is **no longer a slam dunk for external I/O** — the extra hop, added latency, and per-call storage writes erode the savings, so the old "worth it above ~5 s" breakeven is soft and unverified. Reach for it only for genuinely long calls where you've confirmed the win; otherwise a 4-arg result handler is simpler (and, now that it's early-ack + resilient, fine even for long work). `@lumenize/fetch` adds a *delivery guarantee* on top via an alarm backstop, and **that add-on is experimental with a known flaw** (one alarm timer double-duties as both the fetch timeout and the executor-liveness backstop, so long fetches, past-budget deliveries, and concurrent in-flight requests are unproven). Don't reach for `@lumenize/fetch` in product/Nebula code without human sign-off.

## Alarms
Schedule with `this.svc.alarms.schedule(delaySeconds, this.ctn().handler(...))` — the alarm carries an OCAN continuation, so the scheduled work runs as a mesh call with callContext intact. Don't hand-roll `ctx.storage.setAlarm` in mesh code (that's the raw-DO path — see [raw-comm.md](raw-comm.md)).

## `lmz.call` 4-arg — the result-handler mechanics
(The 3-arg/4-arg/`onErrorOnly` basics are in the surface section above; this is *how* the outcome reaches your handler.)
- **The outcome rides a fire-back, not an awaited return.** The callee acks early, runs the chain, then fires the filled handler back one-way. Your handler receives the success value OR the Error in its `$result` slot — a remote `@mesh` throw arrives as that Error (structured errors like `ClientDisconnectedError` keep `name` + custom props). It runs at the caller's `__handleResponse` sink under the naturally-propagated response-leg `callContext`, re-gated by `onBeforeCall`/`enforceScopeReach` (allowlist-off, **scope-check-ON**). There is **no `callRaw` rethrow** — the Error is delivered *to* the handler.
- **The handler is NOT necessarily local.** DO/Worker: it *travels* in the envelope and runs on the callee's fire-back (on a cold, storage-restored caller if the caller was evicted). Client: it stays *in-heap* keyed by callId and delivery re-resolves to the current socket. Either way you never `await` it.
- **`onErrorOnly` + broadcast-to-clients:** the error path is only *delivery* failures — the Gateway (NOT a mesh node; it does not early-ack — the one deliberately-awaited hop) awaits the bounded client delivery and returns `ClientDisconnectedError`, routed to your handler locally (D6 tier-2). Never the client's own app error (delivery to the client is one-way). So `onErrorOnly` is for delivery reactions (drop a dead subscriber), not catching the callee's app errors.

Use the 4-arg form for reactive cleanup, retry, and observability — anything that reacts to "did it land?" without `await`ing. The handler needs `@mesh()` **only** if it can also be dispatched *remotely* (e.g. `svc.broadcast`'s tree path forwards it from a tier Worker — why `onBroadcastResult` below carries `@mesh()`); the "not remotely callable" boundary is the **absence of `@mesh`**, never visibility. A `this.ctn()` handler must be **`public`** (TS only surfaces `public` members on `Continuation<this>`; the modifier is erased at runtime, so non-public buys nothing while forcing an untyped `(this.ctn() as any)` cast). Canonical local-only public handlers: `Star.doTransaction`/`doRead`/`doSubscribe`/`applyFetchedState`. (User docs: [continuations.mdx](../../website/docs/mesh/continuations.mdx).)

```typescript
// svc.broadcast's direct path (broadcast.ts) — fire each push, react only to failures
doInstance.lmz.call(t.bindingName, t.instanceName, remote, opts.onResult,
  { onErrorOnly: true });

// Star's handler — drop a subscriber whose Gateway reported it disconnected
@mesh()
onBroadcastResult(resourceId: string, result?: unknown): void {
  if (result instanceof Error && result.name === 'ClientDisconnectedError') {
    const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
    if (clientId) this.#subscriptions.removeSubscriber(resourceId, clientId);
  }
}
```
Application code rarely writes the raw 4-arg form — it gets the same drop-on-failed-broadcast cleanup for free via `svc.broadcast(targets, remote, { onResult })`. Canonical: `svc.broadcast` in `packages/mesh/src/broadcast.ts` + `Star.onBroadcastResult` in `apps/nebula/src/star.ts`.

## "broadcast" vs "fanout" (naming — don't flip-flop)
`broadcast` is the Lumenize primitive (`this.svc.broadcast`), its API symbols (`onBroadcastResult`, `STAR_BROADCAST_*`), and the user-facing concept — use it everywhere those apply. `fanout` is allowed **only** as the generic CS technique: the recursive tree-dispatch *mechanism* inside `svc.broadcast`'s tier Worker (hence `broadcast.ts` doc-comments say "tree-fanout", "per-tier fanout factor"). When renaming toward broadcast, don't "correct" the technique-level `fanout` back, and never reintroduce `fanout` for the primitive. (The `fanout-scaling-benchmark` files + `bench:fanout` scripts predate this split and are a known straggler — not a counter-example.)

## Fire-and-forget error delivery
When a handler delivers results via an explicit callback (e.g. `lmz.call('GATEWAY', clientId, ctn().handleResult(result))`), wrap the **entire handler body** in try/catch. Uncaught exceptions are silently lost — the client never gets a response and `callCompleted` never becomes true.

## Errors across mesh calls
Errors thrown across a mesh call (DO ↔ Client, DO ↔ DO) are pre/post-processed by `@lumenize/structured-clone`, which preserves `name`, `message`, `stack`, `cause`, and all custom own properties. Built-in `Error` subclasses round-trip with `instanceof` intact; **custom Error classes do NOT keep `instanceof` by default** — postprocess reconstructs via `(globalThis as any)[name] || Error`, and a non-built-in subclass isn't on `globalThis` unless you register it there.

- **Detect structured signals by `err.name === 'MyTypedError'` + a property-presence check**, not `err instanceof MyTypedError`. Canonical: `apps/nebula/src/errors.ts` (`OntologyStaleError` + `isOntologyStaleError`).
- To restore `instanceof`, register the class on `globalThis`. Full mechanics in [website/docs/structured-clone/index.mdx](../../website/docs/structured-clone/index.mdx) § "Error Subclass Preservation" / "Custom Error Classes".
- **Designing typed errors**: when consolidating a throw-based path into typed errors, enumerate *every* case the inner code can throw, not just the one you're typing — a too-broad catch silently swallows unrelated failures (e.g. a permission refactor that swallowed a `"Node X not found"` malformed-request error as a permission failure). One typed Error per case, or string-match the message and mark the site with a TODO.

## `LumenizeClientGateway` is NOT a mesh participant
It extends `DurableObject` directly (not `LumenizeDO`) to keep its "zero storage" design, so **`this.lmz.call(...)` is unavailable**. Subclasses (`NebulaClientGateway`, etc.) inherit this. Outbound calls from a Gateway must either build mesh envelopes manually and call `stub.__executeOperation(envelope)` (see `packages/mesh/src/lumenize-client-gateway.ts` `#handleClientCall`), or use direct Workers RPC (`env.X.get(env.X.idFromName(name)).method(args)`) — bypassing mesh.

For Gateway-originated cleanup, prefer **reactive** patterns (e.g. drop-on-failed-broadcast via the 4-arg result handler above, run on the *callee's* side) over **proactive** ones (alarm-driven calls into the mesh). Much simpler given the constraint. Canonical example: `Star.#broadcast` / `Star.onBroadcastResult` — cleanup runs on Star, not the Gateway, even though "user closed the tab" is a Gateway-observed event.

## Nebula platform code never drops to raw primitives
`apps/nebula` business logic (Galaxy, Star, Universe, Resources) stays on the Mesh surface — never raw Workers RPC, raw `acceptWebSocket`, or `extends DurableObject`. When a raw-level capability is genuinely needed, solve it **architecturally, not inline**:
- **Add a hook at the mesh layer** and have the Nebula subclass use only the hook. Canonical: `NebulaClientGateway` adds no raw DO code — it overrides `LumenizeClientGateway` hooks (`onBeforeCallToMesh`, instance-name validation, …).
- **Factor the raw-DO part into an infrastructure package.** Canonical: `nebula-auth` was forked from `auth` (both raw-DO infra, sharing code — see [raw-comm.md](raw-comm.md)) rather than embedding raw auth DOs in the platform.

If neither fits, that's a signal to extend Mesh itself — ask before dropping down. **Ergonomic friction counts too**: Nebula is Mesh's first (and only) consumer, so "this API is awkward to use from Nebula" is Mesh product feedback — flag it (backlog item or proposal), don't silently absorb it with app-side contortions.

## Package dependency direction
`@lumenize/mesh` is the MIT foundation. Nebula packages extend mesh but **never the reverse** — mesh must not import nebula/nebula-auth/apps. When deciding where code belongs: generic DO/Worker mesh plumbing → `mesh`; product/ontology/resource logic → `nebula`; auth/identity → `auth`/`nebula-auth`. Flag any import that points "up" the graph (mesh → nebula).

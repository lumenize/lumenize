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

## DO vs Worker routing rule
`lmz.call(bindingName, instanceName, remoteContinuation, ...)` decides DO vs Worker entirely by **whether `instanceName` is `undefined`**. From `packages/mesh/src/lmz-api.ts` `callRawImpl`: `calleeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker'`.
- A **DO** binding always needs an instance name.
- A **Worker** (service) binding always needs `undefined`.

The call path validates the binding against its actual shape **synchronously, before dispatch** (`assertCallTarget` + `isDONamespace` from `@lumenize/routing`), so a mismatch **throws a clear error at the `lmz.call(...)` site — even for fire-and-forget calls** (previously such mistakes were silently dropped). Passing a label string for a Worker call (e.g. for tracing) throws *"binding '…' is a Worker/service binding but an instance name was supplied"*; a DO binding with no instance name throws *"requires an instance name"*. The instance-name slot is for DO routing only — never a data or label channel; to pass data to the callee, see *Passing data to the callee* below.

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

## Multi-hop / direct delivery
A continuation names its *final* destination, so a call can hop client → Star → Worker → **directly back to the client** without unwinding through the intermediate hops — each hop fires a one-way call to the next node instead of awaiting and backtracking. This is architecturally motivated (skip the backtrack), independent of any cost argument, and is the pattern to reach for. Canonical: a spell-check kicked off by a doc edit reports straight to the client, not back through the document DO. See [calls.mdx](../../website/docs/mesh/calls.mdx) § Direct Delivery.

## Two one-way calls for external I/O (cost angle — not a default)
The bare pattern is sound and alarm-free: a DO fires a one-way call to a Worker, the Worker does the external `fetch()`, then fires the result back (analytics example in calls.mdx). It keeps the DO out of wall-clock billing while the CPU-billed Worker waits. But it is **no longer a slam dunk for external I/O** — the extra hop, added latency, and per-call storage writes erode the savings, so the old "worth it above ~5 s" breakeven is soft and unverified. Reach for it only for genuinely long calls where you've confirmed the win; otherwise a 4-arg result handler (or a plain `await`) is simpler. `@lumenize/fetch` adds a *delivery guarantee* on top via an alarm backstop, and **that add-on is experimental with a known flaw** (one alarm timer double-duties as both the fetch timeout and the executor-liveness backstop, so long fetches, past-budget deliveries, and concurrent in-flight requests are unproven). Don't reach for `@lumenize/fetch` in product/Nebula code without human sign-off.

## Alarms
Schedule with `this.svc.alarms.schedule(delaySeconds, this.ctn().handler(...))` — the alarm carries an OCAN continuation, so the scheduled work runs as a mesh call with callContext intact. Don't hand-roll `ctx.storage.setAlarm` in mesh code (that's the raw-DO path — see [raw-comm.md](raw-comm.md)).

## `lmz.call` with a result handler (4-arg form)
Two forms:
- **3-arg** (`lmz.call(binding, instance, remote)`) — true fire-and-forget; the caller has no local awareness of success.
- **4-arg** (`lmz.call(binding, instance, remote, this.ctn().onDelivered(remote))`) — pairs the call with a **local** result handler. When the remote call settles, the framework invokes `onDelivered(result)` on this DO with the success value, or with the Error object on failure (including structured errors like `ClientDisconnectedError`). Add `{ onErrorOnly: true }` as a 5th arg to skip the success-path dispatch when you only care about failures.

Use the 4-arg form for reactive cleanup, retry, and observability — anything that reacts to "did the call land?" without `await`ing. The handler runs locally; it needs `@mesh()` **only** if the same handler can also be dispatched *remotely* (e.g. `svc.broadcast`'s tree path forwards it from a tier Worker — which is why `onBroadcastResult` below carries `@mesh()`).

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

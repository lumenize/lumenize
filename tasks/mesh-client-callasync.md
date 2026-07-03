# Mesh — client `callAsync` (resilient Promise-returning client call + abort)

**Status**: **📋 DRAFT — not started; the next thing after [`mesh-continuation-only-calls.md`](mesh-continuation-only-calls.md)** (it completes that task's client-side model). Ready for `/review-task`. Working name `callAsync` is provisional — see D1.

**Packages**: `packages/mesh/` (`LumenizeClient`), then `apps/nebula/` (collapse the hand-rolled bridges onto it).
**Related**: [`mesh-continuation-only-calls.md`](mesh-continuation-only-calls.md) (built the client 4-arg in-heap leg, D16/D17, that this promotes to a primitive), [`on-hold/mesh-call-durable.md`](on-hold/mesh-call-durable.md) (the *guaranteed* tier; `callAsync` is the best-effort rung below it and its foundation — D9 client-side).

---

## Why now (the trigger)

The continuation-only migration deliberately kept the **client** model minimal — a bare in-heap handler keyed by `callId` (D16) — and suppressed any richer client abstraction until a real use case appeared. This mirrors why `callDurable` was moved to its own on-hold file: **wait for the use case, don't speculatively build the client's divergent model.**

`callDurable`'s use case never materialized. **`callAsync`'s did**, during Phase 2:
- `client.orgTree.*` mutators need a `Promise<T>` with **reject-on-failure** (doc-blessed via a `for-docs` test + `.rejects.toThrow()`-tested). To keep that contract on the continuation-only model, Phase 2 hand-rolled `#orgTreeMutate` + `#pendingMutations` + `handleOrgTreeResult` in `apps/nebula/src/nebula-client.ts`.
- That is the **second** copy of the same shape: `#readResource`/`handleReadResponse` (and the transaction path `handleTransactionResult`) already hand-roll a `requestId`-keyed Promise-settled-by-a-pushed-handler.

**Two copies is the signal.** Left un-factored, every new client SDK read/mutate re-hand-rolls a `requestId` map + a settler handler. Per CLAUDE.md ("Nebula fighting a package API — missing capability *or* awkward ergonomics — is product feedback for the package; surface it, don't quietly work around it"), the bridge belongs in Mesh.

Plus it closes a real gap the bridge left open (below).

---

## The gap this also closes (the hang)

The Phase-2 client bridge is resilient to the common failures that killed awaited `callRaw` — the in-heap settlers survive a tab **freeze** and a **WS reconnect**, and delivery **re-resolves to the current socket by `instanceName`** (D17). But two residual cases leave the Promise **hanging until reload**:
- a **freeze longer than the Gateway's zero-socket grace window** → the RESULT is dropped, nothing settles the Promise;
- any case where the RESULT is genuinely lost (callee acked-then-vanished, D6 row 4).

Both are heap-bounded (no server leak) and eventually recovered by **D8 reconcile on reload** — but the *live* UI just spins. The deferred mitigation was "an optional UI soft-timeout." **`AbortSignal` is that mitigation, done as a web standard** (see D3).

---

## Objective

Promote the ad-hoc client 4-arg→Promise bridge to a first-class **`LumenizeClient.callAsync<T>(...)` : Promise<T>** primitive:
- settled by the D16/D17 mechanism (in-heap, re-resolvable delivery) — resilient by construction;
- **`AbortSignal`-cancellable** so the wait can be bounded/cancelled deterministically instead of hanging to reload;
- **client-only** — the D16 asymmetry: a DO/Worker can't hold a heap Promise across hibernation, so it never offers "await a result" (it uses the traveling handler). `callAsync` exists ONLY on `LumenizeClient`.

Then collapse the Nebula hand-rolled bridges onto it.

---

## Design

### The primitive
```ts
// LumenizeClient
callAsync<T = any>(
  calleeBindingName: string,
  calleeInstanceNameOrId: string | undefined,
  remoteContinuation: Continuation<T>,
  options?: CallOptions & { signal?: AbortSignal },
): Promise<T>;
```
- Generates a `callId`, stores `{ resolve, reject, signal, onAbort }` in a **new `#pendingAsyncCalls` map keyed by `callId`** (parallel to `#inHeapHandlers`; `callAsync` settles a Promise, it has no handler *chain*).
- Sends the CALL with `expectsResult: true` (reusing the D17 RESULT path).
- **`#handleCallResponse(message)` settles by `callId`**: success → `resolve(postprocess(result))`; `{$error}` → `reject(Error)`. (It already handles `#inHeapHandlers`; extend it to also check `#pendingAsyncCalls`.) The delete-on-delivery IS the dedup (a duplicate RESULT finds no entry — same as today).
- **No separate `requestId`, no user handler method** — this is why the Mesh version is cleaner than the Nebula hand-roll (which is built on the *public* 4-arg API, so it needs its own correlation id + a public `@mesh`-free handler).

Resilience is inherited, not re-implemented: in-heap survives freeze + reconnect; the Gateway re-resolves the RESULT to the current socket by `instanceName` (D17); reconnect mid-flight still settles.

### Abort (D3)
- `options.signal?: AbortSignal`. On abort **before** the RESULT: reject with `signal.reason` (a `DOMException`/`AbortError`), delete the `#pendingAsyncCalls` entry, remove the abort listener. A RESULT arriving after abort finds no entry → dropped (existing no-handler path).
- If `signal.aborted` is already true at the call site: reject immediately, don't dispatch (matches `fetch`).
- On normal settle: remove the abort listener too (no leak).
- **Abort cancels the WAIT, not the server OPERATION** — the call already left one-way, so the callee may still run. Retry-after-abort is safe ONLY for idempotent ops (client-supplied UUID / ADR-005 eTag), which the model already assumes for D8. Document loudly at the API.
- Compose with `AbortSignal.timeout(ms)` (deterministic timeout) and `AbortSignal.any([...])` (timeout + unmount + user-cancel).

---

## Decisions (to resolve in `/review-task`)

| # | Decision | Lean | Status |
|---|---|---|---|
| D1 | **Name.** `callAsync` vs `callForResult` vs reviving `callDurableAsync` (a prior name). | `callAsync` — short, honest (it's the client's awaitable call), doesn't overclaim durability. Reserve `callDurable*` for the guaranteed tier. Flag any new vocab ([[naming-judgment]]). | OPEN |
| D2 | **Public or protected.** A public `client.lmz.callAsync(...)` lets any client-SDK author build on it (Mesh is MIT, multi-consumer); protected hides it behind Nebula's `client.resources.*`/`orgTree.*`. | **Public on `LumenizeClient`**, documented as "the client's resilient awaitable call — prefer higher-level SDK methods when they exist." It's the SDK-author's tool; user-developers still normally use `client.resources.*`. Does NOT violate the bright line (that governs raw `lmz.call` + platform/DO code, not the client SDK surface). | OPEN |
| D3 | **Abort** = fetch-style `AbortSignal`; abort rejects the wait (not the op). | As designed above. | PINNED (this task's reason to exist) |
| D4 | **Default timeout.** Hidden default on the primitive, or explicit-signal-only? | **No hidden default on the primitive** (fetch semantics — a legit long op shouldn't be silently killed). The **SDK convenience wrappers** (`orgTree.*`, reads) attach a default `AbortSignal.timeout(N)` so the common path can't hang. Pin `N` (30s? matches the retired `CALL_RAW_QUEUE_TIMEOUT_MS`/`CLIENT_CALL_TIMEOUT_MS` precedent). | OPEN (N) |
| D5 | **Migration scope: read/transaction now, or follow-up?** `#orgTreeMutate` maps trivially (already the 4-arg framework fire-back). `#readResource`/`handleReadResponse` + the transaction path use **Pattern R** — the Star EXPLICITLY fires `handleReadResponse`/`handleTransactionResult(requestId, result)` — NOT the framework fire-back. Unifying them onto `callAsync` needs either (a) `Star.read`/`transaction` **return** the value + drop the explicit `deliverReadResponse`/`deliverTransactionResult` data-plane seam, or (b) `callAsync` also supports a server-fires-to-named-handler shape. AND their special logic (ontology-stale → `onShouldRefreshUI`; `mapTransactionResult`) must move to `.then()/.catch()` on the returned Promise or a thin wrapper. | **v1 = `#orgTreeMutate` only** (establish the primitive + kill the newest duplicate). read/transaction unification is a **follow-up** if the data-plane seam change proves invasive — don't force it into v1. | OPEN |
| D6 | **Relationship to `callDurable`.** | `callAsync` = best-effort client tier (heap-durable + re-resolvable + abort-to-unblock). Client-side `callDurable` (on-hold D9) = persist `#pendingAsyncCalls` to IndexedDB + reconcile-on-reload, built **on top of** `callAsync` (swap the heap map for a persisted one; no browser alarm needed — reconcile, not wait). **Keep the seam open**; don't foreclose it. | PINNED |

---

## Non-goals
- **DO/Worker `callAsync`** — a DO's heap dies on hibernation, so it never awaits a result (it uses the traveling handler, D3 of the parent task). `callAsync` is `LumenizeClient`-only, by construction.
- **Guaranteed delivery** — that's `callDurable` ([on-hold](on-hold/mesh-call-durable.md)). `callAsync` is best-effort (reload → D8 reconcile).
- **Cancelling server-side work** — abort is wait-only (D3).

---

## Phases

### Phase 1 — Build `callAsync` + abort in Mesh
- `LumenizeClient.callAsync` + `#pendingAsyncCalls`; extend `#handleCallResponse` to settle it by `callId`.
- `AbortSignal` support per D3 (pre-aborted, abort-before-result, cleanup-on-settle, drop-late-result).
- **Tests (capable-of-failing each):** settles on success RESULT; rejects on error RESULT (`$error` → Error); **abort rejects + entry removed + a subsequent RESULT is dropped (no double-settle)**; pre-aborted signal rejects without dispatch; **survives a WS reconnect** (result re-resolves to the new socket → settles) — reuse the parent task's Flow-C harness; duplicate RESULT dropped (dedup). Remove the now-doubly-dead client queue machinery notes if any remain.

### Phase 2 — Collapse the Nebula duplicate
- `#orgTreeMutate` → `callAsync`; delete `#pendingMutations` + `handleOrgTreeResult`. The `orgTree.*` wrappers attach a default `AbortSignal.timeout(N)` (D4) so the hang case now rejects deterministically.
- Confirm `nebula-orgtree` baseline test stays green (incl. `.rejects.toThrow()`), and that a timed-out mutation rejects rather than hangs (new test).
- (D5) read/transaction unification: do it here if the seam change is clean, else spin a follow-up note.

### Phase 3 — Docs
- Fold into the parent task's Phase 3 (`website/docs/mesh/{calls,continuations}.mdx` + `.claude/rules/mesh.md`): document `callAsync` as the client's resilient awaitable call, the abort-cancels-the-wait semantic, and "prefer subscriptions for live UI data; `callAsync` for one-shot reads/mutations that need an ack/error."

### Success Criteria
- [ ] `LumenizeClient.callAsync` in Mesh, `AbortSignal`-cancellable, tested (settle/reject/abort/reconnect/dedup, each capable-of-failing).
- [ ] `#orgTreeMutate` collapsed onto it; `#pendingMutations`/`handleOrgTreeResult` deleted; a mutation whose result is lost now **rejects on timeout** (no hang), verified.
- [ ] mesh + nebula-baseline suites green; type-check clean.
- [ ] `callDurable`-for-clients seam left open (D6); the on-hold file cross-references `callAsync` as its foundation.

---

## Notes
- This is the client-side completion of the continuation-only model — `mesh-continuation-only-calls.md` is not truly "done" until this lands (its Phase-2 banner points here).
- The abort primitive also gives the UI a clean "cancel this in-flight action" affordance for free (not just timeouts) — e.g., navigating away from a slow mutation.
- Keep the parent task's bright line intact: raw `lmz.call` on the client stays fire-and-forget/4-arg-handler; `callAsync` is the **SDK-layer** awaitable built on top, not a reintroduction of socket-bound awaited `callRaw`.

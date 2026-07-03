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
  options?: CallOptions & { timeoutMs?: number; signal?: AbortSignal },  // timeoutMs default 30_000; 0/Infinity disables
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
- **Built-in default timeout (D4):** `timeoutMs` (default `30_000`; `0`/`Infinity` disables) composes with any caller `signal` via `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` — so the common path can't hang, and `signal` stays free for external cancel (unmount, user-cancel). Because the primitive is public (D2), the default is what makes the escape hatch safe-by-default.

---

## Decisions (to resolve in `/review-task`)

| # | Decision | Lean | Status |
|---|---|---|---|
| D1 | **Name** → **`callAsync`**. | **PINNED 2026-07-03 (Larry).** Rejected `callForResult` (under-distinguishes from 4-arg `call`, which *also* delivers a result) and `callDurableAsync` (overloads "Durable" for a best-effort thing; reserve `callDurable*` for the guaranteed tier). The lingering pull toward a euphemistic name was **backtracking-anxiety** — fear it reads as "awaited `callRaw` is back" — a cognitive bias to resist: `callAsync` is NOT callRaw (socket-bound request/response that dies on reconnect); it's a heap-Promise over one-way-fire + re-resolvable fire-back (D16/D17). `-Async` = the Promise-returning variant is the widely-understood read. **Deciding factor: the name forces the ADR-003 amendment to spell out WHY the browser/client environment makes an awaitable the *right* choice there (Phase 3) — a feature, not a cost.** | **PINNED** |
| D2 | **Public or protected.** | **PINNED 2026-07-03 (Larry): PUBLIC on `client.lmz`** (the `LmzApiClient` surface, alongside `call`). Parity with the already-public `client.lmz.call` (App.vue uses it for wipe/teardown); MIT reuse (other client SDKs build on it); a legit app/UI escape hatch. Doc it "prefer higher-level SDK methods (`client.resources.*`) when they exist." Does NOT breach the bright line (client SDK surface, not raw `lmz.call`/platform/DO). | **PINNED** |
| D3 | **Abort** = fetch-style `AbortSignal`; abort rejects the wait (not the op). | As designed above. | PINNED (this task's reason to exist) |
| D4 | **Default timeout** (gated on D2=public — a public escape hatch with no default re-arms the exact hang `callAsync` exists to kill). | **PINNED 2026-07-03 (Larry): built-in default `timeoutMs: 30_000`, overridable; `0`/`Infinity` disables (rare long awaits); a caller `signal` is ADDITIVE (composed, not replacing) → internally `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`.** 30s matches the retired `CALL_RAW_QUEUE_TIMEOUT_MS`/`CLIENT_CALL_TIMEOUT_MS`. This **flips** the draft's "no hidden default" — that only held for a protected primitive; a public one must be safe-by-default. SDK wrappers (`orgTree.*`, reads) then inherit the default for free (no per-wrapper timeout). | **PINNED** |
| D5 | **Migration scope: read/transaction now, or follow-up?** `#orgTreeMutate` maps trivially (already the 4-arg framework fire-back / Pattern C). `#readResource`/`handleReadResponse` + the transaction path use **Pattern R** — the Star EXPLICITLY fires `handleReadResponse`/`handleTransactionResult(requestId, result)` — NOT the framework fire-back. AND their special logic (ontology-stale → `onShouldRefreshUI`; `mapTransactionResult`; the transaction submit-gate `#inFlightSubmit`/`#pumpSubmitGate`) must move onto `.then()/.catch()` of the returned Promise or a thin wrapper. | **PINNED 2026-07-03 (Larry): v1 = ALL THREE** (orgTree + read + transaction) — do it while the model is loaded; a deferred "unify later" is a standing tax on human concentration (the reviewer-attention-is-the-bottleneck principle) worse than the one-time risk. **⚠ Guardrail (non-negotiable):** read/transaction are the working, green, critical resource path — migrate under `/refactor-efficiently` `.only` discipline (one representative test green on `callAsync` first), keep their existing tests as the safety net, and **mutation-check that the special-case logic survives** (ontology-stale→`onShouldRefreshUI`, `mapTransactionResult`, submit-gate). **Sub-decision for `/review-task` (read the code + check callers first):** (a) unify onto Pattern C — `Star.read`/`transaction` *return* the value, framework fires it back via D17, drop the `deliverReadResponse`/`deliverTransactionResult` seam — vs (b) `callAsync` also supports Pattern R (server-fires-named-handler-by-requestId). **Lean (a):** D17 is the mechanism THIS task built; Pattern R is the pre-D17 hand-roll, so (a) *retires* it rather than preserving it. Confirm no non-client caller relies on the explicit fire-back. | **PINNED (a-vs-b open for review)** |
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

### Phase 2 — Collapse ALL the Nebula duplicates (orgTree + read + transaction) — D5=option 2
Migrate all three onto `callAsync` **under `/refactor-efficiently` `.only` discipline** — get one representative test green on the primitive before rewriting the rest; the existing green tests are the safety net; the read/transaction paths are the **critical resource path**, so mutation-check the special-case logic survives.
- **orgTree** (trivial, Pattern C): `#orgTreeMutate` → `callAsync`; delete `#pendingMutations` + `handleOrgTreeResult`. `orgTree.*` inherits `callAsync`'s built-in default timeout (D4). Confirm `nebula-orgtree` baseline stays green (incl. `.rejects.toThrow()`) + a timed-out mutation rejects rather than hangs (new test).
- **read** (Pattern R → per D5 sub-decision, lean (a) Pattern C): `#readResource` → `callAsync`; `Star.read` returns the Snapshot|null|Error (framework fires back) and the `deliverReadResponse` data-plane seam is dropped; **relocate ontology-stale → `#dispatchOntologyStale`/`onShouldRefreshUI`** onto the `callAsync` `.catch`/wrapper. Delete `#pendingReads`/`handleReadResponse`. Preserve concurrent-read correlation (now by `callId`).
- **transaction** (Pattern R, the gnarliest): `submitBatch` → `callAsync`; `Star.transaction` returns the `TransactionResult`|Error; **relocate `mapTransactionResult`, the ontology-stale→`{ontologyStale}` resolve (not reject), and the submit-gate (`#inFlightSubmit`/`#pumpSubmitGate` serialization)** onto the wrapper. Delete `handleTransactionResult`'s delivery role. This is the highest-risk migration — do it last, most carefully.
- Confirm no non-client caller relied on the dropped explicit fire-backs (D5 sub-decision (a) precondition).

### Phase 3 — ADR + docs
- **ADR-003 amendment — articulate the client carve-out (the point of the `callAsync` name, D1).** Fold into the parent task's Phase-3 ADR work (done after this lands, so one amendment covers the whole picture). The bright line ("nothing depends on request/response across hops") holds for **DO/Worker** — a held Promise dies on hibernation → continuations only. The **client** is the justified asymmetry: its heap survives freeze + reconnect and delivery re-resolves by `instanceName` (D16/D17), so `callAsync` is a **local Promise wrapper over one-way-fire + fire-back — NOT a socket-bound request/response session** (that's what `callRaw` was, and why it stranded on reconnect). So `callAsync` doesn't violate ADR-003; it *realizes* it in the one environment where an awaitable is both safe (heap-durable) and the natural ergonomic (browsers await). State the boundary explicitly: **client-only** — DOs/Workers never get `callAsync` (it would reintroduce the forbidden held-Promise-in-memory).
- **Docs** (`website/docs/mesh/{calls,continuations}.mdx` + `.claude/rules/mesh.md`): `callAsync` as the client's resilient awaitable call; abort-cancels-the-wait-not-the-op; "prefer subscriptions for live UI data; `callAsync` for one-shot reads/mutations that need an ack/error."

### Success Criteria
- [ ] `LumenizeClient.callAsync` in Mesh, `AbortSignal`-cancellable + default `timeoutMs`, tested (settle/reject/abort/timeout/reconnect/dedup, each capable-of-failing).
- [ ] **All three duplicates collapsed onto `callAsync`** (D5=option 2): orgTree (`#orgTreeMutate`), read (`#readResource`/`#pendingReads`/`handleReadResponse`), transaction (`submitBatch`/`handleTransactionResult`) — the hand-rolled `requestId`/`#pending*` maps + settler handlers deleted; a call whose result is lost now **rejects on timeout** (no hang), verified.
- [ ] **Critical-path safety (D5 guardrail):** read/transaction migrated under `.only` discipline; the special-case logic is **mutation-checked** to survive — ontology-stale → `onShouldRefreshUI` (both read + transaction), `mapTransactionResult`, and the transaction submit-gate serialization; concurrent reads stay correlated.
- [ ] D5 sub-decision resolved (lean (a): `Star.read`/`transaction` return-value + framework fire-back, `deliverReadResponse`/`deliverTransactionResult` seam dropped) — with a confirmed check that no non-client caller relied on the explicit fire-back.
- [ ] mesh + nebula-baseline suites green (incl. the full resource path); type-check clean.
- [ ] `callDurable`-for-clients seam left open (D6); the on-hold file cross-references `callAsync` as its foundation.

---

## Notes
- This is the client-side completion of the continuation-only model — `mesh-continuation-only-calls.md` is not truly "done" until this lands (its Phase-2 banner points here).
- The abort primitive also gives the UI a clean "cancel this in-flight action" affordance for free (not just timeouts) — e.g., navigating away from a slow mutation.
- Keep the parent task's bright line intact: raw `lmz.call` on the client stays fire-and-forget/4-arg-handler; `callAsync` is the **SDK-layer** awaitable built on top, not a reintroduction of socket-bound awaited `callRaw`.

# Debounce + serial-per-resource queue (detour task for nebula-frontend Phase 5.3.7-v3)

**Status**: not started. Prerequisite for `tasks/nebula-frontend.md` Phase 5.3.7-v3.

**Why it's a detour**: the design has more correctness invariants than the rest of v3 combined — eTag-race correctness, in-flight buffering, flush-on-(unmount|blur|dispose), transaction-result triggering buffered submits. The spike factory at [apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts) does NONE of this — it just `queueMicrotask`s a single transaction per write. Building the full state machine inline with the rest of v3 risks "the doc says debouncing works, the implementation has subtle bugs nobody caught" — exactly the failure mode the docs-first sequencing was meant to avoid.

Derisking with a spike + property-style tests BEFORE the production port lets us validate the state machine against the invariants in isolation, then port the validated design.

---

## Pinned behavior (from `tasks/nebula-frontend.md` Phase 5.3.7 + spike findings)

- **Quiet window**: 500 ms default. After last write to a resource, wait this long with no further writes, then submit.
- **Max wait**: 2000 ms default. Cap total wait so continuous typing still produces ~1 transaction per maxWait window.
- **Configurable per resource type** via `client.resources.transactionDebounce(rt, { quietMs, maxWaitMs })`.
- **Per-write opt-out** via `v-model.eager` (bypass debounce entirely, fire immediately).
- **Flush triggers**: quiet-window elapse, maxWait elapse, component unmount, input blur, `client.dispose()`.
- **Serial per resource**: at most one transaction in flight per `(rt, rid)`. Subsequent writes during in-flight buffer; flush submits using the in-flight transaction's resulting `eTag`, not the pre-submit `eTag`.
- **Optimistic write is independent of debouncing**: every keystroke writes through to the store immediately. Debounce only gates the transaction submission, not the store update.

---

## Phase D0 — Spike (~half-day)

Goal: validate the state machine against the correctness invariants in a minimal harness. Lives in `apps/nebula/spike/debounce/` (deleted post-merge per the standard experiment lifecycle).

Harness shape:
- A factory of the spike's `createNebulaClient` shape with a mocked `client.transaction` that captures every submitted `{ rt, rid, eTag, newETag, value }` tuple and answers with controlled outcomes (commit, conflict, timeout).
- A `simulateTyping(string, opts)` driver that writes characters into a store path at configurable intervals (including bursts that cross the maxWait boundary).
- A `simulateCrossClientCommit(rt, rid, newSnapshot)` driver that injects fanout while a local tx is in flight.

Property assertions (use vitest's table tests + `vi.useFakeTimers` for determinism; cross-check a subset under real timers):

- [ ] N keystrokes within `quietMs` produce exactly 1 transaction.
- [ ] N keystrokes spread over T ms (T > maxWaitMs) produce ≤ `ceil(T / maxWaitMs) + 1` transactions.
- [ ] All submitted transaction `newETag`s are unique (no idempotency collision).
- [ ] Across a chain of debounced submissions for a single resource, the `eTag` of each submission equals the `newETag` (or server-returned eTag) of the previous successful submission. No stale-eTag submissions, no double-submission with the same `eTag`.
- [ ] Cross-client commit landing while local tx in-flight: exactly one conflict-resolver invocation per conflict, not one per buffered write.
- [ ] Flush on unmount: a write within the quiet window that gets unmounted before quiet elapse submits exactly once (via flush).
- [ ] Flush on blur: same property, blur trigger.
- [ ] Flush on dispose: pending writes flush before dispose resolves; no transactions submitted after dispose returns.
- [ ] `v-model.eager` writes bypass the debouncer entirely — submit on the next microtask.

Aim for ≥ 8 of these green before moving to D1.

---

## Phase D1 — Design (~half-day)

Output: a state diagram (Mermaid or ASCII) as an inline block in this file.

States per resource:
- `Idle` — no writes, no timers, no in-flight tx.
- `QuietTimerRunning` — last write recent; quiet timer ticking; no in-flight tx.
- `MaxWaitTimerRunning` — first write older than quietMs ago but within maxWait; max-wait timer ticking (logically, this is layered onto QuietTimerRunning — both timers run concurrently and whichever fires first triggers submit). May collapse into a single state with two timers.
- `InFlight` — transaction submitted, awaiting result; no buffered writes.
- `InFlightWithBuffer` — transaction submitted; subsequent writes have updated the store and need a follow-up submit.

Transitions to enumerate:
- `write` (any → Quiet/MaxWait, or InFlight → InFlightWithBuffer)
- `quietTimerFire` (Quiet → InFlight, submit pending value)
- `maxWaitTimerFire` (Quiet → InFlight, submit pending value)
- `flushExternal` (unmount/blur/dispose; any → InFlight or Idle)
- `txResultSuccess` (InFlight → Idle, or InFlightWithBuffer → InFlight using new eTag)
- `txResultConflict` (InFlight → resolver fires; InFlightWithBuffer → resolver fires then either back to InFlight with merged value or rollback)
- `txResultRollback` (InFlight → Idle with pre-write value restored)

Open design questions to resolve in D1:
- **Coalescing during InFlight**: when a write arrives during InFlight, does the buffer hold the latest *value*, or a queue of *writes*? Likely just-the-latest-value — the optimistic store update is the source of truth; the buffered submit just needs to capture "whatever the store says when we go to submit."
- **maxWait timer reset semantics**: does maxWait start on first-write-after-Idle and never reset, OR does it reset on transaction-result-success (allowing the next "burst" its own 2 s window)? Likely the latter — the user perceives each successful submission as a fresh starting point.
- **Cross-resource ordering**: are timers per-resource or global? Per-resource — different resources are independent, their submissions can interleave freely.
- **Flush priority during conflict resolution**: if a conflict resolver is awaiting (e.g., `human-in-the-loop` modal), do flushes for that resource block, or do they queue behind the resolver? The doc says "transaction queue parks while the modal is open" — so flushes for the conflicted resource queue; flushes for other resources proceed.

---

## Phase D2 — Production port (~1 day)

Ports the validated state machine into `packages/nebula-frontend/src/debounce.ts` as part of `tasks/nebula-frontend.md` Phase 5.3.7-v3. By this point the design is locked; D2 is mechanical translation + integration with the synced-state middleware.

- [ ] Implement the state machine per the D1 diagram.
- [ ] Wire into synced-state middleware (the middleware enqueues into the debouncer; the debouncer calls `client.resources.transaction(...)` when it's time to submit).
- [ ] Integrate flush triggers: `onScopeDispose` (Vue) for unmount, focus/blur event handlers attached by the `v-model` directive wrapper for blur, `client.dispose()` for whole-app teardown.
- [ ] Port the spike's property tests to `packages/nebula-frontend/test/unit/debounce.test.ts`.
- [ ] Add an e2e test in `packages/nebula-frontend/test/e2e/` that drives a real Star with the debouncer; asserts the per-resource serial-queue + eTag-chain invariants against actual server transactions.

---

## Deletion

This file gets archived to `tasks/archive/debounce-serial-queue.md` once D2 lands. The state-machine diagram + invariants list survive there as historical record.

The `apps/nebula/spike/debounce/` directory gets removed alongside `apps/nebula/spike/alpine-adapter/` in the 5.3.7 post-merge cleanup.

# Debounce + serial-per-resource queue (detour task for nebula-frontend Phase 5.3.7-v3)

**Status**: not started. Prerequisite for `tasks/nebula-frontend.md` Phase 5.3.7-v3.

**Why it's a detour**: the design has more correctness invariants than the rest of v3 combined — eTag-race correctness, in-flight buffering, flush-on-(unmount|blur|dispose), transaction-result triggering buffered submits. The spike factory at [apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts](../apps/nebula/spike/alpine-adapter/src/create-nebula-client.ts) does NONE of this — it just `queueMicrotask`s a single transaction per write. Building the full state machine inline with the rest of v3 risks "the doc says debouncing works, the implementation has subtle bugs nobody caught" — exactly the failure mode the docs-first sequencing was meant to avoid.

Derisking with a spike + property-style tests BEFORE the production port lets us validate the state machine against the invariants in isolation, then port the validated design.

---

## Pinned behavior (from `tasks/nebula-frontend.md` Phase 5.3.7 + spike findings)

- **Quiet window**: 500 ms default. After last write to a resource, wait this long with no further writes, then submit.
- **Max wait**: 2000 ms default. Cap total wait so continuous typing still produces ~1 transaction per maxWait window.
- **Configurable per resource type** via `client.resources.transactionDebounce(rt, { quietMs, maxWaitMs })`.
- **Per-field eager** via ontology `@debounce(0)` (or type-derived `quietMs: 0` for boolean/enum) — NOT a `v-model.eager` modifier (that design was retired; see nebula-frontend.md § "`v-model` debouncing"). Resource-level rule: shortest active timer wins, so flushing a `@debounce(0)` field also flushes pending debounced edits on the same resource.
- **Flush triggers**: quiet-window elapse, maxWait elapse, component unmount, input blur, `client.dispose()`.
- **Connection-gated write path (decided 2026-06-11):** while `lmz.connection.state !== 'connected'`, the write path is **suspended** — flush is held (buffered writes wait; the optimistic store already shows them), no submission goes out, and no in-flight timeout/infra-error timer arms. Held writes flush on reconnect; a transaction that was in flight at the moment of disconnect is **re-submitted** on reconnect with its *same* `newETag` (idempotent — the server short-circuits if it had already committed), never rolled back by the disconnect itself. This is what makes the disconnected banner's promise ("your changes are queued") honest. Rollback is reserved for server-acknowledged failures and genuine *while-connected* non-response.
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
- [ ] **Base re-anchors with the eTag at the commit boundary (B4 site b):** a buffered write that chains onto a cleanly-committed transaction carries that transaction's committed value as its merge `base`, not the original pre-write value. Capable-of-failing: T1 commits, a buffered write becomes T2, a third party moved the server → T2 conflicts; assert the resolver's `base` = T1's committed value (a base-not-re-anchored impl carries the stale original and the merge double-counts T1's edit).
- [ ] Cross-client commit landing while local tx in-flight: exactly one conflict-resolver invocation per conflict, not one per buffered write.
- [ ] Flush on unmount: a write within the quiet window that gets unmounted before quiet elapse submits exactly once (via flush).
- [ ] Flush on blur: same property, blur trigger.
- [ ] Flush on dispose: pending writes flush before dispose resolves; no transactions submitted after dispose returns.
- [ ] A `@debounce(0)` / `quietMs: 0` field submits on the next microtask (no quiet window); flushing it also flushes any pending debounced writes on the **same** resource (shortest-active-timer-wins).
- [ ] **Multi-resource batch (deep-review m9):** a transaction touching N resources occupies all N per-`(rt, rid)` queues; buffered writes to any of those resources chain off the batch's resulting eTag; an explicit `transaction()` call flushes pending debounced writes for the resources it touches first. D0 race probe: interleave a debounced write and an explicit multi-resource batch on overlapping resources; assert no lost write and correct eTag chaining.
- [ ] **Disconnect suspends the write path (decided 2026-06-11):** drive the mock to a non-`'connected'` state; a write that would normally flush (quiet/maxWait elapse, blur) produces **no** submission and arms **no** timeout timer while disconnected; on reconnect, exactly one submission goes out carrying the latest coalesced value, eTag chain intact. Capable-of-failing: an impl that flushes regardless of connection submits-then-times-out (or rolls back) before reconnect.
- [ ] **In-flight at disconnect re-submits on reconnect (idempotent):** a transaction in flight when the connection drops is NOT rolled back by the disconnect, and its timeout timer is suspended; on reconnect it re-submits with the *same* `newETag` (server replay short-circuits to `committed` if it had landed). Capable-of-failing: an impl that lets the 10 s timeout fire while disconnected rolls back the optimistic write the banner promised was queued.

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
- `txResultSuccess` (InFlight → Idle, or InFlightWithBuffer → InFlight using new eTag **and re-anchoring the merge `base` to the just-committed value** — see [factory-conflict-outcome.md](factory-conflict-outcome.md) invariant 5 site (b); the buffered submit's `base` must advance with its `eTag`, or a later conflict double-counts the committed edit)
- `txResultConflict` (InFlight → resolver fires; InFlightWithBuffer → resolver fires then either back to InFlight with merged value or rollback)
- `txResultRollback` (InFlight → Idle with pre-write value restored)
- `connectionLost` (`lmz.connection.state` leaves `'connected'`; any state → **suspended**: hold buffered writes, do NOT submit, suspend the quiet/maxWait timers AND any in-flight timeout timer — no rollback from a disconnect)
- `connectionRestored` (→ `'connected'`: re-submit any transaction that was in flight at disconnect with its *same* `newETag` (idempotent — server short-circuits if it had committed), then flush held writes; eTag chain intact)

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
- [ ] Integrate flush triggers: `onScopeDispose` (Vue) for unmount; blur flush via a directive-free mechanism (no custom directive exists in the pinned design — e.g. a factory-installed capture-phase `focusout` listener; pick during D1/D2 and record here) honoring the "input blur (when reachable)" contract (nebula-frontend § v-model debouncing, trigger (d)); `client.dispose()` for whole-app teardown.
- [ ] Wire the **connection gate**: subscribe to `lmz.connection` transitions (the factory already observes them via `onConnectionStateChange`) — suspend flush + the in-flight timeout/infra-error timer while not `'connected'`; on reconnect, re-submit any in-flight transaction (same `newETag`) and flush held writes.
- [ ] Port the spike's property tests to `packages/nebula-frontend/test/unit/debounce.test.ts`.
- [ ] Add an e2e test in `packages/nebula-frontend/test/e2e/` that drives a real Star with the debouncer; asserts the per-resource serial-queue + eTag-chain invariants against actual server transactions.

---

## Deletion

This file gets archived to `tasks/archive/debounce-serial-queue.md` once D2 lands. The state-machine diagram + invariants list survive there as historical record.

The `apps/nebula/spike/debounce/` directory gets removed alongside `apps/nebula/spike/alpine-adapter/` in the 5.3.7 post-merge cleanup.

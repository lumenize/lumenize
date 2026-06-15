# Debounce + serial-per-resource queue (detour task for nebula-frontend Phase 5.3.7-v3)

**Status**: **D0 + D1 complete in spike 2026-06-12**; D2 (production port) remains, rides v3. Prerequisite for `tasks/nebula-frontend.md` Phase 5.3.7-v3.

**Where it landed** (in `apps/nebula/spike/vue-factory/`, NOT the originally-planned `spike/debounce/` — the queue had to share the factory + MockClient harness with the collection-sync detour, and the spike factory itself needed the queue wired in so collection mutations could share the submission path):
- `src/debounce-queue.ts` — the state machine, standalone module with injected `submit`/`readResource`/`onCommitted`/`onNonCommit`.
- `test/debounce-queue.test.ts` — 20 property tests (fake timers), the D0 isolation harness.
- `src/create-nebula-client.ts` — the spike factory now submits THROUGH the queue (synced-state middleware → `queue.write`; `queueMicrotask`-per-write is gone). Factory-level integration covered by factory-basics (at `quietMs: 0`) + collection-sync suites; e2e (phase-0b) + Vue (phase-1) re-verified green.
- Conflict resolution stays OUT: every non-committed outcome delegates to `onNonCommit(outcome, submission, api)` with `api.accept/fail/resubmit` — the `factory-conflict-outcome.md` machine plugs in there; the key stays occupied (and its timeout cancelled) while a resolver deliberates, so async-resolver-suspends-timeout falls out of the occupancy design.

**Capable-of-failing verified 2026-06-12** (gut → observe failures → restore): (a) removing the commit-boundary base re-anchor fails exactly the B4 test; (b) removing the disconnect suspend block fails exactly the two connection-gate tests ("submits-then-times-out before reconnect" and "timeout fires while disconnected"). One test was strengthened when a probe survived: the offline-write assertion now advances time before asserting zero submissions (an impl that arms timers offline would otherwise slip through).

**Why it's a detour**: the design has more correctness invariants than the rest of v3 combined — eTag-race correctness, in-flight buffering, flush-on-(unmount|blur|dispose), transaction-result triggering buffered submits. The spike factory at [apps/nebula/spike/vue-factory/src/create-nebula-client.ts](../apps/nebula/spike/vue-factory/src/create-nebula-client.ts) does NONE of this — it just `queueMicrotask`s a single transaction per write. Building the full state machine inline with the rest of v3 risks "the doc says debouncing works, the implementation has subtle bugs nobody caught" — exactly the failure mode the docs-first sequencing was meant to avoid.

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

## Phase D0 — Spike (~half-day) — DONE 2026-06-12

Goal: validate the state machine against the correctness invariants in a minimal harness. Lives in `apps/nebula/spike/vue-factory/` (see Status above; deleted post-merge per the standard experiment lifecycle).

Harness shape:
- A factory of the spike's `createNebulaClient` shape with a mocked `client.transaction` that captures every submitted `{ rt, rid, eTag, newETag, value }` tuple and answers with controlled outcomes (commit, conflict, timeout).
- A `simulateTyping(string, opts)` driver that writes characters into a store path at configurable intervals (including bursts that cross the maxWait boundary).
- A `simulateCrossClientCommit(rt, rid, newSnapshot)` driver that injects fanout while a local tx is in flight.

Property assertions (use vitest's table tests + `vi.useFakeTimers` for determinism; cross-check a subset under real timers):

- [x] N keystrokes within `quietMs` produce exactly 1 transaction.
- [x] N keystrokes spread over T ms (T > maxWaitMs) produce ≤ `ceil(T / maxWaitMs) + 1` transactions.
- [x] All submitted transaction `newETag`s are unique (no idempotency collision). (Across *logical* submissions — a reconnect replay of the same in-flight submission intentionally reuses its `newETag`; a conflict re-submission gets a fresh one.)
- [x] Across a chain of debounced submissions for a single resource, the `eTag` of each submission equals the `newETag` (or server-returned eTag) of the previous successful submission. No stale-eTag submissions, no double-submission with the same `eTag`.
- [x] **Base re-anchors with the eTag at the commit boundary (B4 site b):** a buffered write that chains onto a cleanly-committed transaction carries that transaction's committed value as its merge `base`, not the original pre-write value. Capable-of-failing VERIFIED: gutting the re-anchor fails exactly this test.
- [x] Cross-client commit landing while local tx in-flight: exactly one conflict-resolver invocation per conflict, not one per buffered write.
- [x] Flush on unmount: a write within the quiet window that gets unmounted before quiet elapse submits exactly once (via flush). (Queue-level `flush(rt, rid)`; the Vue `onScopeDispose` wiring is D2.)
- [x] Flush on blur: same property, blur trigger (queue-level `flush()`; the focusout listener is D2).
- [x] Flush on dispose: pending writes flush before dispose resolves; no transactions submitted after dispose returns. (Design decision recorded below: writes buffered *behind an in-flight transaction* at dispose time are dropped — submitting them would violate "nothing after dispose"; the in-flight one itself settles normally.)
- [x] **v3-port add (Mn13) — assert the drop-behind-in-flight branch.** The dispose test above has nothing in flight (both keys merely Pending), so the surprising half of the pinned decision is unasserted. Add a dispose probe with a *deferred in-flight* transaction + a buffered follow-up write: assert the buffered write **never** submits, the in-flight one settles **normally**, and dispose resolves after it settles — so an impl that flushes the buffer after dispose, or cancels the in-flight settle, is caught. **(DONE 2026-06-14: `debounce.test.ts` "dispose DROPS a write buffered behind a deferred in-flight tx".)**
- [x] A `@debounce(0)` / `quietMs: 0` field submits on the next microtask (no quiet window); flushing it also flushes any pending debounced writes on the **same** resource (shortest-active-timer-wins; the submission reads the full resource value, so both edits ride one transaction).
- [x] **Multi-resource batch (deep-review m9):** a transaction touching N resources occupies all N per-`(rt, rid)` queues; buffered writes to any of those resources chain off the batch's resulting eTag; an explicit `transaction()` call flushes pending debounced writes for the resources it touches first (folded into the batch — their coalesced value rides it; no separate submission, no lost write). Race probe green incl. parking the batch behind an in-flight single.
- [x] **Disconnect suspends the write path (decided 2026-06-11):** capable-of-failing VERIFIED (suspend block gutted → both gate tests fail).
- [x] **In-flight at disconnect re-submits on reconnect (idempotent):** same `newETag`, `attempt` bumped, timeout suspended while offline, stale first-attempt responses ignored (attempt-counter guard). Capable-of-failing VERIFIED (same gut).
- [x] **v3-port add (Mn8) — gate tests drive only `'reconnecting'`.** Both gate tests above call `setConnectionState('reconnecting')`, but the contract predicate is `!== 'connected'`. Parameterize over every non-`'connected'` literal (`'connecting'`, `'reconnecting'`, `'disconnected'`) — a `'disconnected'`-driven in-flight must neither time out nor roll back, then replay the same `newETag` on reconnect. **(DONE 2026-06-14: `debounce.test.ts` "connection gate — every non-connected literal (Mn8)" — in-flight + held-write probes parameterized over all three literals.)**

All 13 green (20 tests incl. per-type config, infra-timeout-while-connected, stale-attempt race, and the use-this resubmit plumbing for detour #4).

---

## Phase D1 — Design (~half-day) — DONE 2026-06-12 (diagram below reflects the built machine)

```
Per (rt, rid) key — two orthogonal axes: dirty? (a local edit awaits submission)
and occupied? (a submission for this key is in flight / awaiting resolver).
Timers exist only when dirty ∧ free ∧ connected.

                         write (effQuiet>0: restart quiet; arm maxWait once/burst)
                         write (effQuiet=0: microtask flush)
            ┌────────┐ ───────────────────────────────────────►  ┌──────────────────┐
            │  Idle   │                                          │ Pending (dirty,  │◄─┐
            │ (clean) │ ◄─── txResult committed (no buffer) ───  │ timers running)  │──┘ write:
            └────────┘      [baseline+base advance together]     └──────────────────┘    restart quiet
                ▲                                                   │
                │                                  quietFire / maxWaitFire / flush(unmount|blur|dispose)
                │                                  [reads store value NOW; eTag=baseline; base=baseValue]
                │                                                   ▼
                │              write ⇒ dirty (buffer; latest-value) ┌──────────────────┐
                │            ┌───────────────────────────────────► │ InFlight          │
                │            │                                     │ (occupied; 10 s   │
                │            └──────────────────────────────────── │ timeout armed)    │
                │                                                  └──────────────────┘
                │                     txResult committed ∧ dirty:      │         │
                │                     re-enter Pending (fresh quiet/   │         │ non-commit outcome:
                │                     maxWait) — flushOnRelease ⇒      │         │ key STAYS occupied;
                │                     submit immediately               │         │ onNonCommit(outcome, sub, api)
                │                                                      ▼         ▼
                │                                            api.accept(snapshot) → baseline=snapshot, release
                └─────────────────────────────────────────── api.fail()           → drop dirty, release
                                                              api.resubmit({...})  → new submission (fresh newETag)

Connection gate (orthogonal): state ≠ 'connected' ⇒ all timers cancelled
(dirty persists), in-flight timeout cancelled + batch marked suspended; NOTHING
rolls back. Reconnect ⇒ suspended in-flight replays (SAME newETag, attempt+1,
stale earlier-attempt responses ignored), then dirty free keys flush
immediately, then parked batches re-checked.

Explicit multi-resource batch (m9): occupies ALL its keys; folds those keys'
pending writes (their timers cancel; values read at submit); parks FIFO until
every key is free ∧ connected.
```

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

Open design questions — ALL RESOLVED in the built machine:
- **Coalescing during InFlight**: just-the-latest-value, as suspected — the buffer is a `dirty` flag; the submission re-reads the store at submit time. ✔ built + tested.
- **maxWait timer reset semantics**: the latter — maxWait anchors at each burst's first write and a post-commit buffered burst gets a fresh window (release re-enters the debounce cycle; an external flush or `@debounce(0)` write during flight sets `flushOnRelease` ⇒ immediate submit on release instead). ✔ built + tested (the continuous-typing cap test depends on it).
- **Cross-resource ordering**: per-resource timers; independent interleaving. ✔ tested (occupied `t1` does not block `t2`).
- **Flush priority during conflict resolution**: the key stays occupied from non-commit outcome until the handler concludes via `api.accept/fail/resubmit` — flushes for that resource buffer behind it (the in-flight timeout is already cancelled when the outcome arrives, so an open modal can't trigger `'timeout'`); other resources proceed. ✔ built; the resolver-side behavior tests live in factory-conflict-outcome.

---

## Phase D2 — Production port (~1 day)

**MODULE PORT DONE 2026-06-14 (nebula-frontend v3 Phase 3):** the state-machine module is ported code-identical to `apps/nebula/src/frontend/debounce.ts` with its 20 property tests + the Mn13/Mn8 v3-port adds (27 tests, unit project 79/79, `tsc` clean). What remains rides the **factory port (Phase 6)**: the synced-state-middleware wiring, the Vue `onScopeDispose` / capture-phase `focusout` flush triggers, the `onConnectionStateChange`→`setConnectionState` subscription, and the real `client.resources.transaction` submit adapter + an e2e test.

Ports the validated state machine into `apps/nebula/src/frontend/debounce.ts` as part of `tasks/nebula-frontend.md` Phase 5.3.7-v3. By this point the design is locked; D2 is mechanical translation + integration with the synced-state middleware. **Head start from D0**: the spike factory already wires the queue end-to-end (middleware → `queue.write`, `onConnectionStateChange` → `setConnectionState`, fanout → `noteRemoteSnapshot`, `dispose` → `queue.dispose`, `flush`/`transactionDebounce` exposed on the factory result) — the port translates that wiring too, leaving only the Vue/DOM triggers (`onScopeDispose`, focusout) and the real `client.resources.transaction` adapter genuinely new.

- [x] Implement the state machine per the D1 diagram. **(ported code-identical to spike; 79/79 unit)**
- [ ] Wire into synced-state middleware (the middleware enqueues into the debouncer; the debouncer calls `client.resources.transaction(...)` when it's time to submit). **(factory port — Phase 6)**
- [ ] Integrate flush triggers: `onScopeDispose` (Vue) for unmount; blur flush via a directive-free mechanism (no custom directive exists in the pinned design — e.g. a factory-installed capture-phase `focusout` listener; pick during D1/D2 and record here) honoring the "input blur (when reachable)" contract (nebula-frontend § v-model debouncing, trigger (d)); `client.dispose()` for whole-app teardown.
- [ ] Wire the **connection gate**: subscribe to `lmz.connection` transitions (the factory already observes them via `onConnectionStateChange`) — suspend flush + the in-flight timeout/infra-error timer while not `'connected'`; on reconnect, re-submit any in-flight transaction (same `newETag`) and flush held writes.
- [x] Port the spike's property tests to `apps/nebula/test/frontend/debounce.test.ts`. **(20 ported + Mn13 + Mn8 = 27, green)**
- [ ] Add an e2e test in `apps/nebula/test/frontend/e2e/` that drives a real Star with the debouncer; asserts the per-resource serial-queue + eTag-chain invariants against actual server transactions.

---

## Deletion

This file gets archived to `tasks/archive/debounce-serial-queue.md` once D2 lands. The state-machine diagram + invariants list survive there as historical record.

The `apps/nebula/spike/debounce/` directory gets removed alongside `apps/nebula/spike/vue-factory/` in the 5.3.7 post-merge cleanup.

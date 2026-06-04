# `validation-failed` rollback on optimistic `put`

**Status**: Complete (2026-06-04). Phase 1 postmortem identified live-reference capture as the root cause (refuting both original hypotheses). Phase 2 fix shipped: `structuredClone` at the `preWriteValue` capture site in `nebula-client.ts` + `assertNever` exhaustiveness check on the dispatcher. Phase 3 in-scope siblings shipped: `validation-failed` un-skipped + `permission-denied` and `ontology-stale` added. Deferred siblings (`timeout`, `retries-exhausted`) tracked in [nebula-scratchpad.md](nebula-scratchpad.md) § "Rollback failure-outcome sibling tests (deferred)".
**Spawned from**: [tasks/nebula-frontend.md](nebula-frontend.md) § Phase 5.3.6 "Deferred items"; surfaced by the skipped test at [apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts:291](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts).

**Prerequisite**: ✅ shipped — see [archive/debug-spyable-output.md](archive/debug-spyable-output.md). Phase 1 diagnosis can use the sink via `setDebugSink` from `@lumenize/debug` rather than `console.log`.

**Scope decision (2026-06-04)**: Phase 3 sibling tests narrowed to `permission-denied` + `ontology-stale`. The other two (`timeout`, `retries-exhausted`) are deferred — `timeout` needs WS-disconnect tooling we don't have yet, and `retries-exhausted` belongs with the broader conflict-resolver-loop work in Phase 5.3.7. Tracked in [nebula-scratchpad.md](nebula-scratchpad.md) § "Rollback failure-outcome sibling tests (deferred)".

## Objective

When a `client.resources.put` (via bindToState middleware) submits a value that fails typia validation server-side, the optimistic write currently **stays at the invalid value** instead of rolling back to the pre-write snapshot. Investigate why and fix so the test at line 291 passes.

When this lands, write the same-shaped sibling tests for the other terminal-non-committed outcomes: `permission-denied`, `ontology-stale`, `timeout`, `retries-exhausted`. (The middleware's `#processMiddlewareOutcome` is the code path for all of them — covered for `'committed'` and `'use-server'` via other tests but the failure-outcome branches need test coverage too.)

## Suspected root cause

Per the SKIP comment at [nebula-client-bindtostate.test.ts:281-290](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts):

> Likely cause: typia validation on a `put` is gated by `currentSnapshots.get(resourceId)` being truthy at [apps/nebula/src/resources.ts:306-310](../apps/nebula/src/resources.ts) — needs investigation into whether validation actually runs in this path or the bad value gets committed.

Two non-exclusive hypotheses:

1. **Validation skipped for `put` when the resource already exists** — the gate at resources.ts:306-310 excludes the put-on-existing-resource path. If so, the fix is to also validate on put, not just on create. Server-side validation should always run.
2. **Validation runs but `#processMiddlewareOutcome` doesn't handle the `'validation-failed'` outcome** — the rollback path covers `'committed'` and `'use-server'` (per the SKIP comment) but `'validation-failed'` may fall through without rolling state. Fix is in the client's middleware-outcome dispatcher.

Investigation order:
1. Use `setDebugSink` from `@lumenize/debug` (see [archive/debug-spyable-output.md](archive/debug-spyable-output.md)) at resources.ts:306-310 to confirm whether typia is called on the put.
2. If typia is NOT called → hypothesis 1, fix the gate.
3. If typia IS called → trace what the client receives. Confirm the wire-protocol field on the `TransactionResolution`. Trace into `#processMiddlewareOutcome` and find the gap.

## Phase 1: Diagnosis

**Goal**: Confirm which hypothesis (or both) is right; produce a one-paragraph postmortem in this file before writing any fix code.

**Success Criteria**:
- One unambiguous root cause identified.
- Either reproduction is trivial outside the bindToState test (write a direct `client.resources.transaction(...)` call with a bad value, see if it fails with `resolution: 'validation-failed'`).

## Phase 1 postmortem (2026-06-04)

**Root cause: live-reference capture, not validation gate or dispatcher gap.** The put-variant probe at [nebula-client-read-transaction.test.ts:145](../apps/nebula/test/test-apps/baseline/nebula-client-read-transaction.test.ts:145) (new) passes — server-side validation correctly runs on `put` and the client receives `resolution: 'validation-failed'`. The dispatcher case for `'validation-failed'` exists and runs. The actual gap is in `#middlewareFn`'s pre-write snapshot: at [nebula-client.ts:477](../apps/nebula/src/nebula-client.ts:477), `preWriteValue = state.getState(`${basePath}.value`)` captures the **live object reference** at `.value`. StateManager's `#setStateImmediate` then calls `#writeAtPath` ([state-manager.ts:369-381](../packages/state/src/state-manager.ts:369-381)) which mutates the *same* object in place (e.g. sets `obj.title = 42`). When the dispatcher later calls `state.setState(`${basePath}.value`, preWriteValue, { source: 'rollback' })`, `preWriteValue` already has `title: 42`, so the deep-equals dedup at [state-manager.ts:357](../packages/state/src/state-manager.ts:357) treats the rollback as a no-op. Both original hypotheses are refuted; the bug is purely in `preWriteValue` capture. Fix: deep-clone the pre-write value at capture time (`structuredClone(state.getState(...))`).

## Phase 2: Fix

**Goal**: Whatever Phase 1 surfaces — fix the gate OR fix the middleware outcome dispatcher OR both.

**Success Criteria**:
- The skipped test at line 291 unskips and passes.
- No regression in the 'committed' / 'use-server' / 'permission-denied' paths covered by neighbor tests.

## Phase 3: Sibling tests (in-scope: `permission-denied` + `ontology-stale`)

**Goal**: Write equivalent rollback tests for the remaining now-achievable non-committed outcomes: `permission-denied` and `ontology-stale`. (`timeout` + `retries-exhausted` are deferred — see Scope decision at the top.)

Each test follows the same shape as the `validation-failed` test:
1. Set up a resource + subscriber.
2. Trigger an optimistic write that maps to the target outcome (revoke admin between subscribe and write → `permission-denied`; set the client's ontology version to one no longer current → `ontology-stale`).
3. Assert the state reverts to the pre-write snapshot.

**Success Criteria**:
- Both in-scope sibling tests pass.
- Baseline test count goes from 167/168 (current baseline after [archive/debug-spyable-output.md](archive/debug-spyable-output.md) shipped) → 170/168 or higher after Phase 2 + Phase 3.

## Final Verification

- [ ] `apps/nebula` unit + baseline tests pass (`npx vitest run --project unit --project baseline`).
- [ ] No regression in mesh / auth / nebula-auth.
- [ ] The middleware-outcome dispatcher (`#processMiddlewareOutcome`) has explicit handling for every variant of `TransactionResolution`, with an `assertNever(_x: never): never` fallback so adding a new variant causes a compile error until it's handled here.

## Notes

- The rollback machinery itself appears correct (`'committed'` / `'use-server'` paths work via other tests). The gap is upstream: either validation isn't running or the outcome isn't reaching the dispatcher.
- The blast radius of "silent invalid-value commit" is significant — every typed field on every resource is at risk if validation is bypassed on put. Worth treating as a real correctness bug, not test polish.
- The diagnostic surface this work uses (`setDebugSink`) was shipped 2026-06-04 — see [archive/debug-spyable-output.md](archive/debug-spyable-output.md).

# `validation-failed` rollback on optimistic `put`

**Status**: Not started. Suspected real bug, not test infrastructure.
**Spawned from**: [tasks/nebula-frontend.md](nebula-frontend.md) § Phase 5.3.6 "Deferred items"; surfaced by the skipped test at [apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts:291](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts).

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
1. Add `console.log` (or `setDebugSink` once that ships — see [debug-spyable-output.md](debug-spyable-output.md)) at resources.ts:306-310 to confirm whether typia is called on the put.
2. If typia is NOT called → hypothesis 1, fix the gate.
3. If typia IS called → trace what the client receives. Confirm the wire-protocol field on the `TransactionResolution`. Trace into `#processMiddlewareOutcome` and find the gap.

## Phase 1: Diagnosis

**Goal**: Confirm which hypothesis (or both) is right; produce a one-paragraph postmortem in this file before writing any fix code.

**Success Criteria**:
- One unambiguous root cause identified.
- Either reproduction is trivial outside the bindToState test (write a direct `client.resources.transaction(...)` call with a bad value, see if it fails with `resolution: 'validation-failed'`).

## Phase 2: Fix

**Goal**: Whatever Phase 1 surfaces — fix the gate OR fix the middleware outcome dispatcher OR both.

**Success Criteria**:
- The skipped test at line 291 unskips and passes.
- No regression in the 'committed' / 'use-server' / 'permission-denied' paths covered by neighbor tests.

## Phase 3: Sibling tests

**Goal**: Write equivalent rollback tests for the remaining non-committed outcomes: `permission-denied`, `ontology-stale`, `timeout`, `retries-exhausted`.

Each test follows the same shape as the `validation-failed` test:
1. Set up a resource + subscriber.
2. Trigger an optimistic write that maps to the target outcome (e.g., revoke admin between subscribe and write → `permission-denied`; set the client's ontology version to one no longer current → `ontology-stale`).
3. Assert the state reverts to the pre-write snapshot.

`timeout` may need WS-disconnect tooling (also a deferred item in nebula-frontend.md § 5.3.6). `retries-exhausted` requires a conflict-resolver loop — may belong to its own follow-on.

**Success Criteria**:
- All four sibling tests pass.
- Baseline test count goes from 170/171 (after [debug-spyable-output.md](debug-spyable-output.md) and Phase 2 here) → 174/171 or higher.

## Final Verification

- [ ] `apps/nebula` unit + baseline tests pass (`npx vitest run --project unit --project baseline`).
- [ ] No regression in mesh / auth / nebula-auth.
- [ ] The middleware-outcome dispatcher has explicit handling for every variant of `TransactionResolution` (compile-error if a new variant is added without handling — use exhaustive switch + `never`-typed fallback).

## Notes

- The rollback machinery itself appears correct (`'committed'` / `'use-server'` paths work via other tests). The gap is upstream: either validation isn't running or the outcome isn't reaching the dispatcher.
- The blast radius of "silent invalid-value commit" is significant — every typed field on every resource is at risk if validation is bypassed on put. Worth treating as a real correctness bug, not test polish.
- Could pair naturally with [debug-spyable-output.md](debug-spyable-output.md) — that ships the diagnostic surface this work would use.

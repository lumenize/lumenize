# `onStart()` throw → workerd isolate hang under vitest cleanup

**Status**: Not started.
**Spawned from**: skipped test [packages/mesh/test/lumenize-do.test.ts:92](../packages/mesh/test/lumenize-do.test.ts) — `it.skip('propagates errors from onStart()')`. SKIP comment: "the test passes, but the broken DO leaves workerd in a bad state."

## Objective

Two paired questions:

1. **Does this affect production**, or only test contexts? If a deployed DO's `onStart()` throws, does workerd recover (evict + recreate the DO, isolate serves other DOs normally) or get permanently wedged like it does under vitest-pool-workers cleanup?
2. **If it's a workerd bug** (rather than a vitest-pool-workers test-teardown problem), file an issue with Cloudflare so an upstream fix is on their radar.

Order matters: production behavior gates everything downstream. If production recovers cleanly and only vitest hangs, the bug is in `@cloudflare/vitest-pool-workers`'s isolate-teardown logic; the issue lives at [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/issues). If production ALSO wedges, that's a runtime correctness bug; issue lives at [cloudflare/workerd](https://github.com/cloudflare/workerd/issues).

## Why now (or at least: why on the list)

- Risk surface: `LumenizeDO.onStart()` is documented as the right place for table initialization, blockConcurrencyWhile-protected setup, etc. Any user-authored DO that throws from onStart hits this code path in production. We don't currently know whether their DO is bricked or self-heals.
- Cheap to test: the minimum-repro investigation below should fit in ~30-60 min.
- Cheap to file: Cloudflare's issue templates ask for a `wrangler.jsonc` + a worker source file + repro steps. If the repro is small enough that vitest produces it deterministically, the issue practically writes itself.

## Phase 1: Production-behavior investigation

**Goal**: Determine empirically whether a thrown `onStart()` wedges the DO in production (or, more weakly, whether subsequent calls to the SAME instance recover after a delay).

**Setup**:
- Build a tiny worker with one DO whose `onStart()` throws (the existing `ONSTART_ERROR_DO` in mesh's test-worker-and-dos is the obvious starting point; could be repurposed or copied to a `tooling/onstart-repro/` worker for a clean isolated test).
- Deploy to your existing test Cloudflare account (`transformation` subdomain) as e.g. `onstart-repro.transformation.workers.dev`.
- Send N requests from outside (curl loop) to the same DO instance name. Observe:
  - Do all N return the rejection?
  - Is there evidence of DO eviction (e.g., a fresh DO instance after a delay — observable if onStart writes a sentinel timestamp to storage somewhere safe before throwing)?
  - Does the worker as a whole stay responsive (try a SECOND DO instance name and confirm it works fine)?

**Success Criteria**:
- One paragraph in this file's "Findings" section recording: (a) whether the worker stays responsive to OTHER DO instances, (b) whether the broken DO recovers, (c) any timing data on recovery.

## Phase 2: Minimum-repro construction for upstream

**Goal**: a self-contained reproduction that Cloudflare can run locally without our codebase.

Should be **at most ~30 lines total** across `wrangler.jsonc` + `src/index.ts` + (if going via the workers-sdk issue) `vitest.config.ts` + a one-test test file. The skipped test in [packages/mesh/test/lumenize-do.test.ts](../packages/mesh/test/lumenize-do.test.ts) plus the `OnStartErrorDO` definition in [packages/mesh/test/test-worker-and-dos.ts](../packages/mesh/test/test-worker-and-dos.ts) are the starting point — strip away the LumenizeDO wrapper and use a plain `DurableObject` subclass to rule out any `@lumenize/mesh` involvement.

**Success Criteria**:
- Reproducer fits in a single gist-able snippet.
- Reproducer reproduces deterministically on a fresh `npm install` (no dependency on this repo's lockfile or @lumenize packages).
- Behavior delta vs. expectation is clearly documented in the repro README/comment.

## Phase 3: File the issue

**Goal**: open one issue at the right repo with the repro attached.

**Routing decision** (depends on Phase 1):
- Production OK, vitest hangs → [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/issues) — `@cloudflare/vitest-pool-workers` issue: "broken input gate from thrown onStart prevents isolate teardown."
- Production also wedges → [cloudflare/workerd](https://github.com/cloudflare/workerd/issues) — "Durable Object with thrown onStart leaves the instance in a permanently rejecting state without auto-eviction."

**Success Criteria**:
- Issue opened with repro link.
- Issue URL recorded in this task file's "Findings" section so it's findable later.
- (Optional but valuable) Watch/subscribe to the issue so we're notified of resolution.

## Phase 4: Decide next move based on Cloudflare's response

Three possible response shapes:
1. **"Fixing upstream"** → wait, then unskip when the fix lands in a vitest-pool-workers / workerd release we use.
2. **"Working as intended; here's the right test pattern"** → adopt that pattern, unskip the test.
3. **No response / declined** → either restructure the test (e.g., onStart writes sentinel to storage before throwing, test reads the sentinel from outside without calling the broken DO) or accept the permanent skip with a clear `tasks/` follow-up reference.

## Notes

- "The test passes, but workerd is in a bad state" claim from the original SKIP comment was unverified at the time of this task file's creation. Phase 1 includes verifying it: run the test isolated with `it.only`, watch vitest's output for the ✓/✗ marker on this specific test before the hang. If the assertion DOESN'T pass, that's a different (and more interesting) bug.
- The blast-radius framing — "every user-authored DO with a throwing onStart is potentially affected in production" — may be wrong if the runtime evicts cleanly. Don't carry forward that framing as fact until Phase 1 confirms.

## Findings

(Empty — to be filled in during Phase 1.)

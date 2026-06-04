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

### Phase 1 — Production behavior (2026-06-04)

**Verdict: production recovers cleanly. The bug is a vitest-pool-workers teardown issue, not a workerd runtime issue.**

Repro deployed at `https://onstart-repro.transformation.workers.dev` (account "Lumenize and Transformation.dev"). Source: [experiments/onstart-repro](../experiments/onstart-repro/). Two DO classes — `BrokenDO` (plain `DurableObject` whose constructor calls `ctx.blockConcurrencyWhile(async () => { throw ... })`, no LumenizeDO wrapper) and `HealthyDO` (control).

Observations:

- **10 sequential `GET /broken?name=broken-1` requests**: every one returned the expected error with elapsedMs in the 200-530 ms range. No request rejected instantly (which would indicate a cached/wedged input gate), no request hung, no degradation across requests.
- **`GET /healthy` immediately after the 10 broken hits**: returned `pong` in 21 ms (warm). Worker as a whole is fully responsive.
- **Fresh sibling instance `broken-2`**: same behavior as `broken-1` — fresh cold start (~315 ms), constructor throw, clean rejection. No spillover from the previously-broken `broken-1`.
- **20 parallel requests to `broken-1`**: all completed in 112-229 ms. `wrangler tail` showed 21 DO exception events across two unique `durableObjectId`s (some coalescing happened, but each batch triggered a fresh constructor that threw).
- **Other DO instances and classes are unaffected.** `healthy-1`, `healthy-2`, and a fresh `broken-3` all worked as expected after the burst.

Interpretation: workerd appears to evict the broken DO after each failed instantiation. Subsequent calls to the same instance name get a brand-new DO that runs the same constructor and throws the same error. From the application's perspective, the broken DO is "permanently broken" (every call fails the same way), but there is no leak to other DOs, no isolate wedge, no eviction-storm, no recovery delay needed. The SKIP comment in [packages/mesh/test/lumenize-do.test.ts:91](../packages/mesh/test/lumenize-do.test.ts:91) — "the test passes, but the broken DO leaves workerd in a bad state" — does not reflect production behavior.

Routing decision: **filed at [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/issues)** (`@cloudflare/vitest-pool-workers`), not workerd.

### Phase 2 — Minimum vitest repro (2026-06-04)

**The trigger is more specific than the SKIP comment implied.** Bisecting from mesh's setup down to plain `DurableObject` revealed two necessary conditions inside the `ctx.blockConcurrencyWhile(...)` IIFE: **(1) a `console.*` call**, and **(2) a throw**. Either one alone is fine. Together, they hang vitest at teardown.

Bisection trail (all run under `vitest 4.1.4` + `@cloudflare/vitest-pool-workers 0.16.13`):

| Setup | Result |
| --- | --- |
| Plain `DurableObject`, `blockConcurrencyWhile` throws, **no console call** | exits 293 ms ✅ |
| Plain `DurableObject`, throw + post-throw SQL (LumenizeDO-shaped), no console call | exits 419 ms ✅ |
| Plain `DurableObject`, projects-based vitest config | exits ✅ |
| Plain `DurableObject`, 4 tests in file including healthy DOs around the broken one | exits 443 ms ✅ |
| Plain `DurableObject`, **+ `console.log(...)` inside the IIFE before throw** | **hangs >45 s** ❌ |
| Same, with `console.debug(JSON.stringify(...))` instead of `console.log` | hangs ❌ |
| Same trigger, without any try/catch wrapping the throw | hangs ❌ |
| `@lumenize/mesh` imported into bundle but only the plain-DO test runs (no console call) | exits ≈1 s ✅ |
| `LumenizeDO` subclass with thrown `onStart()` (which goes through LumenizeDO's `debug().error()` + rethrow) | hangs ❌ |
| Mesh's `OnStartErrorDO` (full mesh setup + worker bundle) | hangs ❌ |

So the trigger is the **combination of synchronous console output and a thrown rejection inside the same `blockConcurrencyWhile` IIFE**. `LumenizeDO` hits it because its catch handler does `log.error(...)` (`console.debug(JSON.stringify(...))`) and then rethrows. Any user-authored DO that logs before throwing inside `blockConcurrencyWhile` will hit the same hang under vitest-pool-workers.

The canonical minimum repro is ~22 LOC of source:

```typescript
// src/index.ts
import { DurableObject } from 'cloudflare:workers';
export class BrokenDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      console.log('emit anything before the throw to trigger the hang');
      throw new Error('Intentional throw in blockConcurrencyWhile');
    });
  }
  async getValue(): Promise<string> { return 'never-reached'; }
}
export default { async fetch() { return new Response('ok'); } } satisfies ExportedHandler<Env>;
```

Lives in [experiments/onstart-repro](../experiments/onstart-repro/), self-contained (no `@lumenize/*` deps, no swc, no decorators). README.md explains how to flip the trigger on/off.

**Mesh test SKIP comment updated** at [packages/mesh/test/lumenize-do.test.ts:90-96](../packages/mesh/test/lumenize-do.test.ts:90) to reflect the actual trigger ("console.* + throw inside the IIFE", not "broken DO leaves workerd in a bad state").

**Gist published** (flat layout, single npm install + npm test reproduces): https://gist.github.com/lmaccherone/e6f49cf2e7fa4a0cb9efe03a4b1c2feb

**Recommended issue title for cloudflare/workers-sdk**: *"@cloudflare/vitest-pool-workers hangs at teardown when a DO blockConcurrencyWhile IIFE both emits a `console.*` call and throws"*.

### Phase 3 — Issue filed

[cloudflare/workers-sdk#14180](https://github.com/cloudflare/workers-sdk/issues/14180)

### Workaround feasibility (tested 2026-06-04)

In the experiment, with `console.log` + `throw` inside `blockConcurrencyWhile`'s IIFE:

| Workaround | Result |
| --- | --- |
| `queueMicrotask(() => console.log(...))` then `throw` inside the IIFE | **still hangs** ❌ |
| `.catch(err => console.log(...))` chained on the Promise returned by `blockConcurrencyWhile` | **exits cleanly** ✅ |

So `queueMicrotask` does not dodge the trigger (the microtask runs before vitest considers the IIFE rejection settled). The viable shape is: do NOT catch inside the IIFE; let it reject; observe the rejection via `.catch()` on the returned Promise.

For `LumenizeDO`, this means restructuring `lumenize-do.ts`'s constructor from:

```typescript
ctx.blockConcurrencyWhile(async () => {
  if (this.onStart) {
    try { await this.onStart(); }
    catch (error) { log.error(...); throw error; }   // <— this catch is the hang trigger
  }
  // alarm recovery
});
```

to:

```typescript
ctx.blockConcurrencyWhile(async () => {
  if (this.onStart) await this.onStart();
  // alarm recovery
}).catch((error) => {
  log.error('LumenizeDO init failed', {...});
  // No rethrow — the input gate is already broken by the IIFE's rejection.
});
```

Net behavior identical from the user's standpoint (failures still log + bubble), but vitest teardown drains cleanly so the [propagates errors from onStart()](../packages/mesh/test/lumenize-do.test.ts:96) test can be un-skipped.

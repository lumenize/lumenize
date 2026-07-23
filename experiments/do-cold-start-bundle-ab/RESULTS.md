# Where does a Durable Object's ~1.5 s cold start go?

**Date:** 2026-07-22 · **Status:** headline question answered; two follow-ups open

## TL;DR

A fresh Durable Object in the Nebula worker costs **~1.5 s** before your code runs. It is
**not** the data plane, **not** the Nebula scope guards, **not** a Registry lookup, and **not**
a Galaxy/ontology hop — all four were measured and eliminated. It is:

| component | cost | notes |
|---|---:|---|
| irreducible fresh-DO creation | **~344 ms** | 130 KiB worker, no mesh/Gateway |
| **module instantiation of the worker's import graph** | **~847 ms** | paid per fresh DO, for code the call never touches |

The second number is the finding. A DO is not a separate deployment — its class is exported
from the Worker bundle, so **a new DO means a new isolate, and a new isolate must evaluate the
entire module graph before the constructor runs.**

## The controlled A/B (the load-bearing result)

Two workers deployed simultaneously, **identical but for one import**, measured **interleaved
with alternating order** so CF-side drift cannot load onto one arm. n=20 cold / 20 warm each.

| arm | bundle | `Worker Startup Time` | warm p50 | cold p50 | **cold − warm** |
|---|---:|---:|---:|---:|---:|
| light | 130 KiB | 5 ms | 40.2 ms | 383.8 ms | **343.6 ms** |
| heavy | 11,826 KiB | 579 ms | 34.4 ms | 1,224.7 ms | **1,190.3 ms** |

**heavy − light = 846.7 ms**, attributable to `import * as nebula from '@lumenize/nebula'`.

The **warm rows are the control that makes it airtight**: 40.2 vs 34.4 ms — the heavy arm is if
anything *faster* warm. The graph costs nothing once the isolate exists; it is purely a
per-fresh-DO cost. The effect is an order of magnitude above the ~55 ms noise floor.

## Create vs. wake — the ~847 ms is RECURRING, not one-time

Same two arms, four lifecycle states, both arms in lockstep per round (one idle wait serves
both), order alternating. n=8 rounds, 20 s idle.

| state | light p50 | heavy p50 | **heavy − light** |
|---|---:|---:|---:|
| create | 382.4 ms | 1,237.9 ms | **855.5 ms** |
| warm | 42.5 ms | 41.7 ms | **−0.8 ms** |
| hibernate-wake (20 s idle) | 111.0 ms | 1,567.7 ms | **1,456.7 ms** |
| eject-wake (`ctx.abort()`) | 309.2 ms | 608.3 ms | **299.1 ms** |

**`create` reproduces the A/B exactly** (855.5 vs 846.7 ms) — an independent replication.
**`warm` is −0.8 ms**, re-confirming the graph costs nothing once the isolate exists.

**The cost after idle is real and bundle-dependent:** the heavy arm pays ~1,228–1,568 ms on
its next request after 20 s idle, vs ~105 ms for light. So an idle tenant's next request is
expensive, and it scales with the bundle. That practical conclusion holds.

### ⚠️ CORRECTION: the *mechanism* is NOT module re-evaluation

A follow-up run instrumented the DO with two ids — `instanceId` (per DO construction) and
`isolateId` (module scope, so it survives DO reconstruction *within* an isolate) — to
**observe** the lifecycle state instead of inferring it from timing. n=10:

| arm | state | p50 | what actually happened |
|---|---|---:|---|
| light | create | 340.3 ms | create ×10 |
| light | warm | 40.0 ms | resident ×10 |
| light | hibernate-wake | 104.6 ms | **do-rebuilt ×10** |
| light | eject-wake | 564.8 ms | **do-rebuilt ×10** |
| heavy | create | 1,193.3 ms | create ×10 |
| heavy | warm | 40.8 ms | resident ×10 |
| heavy | hibernate-wake | 1,228.5 ms | **do-rebuilt ×8, isolate-rebuilt ×2** |
| heavy | eject-wake | 566.0 ms | **do-rebuilt ×10** |

Three things this settles, and one it opens:

1. **The eject-wake anomaly is real, not a measurement artifact.** All 20 eject-wakes are
   `do-rebuilt` — never `resident` — so `ctx.abort()` genuinely destroyed the instance before
   we measured. **`ctx.abort()` tears down the DO but leaves the ISOLATE resident.**
2. **eject-wake is bundle-INDEPENDENT: 564.8 (light) vs 566.0 ms (heavy).** Exactly what
   isolate-reuse predicts — with the module graph already evaluated, bundle size stops
   mattering. Clean confirmation.
3. **The earlier claim "waking fully re-pays module instantiation" was WRONG.** It rested on
   timing plus the bundle delta. The ids contradict it: in 8 of 10 heavy hibernate-wakes the
   module-scope state **survived**, so the graph was *not* re-evaluated — yet the call still
   cost ~1,228 ms.
4. **Open: why is heavy's post-idle wake expensive when the module graph was reused?** It is
   bundle-correlated but is *not* module evaluation. A heap snapshot/restore whose cost scales
   with retained memory would fit (module-scope state preserved, big heap slower to restore),
   but that is speculation — we have no evidence for the mechanism.

**Why this distinction matters practically:** if the post-idle cost tracks *retained heap*
rather than *parse/evaluate work*, then shrinking what the module graph **allocates and holds**
matters as much as shrinking what it parses — and the two are not the same lever.

## Corroboration across four independently-built workers

| worker | bundle | startup | cold − warm |
|---|---:|---:|---:|
| light arm (fetch→RPC) | 130 KiB | 5 ms | 344 ms |
| mesh-only `lumenize-mesh-browser-e2e` (Gateway+WS) | 232 KiB | 2–3 ms | ~490 ms |
| heavy arm (fetch→RPC) | 11.8 MB | 579 ms | 1,190 ms |
| real `nebula-browser-test` (Gateway+WS) | 13.8 MB | 647 ms | ~1,431 ms |

## What was eliminated first (the composition ladder)

Measured on the real Nebula worker via its marker-decomposed bench. Same client, same call
path; only the callee's composition varied:

| DO | composition | warm G-onward p50 | cold G-onward p50 | cold mean |
|---|---|---:|---:|---:|
| `Star` | NebulaDO + data plane | 18.6 ms | 1,448.5 ms | 1,541.5 ms |
| `NebulaEchoDO` | NebulaDO, no data plane | 18.7 ms | 1,508.0 ms | 1,538.9 ms |
| `MeshEchoDO` | bare `LumenizeDO` | 9.8 ms | 1,760.6 ms | 1,610.1 ms |

Cold means are statistically indistinguishable — **stripping the data plane and then the
Nebula guards saved nothing.** The warm column proves the instrument *could* resolve
composition differences (9.8 vs 18.6 ms), so the cold null is real, not insensitivity.
Every rung shared one worker bundle, which is what pointed at the bundle as the variable.

Also eliminated earlier, by static trace: a cold `echo` touches **no** Registry/Galaxy/
singleton DO. All identity/scope decisions read in-memory JWT claims or local storage.

## Negative result worth keeping: synthetic weight failed

A first attempt varied *synthetic* generated module weight instead of a real import. It was
**inconclusive and nearly produced a false positive**:

| units | startup | cold − warm |
|---:|---:|---:|
| 0 (run 1) | 2 ms | 490.5 ms |
| 0 (run 2) | 3 ms | 545.7 ms |
| 2,000 | 33 ms | 497.7 ms |
| 8,000 | 143 ms | 681.0 ms |
| 20,000 | 505 ms | timed out |

The 2,000 dose landed *below* the 0 dose, and repeat runs of the identical bundle differed by
55 ms. Pairing 0 with 8,000 alone would have "shown" a clean 1:1 relationship — cherry-picking.
Three flaws: too few iterations against high variance; sequential blocks so drift confounded
dose; and repetitive generated classes (5.4 MB → 434 KiB gzip) don't model heterogeneous real
library init. **Lesson: use the real import, deploy both arms at once, and interleave.**

A second false start: the "heavy" arm first imported only `isomorphic-git` +
`@cloudflare/shell` (named in the nebula wrangler comment) and produced just 575 KiB / 27 ms —
a 20 ms delta that would have tested nothing. The weight is elsewhere in the barrel; **typia/tsc
and the agents SDK are the untested suspects.**

## Honest limits

- The A/B workers use `fetch`→raw RPC, not the Gateway/WS/mesh path. **Compare the deltas, not
  the absolutes.**
- The heavy arm reproduces 86% of the real graph (11.8 of 13.8 MB).
- This proves the graph *as a whole* causes it; it does **not** decompose which parts dominate.
- `Worker Startup Time` is a leading indicator, not the exact toll (579 ms reported vs ~847 ms
  measured) — real per-isolate cost under load ran higher.
- Whether Cloudflare amortizes *parse/compile* across isolates on a machine isn't observable
  from outside. What cannot be shared is **evaluation**: each isolate builds its own objects.

## Open questions

1. ~~Creation vs. wake~~ **ANSWERED above: wake re-pays it.** Remaining sub-questions: why
   `eject-wake` beat `hibernate-wake`, and directly *observing* hibernated-vs-evicted (via WS
   survival) rather than inferring from timing. Both want a higher-n run.
2. **Which part of the 13.8 MB dominates?** Bisect the barrel before doing import surgery.
   Now the highest-value follow-up, since the cost is recurring rather than one-time.
   `isomorphic-git` + `@cloudflare/shell` were measured at only 575 KiB / 27 ms, so the weight
   is elsewhere — typia/tsc and the agents SDK are the untested suspects.

## Reproduce

```
npm run deploy      # deploys both arms
npm run bench       # interleaved A/B
```

Deployed workers: `do-cold-start-light`, `do-cold-start-heavy`.

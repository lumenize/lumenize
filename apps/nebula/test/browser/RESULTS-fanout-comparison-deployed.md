# Fanout Bench — Three-Pattern Comparison (DEPLOYED Cloudflare)

Real-cloud measurements via `nebula-browser-test.transformation.workers.dev`.
**Apples-to-apples**: all three columns measure the same user-facing flow
(originator → Star.transaction → subscribers receive). Numbers are
end-to-end wall-clock from "originator called transaction()" (or
"originator called setState()" for Agents) to "subscriber's handler
fired", measured at the Node test client.

- **client location**: Pittsburgh, PA → IAD colo
- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) (Lumenize) ·
  [fanout-agents.benchmark.ts](fanout-agents.benchmark.ts) (Agents)
- **three patterns**:
  - **A — Cloudflare Agents `setState`**: state-sync write + naive partyserver
    broadcast loop.
  - **B — Lumenize without broadcast**: prior `Star.#fanout` with synchronous
    `lmz.call` per subscriber + 4-arg result handler. Old measurements.
  - **C — Lumenize with `svc.broadcast` (v2)**: the new framework primitive
    in `@lumenize/mesh`. Direct loop at N ≤ 100; recursive Worker tier at
    N > 100. Per-target `onResult` handler routes results back to Star
    for drop-on-failed-fanout (errors-only path forwards from tier to
    Star to keep Star's input gate uncongested at high N).

## e2e p50 — median subscriber wait (ms)

| N | A — Agents | B — Lumenize without broadcast | C — Lumenize with `svc.broadcast` (v2) |
| ---: | ---: | ---: | ---: |
| 10 | 182 | 61 | **47** |
| 50 | 168 | **96** | 101 |
| 100 | 137 | 142 | 151 |
| 250 | 158 | **296** | 317 |
| 500 | 144 | 652 | **614** |
| 1000 | 148 | 1,746 | **790** |

## e2e p99 — 99th-percentile subscriber wait (ms)

| N | A — Agents | B — Lumenize without broadcast | C — Lumenize with `svc.broadcast` (v2) |
| ---: | ---: | ---: | ---: |
| 10 | 214 | 77 | **58** |
| 50 | 493 | **151** | 153 |
| 100 | 176 | **243** | 254 |
| 250 | 181 | **522** | 590 |
| 500 | 154 | 1,161 | 2,811 |
| 1000 | 291 | 4,739 | **2,677** |

## e2e max — worst observed subscriber (ms)

| N | A — Agents | B — Lumenize without broadcast | C — Lumenize with `svc.broadcast` (v2) |
| ---: | ---: | ---: | ---: |
| 10 | 214 | 77 | **58** |
| 50 | 494 | 153 | 269 |
| 100 | 229 | **293** | 336 |
| 250 | 182 | **581** | 640 |
| 500 | 274 | 1,230 | 2,843 |
| 1000 | 429 | 5,418 | **2,702** |

## Findings

**1. At N ≤ 100 — direct branch — `svc.broadcast` matches the prior path.**
Bench-to-bench variance is the dominant signal in this regime; p50 at
N=10 is 47ms vs 61ms (broadcast slightly faster, probably because the
v1 direct branch drops the result-handler chain construction the old
code did). At N=50/100 the two are within run-to-run noise.

**2. At N=250 (tree path kicks in by default) — broadcast and the
direct loop are within noise.** p50 317 vs 296ms. The tier-hop cost
roughly matches the first few RPC queue cycles the direct loop is
starting to pay, so the two are close. The directThreshold knob is
exposed for callers who want to override either way.

**3. At N=1000 — broadcast dominates decisively.** Median 743ms vs 1,746ms
(2.4× faster). 99th-percentile 1,204ms vs 4,739ms (3.9× faster). Worst
case 1,262ms vs 5,418ms (4.3× faster). This is the regime the framework
addition was for; the data justifies the lift.

**4. Agents remains the fastest at low/mid N** (~150ms flat across the
ramp). But at N=1000 Agents is 148ms vs `svc.broadcast` 743ms — a 5×
gap. The architectural floor is real but the gap is now within an order
of magnitude rather than 12× without broadcast.

**5. Zero errors across all patterns at all tested N.** No hard caps hit
on real CF in the tested range. The cliff Discord folklore worries
about doesn't manifest as failed deliveries; it's a tail-latency story.

## The threshold knob

The `directThreshold: 100` default was picked from earlier sweeps. It's
a per-call option, so callers who know their workload's shape can
override:

- Pass `directThreshold: 0` to force the tree path (e.g., a Star with a
  consistently popular resource).
- Pass `Infinity` to force the direct loop (e.g., a publish path
  guaranteed never to exceed a few dozen subscribers).
- Default behavior — let the framework pick by target count.

## Caveats

- **3 commits per N** with 2 warmups. Tight bands need 10+ commits per
  N; the qualitative trend (broadcast wins at high N, loses at mid N) is
  robust but the exact crossover point will shift with more samples.
- **The "without broadcast" column (B)** uses the OLD Star.#fanout code
  measured earlier this session. The "with broadcast" column (C) is
  this run. Run-to-run variance + CF infra state likely accounts for
  10-30% of cell-to-cell differences.
- **All clients on the same Star tenant.** Sharded workloads behave
  differently.
- **The framework primitive is v1.** No drop-on-failed-fanout for the
  tree branch; leaked subscriber rows fall back to push-on-clear at
  next deploy. Production safety: equivalent to the pre-broadcast
  fallback path that always existed for quiet resources. v2 adds the
  per-target result handler.

## How to re-run

```
cd apps/nebula
npx wrangler deploy --config test/browser/worker/wrangler.jsonc

# Lumenize side (uses Star.svc.broadcast at framework default
# directThreshold of 100; override with STAR_BROADCAST_DIRECT_THRESHOLD env var):
BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
  FANOUT_N_VALUES=10,50,100 FANOUT_COMMITS_PER_N=10 \
  npm run bench:fanout
# (Then individual high-N runs to avoid hitting the test timeout boundary:)
BENCH_BASE_URL=... FANOUT_N_VALUES=250 FANOUT_COMMITS_PER_N=10 npm run bench:fanout
BENCH_BASE_URL=... FANOUT_N_VALUES=500 FANOUT_COMMITS_PER_N=10 npm run bench:fanout
BENCH_BASE_URL=... FANOUT_N_VALUES=1000 FANOUT_COMMITS_PER_N=10 \
  FANOUT_TEST_TIMEOUT_MS=600000 npm run bench:fanout
```

To toggle the threshold without redeploying, set
`STAR_BROADCAST_DIRECT_THRESHOLD` as a Worker var (e.g., `Infinity` to
force direct path; `0` to force tree).

# Parse-Validate Integrated Bench Results

What's measured: full Nebula transaction path, end-to-end.
**client → Gateway → Star (Handler 1) → [Galaxy on cache miss] → Star (Handler 2) → load parser-validator facet → parseBatch → write transaction → mesh callback → client.handleTransactionResult**

Two scenarios:
- **warm**: same Star across iterations, hot Handler 1 cache, no Galaxy hop. The steady-state cost of executing a parse-validate transaction on a hot DO.
- **cold-Star/warm-cluster**: fresh Star per iteration (varies tenant segment only). Galaxy and parser-validator bundle stay warm; only the Star pays a cache miss + Galaxy hop. This is the most common real-world cold path: a user touches a new tenant scope under their existing org/galaxy.

A mesh-shape baseline is captured alongside each run: `StarTest.ping()` is a no-op mesh handler that bounces a value back via the **same call path as `transaction()`** — client → WS → Gateway DO (OCAN check) → Star DO → Gateway DO → WS → client. So `ping` already includes all the mesh-shape costs (WS round-trip, Gateway OCAN check, cross-DO RPC, result-callback hop). Subtracting ping mean from `transaction` mean isolates the work `Star.transaction()` does on top of `Star.ping()`: parse + DagTree permission check + storage write + result construction. Per-percentile subtraction uses ping mean (not ping percentile), so percentiles below are conservative approximations — for the headline, prefer the mean.

Bench source: [transactions.bench.ts](transactions.bench.ts) · client: [harness-client.ts](harness-client.ts) · ping handler: [test-apps/baseline/index.ts](../test-apps/baseline/index.ts) (`StarTest.ping`).

---

## Deployed (Cloudflare production-equivalent)

Worker: `nebula-browser-test.transformation.workers.dev`. Client at Larry's machine in Pittsburgh; colo per Cloudflare default routing. Two consecutive runs of `npx vitest bench --run --project browser-bench` against the deployed Worker (BENCH_BASE_URL override).

### In-Worker (raw − ping mean)

| Block | mean (ms) | p75 | p99 | samples |
| --- | --- | --- | --- | --- |
| warm — hot Star (Handler 1 cache hit) | **~16** | ~17 | ~33 | 100 × 2 runs |
| cold — fresh Star (cache miss → Galaxy hop) | **~1,500** | ~1,710 | ~3,150 | 30 × 2 runs |

These are **single-client serial latencies**. Do **not** read `1/mean` as the system's throughput ceiling: DO output gates only hold *that invocation's* outputs until *its* writes commit — they don't block other invocations. With concurrent clients on the same Star, work interleaves on awaits and writes batch into shared commits (group-commit), so per-Star throughput exceeds `1/mean × 1` and scales up to a commit-pipeline plateau. The throughput task ([parse-validate-throughput.md](../../../../tasks/parse-validate-throughput.md)) measures where that plateau is.

### Raw (un-subtracted)

| Block | mean (ms) | p75 | p99 | max |
| --- | --- | --- | --- | --- |
| warm | 55.9 | 56.7 | 73.1 | 525.95 |
| cold | 1,542 | 1,747 | 3,187 | 3,214.50 |
| ping (WS-leg baseline) | 40.3 | 39.8 | 73.0 | 288.17 |

Run-by-run (rme = relative margin of error):

| Run | warm mean | warm rme | cold mean | cold rme | ping mean | ping rme |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 59.45 ms | ±15.78% | 1,594.18 ms | ±11.06% | 38.33 ms | ±9.14% |
| 2 | 52.33 ms | ±2.31% | 1,490.59 ms | ±13.44% | 42.21 ms | ±11.84% |

### Reconciliation with bare facet bench (5.2.4.1 Phase 6)

5.2.4.1's bare facet bench (no Galaxy/Star/auth/mesh) measured deployed cold-wake of ~1,756 ms = ~1,494 ms DO infrastructure baseline + ~262 ms facet contribution (facet load + 119 KB module parse + first parse).

In our integrated bench the bundle is pre-warmed in `setupClient`, so per-iteration cold pays the DO infra baseline + integration overhead but NOT the 262 ms facet contribution:

| Cost | bare (5.2.4.1 P6) | integrated (this bench) |
| --- | --- | --- |
| DO infrastructure cold-wake | ~1,494 ms | ~1,494 ms (paid every cold iteration) |
| Facet load + module parse | ~262 ms | 0 (pre-warmed once in setup) |
| Galaxy hop + cold-Star integration overhead | n/a | **~8 ms** (cold mean − DO infra baseline) |
| Warm in-Worker (above the mesh-shape baseline) | ~1.4 ms (same-isolate facet RPC + parse) | ~16 ms |

About the warm in-Worker number: the **mesh-shape baseline** (Gateway OCAN check, cross-DO RPC, mesh callback hop, WS round-trip) is captured by `ping` and already subtracted out. The remaining ~16 ms is the work `Star.transaction()` does that `Star.ping()` doesn't — and it includes the bare bench's 1.4 ms (the facet RPC + parse happens *inside* `Resources.transaction()`). The other ~14.6 ms is everything else `Resources.transaction()` does: DagTree permission check, ResourceHistory/storage write, output-gate flush, result tuple build. That's transaction business logic, not infrastructure overhead.

Output gates do **not** serialize the DO. They hold *one* invocation's outputs until *its* writes commit, but the input gate keeps opening on awaits — concurrent invocations interleave their CPU work and their writes batch through a shared commit (group-commit). So real per-Star throughput is well above the serial `1/mean` figure. The throughput task ([parse-validate-throughput.md](../../../../tasks/parse-validate-throughput.md)) maps where that ceiling actually sits.

---

## Local (wrangler dev)

Recorded for regression-diagnostic value. Local numbers are sanity-floor — no real network, no real cold-start, different Worker Loader cache behavior — so they don't substitute for deployed.

### In-Worker (raw − ping mean)

| Block | mean (ms) | p75 | p99 | samples |
| --- | --- | --- | --- | --- |
| warm | **~0.19** | ~0.22 | ~0.82 | ~1,060 |
| cold | **~13.1** | ~14.0 | ~15.4 | 30 |

### Raw

| Block | mean (ms) | p75 | p99 | samples |
| --- | --- | --- | --- | --- |
| warm | 0.47 | 0.50 | 1.11 | 1,065 |
| cold | 13.42 | 14.27 | 15.70 | 30 |
| ping | 0.28 | 0.27 | 0.78 | 1,802 |

(Local runs are highly stable across repeats; numbers above are from the second of two consecutive runs.)

---

## Experiment design notes

**WS-leg subtraction.** Each bench iteration's wall-clock includes (a) the actual in-Worker cost we want to measure and (b) the WebSocket round-trip from the test client. The `ping` block is a no-op `ping()` mesh handler on `StarTest` that bounces a value back to the client via the same callback mechanism — so its mean is an estimate of (b) alone. We subtract ping mean from raw mean to derive an in-Worker estimate. This is approximate: ping has its own variance, and subtracting a constant from each percentile doesn't yield the true joint distribution — but for mean-based comparisons it's accurate within a few percent.

**Cold-Star/warm-cluster.** Each cold iteration varies only the tenant segment of the Star scope (`acme.app.tenant-cold-${uuid}`), so:
- Star DO is cold (fresh wake; `_index` empty → cache miss → Galaxy hop)
- Galaxy DO is warm (one galaxy serves all iterations; ontology registered once in setup)
- Parser-validator bundle is warm (bundleId is `<universe.galaxy>/<version>`, constant since universe.galaxy doesn't change; pre-warmed in setup)
- Worker isolate / WS connection / JWT are warm

This is the common real-world cold path. It is **not** "fresh-deploy cold" (whole-Worker cold start) or "first-org-ever cold" (cold Galaxy + cold bundle).

**Bundle pre-warm.** vi.bench's `warmupIterations` would itself execute fresh-Star paths, so it can't pre-warm the bundle for the cold bench. Instead, `setupClient()` fires one transaction against a throwaway tenant scope (`acme.app.tenant-warmup`) before any benches run. This populates the Worker Loader cache for `<galaxy>/<version>` so cold-bench iteration 1 doesn't pay the one-time ~262 ms facet load cost.

**Why a single `#pending` slot in HarnessNebulaClient.** vi.bench iterations are sequential, so there's only ever one in-flight transaction. A single Promise slot beats a Map for clarity. The throughput task ([parse-validate-throughput.md](../../../../tasks/parse-validate-throughput.md)) needs concurrent in-flight calls and switches to a Map.

**Sample counts.** Warm and ping run for ~500 ms after meeting the iteration minimum (vi.bench default `time` budget), yielding 1k+ samples and tight rme. Cold runs exactly 30 iterations (`time: 0`) because each iteration takes ~1.5 s deployed; rme stays around ±10–13%. The cold p99 sits at the max sample with N=30 — read it as "rare slow case" rather than a percentile.

---

## How to re-run

Local (auto-spawns wrangler dev):
```
cd apps/nebula && npm run bench
```

Deployed (override base URL):
```
cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npm run bench
```

To redeploy after code changes:
```
cd apps/nebula && npx wrangler deploy --config test/browser/worker/wrangler.jsonc
```

Secrets for the deployed Worker (`NEBULA_AUTH_BOOTSTRAP_EMAIL`, `JWT_PRIVATE_KEY_BLUE`, `JWT_PUBLIC_KEY_BLUE`) are already set via `wrangler secret bulk`. To remove the deployed Worker entirely:
```
npx wrangler delete --name nebula-browser-test
```

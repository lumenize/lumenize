# Parse-Validate Integrated Bench Results

What's measured: full Nebula transaction path, end-to-end.
**client → Gateway → Star (Handler 1) → [Galaxy on cache miss] → Star (Handler 2) → load parser-validator facet → parseBatch → write transaction → mesh callback → client.handleTransactionResult**

Two scenarios:
- **warm**: same Star across iterations, hot Handler 1 cache, no Galaxy hop. The steady-state cost of executing a parse-validate transaction on a hot DO.
- **cold-Star/warm-cluster**: fresh Star per iteration (varies tenant segment only). Galaxy and parser-validator bundle stay warm; only the Star pays a cache miss + Galaxy hop. This is the most common real-world cold path: a user touches a new tenant scope under their existing org/galaxy.

A mesh-shape baseline is captured alongside each run: `StarTest.ping()` is a no-op mesh handler that bounces a value back via the **same call path as `transaction()`** — client → WS → Gateway DO (OCAN check) → Star DO → Gateway DO → WS → client. So `ping` already includes all the mesh-shape costs (WS round-trip, Gateway OCAN check, cross-DO RPC, result-callback hop). Subtracting ping from `transaction` isolates the work `Star.transaction()` does on top of `Star.ping()`: parse + DagTree permission check + storage write + result construction.

**Decomposed measurement (2026-05-05):** [`transactions.benchmark.ts`](transactions.benchmark.ts) decomposes each call's wall clock into **WS hop client↔Gateway** + **Gateway-onward** via the `bench_marker` frame emitted by [`InstrumentedNebulaClientGateway`](worker/instrumented-nebula-client-gateway.ts) — see [`tasks/gateway-hop-benchmark.md`](../../../../tasks/gateway-hop-benchmark.md). The marker's emit point is `onBeforeCallToMesh` (synchronous, before the Workers RPC dispatch to Star). The Node test client timestamps the marker frame's arrival via `performance.now()`. Subtracting two arrival times measured over the same WS connection cancels out the Gateway-to-client one-way (it appears in both), leaving the Cloudflare-side time difference between the two `ws.send()` call sites — no Cloudflare clock involved.

Bench source: [transactions.benchmark.ts](transactions.benchmark.ts) · client: [harness-client.ts](harness-client.ts) · Gateway subclass: [worker/instrumented-nebula-client-gateway.ts](worker/instrumented-nebula-client-gateway.ts) · ping handler: [test-apps/baseline/index.ts](../test-apps/baseline/index.ts) (`StarTest.ping`).

---

## Deployed (Cloudflare production-equivalent)

Worker: `nebula-browser-test.transformation.workers.dev`. Client at Larry's machine in Pittsburgh; colo per Cloudflare default routing. Three consecutive runs of `npm run bench` against the deployed Worker (BENCH_BASE_URL override) on 2026-05-05.

### Decomposed latency (p50 across 3 runs)

| Block | WS hop client↔Gateway | Gateway-onward | end-to-end | samples |
| --- | ---: | ---: | ---: | ---: |
| ping (no-op handler) | **~28 ms** | ~12 ms | ~41 ms | 100 × 3 runs |
| warm transaction (hot Star) | **~29 ms** | ~30 ms | ~58 ms | 100 × 3 runs |
| cold transaction (fresh Star, cache miss + Galaxy hop) | **~28 ms** | ~1,255 ms | ~1,279 ms | 30 × 3 runs |

**Why p50 not mean**: at fast operations (gateway-onward < ~20 ms), TCP-level packet coalescence sometimes batches the marker frame and the response frame into one segment. When that happens, both arrive at Node within microseconds of each other, inflating `WS hop` and deflating `Gateway-onward` for that iteration. End-to-end is unaffected. Coalescence is bounded — across 100 iterations the median is robust; means can drift 25–50% between runs depending on how often coalescence happens. Cold transactions (>1 s gateway-onward) are well clear of coalescence and show stable means.

### Cross-block readings

The methodology check: **WS hop is the same shape across all three blocks** (~28 ms p50, regardless of what the Gateway does next). It's the client↔Gateway round trip, independent of the work behind it. Stable across blocks ↔ trustworthy decomposition.

- **Gateway-onward for ping (~12 ms)** = Workers RPC × 2 between Gateway and Star + Star-side fire-and-forget callback dispatch + the callback's own Workers RPC + Gateway processing for INCOMING_CALL + Gateway-to-client WS one-way (which cancels in the subtraction). For a no-op handler, the Star-side work is microseconds; the rest is mesh-shape overhead.
- **Warm transaction Gateway-onward (~30 ms) − ping Gateway-onward (~12 ms) = ~18 ms** is the work `Star.transaction()` does on top of `Star.ping()`: parse-validate + DagTree permission check + ResourceHistory/storage write + result construction. Matches the previously-reported "in-Worker" estimate of ~16 ms.
- **Cold Gateway-onward (~1,255 ms) − warm Gateway-onward (~30 ms) = ~1,225 ms** is the cache-miss + Galaxy hop + DO cold-wake. Compatible with the bare facet bench's ~1,494 ms DO infra baseline (5.2.4.1 P6) within run-to-run variance — the integrated bench pre-warms the bundle so we don't pay the additional ~262 ms facet-load cost.

### End-to-end (sanity check vs prior runs)

| Block | new bench (p50) | old bench (mean) |
| --- | ---: | ---: |
| ping | ~41 ms | 40.3 ms |
| warm | ~58 ms | 55.9 ms |
| cold | ~1,279 ms | 1,542 ms |

End-to-end p50 of the decomposed bench matches the old vi.bench mean within noise. The new bench replaced [`transactions.bench.ts`](https://github.com/lumenize/lumenize) (vi.bench-based, single-number per block) on 2026-05-05 because vi.bench couldn't accommodate per-call hop decomposition.

These are **single-client serial latencies**. Do **not** read `1/mean` as the system's throughput ceiling: DO output gates only hold *that invocation's* outputs until *its* writes commit — they don't block other invocations. With concurrent clients on the same Star, work interleaves on awaits and writes batch into shared commits (group-commit), so per-Star throughput exceeds `1/mean × 1` and scales up to a commit-pipeline plateau. See the throughput bench ([THROUGHPUT-RESULTS.md](THROUGHPUT-RESULTS.md)).

### Reconciliation with bare facet bench (5.2.4.1 Phase 6)

5.2.4.1's bare facet bench (no Galaxy/Star/auth/mesh) measured deployed cold-wake of ~1,756 ms = ~1,494 ms DO infrastructure baseline + ~262 ms facet contribution (facet load + 119 KB module parse + first parse).

The integrated bench pre-warms the bundle in setup, so per-iteration cold pays the DO infra baseline + integration overhead but NOT the 262 ms facet contribution:

| Cost | bare (5.2.4.1 P6) | integrated (this bench, decomposed) |
| --- | --- | --- |
| DO infrastructure cold-wake | ~1,494 ms | ~1,225 ms (cold gateway-onward − warm gateway-onward) |
| Facet load + module parse | ~262 ms | 0 (pre-warmed once in setup) |
| Warm in-Worker work (transaction beyond mesh-shape) | ~1.4 ms (same-isolate facet RPC + parse) | ~18 ms (warm gateway-onward − ping gateway-onward) |

About the warm in-Worker number: the **mesh-shape baseline** (Workers RPC × 2 between Gateway and Star, mesh callback hop, Gateway-side processing) is captured by `ping`'s gateway-onward and subtracted out. The remaining ~18 ms is the work `Star.transaction()` does that `Star.ping()` doesn't — and it includes the bare bench's 1.4 ms (the facet RPC + parse happens *inside* `Resources.transaction()`). The other ~16.6 ms is everything else `Resources.transaction()` does: DagTree permission check, ResourceHistory/storage write, output-gate flush, result tuple build. Transaction business logic, not infrastructure overhead.

The cold-wake number drifts run-to-run by ~20% (1,225 ± 250 ms across runs) because cold starts include Cloudflare-side scheduling that varies. Mean and p99 of the cold block can have multi-second tails (one 12-second outlier observed in 30 iterations). The bare-bench's tighter ~1,494 ms number had different runtime conditions.

Output gates do **not** serialize the DO. They hold *one* invocation's outputs until *its* writes commit, but the input gate keeps opening on awaits — concurrent invocations interleave their CPU work and their writes batch through a shared commit (group-commit). So real per-Star throughput is well above the serial `1/mean` figure. The throughput bench ([THROUGHPUT-RESULTS.md](THROUGHPUT-RESULTS.md)) maps where that ceiling actually sits.

---

## Local (wrangler dev)

Recorded for regression-diagnostic value. Local numbers are sanity-floor — no real network, no real cold-start, different Worker Loader cache behavior — so they don't substitute for deployed.

The deployed numbers above are the canonical decomposed measurements; local numbers will be re-captured the next time `npm run bench` is invoked without `BENCH_BASE_URL`. The auto-generated [`RESULTS-local.md`](RESULTS-local.md) (gitignored) holds the latest local run.

---

## Experiment design notes

**Marker decomposition.** The `bench_marker` frame is emitted from [`InstrumentedNebulaClientGateway.onBeforeCallToMesh`](worker/instrumented-nebula-client-gateway.ts) — synchronously, *before* `await stub.__executeOperation(envelope)`. The Phase 0 spike ([`flush-spike.benchmark.ts`](flush-spike.benchmark.ts), 2026-05-05) confirmed that `ws.send()` from inside a DO invocation flushes mid-invocation rather than queuing until invocation end. The Node test client timestamps every inbound frame; subtracting two arrival times measured over the same WS connection cancels the unmeasurable Gateway-to-client one-way (it appears in both), leaving a Cloudflare-side time difference between the two `ws.send()` call sites. No Cloudflare clock involved.

**Why p50, not mean.** TCP-level packet coalescence sometimes batches the marker frame and the response frame into one TCP segment when the Gateway-onward time is small (< ~20 ms — within the typical TCP delayed-ACK window). When that happens, both arrive at Node within microseconds of each other, inflating WS-hop and deflating Gateway-onward for that iteration. End-to-end is unaffected. Across 100 iterations the median is robust; the mean drifts run-to-run because the *fraction* of coalesced iterations varies. Cold-block iterations (>1 s gateway-onward) don't suffer from this — they're well clear of the coalescence window.

**Cold-Star/warm-cluster.** Each cold iteration varies only the tenant segment of the Star scope (`acme.app.tenant-cold-${uuid}`), so:
- Star DO is cold (fresh wake; `_index` empty → cache miss → Galaxy hop)
- Galaxy DO is warm (one galaxy serves all iterations; ontology registered once in setup)
- Parser-validator bundle is warm (bundleId is `<universe.galaxy>/<version>`, constant since universe.galaxy doesn't change; pre-warmed in setup)
- Worker isolate / WS connection / JWT are warm

This is the common real-world cold path. It is **not** "fresh-deploy cold" (whole-Worker cold start) or "first-org-ever cold" (cold Galaxy + cold bundle).

**Bundle pre-warm.** A single transaction against a throwaway tenant scope (`acme.app.tenant-warmup`) runs in setup before any measured iterations. This populates the Worker Loader cache for `<galaxy>/<version>` so cold-bench iteration 1 doesn't pay the one-time ~262 ms facet load cost.

**Per-callId marker correlation.** [`HarnessNebulaClient`](harness-client.ts) keeps a `Map<callId, markerArrival>` that's populated by `onUnknownMessage` (capturing every `bench_marker` frame's `performance.now()` arrival) and consumed by `callStarTransaction` / `callStarPing` / `callStarDelay`. The harness threads `callId` from the outbound message via `CallOptions.onSent` (added to the public mesh API as part of this work). Sequential and concurrent in-flight calls both work — the throughput bench can adopt the same plumbing.

**Sample counts.** 100 iterations for ping and warm, 30 for cold (each cold iteration takes ~1.5 s, so larger counts trade depth for run time). The bench is `it()`-based (not `vi.bench`) — see the file header in [`transactions.benchmark.ts`](transactions.benchmark.ts) for why.

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

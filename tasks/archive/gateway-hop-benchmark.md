# Gateway Hop Benchmarking

**Status (2026-05-05)**: **Phases 0–6 complete; Phase 5b skipped (decided not load-bearing).** Latency decomposition (~12 ms Gateway hop cost in same DC), throughput direction (~14% peak gain from M-Gateway fanout), and cross-region Workers RPC RT (~8 ms same-DC, ~101 ms cross-Atlantic) all measured. gateway.mdx updated with citable numbers. Methodology post 2d is fully unblocked. Remaining: publish 2d, optionally Phase 7 (follow-up post).

**Depends on**: Existing bench harness from [parse-validate-release.md](./archive/parse-validate-release.md) Phase 1:
- [`apps/nebula/test/browser/`](../apps/nebula/test/browser/) — `transactions.bench.ts` (single-call latency), `throughput.benchmark.ts` (concurrent ramp), `harness-client.ts` (Node-side client → real WebSockets → deployed Worker pattern + ping subtraction)
- Auto-spawned `wrangler dev`, magic-link auth bootstrap, `Browser`-based harness
- Deployed Worker `nebula-browser-test.transformation.workers.dev` + `BENCH_BASE_URL` override

**Related**:
- [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) — methodology post; Ping baseline section explicitly gestures at this task as the "next rung up"
- [tasks/archive/parse-validate-throughput.md](./archive/parse-validate-throughput.md) — sibling throughput-measurement project (per-Star saturation)
- [website/docs/mesh/gateway.mdx](../website/docs/mesh/gateway.mdx) — documents intra-datacenter hops typically <10 ms but cross-region can be several hundred ms

## Objective

Quantify **two** numbers for the 1:1 Gateway architecture vs hypothetical Client→DO direct:

1. **Per-call latency cost** — how much round-trip time the Gateway adds (Phase 3)
2. **Peak per-DO throughput effect** — does the Gateway raise, lower, or break even the per-DO throughput ceiling? (Phase 5)

Latency direction is obvious (more hops → more latency). Throughput direction is **not** obvious — and is the more interesting question.

### Why throughput direction isn't obvious

More hops add queues, and queues can *improve* throughput when an upstream stage offloads serial work from the bottleneck. Specifically:

- The Gateway does OCAN checks + routing on its own DO, sparing the parent DO's ~2.5 ms serial CPU floor (see [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) for the floor measurement).
- With 1:1 Gateway architecture, auth work for N clients runs across N concurrent Gateway DOs (independent serial CPUs) instead of serially on the parent DO.

So the Gateway could plausibly cost latency per call but *win* on peak per-DO throughput. Could also break even or lose. Direction is empirical.

**Important harness implication**: testing the throughput-direction hypothesis requires **M concurrent authenticated clients** (each with its own Gateway DO via distinct `tabId`), not the existing "one client × N in-flight" pattern. The current `throughput.benchmark.ts` saturates a single Gateway's input gate, which can't observe the cross-Gateway parallelism that's central to the hypothesis. See Phase 4.

## Instrumentation strategy: push-frame markers, Node-side timestamps

Cloudflare clocks are unreliable inside the Worker (`Date.now()` and `performance.now()` are pinned to invocation start — see methodology link). The reliable measurement surface is the Node.js test client. To decompose latency without trusting Cloudflare time:

- Gateway emits a marker WS frame at known points in its handling lifecycle. Frame *content* doesn't matter; the **arrival time at the Node client** is the measurement.
- Node client timestamps every inbound frame via `performance.now()`.
- Deltas between frame arrivals received over the same WS connection cancel out the Gateway-to-client one-way (it appears equally in both arrivals), leaving the Cloudflare-internal time difference between the two `ws.send()` call sites.

**Simplest decomposition** (one marker emitted at Gateway entry, before forwarding to Star):
- `tMarker − t0_send` = client→Gateway round trip (≈ existing ping baseline)
- `tResponse − tMarker` = Gateway→Star→Star_proc→Star→Gateway internal cost (the **headline gateway-hop cost**)
- `tResponse − t0_send` = end-to-end (already measured)

The instrumentation lives in a test-only `InstrumentedNebulaClientGateway extends NebulaClientGateway` in [`apps/nebula/test/browser/worker/`](../apps/nebula/test/browser/worker/), bound only in the bench Worker. Production [`NebulaClientGateway`](../apps/nebula/src/nebula-client-gateway.ts) stays untouched.

## Phase 0: Spike — verify `ws.send()` mid-invocation flush behavior ✅ COMPLETE (2026-05-05)

**Result**: `ws.send()` flushes mid-invocation. Two deployed runs of [`flush-spike.test.ts`](../apps/nebula/test/browser/flush-spike.test.ts) at DELAY_MS=200, 30 iterations each, gave `responseArrival − markerArrival`: run 1 mean 259 ms / p50 277 ms / min 63 ms / max 385 ms; run 2 mean 246 ms / p50 239 ms / min 196 ms / max 306 ms. Min ~196 ms is essentially the DELAY_MS floor; the entire distribution sits at or above DELAY_MS. If the marker were held until invocation end, all values would cluster near 0 ms. Marker-from-hook design works as planned. Phase 2 builds directly on the `InstrumentedNebulaClientGateway` + `BENCH_MARKER` plumbing already in place.

**Goal**: Confirm that `ws.send()` from inside a DO invocation actually flushes to the wire at the call site, rather than queuing until invocation end (or until output gates clear).

**Why first**: The whole instrumentation strategy assumes a marker emitted *before* an `await` is observable at the client *before* the response that follows the await. If Cloudflare batches WS outputs to invocation end, marker-then-await-then-response collapses to a single arrival and the entire decomposition design fails.

We have indirect evidence flushes happen across invocations (`handleTransactionResult` arrives separately from any synchronous CALL response, so cross-invocation flush works). What we don't have is direct evidence about *intra-invocation* flush across an `await`. `ws.send()` is synchronous from JS's perspective, but the underlying Cloudflare WS implementation may defer wire-level flush.

**Approach**: build the spike in the real bench stack ([`apps/nebula/test/browser/`](../apps/nebula/test/browser/)), not as a standalone experiment. Reasons:
1. The real instrumentation will run inside the mesh + auth + Nebula stack. A bare-bones spike could give a false positive that doesn't translate to the actual code path.
2. If the answer is "flushes", the spike code *is* the first slice of Phase 2's instrumentation — no rebuild.
3. Deployable performance regression tests (future CI) want to live alongside the bench, not in `experiments/`.

**Implementation**:
- Add `InstrumentedNebulaClientGateway extends NebulaClientGateway` in [`apps/nebula/test/browser/worker/`](../apps/nebula/test/browser/worker/). Override `onBeforeCallToMesh` to emit a marker frame: `ws.send(JSON.stringify({type: 'BENCH_MARKER', kind: 'received', callId}))`. Bind `NEBULA_CLIENT_GATEWAY` to this subclass in the bench Worker's `wrangler.jsonc`.
- Add a `delay(ms: number)` mesh handler to `StarTest` that awaits `setTimeout(ms)` then returns. (Wall-clock billing in a test is acceptable.)
- Extend [`harness-client.ts`](../apps/nebula/test/browser/harness-client.ts) to capture `BENCH_MARKER` frames into `Map<callId, {receivedAt: number}>` with `performance.now()` arrival stamps. Existing dispatch for `CALL_RESPONSE` / `INCOMING_CALL` is unchanged.
- Write `apps/nebula/test/browser/flush-spike.test.ts`: invokes `Star.delay(200)` ~20 times; for each iteration records `markerArrival` and `responseArrival`; checks the histogram of `(responseArrival − markerArrival)`.

**Success Criteria**:
- [x] `InstrumentedNebulaClientGateway` + `Star.delay()` + harness marker-capture all in place
- [x] Spike test runs against the deployed bench Worker
- [x] Histogram of `(responseArrival − markerArrival)` clearly clusters near 200 ms (not 0 ms)
- [x] Decision recorded inline in [`flush-spike.test.ts`](../apps/nebula/test/browser/flush-spike.test.ts) — flushes mid-invocation; spike test promoted to permanent regression check.

**Side-effect**: Added `onUnknownMessage(message)` extension hook to `LumenizeClient` ([packages/mesh/src/lumenize-client.ts](../packages/mesh/src/lumenize-client.ts)) so subclasses can intercept Gateway-emitted frames whose `type` is outside the standard `GatewayMessageType` enum. Default behavior unchanged (logs the existing warning); `HarnessNebulaClient` overrides it to capture `bench_marker` frames. Useful long-term for any application-specific Gateway↔client framing.

## Phase 1: Design `InstrumentedNebulaClientGateway` ✅ COMPLETE (2026-05-05)

Phase 1 decisions were locked in during Phase 0 implementation since the spike code became the design. Decisions taken:
- **One marker** at `onBeforeCallToMesh` (not two — the second marker after the await is a Phase 5 follow-up if finer decomposition is needed). Single marker is sufficient for the two-bucket "WS hop / Gateway-onward" split that's the headline.
- **Frame schema**: `{type: 'bench_marker', kind: 'received', callId}`. Type kept outside `GatewayMessageType` enum so the base `LumenizeClient` falls through to `onUnknownMessage`.
- **Harness-side dispatch**: `onUnknownMessage` hook in `LumenizeClient` (added as part of this work). Subclasses override to capture markers; default behavior unchanged.
- **Per-callId correlation**: `Map<callId, markerArrival>` in the harness, threaded via `CallOptions.onSent` (added as part of this work). Works for sequential and concurrent in-flight calls.
- **Gateway-bounce ping rejected as redundant**: the marker pattern already gives us a "to-Gateway round trip" baseline (markerArrival − sendTs); a separate bounce-ping mesh handler would just duplicate that.

Reference docstring lives in [`worker/instrumented-nebula-client-gateway.ts`](../apps/nebula/test/browser/worker/instrumented-nebula-client-gateway.ts).

## Phase 2: Implement instrumented gateway + extend harness client ✅ COMPLETE (2026-05-05)

**Goal**: Land the instrumentation behind Phase 1's design. Single-client only — multi-client extension is Phase 4.

**Implementation** (all landed):
- `InstrumentedNebulaClientGateway` in bench Worker; bound via aliased export so wrangler.jsonc binding stays `NebulaClientGateway` (no migration). [worker/index.ts](../apps/nebula/test/browser/worker/index.ts), [worker/instrumented-nebula-client-gateway.ts](../apps/nebula/test/browser/worker/instrumented-nebula-client-gateway.ts).
- Extended [`harness-client.ts`](../apps/nebula/test/browser/harness-client.ts) with `Map<callId, markerArrival>` keyed correlation, populated via `onUnknownMessage` and threaded through `CallOptions.onSent`. Three decomposed-call helpers (`callStarTransaction`, `callStarPing`, `callStarDelay`) all return `DecomposedCallResult<T>`.
- Replaced `transactions.bench.ts` (vi.bench) with [`transactions.benchmark.ts`](../apps/nebula/test/browser/transactions.benchmark.ts) (it()-based). vi.bench can't accommodate per-call hop decomposition. Unified bench infra under one `*.benchmark.ts` pattern shared with `throughput.benchmark.ts`. Updated package.json scripts: `npm run bench` (transactions), `npm run bench:throughput` (throughput), `npm run bench:all` (both).

**Side-effect API additions** (mesh package):
- `CallOptions.onSent?: (callId: string) => void` — fires synchronously before `#sendOrQueue` so callers can correlate outbound messages with inbound frames.
- `LumenizeClientGateway.onBeforeCallToMesh` signature gained a third `callId: string` parameter so subclasses can include callId in marker frames.

**Success Criteria**:
- [x] Bench produces three decomposed numbers per iteration (and aggregates to mean/p50/p99)
- [x] Decomposition adds up: `ws_hop_mean + gateway_onward_mean ≈ end_to_end_mean` (asserted in test, < 1ms tolerance)
- [x] End-to-end p50 matches old vi.bench mean within noise (ping 41 vs 40, warm 58 vs 56, cold 1279 vs 1542) — see [RESULTS.md](../apps/nebula/test/browser/RESULTS.md)

## Phase 3: Run latency bench and analyze ✅ COMPLETE (2026-05-05)

**Headline numbers** (deployed, p50 across 3 runs from `nebula-browser-test.transformation.workers.dev`, client in Pittsburgh):

| Block | WS hop client↔Gateway | Gateway-onward | end-to-end |
| --- | ---: | ---: | ---: |
| ping (no-op handler) | ~28 ms | ~12 ms | ~41 ms |
| warm transaction | ~29 ms | ~30 ms | ~58 ms |
| cold transaction | ~28 ms | ~1,255 ms | ~1,279 ms |

**Cross-block readings**:
- WS hop is **~28 ms** consistently across all three blocks — independent of what the Gateway does next. Stable WS hop ↔ trustworthy decomposition.
- Workers RPC × 2 + mesh-callback overhead (ping's gateway-onward) ≈ **~12 ms**.
- Transaction work in-Worker (warm gateway-onward − ping gateway-onward) ≈ **~18 ms** — matches the previously-reported ~16 ms in-Worker estimate.
- Cold-wake + Galaxy hop (cold gateway-onward − warm gateway-onward) ≈ **~1,225 ms** — compatible with bare facet bench's ~1,494 ms DO infra baseline within run variance.

**Methodology note**: The decomposition is robust at p50; means drift run-to-run because of TCP-level packet coalescence (when gateway-onward < ~20 ms, the marker frame and response frame sometimes arrive in the same TCP segment, which inflates WS-hop and deflates gateway-onward for that iteration without affecting end-to-end). End-to-end is unaffected; cold-block iterations (>1 s gateway-onward) are well clear of coalescence.

**Success Criteria**:
- [x] Headline latency decomposition documented in [RESULTS.md](../apps/nebula/test/browser/RESULTS.md)
- [x] Cross-post-test methodology notes captured (TCP coalescence, p50-vs-mean rationale)
- [ ] Methodology post 2d updated: replace the "next rung up" aside with citations of these numbers, flip `draft: true` → published

**Punt for now** (broadcast fanout, fire-and-forget patterns): broader pattern coverage was scoped into the original Phase 3. Current bench covers ping (request/response with mesh-callback), warm/cold transaction (mesh-callback). Pure fire-and-forget and broadcast fanout would need bench-side correlation work and aren't blockers for 2d publish; carrying as Phase 5 follow-ups when the throughput work needs them.

## Phase 4: Multi-client harness extension (token-reuse across tabIds) ✅ COMPLETE (2026-05-05)

**Implementation**: [`apps/nebula/test/browser/multi-client.ts`](../apps/nebula/test/browser/multi-client.ts) exports `setupMultiClient({M, ...})` which returns M `HarnessNebulaClient` instances each on its own Gateway DO. Smoke (M=8) and stress (M=64) tests in [`multi-client.test.ts`](../apps/nebula/test/browser/multi-client.test.ts).

**Approach**: bootstrap admin once (one cookie), mint one access JWT, then create M clients each with explicit `accessToken` + `instanceName = {sub}.{tabId}`. Each client lands on its own `NebulaClientGateway` DO via the unique tabId. Real users with multiple tabs would each refresh independently and have distinct JWTs — but the bench is measuring infrastructure cost, not auth cost, so sharing one JWT is acceptable and avoids the refresh-rotation issue below.

**Discovery during implementation**: NebulaAuth's `/auth/<scope>/refresh-token` rotates the refresh-token cookie on each call ([packages/auth/src/lumenize-auth.ts:345](../packages/auth/src/lumenize-auth.ts:345)). M clients refreshing in parallel from the same cookie causes M-1 of them to fail (first invalidates it). This is a production-correct behavior — real users open tabs sequentially — but the bench needs M parallel connections, so we mint one JWT upfront and skip per-client refresh via `LumenizeClient`'s `accessToken` + `instanceName` config. Documented in the multi-client.ts header.

**Measured at M=64 (deployed)**:
- Setup: ~10s (dominated by ~5s bootstrap email round-trip; M=64 client construction + WS connect = ~5s wall-clock).
- Parallel calls: M=64 concurrent `Star.delay(5)` calls all return in ~1.5s wall-clock — no harness-side bottleneck.

**Success Criteria**:
- [x] Harness can stand up M concurrent authenticated WS connections (verified at M=64; no expected ceiling at M=128 or 256)
- [x] All M connections route to distinct Gateway DOs (verified via distinct `instanceName` set)
- [x] Existing single-client tests still pass without modification (transactions.benchmark / flush-spike unchanged)

## Phase 5: Throughput bench and analyze ✅ COMPLETE (2026-05-05)

**Result**: Gateway fanout raises peak per-Star throughput by ~14% vs collapsing all users onto one Gateway.

| total in-flight | Shape A (M=total Gateways) | Shape B (1 Gateway) | Δ |
| ---: | ---: | ---: | ---: |
| 64 | 345 txn/s | 266 txn/s | **+30%** |
| 128 | 332 txn/s | 279 txn/s | **+19%** |
| 256 | 327 txn/s | 301 txn/s | **+8%** |

Peak A: 345 txn/s. Peak B: 301 txn/s. Headline: **+14% peak throughput from Gateway fanout**. See [THROUGHPUT-MULTI-deployed.md](../apps/nebula/test/browser/THROUGHPUT-MULTI-deployed.md) for full table.

**Bench**: [`throughput-multi.benchmark.ts`](../apps/nebula/test/browser/throughput-multi.benchmark.ts), uses [`multi-client.ts`](../apps/nebula/test/browser/multi-client.ts) for the M-client harness. Sweeps total in-flight ∈ {64, 128, 256}; for each, runs maximum-fanout Shape A (M=total, N=1) and no-fanout Shape B (M=1, N=total). Same total in-flight on both, same Star DO, so any delta isolates the Gateway-side fanout effect.

**Mechanism that explains the 14%**: at Shape B's peak (301 txn/s), each transaction takes 1 inbound CALL invocation + 1 outbound mesh-callback invocation on the Gateway = ~602 invocations/sec on a single Gateway DO. At ~1–2 ms CPU per invocation, that's 60–120% of one DO's CPU — the single Gateway is genuinely saturated. Shape A spreads those 602 invocations/sec across M=256 Gateway DOs, ~2.4 inv/sec/Gateway, no serialization on the Gateway side. Star's storage commit rate then becomes the only ceiling — and that's where Shape A peaks (~345 txn/s).

**Shape interpretation across totals**:
- Shape A peaks at total=64 (~345 txn/s) and decays slightly with more load — additional in-flight just queues at Star.
- Shape B keeps climbing through 64 → 256 — the single Gateway is its own bottleneck and benefits from more queueing depth until storage commit saturates.
- The gap shrinks (30% → 19% → 8%) — at the highest load Star saturation eats the Gateway-fanout advantage.

**Caveats**:
- ~2–3% of calls hit the 30s call-timeout under saturation (181 errors at B/total=256, 160 at A/total=256). Numbers are "successful throughput under stress."
- Single run; high variance vs prior `THROUGHPUT-RESULTS.md` (which showed ~400 txn/s peak — likely a favorable day, plus possible 5–15% instrumentation overhead from the marker emit on every call).
- Same-region only (Phase 6 covers cross-region).

**Updated trade-off framing for the methodology post / blog**: the Gateway hop costs ~12 ms of latency per call (Phase 3) and buys (a) simpler architecture (no WS handling in LumenizeDO/NebulaDO) and (b) **~14% peak per-Star throughput vs collapsing fanout to one Gateway**. Both load-bearing.

**Phase 5b decision**: **skip**. The 14% is meaningful but moderate; the architectural-simplicity win plus measured throughput insurance margin is enough to validate the current 1:1 Gateway design without spending 2–3 days on alt-Star.

**Success Criteria**:
- [x] Headline throughput delta documented (Shape A vs Shape B)
- [x] Direction (helps / hurts / break-even) called out with effect size: helps, +14%
- [x] Trade-off framing for the blog post locked in

## Phase 5b (conditional): Alt-Star comparison ⊘ SKIPPED (2026-05-05)

**Decision**: skipped. Phase 5 showed Shape A > Shape B by 14% — meaningful but moderate. The current architecture's trade-off (12 ms latency cost vs simpler architecture + 14% throughput improvement) is well-justified by Phases 3 and 5 alone. Building an alt-Star prototype to confirm "what would no-Gateway look like?" would take 2–3 days for a result we don't actually need to make decisions.

If a future change ever pressures the Gateway architecture (e.g., considering a routing change that collapses fanout), the trigger criteria below still apply — re-evaluate then.

**Original trigger criteria (kept for reference)**: run *only if* Phase 5 shows Shape A >> Shape B (Gateway fanout is load-bearing). If Phase 5 shows A ≈ B (Star storage commit dominates) or A > B by a small margin, skip — the answer is "Gateway position doesn't matter much for throughput" and the 12 ms latency cost is the architecture's only price. No reason to invest in alt-Star.

**Goal**: Directly measure peak per-Star throughput when there is no Gateway DO in the path — Star holds the WebSocket, does auth, does business logic, pushes results back via the same WS.

**Approach**: Build a `StarDirect` subclass (test-only, in [`apps/nebula/test/browser/worker/`](../apps/nebula/test/browser/worker/)) that:
1. Copies `LumenizeClientGateway`'s WS upgrade + JWT decode + OCAN check inline.
2. Handles client calls directly (no Workers RPC out to a separate DO).
3. Replaces the mesh-callback push pattern with direct `ws.send` from Star.

Add a parallel test endpoint in the bench Worker so the harness can route to either path. Re-run the throughput bench against `StarDirect`; compare peak per-Star throughput to Shape A.

**Effort**: ~2–3 focused days.

**Success Criteria** (only if triggered):
- [ ] `StarDirect` prototype runs end-to-end against the throughput harness
- [ ] Peak per-Star throughput documented for: with-Gateway-fanout (Shape A), with-Gateway-no-fanout (Shape B), no-Gateway-at-all (alt-Star)
- [ ] Decision recorded: keep current architecture, or revisit Gateway design

## Phase 6: Cross-region ✅ COMPLETE (2026-05-05)

**Result**: Workers RPC RT measured empirically for same-DC vs cross-Atlantic placement.

| Hop | Workers RPC RT (gateway-onward − 200 ms `setTimeout`) |
| --- | ---: |
| Same-DC (IAD↔IAD) | **~8 ms** |
| Cross-Atlantic (IAD↔WAW) | **~101 ms** |
| Δ | ~93 ms |

The 8 ms same-DC number validates the gateway.mdx claim "less than ten milliseconds in same data center." 101 ms IAD↔WAW (Warsaw) is consistent with the physics floor (~7,000 km × 2 / 200,000 km/s ≈ 70 ms minimum) plus routing overhead — a reasonable cross-Atlantic baseline. The original "several hundred milliseconds" claim was conservative-high; gateway.mdx updated to cite the measured ~101 ms RTT.

**Approach**: empirical measurement using Cloudflare's strict-jurisdiction primitive `newUniqueId({ jurisdiction: 'eu' })` to force a Star DO into the EU jurisdiction. Compared `Star.delay(200)` gateway-onward times for a same-DC named Star vs the EU-jurisdiction one, both invoked through the same Gateway DO (in IAD, the user's colo). Bench: [`cross-region.test.ts`](../apps/nebula/test/browser/cross-region.test.ts).

**Colo introspection**: added a `getColo()` mesh method on `StarTest` that fetches `https://workers.cloudflare.com/cdn-cgi/trace` and parses the `colo=` line — works inside any DO without needing a fetch handler. Bench Worker also exposes `/bench/colo` (returns `request.cf.colo`, identifies the Worker's and Gateway's colo) and `/bench/cross-region-star?jurisdiction=eu` (creates a Star with the requested jurisdiction, returns its hex ID + colo). The mesh framework's `getDOStub` already auto-detects 64-char hex IDs vs names, so cross-region Stars are addressable from the existing client without changes.

**Caveats**:
- Single run; cross-region values can vary substantially (TCP congestion, BGP routing changes, time of day).
- EU jurisdiction is Cloudflare's only "strict" non-default placement option; cannot pick specific colos. WAW happens to be where it landed; a different run might land in LHR, AMS, FRA, etc., with slightly different RTT.
- Cross-region is from US-East. US-West to EU would be longer; US to APAC longer still.

**Success Criteria**:
- [x] Cross-region latency decomposition documented (Phase 6 inline + gateway.mdx update)
- [x] Same-region vs cross-region table published (above)
- [x] gateway.mdx Latency bullet updated with measured numbers
- [x] gateway.mdx Implications gained a Throughput bullet (Phase 5 finding)

## Phase 7 (optional): Follow-up blog post

**Goal**: If results are interesting, write a follow-up blog post — sibling to [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside).

**Trigger conditions** (any one suffices):
- Throughput direction was non-obvious (Gateway wins or breaks even, contradicting the "more hops = more latency = less throughput" instinct)
- Or: Gateway loses on throughput but the loss is interestingly small/large, with implications for architecture choice
- Or: cross-region results reveal architectural levers worth discussing

**Outputs**:
- New post drafted in `website/blog/`
- Update memory and backlog status

## Tooling

Node-side `performance.now()` (Cloudflare time-pinning makes in-Worker measurement unreliable — see methodology link above). Frame-arrival timestamps captured by the harness client; Gateway emits markers via `ws.send()` at instrumented points.

# Gateway Hop Benchmarking

**Status (2026-05-05)**: **Phases 0–3 complete; methodology post 2d unblocked.** Single-client latency decomposition produces stable headline numbers (see [RESULTS.md](../apps/nebula/test/browser/RESULTS.md)). Remaining work: publish 2d, then move to Phase 4 (multi-client harness for throughput direction question).

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

## Phase 4: Multi-client harness extension (token-reuse across tabIds)

**Goal**: Add an M-client load shape so Phase 5 can answer the throughput-direction question.

**Approach**: reuse one access token across N WebSocket connections, varying `tabId` per connection. The Gateway's `instanceName` is `{sub}.{tabId}` ([packages/mesh/src/lumenize-client-gateway.ts:137](../packages/mesh/src/lumenize-client-gateway.ts:137)), so one sub × N distinct tabIds → N distinct Gateway DOs sharing one authenticated identity. Real users hit this exact pattern (multiple tabs / devices), so it's production-shaped.

**Why not e2e-email per client**: the magic-link flow takes 1–3s per client. M=128 clients = several minutes of setup. Token reuse is seconds.

**Why not test-mode auth**: works, but a different code path. Token reuse preserves real auth flow exactly.

**Connection-limit shape, in rough binding-likelihood order**:
- macOS file descriptors — default `ulimit -n` is often 256. Lift to ~10k. Not a real ceiling.
- Node.js libuv / event loop — handles thousands of WS easily; message rate per connection × M is the real CPU cost.
- Cloudflare per-account WS limits — undocumented but very high; unlikely to bind at M ≤ 256.
- TCP source-port exhaustion — ~28k ephemeral ports per (src-IP, dst-IP, dst-port). Not binding.

Practical ceiling will be the test laptop, well above the M values needed.

**Success Criteria**:
- [ ] Harness can stand up M concurrent authenticated WS connections (M up to at least 256)
- [ ] All M connections route to distinct Gateway DOs (verifiable via per-call instanceName)
- [ ] Existing single-client tests still pass without modification

## Phase 5: Throughput bench and analyze

**Goal**: Answer the throughput-direction question. Does the 1:1 Gateway raise, lower, or break even the per-Star throughput ceiling?

**Comparison shapes** (same total in-flight, different fanout):
- **Shape A — with fanout**: M clients × N in-flight each → M Gateway DOs feeding 1 Star. Auth/routing CPU runs in parallel across M Gateway DOs.
- **Shape B — no fanout**: 1 client × M·N in-flight → 1 Gateway DO feeding 1 Star. Auth/routing CPU serializes through one Gateway. (This is the existing [`throughput.benchmark.ts`](../apps/nebula/test/browser/throughput.benchmark.ts) pattern at the high-N end.)

Note: the Gateway DO supersedes prior connections on a new connection ([packages/mesh/src/lumenize-client-gateway.ts:257](../packages/mesh/src/lumenize-client-gateway.ts:257)), so Shape B can't be done by reusing a tabId across M clients — it's exactly the existing single-client-N-in-flight bench. Phase 4's harness work is only needed for Shape A.

**What this comparison measures**: whether collapsing N Gateways into 1 changes peak per-Star throughput. It tests the "M Gateway parallelism" hypothesis directly.

**Known blind spot**: this does NOT measure "what if there were no Gateway at all." That's a different architecture (Star holds WS + does auth + does business logic, all on one DO's input gate), not just a load-shape change. Phase 5b covers that contingency *if* the Phase 5 result warrants it.

**Success Criteria**:
- [ ] Headline throughput delta documented (Shape A vs Shape B)
- [ ] Direction (helps / hurts / break-even) called out with effect size

## Phase 5b (conditional): Alt-Star comparison

**Trigger**: run *only if* Phase 5 shows Shape A >> Shape B (Gateway fanout is load-bearing). If Phase 5 shows A ≈ B (Star storage commit dominates) or A > B by a small margin, skip — the answer is "Gateway position doesn't matter much for throughput" and the 12 ms latency cost is the architecture's only price. No reason to invest in alt-Star.

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

## Phase 6 (optional): Cross-region

**Goal**: Quantify Gateway hop cost when client and Star are in different regions. `gateway.mdx` notes cross-region can be several hundred ms.

**Approach**: deploy a second bench Worker pinned to a non-default colo (or use a client geo on the other side of the network). Re-run Phase 3 with the cross-region setup.

**Success Criteria**:
- [ ] Cross-region latency decomposition documented
- [ ] Same-region vs cross-region table published

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

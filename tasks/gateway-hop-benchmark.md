# Gateway Hop Benchmarking

**Status (2026-05-05)**: **Drafted, not started.** Pivot target after the methodology post ([Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside)) lands. Methodology post is currently in draft (`draft: true` in frontmatter); will publish once this work produces something to discuss.

**Depends on**: Existing bench harness from [parse-validate-release.md](./archive/parse-validate-release.md) Phase 1:
- [`apps/nebula/test/browser/`](../apps/nebula/test/browser/) — `transactions.bench.ts` (single-call latency), `throughput.benchmark.ts` (concurrent ramp), `harness-client.ts` (Node-side client → real WebSockets → deployed Worker pattern + ping subtraction)
- Auto-spawned `wrangler dev`, magic-link auth bootstrap, `Browser`-based harness
- Deployed Worker `nebula-browser-test.transformation.workers.dev` + `BENCH_BASE_URL` override

**Related**:
- [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) — methodology post; Ping baseline section explicitly gestures at this task as the "next rung up"
- [tasks/parse-validate-throughput.md](./parse-validate-throughput.md) — sibling throughput-measurement project (per-Star saturation)
- [website/docs/mesh/gateway.mdx](../website/docs/mesh/gateway.mdx) — documents intra-datacenter hops typically <10 ms but cross-region can be several hundred ms

## Objective

Quantify **two** numbers for the 1:1 Gateway architecture vs hypothetical Client→DO direct:

1. **Per-call latency cost** — how much round-trip time the Gateway adds
2. **Peak per-DO throughput effect** — does the Gateway raise, lower, or break even the per-DO throughput ceiling?

Latency direction is obvious (more hops → more latency). Throughput direction is **not** obvious — and is the more interesting question.

### Why throughput direction isn't obvious

More hops add queues, and queues can *improve* throughput when an upstream stage offloads serial work from the bottleneck. Specifically:

- The Gateway does OCAN checks + routing on its own DO, sparing the parent DO's ~2.5 ms serial CPU floor (see [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) for the floor measurement).
- With 1:1 Gateway architecture, auth work for N clients runs across N concurrent Gateway DOs (independent serial CPUs) instead of serially on the parent DO.

So the Gateway could plausibly cost latency per call but *win* on peak per-DO throughput. Could also break even or lose. Direction is empirical.

## Phase 1: Investigate existing Gateway hooks

**Goal**: Determine whether previously-added Gateway hooks can send push WS frames from inside the request path.

**Why first**: Phase 2's methodology needs intermediate observation points. If the existing hooks support this, Phase 2 reuses them. If not, Phase 2 needs direct Gateway modifications, which is bigger scope.

**Success Criteria**:
- [ ] Located the relevant Gateway hooks
- [ ] Determined whether they support push WS frames from inside an in-flight request
- [ ] Decided: use existing hooks, extend them, or fall back to direct Gateway modifications

## Phase 2: Implement bench harness extensions

**Goal**: Extend the existing bench harness to either bypass the Gateway or instrument intermediate observation points (per Phase 1's decision).

**Two approaches** (do whichever Phase 1 makes feasible — possibly both, since they answer slightly different questions):

- **Parallel ping path bypassing Gateway** — client → Star direct over WebSocket if achievable, or client → Star via Workers RPC from a thin shim. Compare baselines to existing ping. Answers *"what does the Gateway cost end-to-end?"*
- **Intermediate observers** — instrument push frames at each routing stage; compute deltas to isolate Gateway hop specifically. Answers *"where does the Gateway cost go (WS leg vs Workers RPC leg vs Gateway processing)?"*

**Success Criteria**:
- [ ] Bench produces comparable latency numbers for "with Gateway" vs "without Gateway" (or "Gateway hop isolated") baselines
- [ ] Bench produces comparable throughput curves for "with" vs "without" Gateway under saturation

## Phase 3: Run benchmarks and analyze

**Goal**: Produce headline numbers for both latency and throughput across all relevant call patterns; write up findings.

**Patterns to benchmark**:
- Fire-and-forget calls
- Request/response calls
- Broadcast fanout

**Variations**:
- Same-region (default)
- Cross-region (if reasonable to set up — `gateway.mdx` notes cross-region can be several hundred ms)

**Things to consider during analysis**:
- Whether always using the two one-way call pattern (to avoid DO wall-clock billing) changes the latency tradeoff
- Whether the Gateway helps throughput, hurts it, or breaks even — and by how much

**Success Criteria**:
- [ ] Headline latency delta documented (with vs without Gateway, per pattern)
- [ ] Headline throughput delta documented (with vs without Gateway, per pattern)
- [ ] Cross-post-test methodology notes (analogous to [`apps/nebula/test/browser/RESULTS.md`](../apps/nebula/test/browser/RESULTS.md))

## Phase 4 (optional): Publish findings

**Goal**: If results are interesting, write a follow-up blog post — sibling to [Piercing the temporal haze](/blog/benchmarking-cloudflare-durable-objects-from-outside) or an update to it.

**Trigger conditions**:
- Throughput direction was non-obvious (Gateway wins or breaks even, contradicting the "more hops = more latency = less throughput" instinct)
- Or: Gateway loses but the loss is interestingly small/large, with implications for architecture choice

**Outputs**:
- Replace the "next rung up" aside in the Piercing post's Ping baseline section with a link to actual results
- Update memory and backlog status

## Tooling

Node-side `performance.now()` (Cloudflare time-pinning makes in-Worker measurement unreliable — see methodology link above). Compare same-region and cross-region scenarios where feasible.

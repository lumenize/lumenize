# Proxy-Fetch Performance Experiments

**Status**: Planning
**Type**: Research & Measurement
**Dependencies**: Requires both `proxyFetch` and `proxyFetchSimple` implementations complete

## Objective

Measure and compare wall clock billing costs across three fetch approaches to validate cost-saving theories and decide which implementation(s) to keep.

## Background

**The Measurement Challenge:**
- `Date.now()` doesn't work - clock stops during Workers/DO execution
- Multiple calls to `Date.now()` return the same value even when separated by real time
- Need to use Cloudflare's observability logs which contain wall clock billing data
- Just because something *shouldn't* bill wall clock time doesn't mean it won't
- Need empirical data to validate assumptions

**Three Approaches to Compare:**
1. **Direct** - Origin DO fetches directly (baseline for comparison)
2. **Current** - `proxyFetch` with Orchestrator (DO → Orchestrator DO → Worker)
3. **Simple** - `proxyFetchSimple` without Orchestrator (DO → Worker)

## Phase 1: Research Cloudflare Observability API

**Goal**: Figure out how to retrieve wall clock billing data from Cloudflare logs.

**Questions to Answer:**
- [ ] What API exists for retrieving observability logs?
- [ ] What fields are available in log entries?
- [ ] Is there a `wallClockMs` or similar field?
- [ ] How delayed are log entries? (seconds? minutes?)
- [ ] Can we query logs in real-time or need to wait?
- [ ] What's the API authentication/access pattern?
- [ ] Are logs available in local dev (`wrangler dev`) or production only?

**Research Sources:**
- Cloudflare Workers documentation
- Cloudflare GraphQL Analytics API
- Cloudflare Logpush
- Workers observability dashboard
- Community Discord

**Deliverable**: Document with clear answers + example API calls

## Phase 2: Create Measurement Infrastructure

**Goal**: Build tooling to capture and analyze wall clock billing data.

**Infrastructure Needed:**
- Script to trigger test fetches
- Script to query/poll Cloudflare logs
- Parser to extract wall clock times from log entries
- Aggregator to compute statistics (mean, median, p95, p99)
- Handle log delay (retry logic, timeout)

**Test Design:**
- Multiple runs per approach (30+ for statistical significance)
- Various fetch durations (100ms, 500ms, 1s, 5s, 10s)
- Control for external variability (same endpoint, same time of day)
- Record metadata (timestamp, fetch duration, approach used)

**Success Criteria:**
- [ ] Can reliably retrieve wall clock billing for a test fetch
- [ ] Can run automated test suite
- [ ] Can generate comparison reports

## Phase 3: Run Baseline Experiments

**Goal**: Establish baseline performance for Direct and Current approaches.

**Experiments:**
1. **Direct fetch from origin DO**
   - Vary fetch durations: 100ms, 500ms, 1s, 5s, 10s
   - 30 runs per duration
   - Record wall clock billing

2. **Current `proxyFetch` (with Orchestrator)**
   - Same durations as Direct
   - 30 runs per duration
   - Record wall clock billing for:
     - Origin DO
     - Orchestrator DO
     - Worker (if billed)

**Analysis:**
- Compare Direct vs Current
- Validate theoretical cost model (DO wall clock vs Worker CPU)
- Identify overhead of Orchestrator hop

## Phase 4: Run `proxyFetchSimple` Experiments

**Goal**: Measure `proxyFetchSimple` performance and compare to baselines.

**Experiments:**
1. **Simple fetch (no Orchestrator)**
   - Same durations as previous phases
   - 30 runs per duration
   - Record wall clock billing for:
     - Origin DO
     - Worker (if billed)

**Analysis:**
- Compare Simple vs Current (is one hop faster?)
- Compare Simple vs Direct (overhead of Worker indirection)
- Calculate cost savings

## Phase 5: RpcTarget Comparison (Optional)

**Goal**: Determine if RpcTarget provides measurable benefit vs WorkerEntrypoint.

**Experiments:**
1. **WorkerEntrypoint executor** (current/simple implementations)
2. **RpcTarget executor** (new implementation)
   - Same test matrix as Phase 4
   - Focus on overhead differences

**Analysis:**
- Is RpcTarget measurably faster?
- Is difference significant enough to matter?

## Phase 6: Decision & Documentation

**Goal**: Decide which implementation(s) to keep based on data.

**Decision Criteria:**
- Cost savings (wall clock billing reduction)
- Latency (total request time)
- Complexity (maintenance burden)
- Use case fit (when to use which)

**Possible Outcomes:**
1. **Keep `proxyFetchSimple` only** - Clear winner, deprecate current
2. **Keep both** - Different use cases (document when to use each)
3. **Keep current only** - Simple version doesn't provide expected benefits
4. **Surprise finding** - Data reveals unexpected result, pivot accordingly

**Documentation:**
- Add performance comparison to docs
- Update recommendations based on data
- Archive or deprecate losing approach
- Document methodology for future experiments

## Open Questions

- [ ] Can we access logs in local dev or need production deploy?
- [ ] What's the actual log delay in practice?
- [ ] Do we need to account for cold starts in measurements?
- [ ] Should we test with different geographic regions?
- [ ] How do we control for Cloudflare's internal routing variability?

## Notes

**Why this is separate from implementation:**
- Can build `proxyFetchSimple` without knowing exact performance
- Measurement methodology needs trial and error
- Don't want to block implementation on perfecting experiments
- Experiments inform documentation, not implementation

**Theoretical cost model (to validate):**
- Workers bill on CPU time (~1,000-10,000x cheaper than DO wall clock)
- For 1s fetch: 100x-33x savings (depends on RPC overhead)
- One less hop should reduce latency by 10-30ms
- Need empirical data to confirm or refute


# Proxy-Fetch Performance Experiments

**Status**: Planning
**Type**: Research & Measurement
**Dependencies**: Requires both `proxyFetch` and `proxyFetchSimple` implementations complete

## Objective

Measure and compare wall clock billing costs across proxyFetch approaches with simply making the fetch directly from the origin DO to validate cost-saving and performance theories and decide which implementation(s) to keep.

## Background

**The Measurement Challenge:**
- `Date.now()` doesn't work - clock stops during Workers/DO execution
- Multiple calls to `Date.now()` return the same value even when separated by real time
- Need to use Cloudflare's observability logs which contain wall clock billing data
- Just because we think something *shouldn't* bill wall clock time doesn't mean it won't
- Need empirical data to validate assumptions

**Three Approaches to Compare:**
1. **Direct** - Origin DO fetches directly (baseline for comparison)
2. **Current** - `proxyFetch` with Orchestrator (DO → Orchestrator DO → Worker)
3. **Simple** - `proxyFetchSimple` without Orchestrator (DO → Worker)

## Phase 1: Research Cloudflare Observability API ✅

**Goal**: Figure out how to retrieve wall clock billing data from Cloudflare logs.

**Questions to Answer:**
- [x] What API exists for retrieving observability logs?
- [x] What fields are available in log entries?
- [x] Is there a `wallClockMs` or similar field?
- [x] How delayed are log entries? (seconds? minutes?)
- [x] Can we query logs in real-time or need to wait?
- [x] What's the API authentication/access pattern?
- [x] Are logs available in local dev (`wrangler dev`) or production only?

**Findings:**

**1. Available APIs:**
- ❌ **Workers Logs Dashboard** - UI-only query builder at `/workers-and-pages/observability`, no REST API
- ❌ **Log Explorer SQL API** - Supports HTTP/firewall logs, but NOT `workers_trace_events`
- ❌ **GraphQL Analytics API** - Only provides aggregates (P50/P99), not individual log events
- ✅ **Logpush to R2** - Can export `workers_trace_events` to R2 bucket for querying
- ✅ **`wrangler tail`** - Real-time log streaming (no historical data)

**2. Log Fields (from Logpush job config):**
Available fields in `workers_trace_events`:
- `CPUTimeMs` - CPU billing time ✅
- `WallTimeMs` - Wall clock billing time ✅
- `EventTimestampMs` - When event occurred
- `ScriptName` - Worker/DO name
- `EventType` - `fetch`, `alarm`, etc.
- `Outcome` - `ok`, `exception`, `canceled`, etc.
- `DispatchNamespace`, `Entrypoint`, `Event`, `Exceptions`, `Logs`, `ScriptTags`, `ScriptVersion`

**3. Logpush Job Configuration:**
```bash
# List all Logpush jobs
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/logpush/jobs" \
  --header "X-Auth-Email: larry@maccherone.com" \
  --header "X-Auth-Key: $CLOUDFLARE_GLOBAL_API_KEY"
```

Current job:
- **Dataset**: `workers_trace_events`
- **Destination**: `r2://cloudflare-managed-03e4752d/{DATE}`
- **Frequency**: `high` (every few minutes)
- **Enabled**: `true`
- **R2 Credentials**: Available in job config's `destination_conf`

**4. Log Delay:**
- Logpush jobs with "high" frequency push logs every few minutes
- Logs organized by date: `{DATE}/` folder structure
- Our job created at 2025-11-18T20:46:58Z, first logs expected within 5-10 minutes

**5. Authentication:**
- **Logpush API**: `X-Auth-Email` + `X-Auth-Key` (global API key)
- **R2 Access**: Access Key ID + Secret Access Key (from Logpush job config)
- **AWS CLI**: Can use `aws s3 ls/cp` with R2 endpoint (requires AWS CLI installed)

**6. Production vs Dev:**
- **Production only** - Logpush requires deployed Workers/DOs
- `wrangler dev` logs don't go to Logpush
- Need to run experiments against deployed services

**Recommended Approach:**
Use **Logpush to R2** for experiments:
1. Trigger test fetches against deployed DO
2. Wait 5-10 minutes for logs to push
3. Download logs from R2 (either via wrangler or AWS CLI)
4. Parse JSONL files to extract `WallTimeMs` and `CPUTimeMs`
5. Aggregate statistics

**Validation:**
- ✅ R2 bucket access confirmed via `@aws-sdk/client-s3`
- ✅ Script created: `scripts/inspect-r2-logs.js` successfully lists and parses logs
- ✅ Credentials working (downloaded test file: `{"content":"test"}`)
- ⏳ Waiting for real Worker activity to generate actual logs

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


# Proxy-Fetch Performance Experiments

**Status**: Ready for Phase 3 (Production Testing)
**Type**: Research & Measurement
**Dependencies**: ✅ Both `proxyFetch` and `proxyFetchSimple` implementations complete
**Infrastructure**: ✅ Measurement tooling complete (local testing + R2 polling ready)

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

## Phase 2: Create Measurement Infrastructure ✅

**Status**: COMPLETE

**Goal**: Build tooling to capture both latency and wall clock billing data.

### Two Metrics Required

**1. Latency (Client Perspective)**
- Measured on Node.js client (where `Date.now()` advances!)
- Start: `Date.now()` when DO sends `timing-start` event
- End: `Date.now()` when DO sends `timing-end` event
- Client calculates `totalTime` for batch
- Run 50+ iterations for statistical significance (proven stable in call-delay experiments)

**2. Wall Clock Billing (Cloudflare Perspective)**
- Extracted from R2 Logpush logs
- Fields: `WallTimeMs`, `CPUTimeMs` per operation
- Shows actual cost (what you pay), not just latency
- Validates assumptions about DO wall clock vs Worker CPU billing

### Step 1: Upgrade `@lumenize/for-experiments` ✅

**Remove Legacy Polling:**
- Current: Client polls `/rpc/checkCompletion` for last operation
- New: DO sends `totalTime` directly in `batch-complete` message
- Simpler, more accurate, already used in `call-delay` experiment

**Changes Made:**
- ✅ Removed `pollForCompletion()` function from `node-client.js` (marked as deprecated)
- ✅ Updated `batch-complete` handler to use `msg.totalTime` directly
- ✅ Simplified logging: "Batch complete" instead of "polling for completion"
- ✅ Pattern already proven in `experiments/call-delay`

**Backward Compatibility:**
- Existing experiments may still have `/rpc/checkCompletion` endpoints
- They're no longer called, but harmless if present
- New experiments don't need to implement it

### Step 2: Add R2 Billing Analysis Module ✅

**Created: `tooling/for-experiments/src/r2-billing.js`**

**Phase A - Mock Implementation (for local testing):**
- ✅ `pollForR2Logs()` - Returns mock billing data
- ✅ `fetchBillingMetrics()` - Aggregates mock logs into metrics
- ✅ `extractMetricsFromLogs()` - Calculates avg/total WallTime and CPUTime
- ✅ `generateMockLogs()` - Simulates realistic billing data
- ⏳ Real R2 polling - Stubbed for Phase B (production)

**Updated: `tooling/for-experiments/src/node-client.js`**
- ✅ Added `withBilling` option to `runAllExperiments()`
- ✅ Added warmup phase (10 ops) when billing is enabled
- ✅ Track batch timing windows (`batchWindow: { start, end }`)
- ✅ Fetch billing metrics after all batches complete
- ✅ Updated `displayResults()` to show billing data

**Usage:**
```javascript
// Local testing with mock billing data
runAllExperiments(baseUrl, 50, { 
  withBilling: true, 
  scriptName: 'my-worker' 
});

// Output includes both latency and billing (mock)
// Latency (DO-measured): 1500ms total, 30ms/op
// Billing (R2 logs): Avg Wall Time: 25ms, Avg CPU Time: 7ms
```

**Environment Variables:**
- ✅ Added to `.dev.vars`: `CLOUDFLARE_R2_BUCKET_NAME`, `CLOUDFLARE_ACCOUNT_ID`
- ✅ Updated `.dev.vars.example` with placeholders and descriptions

**R2 Log Matching Strategy:**
- **Assumption**: Isolated testing (we're the only ones running)
- **Time window**: Wide buffer for safety (experiment to determine actual skew)
- **Filter by**: `ScriptName`, `EventType` (fetch/alarm), timestamp range
- **Multi-DO handling**: Need to query Origin DO and Orchestrator DO separately
  - Experiment: Check if `ScriptName` differs or if binding/class name available
- **Validation**: Warn if log count ≠ expected count, but continue with what we have

**Polling Strategy:**
- Poll R2 every 10 seconds
- Max timeout: Determined experimentally (start with 10 minutes)
- If logs consistently appear in ~1 min, can reduce max timeout to 3 min
- Stop polling once expected logs are found

### Step 3: Test & Iterate on R2 Log Matching

**Experiments to run:**
1. **Clock skew measurement**: Compare log timestamps to node.js `Date.now()`
2. **Log delay**: How long until logs appear in R2? (avg, p95, max)
3. **Multi-DO identification**: Can we distinguish Origin DO vs Orchestrator DO logs?
   - Check: `ScriptName` field (may be same if exported from same index)
   - Check: Binding name field (if available)
   - Check: Class name field (if available)
   - Fallback: Sequential batches (run Origin-only first, then Orchestrator-only)

**Success Criteria:**
- [x] Remove legacy polling from `for-experiments`
- [x] Fixed client-side timing (using `timing-start`/`timing-end` events)
- [x] Create R2 billing module with mock implementation (Phase A)
- [x] Add `withBilling` option to `runAllExperiments()`
- [x] Combined reporting shows latency + billing side-by-side (with mock data)
- [x] **Phase B**: R2 polling infrastructure implemented (`listLogFiles`, `downloadAndParseLogFile`, `filterLogsByTimeWindow`)
- [ ] **Phase B**: R2 polling tested against deployed services (finds logs within max timeout)
- [ ] **Phase B**: Time window matching validated (<5% false positives/negatives)
- [ ] **Phase B**: Multi-DO identification strategy determined (Origin vs Orchestrator)

**Phase 2 Summary:**

Phase 2 is **COMPLETE** for local development. The infrastructure is ready to:
1. ✅ Measure latency on the Node.js client (where `Date.now()` actually advances)
2. ✅ Poll R2 for billing logs (infrastructure complete, ready for production testing)
3. ✅ Display both metrics side-by-side

**Next**: Deploy to production and validate R2 log matching with real data (Phase 3).

### Infrastructure Files

**Updated:**
- `tooling/for-experiments/src/node-client.js` - Client-side timing via WebSocket events, billing integration
- `tooling/for-experiments/src/lumenize-experiment-do.ts` - Sends `timing-start`/`timing-end` events
- `tooling/for-experiments/src/index.ts` - No longer exports R2 functions (Node.js-only)

**New:**
- `tooling/for-experiments/src/r2-billing.js` - R2 query and billing extraction (Phase A - mock)
- `experiments/proxy-fetch-performance/` - Experiment folder for Phase 3
  - `src/index.ts` - PerformanceController and OriginDO
  - `test/measurements.mjs` - Test client with billing support
  - `wrangler.jsonc` - DO bindings and Worker config
  - `README.md` - Usage instructions

**Reused:**
- `scripts/inspect-r2-logs.js` - R2 query patterns for Phase B

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


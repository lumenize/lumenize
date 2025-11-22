# Proxy-Fetch Performance Experiments

Compare Direct vs ProxyFetch billing costs and latency.

## Quick Start

### Basic Test (Latency Only)

```bash
# Local development
npm run dev

# In another terminal:
npm test
```

### Production Test with Billing Analysis

```bash
# 1. Deploy to production
npm run deploy

# 2. Run experiment with wrangler tail capture
./run-with-tail.sh
```

The `run-with-tail.sh` script:
- Starts `wrangler tail` in background, capturing logs to `tail-logs.jsonl`
- Runs the experiment against production
- Extracts billing metrics (`WallTimeMs`, `CPUTimeMs`) from captured logs
- Displays both latency and billing cost comparison

## What It Measures

**Two metrics:**
1. **Latency** - Total request time (client-side, where `Date.now()` advances)
2. **Billing** - Wall clock time and CPU time from Cloudflare logs

**Two approaches:**
1. **Direct** - Origin DO fetches directly (baseline)
2. **ProxyFetch** - Origin DO → Worker → External API (cost-saving architecture)

## Understanding Results

### Example Output

```
Direct (direct)
  Latency (Client-measured):
    Total: 7500ms
    Avg: 150.00ms per operation
  Billing (Cloudflare logs):
    Avg Wall Time: 145.00ms
    Avg CPU Time: 5.00ms
  Completed: 50/50

ProxyFetch (proxyfetch)
  Latency (Client-measured):
    Total: 7600ms
    Avg: 152.00ms per operation
  Billing (Cloudflare logs):
    Avg Wall Time: 25.00ms
    Avg CPU Time: 5.00ms
  Completed: 50/50

💡 ANALYSIS
  Latency Overhead (vs Direct): +2.00ms (+1.3%)
  Cost savings: 82.8% (120.00ms less wall time)
```

**Interpretation:**
- **Latency overhead**: ProxyFetch adds ~2ms per request (negligible)
- **Cost savings**: 82.8% reduction in wall clock billing (significant!)
- Direct: 145ms wall time (DO billed for entire fetch duration)
- ProxyFetch: 25ms wall time (DO only billed for RPC setup, Worker handles fetch on CPU time)

### Why This Matters

Workers bill on **CPU time** (~1,000-10,000x cheaper than DO wall clock time).

For long-running fetches (100ms-10s):
- Direct: DO billed for entire fetch (wall clock)
- ProxyFetch: DO billed for RPC setup only, Worker handles fetch (CPU time)

Expected savings: **60-95%** depending on fetch duration.

## How Billing Analysis Works

### Wrangler Tail Capture (Recommended)

`run-with-tail.sh` uses `wrangler tail --format json` to capture logs during experiments:

1. **Start tail**: `wrangler tail --format json > tail-logs.jsonl`
2. **Run experiment**: Generates requests with known time windows
3. **Parse logs**: Extract `wallTime` and `cpuTime` from captured JSONL
4. **Match by time**: Filter logs within experiment time window
5. **Aggregate**: Calculate averages per approach

**Fields captured:**
```json
{
  "scriptName": "proxy-fetch-performance",
  "eventTimestamp": 1763733534327,
  "wallTime": 145,
  "cpuTime": 5,
  "executionModel": "durableObject",
  "outcome": "ok"
}
```

### Why Not R2 Logpush?

We initially tried R2 Logpush but it proved unreliable:
- Jobs frequently get "stuck" (`last_complete: null`)
- No errors reported, just silently stops working
- Requires disabling/recreating jobs to fix
- Adds 5-10 minute delay for logs to appear

Wrangler tail is:
- ✅ Immediate (real-time capture)
- ✅ Reliable (direct stream from Cloudflare)
- ✅ Same data (includes all billing metrics)
- ❌ Requires manual start/stop (handled by `run-with-tail.sh`)

## Manual Workflow

If you want more control:

```bash
# Terminal 1: Start tail capture
wrangler tail --format json > my-logs.jsonl

# Terminal 2: Run experiment
WITH_BILLING=true TAIL_LOG_FILE=my-logs.jsonl npm test 50

# Terminal 1: Stop tail (Ctrl+C)
```

## Advanced Options

### Custom Operation Count

```bash
# Run with 100 operations instead of default 50
./run-with-tail.sh 100
```

### Environment Variables

```bash
# Production URL
export TEST_URL=https://proxy-fetch-performance.YOUR_ACCOUNT.workers.dev

# Enable billing analysis
export WITH_BILLING=true

# Custom tail log file
export TAIL_LOG_FILE=custom-logs.jsonl

npm test 50
```

## Troubleshooting

### "Server is not responding"

Make sure the worker is deployed:
```bash
npm run deploy
```

### "No logs found" / "Log count mismatch"

Common causes:
- Tail wasn't running during experiment
- Time window mismatch (check system clock)
- Logs got filtered out (check scriptName matches)

Check the raw tail log:
```bash
cat tail-logs.jsonl | grep '"wallTime"' | head -10
```

### Experiment times out

Default timeout is 60s. For slower networks:
```bash
# Increase timeout (not yet implemented - would need code change)
# Current workaround: Reduce operation count
npm test 20
```

## Files

- `src/index.ts` - PerformanceController and OriginDO implementation
- `test/measurements.mjs` - Experiment runner with billing analysis
- `run-with-tail.sh` - Wrapper script for wrangler tail capture
- `tail-logs.jsonl` - Captured logs (gitignored)
- `wrangler.jsonc` - Cloudflare Worker/DO configuration

## Related

- `@lumenize/for-experiments` - Shared experiment infrastructure
- `tooling/for-experiments/src/r2-billing.js` - Billing metric extraction
- `tasks/proxy-fetch-performance-experiments.md` - Full research documentation

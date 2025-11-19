# Proxy-Fetch Performance Experiment

Measures latency and wall clock billing costs across three approaches to external HTTP fetching from Durable Objects.

## Goal

Answer the key questions:
- **Latency**: How much overhead does each proxy approach add?
- **Cost**: What are the actual wall clock billing costs?
- **Decision**: Keep both implementations, or deprecate one?

## Three Approaches

### Direct (Baseline)
- Origin DO fetches directly using `fetch()`
- **Expected**: Fastest latency, highest DO wall clock cost
- **Use case**: When latency is critical, cost is secondary

### Current (proxyFetch with Orchestrator)
- Origin DO → Orchestrator DO → Worker Executor
- **Expected**: Medium latency, lower DO cost (two DOs but minimal wall time)
- **Use case**: Existing implementation, proven in production

### Simple (proxyFetchSimple)
- Origin DO → Worker Executor (no Orchestrator)
- **Expected**: Lower latency than Current, similar cost savings
- **Use case**: Simplified architecture, faster

## Local Testing

```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Run test (latency only, mock billing)
npm test 50

# With billing analysis (mock data locally)
npm test 50 --billing
```

**Local mode uses mock billing data** from `@lumenize/for-experiments`. To test real billing, deploy to production.

## Production Testing

```bash
# Deploy to production
npm run deploy

# Run with real billing analysis
TEST_URL=https://proxy-fetch-performance.YOUR_ACCOUNT.workers.dev \
WITH_BILLING=true \
npm test 50
```

**Production mode:**
- Runs warmup (10 ops, excluded from analysis)
- Runs measurement batches (50 ops per variation)
- Waits ~10 minutes for R2 Logpush
- Queries R2 logs for actual `WallTimeMs` and `CPUTimeMs`
- Displays combined latency + billing analysis

## Expected Results

**Latency (DO-measured):**
- Direct: ~150ms avg
- Current: ~180ms avg (+30ms overhead)
- Simple: ~165ms avg (+15ms overhead)

**Billing (R2 logs):**
- Direct: ~150ms wall time (expensive - DO billed on wall clock)
- Current: ~30ms wall time total (Origin + Orchestrator DOs)
- Simple: ~20ms wall time (Origin DO only)

**Cost Savings:**
- Current: ~80% cheaper than Direct
- Simple: ~87% cheaper than Direct, ~23% cheaper than Current

## Architecture

Uses `@lumenize/for-experiments` framework:
- `PerformanceController` - Extends `LumenizeExperimentDO`
- `OriginDO` - Makes fetches using all three methods
- `FetchOrchestrator` - From `@lumenize/proxy-fetch` (for Current variation)
- `FetchExecutorEntrypoint` - Worker that executes fetches
- `TestEndpointsDO` - Mock HTTP endpoints (from `@lumenize/test-endpoints`)

## Files

- `src/index.ts` - Controller and Origin DO
- `test/measurements.mjs` - Test client
- `wrangler.jsonc` - DO bindings and Worker config
- `package.json` - Dependencies and scripts

## Implementation Notes

- Uses 100ms delay endpoints for consistent measurements
- Separate Origin DO instances per variation to avoid state conflicts
- Mark completion in storage for validation
- Billing analysis requires deployment to production (R2 Logpush)


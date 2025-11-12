# ProxyFetch Latency Measurements

This experiment measures the real-world latency characteristics of the new `proxyFetchWorker` variant compared to the existing `proxyFetchDO` and `proxyFetchQueue` variants.

## Architecture

**proxyFetchWorker (V3)**: DO-Worker Hybrid
1. Origin DO → FetchOrchestrator DO: Enqueue fetch request
2. FetchOrchestrator → Worker: Dispatch (CPU-billed)
3. Worker: Execute external fetch
4. Worker → Origin DO: Send result directly
5. Origin DO: Execute continuation with Response | Error

## Structure

- **`src/`**: Test DO implementations for latency measurement
- **`test/`**: Node.js-based performance tests (avoids worker clock issues)
- **`MEASUREMENTS.md`**: Running log of all latency measurements
- **`wrangler.jsonc`**: Production deployment configuration

## Running Measurements

**Two-process setup to get accurate timing:**

**Requirements:**
- Node.js v22+ (for native fetch support)

1. **Terminal 1** - Start the worker with wrangler:
   ```bash
   npm run dev
   ```

2. **Terminal 2** - Run the latency tests (connects to localhost:8787):
   ```bash
   npm test
   ```

The tests run in Node.js and connect to the wrangler dev server over HTTP, giving accurate latency measurements without test environment overhead.

## What We're Measuring

1. **Enqueue Latency**: Time from `proxyFetchWorker()` call until reqId returned
   - Target: <50ms (vs 416ms in test environment)
   
2. **End-to-End Latency**: Time from enqueue until result delivered to origin DO
   - Includes: queue time + worker dispatch + external fetch + callback
   
3. **Comparison**: How does proxyFetchWorker compare to:
   - `proxyFetchDO`: DO variant (current best for latency)
   - `proxyFetchQueue`: Queue variant (high latency, good for scale)

## Recording Results

**Best Practice: Always commit code changes before recording measurements.**

### Workflow

1. Make code changes (optimizations, fixes, etc.)
2. Run tests to verify they work: `npm test`
3. **Commit the changes** with descriptive message
4. Get git hash: `git rev-parse --short HEAD`
5. Run performance benchmark: `npm test`
6. Record results in `MEASUREMENTS.md`:
   - Timestamp (YYYY-MM-DD HH:MM:SS format)
   - Git hash from step 4
   - Description of what changed
   - Formatted latency results
   - Relevant observations
7. Commit the `MEASUREMENTS.md` update

This way, every measurement is tied to a clean, committed state that can be reproduced exactly.


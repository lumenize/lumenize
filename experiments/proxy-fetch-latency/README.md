# ProxyFetch Latency Measurements

This experiment measures the real-world latency of the `proxyFetchWorker` architecture.

## Architecture (Simplified)

The experiment deploys a **single** Cloudflare Worker with three components:

1. **`OriginDO`** - Initiates fetches and measures latency
2. **`FetchOrchestrator`** - Manages fetch queue
3. **Worker fetch handler** - Handles both routing AND proxy-fetch execution (CPU-billed)

### Flow Diagram

```
Origin DO → FetchOrchestrator → Worker Handler (HTTP POST to /proxy-fetch-execute)
                                       ↓ (executes fetch)
                                  External API
                                       ↓
                              Worker Handler → Origin DO (result via RPC)
```

### Key Benefits

- ✅ **Simple deployment** - Single `wrangler deploy` command
- ✅ **No service bindings** - Uses HTTP with shared secret authentication  
- ✅ **CPU billing** - Fetch execution happens in worker's fetch handler (CPU-billed)
- ✅ **Low latency** - Direct HTTP dispatch, ~100-200ms end-to-end

## Structure

- **`src/index.ts`**: Main worker with OriginDO, FetchOrchestrator, and fetch handler
- **`test/latency-measurements.mjs`**: Node.js performance tests (avoids worker clock issues)
- **`MEASUREMENTS.md`**: Running log of all latency measurements
- **`wrangler.jsonc`**: Production deployment configuration

## Setup

Before deploying or running tests, you need to:

### 1. Set the Shared Secret

```bash
wrangler secret put PROXY_FETCH_SECRET
# Enter a secure random string when prompted
```

This secret is used to authenticate requests from FetchOrchestrator to the worker's fetch handler.

### 2. Configure Worker URL

Edit `wrangler.jsonc` and update the `WORKER_URL`:

```jsonc
{
  "vars": {
    "WORKER_URL": "https://proxy-fetch-latency.YOUR_SUBDOMAIN.workers.dev"
  }
}
```

Replace `YOUR_SUBDOMAIN` with your actual Cloudflare subdomain.

## Running Measurements

### Option 1: Production Deployment (Recommended)

For real production latency measurements:

```bash
# Deploy the worker
npm run deploy

# Run measurements against production
export $(cat ../../.dev.vars | xargs)
export TEST_URL=https://proxy-fetch-latency.YOUR_SUBDOMAIN.workers.dev
npm test
```

This gives true production numbers with:
- ✅ Full HTTP dispatch flow
- ✅ Worker fetch handler with CPU billing
- ✅ FetchOrchestrator → Worker → Origin DO flow
- ✅ Real network latencies

### Option 2: Local Development

For quick iteration during development:

**Requirements:**
- Node.js v22+ (for native fetch support)

1. **Terminal 1** - Start the worker with wrangler:
   ```bash
   npm run dev
   ```

2. **Terminal 2** - Export env vars and run tests (connects to localhost:8787):
   ```bash
   export $(cat ../../.dev.vars | xargs)
   npm test
   ```

**Note:** Local dev uses `http://localhost:8787` by default. Some behaviors may differ from production.

## What We're Measuring

### 1. Enqueue Latency

Time from `proxyFetchWorker()` call until reqId returned:
- **Includes**: Client → Cloudflare network latency + DO-to-DO RPC + queueing
- **Target**: <200ms (with network overhead)
- **Production overhead alone**: ~20-50ms within Cloudflare network

### 2. End-to-End Latency  

Total time from `proxyFetchWorker()` call until continuation executes:
- **Breakdown**: Enqueue + Worker HTTP POST + External fetch + Result callback
- **Target**: Depends on external API, but overhead should be minimal (~100-200ms + API time)

### 3. What's NOT Measured

- **Server Duration**: Always 0ms due to Workers clock behavior during I/O
- **Worker execution time**: Not directly measured (included in end-to-end)

## How It Works

The experiment exposes HTTP endpoints on the OriginDO:

1. **`/start-fetch?url=...`** - Initiates a fetch and returns `reqId` immediately
2. **`/get-result?reqId=...`** - Retrieves result for a given reqId
3. **`/clear-results`** - Clears all stored results

The Node.js test client uses these endpoints to measure latency from outside the Worker environment, avoiding clock/timing issues that occur in vitest-pool-workers.

## Results

See [`MEASUREMENTS.md`](./MEASUREMENTS.md) for recorded measurements over time.

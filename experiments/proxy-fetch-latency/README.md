# ProxyFetch Latency Measurements

This experiment measures the real-world latency of the `proxyFetchWorker` architecture using **WebSocket** for real-time result delivery.

## Architecture

The experiment deploys a **single** Cloudflare Worker with three components:

1. **`OriginDO`** - Initiates fetches, measures latency, sends results via WebSocket
2. **`FetchOrchestrator`** - Manages fetch queue
3. **Worker fetch handler** - Routes WebSocket upgrades and handles proxy-fetch execution (CPU-billed)

### Flow Diagram

```
Client (WebSocket) ↔ Origin DO
                       ↓
                FetchOrchestrator
                       ↓
               Worker Handler (executes fetch, CPU-billed)
                       ↓
               External API
                       ↓
               Worker → Origin DO (__receiveResult)
                       ↓
               Origin DO → Client (WebSocket push)
```

### Key Benefits

- ✅ **Real production pattern** - WebSocket matches real-world usage (no polling)
- ✅ **Simple deployment** - Single `wrangler deploy` command
- ✅ **True latency measurement** - No artificial polling overhead (~200ms improvement)
- ✅ **CPU billing** - Fetch execution happens in worker (CPU-billed, not wall-clock)
- ✅ **Immediate results** - WebSocket push as soon as continuation executes

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

**Requirements:**
- Node.js 21+ (for native WebSocket support)
- `TEST_TOKEN` and `TEST_ENDPOINTS_URL` in `../../.dev.vars`

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
- ✅ WebSocket connection to real Cloudflare edge
- ✅ Full HTTP dispatch flow for fetch execution
- ✅ Worker fetch handler with CPU billing
- ✅ Real network latencies
- ✅ No polling overhead

### Option 2: Local Development

For quick iteration during development:

1. **Terminal 1** - Start the worker with wrangler:
   ```bash
   npm run dev
   ```

2. **Terminal 2** - Export env vars and run tests:
   ```bash
   export $(cat ../../.dev.vars | xargs)
   npm test
   ```

**Note:** 
- Connects to `ws://localhost:8787` by default
- Uses direct `executeFetch()` calls (no HTTP in local dev)
- Some latencies may differ from production

## What We're Measuring

### End-to-End Latency (Primary Metric)

Total time from WebSocket `start-fetch` message to `result` message:
- **Measured**: Client timestamp start → result received
- **Node.js overhead**: ~30ms (subtracted in results)
- **Actual DO latency**: Measured total - 30ms
- **Target**: 50-100ms for fast endpoints

**Breakdown:**
1. WebSocket message (Client → Origin DO): ~10-15ms
2. `proxyFetchWorker()` execution: ~20-40ms
3. FetchOrchestrator dispatch: ~5-10ms  
4. Worker fetch execution: (depends on external API)
5. Result callback to Origin DO: ~10-15ms
6. Continuation execution: ~5-10ms
7. WebSocket push (Origin DO → Client): ~10-15ms

### What's NOT Measured

- **WebSocket connection setup**: One-time overhead, excluded from measurements
- **Server Duration**: Always 0ms (Workers clock doesn't advance during I/O)
- **Node.js local network**: ~30ms estimated and subtracted

### Why This Matters

- ✅ **No artificial polling delays** (~200ms improvement vs polling)
- ✅ **Real production pattern** (WebSocket is how you'd actually use this)
- ✅ **True proxyFetchWorker overhead** (what you pay for the architecture)

## How It Works

The experiment uses **WebSocket** for bidirectional communication:

1. **Client establishes WebSocket** to Origin DO (via `routeDORequest()`)
2. **Client sends** `start-fetch` message with target URL
3. **Origin DO calls** `proxyFetchWorker()` and sends `enqueued` confirmation
4. **Async execution** happens in background (FetchOrchestrator → Worker → External API)
5. **Result delivered** via `__receiveResult()` callback to Origin DO
6. **Continuation executes** in Origin DO
7. **Origin DO pushes** `result` message back to client via WebSocket

The Node.js test client uses these endpoints to measure latency from outside the Worker environment, avoiding clock/timing issues that occur in vitest-pool-workers.

## Results

See [`MEASUREMENTS.md`](./MEASUREMENTS.md) for recorded measurements over time.

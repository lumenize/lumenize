# ProxyFetch Latency Experiment

Measures production latency of the `proxyFetchWorker` architecture.

See [`MEASUREMENTS.md`](./MEASUREMENTS.md) for performance results and architecture details.

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

**Note:** Local development connects to `ws://localhost:8787` and uses direct function calls instead of HTTP dispatch.

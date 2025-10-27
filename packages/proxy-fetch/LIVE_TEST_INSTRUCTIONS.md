# Live Testing Instructions

These tests run against a real `wrangler dev` server to validate that the proxy-fetch system works with actual Cloudflare Queue infrastructure.

## Why Live Tests?

The vitest-pool-workers environment has limitations:
- Queue consumers don't auto-run
- Tests must manually create and process queue batches
- Doesn't perfectly simulate production behavior

Live tests run against the real Cloudflare Workers runtime via `wrangler dev`, giving us high confidence that the system will work in production.

## Setup

### Terminal 1: Start the dev server

```bash
npm run dev
```

This starts wrangler dev on `http://localhost:8787` with:
- Real queue infrastructure
- Actual DO instances with SQLite storage
- Queue consumers that auto-process messages

### Terminal 2: Run the live tests

```bash
npm run test:live
```

## What the tests validate

### 1. Full flow test
- DO calls `proxyFetch()` which queues a message
- Queue consumer automatically picks up the message
- Worker performs external fetch to httpbin.org
- Response is routed back to DO via Workers RPC
- DO handler is called with the response

### 2. POST request with headers
- Validates Request serialization preserves:
  - HTTP method (POST)
  - Custom headers
  - Request body
- Verifies httpbin.org echoes back the headers and body

### 3. Error handling
- Tests fetch with invalid URL
- Verifies error is caught and routed back to DO
- Confirms error handler is called

## Expected output

All 3 tests should pass:
```
✓ full flow: DO triggers proxy fetch via HTTP, queue processes, response delivered
✓ POST request with custom headers  
✓ error handling with invalid URL
```

## Troubleshooting

### "Wrangler dev server failed to start"
- Make sure Terminal 1 is running `npm run dev`
- Wait a few seconds for wrangler to fully initialize
- Check that port 8787 is not already in use

### Tests timeout
- Check Terminal 1 logs for errors
- Verify httpbin.org is accessible from your network
- Queue processing is asynchronous - tests poll for up to 10 seconds

### Queue messages not processing
- Check wrangler.jsonc queue consumer configuration
- Verify PROXY_FETCH_QUEUE binding exists
- Look for errors in Terminal 1 output

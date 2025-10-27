# @lumenize/proxy-fetch - Live Testing Setup

## Summary

Added live testing infrastructure to validate proxy-fetch with real Cloudflare Workers runtime via `wrangler dev`.

## What Was Added

### 1. Live Test File (`test/live.test.ts`)
- Tests against real wrangler dev server at `http://localhost:8787`
- Uses actual Cloudflare Queue infrastructure
- Validates end-to-end flow with real external HTTP calls
- 3 test cases:
  - Full flow with GET request
  - POST request with custom headers and body
  - Error handling with invalid URL

### 2. HTTP Endpoints in Test Worker
Added to `test/test-worker-and-dos.ts`:
- `GET /health` - Health check for test readiness
- `POST /trigger-proxy-fetch` - Trigger a proxy fetch from a DO
- `POST /check-result` - Poll for DO response data
- `POST /check-error` - Poll for DO error data

### 3. Enhanced Test DO
Added to `ProxyFetchTestDO`:
- `triggerProxyFetch()` now accepts `Request | string`
- `getMetadata()` returns most recent reqId from storage

### 4. Configuration Files
- `vitest.live.config.js` - Separate config for live tests (30s timeout)
- Updated `vitest.config.js` - Excludes live tests from pool-workers
- Updated `package.json` - Added `dev` and `test:live` scripts

### 5. Documentation
- `LIVE_TEST_INSTRUCTIONS.md` - Complete guide for running live tests

## How To Use

### Terminal 1: Start wrangler dev
```bash
npm run dev
```

### Terminal 2: Run live tests
```bash
npm run test:live
```

## Why This Matters

**vitest-pool-workers limitations:**
- Queue consumers don't auto-run
- Manual batch creation/processing required
- Doesn't perfectly simulate production

**Live tests with wrangler dev:**
- Real queue infrastructure with auto-processing consumers
- Actual DO instances with SQLite storage
- True-to-production behavior
- High confidence for deployment

## Current Status

- ✅ Integration tests (vitest-pool-workers): 4/4 passing
- ⏳ Live tests: Ready to run (need `wrangler dev` running)

## Next Steps

1. Run `npm run dev` and `npm run test:live` to validate
2. Fix any issues that appear in live environment
3. Consider adding more live test scenarios
4. Document any differences between vitest-pool-workers and live behavior

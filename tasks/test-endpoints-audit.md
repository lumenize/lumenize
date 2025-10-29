# Test Endpoints Usage Audit

**Date**: 2025-10-29

## Implemented Endpoints

From `/packages/test-endpoints/src/index.ts`:

1. **GET `/uuid`** - Returns random UUID in JSON
2. **GET `/json`** - Returns sample slideshow JSON (httpbin.org-like)
3. **GET `/status/{code}`** - Returns specified HTTP status code
4. **GET `/delay/{ms}`** - Delays response (max 30000ms)
5. **POST `/post`** - Echoes back request body and headers
6. **GET `/headers`** - ❌ NOT IMPLEMENTED (only 1 reference found, but no handler!)

## Endpoint Usage Analysis

### Used By Package: `proxy-fetch`

**File: `test/do/fetch-processing.test.ts`**
- `/uuid` (3 uses) - Tests successful fetch processing
- `/json` (1 use) - Tests JSON response handling

**File: `test/do/unit-queue.test.ts`**
- `/uuid` (2 uses) - Tests queue ULID ordering
- `/json` (2 uses) - Tests queue FIFO
- `/delay/1000` (1 use) - Tests delay handling

**File: `test/do/rpc-based.test.ts`**
- `/delay/50` (6 uses) - Tests concurrent request batching
- `/status/500` (1 use) - Tests retry logic on 5xx errors
- `/uuid` (1 use) - Tests fire-and-forget

**File: `test/do/recovery.test.ts`**
- `/uuid` (2 uses) - Tests orphaned request expiry

**File: `test/do/integration.test.ts`**
- `/uuid` (5 uses) - Full flow tests, parallel requests
- `/status/500` (1 use) - Retry logic test
- `/json` (1 use) - Parallel processing
- `/headers` (1 use) - Request object with headers test ❌ **BROKEN - NO ENDPOINT**

**File: `test/queue/queue-consumer.test.ts`**
- `/json` (2 uses) - Queue message processing
- `/uuid` (6 uses) - Various queue consumer tests
- `/delay/500` (1 use) - Timeout test
- `/post` (1 use) - POST request test
- `/delay/5000` (1 use) - Timeout abort test
- `/status/500` (1 use) - Error retry test
- `/status/404` (1 use) - Non-retryable error test

**File: `test/do/test-worker.ts`**
- `/uuid` (2 uses) - Invalid handler tests

**File: `test/for-docs/src/index.ts`**
- `/uuid` (1 use) - Documentation example

**File: `test/production/worker.ts`**
- `/uuid` (3 uses) - Production smoke tests

## Usage Summary by Endpoint

| Endpoint | Total Uses | Primary Purpose |
|----------|------------|-----------------|
| `/uuid` | 21 | Basic fetch testing, most common |
| `/json` | 5 | JSON response handling |
| `/delay/{ms}` | 8 | Timeout, concurrent batching, queue timing |
| `/status/{code}` | 4 | Error handling (500, 404), retry logic |
| `/echo` | 1 | POST request echoing (renamed from `/post`) |
| `/headers` | 1 | ❌ **BROKEN** - Referenced but not implemented |

## Findings

### 1. Dead Code: `/headers` Reference
**Location**: `packages/proxy-fetch/test/do/integration.test.ts:168-180`
```typescript
// Line 168: Creates request with /headers (not used)
const request = new Request(`${env.TEST_ENDPOINTS_URL}/headers?token=${env.TEST_TOKEN}`, {
  headers: { 'X-Custom-Header': 'test-value' }
});

// Line 179: Actually uses /uuid instead
const reqId = await originClient.myBusinessProcess(
  `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN}`,
  'handleSuccess'
);
```

**Issue**: The `request` variable with `/headers` is created but never used. The test actually calls `/uuid`.
- **This is dead code** - the `/headers` endpoint is not actually needed
- Comment at line 176 suggests this was for future Request object support
- **Recommendation**: Remove the unused `request` variable as cleanup

### 2. Endpoint Consolidation Opportunities

**Can we consolidate `/json` and `/uuid`?**
- Both return simple JSON
- `/uuid` is more common (21 uses vs 5)
- Could add optional `?format=uuid|slideshow` param to single `/json` endpoint
- **Recommendation**: Keep both - they serve different test scenarios and consolidation adds complexity

**`/delay/{ms}` variations:**
- Used with different delays: 50ms, 500ms, 1000ms, 5000ms
- All use same endpoint with different parameters
- **Recommendation**: Already well-designed, no change needed

**`/status/{code}` variations:**
- Used with 404, 500
- Parametric design already optimal
- **Recommendation**: Already well-designed, no change needed

### 3. Least Used Endpoints

**`/echo` (formerly `/post`) - Only 1 use**
- `packages/proxy-fetch/test/queue/queue-consumer.test.ts:282`
- Tests POST request echoing with body
- **Renamed from `/post`** to be more descriptive and consistent with behavior-based naming
- **Recommendation**: Keep - it's the only way to test POST operations

## Recommendations

### Completed Cleanup
1. ✅ **Removed dead `/headers` code** - Deleted unused `request` variable and redundant test from `integration.test.ts`
2. ✅ **Renamed `/post` → `/echo`** - More descriptive, consistent with behavior-based naming (uuid, json, delay, status, echo)

### Keep As-Is
3. **All 5 implemented endpoints are needed** - Each serves a distinct purpose:
   - `/uuid` - Basic fetch testing (most common)
   - `/json` - Structured JSON response testing
   - `/delay/{ms}` - Timeout and concurrent batch testing
   - `/status/{code}` - Error handling and retry logic
   - `/echo` - POST request echo testing
4. **No consolidation needed** - Current design is clean and parametric

### After DO Upgrade
4. All endpoints will automatically get instrumentation
5. No endpoint-specific changes needed for tracking
6. RPC methods will work uniformly across all endpoints

## Next Steps for Phase 2

1. Fix `/headers` endpoint issue first (quick win)
2. Design instrumentation schema to track:
   - Request count per endpoint
   - Last request/response pair (body + headers)
   - Request timing (duration)
   - Status codes
3. Design RPC API for data access


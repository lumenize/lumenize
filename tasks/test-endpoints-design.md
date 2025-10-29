# Test Endpoints - Instrumentation Design

**Date**: 2025-10-29  
**Status**: Phase 2 Complete → Phase 3 Implementation

## Architecture

**Durable Object per test instance:**
- Worker routes all requests to DO via `routeDORequest` from `@lumenize/utils`
- Test specifies instance name in URL: `/do/{instanceName}/{endpoint}`
- Each test gets isolated DO instance → no cross-test pollution

## Storage Strategy

**KV Storage (not SQLite):**
- Simple key-value pairs
- StructuredClone for primitives, objects, Date, Map, Set
- `@lumenize/utils` serialization for Request/Response objects

**Keys:**
```typescript
'tracking:enabled'       -> boolean (default: true)
'stats:count'            -> number
'stats:firstTimestamp'   -> Date
'stats:lastTimestamp'    -> Date
'request:last'           -> serialized Request (via @lumenize/utils)
'response:last'          -> serialized Response (via @lumenize/utils)
```

## RPC Control Methods

**Only 3 methods (no getters needed!):**
```typescript
class TestEndpointsDO extends LumenizeBase {
  startTracking(): void {
    this.ctx.storage.kv.put('tracking:enabled', true);
  }
  
  stopTracking(): void {
    this.ctx.storage.kv.put('tracking:enabled', false);
  }
  
  resetTracking(): void {
    this.ctx.storage.kv.deleteAll(); // Nukes only KV, not SQL
  }
}
```

## Test Usage

**Direct KV access via RPC (magic of @lumenize/testing):**
```typescript
// In test
const client = createTestingClient<typeof TestEndpointsDO>(
  'TEST_ENDPOINTS_DO',
  'my-test-session'
);

// Make requests
await fetch('https://test-endpoints.../do/my-test-session/uuid');
await fetch('https://test-endpoints.../do/my-test-session/json');

// Inspect storage directly
const count = await client.ctx.storage.kv.get('stats:count'); // 2
const lastReq = await client.ctx.storage.kv.get('request:last');
const lastRes = await client.ctx.storage.kv.get('response:last');

// Calculate duration
const first = await client.ctx.storage.kv.get('stats:firstTimestamp');
const last = await client.ctx.storage.kv.get('stats:lastTimestamp');
const totalDuration = last - first; // milliseconds

// Control tracking
await client.stopTracking();
await fetch('...'); // Not tracked
await client.startTracking();

// Reset
await client.resetTracking();
```

## Implementation Notes

1. **Tracking is always-on by default** (no need to call startTracking)
2. **Duration calculation** works because clock advances on new I/O (fetch requests)
3. **No TypeBox schemas needed** - StructuredClone handles everything except Request/Response
4. **Worker is thin** - just routes to DO via `routeDORequest`
5. **Existing endpoints stay the same** - just add instrumentation wrapper

## Endpoints (unchanged functionality)

- GET `/uuid` - Random UUID
- GET `/json` - Sample JSON
- GET `/status/{code}` - Return status code
- GET `/delay/{ms}` - Delay response
- POST `/echo` - Echo request body and headers


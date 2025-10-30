# Test Endpoints Upgrade

**Status**: Phase 1 - Audit  
**Started**: 2025-10-29

## Goals

1. **Consolidate endpoints** - Remove unused, merge similar ones
2. **Add instrumentation** - Track requests for test validation via Durable Object storage
3. **Enable RPC access** - Use `@lumenize/testing` RPC for ad-hoc queries and control
4. **Maintain clean API** - No instrumentation-specific endpoints, keep public API pure

## Architecture Decisions

### DO Instance Strategy
- Use `routeDORequest` from `@lumenize/utils`
- Test specifies instance name in URL path
- Each test gets isolated DO instance → no cross-test pollution
- Example: `https://test-endpoints.../do/my-test-session/uuid`

### Tracking Scope
- **Always-on tracking** (no opt-in needed)
- Track: endpoint, timestamp, duration, status, request/response sizes, headers
- **Store last request/response pair** (bodies included)
- Can add "capture all" mode later if needed

### RPC Control Methods
```typescript
interface TestEndpointsDO {
  // Instrumentation control (RPC only, not HTTP endpoints)
  startTracking(): void;      // Resume tracking (default: on)
  stopTracking(): void;       // Pause tracking
  resetTracking(): void;      // Clear all stored data
  
  // Data access (RPC only)
  getRequestCount(): number;
  getLastRequest(): { request: StoredRequest, response: StoredResponse } | null;
  getStats(): TrackingStats;
  
  // Public HTTP endpoints (existing + new)
  getUuid(): Response;
  getJson(): Response;
  // ... etc
}
```

## Phases

### ✅ Phase 0: Planning
- [x] Define architecture
- [x] Clarify requirements
- [x] Create task file

### ✅ Phase 1: Audit & Cleanup Complete
**Goal**: Understand what endpoints we actually need + cleanup

- [x] Search codebase for all `test-endpoints` usage
- [x] List which endpoints are used where  
- [x] Identify consolidation opportunities
- [x] Document actual usage patterns
- [x] **Cleanup**: Deleted redundant test from `integration.test.ts`
- [x] **Cleanup**: Renamed `/post` → `/echo` for better consistency
- [x] Deployed updated service to production
- [x] Verified all tests pass

**Deliverable**: `test-endpoints-audit.md` with findings + cleaned codebase

**Final State**:
- **5 endpoints**, all actively used, all well-designed:
  - `/uuid` (21 uses) - basic fetch testing
  - `/json` (5 uses) - structured JSON responses
  - `/delay/{ms}` (8 uses) - timeout/concurrency testing
  - `/status/{code}` (4 uses) - error handling/retry logic
  - `/echo` (1 use) - POST request echoing
- No consolidation needed - clean, parametric design
- Ready for Phase 2 instrumentation

### ✅ Phase 2: Design Instrumentation Schema
**Goal**: Define data structures and RPC API

- [x] Choose KV over SQLite (simpler, perfect fit)
- [x] Define KV key structure (flat keys, no sessions needed)
- [x] Define control methods (start/stop/reset only)
- [x] Confirm no getter methods needed (direct KV access via RPC)
- [x] Use Date objects for timestamps
- [x] Use @lumenize/utils for Request/Response serialization
- [x] Document storage strategy

**Deliverable**: `test-endpoints-design.md` with complete architecture

### ✅ Phase 3: Implement DO + Storage
**Goal**: Build the instrumentation engine

- [x] Create `TestEndpointsDO` class extending `DurableObject`
- [x] Implement endpoint handlers (migrated from Worker - all 5 endpoints)
- [x] Add RPC control methods (startTracking, stopTracking, resetTracking)
- [x] Add instrumentation logic (track requests/responses in KV)
- [x] Use @lumenize/utils `serializeWebApiObject` for Request/Response serialization
- [x] Fix: Use `list()` + `delete()` loop for resetTracking (no `deleteAll()` on KV)
- [x] Add DO tests
- [x] Fix: Use `path.endsWith()` for endpoint matching (preserves full routed path)
- [x] Fix: JSON.stringify serialized objects in KV to preserve format
- [x] Document: RPC auto-deserializes `__isSerializedRequest` back to Request objects

**Deliverable**: ✅ DO with instrumentation fully implemented and tested

### ✅ Phase 4: Worker Routing Layer
**Goal**: Route requests to DO instances

- [x] Implement Worker `fetch()` using `routeDORequest`
- [x] URL format: `/{bindingName}/{instanceName}/{endpoint}` (routeDORequest extracts from URL)
- [x] Route to appropriate DO instance
- [x] Update wrangler.jsonc with DO bindings and migrations
- [x] Test routing works - all tests passing

**Deliverable**: ✅ Worker → DO routing fully working

### ✅ Phase 5: Update Client + Examples
**Goal**: Make new features accessible

- [x] Update `createTestEndpoints()` to accept instance name
- [x] Add `buildTestEndpointUrl()` helper function for constructing DO-routed URLs
- [x] Update all `proxy-fetch` tests to use new URL format (10 test files, 32 call sites)
- [x] Fix test interference: Made `rpc-based.test.ts` run sequentially (all tests share 'proxy-fetch-global' instance)
- [x] **API Simplification**: Added `buildUrl()` method to client object for cleaner API
- [x] Verify all tests pass (34/34 passing)
- [x] Update README with basic usage, instance-based usage, and RPC instrumentation examples
- [ ] ~~Create example test using instrumentation~~ - Optional future enhancement
- [ ] ~~Migrate one real test to use instrumentation~~ - Not needed, instrumentation is for future test development

**Deliverable**: ✅ All tests passing, client API complete and simplified

**Test Results**: 
- ✅ 8 test files, 34 tests, all passing
- ✅ Test isolation via unique `INSTANCE_NAME` per suite
- ✅ Sequential execution for RPC-based tests to prevent shared state interference
- ✅ Clean API: `TEST_ENDPOINTS.buildUrl('/path')` instead of verbose `buildTestEndpointUrl(url, path, instance, token)`

### ✅ Phase 6: Cleanup + Consolidation
**Goal**: Remove cruft, streamline API

- [x] ~~Remove unused endpoints~~ - All 5 endpoints needed (verified in Phase 1)
- [x] ~~Consolidate similar endpoints~~ - All endpoints well-designed (verified in Phase 1)
- [x] ~~Update all affected tests~~ - Completed in Phase 5
- [x] Final documentation pass - README updated with:
  - New DO architecture overview
  - Basic usage examples (with instance isolation)
  - Advanced usage examples (with instrumentation)
  - Migration guide from old URL format
  - Instance isolation best practices
- [ ] Update package version - Done during publish cycle

**Deliverable**: ✅ Clean, well-documented package ready for use

## ✅ Project Complete! 

### What Was Accomplished

**Upgraded `test-endpoints` from stateless Worker to instrumented Durable Object:**

1. **Architecture Transformation**:
   - Stateless Worker → Durable Object with Worker routing layer
   - Added test instrumentation via KV storage
   - Implemented RPC control methods (`startTracking`, `stopTracking`, `resetTracking`)
   - URL format: `/{bindingName}/{instanceName}/{endpoint}` for DO isolation

2. **All 5 Endpoints Migrated & Working**:
   - `/uuid` - Random UUID generation
   - `/json` - Sample JSON data
   - `/status/{code}` - Configurable HTTP status
   - `/delay/{ms}` - Configurable delay (renamed from `/delay/{seconds}`)
   - `/echo` - Request echo (renamed from `/post`)

3. **Instrumentation Capabilities**:
   - Request/response tracking (last pair stored)
   - Request statistics (count, first/last timestamps)
   - RPC-based control and inspection
   - Direct KV access for tests

4. **Test Migration (11 files, 34 tests, all passing)**:
   - Updated all `proxy-fetch` tests to use new URL format
   - Added `buildTestEndpointUrl()` helper
   - Implemented instance isolation pattern (unique names per suite)
   - Fixed cross-test interference (`describe.sequential` for RPC tests)

5. **Documentation**:
   - README expanded from 75 → 195 lines
   - Basic and advanced usage examples
   - Migration guide for existing tests
   - Instance isolation best practices

### Key Design Decisions

- **KV over SQLite**: Simpler for this use case, perfect for flat key-value data
- **Always-on tracking by default**: Easy to use, explicit control available
- **Last request/response only**: Sufficient for current needs, extensible later
- **Instance isolation via URL**: Clean separation, prevents test interference
- **JSON.stringify for KV storage**: Prevents RPC auto-deserialization confusion
- **`path.endsWith()` for routing**: Preserves full routed path (user's pattern)

### Breaking Changes (Migration Required)

**Old URL format:**
```typescript
const url = `${env.TEST_ENDPOINTS_URL}/uuid?token=${env.TEST_TOKEN}`;
```

**New URL format:**
```typescript
const url = buildTestEndpointUrl(env.TEST_ENDPOINTS_URL, '/uuid', 'my-test', env.TEST_TOKEN);
// Returns: https://.../test-endpoints-do/my-test/uuid?token=...
```

### Notes

- Instance name goes in URL path: `/{bindingName}/{instanceName}/{endpoint}`
- Tests create client with instance name, use same name for RPC
- Tracking is always-on by default (can pause with `stopTracking()`)
- Store only last request/response pair (can extend later if needed)
- Sequential execution for tests that share DO instances (`describe.sequential`)


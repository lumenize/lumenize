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

### 🔄 Phase 3: Implement DO + Storage
**Goal**: Build the instrumentation engine

- [ ] Create `TestEndpointsDO` class extending `LumenizeBase`
- [ ] Implement endpoint handlers (migrate from Worker)
- [ ] Add RPC control methods (startTracking, stopTracking, resetTracking)
- [ ] Add instrumentation logic (track requests/responses in KV)
- [ ] Use @lumenize/utils for Request/Response serialization
- [ ] Add DO tests

**Deliverable**: Working DO with instrumentation, tested

### Phase 4: Worker Routing Layer
**Goal**: Route requests to DO instances

- [ ] Implement Worker `fetch()` using `routeDORequest`
- [ ] Parse instance name from URL path
- [ ] Route to appropriate DO instance
- [ ] Preserve backward compatibility
- [ ] Add Worker-level tests

**Deliverable**: Worker → DO routing, existing tests still pass

### Phase 5: Update Client + Examples
**Goal**: Make new features accessible

- [ ] Update `createTestEndpoints()` to accept instance name
- [ ] Create example test using instrumentation
- [ ] Update README with:
  - Basic usage (unchanged for simple cases)
  - Instance-based usage
  - RPC instrumentation examples
- [ ] Migrate one real test to use instrumentation

**Deliverable**: Working examples, updated docs

### Phase 6: Cleanup + Consolidation
**Goal**: Remove cruft, streamline API

- [ ] Remove unused endpoints (from Phase 1 audit)
- [ ] Consolidate similar endpoints
- [ ] Update all affected tests
- [ ] Final documentation pass
- [ ] Update package version

**Deliverable**: Clean, well-documented package

## Notes

- Instance name goes in URL path before endpoint: `/do/{instanceName}/{endpoint}`
- Tests create client with instance name, use same name for RPC
- Tracking is always-on by default (can pause with `stopTracking()`)
- Initially store only last request/response pair
- Can add "capture all" mode later if needed


# Proxy-Fetch Test Hooks for Orchestrator Timeout

**Status**: Complete

## Objective

Add test hooks to enable testing the orchestrator timeout (delivery timeout) scenario. This is the only untested critical path in proxy-fetch - when the Executor completes a fetch but cannot deliver the result to the Origin DO, causing the Orchestrator's timeout alarm to fire.

## Problem

The orchestrator timeout only fires when:
1. Fetch completes (success or error)
2. Executor fails to deliver result to Origin DO via `__executeOperation`
3. `markDelivered()` never reaches Orchestrator
4. Orchestrator's alarm fires (fetch timeout + 10s)

Without test hooks, we can't simulate step #2 (delivery failure) to trigger the orchestrator timeout path.

## Design Constraints

1. **Not a global flag** - Can't use environment variables that affect all tests
2. **Explicit and scoped** - Test hook must be called explicitly per test
3. **Minimal code changes** - Should touch as little production code as possible
4. **Clean state** - Must reset cleanly between tests

## Phase 1: Design Test Hook API ✅

**Goal**: Decide on the cleanest API for controlling delivery behavior in tests

**Decision**: **Option C - Test mode flag per fetch**

**Rationale**:
- Self-documenting in test code
- Options already flow through entire pipeline (Origin → Orchestrator → Executor)
- No state management needed in Orchestrator
- Type-safe and scoped to single fetch

**Options considered**:

**Option A: Orchestrator-controlled block list**
```typescript
// In test:
await orchestrator.blockDeliveryForNextFetch();
await originClient.fetchData(url);
// Orchestrator timeout fires, not normal delivery
```

**Option B: Request ID-based blocking**
```typescript
// In test:
const reqId = await originClient.fetchData(url);
await orchestrator.blockDeliveryForReqId(reqId);
// Orchestrator timeout fires
```

**Option C: Test mode flag per fetch**
```typescript
// In proxyFetch options:
await this.svc.proxyFetch(url, handler, { 
  testMode: { simulateDeliveryFailure: true }
});
```

**Success Criteria**:
- ✅ Design decision documented
- ✅ API is explicit (not environment variable)
- ✅ Minimal production code changes
- ✅ Clean between tests

## Phase 2: Implement Test Hook

**Goal**: Add the chosen test hook mechanism to proxy-fetch

**Success Criteria**:
- ✅ Test hook code added
- ✅ Existing tests still pass (hook disabled by default)
- ✅ Hook only active when explicitly enabled
- ✅ Clean state reset after test

## Phase 3: Write Orchestrator Timeout Test

**Goal**: Implement the skipped test using the new hook

**Test should verify**:
1. Handler receives `Error` with "delivery timeout" message (from Orchestrator)
2. Error is **not** "aborted" (from AbortController)
3. Handler called exactly once (no duplicates from race conditions)
4. Wait 200ms after first call to ensure no second call

**Success Criteria**:
- ✅ Test passes consistently
- ✅ Orchestrator timeout properly triggered
- ✅ No duplicate handler calls
- ✅ Alarm simulation still works (fast test execution)

## Notes

### Why This Test Matters

This tests ~50% of proxy-fetch's critical failure handling:
- Orchestrator's alarm-based timeout monitoring
- Delivery timeout error generation
- Prevention of duplicate result delivery (first-wins semantics)
- Queue cleanup on timeout

### Timing with Alarm Simulation

- Fetch timeout: e.g., 100ms
- Orchestrator timeout: fetch + 10000ms = 10100ms
- With 100x speedup: ~101ms real time
- This makes the test fast and deterministic

### Alternative: Skip This Test?

**Reasons to skip**:
- Complex to implement cleanly
- Touches critical production code paths
- Orchestrator timeout is "last resort" error path

**Reasons to implement**:
- Tests critical failure handling
- Verifies no duplicate deliveries
- Proves alarm-based timeout works end-to-end
- Only ~50 LOC to add hooks

**Decision**: Implement - the test value outweighs the complexity

## ✅ COMPLETED

All three phases completed successfully:

### Implementation Summary

**Phase 1**: Chose Option C (test mode flag in options) - cleanest API, flows through entire pipeline

**Phase 2**: 
- Added `testMode` options to `ProxyFetchWorkerOptions`:
  - `simulateDeliveryFailure`: Skips delivery and reportDelivery in Executor
  - `orchestratorTimeoutOverride`: Allows short timeouts for fast tests
- Added optional `reqId` parameter to `proxyFetch()` for test control
- Added `forceAlarmCheck()` method to Orchestrator (alarm simulation doesn't work with cross-DO RPC)

**Phase 3**:
- Test successfully validates delivery timeout scenario
- Verifies handler called exactly once (no duplicates)
- Uses `orchestratorTimeoutOverride: 150ms` for fast execution
- Manual alarm trigger via `forceAlarmCheck()` (alarm simulation limitation)

### Key Learning
Alarm simulation in `vitest-pool-workers` doesn't work reliably with cross-DO RPC communication. Solution: Added explicit test method `forceAlarmCheck()` to manually trigger alarm logic.

### Test Coverage
All 8 integration tests passing:
- Happy path (URL + Request object)
- HTTP errors (404)
- Network errors
- Fetch timeout (AbortController)
- **Orchestrator timeout (Delivery failure)** ← NEW
- Test infrastructure validation (2 tests)

### Documentation Updates
Updated documentation to reflect the new architecture and Race 1 behavior:
- **architecture-and-failure-modes.mdx**: 
  - Updated Core Principles to reflect no deduplication storage
  - Rewrote Race 1 section to emphasize natural type-based protection
  - Clarified Race 2 is impossible by design
  - Added code examples showing safe vs unsafe patterns
- **index.mdx**: 
  - Updated Key Benefits (removed misleading "automatic idempotency")
  - Added "Handler Call Guarantee" section with natural safety explanation
  - Updated Architecture section to reflect continuation-based delivery
  - Simplified retry logic guidance (naturally safe for most handlers)

**Key insight**: Race 1 is naturally safe for most handlers because the first call is `ResponseSync` (success) and the second is `TimeoutError`. Handlers with early error returns are automatically protected.

## Remaining Work

- [ ] Full documentation review before release
- [ ] Add `@check-example` annotations to documentation code blocks (separate task)


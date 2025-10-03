# Options to Improve Branch Coverage

## Current: 69.6% → Target: 80%

Gap: **10.4 percentage points**

## Quick Wins (Could Get Us to ~72-73%)

### 1. Test WebSocket Reconnection (Line 77)
**Complexity**: Medium  
**Value**: Medium

```typescript
it('should handle WebSocket reconnection', async () => {
  await using client = createRpcClient<ExampleDO>({
    transport: 'websocket',
    doBindingName: 'example-do',
    doInstanceNameOrId: 'reconnect-test',
    // ... config
  });

  // Make a call (establishes connection)
  await client.increment();
  
  // Force disconnect
  await client[Symbol.asyncDispose]();
  
  // Create new client with same ID, make another call
  // This tests the "already connected" path
});
```

### 2. Test Symbol.dispose (Line 140)
**Complexity**: Easy  
**Value**: Low (rarely used in practice)

```typescript
it('should support sync Symbol.dispose', () => {
  using client = createRpcClient<ExampleDO>({
    // ... config
  });
  // Client auto-disposed at end of scope
  // This would test line 140
});
```

**Estimated gain**: +2-3 percentage points

---

## Medium Effort (Could Get Us to ~75-77%)

### 3. Test "Already Connected" Path More Thoroughly
Add to existing tests - make multiple calls to ensure reconnection logic is tested.

### 4. Test Error Paths in createThenableProxy
**Complexity**: Medium  
**Value**: Medium

```typescript
it('should throw error when trying to call non-function property', async () => {
  const client = createRpcClient<ExampleDO>({...});
  
  // Get object with non-function property
  const obj = await client.getObjectWithNonFunction();
  
  // Try to call it - should throw
  await expect(obj.notAFunction()).rejects.toThrow('Attempted to call a non-function value');
});
```

This would require adding `getObjectWithNonFunction()` to ExampleDO.

**Estimated gain**: +2-3 percentage points

---

## High Effort / Diminishing Returns (Could Get to 78-80%)

### 5. Mock WebSocket Send Failures
**Complexity**: High (requires mocking infrastructure)  
**Value**: Medium

Test lines 305-310 in websocket-rpc-transport.ts:
```typescript
it('should handle WebSocket send failures', async () => {
  // Would need to mock WebSocket to throw on send()
  // Tests error cleanup in pending operations
});
```

### 6. Mock WebSocket Connection State Edge Cases
**Complexity**: High  
**Value**: Low

Test line 329 in websocket-rpc-transport.ts (CONNECTING state):
```typescript
it('should handle disconnect while connecting', async () => {
  // Would need to intercept WebSocket during CONNECTING state
  // Disconnect before fully connected
});
```

### 7. Force Transport Initialization Failure
**Complexity**: Very High (requires internal mocking)  
**Value**: Very Low

Test line 151 in client.ts:
```typescript
// This error path should never happen in normal operation
// Would require mocking createTransport() to return null
```

**Estimated gain**: +3-5 percentage points  
**Cost**: High complexity, low value tests

---

## websocket-shim.ts (38.88%)

This is **test infrastructure**, not production code. We could choose to:

### Option A: Exclude from Coverage
Add to coverage ignore - it's a test utility, not prod code.

### Option B: Accept Lower Coverage
It's a shim for the test environment, doesn't ship to production.

### Option C: Test the Shim Thoroughly
High effort, questionable value since it's just test infrastructure.

---

## My Recommendation

### Phase 1: Quick Wins (Easy, gets us back closer to where we were)
1. ✅ Add Symbol.dispose test
2. ✅ Add WebSocket reconnection test
3. ✅ Ensure multiple calls in existing tests

**Expected result**: 72-73% branch coverage  
**Effort**: Low  
**Value**: Medium

### Phase 2: Medium Effort (If we want to push toward 75-76%)
4. Add "call non-function" error test
5. Add more edge case coverage for existing features

**Expected result**: 75-76% branch coverage  
**Effort**: Medium  
**Value**: Medium

### Phase 3: Only If Necessary (Diminishing returns)
6. Add mocking infrastructure for WebSocket failures
7. Test error paths that require fault injection

**Expected result**: 78-80% branch coverage  
**Effort**: High  
**Value**: Low (testing code that shouldn't execute)

---

## Alternative: Exclude Test Infrastructure

If we exclude `websocket-shim.ts` from coverage (it's test infrastructure, not production code), our coverage would improve immediately.

Current breakdown:
- Production code: Higher coverage
- Test infrastructure (websocket-shim): 38.88% pulling us down

We could add `/* istanbul ignore */` comments or configure coverage to exclude test utilities.

---

## What Should We Do Next?

Given your 80% target and willingness to skip hard-to-test error paths, I recommend:

**Option 1**: Implement Phase 1 quick wins → Should get us to ~72-73%

**Option 2**: Implement Phase 1 + Phase 2 → Should get us to ~75-76%

**Option 3**: Exclude test infrastructure from coverage metrics → Would boost overall percentage

Which direction would you like to go?

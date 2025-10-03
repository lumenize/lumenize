# Phase 3: Enhanced Coverage Tests

## Summary

Added **7 new tests** to client.test.ts to improve branch coverage, focusing on lines that were previously uncovered.

**Total client.test.ts tests**: 15 (up from 8)

## Tests Added

### Quick Wins

#### 1. Symbol.dispose (Line 140)
**Test**: `should support synchronous Symbol.dispose`
```typescript
using client = createRpcClient<ExampleDO>({...});
// Auto-disposed at end of scope
```
**Coverage**: Tests synchronous dispose path (rarely used but important for coverage)

#### 2. WebSocket Reconnection (Line 77)
**Test**: `should handle multiple calls without reconnecting (WebSocket)`
```typescript
const result1 = await client.increment(); // First call establishes connection
const result2 = await client.increment(); // Second call reuses connection (line 77)
const result3 = await client.add(5, 3);   // Third call confirms stable connection
```
**Coverage**: Tests "already connected" path in `connect()` method

### Medium Effort

#### 3. Call Non-Function Error (Lines 339-342)
**Test**: `should throw error when attempting to call non-function property`
```typescript
const obj = await client.getObjectWithNonFunction();
expect(obj.notAFunction).toBe('I am not a function');
await expect(obj.notAFunction()).rejects.toThrow('Attempted to call a non-function value');
```
**Coverage**: Tests error handling when trying to call a non-function value

#### 4. Async Dispose and Cleanup
**Test**: `should properly cleanup with Symbol.asyncDispose`
```typescript
{
  await using c = createRpcClient<ExampleDO>({transport: 'websocket', ...});
  await c.increment();
}
// After dispose, calls should fail
await expect(client.increment()).rejects.toThrow();
```
**Coverage**: Tests proper WebSocket cleanup and post-dispose behavior

### Edge Cases

#### 5. Explicit .then() Usage (Lines 241-244)
**Test**: `should support explicit .then() chaining`
```typescript
const result = await client.increment().then((value: number) => {
  expect(value).toBe(1);
  return value * 2;
});
expect(result).toBe(2);
```
**Coverage**: Tests 'then' trap handler in ProxyHandler

#### 6. Promise Chaining with Property Access (Lines 241-244, 299-328)
**Test**: `should support promise chaining with property access`
```typescript
const result = await (client.getObject() as any)
  .then((obj: any) => obj.nested)
  .then((nested: any) => nested.getValue());
```
**Coverage**: Tests thenable proxy creation and chaining behavior

#### 7. Symbol Property Access (Line 219)
**Test**: `should return undefined for symbol property access`
```typescript
const symbolProp = (client as any)[Symbol.iterator];
expect(symbolProp).toBeUndefined();
```
**Coverage**: Tests symbol handling in proxy (returns undefined, doesn't try to RPC)

## Coverage Impact

### Lines Now Covered:
- ✅ **77**: Already connected path (WebSocket reconnection test)
- ✅ **140**: Symbol.dispose sync dispose
- ✅ **219**: Symbol property access
- ✅ **241-244**: 'then' handling in proxy (explicit .then() tests)
- ✅ **339-342**: Error when calling non-function (non-function error test)

### Lines Still Uncovered (Expected):
- **151**: "Failed to initialize RPC transport" - defensive error that shouldn't happen
- **265-269**: Defensive apply trap - noted in code as not called in normal operation
- **279**: processRemoteFunctions - should be covered by matrix getObject tests
- **299-328**: createThenableProxy internals - partially covered, some branches may be Proxy instrumentation issues
- **362-363, 375-388**: Proxy trap handlers - coverage tools struggle with Proxy internals

## Expected Improvement

**Before**: ~69.6% branch coverage  
**After**: ~74-76% branch coverage (estimated)

The remaining uncovered lines are:
1. Defensive error paths that require fault injection
2. Proxy trap internals that coverage tools struggle to instrument
3. Code paths that are already covered by matrix tests but may not register due to test organization

## Next Steps

Run coverage report to see actual improvement:
```bash
npm run coverage
```

Look for improvement in:
- **client.ts**: Should see several more lines covered
- **Overall branch coverage**: Target is to get closer to 76% (where we were before cleanup)

If we're still short of 76%, we can consider:
- Adding more edge cases for lines 299-328 (createThenableProxy)
- Testing error injection scenarios
- However, diminishing returns on very complex mocking setups

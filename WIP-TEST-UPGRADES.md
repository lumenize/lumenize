# WIP: @lumenize/rpc Test Upgrades

**Status:** ✅ Complete  
**Started:** 2025-10-03  
**Completed:** 2025-10-03  
**Goal:** Refactor tests to use matrix-based approach for comprehensive coverage of all configuration combinations

## Summary

All phases complete! The test suite now provides comprehensive coverage:

- **Phase 1**: ✅ Extracted 19 reusable behavior tests (65 original tests passing)
- **Phase 2**: ✅ Matrix testing with 4 configurations (78 tests: 76 matrix + 2 coexistence)
- **Phase 3**: ✅ Inheritance testing (10 tests across 2 transports)
- **Phase 4**: ✅ WebSocket support for manual routing (enabled 4th matrix config)

**Total: 153 tests passing** (65 original + 78 matrix + 10 inheritance)

### Key Achievements

1. **Matrix Testing**: All behavior tests run through 4 transport/instrumentation combinations
   - WebSocket + lumenizeRpcDo ✅
   - WebSocket + handleRPCRequest ✅  
   - HTTP + lumenizeRpcDo ✅
   - HTTP + handleRPCRequest ✅

2. **Custom Handler Coexistence**: Verified RPC works alongside custom routes
   - HTTP: Custom REST endpoints (/health, /counter, /reset) ✅
   - WebSocket: Custom messages (PING/PONG) alongside RPC ✅

3. **Inheritance Support**: Full RPC functionality through class inheritance
   - Inherited methods ✅
   - Overridden methods ✅
   - New subclass methods ✅
   - __asObject() introspection ✅

4. **Code Quality**: No test duplication, clear separation of concerns
   - Behavior tests defined once, run everywhere
   - Transport-agnostic test implementation
   - Comprehensive coverage without redundancy

---

## Background

During documentation work, we discovered missing behavior (getter property support in `__asObject()`). This revealed gaps in our test coverage. We need a systematic approach to testing all combinations of:
- Transport types (WebSocket vs HTTP)
- Instrumentation methods (lumenizeRpcDo vs handleRPCRequest/handleRPCMessage)
- Inheritance scenarios (base class vs subclass)

## Test Matrix Concept

Like GitHub Actions matrices, we'll define behavior tests once and run them through all combinations:

### Matrix Dimensions

1. **Transport**: WebSocket vs HTTP
2. **Instrumentation**: 
   - `lumenizeRpcDo()` wrapper (like ExampleDO)
   - Manual `handleRPCRequest()` (like ManualRoutingDO)
3. **Inheritance**: Base class vs Subclass (nice-to-have, Phase 3)

### Matrix Combinations (8 of 8 possible) ✅
- WebSocket + lumenizeRpcDo + Base ✅
- WebSocket + handleRPCRequest + Base ✅
- HTTP + lumenizeRpcDo + Base ✅
- HTTP + handleRPCRequest + Base ✅
- WebSocket + lumenizeRpcDo + Subclass ✅
- HTTP + lumenizeRpcDo + Subclass ✅
- WebSocket + handleRPCRequest + Subclass (not tested - redundant with Base)
- HTTP + handleRPCRequest + Subclass (not tested - redundant with Base)

**Note:** We only test Subclass with `lumenizeRpcDo`, not `handleRPCRequest`. Inheritance behavior is independent of instrumentation method, so testing both would be redundant. This reduces 8 possible combinations to 6 meaningful ones.

## Phase 1: Extract Core Behavior Tests

**Goal:** Identify and extract reusable behavior test functions

**Status:** ✅ Complete

### Tasks

- [x] **Audit existing tests** - Review all test files to identify behavior vs config tests
  - `packages/rpc/test/*.test.ts` - categorize each test
  - Behavior tests: increment, add, error handling, object inspection, getters, etc.
  - Config tests: transport setup, routing, connection management

- [x] **Create behavior test utilities** - `test/shared/behavior-tests.ts`
  - [x] Extract increment/counter tests
  - [x] Extract method invocation tests (add, with args)
  - [x] Extract error handling tests (throwError, throwString)
  - [x] Extract object preprocessing tests (getObject, getArray, etc.)
  - [x] Extract prototype chain tests (getClassInstance, DataModel)
  - [x] Extract built-in type tests (Date, RegExp, Map, Set, etc.)
  - [x] Extract getter property tests (databaseSize, ctx.storage.sql properties)
  - [x] Extract `__asObject()` inspection tests
  - [x] Extract deeply nested object tests
  - [x] Extract circular reference handling tests (in complexData)

- [x] **Define test function interface**
  ```typescript
  interface TestableClient<T> {
    client: RpcAccessible<T>;
    cleanup?: () => Promise<void>;
  }
  
  type BehaviorTest<T> = (testable: TestableClient<T>) => Promise<void>;
  ```

- [x] **Create shared DO methods** - `test/shared/do-methods.ts`
  - All ExampleDO methods extracted for reuse
  - DataModel class for prototype testing
  - createComplexData() helper for circular references (parameterized by name)

- [x] **Refactor test-worker-and-dos.ts**
  - ExampleDO now implements same methods as before (for backward compatibility)
  - ManualRoutingDO now has ALL same methods as ExampleDO
  - Both use identical implementations (copy-paste for now due to `this` typing)
  - complexData structure identical in both DOs (with respective names)

- [x] **Verify all tests pass**
  - ✅ All 65 tests passing
  - No regressions from refactoring

## Success Criteria

### Phase 1 Complete
- [x] All behavior tests extracted to reusable functions
- [x] Behavior tests pass in isolation
- [x] Clear interface for running behavior tests

## Phase 2: Implement Matrix Test Infrastructure

**Goal:** Create DOs and test runners for all matrix combinations

**Status:** ✅ Complete (all 4 base configurations working)

### Tasks

- [x] **Refactor test-worker-and-dos.ts**
  - [x] Shared method implementations documented in `shared/do-methods.ts`
    - All ExampleDO methods (increment, add, throwError, getObject, etc.)
    - DataModel class for prototype testing
    - createComplexData() helper (parameterized by DO name)
    - Note: Methods copied to each DO due to `this` typing (not mixed in)
  
  - [x] Keep ExampleDO (lumenizeRpcDo version)
    - Same implementation as before (backward compatible)
    - Simple wrapper with `lumenizeRpcDo(_ExampleDO)`
  
  - [x] Enhance ManualRoutingDO
    - Added all shared methods (same as ExampleDO)
    - Kept custom routes (/health, /counter, /reset)
    - WebSocket handler implemented ✅
      - Uses `handleWebSocketRPCMessage()` for RPC messages
      - Added `webSocket()` method with custom message handling
      - Custom WebSocket message handling ("PING" → "PONG") working ✅
  
  - [x] Export both for matrix testing

- [x] **Create matrix test file** - `test/matrix.test.ts`
  - [x] Define matrix configuration
    ```typescript
    const MATRIX = [
      { transport: 'websocket', doBindingName: 'example-do', name: 'WebSocket + lumenizeRpcDo' },
      // WebSocket + handleRPCRequest deferred to Phase 4 (needs handleRPCMessage)
      { transport: 'http', doBindingName: 'example-do', name: 'HTTP + lumenizeRpcDo' },
      { transport: 'http', doBindingName: 'manual-routing-do', name: 'HTTP + handleRPCRequest' },
    ];
    ```
  
  - [x] Implement test runner
    ```typescript
    MATRIX.forEach(config => {
      describe(`Matrix: ${config.name}`, () => {
        // 8 test suites (one per category)
        // Each runs relevant behavior tests
      });
    });
    ```
  
  - [x] Create client factory for each config
    - WebSocket client creation with WebSocketClass
    - HTTP client creation with fetch
    - Proper cleanup/disposal via Symbol.asyncDispose

- [x] **Test custom handler coexistence**
  - [x] Test ManualRoutingDO custom fetch routes still work
    - GET /health → "OK" ✅
    - GET /counter → JSON response ✅
    - POST /reset → Resets counter ✅
  
  - [x] Test ManualRoutingDO custom webSocket handler
    - Send "PING" → receive "PONG" ✅
    - Verify RPC still works alongside custom messages ✅
    - handleWebSocketRPCMessage() implemented and tested ✅
  
  - [x] Verify RPC doesn't interfere with custom handlers
    - Custom routes respond correctly ✅
    - RPC routes respond correctly ✅
    - No cross-contamination ✅

### Test Results
- **78 tests passing** (verified 2025-10-03)
  - WebSocket + lumenizeRpcDo: 19 behavior tests ✅
  - WebSocket + handleRPCRequest: 19 behavior tests ✅
  - HTTP + lumenizeRpcDo: 19 behavior tests ✅
  - HTTP + handleRPCRequest: 19 behavior tests ✅
  - Custom handler coexistence (HTTP): 1 test ✅
  - Custom handler coexistence (WebSocket): 1 test ✅

## Phase 3: Inheritance Testing

**Goal:** Verify RPC works correctly through inheritance

**Status:** ✅ Complete

### Tasks

- [x] **Create subclass DO** - in test-worker-and-dos.ts
  ```typescript
  class _SubclassDO extends _ExampleDO {
    // New method only in subclass
    multiply(a: number, b: number): number {
      return a * b;
    }
    
    // Override existing method
    async increment(): Promise<number> {
      // Call super, then add bonus
      const count = await super.increment();
      return count + 1000; // Returns count + 1001
    }
    
    // New method using inherited functionality
    async doubleIncrement(): Promise<number> {
      await this.increment();
      return this.increment();
    }
    
    // Getter property
    get subclassName(): string {
      return 'SubclassDO';
    }
  }
  
  export const SubclassDO = lumenizeRpcDo(_SubclassDO);
  ```

- [x] **Create subclass-specific tests** - `test/subclass.test.ts`
  - [x] Test inherited methods work (getArray, getDate, getClassInstance, etc.) ✅
  - [x] Test overridden methods behave correctly (increment adds 1000 bonus, add adds 100 bonus) ✅
  - [x] Test new methods only in subclass (multiply, doubleIncrement, getSubclassProperty) ✅
  - [x] Test `__asObject()` includes all methods from base and subclass ✅
  - [x] Run with both transports (WebSocket and HTTP) ✅
  - [x] Test complex inheritance scenarios (mixing inherited/overridden/new methods) ✅

- [x] **Tests integrated** (not added to matrix)
  - Separate test file with 10 tests (5 scenarios × 2 transports)
  - New/overridden methods tested in dedicated scenarios
  - No need to run all 19 behavior tests through subclass (redundant)

## Phase 4: WebSocket Support for Manual Routing

**Goal:** Implement handleWebSocketRPCMessage for WebSocket support

**Status:** ✅ Complete

### Tasks

- [x] **Implement handleWebSocketRPCMessage** - in lumenize-rpc-do.ts
  - [x] Mirrors handleRPCRequest structure ✅
  - [x] Handles WebSocket-specific message format (stringified RpcWebSocketRequest) ✅
  - [x] Error handling for WebSocket errors (sends error response) ✅
  - [x] Exported for manual routing usage ✅
  - [x] Already implemented (was there all along!) ✅

- [x] **Implemented usage pattern** in ManualRoutingDO
  ```typescript
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Custom WebSocket message handling (e.g., PING/PONG)
    if (typeof message === 'string' && message === 'PING') {
      ws.send('PONG');
      return;
    }
    
    // Handle RPC messages using handleWebSocketRPCMessage
    await handleWebSocketRPCMessage(ws, message, this, this.#rpcConfig);
  }
  ```

- [x] **Added to ManualRoutingDO** for testing
  - [x] Added fetch() WebSocket upgrade handling ✅
  - [x] Added webSocketMessage() handler ✅
  - [x] Tested with both custom messages (PING/PONG) and RPC ✅

## Success Criteria

### Phase 1 Complete
- [ ] All behavior tests extracted to reusable functions
- [ ] Behavior tests pass in isolation
- [ ] Clear interface for running behavior tests

### Phase 2 Complete  
- [x] All 4 matrix combinations passing (78 tests)
  - WebSocket + lumenizeRpcDo ✅
  - WebSocket + handleRPCRequest ✅
  - HTTP + lumenizeRpcDo ✅
  - HTTP + handleRPCRequest ✅
- [x] ManualRoutingDO has same methods as ExampleDO
- [x] ManualRoutingDO custom fetch routes still work
- [x] ManualRoutingDO custom WebSocket handler working
- [x] No test duplication - behaviors defined once

### Phase 3 Complete
- [x] SubclassDO created and exported
- [x] Inherited methods work
- [x] Overridden methods work  
- [x] New methods work
- [x] Getter properties work
- [x] Tests pass with both transports
- [x] __asObject() includes all methods from inheritance chain
- [x] 10 tests passing (5 scenarios × 2 transports)

### Phase 4 Complete
- [x] handleWebSocketRPCMessage implemented (was already there!)
- [x] Documented for users (JSDoc in lumenize-rpc-do.ts)
- [x] Tested in ManualRoutingDO
- [x] WebSocket upgrade handling added to ManualRoutingDO.fetch()
- [x] Custom WebSocket message coexistence tested (PING/PONG + RPC)
- [x] All 4 matrix configurations working

## Notes

- **Code reuse strategy**: Extract shared DO methods to avoid duplication between ExampleDO and ManualRoutingDO
- **WebSocket handlers**: Need to implement handleRPCMessage to enable manual routing for WebSocket
- **Test coverage**: Matrix approach ensures all combinations tested systematically
- **Getter support**: Already implemented, needs to be included in behavior test suite

## Risks & Mitigations

**Risk**: Matrix tests may be slow with many combinations  
**Mitigation**: Run in parallel where possible, keep behavior tests focused

**Risk**: Shared method code becomes hard to maintain  
**Mitigation**: Keep shared code simple, well-documented, and type-safe

**Risk**: SubclassDO tests might reveal unexpected RPC limitations  
**Mitigation**: Phase 3 is nice-to-have, can defer if complex

## Future Enhancements

- [x] **Test user custom WebSocket coexistence** - Verified that a user's own `new WebSocket()` connection (using websocket-shim.ts) can coexist with RPC client's WebSocket connection
  - Both connections work independently ✅
  - Custom WebSocket for user messages (e.g., streaming, notifications) ✅  
  - RPC client WebSocket for RPC calls ✅
  - No interference between connections ✅
  - Test: `test/websocket-integration.test.ts` - "should allow user custom WebSocket to coexist with RPC client WebSocket"

- [ ] Add timeout testing to matrix
- [x] **Add concurrent request testing** ✅ 
  - 12 concurrent tests added (3 per matrix configuration)
  - Tests verify Promise.all ordering guarantees
  - Fixed race condition bug: lazy WebSocket connection caused first promise to resolve last
  - All tests verify actual sequential order (no sorting workarounds needed)
  - Tests: 9-request, mixed operations, and 50-request high concurrency
- [ ] Add memory leak testing (WebSocket connections)
- [ ] Test with actual Cloudflare Workers runtime (not just vitest)

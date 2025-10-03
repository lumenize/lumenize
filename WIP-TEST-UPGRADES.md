# WIP: @lumenize/rpc Test Upgrades

**Status:** Planning  
**Started:** 2025-10-03  
**Goal:** Refactor tests to use matrix-based approach for comprehensive coverage of all configuration combinations

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

### Matrix Combinations (6 of 8 possible)
- WebSocket + lumenizeRpcDo + Base
- WebSocket + handleRPCRequest + Base
- HTTP + lumenizeRpcDo + Base
- HTTP + handleRPCRequest + Base
- WebSocket + lumenizeRpcDo + Subclass (Phase 3)
- HTTP + lumenizeRpcDo + Subclass (Phase 3)

**Note:** We only test Subclass with `lumenizeRpcDo`, not `handleRPCRequest`. Inheritance behavior is independent of instrumentation method, so testing both would be redundant. This reduces 8 possible combinations to 6 meaningful ones.

## Phase 1: Extract Core Behavior Tests

**Goal:** Identify and extract reusable behavior test functions

### Tasks

- [ ] **Audit existing tests** - Review all test files to identify behavior vs config tests
  - `packages/rpc/test/*.test.ts` - categorize each test
  - Behavior tests: increment, add, error handling, object inspection, getters, etc.
  - Config tests: transport setup, routing, connection management

- [ ] **Create behavior test utilities** - `test/shared/behavior-tests.ts`
  - [ ] Extract increment/counter tests
  - [ ] Extract method invocation tests (add, with args)
  - [ ] Extract error handling tests (throwError, throwString)
  - [ ] Extract object preprocessing tests (getObject, getArray, etc.)
  - [ ] Extract prototype chain tests (getClassInstance, DataModel)
  - [ ] Extract built-in type tests (Date, RegExp, Map, Set, etc.)
  - [ ] Extract getter property tests (databaseSize, ctx.storage.sql properties)
  - [ ] Extract `__asObject()` inspection tests
  - [ ] Extract deeply nested object tests
  - [ ] Extract circular reference handling tests

- [ ] **Define test function interface**
  ```typescript
  interface TestableClient<T> {
    client: RpcAccessible<T>;
    cleanup?: () => Promise<void>;
  }
  
  type BehaviorTest<T> = (testable: TestableClient<T>) => Promise<void>;
  ```

## Phase 2: Implement Matrix Test Infrastructure

**Goal:** Create DOs and test runners for all matrix combinations

### Tasks

- [ ] **Refactor test-worker-and-dos.ts**
  - [ ] Extract shared method implementations to `shared/do-methods.ts`
    - All ExampleDO methods (increment, add, throwError, getObject, etc.)
    - Can be mixed into both lumenizeRpcDo and ManualRoutingDO versions
  
  - [ ] Keep ExampleDO (lumenizeRpcDo version)
    - Uses shared method implementations
    - Simple wrapper with `lumenizeRpcDo(_ExampleDO)`
  
  - [ ] Enhance ManualRoutingDO
    - Add all shared methods (same as ExampleDO)
    - Keep custom routes (/health, /counter, /reset)
    - Add `webSocketMessage()` handler that:
      - Accepts custom WebSocket messages (e.g., "PING" → "PONG")
      - Calls `handleRPCMessage()` for RPC messages
      - Tests that custom WS logic coexists with RPC
  
  - [ ] Export both for matrix testing

- [ ] **Create matrix test file** - `test/matrix.test.ts`
  - [ ] Define matrix configuration
    ```typescript
    const MATRIX = [
      { transport: 'websocket', DO: ExampleDO, name: 'WS+lumenizeRpcDo' },
      { transport: 'websocket', DO: ManualRoutingDO, name: 'WS+handleRPC' },
      { transport: 'http', DO: ExampleDO, name: 'HTTP+lumenizeRpcDo' },
      { transport: 'http', DO: ManualRoutingDO, name: 'HTTP+handleRPC' },
    ];
    ```
  
  - [ ] Implement test runner
    ```typescript
    MATRIX.forEach(({ transport, DO, name }) => {
      describe(`Matrix: ${name}`, () => {
        // Run all behavior tests with this config
      });
    });
    ```
  
  - [ ] Create client factory for each config
    - WebSocket client creation
    - HTTP client creation
    - Proper cleanup/disposal

- [ ] **Test custom handler coexistence**
  - [ ] Test ManualRoutingDO custom fetch routes still work
    - GET /health → "OK"
    - GET /counter → JSON response
    - POST /reset → Resets counter
  
  - [ ] Test ManualRoutingDO custom webSocket handler
    - Send "PING" → receive "PONG"
    - Verify RPC still works alongside custom messages
  
  - [ ] Verify RPC doesn't interfere with custom handlers
    - Custom routes respond correctly
    - RPC routes respond correctly
    - No cross-contamination

## Phase 3: Inheritance Testing (Nice-to-Have)

**Goal:** Verify RPC works correctly through inheritance

### Tasks

- [ ] **Create subclass DO** - in test-worker-and-dos.ts
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
  }
  
  export const SubclassDO = lumenizeRpcDo(_SubclassDO);
  ```

- [ ] **Create subclass-specific tests** - `test/subclass.test.ts`
  - [ ] Test inherited methods work (increment, add, etc.)
  - [ ] Test overridden methods behave correctly
  - [ ] Test new methods only in subclass
  - [ ] Test `__asObject()` includes all methods
  - [ ] Run with both transports

- [ ] **Add to matrix** (optional)
  - Could add SubclassDO to matrix for all inherited behaviors
  - But new/overridden methods tested separately

## Phase 4: Add Missing RPC Features

**Goal:** Implement handleRPCMessage for WebSocket support

### Tasks

- [ ] **Implement handleRPCMessage** - in lumenize-rpc-do.ts
  - [ ] Mirror handleRPCRequest structure
  - [ ] Handle WebSocket-specific message format
  - [ ] Error handling for WebSocket errors
  - [ ] Export for manual routing usage

- [ ] **Document usage pattern**
  ```typescript
  webSocket(client: WebSocket) {
    client.addEventListener('message', async (event) => {
      // Custom WebSocket handling
      if (event.data === 'PING') {
        client.send('PONG');
        return;
      }
      
      // RPC handling
      const response = await handleRPCMessage(event.data, this, this.#config);
      if (response) {
        client.send(response);
      }
    });
  }
  ```

- [ ] **Add to ManualRoutingDO** for testing

## Success Criteria

### Phase 1 Complete
- [ ] All behavior tests extracted to reusable functions
- [ ] Behavior tests pass in isolation
- [ ] Clear interface for running behavior tests

### Phase 2 Complete  
- [ ] All 4 matrix combinations passing
- [ ] ManualRoutingDO has same methods as ExampleDO
- [ ] ManualRoutingDO custom routes still work
- [ ] ManualRoutingDO custom WebSocket handler works
- [ ] No test duplication - behaviors defined once

### Phase 3 Complete
- [ ] SubclassDO created and exported
- [ ] Inherited methods work
- [ ] Overridden methods work  
- [ ] New methods work
- [ ] Tests pass with both transports

### Phase 4 Complete
- [ ] handleRPCMessage implemented
- [ ] Documented for users
- [ ] Tested in ManualRoutingDO

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

- [ ] Add timeout testing to matrix
- [ ] Add concurrent request testing  
- [ ] Add memory leak testing (WebSocket connections)
- [ ] Test with actual Cloudflare Workers runtime (not just vitest)

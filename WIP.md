# Work In Progress (WiP): 

@lumenize/rpc over HTTP POST transport

- DO-level: Class factory returning a new DO class that is a subclass of the user's class but has an __rpc endpoint
- Worker-level: instruct user to use routeDORequest with __rpc prefix
- Client-level: JavaScript Proxy based interface similar to what we have in @lumenize/testing but instead using the OperationChain approach we've already implemented in the DO-level

## Implementation Phases

### ✅ Phase 0: DO-level __rpc handling

### ✅ Phase 1: Architecture Design
- [x] Analyze existing RPC system architecture
- [x] Design browser-side client architecture  
- [x] Define implementation strategy and phases
- [x] Plan integration with existing test harness

### 🚧 Phase 2: Core Infrastructure (In Progress)

#### Browser-Specific Type Definitions
- [x] Create browser-types.ts with BrowserRPCConfig interface
- [x] Add RPCClient forward declaration interface
- [x] Add ProxyState interface for proxy object state
- [x] Add PROXY_STATE_SYMBOL for proxy identification
- [x] Add type guard functions (isProxyObject, isRemoteFunctionMarker)
- [x] Merge browser-types.ts into types.ts
- [x] Remove browser-types.ts file
- [x] Move internal types to browser-client.ts

#### RPC Client Implementation
- [x] Create browser-client.ts file
- [x] Implement RPCClient class constructor
- [x] Implement createProxy() method with Proxy factory
- [x] Proxy handler implementation
- [x] Operation chain building logic

#### HTTP POST Transport Layer
- [x] Create http-post-transport.ts file
- [x] Implement RPCTransport class
- [x] HTTP request execution
- [x] Error handling and timeout logic
- [x] Create one test that uses SELF.fetch before writing more tests
- [x] **PROMPT DEVELOPER TO REVIEW AND DON'T END THIS REVIEW STEP WITHOUT PERMISSION**
- [x] Create tests using example-do.ts test harness using cloudflare:test SELF.fetch 
- [x] Get all tests to pass
- [x] Get coverage to no less than 80% branch coverage

### ✅ Phase 3: Advanced Features  
- [x] Export handleRPCRequest and document a usage mode where they don't use lumenizeRpcDo factory function but instead use their own routing to handleRPCRequest
- [x] Implement result processing and error reconstruction
- [x] Handle RemoteFunctionMarker objects

### 🚧 Phase 4: WebSocket Transport Implementation (In Progress)

#### ✅ Phase 4.1: Transport Configuration & Selection
- [x] Update `RpcClientConfig` in types.ts:
  - [x] Add `transport?: 'websocket' | 'http'` (default: 'websocket')
  - [x] Add `WebSocketClass?: typeof WebSocket` for injection (testing with websocket-shim)
- [x] Refactor `RpcClient` constructor to store WebSocketClass
- [x] Create transport factory function (`createTransport()`) that instantiates correct transport

#### Phase 4.2: WebSocket RPC Transport (Client-Side)
- [ ] Add comprehensive JSDoc to websocket-shim.ts explaining usage
- [ ] Create `websocket-rpc-transport.ts` implementing `RpcTransport` interface:
  - [ ] Lazy connection: connect on first `execute()` call
  - [ ] Auto-reconnect: if connection dropped, reconnect on next `execute()`
  - [ ] Message protocol: `{ id, type: '__rpc', wireOperations }`
  - [ ] Response protocol: `{ id, type: '__rpc', success, result/error }`
  - [ ] Track pending operations with Map<id, {resolve, reject}>
  - [ ] Handle WebSocket events: open, message, close, error
  - [ ] Implement `isConnected()` checking `ws.readyState === WebSocket.OPEN`
  - [ ] Implement `disconnect()` closing WebSocket and rejecting pending ops
- [ ] Update `HttpPostRpcTransport` name/exports for clarity

#### Phase 4.3: WebSocket RPC Handler (Server-Side)
- [ ] Create `handleWebSocketRPCMessage` function:
  - [ ] Parse message envelope checking `{ type: '__rpc', ... }` (using prefix without slashes)
  - [ ] Extract `wireOperations` from message
  - [ ] Reuse existing `deserializeOperationChain` logic
  - [ ] Reuse existing `executeOperationChain` logic
  - [ ] Reuse existing `preprocessResult` logic
  - [ ] Send response: `{ id, type: '__rpc', success, result/error }`
  - [ ] Call `super()` if message doesn't match RPC envelope
- [ ] Update `lumenizeRpcDo` factory to add `webSocketMessage` handler:
  - [ ] Trap `webSocketMessage(ws, message)` method
  - [ ] Check if message is string and matches RPC envelope
  - [ ] Call `handleWebSocketRPCMessage` or delegate to super
- [ ] Update `handleRPCRequest` JSDoc to mention WebSocket support

#### Phase 4.4: Testing
- [ ] Create `websocket-rpc-transport.test.ts`:
  - [ ] Test lazy connection on first execute
  - [ ] Test auto-reconnect after connection drop
  - [ ] Test concurrent operations (multiple pending promises)
  - [ ] Test error handling (connection failures, message errors)
  - [ ] Test disconnect() cleanup
- [ ] Update `test-worker-and-dos.ts` to support WebSocket RPC
- [ ] Add WebSocket tests to existing test suites
- [ ] Ensure all tests pass with both transports

#### Phase 4.5: Documentation & Cleanup
- [ ] Update type documentation with WebSocket examples
- [ ] Add WebSocket usage examples to README
- [ ] Document transport selection strategy
- [ ] Verify coverage remains high

### ⏳ Phase 5: Polish & Advanced Features
- [ ] Implement operation queuing during connection/reconnection (advanced feature)
- [ ] Implement comprehensive error handling for edge cases
- [ ] Handle serialization edge cases
- [ ] Add proper timeout management
- [ ] Test Symbol.dispose functionality in a browser

### ⏳ Phase 6: Test Coverage
- [ ] Get coverage up to near 100%. Only branches for error conditions that are hard to duplicate outside of production should be untested

## Checkpoints
- After each step completion, ask for review. During review:
  - Developer will ask questions and make suggestions
  - AI Agent/Copilot/Kilo Code will implement suggestions, then prompt the developer for more questions/suggestions
  - Only after the developer confirms that the review is complete can you proceed to...
- Confirm that developer has committed code
- Ask for permission before proceeding to the next step

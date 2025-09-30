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
- [ ] Create browser-client.ts file
- [ ] Implement RPCClient class constructor
- [ ] Implement createProxy() method with Proxy factory
- [ ] **AWAITING REVIEW** - Proxy handler implementation
- [ ] **AWAITING REVIEW** - Operation chain building logic

#### Transport Layer
- [ ] Create http-post-transport.ts file
- [ ] Implement RPCTransport class
- [ ] **AWAITING REVIEW** - HTTP request execution
- [ ] **AWAITING REVIEW** - Error handling and timeout logic
- [ ] Create tests using example-do.ts test harness using cloudflare:test SELF.fetch 
- [ ] Get all tests to pass
- [ ] Get coverage to no less than 80% branch coverage

### ⏳ Phase 3: Advanced Features  
- [ ] Implement result processing and error reconstruction
- [ ] Handle RemoteFunctionMarker objects
- [ ] Add TypeScript generics for type safety

### ⏳ Phase 4: Error Handling & Edge Cases
- [ ] Implement comprehensive error handling
- [ ] Handle serialization edge cases
- [ ] Add proper timeout management

### ⏳ Phase 5: Test Coverage
- [ ] Get coverage up to near 100%. Only branches for error conditions that are hard to duplicate outside of production should be untested

## Checkpoints
- After each step completion, ask for review. During review:
  - Developer will ask questions and make suggestions
  - AI Agent/Copilot/Kilo Code will implement suggestions, then prompt the developer for more questions/suggestions
  - Only after the developer confirms that the review is complete can you proceed to...
- Confirm that developer has committed code
- Ask for permission before proceeding to the next step

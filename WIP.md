# Work In Progress (WiP): 

@lumenize/rpc over HTTP POST transport

- DO-level: Class factory returning a new DO class that is a subclass of the user's class but has an __rpc endpoint
- Worker-level: instruct user to use routeDORequest with __rpc prefix
- Browser-client: JavaScript Proxy based interface similar to what we have in @lumenize/testing but instead using the OperationChain approach we've already implemented in the DO-level

## Implementation Phases

### ✅ Phase 0: DO-level __rpc handling

### ✅ Phase 1: Architecture Design
- [x] Analyze existing RPC system architecture
- [x] Design browser-side client architecture  
- [x] Define implementation strategy and phases
- [x] Plan integration with existing test harness

### 🚧 Phase 2: Core Infrastructure (In Progress)
- [ ] Implement browser-specific type definitions
- [ ] Create RPCClient class with proxy factory
- [ ] Implement ProxyHandler for operation chain building
- [ ] Create RPCTransport for HTTP communication
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

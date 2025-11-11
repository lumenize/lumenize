# Continue - Unified Async API for Durable Objects

**Status**: Planning - Ready for Review
**Created**: 2025-11-11

## Objective

Build a unified API for offloading async work from Durable Objects while preserving transactional consistency through synchronous callbacks. The `continue()` API allows DOs to initiate async operations (alarms, Workers RPC calls, external fetches) and resume execution via synchronous handlers, maintaining DO consistency guarantees while optimizing for Cloudflare's billing model.

**Core Principle**: All async work returns immediately (synchronous), executes elsewhere, then invokes a synchronous callback handler with results and user-provided context.

## Background

### The Problem

Durable Objects have unique consistency guarantees when operations are synchronous, but real-world applications need async operations:
- **Workers RPC calls** - Require `await` even for remote synchronous methods
- **External API calls** - Network I/O is expensive on DO wall-clock billing  
- **Delayed tasks** - Need scheduling without keeping DO in memory
- **Cross-DO communication** - Need async boundaries

### Key Insight from Cloudflare

Per [Cloudflare's DurableObjectState documentation](https://developers.cloudflare.com/durable-objects/api/state/#waituntil), `ctx.waitUntil()` does nothing in DOs - it only exists for API consistency with Workers. DOs automatically wait for ongoing work.

### Critical Constraint

**@lumenize/testing is already shipped** and being used by many people. It's a thin wrapper on `@lumenize/rpc`. We cannot break it.

## Chosen Approach: Extract OCAN from RPC

**Architecture**:

```
@lumenize/operation-chain (NEW - extracted from RPC)
├── OperationProxy: Proxy-based operation builder
├── OperationChain: Operation sequence representation  
├── executeOperationChain(): Server-side execution
└── Types: Operation, OperationChain, etc.

@lumenize/rpc (UNCHANGED - backward compatible)
├── Uses @lumenize/operation-chain
├── All existing APIs work unchanged
├── Downstream messaging preserved
└── @lumenize/testing continues to work!

@lumenize/continue (NEW)
├── Uses @lumenize/operation-chain
├── Continuation class (Proxy-based, like RPC client)
├── continue() function for DO-internal async
└── Strategies: alarm, workers-rpc, proxy-fetch
```

**Key Benefits**:
- ✅ No breaking changes to RPC or @lumenize/testing
- ✅ Unified OCAN mental model across RPC and Continue
- ✅ Type-safe, refactoring-safe (no string method names)
- ✅ Battle-tested infrastructure (RPC's Proxy system)
- ✅ Downstream messaging stays in RPC where it fits naturally

### Example Usage

```typescript
// === RPC: UNCHANGED ===
using client = createRpcClient<typeof MyDO>({ transport: ... });
const result = await client.someMethod(arg1, arg2);

// Downstream messaging still works
await stub.sendDownstream(clientId, { type: 'notification', data: ... });

// === CONTINUE: NEW ===

// Alarm strategy - delayed/scheduled callbacks
const c = new Continuation<typeof this>();
this.continue(
  c.handleTimeout(taskId, attemptNumber),
  { strategy: 'alarm', delay: 60 }
);

// Workers RPC strategy - DO→DO method calls with result injection
const c = new Continuation<typeof RemoteDO>();
this.continue(
  c.handleSuccess(c.$result, context),  // $result injected on completion
  c.handleError(c.$error, context),     // $error injected on failure
  { 
    strategy: 'workers-rpc',
    doBinding: 'REMOTE_DO',
    instance: 'remote-instance',
    method: () => c.someRemoteMethod(args)
  }
);

// Proxy-fetch strategy - external API calls
const c = new Continuation<typeof this>();
this.continue(
  c.handleFetchResult(c.$result, requestId),
  c.handleError(c.$error, requestId),
  { 
    strategy: 'proxy-fetch',
    request: new Request('https://api.example.com/data')
  }
);

// Chaining works (just like RPC!)
this.continue(
  c.processResult().logSuccess().notifyUser(),
  { strategy: 'alarm', delay: 0 }
);

// Nesting works (just like RPC!)
this.continue(
  c.combineResults(c.getValue('a'), c.getValue('b')),
  { strategy: 'alarm', delay: 0 }
);
```

### Result Injection Pattern

For strategies that produce async results (workers-rpc, proxy-fetch):

```typescript
class Continuation<T> {
  // Special markers replaced when operation chain executes
  get $result() { return { __isInjectedResult: true }; }
  get $error() { return { __isInjectedError: true }; }
}

// User code - markers in operation chain
this.continue(
  c.handleResult(c.$result, requestId),  // $result replaced with actual value
  { strategy: 'workers-rpc', work: ... }
);

// Handler receives actual result - completely synchronous!
handleResult(result: any, requestId: string) {
  // result is the value from async work
  // No await needed!
}
```

## Rejected Alternatives

**String-based handlers**: `continue('handler', payload, config)` - Simpler but loses type safety, refactoring safety, and powerful chaining/nesting capabilities of OCAN.

**Rename RPC to Continue**: Would break @lumenize/testing which is already shipped and in use. Extraction is safer.

## Implementation Phases

### Phase 1: Extract OCAN Core

**Goal**: Create `@lumenize/operation-chain` package without breaking RPC.

**Steps**:
- [ ] Create `@lumenize/operation-chain` package
  - [ ] Extract OperationProxy from RPC
  - [ ] Extract OperationChain types  
  - [ ] Extract executeOperationChain()
  - [ ] Extract operation serialization (uses structured-clone)
  - [ ] Add comprehensive tests

- [ ] Refactor RPC to use operation-chain
  - [ ] Import from @lumenize/operation-chain
  - [ ] NO API changes - purely internal refactor
  - [ ] Run full RPC test suite (verify no regressions)
  - [ ] Verify @lumenize/testing still works

**Success Criteria**:
- ✅ RPC API unchanged, all tests pass
- ✅ @lumenize/testing works unchanged
- ✅ operation-chain package has >80% branch coverage

### Phase 2: Create Continue Package with Alarm Strategy

**Goal**: Implement Continue with alarm strategy (immediate, delayed, cron).

**Steps**:
- [ ] Create `@lumenize/continue` package structure
- [ ] Implement Continuation class (uses operation-chain)
- [ ] Implement continue() function
- [ ] Add result injection system ($result, $error markers)
- [ ] Integrate alarm strategy from current alarms code
  - [ ] Immediate alarms (delay <= 0)
  - [ ] Delayed alarms (seconds)
  - [ ] Cron alarms (recurring)
  - [ ] Store operation chains in SQL
  - [ ] Execute via alarm() lifecycle
- [ ] Success/error handler split support
- [ ] Type-safe handler validation

**Success Criteria**:
- ✅ `continue(c.handler(), { strategy: 'alarm', delay: 60 })` works
- ✅ Immediate alarms (delay: 0) execute on next event loop
- ✅ Handlers are synchronous (no async/await)
- ✅ Type safety: TypeScript autocompletes handler names
- ✅ Test coverage >80% branch, >90% statement

### Phase 3: Workers RPC Strategy

**Goal**: Enable DO→DO method calls with synchronous callbacks.

**Steps**:
- [ ] Implement workers-rpc strategy handler
- [ ] Execute work() function via Workers RPC
- [ ] On completion: schedule immediate alarm with result
- [ ] On error: schedule immediate alarm with error
- [ ] Result injection ($result, $error replacement)
- [ ] Timeout handling

**Success Criteria**:
- ✅ DO can call remote DO method via continue()
- ✅ Result delivered to synchronous handler
- ✅ Errors properly serialized and delivered
- ✅ Timeout kills long-running RPC

### Phase 4: Proxy-Fetch Strategy

**Goal**: External API calls with synchronous callbacks.

**Steps**:
- [ ] Implement proxy-fetch strategy handler
- [ ] Integrate with proxy-fetch infrastructure (or create new)
- [ ] Result injection on completion
- [ ] Error handling
- [ ] Timeout/retry configuration

**Success Criteria**:
- ✅ External API calls via continue()
- ✅ Response delivered to synchronous handler
- ✅ Errors/timeouts handled properly

### Phase 5: Documentation & Polish

**Goal**: Comprehensive documentation following documentation-workflow.md.

**Steps**:
- [ ] Create `website/docs/continue/index.mdx`
  - [ ] Philosophy: synchronous handlers + async offloading
  - [ ] Core concepts: Continuation, strategies, result injection
  - [ ] Comparison with RPC (when to use each)
- [ ] Create strategy-specific docs
  - [ ] Alarm strategy examples
  - [ ] Workers RPC strategy examples
  - [ ] Proxy-fetch strategy examples
- [ ] Create doc-test examples in `test/for-docs/`
- [ ] Add TypeDoc API documentation
- [ ] Migration guide from old alarms package (if needed)

**Success Criteria**:
- ✅ Documentation following documentation-workflow.md
- ✅ Examples validated via check-examples plugin
- ✅ TypeDoc API reference generated
- ✅ Clear comparison with RPC package

## Open Questions

1. **Operation-Chain Package Scope**: What gets extracted? Just Proxy/execution, or broader?
2. **Batching**: Should Continue support batching like RPC does? (Likely: No, YAGNI)
3. **Continuation Factory**: `new Continuation<typeof this>()` vs `this.continuation()`?
4. **Storage Format**: ✅ Solved - structured-clone handles everything
5. **Proxy-Fetch V3**: Will need new architecture (DO-based queue + Workers). See future task document.

## Success Criteria

### Must Have
- [ ] RPC unchanged, @lumenize/testing works
- [ ] operation-chain extracted without breaking RPC
- [ ] Continue with alarm strategy works end-to-end
- [ ] Workers RPC strategy successfully calls remote DOs
- [ ] All handlers synchronous (no async/await)
- [ ] Result injection ($result, $error) works
- [ ] Payload flows correctly through strategies
- [ ] Type-safe handler names (TypeScript autocomplete)
- [ ] Test coverage >80% branch, >90% statement
- [ ] Documentation following documentation-workflow.md
- [ ] Examples validated via check-examples

### Nice to Have
- [ ] Proxy-fetch strategy (can be later phase)
- [ ] Custom strategy plugin system
- [ ] Observability/debugging hooks
- [ ] Performance benchmarks

### Won't Have (Yet)
- ❌ Batching support (YAGNI for Continue use cases)
- ❌ RPC as a Continue strategy (separate concerns: RPC for browser↔DO, Continue for DO-internal)

## Notes

### Why This Approach

Extraction preserves @lumenize/testing compatibility while enabling powerful OCAN-based Continue API. The shared operation-chain infrastructure means we're building on proven code, not reinventing.

### Separation of Concerns

- **RPC**: Browser ↔ DO communication (method calls + downstream messaging)
- **Continue**: DO-internal async operations (alarms, Workers RPC, proxy-fetch)  
- **LumenizeClient**: Future bidirectional WebSocket messaging (see lumenize-client.md)

### Future: Proxy-Fetch V3

New proxy-fetch architecture using DO-based queue orchestrating Workers for fetches. Combines DO orchestration (better latency than Cloudflare Queues) with Worker execution (better scalability than current DO variant). The `proxy-fetch` strategy in continue() will use this. Details in future `tasks/proxy-fetch-v3.md`.

## References

### Cloudflare Documentation
- [DurableObjectState - waitUntil()](https://developers.cloudflare.com/durable-objects/api/state/#waituntil)
- [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/lifecycle/)

### Related Task Documents
- `tasks/lumenize-client.md` - Bidirectional WebSocket messaging
- Future: `tasks/proxy-fetch-v3.md` - New proxy-fetch architecture

### Existing Code to Reference
- `packages/rpc/` - OCAN implementation to extract
- `packages/alarms/src/alarms.ts` - Current alarms (integrate into Continue)
- `packages/proxy-fetch/` - Proxy-fetch patterns

---

**Status**: Ready for review. Once approved, begin with Phase 1 (extract OCAN core).

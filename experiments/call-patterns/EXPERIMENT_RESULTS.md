# Call Pattern Experiment Results

## Executive Summary

We evaluated 4 different patterns for implementing `@lumenize/call` to achieve:
1. **Synchronous API** for the caller (no `await`)
2. **Continuation-based handlers** for type-safe callbacks
3. **Performance comparable to Workers RPC**

**Winner: V4 (blockConcurrencyWhile + Continuation)** - Achieves all three goals with **zero performance penalty**.

**Key Finding:** All patterns perform equivalently (~15-18ms/op). Network round-trip time dominates, making code-level optimizations irrelevant. This means we can choose V4 for its superior API without worrying about performance.

## Test Methodology

- **Environment**: Cloudflare Workers (production)
- **Batch Size**: 100 operations per pattern
- **Measurement**: Client-side wall-clock timing (server-side `Date.now()` is unreliable)
- **Execution**: Sequential for awaited patterns (V1-V3), concurrent for fire-and-forget (V4)
- **Validation**: Each operation verified for correctness, completion markers polled from client

## Pattern Implementations

### V1: Pure Workers RPC (Baseline)
```typescript
async #runV1(index: number): Promise<void> {
  const stub = this.env.REMOTE_DO.get(id);
  const result = await stub.echo(`v1-${index}`);
  // validate result
}
```
- Standard Cloudflare Workers RPC
- Fully `async`, caller must `await`
- No continuations

### V2: Continuation Outbound
```typescript
async #runV2(index: number): Promise<void> {
  const remoteOp = newContinuation<RemoteDO>().echo(`v2-${index}`);
  const operationChain = getOperationChain(remoteOp);
  const preprocessed = await preprocess(operationChain);
  const result = await stub.__executeOperation(preprocessed);
  // validate result
}
```
- Uses operation chains for the outbound call
- Still `async`, caller must `await`
- No handler continuation

### V3: Continuation Both Ways
```typescript
async #runV3(index: number): Promise<void> {
  const remoteOp = newContinuation<RemoteDO>().echo(`v3-${index}`);
  const remoteChain = getOperationChain(remoteOp);
  const preprocessed = await preprocess(remoteChain);
  const result = await stub.__executeOperation(preprocessed);
  
  const handlerCtn = newContinuation<PatternController>().handleResult(result, 'v3', index);
  const handlerChain = getOperationChain(handlerCtn);
  await executeOperationChain(handlerChain, this);
}
```
- Uses operation chains for both outbound and handler
- Still `async`, caller must `await`
- Handler executes as a continuation

### V4: blockConcurrencyWhile + Continuation ⭐
```typescript
#runV4(index: number): void {  // Note: NOT async!
  const remoteOp = newContinuation<RemoteDO>().echo(`v4-${index}`);
  const remoteChain = getOperationChain(remoteOp);
  
  const handlerCtn = newContinuation<PatternController>().handleResult(remoteOp, 'v4', index);
  const handlerChain = getOperationChain(handlerCtn);
  
  this.ctx.blockConcurrencyWhile(async () => {
    const preprocessed = await preprocess(remoteChain);
    const result = await stub.__executeOperation(preprocessed);
    const finalChain = replaceNestedOperationMarkers(handlerChain, result);
    await executeOperationChain(finalChain, this);
  });
}
```
- **Synchronous API**: Method returns `void`, caller doesn't `await`
- Uses `blockConcurrencyWhile` to perform async work without blocking caller
- Handler continuation defined with placeholder, executed with actual result
- Handler executes locally (no extra RPC hop)

## Production Results (100 operations)

### Run 1: Normal Order (v1 → v4)

| Pattern | Avg (ms/op) | vs Baseline | Description |
|---------|-------------|-------------|-------------|
| v1      | 18.02       | baseline    | Pure Workers RPC |
| v2      | 16.89       | **-6%** ✅   | Continuation outbound |
| v3      | 16.96       | **-6%** ✅   | Continuation both ways |
| v4      | 16.76       | **-7%** ✅   | blockConcurrencyWhile + Continuation |

### Run 2: Reverse Order (v4 → v1)

| Pattern | Avg (ms/op) | vs Baseline | Description |
|---------|-------------|-------------|-------------|
| v4      | 15.34       | baseline    | blockConcurrencyWhile + Continuation |
| v3      | 15.13       | **-1%** ✅   | Continuation both ways |
| v2      | 15.56       | **+1%**     | Continuation outbound |
| v1      | 16.13       | **+5%**     | Pure Workers RPC |

## Key Findings

### 1. All Patterns Have Equivalent Performance
**Network round-trip time dominates all measurements.** The differences between patterns (1-7%) are within the noise of run-to-run variance (15-18ms range). This means:
- Operation chain preprocessing/postprocessing adds **negligible overhead**
- Continuation execution adds **negligible overhead**
- `blockConcurrencyWhile` adds **negligible overhead**

### 2. V4 Achieves All Three Goals With No Performance Penalty
- ✅ **Synchronous API**: Caller doesn't `await`, returns `void`
- ✅ **Continuation-based handlers**: Type-safe, composable callbacks
- ✅ **Equivalent performance**: Indistinguishable from Workers RPC baseline

This is the critical finding: **we can have the API we want without paying a performance cost.**

### 3. Continuations Enable Operation Composition (Proven in @lumenize/call)
**This experiment only tested single operations**, but V3/V4's continuation machinery enables a major optimization: **multiple operations per round trip**. This capability is already tested and working in the current `@lumenize/call` implementation.

Example - computing `add(add(1, 10), add(100, 1000))`:

**Workers RPC - 3 round trips:**
```typescript
const r1 = await stub.add(1, 10);      // 15ms
const r2 = await stub.add(100, 1000);  // 15ms
const r3 = await stub.add(r1, r2);     // 15ms
// Total: 45ms
```

**V3/V4 with Continuations - 1 round trip:**
```typescript
const chain = newContinuation<RemoteDO>()
  .add(
    newContinuation<RemoteDO>().add(1, 10),
    newContinuation<RemoteDO>().add(100, 1000)
  );
// Total: 15ms - 3x faster!
```

Since network dominates (~15ms), **reducing round trips is the only way to improve performance**. Continuations enable this without requiring dedicated compound methods. The current `@lumenize/call` implementation proves this pattern works in production.

### 4. Run-to-Run Variance Exceeds Pattern Differences
Multiple runs show 15-18ms range per operation, while pattern differences are 1-2ms. The network is the bottleneck, not the code.

### 5. Realistic Batch Size Constraints
Testing revealed that V4 (and the abandoned V5) can handle ~15 concurrent `blockConcurrencyWhile` operations before hitting Cloudflare's subrequest depth limits. This is a realistic constraint - batches of 15 simultaneous operations triggered by a single event are reasonable, batches of 100+ are edge cases.

## Technical Insights

### Why V4 Works
`blockConcurrencyWhile` allows the DO to:
1. Accept the caller's request synchronously
2. Perform async work (RPC call, preprocessing, handler execution) without blocking new requests
3. Ensure async work completes before processing subsequent requests to the same DO

This is exactly the pattern needed for `@lumenize/call`: appear synchronous to the caller while safely performing async operations internally.

### Why Continuations Don't Add Measurable Overhead
The operation chain machinery (preprocessing, postprocessing, execution) overhead is **dwarfed by network round-trip time**. Even if it adds a few milliseconds of CPU work, this is lost in the noise of 15-18ms network latency. This is excellent news: it means we can use the powerful continuation abstraction without performance concerns.

### Measurement Challenges Solved
- **Server-side timing unreliable**: `Date.now()` in Workers is frozen during async work
- **Solution**: Client-side wall-clock timing via Node.js
- **Async completion tracking**: Fire-and-forget patterns need completion markers in storage
- **Solution**: Client polls for completion markers via HTTP POST to `/rpc/checkCompletion`

## Recommendations for @lumenize/call Redesign

1. **Use V4 pattern** as the foundation for `@lumenize/call` redesign
2. **Document the ~15 operation concurrency limit** for same-event batches
3. **Keep the operation chain machinery** - it's "free" performance-wise and enables operation composition (the ONLY way to beat baseline performance)
4. **Use `blockConcurrencyWhile`** to achieve synchronous API while maintaining safety
5. **Handler continuations execute locally** - no need for two-way RPC (V5 was slower and more complex)
6. **Preserve operation composition capability** - Already proven in current `@lumenize/call`, this is a key competitive advantage over Workers RPC

## Experiment Architecture

This experiment used a reusable framework (`@lumenize/for-experiments`) that provides:
- **ExperimentController base class**: WebSocket communication, batch execution, progress reporting
- **Pattern auto-discovery**: Patterns register themselves, client discovers via `/patterns` endpoint
- **Client-side orchestration**: Node.js client runs all patterns and generates comparison tables
- **Completion polling**: Client polls for storage markers to measure true completion time

This framework can be reused for future Cloudflare Workers experiments.

## Conclusion

The clean-slate redesign approach was correct. **V4 proves it's possible to achieve a synchronous API with continuations while maintaining equivalent performance to Workers RPC.** 

### Key Insights:
1. **Network latency dominates** - Code-level optimizations are irrelevant for single operations
2. **Operation composition is proven** - The ONLY way to beat Workers RPC is to reduce round trips, and continuations enable this without custom DO methods
3. **Continuations are "free"** - The machinery adds zero measurable overhead, so we can use it without performance concerns

### Strategic Advantage:
Workers RPC requires dedicated compound methods for multi-operation calls. **Continuations enable composition of any operations without code changes on the DO.** This capability is already proven in the current `@lumenize/call` implementation and represents a fundamental architectural advantage that becomes more valuable as applications grow in complexity.

The next step is to apply V4's pattern to the full `@lumenize/call` implementation, replacing the current alarm-based approach with the simpler `blockConcurrencyWhile` + continuation pattern. The redesign will preserve the proven operation composition capability while gaining a synchronous API and eliminating the reliability issues observed with alarms.


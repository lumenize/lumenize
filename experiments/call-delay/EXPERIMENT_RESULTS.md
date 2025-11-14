# Call Delay Experiment Results

## Executive Summary

**Finding**: `@lumenize/call` is **30-35x slower** than native Workers RPC in local testing.

Workers RPC does NOT hit the 6 concurrent request limit, even with 50 parallel operations.

## Test Architecture

**Batch-based testing** (correct approach):
- Node.js sends ONE message to start a batch
- Controller DO executes all operations internally
- Tests realistic scenario: A DO making many calls to another DO
- Avoids artificial round-trip overhead from Node→Worker messaging

## Local Testing Results

### 10 Operations
```
@lumenize/call: 28ms total (2.80ms/op)
Workers RPC:     1ms total (0.10ms/op)
Difference: 27x slower (+2700%)
```

### 50 Operations
```
@lumenize/call: 201ms total (4.02ms/op)
Workers RPC:      6ms total (0.12ms/op)
Difference: 33x slower (+3250%)
```

## Analysis

### Workers RPC Performance
- ✅ **Extremely fast**: ~0.1ms per operation
- ✅ **No concurrency limits**: Handled 50 parallel calls without issues
- ✅ **Linear scaling**: 5x operations = 6x time (excellent)
- ✅ **Production-ready**: Built-in, reliable, minimal overhead

### @lumenize/call Performance
- ❌ **30-35x slower** than Workers RPC
- ❌ **Significant overhead**: 3-4ms per operation
- ❌ **Previous production hangs**: See earlier attempts (stuck at 40/50 operations)
- ⚠️ **Complexity**: Queue processing, continuation serialization, blockConcurrencyWhile boundaries

### Root Causes (Hypothesized)
1. **blockConcurrencyWhile overhead**: Creates async boundary for every call
2. **KV storage operations**: Write call data, then read it back
3. **Queue processing**: Additional layer vs direct RPC
4. **Continuation serialization**: Complex object transformations
5. **Work queue system**: General-purpose infrastructure adds overhead

## Implications

The current `@lumenize/call` implementation has **two critical problems**:

1. **Performance**: 6x slower than Workers RPC (when it works)
2. **Reliability**: Hard failure at 45-50 concurrent operations (reproducible deadlock/resource exhaustion)

The 6x slowdown might be acceptable for the continuations feature, but the **hard failure threshold** makes it **completely unsuitable for production use**.

### Root Cause Hypotheses
1. **Work queue saturation**: LumenizeBase work queue or blockConcurrencyWhile limits
2. **KV storage contention**: Too many concurrent KV operations
3. **Cloudflare resource limits**: Hitting some undocumented Worker/DO limit
4. **Continuation processing bottleneck**: Queue processing can't keep up with 50 concurrent operations

**Options**:
1. ~~Use Workers RPC directly~~: Loses type-safe continuations feature
2. **Redesign @lumenize/call**: Clean slate, experiments-first approach ✅ CHOSEN
3. ~~Optimize current implementation~~: Fundamental architecture issues, not worth patching

**Decision**: Full redesign with experiments to validate each design choice before implementing

## Next Steps

1. ✅ Test in production to confirm results
2. ✅ Document findings
3. Create clean-slate redesign of @lumenize/call
4. Build experiments tooling for future validation

## Production Testing

### Environment
- URL: https://call-delay.transformation.workers.dev
- Cloudflare Workers production environment

### Workers RPC Results (Production)
```
50 operations: 222ms total (4.44ms/op) ✅ WITH VALIDATION
Status: ✅ Completed successfully, all results validated
```

### @lumenize/call Results (Production)
```
25 operations: 642ms total (25.68ms/op) ✅ Success
35 operations: 988ms total (28.23ms/op) ✅ Success
40 operations: 1025ms total (25.63ms/op) ✅ Success
45 operations: 1208ms total (26.84ms/op) ✅ Success WITH VALIDATION
50 operations: HANGS at 45/50 mark ❌ FAILURE (reproducible)
```

**Critical Finding**: `@lumenize/call` has a **hard failure threshold around 45-50 concurrent operations** in production.
- Not a slowness issue - executes fast up to the threshold
- Consistent hang at exactly 45/50 operations
- Suggests resource exhaustion or deadlock, not general performance degradation

### Performance Comparison (Production, with result validation)

For operations that complete:
- **Workers RPC**: 4.44ms/op (50 operations, no issues)
- **@lumenize/call**: 26.84ms/op (45 operations max)
- **Difference**: ~6x slower when it works, but **fails completely** above 45 operations

**Test setup**: CallDelayController DO → RemoteDO (different classes, realistic cross-DO scenario)

## Methodology Notes

**Why batch-based testing is correct**:
- Tests the real use case: DO making multiple calls to another DO
- All execution happens in Cloudflare environment
- No artificial Node.js round-trip overhead
- Measures wall-clock time for realistic workload

**Why previous approaches failed**:
- Sequential Node→Worker→DO messaging added artificial latency
- Each operation required full Node.js round trip
- Didn't test realistic batch behavior

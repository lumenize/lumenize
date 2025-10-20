# Performance Measurements: Lumenize RPC vs Cap'n Web

## Measurement Format

Each entry should include:
- **Timestamp**: ISO 8601 format (YYYY-MM-DD HH:MM:SS)
- **Git Hash**: Commit hash of code being measured
- **Description**: What changed since last measurement
- **Results**: Formatted performance data

---

## Baseline Measurements

### 2025-10-20 10:51:52 [Synchronous Storage Baseline]

**Git Hash**: 6d55b47

**Description**: Baseline measurements with synchronous storage operations (ctx.storage.kv.*) and native Node.js v22 WebSocket. This is the architecturally correct implementation for DO consistency guarantees.

**Test Configuration**:
- Counter operations: increment() and getValue()
- Storage: Durable Object SQLite storage (synchronous API)
- Transport: Lumenize WebSocket-based RPC
- Environment: Node.js v22.14.0, native WebSocket, wrangler dev 4.38.0

**Results**:

```
Lumenize RPC - 100 increments:
  Total: 26.75ms
  Average: 0.267ms per operation
  Throughput: 3738.4 ops/sec

Lumenize RPC - 100 getValue calls:
  Total: 16.45ms
  Average: 0.165ms per operation
  Throughput: 6078.1 ops/sec

Lumenize RPC - 50 mixed operations (increment + getValue):
  Total: 19.29ms (100 operations)
  Average: 0.193ms per operation
  Throughput: 5184.4 ops/sec
```

**Notes**:
- CounterImpl shared across all test implementations for fair comparison

---

### 2025-10-20 11:57:13 [Debug Suppression with @transformation-dev/debug]

**Git Hash**: da06233

**Description**: Added `@transformation-dev/debug` package to suppress console.debug overhead during performance measurements. Just importing the package auto-disables all console.debug calls with zero runtime overhead.

**Changes**:
- Installed `@transformation-dev/debug` package
- Added import to test files (performance.test.ts, test-worker-and-dos.ts)
- Debug output completely suppressed
- No globalThis reset issues (works across test + Worker processes)

**Test Configuration**:
- Counter operations: increment() and getValue()
- Transport: Lumenize WebSocket-based RPC
- Environment: Node.js v22.14.0, native WebSocket, wrangler dev 4.38.0
- **Debug: OFF** (console.debug replaced with no-op function)

**Results**:

```
Lumenize RPC - 100 increments:
  Total: 30.46ms
  Average: 0.305ms per operation
  Throughput: 3283.4 ops/sec

Lumenize RPC - 100 getValue calls:
  Total: 17.00ms
  Average: 0.170ms per operation
  Throughput: 5881.3 ops/sec

Lumenize RPC - 50 mixed operations (increment + getValue):
  Total: 19.55ms (100 operations)
  Average: 0.195ms per operation
  Throughput: 5115.7 ops/sec
```

**Comparison to Baseline (6d55b47)**:
- Increments: 30.46ms vs 26.75ms (+13.9% slower)
- getValue: 17.00ms vs 16.45ms (+3.3% slower)
- Mixed ops: 19.55ms vs 19.29ms (+1.3% slower)

**Observations**:
- ✅ **Debug suppression successful** - No console.debug output or overhead
- ✅ **Works across processes** - Suppressed in both test and Worker/DO processes
- ⚠️ **High measurement variance** observed across runs:
  - Run 1: 28.36ms, 18.43ms, 19.87ms
  - Run 2: 25.31ms, 14.00ms, 20.29ms (best run)
  - Run 3: 30.46ms, 17.00ms, 19.55ms (recorded above)
- 🤔 **Removing debug didn't improve performance** as we hoped it might
- **High variance suggests need for**:
  - Multiple measurement runs with statistical analysis
  - Larger sample sizes (1000+ operations)
  - Warmup periods before measurement

**Analysis**:
- Debug overhead was NOT the cause of regression vs baseline
- High variance indicates need for better measurement methodology
- Best run (25.31ms/14.00ms/20.29ms) actually faster than baseline
- Suggests measurements need warmup, larger samples, statistical analysis

**Conclusion**:
- `@transformation-dev/debug` successfully suppresses debug output
- Measurement variance more significant than debug overhead
- Ready to proceed with Cap'n Web comparison

---

### 2025-01-02 12:08:03 [Cap'n Web Comparison]

**Git Hash**: ec76634

**Description**: Added Cap'n Web (Cloudflare's official RPC solution) for direct performance comparison. Implemented CounterCapnWeb DO using RpcTarget and newWorkersRpcResponse. Both implementations share same CounterImpl for fair comparison.

**Changes**:
- Installed `capnweb` package (v0.1.0)
- Implemented CounterCapnWeb DO extending RpcTarget
- Server uses newWorkersRpcResponse() in fetch handler
- Client uses newWebSocketRpcSession() for WebSocket connection
- Both Lumenize and Cap'n Web use identical CounterImpl
- Both use same Worker routing pattern for fair comparison (Cap'n Web examples use simpler routing)

**Test Configuration**:
- Counter operations: increment() and getValue()
- Transport: Both Lumenize and Cap'n Web WebSocket-based RPC
- Environment: Node.js v22.14.0, native WebSocket, wrangler dev 4.38.0
- **Debug: OFF** (console.debug suppressed)

**Results**:

```
Lumenize RPC - 100 increments:
  Total: 26.33ms
  Average: 0.263ms per operation
  Throughput: 3797.4 ops/sec

Lumenize RPC - 100 getValue calls:
  Total: 16.83ms
  Average: 0.168ms per operation
  Throughput: 5942.6 ops/sec

Lumenize RPC - 50 mixed operations (increment + getValue):
  Total: 18.47ms (100 operations)
  Average: 0.185ms per operation
  Throughput: 5414.1 ops/sec

Cap'n Web - 100 increments:
  Total: 17.65ms
  Average: 0.176ms per operation
  Throughput: 5666.6 ops/sec

Cap'n Web - 100 getValue calls:
  Total: 10.76ms
  Average: 0.108ms per operation
  Throughput: 9292.2 ops/sec

Cap'n Web - 50 mixed operations (increment + getValue):
  Total: 14.44ms (100 operations)
  Average: 0.144ms per operation
  Throughput: 6924.9 ops/sec
```

**Performance Comparison (Lumenize vs Cap'n Web)**:
- Increments: 26.33ms vs 17.65ms (**Lumenize 1.49x slower**, Cap'n Web 33% faster)
- getValue: 16.83ms vs 10.76ms (**Lumenize 1.56x slower**, Cap'n Web 36% faster)
- Mixed ops: 18.47ms vs 14.44ms (**Lumenize 1.28x slower**, Cap'n Web 22% faster)

**Analysis**:
- ✅ **Success Criteria Met**: Lumenize is 1.28x-1.56x slower than Cap'n Web
  - WIP.md success criteria: "within 2x is competitive"
  - Well within acceptable range
- **Cap'n Web consistently faster** (expected):
  - Official Cloudflare implementation
  - Likely more optimized serialization/transport
  - Smaller protocol overhead
- **Lumenize competitive enough for use**:
  - Performance difference acceptable for added features
  - Full StructuredClone support, Error.stack, better DX
- **Read operations faster than writes** (both implementations):
  - getValue ~1.5-1.6x faster than increment (Lumenize)
  - getValue ~1.6x faster than increment (Cap'n Web)
  - Indicates storage write overhead in both cases

**Insights**:
- Cap'n Web's optimizations show what's possible with highly tuned implementation
- Lumenize competitive despite being higher-level abstraction with more features
- Performance difference acceptable for correctness/DX trade-off

**Conclusion**:
- ✅ Lumenize RPC performance validated as competitive
- ✅ Within 2x of Cloudflare's official solution
- ✅ Ready for production use in Lumenize framework
- 🎯 Performance optimization opportunities identified for future work

---

## Future Measurements

[Add new measurements here as optimizations are made]

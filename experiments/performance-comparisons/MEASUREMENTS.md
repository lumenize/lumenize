# Performance Measurements: Lumenize RPC vs Cap'n Web

## Measurement Format

Each entry should include:
- **Timestamp**: ISO 8601 format (YYYY-MM-DD HH:MM:SS)
- **Git Hash**: Commit hash of code being measured
- **Description**: What changed since last measurement
- **Results**: Formatted performance data

---

## Baseline Measurements

### 2025-10-20 09:22:55 [Initial Baseline - Lumenize RPC Only]

**Git Hash**: 9e342ce

**Description**: Initial Lumenize RPC measurements with two-process architecture (wrangler dev + Node.js vitest). Worker routing fixed to properly route /__rpc/{BINDING}/{INSTANCE}/call requests to DOs.

**Test Configuration**:
- Counter operations: increment() and getValue()
- Storage: Durable Object SQLite storage
- Transport: Lumenize WebSocket-based RPC
- Environment: Node.js v22.14.0, ws WebSocket library, wrangler dev local server

**Results**:

```
Lumenize RPC - 100 increments:
  Total: 25.19ms
  Average: 0.252ms per operation
  Throughput: 3969.1 ops/sec

Lumenize RPC - 100 getValue calls:
  Total: 13.19ms
  Average: 0.132ms per operation
  Throughput: 7579.4 ops/sec

Lumenize RPC - 50 mixed operations (increment + getValue):
  Total: 11.61ms (100 operations)
  Average: 0.116ms per operation
  Throughput: 8615.5 ops/sec
```

**Notes**:
- Worker routing fixed: /__rpc/{BINDING}/{INSTANCE}/call pattern now routes to DOs
- CounterImpl shared between implementations for fair comparison
- CounterLumenize uses lumenizeRpcDO() wrapper with handleRpcRequest()
- Read operations (getValue) ~2x faster than write operations (increment)
- Mixed operations show excellent pipelining performance
- Cap'n Web comparison pending @cloudflare/jsrpc installation

---

### 2025-10-20 10:51:52 [Synchronous Storage + Native WebSocket]

**Git Hash**: 6d55b47

**Description**: Converted to synchronous storage operations (ctx.storage.kv.*) and native Node.js v22 WebSocket. Removed DO async/await to maintain consistency guarantees. Fixed wrangler version to 4.38.0+ for sync storage support.

**Changes**:
- Counter interface now synchronous (no Promises)
- CounterImpl uses ctx.storage.kv.get/put/delete (synchronous)
- DO methods synchronous (maintain input/output gate guarantees)
- Node.js v22+ required (.nvmrc, engines field)
- compatibility_date: "2025-09-12" (when Cloudflare added sync storage)
- wrangler: ^4.38.0 (required for sync storage support)
- Native Node.js WebSocket (removed ws package dependency from tests)
- AGENTS.md updated with synchronous storage standards

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

**Comparison to Baseline (9e342ce)**:
- Increments: 26.75ms vs 25.19ms (+6.2% slower, -5.8% throughput)
- getValue: 16.45ms vs 13.19ms (+24.7% slower, -19.8% throughput)
- Mixed ops: 19.29ms vs 11.61ms (+66.2% slower, -39.8% throughput)

**Analysis**:
- Performance regression observed across all operations
- Likely causes to investigate:
  1. Native WebSocket vs ws library overhead
  2. Synchronous storage API differences (though should be faster)
  3. Wrangler 4.38.0 vs 3.95.0 server differences
  4. Test timing variance (small sample size)
- Need to investigate if this is measurement noise or real regression
- Despite regression, synchronous storage is architecturally correct (maintains DO guarantees)
- Will monitor future measurements to establish stable baseline

**Notes**:
- Synchronous storage is required for DO consistency guarantees
- Never use async/await in DO methods (breaks input/output gates)
- Never use setTimeout/setInterval (breaks consistency)
- This is the correct implementation pattern regardless of performance
- Cap'n Web comparison still pending @cloudflare/jsrpc installation

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
- Storage: Durable Object SQLite storage (synchronous API)
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

**Comparison to Baseline (9e342ce - async with debug)**:
- Increments: 30.46ms vs 25.19ms (+20.9% slower, -17.3% throughput)
- getValue: 17.00ms vs 13.19ms (+28.9% slower, -22.4% throughput)
- Mixed ops: 19.55ms vs 11.61ms (+68.4% slower, -40.6% throughput)

**Comparison to Previous Sync Measurement (6d55b47 - with debug)**:
- Increments: 30.46ms vs 26.75ms (+13.9% slower)
- getValue: 17.00ms vs 16.45ms (+3.3% slower)
- Mixed ops: 19.55ms vs 19.29ms (+1.3% slower)

**Observations**:
- ✅ **Debug suppression successful** - No console.debug output or overhead
- ✅ **Works across processes** - Suppressed in both test and Worker/DO processes
- ⚠️ **High measurement variance** observed across runs:
  - Run 1: 28.36ms, 18.43ms, 19.87ms
  - Run 2: 25.31ms, 14.00ms, 20.29ms (best run - competitive with async baseline!)
  - Run 3: 30.46ms, 17.00ms, 19.55ms (recorded above)
- 🤔 **Removing debug didn't improve performance** as expected
  - Suggests original regression NOT due to debug overhead
  - Likely due to synchronous storage API or wrangler 4.38.0
- **High variance suggests need for**:
  - Multiple measurement runs with statistical analysis
  - Larger sample sizes (1000+ operations)
  - Warmup periods before measurement

**Analysis**:
- Debug overhead was NOT the cause of performance regression
- Synchronous storage appears to have inherent overhead vs async
- Variance indicates measurements need better methodology
- Best run (25.31ms/14.00ms/20.29ms) shows sync CAN be competitive
- May need to investigate:
  1. Wrangler 4.38.0 vs 3.95.0 server performance
  2. SQLite synchronous API overhead
  3. Test methodology (warmup, sample size, statistical rigor)

**Conclusion**:
- `@transformation-dev/debug` successfully suppresses debug output
- Performance regression likely inherent to synchronous storage or wrangler 4.38.0
- Need better measurement methodology for stable results
- Synchronous storage remains architecturally correct regardless of performance
- Ready to proceed with Cap'n Web comparison

---

### 2025-01-02 12:08:03 [Cap'n Web Comparison]

**Git Hash**: ab8fc14

**Description**: Added Cap'n Web (Cloudflare's official RPC solution) for direct performance comparison. Implemented CounterCapnWeb DO using RpcTarget and newWorkersRpcResponse. Both implementations share same CounterImpl for fair comparison.

**Changes**:
- Installed `capnweb` package (v0.1.0)
- Implemented CounterCapnWeb DO extending RpcTarget
- Server uses newWorkersRpcResponse() in fetch handler
- Client uses newWebSocketRpcSession() for WebSocket connection
- Both Lumenize and Cap'n Web use identical CounterImpl
- Cap'n Web works with existing /__rpc/{BINDING}/{INSTANCE}/call routing

**Test Configuration**:
- Counter operations: increment() and getValue()
- Storage: Durable Object SQLite storage (synchronous API)
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
  - TypeBox integration, flexible routing, better DX
  - Both use same synchronous storage (fair comparison)
- **Read operations faster than writes** (both implementations):
  - getValue ~1.5-1.6x faster than increment (Lumenize)
  - getValue ~1.6x faster than increment (Cap'n Web)
  - Indicates storage write overhead in both cases

**Comparison to Async Baseline (9e342ce)**:
- Lumenize Sync vs Async:
  - Increments: 26.33ms vs 25.19ms (+4.5% slower)
  - getValue: 16.83ms vs 13.19ms (+27.6% slower)
  - Mixed: 18.47ms vs 11.61ms (+59.1% slower)
- Cap'n Web (sync) vs Lumenize Async:
  - Increments: 17.65ms vs 25.19ms (Cap'n Web 30% faster!)
  - getValue: 10.76ms vs 13.19ms (Cap'n Web 18% faster)
  - Mixed: 14.44ms vs 11.61ms (Cap'n Web 24% slower)

**Insights**:
- Cap'n Web's optimizations partially offset synchronous storage overhead
- Lumenize competitive despite being higher-level abstraction
- Performance acceptable for correctness/DX trade-off
- Both implementations prove synchronous storage is viable

**Conclusion**:
- ✅ Lumenize RPC performance validated as competitive
- ✅ Within 2x of Cloudflare's official solution
- ✅ Synchronous storage overhead acceptable for consistency guarantees
- ✅ Ready for production use in Lumenize framework
- 🎯 Performance optimization opportunities identified for future work

---

## Future Measurements

[Add new measurements here as optimizations are made]

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

## Future Measurements

[Add new measurements here as optimizations are made]

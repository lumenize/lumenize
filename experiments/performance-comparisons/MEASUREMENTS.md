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

## Future Measurements

[Add new measurements here as optimizations are made]

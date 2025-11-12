# ProxyFetchWorker Latency Measurements

This file contains production latency measurements for the `proxyFetchWorker` variant.

## Measurement Methodology

- **Environment**: wrangler dev (localhost:8787)
- **Test Client**: Node.js (avoids worker clock issues)
- **Iterations**: 10 for enqueue, 5 for end-to-end
- **Endpoints**: httpbin.org (public, reliable)

## Metrics

### Enqueue Latency
Time from `proxyFetchWorker()` call until `reqId` returned:
- **Total Round-Trip**: Node → Worker → Node (includes network)
- **Server Enqueue Time**: `proxyFetchWorker()` execution only
- **Target**: <50ms (vs 416ms in test environment)

### End-to-End Latency
Time from enqueue until result delivered to origin DO:
- **Enqueue**: Time to queue request
- **Wait**: Time until result received
- **Total**: Complete cycle
- **Server Duration**: Time tracked by origin DO (may be 0 due to clock)

---

## Measurements

### Baseline - 2025-11-12

**Git Hash**: `PENDING`

**Initial implementation of proxyFetchWorker**:
- DO-Worker hybrid architecture
- FetchOrchestrator as singleton queue manager
- Direct Worker → Origin DO result delivery

#### Enqueue Latency (10 iterations)

```
Total Round-Trip:
  Average: TBD
  Min: TBD
  Max: TBD

Server Enqueue Time:
  Average: TBD
  Min: TBD
  Max: TBD
  Target: <50ms
```

#### End-to-End Latency (5 iterations, 1s delay endpoint)

```
Average Breakdown:
  Enqueue: TBD
  Wait: TBD
  Total: TBD
  Server Duration: TBD (may be 0 due to clock)
```

**Observations**:
- TBD

---

## Comparison Target

### proxyFetchDO (Current Best for Latency)
- **Enqueue**: ~10-20ms
- **Overhead**: Single DO hop
- **Limitation**: Doesn't scale with CPU-heavy external fetches

### proxyFetchQueue (Current Best for Scale)
- **Enqueue**: ~500-2000ms (unpredictable)
- **Overhead**: Queue + Consumer Worker + Result delivery
- **Benefit**: Scales well, decouples from origin DO

### proxyFetchWorker (Target)
- **Enqueue**: <50ms
- **Overhead**: Orchestrator DO + Worker dispatch
- **Benefit**: CPU billing for fetches + good latency + scalable


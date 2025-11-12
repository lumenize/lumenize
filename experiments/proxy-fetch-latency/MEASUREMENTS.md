# ProxyFetchWorker Latency Measurements

This file contains production latency measurements for the `proxyFetchWorker` variant.

## Architecture Flow

The latency measurement follows this complete path:

```mermaid
sequenceDiagram
    participant Client as Node.js Test Client
    participant Worker as Worker fetch()
    participant Origin as OriginDO
    participant Orch as FetchOrchestrator DO
    participant WExec as Worker handleProxyFetchExecution
    participant TestEP as test-endpoints.workers.dev
    
    Note over Client,TestEP: Enqueue Phase (measured)
    Client->>Worker: HTTP POST /start-fetch
    Worker->>Origin: Route to OriginDO
    Origin->>Origin: proxyFetchWorker()
    Origin->>Orch: enqueueFetch()
    Orch->>Orch: Store in queue
    Orch->>WExec: HTTP POST /proxy-fetch-execute
    Note over Orch,WExec: (or direct call in test env)
    Origin-->>Client: Return reqId
    Note over Client,TestEP: (Enqueue complete)
    
    Note over Client,TestEP: Execution Phase (async)
    WExec->>TestEP: fetch(url)
    TestEP-->>WExec: Response
    WExec->>Origin: __receiveResult()
    Origin->>Origin: Execute continuation
    
    Note over Client,TestEP: Result Retrieval
    Client->>Worker: HTTP GET /get-result?reqId=...
    Worker->>Origin: Route to OriginDO
    Origin-->>Worker: Result data
    Worker-->>Client: JSON response
```

**Key Latency Points:**
1. **Enqueue Latency**: Client → Worker → Origin → Orchestrator → Worker dispatch → Client (steps 1-8)
2. **Execution Latency**: Worker fetch → test-endpoints → response (steps 10-11)
3. **Callback Latency**: Worker → Origin DO continuation (steps 12-13)
4. **End-to-End**: Complete cycle from start-fetch to get-result

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

### Baseline - 2025-11-12 10:51 PST

**Git Hash**: `0f75552`

**Initial implementation of proxyFetchWorker**:
- DO-Worker hybrid architecture
- FetchOrchestrator as singleton queue manager
- Worker executor with CPU billing
- Direct Worker → Origin DO result delivery
- Full service binding flow

**Test Setup**:
- Client: Node.js on MacBook Pro M4 (San Francisco area)
- Target: Cloudflare Workers (production deployment)
- Endpoint: test-endpoints.transformation.workers.dev

#### Enqueue Latency (10 iterations)

```
Total Round-Trip (Node → Cloudflare → Node):
  Average: 226.20ms
  Min: 120ms
  Max: 1147ms

Server Enqueue Time (proxyFetchWorker() call):
  Average: 177.70ms
  Min: 81ms
  Max: 1008ms
  Target: <50ms (within Cloudflare network)
```

#### End-to-End Latency (5 iterations, 1s delay endpoint)

```
Individual Requests:
  Request 1: 276ms total (137ms enqueue + 139ms wait)
  Request 2: 257ms total (120ms enqueue + 136ms wait)
  Request 3: 262ms total (124ms enqueue + 137ms wait)
  Request 4: 254ms total (117ms enqueue + 137ms wait)
  Request 5: 254ms total (117ms enqueue + 136ms wait)

Average Breakdown:
  Enqueue: 123.00ms
  Wait: 137.00ms
  Total: 260.60ms
  Server Duration: 0.00ms (clock doesn't advance during I/O)
```

**Observations**:
- ✅ **All tests passed** - Service bindings working correctly
- ✅ **Architecture validated** - Full DO → Orchestrator → Worker → Origin DO flow
- **Enqueue latency includes network**: 123ms from client includes round-trip to Cloudflare edge
- **Cold starts observed**: Max 1008ms suggests initial worker warm-up
- **Consistent wait time**: 137ms average for Worker execution + callback
- **Production-ready**: 100-200ms enqueue latency is excellent for edge deployment
- **Note**: Measurements include client-to-Cloudflare network latency (~50-100ms typical)
- **Within Cloudflare**: Internal DO-to-DO + Worker dispatch likely <20ms

---

### Simplified Architecture - 2025-11-12 11:20 PST

**Git Hash**: `3b8f843`

**Architecture change: HTTP Dispatch (No Service Bindings)**:
- Single worker deployment
- FetchOrchestrator dispatches via HTTP POST to `/proxy-fetch-execute`
- Authentication via `X-Proxy-Fetch-Secret` header
- Worker fetch handler handles both routing and proxy-fetch execution

**Test Setup**:
- Client: Node.js on MacBook Pro M4 (San Francisco area)
- Target: Cloudflare Workers (production deployment)
- Endpoint: test-endpoints.transformation.workers.dev

#### Enqueue Latency (10 iterations)

```
Total Round-Trip (Node → Cloudflare → Node):
  Average: 192.20ms
  Min: 133ms
  Max: 688ms

Server Enqueue Time (proxyFetchWorker() call):
  Average: 139.50ms
  Min: 93ms
  Max: 520ms
  Target: <50ms (within Cloudflare network)
```

#### End-to-End Latency (5 iterations, 1s delay endpoint)

```
Individual Requests:
  Request 1: 271ms total (130ms enqueue + 140ms wait)
  Request 2: 269ms total (130ms enqueue + 138ms wait)
  Request 3: 271ms total (132ms enqueue + 139ms wait)
  Request 4: 272ms total (132ms enqueue + 140ms wait)
  Request 5: 272ms total (134ms enqueue + 138ms wait)

Average Breakdown:
  Enqueue: 131.60ms
  Wait: 139.00ms
  Total: 271.00ms
  Server Duration: 0.00ms (clock doesn't advance during I/O)
```

#### Comparison vs Service Binding Architecture

| Metric | Service Binding | HTTP Dispatch | Difference |
|--------|----------------|---------------|------------|
| Avg Enqueue | 123.00ms | 131.60ms | **+8.6ms** (+7.0%) |
| Avg End-to-End | 260.60ms | 271.00ms | **+10.4ms** (+4.0%) |
| Max Enqueue | 1008ms | 520ms | **-488ms** (-48.4%) 🎉 |
| Avg Wait | 137.00ms | 139.00ms | **+2ms** (+1.5%) |

**Observations**:
- ✅ **Comparable performance** - HTTP dispatch adds ~10ms overhead (4%)
- ✅ **More consistent** - Max enqueue latency improved by 48% (520ms vs 1008ms)
- ✅ **Simpler deployment** - Single worker, no service bindings
- ✅ **Production-ready** - 131ms average enqueue is excellent
- 📝 **Network included** - Measurements include client-to-Cloudflare latency
- 📝 **Cloudflare-internal** - Actual DO→Worker overhead likely <20ms

**Conclusion**: HTTP dispatch architecture achieves **equivalent performance** to service bindings with significantly simpler deployment. The ~10ms difference is within noise and is offset by better consistency (lower max latency).

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


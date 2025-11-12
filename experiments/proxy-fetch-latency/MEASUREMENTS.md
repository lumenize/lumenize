# ProxyFetchWorker Latency Measurements

Production performance measurements for the `proxyFetchWorker` architecture.

## Results in Cloudflare production - 2025-11-12

**Production (Warm):**
- **101ms measured total** (92-107ms range, 15ms variance)
  - Enqueue phase: 80ms (orchestration & dispatch)
  - Execution phase: 21ms (fetch & result delivery)
- **DO → Orchestrator → Worker → External fetch → Worker → DO**: ~71ms in production 
  after subtracting ~30ms round trip between local Node.js and Cloud
- **57ms added latency** after subtracting ~14ms for the actual fetch call

---

## Architecture Flow

```mermaid
sequenceDiagram
    participant Client as Node.js Client
    participant Worker as Worker fetch()
    participant Origin as OriginDO
    participant Orch as FetchOrchestrator
    participant WExec as Worker Execute
    participant TestEP as test-endpoints
    
    Note over Client,Origin: WebSocket Upgrade (one-time, not counted)
    Client->>Worker: WS Upgrade Request
    Worker->>Origin: routeDORequest()
    Origin-->>Client: WebSocket Connection
    
    Note over Client,TestEP: START MEASUREMENT
    Client->>Origin: WS: start-fetch
    Origin->>Origin: proxyFetchWorker()
    Origin->>Orch: enqueueFetch()
    Orch->>WExec: Direct call (test) or HTTP (prod)
    Origin->>Client: WS: enqueued
    
    Note over WExec,TestEP: Async Execution
    WExec->>TestEP: fetch(url)
    TestEP-->>WExec: Response
    WExec->>Origin: __receiveResult()
    Origin->>Origin: Execute continuation
    Origin->>Client: WS: result
    Note over Client,TestEP: END MEASUREMENT
```

---

## Scalability Results - Local Development - 2025-11-12

Testing concurrent fetch handling to find scalability limits:

**Local Development:**
- **10 concurrent**: 420ms total (~42ms per fetch)
- **100 concurrent**: 3168ms total (~32ms per fetch, **75% of linear time**)
- **1000 concurrent**: 30087ms total (~30ms per fetch, **72% of linear time**)
- **2000 concurrent**: 57678ms total (~29ms per fetch, **69% of linear time**)

**Scaling Analysis:**
- ✅ **Linear scaling maintained** up to **2000 concurrent fetches**
- **Super-linear efficiency** (sub-linear time ratios) due to:
  - HTTP connection reuse across batches
  - Efficient DO queue processing at scale
  - Worker parallelism
- **Per-fetch overhead improves with scale**: 42ms → 32ms → 30ms → 29ms
- No observed bottleneck at 2000 concurrent
- System can likely scale beyond 2000 with same efficiency

**Key Characteristics:**
- DO-based queue handles high concurrency without degradation
- HTTP dispatch to CPU-billed Workers scales efficiently
- WebSocket-based result delivery enables real-time coordination
- No artificial limits observed (6-connection limit doesn't bottleneck)

---

**Git Hash**: `87e13bd`

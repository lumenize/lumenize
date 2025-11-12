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

**Git Hash**: `87e13bd`

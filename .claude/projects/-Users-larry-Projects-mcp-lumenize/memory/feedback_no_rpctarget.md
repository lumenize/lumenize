---
name: no-rpctarget-capnproto
description: Avoid RpcTarget and Cap'n Web-based APIs in the Lumenize stack — use WorkerEntrypoint 
type: feedback
---

Avoid `RpcTarget` and Cap'n Web-based APIs in the Lumenize stack. Use `WorkerEntrypoint` and call via `this.lmz.call()` or Workers RPC or `getEntrypoint()` as appropriate.

**Why:** There is internal politics at Cloudflare around RpcTarget vs other approaches. Lumenize has chosen the non-RpcTarget camp. Additionally, RpcTarget keeps persistent handles open which incur wall-clock billing in DO contexts — bad for Lumenize's cost model where DOs should stay synchronous and avoid open connections.

**How to apply:** When designing cross-Worker or cross-DW communication, always use `WorkerEntrypoint` as the base class. Each method call should be an independent RPC request (fire-and-forget). Never extend `RpcTarget` for returned objects. Use `using` to dispose entrypoint stubs promptly. This applies to the DW validator wrapper, future NebulaWorker, and any new inter-Worker communication patterns.

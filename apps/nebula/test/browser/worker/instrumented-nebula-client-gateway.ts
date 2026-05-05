/**
 * InstrumentedNebulaClientGateway — bench-only Gateway subclass that emits
 * timing-marker WS frames during call handling.
 *
 * Used by the Gateway-hop benchmark (`tasks/gateway-hop-benchmark.md`) to
 * decompose end-to-end latency into "client→Gateway round trip" vs "Gateway-
 * onward cost" without trusting any Cloudflare-side clock. The Node test
 * client timestamps frame arrivals via `performance.now()`; the
 * unmeasurable Gateway-to-client one-way appears in both arrival times
 * and falls out of the subtraction.
 *
 * Phase 0 of the task uses this to verify the marker actually flushes
 * mid-invocation (rather than being held until invocation end alongside
 * the response). If the spike confirms that, this class graduates from
 * spike-only to permanent bench instrumentation.
 *
 * Production `NebulaClientGateway` is unchanged; only the bench Worker
 * binds `NEBULA_CLIENT_GATEWAY` to this subclass.
 */

import { NebulaClientGateway } from '@lumenize/nebula';
import type { CallContext, GatewayConnectionInfo } from '@lumenize/mesh';

/**
 * Marker frame schema. `type` is intentionally outside `GatewayMessageType`
 * so the base `LumenizeClient` falls through to `onUnknownMessage`, which
 * `HarnessNebulaClient` overrides to capture arrival timestamps.
 */
export const BENCH_MARKER_TYPE = 'bench_marker' as const;
export type BenchMarkerKind = 'received';
export interface BenchMarkerFrame {
  type: typeof BENCH_MARKER_TYPE;
  kind: BenchMarkerKind;
  /** Correlates this marker with the inbound CALL it was emitted for. */
  callId: string;
}

export class InstrumentedNebulaClientGateway extends NebulaClientGateway {
  /**
   * Emit a `received` marker the moment the Gateway has parsed an inbound
   * client CALL — before the cross-DO Workers RPC to the callee is dispatched.
   *
   * The hook is synchronous and runs inside `#handleClientCall`, which itself
   * runs inside `webSocketMessage`. Phase 0 confirmed (2026-05-05) that this
   * `ws.send()` flushes to the wire here, *before* the
   * `await stub.__executeOperation(...)` that follows.
   */
  override onBeforeCallToMesh(
    baseContext: CallContext,
    connectionInfo: GatewayConnectionInfo,
    callId: string,
  ): CallContext {
    const sockets = this.ctx.getWebSockets();
    const ws = sockets.find((s) => s.readyState === WebSocket.OPEN);
    if (ws) {
      const frame: BenchMarkerFrame = {
        type: BENCH_MARKER_TYPE,
        kind: 'received',
        callId,
      };
      ws.send(JSON.stringify(frame));
    }
    return super.onBeforeCallToMesh(baseContext, connectionInfo, callId);
  }
}

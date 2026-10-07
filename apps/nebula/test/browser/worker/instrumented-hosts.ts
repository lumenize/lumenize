/**
 * Bench-only host nodes that emit a timing-marker WS frame while handling a hosted Client's call.
 *
 * Used by the gateway-hop benchmark (`tasks/gateway-hop-benchmark.md`) to decompose end-to-end
 * latency into "client→host node round trip" vs "the host node's onward cost" without trusting any
 * Cloudflare-side clock. The Node test client timestamps frame arrivals via `performance.now()`; the
 * unmeasurable host-to-client one-way appears in both arrival times and falls out of the subtraction.
 *
 * A bench client is hosted by the node its page's host names, a Galaxy or a Star, so both carry the
 * marker. Production `Galaxy` and `Star` are unchanged; only the bench Worker binds `GALAXY` and
 * `STAR` to these.
 */

import { Galaxy } from '@lumenize/nebula';
import type { CallContext, GatewayConnectionInfo } from '@lumenize/mesh';
import { StarTest } from '../../test-apps/baseline/index';

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

/**
 * Emit a `received` marker down the calling Client's own socket the moment its host node has parsed
 * the CALL — before the call runs in place or goes onward by Workers RPC. The hook is synchronous
 * and runs inside `webSocketMessage`; for a Gateway, the benchmark's first spike confirmed (2026-05-05)
 * that this `ws.send()` flushes to the wire before the dispatch that follows.
 */
function sendReceivedMarker(ctx: DurableObjectState, connectionInfo: GatewayConnectionInfo, callId: string): void {
  const ws = ctx.getWebSockets(connectionInfo.instanceName).find((s) => s.readyState === WebSocket.OPEN);
  if (!ws) return;
  const frame: BenchMarkerFrame = { type: BENCH_MARKER_TYPE, kind: 'received', callId };
  ws.send(JSON.stringify(frame));
}

export class InstrumentedGalaxy extends Galaxy {
  override onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo, callId: string): CallContext {
    sendReceivedMarker(this.ctx, connectionInfo, callId);
    return super.onBeforeCallToMesh(baseContext, connectionInfo, callId);
  }
}

export class InstrumentedStar extends StarTest {
  override onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo, callId: string): CallContext {
    sendReceivedMarker(this.ctx, connectionInfo, callId);
    return super.onBeforeCallToMesh(baseContext, connectionInfo, callId);
  }
}

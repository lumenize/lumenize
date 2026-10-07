import { DurableObject } from 'cloudflare:workers';
import type { CallEnvelope } from './lmz-api.js';
import type { CallContext } from './types.js';
import { ClientGateway, type ClientGatewayHost } from './client-gateway.js';
import {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_TIMED_OUT,
  type CallMessage,
  type ResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
  type ConnectionStatusMessage,
  type GatewayMessage,
  type GatewayConnectionInfo,
} from './gateway-messages.js';

// Re-export so existing consumers that import these from
// `@lumenize/mesh` / `./lumenize-client-gateway.js` keep working.
export {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_TIMED_OUT,
};
export type {
  CallMessage,
  ResponseMessage,
  IncomingCallMessage,
  IncomingCallResponseMessage,
  ConnectionStatusMessage,
  GatewayMessage,
  GatewayConnectionInfo,
};

/**
 * LumenizeClientGateway — the Durable Object that hosts one `ClientGateway`.
 *
 * `ClientGateway` (`./client-gateway.ts`) is a Client's server-side half: it accepts the Client's
 * socket, builds the context of every call the Client makes from that socket's verified
 * attachment, forwards a node's call to the Client, and waits within a grace period for a Client
 * whose socket closed. This class gives it a Durable Object to run in, one per Client, named
 * `{sub}.{tabId}`, and every entry point below delegates to it.
 *
 * It extends `DurableObject` directly (NOT `LumenizeDO`) to keep its zero-storage design: nothing
 * it or its `ClientGateway` does touches `ctx.storage`. State is derived from the Client's socket,
 * that socket's attachment, and an in-memory grace period:
 *
 * | Client's socket | Grace period | State | subscriptionRequired on reconnect |
 * |-----------------|--------------|-------|-----------------------------------|
 * | Open | — | Connected | `false` (a supersede) |
 * | None | Running (≤5 s) | Grace Period | `false`, or `true` once a delivery to it failed |
 * | None | None, or ended | Disconnected | `true` |
 *
 * An evicted Gateway has no record of a grace period, so it reports `true`, the safe direction. A
 * delivery that failed is recorded on the grace period and on every socket the Client still holds,
 * open or closing, and the next connection is told `true` whatever the row says.
 *
 * Subclasses customize it through the three hooks below.
 */
export class LumenizeClientGateway extends DurableObject<any> implements ClientGatewayHost {
  #clientGateway = new ClientGateway(this.ctx, this.env, this, { singleClient: true });

  // ============================================
  // Extension Points (subclass overrides)
  // ============================================

  /**
   * Connection-time hook: validate instance name and optionally add claims.
   *
   * Called during WebSocket upgrade after JWT decoding. The base class
   * auto-includes all JWT payload fields in `claims`; if this hook returns
   * a `Record`, it is merged on top (`{ ...jwtPayload, ...hookResult }`).
   *
   * @returns `Response` to reject the upgrade, `Record` to merge on top of
   *          JWT claims, or `undefined` to accept with JWT claims only.
   */
  onBeforeAccept(
    instanceName: string,
    sub: string,
    jwtPayload: Record<string, unknown>
  ): Response | Record<string, unknown> | undefined {
    // Validate instance name format: {sub}.{tabId}
    const dotIndex = instanceName.indexOf('.');
    if (dotIndex === -1) {
      return new Response('Forbidden: invalid instance name format (expected sub.tabId)', { status: 403 });
    }
    if (instanceName.substring(0, dotIndex) !== sub) {
      return new Response('Forbidden: identity mismatch', { status: 403 });
    }

    // Accept with JWT claims only (no additional claims needed)
    return undefined;
  }

  /**
   * Pre-dispatch hook: enrich the CallContext before a client call is routed to a DO.
   *
   * Called from `ClientGateway`'s `#handleClientCall` after building the base CallContext.
   * Return the (possibly enriched) CallContext.
   *
   * `callId` is the inbound CALL message's callId — useful for tracing /
   * instrumentation that wants to correlate this hook firing with the
   * original client request.
   */
  onBeforeCallToMesh(
    baseContext: CallContext,
    connectionInfo: GatewayConnectionInfo,
    callId: string
  ): CallContext {
    return baseContext;
  }

  /**
   * Pre-forward hook: validate a DO-initiated call before forwarding to the client.
   *
   * Called after `__executeOperation` has acked, immediately before the call is sent down the
   * socket. `connectionInfo` carries the connected client's verified identity and claims. Throw to
   * refuse the call: the Error fills the calling node's continuation, which fires back to it. It
   * returns `undefined` rather than `void` so that an `async` override, whose rejected Promise would
   * refuse nothing, does not compile.
   */
  onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): undefined {
    // No validation by default
  }

  // ============================================
  // Entry points — each delegates to the ClientGateway
  // ============================================

  /** A WebSocket upgrade from the Client. */
  async fetch(request: Request): Promise<Response> {
    return this.#clientGateway.acceptUpgrade(request);
  }

  /** A message from the Client's socket. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#clientGateway.receiveMessage(ws, message);
  }

  /** The Client's socket closed; starts its grace period unless a new connection superseded it. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#clientGateway.socketClosed(ws, code, reason);
  }

  /** The Client's socket errored. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.#clientGateway.socketErrored(ws, error);
  }

  /**
   * A mesh node's call to the Client: `this.lmz.call('LUMENIZE_CLIENT_GATEWAY', clientId, ...)`.
   * Acks once the envelope's version checks out, then answers through the node's own fire-back
   * door, as a node does.
   */
  async __executeOperation(envelope: CallEnvelope): Promise<{ $ack: true } | { $error: any }> {
    return this.#clientGateway.executeOperation(envelope);
  }

  /**
   * The Gateway's fire-back door: a node fires a Client's filled result handler continuation here,
   * exactly as it would to any caller, and `ClientGateway` sends it down to the Client named in
   * the envelope's `metadata.callee`, on its current socket.
   *
   * `onBeforeCallToClient` does not run here: the answer is solicited, the continuation is the one
   * the Client sent, and this Gateway wrote its return address from the socket's attachment.
   *
   * @internal Fired at by the framework, not for direct use.
   */
  async __handleResponse(envelope: CallEnvelope): Promise<{ $ack: true }> {
    return this.#clientGateway.receiveFireBack(envelope);
  }
}

/**
 * Gateway wire-protocol primitives — shared between `MeshClient` and
 * `ClientGateway`, its server-side half.
 *
 * **This module must have zero imports from `cloudflare:workers`**, so that
 * `MeshClient` (which imports `GatewayMessageType` and `ClientDisconnectedError`
 * from here) can be loaded in Node.js and browsers without the `cloudflare:workers`
 * module-load failure.
 *
 * Type-only imports from `./types.js` are fine — TypeScript strips them at
 * compile time, and even if the upstream file eventually imports Workers-only
 * modules, the type-only path doesn't pull them in at runtime.
 *
 * See `tasks/mesh-client-node-import.md` for the full context on why this
 * separation exists.
 */

import type { NodeIdentity, OriginAuth, OriginRequest } from './types.js';

// ============================================
// Close Codes
// ============================================

/** Close code for superseded connections (parallel to HTTP 409 Conflict) */
export const WS_CLOSE_SUPERSEDED = 4409;

/**
 * Close code for a Client whose socket was open when the Gateway gave up on a delivery to it, which
 * in practice means it missed the 30 s wait for an answer (parallel to HTTP 408 Request Timeout).
 * The Gateway answered that call `ClientDisconnectedError`, which a reaper drops a subscriber row
 * on. The close makes a paused tab reconnect when it wakes, and the Gateway tells that connection
 * `subscriptionRequired: true`.
 */
export const WS_CLOSE_TIMED_OUT = 4408;

/**
 * Close code for a Client whose host node is being deleted (parallel to HTTP 410 Gone). A host
 * closes every Client socket it holds with it before its storage goes, so a Client can tell a
 * deleted scope from a reset, which drops its socket with no code of the host's.
 */
export const WS_CLOSE_GONE = 4410;

// ============================================
// Protocol name
// ============================================

/**
 * The subprotocol a Client offers and its Gateway accepts, beside the access-token one. A Gateway
 * answers 426 to an upgrade that offers only the previous name, `lmz`: that Client speaks the
 * previous wire, which this version no longer has.
 */
export const WS_PROTOCOL = 'lmz.2';

// ============================================
// Access-token subprotocol
// ============================================

/**
 * Subprotocol prefix carrying the access token on a WebSocket upgrade.
 *
 * ⚠️ **A PUBLISHED WIRE CONVENTION, not an internal detail.** `website/docs/mesh/security.mdx`
 * teaches third parties to hand-write `new WebSocket(url, ['lmz.2', \`lmz.access-token.${'${token}'}\`])`,
 * and deployed clients already send this exact string — so changing the value is a breaking
 * protocol change, not a rename. `mesh/test/ws-token-subprotocol.test.ts` pins the literal for
 * that reason; a producer→consumer round-trip cannot catch it, being true by construction once
 * both ends share this constant.
 *
 * Lives here because this module is the Workers-free wire-protocol home: the PRODUCER
 * (`lumenize-client.ts` `#connect`) and the `@lumenize/mesh/client` entry both reach it without
 * dragging `cloudflare:workers` into a browser bundle.
 *
 * ⚠️ `packages/auth/src/hooks.ts` keeps its own copy of this prefix and of
 * {@link extractWebSocketToken}, deliberately — `auth` must not depend on `mesh`. See the
 * reciprocal note there.
 */
export const WS_TOKEN_PREFIX = 'lmz.access-token.';

/**
 * Pull the access token out of a WebSocket upgrade's `Sec-WebSocket-Protocol` header.
 *
 * Returns `null` when the header is absent or carries no token protocol — callers decide
 * whether that is a rejection, since some upgrades are legitimately unauthenticated.
 */
export function extractWebSocketToken(request: Request): string | null {
  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (!protocolHeader) {
    return null;
  }

  const protocols = protocolHeader.split(',').map((p) => p.trim());

  for (const protocol of protocols) {
    if (protocol.startsWith(WS_TOKEN_PREFIX)) {
      return protocol.slice(WS_TOKEN_PREFIX.length);
    }
  }

  return null;
}

// ============================================
// Wire Protocol Message Types
// ============================================

/** Message types for Gateway-Client communication */
export const GatewayMessageType = {
  /** Client initiating a call to a mesh node */
  CALL: 'call',
  /** Gateway delivering a Client's filled result handler continuation */
  RESPONSE: 'response',
  /** Mesh node calling the client (forwarded by Gateway) */
  INCOMING_CALL: 'incoming_call',
  /** Client's response to an incoming call */
  INCOMING_CALL_RESPONSE: 'incoming_call_response',
  /** Post-handshake status (sent immediately after connection) */
  CONNECTION_STATUS: 'connection_status',
} as const;

export type GatewayMessageType = typeof GatewayMessageType[keyof typeof GatewayMessageType];

// ============================================
// Wire Protocol Message Interfaces
// ============================================

/**
 * WebSocket Wire Protocol Serialization
 *
 * All messages use JSON over WebSocket. Fields that may contain extended types
 * (Maps, Sets, Dates, custom Errors) use @lumenize/structured-clone:
 *
 * | Field | Preprocessing | Notes |
 * |-------|---------------|-------|
 * | `chain` | Always | May contain any type in method args |
 * | `result` | Always | Method return value, any type |
 * | `error` | Always | Custom Error subclasses with properties |
 * | Other fields | Never | Plain strings/booleans |
 *
 * Note: `error` uses preprocessing to preserve custom Error properties
 * that native structured clone would lose.
 */

/** Message from client initiating a mesh call */
export interface CallMessage {
  type: typeof GatewayMessageType.CALL;
  callId: string;
  /** The id this Client minted when it was constructed; the answer echoes it. */
  loadId: string;
  binding: string;
  instance?: string;
  /** Preprocessed operation chain (contains method args which may be any type) */
  chain: any;
  /** Preprocessed result handler continuation, which travels to the node and back */
  handler: any;
  /** When true, the node fires the handler back only with an Error */
  onErrorOnly?: boolean;
  // No callContext: the Gateway builds all of a client call's context from the socket's verified
  // attachment, so a frame has nothing of its own to add.
}

/**
 * A Client's own result handler continuation, filled with the outcome: from a node's fire-back,
 * or from a refusal at the early ack. The Client runs it with the `@mesh()` check off.
 */
export interface ResponseMessage {
  type: typeof GatewayMessageType.RESPONSE;
  callId: string;
  loadId: string;
  /** Preprocessed filled handler chain */
  chain: any;
  /** The fire-back's context: its last hop is the node that answered. */
  callContext: {
    callChain: NodeIdentity[];
    originAuth?: OriginAuth;
  };
}

/** Mesh node calling the client (forwarded by Gateway) */
export interface IncomingCallMessage {
  type: typeof GatewayMessageType.INCOMING_CALL;
  callId: string;
  /** Preprocessed operation chain */
  chain: any;
  /**
   * Deliberately NOT the whole `CallContext`: `originRequest` stays server-side and never reaches
   * a client. `OriginRequest`'s JSDoc says why.
   */
  callContext: {
    /** Plain strings - no preprocessing needed */
    callChain: NodeIdentity[];
    originAuth?: OriginAuth;
  };
}

/** Client's response to an incoming call */
export interface IncomingCallResponseMessage {
  type: typeof GatewayMessageType.INCOMING_CALL_RESPONSE;
  callId: string;
  success: boolean;
  /** Preprocessed result */
  result?: any;
  /** Preprocessed error (preserves custom Error properties) */
  error?: any;
}

/** Post-handshake status message */
export interface ConnectionStatusMessage {
  type: typeof GatewayMessageType.CONNECTION_STATUS;
  subscriptionRequired: boolean;
  /**
   * The Client's address on the node that accepted it, `STAR/acme.crm.tenant1/alice.9f2c41aa`: the
   * host's binding and the name it holds the Client under (`addressOf`). The Client reports it as
   * its own identity, since nothing on the page names the binding.
   */
  address: string;
}

/** Union of all Gateway messages */
export type GatewayMessage =
  | CallMessage
  | ResponseMessage
  | IncomingCallMessage
  | IncomingCallResponseMessage
  | ConnectionStatusMessage;

// ============================================
// Custom Errors
// ============================================

/**
 * The Gateway's verdict that a client is gone, which a reaper drops the client's subscriber row on.
 *
 * Only the Gateway raises it, when:
 * - A mesh node calls a client that is not connected
 * - The client's grace period has expired, including one the Gateway started by closing a socket
 *   whose token had expired
 * - The client doesn't respond within the timeout
 *
 * A client's own answer carrying this name, returned or thrown, reaches the node renamed `Error`,
 * so no client can get a subscriber row dropped by saying it is gone.
 *
 * Registered on globalThis below for proper structured-clone serialization
 * across mesh nodes.
 */
export class ClientDisconnectedError extends Error {
  name = 'ClientDisconnectedError';

  constructor(message: string = 'Client is not connected') {
    super(message);
  }
}

// Register on globalThis for @lumenize/structured-clone deserialization
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

// ============================================
// WebSocket Attachment / Connection Info
// ============================================

/**
 * Identity and claims stored in the WebSocket attachment (survives hibernation)
 * and passed to lifecycle hooks (`onBeforeAccept`, `onBeforeCallToMesh`,
 * `onBeforeCallToClient`).
 *
 * `sub` is a convenience field that duplicates `claims.sub`.
 * Token expiration is available as `claims.exp`.
 */
export interface GatewayConnectionInfo {
  /** Subject ID from verified JWT. Also present as `claims.sub` (convenience field). */
  sub: string;
  /** DO binding name from `X-Lumenize-DO-Binding-Name` routing header. */
  bindingName: string;
  /** DO instance name from `X-Lumenize-DO-Instance-Name-Or-Id` routing header. */
  instanceName: string;
  /** All JWT payload fields, plus any additional claims from `onBeforeAccept`. */
  claims: Record<string, unknown>;
  /**
   * HTTP facts of the upgrade request, snapshotted at accept — becomes `callContext.originRequest`
   * on every call this connection originates. Rebuilt on every reconnect, so it refreshes exactly
   * when the socket does. Budget: ~250–350 bytes against the 2 KB `serializeAttachment` cap this
   * attachment shares with `claims` (a comment, not an enforcement, in v1).
   */
  originRequest?: OriginRequest;
  /**
   * Set by the Gateway once a delivery to this Client failed while this socket was its socket, so a
   * reaper may have dropped the Client's subscriptions. It rides the socket rather than the grace
   * period, which ends, and is not lost when the Gateway is evicted.
   */
  subscriptionsLost?: true;
}

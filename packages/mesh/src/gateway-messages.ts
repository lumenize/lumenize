/**
 * Gateway wire-protocol primitives — shared between `LumenizeClient` and
 * `LumenizeClientGateway`.
 *
 * **This module must have zero imports from `cloudflare:workers`**, so that
 * `LumenizeClient` (which imports `GatewayMessageType` and `ClientDisconnectedError`
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

import type { NodeIdentity, OriginAuth } from './types.js';

// ============================================
// Close Codes
// ============================================

/** Close code for superseded connections (parallel to HTTP 409 Conflict) */
export const WS_CLOSE_SUPERSEDED = 4409;

// ============================================
// Wire Protocol Message Types
// ============================================

/** Message types for Gateway-Client communication */
export const GatewayMessageType = {
  /** Client initiating a call to a mesh node */
  CALL: 'call',
  /** Gateway returning the result of a client-initiated call */
  CALL_RESPONSE: 'call_response',
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
 * | `callContext.state` | Always | User-defined, may contain extended types |
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
  binding: string;
  instance?: string;
  /** Preprocessed operation chain (contains method args which may be any type) */
  chain: any;
  callContext?: {
    /** Plain strings - no preprocessing needed */
    callChain: NodeIdentity[];
    /** User-defined, preprocessed for WebSocket (may contain Maps, Sets, etc.) */
    state: any;
  };
}

/** Response to a client-initiated call */
export interface CallResponseMessage {
  type: typeof GatewayMessageType.CALL_RESPONSE;
  callId: string;
  success: boolean;
  /** Preprocessed result (may be any type) */
  result?: any;
  /** Preprocessed error (preserves custom Error properties) */
  error?: any;
}

/** Mesh node calling the client (forwarded by Gateway) */
export interface IncomingCallMessage {
  type: typeof GatewayMessageType.INCOMING_CALL;
  callId: string;
  /** Preprocessed operation chain */
  chain: any;
  callContext: {
    /** Plain strings - no preprocessing needed */
    callChain: NodeIdentity[];
    originAuth?: OriginAuth;
    /** User-defined, preprocessed for WebSocket */
    state: any;
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
}

/** Union of all Gateway messages */
export type GatewayMessage =
  | CallMessage
  | CallResponseMessage
  | IncomingCallMessage
  | IncomingCallResponseMessage
  | ConnectionStatusMessage;

// ============================================
// Custom Errors
// ============================================

/**
 * Error thrown when attempting to call a disconnected client
 *
 * This error is thrown when:
 * - A mesh node calls a client that is not connected
 * - The client's grace period has expired
 * - The client doesn't respond within the timeout
 *
 * Registered on globalThis below for proper structured-clone serialization
 * across mesh nodes.
 */
export class ClientDisconnectedError extends Error {
  name = 'ClientDisconnectedError';

  constructor(
    message: string = 'Client is not connected',
    public readonly clientInstanceName?: string
  ) {
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
}

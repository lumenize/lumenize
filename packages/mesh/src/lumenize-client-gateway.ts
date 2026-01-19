import { DurableObject } from 'cloudflare:workers';
import { stringify, parse } from '@lumenize/structured-clone';
import { getDOStub } from '@lumenize/utils';
import { debug, type DebugLogger } from '@lumenize/debug';
import type { CallEnvelope } from './lmz-api.js';
import type { NodeIdentity, CallContext, OriginAuth } from './types.js';

// ============================================
// Constants
// ============================================

/** Grace period before marking subscriptions as lost (5 seconds) */
const GRACE_PERIOD_MS = 5000;

/** Marker alarm offset - 100 years in the future (no ongoing cost for pending alarms) */
const MARKER_ALARM_OFFSET_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Timeout for client to respond to an incoming call (30 seconds) */
const CLIENT_CALL_TIMEOUT_MS = 30000;

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

/** Message from client initiating a mesh call */
export interface CallMessage {
  type: typeof GatewayMessageType.CALL;
  callId: string;
  binding: string;
  instance?: string;
  chain: any; // Serialized operation chain
  callContext?: {
    callChain: NodeIdentity[];
    state: Record<string, unknown>;
  };
}

/** Response to a client-initiated call */
export interface CallResponseMessage {
  type: typeof GatewayMessageType.CALL_RESPONSE;
  callId: string;
  success: boolean;
  result?: any; // Serialized result
  error?: any;  // Serialized error
}

/** Mesh node calling the client (forwarded by Gateway) */
export interface IncomingCallMessage {
  type: typeof GatewayMessageType.INCOMING_CALL;
  callId: string;
  chain: any; // Serialized operation chain
  callContext: {
    origin: NodeIdentity;
    originAuth?: OriginAuth;
    callChain: NodeIdentity[];
    state: Record<string, unknown>;
  };
}

/** Client's response to an incoming call */
export interface IncomingCallResponseMessage {
  type: typeof GatewayMessageType.INCOMING_CALL_RESPONSE;
  callId: string;
  success: boolean;
  result?: any; // Serialized result
  error?: any;  // Serialized error
}

/** Post-handshake status message */
export interface ConnectionStatusMessage {
  type: typeof GatewayMessageType.CONNECTION_STATUS;
  subscriptionsLost: boolean;
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
 * Register on globalThis for proper serialization across mesh nodes:
 * ```typescript
 * (globalThis as any).ClientDisconnectedError = ClientDisconnectedError;
 * ```
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

// Register on globalThis for @lumenize/structured-clone serialization
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

// ============================================
// WebSocket Attachment Types
// ============================================

/** Data stored in WebSocket attachment (survives hibernation) */
interface WebSocketAttachment {
  /** Verified user ID from JWT */
  userId: string;
  /** Additional JWT claims */
  claims?: Record<string, unknown>;
  /** Token expiration timestamp (seconds since epoch) */
  tokenExp?: number;
  /** When the connection was established */
  connectedAt: number;
  /** Instance name of this Gateway (for identity) */
  instanceName?: string;
}

// ============================================
// Internal Types
// ============================================

/** Pending call waiting for client response */
interface PendingCall {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Waiter for client reconnection during grace period */
interface ReconnectWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

// ============================================
// LumenizeClientGateway
// ============================================

/**
 * LumenizeClientGateway - Zero-storage WebSocket bridge for mesh clients
 *
 * This Durable Object bridges browser/Node.js clients into the Lumenize Mesh.
 * It extends DurableObject directly (NOT LumenizeDO) to maintain zero-storage design.
 *
 * **Design Principles:**
 * - Zero storage operations (no ctx.storage.kv, no ctx.storage.sql)
 * - State derived from getWebSockets(), getAlarm(), and WebSocket attachments
 * - 1:1 relationship with clients (each client has its own Gateway instance)
 * - Transparent proxying (doesn't interpret calls, just forwards them)
 * - Trust DMZ (builds callContext.origin/originAuth from verified sources)
 *
 * **Connection States (derived, not stored):**
 * | getWebSockets() | getAlarm() | State | Behavior |
 * |-----------------|------------|-------|----------|
 * | Has connection | Any | Connected | Forward calls immediately |
 * | Empty | Pending | Grace Period | Wait for reconnect (up to 5s) |
 * | Empty | None | Disconnected | Throw ClientDisconnectedError |
 */
export class LumenizeClientGateway extends DurableObject<any> {
  /** Debug logger factory - call with namespace to get logger */
  #debugFactory: (namespace: string) => DebugLogger = debug(this as unknown as { env: { DEBUG?: string } });

  /** Pending calls waiting for client response */
  #pendingCalls = new Map<string, PendingCall>();

  /** Waiters for client reconnection during grace period */
  #pendingReconnectWaiters: ReconnectWaiter[] = [];

  /**
   * Handle incoming HTTP requests (primarily WebSocket upgrades)
   */
  async fetch(request: Request): Promise<Response> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.fetch');

    // Only handle WebSocket upgrades
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Extract verified identity from headers (set by auth middleware)
    const userId = request.headers.get('X-Auth-User-Id');
    if (!userId) {
      log.warn('WebSocket upgrade rejected: missing X-Auth-User-Id header');
      return new Response('Unauthorized: missing identity', { status: 401 });
    }

    // Extract instance name from routing headers (set by routeDORequest)
    const instanceName = request.headers.get('X-Lumenize-DO-Instance-Name-Or-Id') ?? undefined;

    // Parse claims if present
    let claims: Record<string, unknown> | undefined;
    const claimsHeader = request.headers.get('X-Auth-Claims');
    if (claimsHeader) {
      try {
        claims = JSON.parse(claimsHeader);
      } catch (e) {
        log.warn('Failed to parse X-Auth-Claims header', { claimsHeader });
      }
    }

    // Extract token expiration if present (for expiration checks)
    let tokenExp: number | undefined;
    const tokenExpHeader = request.headers.get('X-Auth-Token-Exp');
    if (tokenExpHeader) {
      tokenExp = parseInt(tokenExpHeader, 10);
    }

    // Validate identity matches Gateway instance name (security check)
    // Gateway instance name MUST follow format: {userId}.{tabId}
    // This prevents reconnection hijacking during the 5-second grace period
    if (!instanceName) {
      log.warn('WebSocket upgrade rejected: missing instance name header');
      return new Response('Forbidden: missing instance name', { status: 403 });
    }

    const dotIndex = instanceName.indexOf('.');
    if (dotIndex === -1) {
      log.warn('Invalid instance name format', { instanceName, expected: '{userId}.{tabId}' });
      return new Response('Forbidden: invalid instance name format (expected userId.tabId)', { status: 403 });
    }

    const instanceUserId = instanceName.substring(0, dotIndex);
    if (instanceUserId !== userId) {
      log.warn('Identity mismatch: userId does not match instance name prefix', {
        userId,
        instanceUserId,
        instanceName
      });
      return new Response('Forbidden: identity mismatch', { status: 403 });
    }

    // Determine if subscriptions were lost (before accepting new connection)
    const subscriptionsLost = await this.#determineSubscriptionState();

    // Accept WebSocket with hibernation support
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Store verified identity in WebSocket attachment
    const attachment: WebSocketAttachment = {
      userId,
      claims,
      tokenExp,
      connectedAt: Date.now(),
      instanceName,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // Resolve any pending reconnect waiters
    this.#resolveReconnectWaiters();

    // Clear grace period alarm if set
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null) {
      await this.ctx.storage.deleteAlarm();
    }

    // Send connection status immediately after accepting
    const statusMessage: ConnectionStatusMessage = {
      type: GatewayMessageType.CONNECTION_STATUS,
      subscriptionsLost,
    };
    server.send(stringify(statusMessage));

    log.info('WebSocket connection accepted', {
      userId,
      instanceName,
      subscriptionsLost,
    });

    // Return upgrade response with 'lmz' protocol
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'Sec-WebSocket-Protocol': 'lmz',
      },
    });
  }

  /**
   * Handle incoming WebSocket messages from the client
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.webSocketMessage');

    // Only handle string messages (JSON)
    if (typeof message !== 'string') {
      log.warn('Received non-string message, ignoring');
      return;
    }

    // Check token expiration
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (attachment?.tokenExp && attachment.tokenExp < Date.now() / 1000) {
      log.warn('Token expired, closing connection');
      ws.close(4401, 'Token expired');
      return;
    }

    let parsed: GatewayMessage;
    try {
      parsed = parse(message) as GatewayMessage;
    } catch (e) {
      log.error('Failed to parse message', { error: e });
      return;
    }

    switch (parsed.type) {
      case GatewayMessageType.CALL:
        await this.#handleClientCall(ws, parsed as CallMessage, attachment);
        break;

      case GatewayMessageType.INCOMING_CALL_RESPONSE:
        this.#handleIncomingCallResponse(parsed as IncomingCallResponseMessage);
        break;

      default:
        log.warn('Unknown message type', { type: (parsed as any).type });
    }
  }

  /**
   * Handle WebSocket close event
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.webSocketClose');

    log.info('WebSocket closed', { code, reason });

    // Set grace period alarm (5 seconds)
    // If client reconnects before alarm fires, subscriptions are preserved
    await this.ctx.storage.setAlarm(Date.now() + GRACE_PERIOD_MS);
  }

  /**
   * Handle WebSocket error event
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.webSocketError');
    log.error('WebSocket error', { error });
  }

  /**
   * Handle alarm (grace period expired)
   */
  async alarm(): Promise<void> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.alarm');

    // Check if this is a marker alarm (far future) - ignore those
    // Marker alarms are set when grace period expires, not when this method is called
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm && currentAlarm > Date.now() + GRACE_PERIOD_MS) {
      // This is a marker alarm check, not a grace period expiry
      return;
    }

    // Grace period expired - client didn't reconnect
    log.info('Grace period expired, marking subscriptions as lost');

    // Set marker alarm so we know subscriptions were lost when client reconnects
    await this.ctx.storage.setAlarm(Date.now() + MARKER_ALARM_OFFSET_MS);

    // Reject all pending reconnect waiters
    this.#rejectReconnectWaiters(new ClientDisconnectedError(
      'Client did not reconnect within grace period',
      this.#getInstanceName()
    ));
  }

  /**
   * Receive and execute an RPC call from a mesh node destined for the client
   *
   * This is called by mesh nodes via: this.lmz.call('LUMENIZE_CLIENT_GATEWAY', clientId, ...)
   */
  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.__executeOperation');

    // Validate envelope version
    if (!envelope.version || envelope.version !== 1) {
      throw new Error(`Unsupported RPC envelope version: ${envelope.version}`);
    }

    // Get active WebSocket connection
    let ws = this.#getActiveWebSocket();

    if (!ws) {
      // Check if we're in grace period
      const alarm = await this.ctx.storage.getAlarm();

      if (alarm !== null && alarm <= Date.now() + GRACE_PERIOD_MS) {
        // In grace period - wait for reconnection
        log.info('Client disconnected, waiting for reconnect during grace period');
        await this.#waitForReconnect();
        ws = this.#getActiveWebSocket();

        if (!ws) {
          throw new ClientDisconnectedError(
            'Client did not reconnect in time',
            this.#getInstanceName()
          );
        }
      } else {
        // Not in grace period - client is disconnected
        throw new ClientDisconnectedError(
          'Client is not connected',
          this.#getInstanceName()
        );
      }
    }

    // Check token expiration before forwarding
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    if (attachment?.tokenExp && attachment.tokenExp < Date.now() / 1000) {
      log.warn('Token expired, closing connection');
      ws.close(4401, 'Token expired');
      throw new ClientDisconnectedError(
        'Client token expired',
        this.#getInstanceName()
      );
    }

    // Forward call to client and wait for response
    return await this.#forwardToClient(ws, envelope);
  }

  // ============================================
  // Private Methods - Call Handling
  // ============================================

  /**
   * Handle a call from the client to a mesh node
   */
  async #handleClientCall(
    ws: WebSocket,
    message: CallMessage,
    attachment: WebSocketAttachment | null
  ): Promise<void> {
    const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.#handleClientCall');
    const { callId, binding, instance, chain, callContext: clientContext } = message;

    try {
      // Build origin identity from VERIFIED sources (WebSocket attachment)
      const origin: NodeIdentity = {
        type: 'LumenizeClient',
        bindingName: 'LUMENIZE_CLIENT_GATEWAY', // Clients connect through Gateway binding
        instanceName: attachment?.instanceName,
      };

      // Build originAuth from VERIFIED sources (WebSocket attachment)
      const originAuth: OriginAuth | undefined = attachment?.userId
        ? {
            userId: attachment.userId,
            claims: attachment.claims,
          }
        : undefined;

      // Build callee identity
      const callee: NodeIdentity = {
        type: instance ? 'LumenizeDO' : 'LumenizeWorker',
        bindingName: binding,
        instanceName: instance,
      };

      // Build callContext - origin/originAuth from verified sources, chain/state from client
      const callContext: CallContext = {
        origin,
        originAuth,
        callChain: clientContext?.callChain ?? [],
        callee,
        state: clientContext?.state ?? {},
      };

      // Build envelope
      const envelope: CallEnvelope = {
        version: 1,
        chain,
        callContext,
        metadata: {
          caller: {
            type: 'LumenizeClient',
            bindingName: 'LUMENIZE_CLIENT_GATEWAY',
            instanceNameOrId: attachment?.instanceName,
          },
          callee: {
            type: callee.type,
            bindingName: binding,
            instanceNameOrId: instance,
          },
        },
      };

      // Get stub and call
      let stub: any;
      if (instance) {
        stub = getDOStub(this.env[binding], instance);
      } else {
        stub = this.env[binding];
      }

      const result = await stub.__executeOperation(envelope);

      // Send success response
      const response: CallResponseMessage = {
        type: GatewayMessageType.CALL_RESPONSE,
        callId,
        success: true,
        result: result, // Already serialized by structured-clone
      };
      ws.send(stringify(response));

    } catch (error) {
      log.error('Call failed', { callId, binding, instance, error });

      // Send error response
      const response: CallResponseMessage = {
        type: GatewayMessageType.CALL_RESPONSE,
        callId,
        success: false,
        error: error, // Let structured-clone serialize the error
      };
      ws.send(stringify(response));
    }
  }

  /**
   * Handle a response from the client to an incoming call
   */
  #handleIncomingCallResponse(message: IncomingCallResponseMessage): void {
    const { callId, success, result, error } = message;

    const pending = this.#pendingCalls.get(callId);
    if (!pending) {
      const log = this.#debugFactory('lmz.mesh.LumenizeClientGateway.#handleIncomingCallResponse');
      log.warn('Received response for unknown call', { callId });
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.#pendingCalls.delete(callId);

    // Resolve or reject
    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Forward a mesh call to the client and wait for response
   */
  async #forwardToClient(ws: WebSocket, envelope: CallEnvelope): Promise<any> {
    const callId = crypto.randomUUID();

    // Build incoming call message for client
    const message: IncomingCallMessage = {
      type: GatewayMessageType.INCOMING_CALL,
      callId,
      chain: envelope.chain,
      callContext: {
        origin: envelope.callContext.origin,
        originAuth: envelope.callContext.originAuth,
        callChain: envelope.callContext.callChain,
        state: envelope.callContext.state,
      },
    };

    return new Promise<any>((resolve, reject) => {
      // Set timeout for client response
      const timeout = setTimeout(() => {
        this.#pendingCalls.delete(callId);
        reject(new ClientDisconnectedError(
          'Client call timed out',
          this.#getInstanceName()
        ));
      }, CLIENT_CALL_TIMEOUT_MS);

      // Track pending call
      this.#pendingCalls.set(callId, { resolve, reject, timeout });

      // Send to client
      ws.send(stringify(message));
    });
  }

  // ============================================
  // Private Methods - Connection State
  // ============================================

  /**
   * Get the active WebSocket connection (if any)
   */
  #getActiveWebSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets();
    return sockets.length > 0 ? sockets[0] : null;
  }

  /**
   * Get the instance name of this Gateway DO from the WebSocket attachment
   */
  #getInstanceName(): string | undefined {
    const ws = this.#getActiveWebSocket();
    if (ws) {
      const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
      return attachment?.instanceName;
    }
    return undefined;
  }

  /**
   * Determine if subscriptions were lost based on alarm state
   */
  async #determineSubscriptionState(): Promise<boolean> {
    const alarm = await this.ctx.storage.getAlarm();

    if (alarm === null) {
      // Fresh connection (never disconnected)
      return false;
    }

    if (alarm > Date.now() + GRACE_PERIOD_MS) {
      // Marker alarm - grace period had expired
      await this.ctx.storage.deleteAlarm();
      return true;
    }

    // Alarm still in grace period range - subscriptions intact
    await this.ctx.storage.deleteAlarm();
    return false;
  }

  // ============================================
  // Private Methods - Grace Period
  // ============================================

  /**
   * Wait for client to reconnect during grace period
   */
  async #waitForReconnect(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();

    if (alarm === null) {
      throw new ClientDisconnectedError(
        'Client is not connected and no grace period active',
        this.#getInstanceName()
      );
    }

    // Check if alarm is a marker (far future) - means grace period already expired
    if (alarm > Date.now() + GRACE_PERIOD_MS) {
      throw new ClientDisconnectedError(
        'Client grace period has expired',
        this.#getInstanceName()
      );
    }

    const remainingMs = alarm - Date.now();
    if (remainingMs <= 0) {
      throw new ClientDisconnectedError(
        'Client grace period has expired',
        this.#getInstanceName()
      );
    }

    return new Promise((resolve, reject) => {
      // Add to waiters list - will be resolved when client reconnects
      this.#pendingReconnectWaiters.push({ resolve, reject });

      // Note: We don't set a timeout here because the alarm() method
      // will reject all waiters when grace period expires
    });
  }

  /**
   * Resolve all pending reconnect waiters (called when client reconnects)
   */
  #resolveReconnectWaiters(): void {
    const waiters = this.#pendingReconnectWaiters;
    this.#pendingReconnectWaiters = [];

    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /**
   * Reject all pending reconnect waiters (called when grace period expires)
   */
  #rejectReconnectWaiters(error: Error): void {
    const waiters = this.#pendingReconnectWaiters;
    this.#pendingReconnectWaiters = [];

    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}

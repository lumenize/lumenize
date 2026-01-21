import { stringify, parse } from '@lumenize/structured-clone';
import {
  newContinuation,
  executeOperationChain,
  replaceNestedOperationMarkers,
  getOperationChain,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';

// Re-export continuation types from ocan for convenience
export type { Continuation, AnyContinuation };
import {
  runWithCallContext,
  captureCallContext,
  buildOutgoingCallContext,
  type CallEnvelope
} from './lmz-api.js';
import {
  GatewayMessageType,
  type CallMessage,
  type CallResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
  type ConnectionStatusMessage,
  type GatewayMessage
} from './lumenize-client-gateway.js';
import type { NodeIdentity, CallContext, CallOptions } from './types.js';

// ============================================
// Constants
// ============================================

/** Maximum number of queued messages during disconnection */
const MAX_QUEUE_SIZE = 100;

/** Maximum reconnect backoff delay (30 seconds) */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Initial reconnect delay (1 second) */
const INITIAL_RECONNECT_DELAY_MS = 1000;

/** Timeout for callRaw() when queued during disconnection (30 seconds) */
const CALL_RAW_QUEUE_TIMEOUT_MS = 30000;

/** Default gateway binding name */
const DEFAULT_GATEWAY_BINDING = 'LUMENIZE_CLIENT_GATEWAY';

/** Default token refresh endpoint */
const DEFAULT_REFRESH_ENDPOINT = '/auth/refresh-token';

// ============================================
// Types
// ============================================

/**
 * Connection state for LumenizeClient
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Error thrown when the user must re-login
 *
 * This error is passed to `onLoginRequired` when:
 * - The refresh token has expired (HTTP 401 from refresh endpoint)
 * - No token was provided (WebSocket close code 4400)
 * - Token signature is invalid (WebSocket close code 4403)
 */
export class LoginRequiredError extends Error {
  name = 'LoginRequiredError';

  constructor(
    message: string,
    public readonly code: number,
    public readonly reason: string
  ) {
    super(message);
  }
}

// Register on globalThis for @lumenize/structured-clone serialization
(globalThis as any).LoginRequiredError = LoginRequiredError;

/**
 * Configuration for LumenizeClient
 */
export interface LumenizeClientConfig {
  /**
   * Base URL for WebSocket connection
   *
   * Default: current origin in browsers (e.g., `https://` → `wss://`)
   * Required in Node.js environments.
   */
  baseUrl?: string;

  /**
   * Unique client identifier
   *
   * Recommended format: `${userId}.${tabId}`
   * This becomes the Gateway DO instance name.
   */
  instanceName: string;

  /**
   * Gateway DO binding name
   *
   * Default: `LUMENIZE_CLIENT_GATEWAY`
   */
  gatewayBindingName?: string;

  /**
   * Initial JWT access token
   *
   * If omitted, fetched via `refresh` before connecting.
   */
  accessToken?: string;

  /**
   * Token refresh source
   *
   * - String: endpoint URL (POST, expects `{ access_token }`)
   * - Function: custom refresh logic returning access token string
   *
   * Default: `/auth/refresh-token`
   */
  refresh?: string | (() => Promise<string>);

  /**
   * Called when connection state changes
   */
  onConnectionStateChange?: (state: ConnectionState) => void;

  /**
   * Called when re-login is required (refresh token expired or invalid)
   *
   * Typical action: redirect to login page
   */
  onLoginRequired?: (error: LoginRequiredError) => void;

  /**
   * Called after reconnection if the grace period had expired
   *
   * Subscriptions need to be re-established.
   */
  onSubscriptionsLost?: () => void;

  /**
   * Called for low-level WebSocket errors (rarely actionable)
   */
  onConnectionError?: (error: Error) => void;

  /**
   * WebSocket constructor for testing
   *
   * Default: globalThis.WebSocket
   */
  WebSocket?: typeof WebSocket;

  /**
   * Custom fetch function for token refresh
   *
   * Use with Browser from @lumenize/testing for cookie-aware requests.
   *
   * Default: globalThis.fetch
   */
  fetch?: typeof fetch;
}

/**
 * LmzApi interface for LumenizeClient
 *
 * Provides identity properties and mesh communication methods.
 */
export interface LmzApiClient {
  /** Node type - always 'LumenizeClient' */
  readonly type: 'LumenizeClient';

  /** Binding name - always the gateway binding */
  readonly bindingName: string;

  /** Instance name from config */
  readonly instanceName: string;

  /**
   * Current call context (only valid during @mesh handler execution)
   *
   * @throws Error if accessed outside of a mesh call context
   */
  readonly callContext: CallContext;

  /**
   * Raw async RPC call through the Gateway
   *
   * Returns a Promise that resolves with the result.
   * If disconnected, queues the call with a timeout.
   */
  callRaw(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chainOrContinuation: OperationChain | Continuation<any>,
    options?: CallOptions
  ): Promise<any>;

  /**
   * Fire-and-forget RPC call with optional handler
   *
   * Returns immediately. If disconnected, queues the call.
   */
  call<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation?: Continuation<any>,
    options?: CallOptions
  ): void;
}

// ============================================
// Internal Types
// ============================================

/** Pending call waiting for response */
interface PendingCall {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

/** Queued message waiting for connection */
interface QueuedMessage {
  message: string;
  callId: string;
  resolve?: (result: any) => void;
  reject?: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ============================================
// LumenizeClient
// ============================================

/**
 * LumenizeClient - Browser/Node.js client for Lumenize Mesh
 *
 * Clients are full mesh peers — they can both make and receive calls.
 * Extend this class and define `@mesh` methods for incoming calls.
 *
 * @example
 * ```typescript
 * class EditorClient extends LumenizeClient {
 *   @mesh
 *   handleDocumentChange(change: DocumentChange) {
 *     this.editor.applyChange(change);
 *   }
 * }
 *
 * using client = new EditorClient({
 *   instanceName: `${userId}.${tabId}`
 * });
 * ```
 */
export abstract class LumenizeClient {
  // ============================================
  // Private Fields
  // ============================================

  #config: Required<Pick<LumenizeClientConfig, 'instanceName' | 'gatewayBindingName'>> & LumenizeClientConfig;
  #ws: WebSocket | null = null;
  #connectionState: ConnectionState = 'disconnected';
  #accessToken: string | null = null;
  #pendingCalls = new Map<string, PendingCall>();
  #messageQueue: QueuedMessage[] = [];
  #reconnectAttempts = 0;
  #reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  #currentCallContext: CallContext | null = null;
  #WebSocketClass: typeof WebSocket;
  #lmzApi: LmzApiClient | null = null;

  // ============================================
  // Constructor
  // ============================================

  constructor(config: LumenizeClientConfig) {
    // Validate required config
    if (!config.instanceName) {
      throw new Error('LumenizeClient requires instanceName in config');
    }

    // Set defaults
    this.#config = {
      ...config,
      gatewayBindingName: config.gatewayBindingName ?? DEFAULT_GATEWAY_BINDING,
      refresh: config.refresh ?? DEFAULT_REFRESH_ENDPOINT,
    };

    // Get WebSocket class
    this.#WebSocketClass = config.WebSocket ?? globalThis.WebSocket;
    if (!this.#WebSocketClass) {
      throw new Error(
        'WebSocket is not available. In Node.js, provide WebSocket in config.'
      );
    }

    // Store initial token if provided
    if (config.accessToken) {
      this.#accessToken = config.accessToken;
    }

    // Set up wake-up sensing (browser only)
    this.#setupWakeUpSensing();

    // Start connection immediately (eager connect)
    this.connect();
  }

  // ============================================
  // Public Properties
  // ============================================

  /**
   * Current connection state
   */
  get connectionState(): ConnectionState {
    return this.#connectionState;
  }

  /**
   * Lumenize API for mesh communication
   */
  get lmz(): LmzApiClient {
    if (!this.#lmzApi) {
      this.#lmzApi = this.#createLmzApi();
    }
    return this.#lmzApi;
  }

  #createLmzApi(): LmzApiClient {
    const self = this;

    const api: LmzApiClient = {
      type: 'LumenizeClient',
      bindingName: self.#config.gatewayBindingName,
      instanceName: self.#config.instanceName,

      get callContext(): CallContext {
        if (!self.#currentCallContext) {
          throw new Error(
            'Cannot access callContext outside of a mesh call. ' +
            'callContext is only available during @mesh handler execution.'
          );
        }
        return self.#currentCallContext;
      },

      callRaw: self.#callRaw.bind(self),
      call: self.#call.bind(self),
    };

    return api;
  }

  // ============================================
  // Public Methods
  // ============================================

  /**
   * Create a continuation proxy for operation chaining
   */
  ctn<T = this>(): Continuation<T> {
    return newContinuation<T>() as Continuation<T>;
  }

  /**
   * Manually trigger reconnection
   *
   * Usually not needed — reconnection is automatic.
   */
  connect(): void {
    // Don't connect if already connected or connecting
    if (this.#connectionState === 'connected' || this.#connectionState === 'connecting') {
      return;
    }

    // Clear any pending reconnect
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
      this.#reconnectTimeoutId = undefined;
    }

    // Start connection
    this.#connectInternal();
  }

  /**
   * Close connection and clean up
   */
  disconnect(): void {
    // Clear reconnect timer
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
      this.#reconnectTimeoutId = undefined;
    }

    // Close WebSocket
    if (this.#ws) {
      // Remove event handlers to prevent reconnect
      this.#ws.onclose = null;
      this.#ws.onerror = null;
      this.#ws.onmessage = null;
      this.#ws.onopen = null;

      if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
        this.#ws.close(1000, 'Client disconnect');
      }
      this.#ws = null;
    }

    // Reject all pending calls
    for (const [callId, pending] of this.#pendingCalls) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new Error('Client disconnected'));
    }
    this.#pendingCalls.clear();

    // Reject all queued messages
    for (const queued of this.#messageQueue) {
      if (queued.timeoutId) clearTimeout(queued.timeoutId);
      if (queued.reject) {
        queued.reject(new Error('Client disconnected'));
      }
    }
    this.#messageQueue = [];

    // Update state
    this.#setConnectionState('disconnected');
  }

  /**
   * Symbol.dispose for `using` keyword support
   */
  [Symbol.dispose](): void {
    this.disconnect();
  }

  // ============================================
  // Lifecycle Hooks (Override in Subclass)
  // ============================================

  /**
   * Called before each incoming mesh call is executed
   *
   * Override to add authentication/authorization.
   * Default: reject calls from other LumenizeClients.
   *
   * Access context via `this.lmz.callContext`.
   */
  onBeforeCall(): void | Promise<void> {
    // Default: reject peer-to-peer client calls
    const origin = this.#currentCallContext?.callChain[0];
    if (origin?.type === 'LumenizeClient') {
      throw new Error(
        'Peer-to-peer client calls are disabled by default. ' +
        'Override onBeforeCall() to allow them.'
      );
    }
  }

  // ============================================
  // Private - Connection Management
  // ============================================

  async #connectInternal(): Promise<void> {
    const isReconnect = this.#connectionState === 'reconnecting';
    this.#setConnectionState(isReconnect ? 'reconnecting' : 'connecting');

    try {
      // Get access token if not available
      if (!this.#accessToken) {
        await this.#refreshToken();
      }

      // Build WebSocket URL
      const url = this.#buildWebSocketUrl();

      // Build protocols array with token
      const protocols = ['lmz'];
      if (this.#accessToken) {
        protocols.push(`lmz.access-token.${this.#accessToken}`);
      }

      // Create WebSocket
      this.#ws = new this.#WebSocketClass(url, protocols);

      // Set up event handlers
      this.#ws.onopen = () => this.#handleOpen();
      this.#ws.onclose = (event) => this.#handleClose(event.code, event.reason);
      this.#ws.onerror = (event) => this.#handleError(event);
      this.#ws.onmessage = (event) => this.#handleMessage(event.data);

    } catch (error) {
      // Connection failed - schedule reconnect
      this.#scheduleReconnect();
    }
  }

  #buildWebSocketUrl(): string {
    let baseUrl = this.#config.baseUrl;

    // Default to current origin in browsers
    if (!baseUrl && typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      baseUrl = `${protocol}//${window.location.host}`;
    }

    if (!baseUrl) {
      throw new Error('LumenizeClient requires baseUrl in Node.js environments');
    }

    // Ensure wss:// or ws:// protocol
    if (baseUrl.startsWith('https://')) {
      baseUrl = baseUrl.replace('https://', 'wss://');
    } else if (baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'ws://');
    }

    // Build URL: /gateway/{bindingName}/{instanceName}
    const binding = this.#config.gatewayBindingName;
    const instance = this.#config.instanceName;

    return `${baseUrl}/gateway/${binding}/${instance}`;
  }

  #handleOpen(): void {
    // Reset reconnect attempts on successful connection
    this.#reconnectAttempts = 0;

    // State will be set to 'connected' when we receive connection_status message
    // This ensures we don't miss the subscriptionsLost info
  }

  #handleClose(code: number, reason: string): void {
    this.#ws = null;

    // Check if this is an auth-related close
    // 4400 (no token) and 4403 (invalid signature) are unlikely since the auth
    // middleware typically handles these before the WebSocket upgrade reaches
    // the Gateway, but we handle them defensively just in case.
    if (code === 4400 || code === 4403) {
      const error = new LoginRequiredError(
        `Authentication failed: ${reason}`,
        code,
        reason
      );
      this.#setConnectionState('disconnected');
      this.#config.onLoginRequired?.(error);
      return;
    }

    if (code === 4401) {
      // Token expired - try refresh
      this.#accessToken = null;
      this.#handleTokenExpired();
      return;
    }

    // Normal disconnection - schedule reconnect
    this.#scheduleReconnect();
  }

  async #handleTokenExpired(): Promise<void> {
    try {
      await this.#refreshToken();
      // Reconnect with new token
      this.#setConnectionState('reconnecting');
      this.#connectInternal();
    } catch (error) {
      // Refresh failed - login required
      const loginError = new LoginRequiredError(
        'Token refresh failed',
        401,
        'Refresh token expired or invalid'
      );
      this.#setConnectionState('disconnected');
      this.#config.onLoginRequired?.(loginError);
    }
  }

  #handleError(event: Event): void {
    const error = new Error('WebSocket error');
    this.#config.onConnectionError?.(error);
  }

  #scheduleReconnect(): void {
    // Calculate delay with exponential backoff
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.#reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.#reconnectAttempts++;

    this.#setConnectionState('reconnecting');

    this.#reconnectTimeoutId = setTimeout(() => {
      this.#reconnectTimeoutId = undefined;
      this.#connectInternal();
    }, delay);
  }

  #setupWakeUpSensing(): void {
    // Only in browser environments
    if (typeof document === 'undefined') return;

    // Visibility change (tab becomes visible)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.#connectionState === 'reconnecting') {
        // Reset backoff and try immediately
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = undefined;
        }
        this.#connectInternal();
      }
    });

    // Window focus
    window.addEventListener('focus', () => {
      if (this.#connectionState === 'reconnecting') {
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = undefined;
        }
        this.#connectInternal();
      }
    });

    // Online event
    window.addEventListener('online', () => {
      if (this.#connectionState === 'reconnecting' || this.#connectionState === 'disconnected') {
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = undefined;
        }
        this.#connectInternal();
      }
    });
  }

  #setConnectionState(state: ConnectionState): void {
    if (this.#connectionState !== state) {
      this.#connectionState = state;
      this.#config.onConnectionStateChange?.(state);
    }
  }

  // ============================================
  // Private - Token Refresh
  // ============================================

  async #refreshToken(): Promise<void> {
    const refresh = this.#config.refresh;

    if (typeof refresh === 'function') {
      // Custom refresh function
      this.#accessToken = await refresh();
    } else if (typeof refresh === 'string') {
      // Endpoint URL - use custom fetch if provided (for cookie-aware requests)
      const fetchFn = this.#config.fetch ?? fetch;
      const response = await fetchFn(refresh, {
        method: 'POST',
        credentials: 'include', // Include cookies
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = await response.json() as { access_token?: string };
      this.#accessToken = data.access_token ?? null;
    } else {
      throw new Error('No refresh method configured');
    }

    if (!this.#accessToken) {
      throw new Error('Refresh returned no token');
    }
  }

  // ============================================
  // Private - Message Handling
  // ============================================

  #handleMessage(data: string): void {
    let message: GatewayMessage;
    try {
      message = parse(data) as GatewayMessage;
    } catch (error) {
      console.error('Failed to parse Gateway message:', error);
      return;
    }

    switch (message.type) {
      case GatewayMessageType.CONNECTION_STATUS:
        this.#handleConnectionStatus(message as ConnectionStatusMessage);
        break;

      case GatewayMessageType.CALL_RESPONSE:
        this.#handleCallResponse(message as CallResponseMessage);
        break;

      case GatewayMessageType.INCOMING_CALL:
        this.#handleIncomingCall(message as IncomingCallMessage);
        break;

      default:
        console.warn('Unknown Gateway message type:', (message as any).type);
    }
  }

  #handleConnectionStatus(message: ConnectionStatusMessage): void {
    // Now connected
    this.#setConnectionState('connected');

    // Flush queued messages
    this.#flushMessageQueue();

    // Notify if subscriptions were lost
    if (message.subscriptionsLost) {
      this.#config.onSubscriptionsLost?.();
    }
  }

  #handleCallResponse(message: CallResponseMessage): void {
    const pending = this.#pendingCalls.get(message.callId);
    if (!pending) {
      console.warn('Received response for unknown call:', message.callId);
      return;
    }

    // Clear timeout and remove from pending
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.#pendingCalls.delete(message.callId);

    // Resolve or reject
    if (message.success) {
      pending.resolve(message.result);
    } else {
      const error = message.error instanceof Error
        ? message.error
        : new Error(String(message.error));
      pending.reject(error);
    }
  }

  async #handleIncomingCall(message: IncomingCallMessage): Promise<void> {
    const { callId, chain, callContext } = message;

    try {
      // Set up call context for this request
      this.#currentCallContext = callContext;

      // Execute within call context (for nested calls)
      const result = await runWithCallContext(callContext, async () => {
        // Run onBeforeCall hook
        await this.onBeforeCall();

        // Execute the operation chain
        return await executeOperationChain(chain, this);
      });

      // Send success response
      const response: IncomingCallResponseMessage = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: true,
        result,
      };
      this.#send(stringify(response));

    } catch (error) {
      // Send error response
      const response: IncomingCallResponseMessage = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: false,
        error,
      };
      this.#send(stringify(response));

    } finally {
      this.#currentCallContext = null;
    }
  }

  // ============================================
  // Private - Sending Messages
  // ============================================

  #send(message: string): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(message);
    }
  }

  #sendOrQueue(message: string, callId: string, resolve?: (result: any) => void, reject?: (error: Error) => void): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(message);
    } else {
      // Queue the message
      if (this.#messageQueue.length >= MAX_QUEUE_SIZE) {
        const error = new Error('Message queue full');
        if (reject) {
          reject(error);
        }
        return;
      }

      const queued: QueuedMessage = { message, callId, resolve, reject };

      // For callRaw, add timeout
      if (resolve && reject) {
        queued.timeoutId = setTimeout(() => {
          const index = this.#messageQueue.indexOf(queued);
          if (index >= 0) {
            this.#messageQueue.splice(index, 1);
            reject(new Error('Call timed out while waiting for connection'));
          }
        }, CALL_RAW_QUEUE_TIMEOUT_MS);
      }

      this.#messageQueue.push(queued);
    }
  }

  #flushMessageQueue(): void {
    const queue = this.#messageQueue;
    this.#messageQueue = [];

    for (const queued of queue) {
      if (queued.timeoutId) {
        clearTimeout(queued.timeoutId);
      }
      this.#send(queued.message);
    }
  }

  // ============================================
  // Private - RPC Methods
  // ============================================

  async #callRaw(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chainOrContinuation: OperationChain | Continuation<any>,
    options?: CallOptions
  ): Promise<any> {
    // Extract chain from continuation if needed
    const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;

    // Generate call ID
    const callId = crypto.randomUUID();

    // Build call context for outgoing call
    const callerIdentity: NodeIdentity = {
      type: 'LumenizeClient',
      bindingName: this.#config.gatewayBindingName,
      instanceName: this.#config.instanceName,
    };

    const callContext = buildOutgoingCallContext(callerIdentity, options);

    // Build message
    const message: CallMessage = {
      type: GatewayMessageType.CALL,
      callId,
      binding: calleeBindingName,
      instance: calleeInstanceNameOrId,
      chain,
      callContext: {
        callChain: callContext.callChain,
        state: callContext.state,
      },
    };

    const messageStr = stringify(message);

    // Create promise for response
    return new Promise<any>((resolve, reject) => {
      // Track pending call
      this.#pendingCalls.set(callId, { resolve, reject });

      // Send or queue
      this.#sendOrQueue(messageStr, callId, resolve, reject);
    });
  }

  #call<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation?: Continuation<any>,
    options?: CallOptions
  ): void {
    // Extract chains
    const remoteChain = getOperationChain(remoteContinuation);
    if (!remoteChain) {
      throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
    }

    let handlerChain: OperationChain | undefined;
    if (handlerContinuation) {
      handlerChain = getOperationChain(handlerContinuation);
      if (!handlerChain) {
        throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
      }
    }

    // Capture current context for handler execution
    const capturedContext = captureCallContext();

    // Fire-and-forget: use Promise.then/catch
    const callPromise = capturedContext
      ? runWithCallContext(capturedContext, () =>
          this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options))
      : this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);

    callPromise
      .then(async (result) => {
        if (handlerChain) {
          const finalChain = replaceNestedOperationMarkers(handlerChain, result);
          if (capturedContext) {
            await runWithCallContext(capturedContext, async () => {
              await executeOperationChain(finalChain, this);
            });
          } else {
            await executeOperationChain(finalChain, this);
          }
        }
      })
      .catch(async (error) => {
        if (handlerChain) {
          const errorObj = error instanceof Error ? error : new Error(String(error));
          const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
          if (capturedContext) {
            await runWithCallContext(capturedContext, async () => {
              await executeOperationChain(finalChain, this);
            });
          } else {
            await executeOperationChain(finalChain, this);
          }
        }
        // If no handler, silently swallow error (fire-and-forget)
      });
  }
}

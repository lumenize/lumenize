import { stringify, preprocess, postprocess } from '@lumenize/structured-clone';
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
  extractCallChains,
  createHandlerExecutor,
  setupFireAndForgetHandler,
  type CallEnvelope,
  type LocalChainExecutor,
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
import { getOrCreateTabId, type TabIdDeps } from './tab-id.js';

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
   * Format: `${sub}.${tabId}` where `sub` is the JWT subject.
   * This becomes the Gateway DO instance name.
   *
   * **Optional** — auto-generated from the `sub` returned by `refresh`
   * and a sessionStorage-backed `tabId` (with BroadcastChannel
   * duplicate-tab detection). Pass explicitly to override.
   */
  instanceName?: string;

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
   * - String: endpoint URL (POST, expects `{ access_token, sub }`)
   * - Function: custom refresh logic returning `{ access_token, sub }`
   *
   * Both forms must provide `sub` so the client can auto-generate
   * `instanceName` as `${sub}.${tabId}`.
   *
   * Default: `/auth/refresh-token`
   */
  refresh?: string | (() => Promise<{ access_token: string; sub: string }>);

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

  /**
   * sessionStorage for tab ID persistence
   *
   * Used for auto-generating `instanceName`. In tests, pass
   * `context.sessionStorage` from `@lumenize/testing`'s Browser.
   *
   * Default: `globalThis.sessionStorage` (browser) or undefined (Node.js)
   */
  sessionStorage?: Storage;

  /**
   * BroadcastChannel constructor for duplicate-tab detection
   *
   * Used for auto-generating `instanceName`. In tests, pass
   * `context.BroadcastChannel` from `@lumenize/testing`'s Browser.
   *
   * Default: `globalThis.BroadcastChannel` (browser) or undefined (Node.js)
   */
  BroadcastChannel?: typeof BroadcastChannel;
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
 * Extend this class and define `@mesh()` methods for incoming calls.
 *
 * @example
 * ```typescript
 * class EditorClient extends LumenizeClient {
 *   @mesh()
 *   handleDocumentChange(change: DocumentChange) {
 *     this.editor.applyChange(change);
 *   }
 * }
 *
 * using client = new EditorClient({
 *   instanceName: `${sub}.${tabId}`
 * });
 * ```
 */
export abstract class LumenizeClient {
  // ============================================
  // Private Fields
  // ============================================

  #config: Required<Pick<LumenizeClientConfig, 'gatewayBindingName'>> & LumenizeClientConfig;
  #instanceName: string | null = null;
  #ws: WebSocket | null = null;
  #connectionState: ConnectionState = 'disconnected';
  #accessToken: string | null = null;
  #sub: string | null = null;
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
    // Set defaults
    this.#config = {
      ...config,
      gatewayBindingName: config.gatewayBindingName ?? DEFAULT_GATEWAY_BINDING,
      refresh: config.refresh ?? DEFAULT_REFRESH_ENDPOINT,
    };

    // Store explicit instanceName if provided
    if (config.instanceName) {
      this.#instanceName = config.instanceName;
    }

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

      get instanceName(): string {
        if (!self.#instanceName) {
          throw new Error(
            'instanceName is only available after connected state. ' +
            'When instanceName is auto-generated, it is constructed during the first connection.'
          );
        }
        return self.#instanceName;
      },

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
   *
   * When called without a type parameter, returns a continuation typed to the
   * concrete subclass. When called with a type parameter (e.g., `ctn<RemoteDO>()`),
   * returns a continuation for that remote type.
   */
  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
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
   * Default: reject calls from other LumenizeClients (peer-to-peer),
   * but allow calls that originated from this same client instance.
   *
   * Access context via `this.lmz.callContext`.
   */
  onBeforeCall(): void | Promise<void> {
    // Default: reject peer-to-peer client calls, but allow self-originated calls
    const origin = this.#currentCallContext?.callChain[0];
    if (origin?.type === 'LumenizeClient') {
      // Allow if origin is this same client instance (response to our own request)
      if (origin.instanceName === this.#instanceName) {
        return;
      }
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
      // Auto-generate instanceName if not set (parallel optimization)
      if (!this.#instanceName && !this.#accessToken) {
        // Run tabId generation and token refresh in parallel
        // tabId takes ≤50ms, refresh is a network call (usually >50ms)
        const tabIdDeps = this.#getTabIdDeps();
        const [tabId] = await Promise.all([
          tabIdDeps ? getOrCreateTabId(tabIdDeps) : Promise.resolve(crypto.randomUUID().slice(0, 8)),
          this.#refreshToken(),  // Sets this.#accessToken and this.#sub
        ]);
        this.#instanceName = `${this.#sub}.${tabId}`;
      } else if (!this.#accessToken) {
        // instanceName already set, just need the token
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
      // Capture the socket reference so stale close events from superseded
      // sockets don't clobber the new connection (see #handleClose guard).
      const thisWs = this.#ws;
      this.#ws.onopen = () => this.#handleOpen();
      this.#ws.onclose = (event) => {
        if (this.#ws !== thisWs) return; // stale close from superseded socket
        this.#handleClose(event.code, event.reason);
      };
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
    const instance = this.#instanceName;
    if (!instance) {
      throw new Error('instanceName not available — connect has not completed');
    }

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
    // auth hooks typically handle these before the WebSocket upgrade reaches
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
      // Custom refresh function — returns { access_token, sub }
      const result = await refresh();
      this.#accessToken = result.access_token;
      if (result.sub) {
        this.#sub = result.sub;
      }
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

      const data = await response.json() as { access_token?: string; sub?: string };
      this.#accessToken = data.access_token ?? null;
      // Store sub for instanceName auto-generation
      if (data.sub) {
        this.#sub = data.sub;
      }
    } else {
      throw new Error('No refresh method configured');
    }

    if (!this.#accessToken) {
      throw new Error('Refresh returned no token');
    }
  }

  /**
   * Get TabIdDeps from config or globals. Returns null if unavailable
   * (non-browser environment without injected deps).
   */
  #getTabIdDeps(): TabIdDeps | null {
    const sessionStorage = this.#config.sessionStorage ?? globalThis.sessionStorage;
    const BroadcastChannelCtor = this.#config.BroadcastChannel ?? globalThis.BroadcastChannel;

    if (!sessionStorage || !BroadcastChannelCtor) {
      return null;
    }

    return { sessionStorage, BroadcastChannel: BroadcastChannelCtor };
  }

  // ============================================
  // Private - Message Handling
  // ============================================

  #handleMessage(data: string): void {
    let message: GatewayMessage;
    try {
      // Use JSON.parse - postprocessing is done per-field as needed
      message = JSON.parse(data) as GatewayMessage;
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
    // Note: result/error are preprocessed by Gateway, postprocess them here
    if (message.success) {
      pending.resolve(postprocess(message.result));
    } else {
      const error = postprocess(message.error);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #handleIncomingCall(message: IncomingCallMessage): Promise<void> {
    const { callId, chain: preprocessedChain, callContext: preprocessedCallContext } = message;

    try {
      // Postprocess fields that were preprocessed for WebSocket transport
      const chain = postprocess(preprocessedChain);
      const callContext: CallContext = {
        callChain: preprocessedCallContext.callChain,  // Plain strings - no postprocessing
        originAuth: preprocessedCallContext.originAuth,  // From JWT - no postprocessing
        state: postprocess(preprocessedCallContext.state),  // Preprocessed → native
      };

      // Set up call context for this request
      this.#currentCallContext = callContext;

      // Execute within call context (for nested calls)
      const result = await runWithCallContext(callContext, async () => {
        // Run onBeforeCall hook
        await this.onBeforeCall();

        // Execute the operation chain
        return await executeOperationChain(chain, this);
      });

      // Send success response (preprocess for structured clone handling)
      const response: IncomingCallResponseMessage = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: true,
        result: preprocess(result),
      };
      this.#send(JSON.stringify(response));

    } catch (error) {
      // Send error response
      // Preprocess error (Error objects need special handling for JSON)
      const response: IncomingCallResponseMessage = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: false,
        error: preprocess(error),
      };
      this.#send(JSON.stringify(response));

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
      instanceName: this.#instanceName!,
    };

    const callContext = buildOutgoingCallContext(callerIdentity, options);

    // Preprocess fields that may contain extended types (Maps, Sets, etc.)
    // See CallMessage interface for serialization rules
    const message: CallMessage = {
      type: GatewayMessageType.CALL,
      callId,
      binding: calleeBindingName,
      instance: calleeInstanceNameOrId,
      chain: preprocess(chain),
      callContext: {
        callChain: callContext.callChain,  // Plain strings - no preprocessing
        state: preprocess(callContext.state),  // User-defined - may contain extended types
      },
    };

    const messageStr = JSON.stringify(message);

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
    // 1. Extract and validate chains (shared helper)
    const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);

    // 2. Set up handler execution (shared helpers)
    // Client uses executeOperationChain directly (no RPC exposure concern)
    const capturedContext = captureCallContext();
    const localExecutor: LocalChainExecutor = (chain, opts) =>
      executeOperationChain(chain, this, opts);
    const executeHandler = createHandlerExecutor(localExecutor, capturedContext);

    // 3. Make remote call with context
    const callPromise = capturedContext
      ? runWithCallContext(capturedContext, () =>
          this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options))
      : this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);

    // 4. Fire-and-forget with handler callbacks (shared helper)
    setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
  }
}

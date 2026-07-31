import { debug } from '@lumenize/debug';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { parseJwtUnsafe, type JwtPayload } from '@lumenize/crypto';
import { WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG, WS_HEARTBEAT_INTERVAL_MS } from './ws-heartbeat.js';
import {
  newContinuation,
  executeOperationChain,
  getOperationChain,
  replaceNestedOperationMarkers,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';

// Re-export continuation types from ocan for convenience
export type { Continuation, AnyContinuation };
import {
  extractCallChains,
  type CallEnvelope,
} from './lmz-api.js';

// ---------------------------------------------------------------------------
// Browser-safe call-context threading
// ---------------------------------------------------------------------------
//
// LumenizeClient runs in browsers where `node:async_hooks`'s AsyncLocalStorage
// isn't available, and the userland Promise-then patching approach can't
// preserve context across native `await` (V8 bypasses user-visible .then for
// async-function resumes). So this file threads `CallContext` explicitly
// through framework code via closures + a synchronous instance field
// (`#currentCallContext`) rather than via ALS.
//
// `this.lmz.callContext` (the user-facing getter) reads `#currentCallContext`
// synchronously. It returns the correct value for code running SYNCHRONOUSLY
// inside an `@mesh()` handler (no await between handler entry and the read),
// but may return a stale value if read AFTER an await when concurrent calls
// have re-entered the dispatcher. This is the same cliff as today; no current
// browser-side `@mesh()` handler in `apps/nebula/` reads `callContext` after
// an await, so it doesn't surface in practice. Framework code below does NOT
// depend on the field being correct across awaits — it captures the parent
// context synchronously at every `lmz.call(...)` entry and threads it as an
// explicit parameter through to `#call` and the handler executor.
//
// See tasks/playwright-test-template.md § Known blockers #2 for the full
// rationale and the alternatives considered (polyfill, refactor-everywhere).

/**
 * Build the outgoing CallContext from an explicit parent context.
 *
 * Mirrors `buildOutgoingCallContext` from `lmz-api.ts` but takes the parent
 * as a parameter instead of looking it up via ALS. Returns a fresh chain
 * when `parentContext` is undefined or `options.newChain` is set.
 */
function buildClientOutgoingContext(
  callerIdentity: NodeIdentity,
  parentContext: CallContext | undefined,
  options?: CallOptions,
): CallContext {
  if (options?.newChain || !parentContext) {
    return {
      callChain: [callerIdentity],
      originAuth: undefined,
      state: options?.state ?? {},
    };
  }
  const newCallChain = [...parentContext.callChain, callerIdentity];
  const newState = options?.state
    ? { ...parentContext.state, ...options.state }
    : parentContext.state;
  return {
    callChain: newCallChain,
    originAuth: parentContext.originAuth,
    state: newState,
  };
}
import {
  GatewayMessageType,
  type CallMessage,
  type CallResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
  type ConnectionStatusMessage,
  type GatewayMessage
} from './gateway-messages.js';
import type { NodeIdentity, CallContext, CallOptions } from './types.js';
import { getOrCreateTabId, type TabIdDeps } from './tab-id.js';

// ============================================
// Constants
// ============================================

/** Maximum number of queued messages during disconnection */
const MAX_QUEUE_SIZE = 100;

/**
 * Default `callAsync` timeout (D4). A public awaitable escape hatch with no default would re-arm the
 * exact "Promise hangs to reload" gap `callAsync` exists to close, so the common path is bounded by
 * construction. `0`/`Infinity` disables (rare long awaits). 30s matches the mesh→client push budget
 * (`CLIENT_CALL_TIMEOUT_MS`, `lumenize-client-gateway.ts`).
 */
const DEFAULT_CALLASYNC_TIMEOUT_MS = 30_000;

/** Maximum reconnect backoff delay (30 seconds) */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Initial reconnect delay (1 second) */
const INITIAL_RECONNECT_DELAY_MS = 1000;


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
/**
 * How far AHEAD of a token's `exp` the client refreshes, in seconds.
 *
 * ⚠️ **Exported because it is a cross-package coupling, not an implementation detail.** A token whose
 * whole lifetime is at or under this window is *born* already due for refresh, so it re-mints
 * continuously — which makes this value the floor under any caller-chosen token TTL. `nebula-auth`'s
 * `RECOMMENDED_MIN_TTL_SECONDS` is defined as a multiple of it; before this was exported that
 * relation could only be asserted in prose, so changing the number here would silently falsify a
 * constant in another package.
 */
export const TOKEN_REFRESH_AHEAD_SECONDS = 30;

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
   * - String: endpoint URL (POST, expects `{ access_token }`)
   * - Function: custom refresh logic returning `{ access_token }`
   *
   * The `sub` for auto-generating `instanceName` is read from the JWT's
   * payload (`client.claims.sub`); the refresh source only needs to return
   * the token.
   *
   * Default: `/auth/refresh-token`
   */
  refresh?: string | (() => Promise<{ access_token: string; sub?: string }>);

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
   * Called when subscriptions need to be (re)established
   *
   * Fires on every connection except reconnects within the 5-second grace period.
   * Use this as the single place to set up all subscriptions.
   */
  onSubscriptionRequired?: () => void;

  /**
   * Called for low-level WebSocket errors (rarely actionable)
   */
  onConnectionError?: (error: Error) => void;

  /**
   * WebSocket keepalive ping cadence in ms (default {@link WS_HEARTBEAT_INTERVAL_MS} = 30s). Keeps a
   * long, quiet turn from idle-dropping the gateway WS (the gateway auto-pongs without waking). Mainly
   * a testing override — set small to exercise the heartbeat without a 30s wait. `<= 0` disables it.
   */
  heartbeatIntervalMs?: number;

  // --- Testing overrides (see @lumenize/testing docs) ---

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
   * Current call context (only valid during @mesh handler execution).
   *
   * ⚠️ **Browser constraint**: in the browser this value is backed by a
   * private instance field updated synchronously when an `@mesh()` handler
   * is dispatched. It returns the correct context for code running
   * **synchronously** inside the handler, but may return a stale value if
   * read **after an `await`** when concurrent mesh calls have re-entered
   * the dispatcher. This applies to direct reads AND transitive reads via
   * helper methods called from a post-await position.
   *
   * Safe pattern in browser-side `@mesh()` handlers:
   * ```typescript
   * @mesh()
   * async handleX(arg) {
   *   const ctx = this.lmz.callContext;  // ← capture synchronously
   *   await something();
   *   use(ctx);                          // ← use the captured value
   *   this.helper(ctx);                  // ← thread to helpers, don't have them re-read
   * }
   * ```
   *
   * No constraint on the server side (LumenizeDO/LumenizeWorker) — those
   * use real `AsyncLocalStorage` and preserve context across awaits. The
   * same code pattern works there too, just isn't required.
   *
   * @throws Error if accessed outside of a mesh call context
   */
  readonly callContext: CallContext;

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

  /**
   * Resilient, `Promise`-returning cross-node call — **client-only** (D16/D17). Settled by the same
   * in-heap re-resolvable-delivery mechanism as a 4-arg `call` (survives tab freeze + WS reconnect),
   * so it does NOT strand on a dead socket the way the removed `callRaw` did. Rejects on an error
   * RESULT, on `signal` abort, or on the built-in default `timeoutMs` (D4; `0`/`Infinity` disables).
   *
   * ⚠️ Prefer a higher-level SDK method (`client.resources.*`) when one exists, and a `subscribe` for
   * live UI data. `callAsync` is the SDK-layer awaitable escape hatch — the ONLY awaitable on
   * `client.lmz`; `call` stays fire-and-forget/`void`.
   *
   * ⚠️ Abort cancels the WAIT, not the server OPERATION (the call already left one-way), so a
   * retry-after-abort is safe ONLY for idempotent ops (client-supplied UUID / ADR-005 eTag).
   */
  callAsync<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    options?: CallOptions & { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Awaited<T>>;
}

// ============================================
// Internal Types
// ============================================

/**
 * A 4-arg `call()`'s response handler, kept IN-HEAP keyed by callId (D16). The JS heap survives
 * a tab freeze AND a WebSocket reconnect, so the handler outlives every failure short of
 * discard/reload — the client bug this fixes is delivery-bound-to-a-transient-socket, not holding
 * the handler. `capturedContext` is the callContext active at the call site, restored when the
 * RESULT arrives so the handler (and any nested `call`) sees the right context.
 */
interface InHeapHandler {
  handlerChain: OperationChain;
  capturedContext: CallContext | undefined;
  /** When true, run the handler only on an error RESULT (skip the success path — N6). */
  onErrorOnly: boolean;
}

/**
 * A `callAsync` in-flight Promise, kept IN-HEAP keyed by callId (D16) and settled by the RESULT
 * fired back for that callId (`#handleCallResponse`). Parallel to `#inHeapHandlers`: `callAsync`
 * settles a Promise, it has no handler *chain*. `signal`/`onAbort` are retained so a normal settle
 * can remove the abort listener (no leak) and an abort can drop the entry.
 */
interface PendingAsyncCall {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Compose the caller's optional `AbortSignal` (external cancel) with the built-in default-timeout
 * signal (D4) into one. Uses the web-standard `AbortSignal.any`; returns the lone signal unwrapped
 * when only one is present, `undefined` when neither is.
 */
function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** Queued message waiting for connection */
interface QueuedMessage {
  message: string;
  callId: string;
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
export abstract class LumenizeClient<TClaims extends { sub: string } = JwtPayload> {
  // ============================================
  // Private Fields
  // ============================================

  #debugFactory = debug;
  #config: Required<Pick<LumenizeClientConfig, 'gatewayBindingName'>> & LumenizeClientConfig;
  #instanceName: string | null = null;
  #ws: WebSocket | null = null;
  #connectionState: ConnectionState = 'disconnected';
  #accessToken: string | null = null;
  #claims: Readonly<TClaims> | null = null;
  #refreshInFlight: Promise<void> | null = null;
  // D16: 4-arg call handlers kept in-heap keyed by callId (survives freeze + reconnect).
  #inHeapHandlers = new Map<string, InHeapHandler>();
  // callAsync (D16): Promise settlers kept in-heap keyed by callId — parallel to #inHeapHandlers.
  #pendingAsyncCalls = new Map<string, PendingAsyncCall>();
  #messageQueue: QueuedMessage[] = [];
  #reconnectAttempts = 0;
  #reauthAttemptedThisCycle = false; // forced one token re-auth this disconnect cycle (reset on open)
  #reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  #heartbeatTimer?: ReturnType<typeof setInterval>; // WS keepalive while connected (started on open)
  #currentCallContext: CallContext | null = null;
  #WebSocketClass: typeof WebSocket;
  #lmzApi: LmzApiClient | null = null;

  // The constructor's eager connect() fires the initial 'connecting'
  // transition synchronously. For a subclass that runs during super(), before
  // the subclass's field initializers — so delivery of that first
  // onConnectionStateChange is deferred to a microtask (see the constructor
  // and #setConnectionState). The WebSocket itself is still created eagerly;
  // only the subclass-observable callback waits for construction to finish.
  #deferInitialStateCallback = false;
  #pendingInitialState: ConnectionState | null = null;

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
      const parsed = parseJwtUnsafe(config.accessToken);
      if (parsed) {
        // Trust boundary: parseJwtUnsafe returns the raw JwtPayload; the
        // subclass asserts the concrete claim shape via TClaims.
        this.#claims = Object.freeze(parsed.payload) as unknown as Readonly<TClaims>;
      }
    }

    // Set up wake-up sensing (browser only)
    this.#setupWakeUpSensing();

    // Eager connect. connect() synchronously creates the WebSocket and sets
    // state to 'connecting', but delivery of that initial onConnectionStateChange
    // is deferred to a microtask: for a subclass this constructor runs during
    // super(), before the subclass's field initializers, so firing the callback
    // synchronously here would run subclass code (an override, or a closure
    // capturing `this`) against a half-constructed instance. By the next
    // microtask, construction is complete.
    this.#deferInitialStateCallback = true;
    this.connect();
    this.#deferInitialStateCallback = false;

    const pendingState = this.#pendingInitialState;
    if (pendingState !== null) {
      this.#pendingInitialState = null;
      queueMicrotask(() => {
        // Skip if a later transition already superseded it — e.g. the caller
        // synchronously called disconnect() before this microtask ran.
        if (this.#connectionState === pendingState) {
          this.#config.onConnectionStateChange?.(pendingState);
        }
      });
    }
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
   * Decoded JWT payload from the current access token
   *
   * Frozen and stable across the client's lifetime (replaced on each refresh).
   * Returns `null` until the first successful token refresh.
   *
   * Use `client.claims.sub` for per-user keying, `client.claims.aud` for the
   * audience claim, etc. — same shape as `originAuth.claims` on the server side.
   *
   * Typed `Readonly<TClaims> | null` — `TClaims` defaults to `JwtPayload`. A
   * subclass scoped to a richer payload (e.g. `LumenizeClient<NebulaJwtPayload>`)
   * may re-declare this getter to drop the `| null` once its lifecycle
   * guarantees claims are populated before any caller runs.
   */
  get claims(): Readonly<TClaims> | null {
    return this.#claims;
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

      call: self.#call.bind(self),
      callAsync: self.#callAsync.bind(self),
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
    this.#clearReconnectTimeout();

    // Start connection
    this.#connectInternal();
  }

  /**
   * Close connection and clean up
   */
  disconnect(): void {
    // Clear reconnect timer
    this.#clearReconnectTimeout();
    this.#stopHeartbeat();

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

    // Explicit teardown: drop in-heap 4-arg handlers (no result will arrive). A transient WS
    // drop/reconnect does NOT reach here — those handlers survive in the heap (D16); on a full
    // reload the client re-issues + reconciles (D8). disconnect() is a deliberate discard.
    this.#inHeapHandlers.clear();

    // callAsync Promises DO have an awaiting caller (unlike the fire-and-forget in-heap handlers
    // above), so an explicit teardown must REJECT them rather than drop silently — otherwise the
    // awaiter hangs until the default timeout. Clean up each abort listener too (no leak).
    for (const pending of this.#pendingAsyncCalls.values()) {
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(new Error('LumenizeClient disconnected before the callAsync result arrived'));
    }
    this.#pendingAsyncCalls.clear();

    // Drop any messages queued while disconnected — the client holds no awaited per-call
    // Promise (4-arg handlers are in #inHeapHandlers, cleared above; 3-arg is fire-and-forget),
    // so there is nothing to reject.
    this.#messageQueue = [];

    // Update state
    this.#setConnectionState('disconnected');
  }

  /**
   * Drop the in-memory access token and its decoded claims.
   *
   * The mesh half of a sign-out: afterwards `client.claims` is `null` and the
   * next `connect()` must `refresh` again to obtain a token. Unlike
   * `disconnect()` (which tears down the connection but keeps the token so a
   * reconnect succeeds), this forgets *who* the client is. It does NOT close
   * the connection and does NOT revoke the server-side refresh cookie — a
   * higher-level `logout()` composes this with `disconnect()` and an
   * app/auth-level cookie-revocation endpoint.
   */
  clearAccessToken(): void {
    this.#accessToken = null;
    this.#claims = null;
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
   * Default: block a DIRECT client-to-client call — one whose IMMEDIATE caller
   * (`callChain.at(-1)`) is another LumenizeClient. DO/Worker-mediated pushes
   * (fanout, direct-delivery, `svc.broadcast`) have a DO/Worker as the caller and
   * are accepted — this is what every reactive app relies on, so no override is
   * needed for them. Override (and skip `super`) to opt into peer communication.
   *
   * Access context via `this.lmz.callContext`.
   */
  onBeforeCall(): void {
    // Check the IMMEDIATE caller, not the origin: a DO/Worker-mediated push has a
    // DO/Worker caller (accepted); only a direct peer call has a client caller.
    const caller = this.#currentCallContext?.callChain.at(-1);
    if (caller?.type === 'LumenizeClient' && caller.instanceName !== this.#instanceName) {
      throw new Error(
        'Direct client-to-client calls are disabled by default. ' +
        'Override onBeforeCall() to allow them.'
      );
    }
  }

  /**
   * Called when a Gateway message arrives whose `type` is not in
   * `GatewayMessageType`. Default: warn via `@lumenize/debug`.
   *
   * Override in a subclass to handle application-specific frames sent by a
   * Gateway subclass via `ws.send()`. The frame has already been
   * `JSON.parse`d. Used (e.g.) by bench instrumentation to capture
   * timing-marker frames emitted from Gateway hooks.
   */
  onUnknownMessage(message: any): void {
    const log = this.#debugFactory('lmz.mesh.LumenizeClient.onUnknownMessage');
    log.warn('Unknown Gateway message type', { type: message?.type });
  }

  // ============================================
  // Private - Connection Management
  // ============================================

  async #connectInternal(): Promise<void> {
    const isReconnect = this.#connectionState === 'reconnecting';
    this.#setConnectionState(isReconnect ? 'reconnecting' : 'connecting');

    try {
      // Auto-generate instanceName if not set
      if (!this.#instanceName) {
        if (!this.#accessToken) {
          // Parallel optimization: tabId generation (≤50ms) and token
          // refresh (network call, usually >50ms) overlap.
          const tabIdDeps = this.#getTabIdDeps();
          const [tabId] = await Promise.all([
            tabIdDeps ? getOrCreateTabId(tabIdDeps) : Promise.resolve(crypto.randomUUID().slice(0, 8)),
            this.#refreshToken(),  // Sets this.#accessToken and this.#claims
          ]);
          this.#instanceName = `${this.#claims?.sub}.${tabId}`;
        } else {
          // Token was supplied by the caller — derive instanceName from its
          // `sub` claim + tabId without making a refresh round-trip.
          const tabIdDeps = this.#getTabIdDeps();
          const tabId = tabIdDeps
            ? await getOrCreateTabId(tabIdDeps)
            : crypto.randomUUID().slice(0, 8);
          this.#instanceName = `${this.#claims?.sub}.${tabId}`;
        }
      } else if (this.#needsTokenRefresh()) {
        // instanceName already set. Refresh when the token is MISSING or its `exp` says it's expiring:
        // a reconnect after a long idle has a set-but-EXPIRED token, and reusing it makes the gateway
        // reject the WS upgrade ("bad response from the server"), which `#scheduleReconnect` then
        // retries forever with the same dead token (the chat-down-after-hours bug). The OLD guard was
        // `!this.#accessToken` — it only refreshed a MISSING token, never an expired one. The check is
        // SYNCHRONOUS so a fresh/opaque token adds NO await here, keeping the synchronous-WS-creation
        // path synchronous.
        await this.#ensureFreshToken();
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
      // Classify the first-connect failure, symmetric with #handleClose's
      // close-code classification. A terminal auth failure (LoginRequiredError
      // from #refreshToken on a 401/403) must surface as login-required +
      // 'disconnected' so a logged-out visitor is redirected — NOT swallowed
      // into unbounded reconnect (which left onLoginRequired un-fired and the
      // factory's `ready` Promise pending forever). Any other failure (transient
      // refresh error, WebSocket construction, tab-id generation) is transient →
      // reconnect with backoff, as before.
      //
      // `instanceof` (not the err.name check mesh.md prescribes) is intentional:
      // this error is thrown in #refreshToken and caught here within the same
      // class/module/realm — it never crosses a structured-clone or RPC hop, so
      // mesh.md's wire-round-trip precondition doesn't apply, and instanceof is
      // the more precise (un-spoofable) test with the safer transient default.
      if (error instanceof LoginRequiredError) {
        this.#setConnectionState('disconnected');
        this.#config.onLoginRequired?.(error);
      } else {
        this.#scheduleReconnect();
      }
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
    this.#reauthAttemptedThisCycle = false; // fresh cycle — re-arm the once-per-cycle re-auth
    this.#startHeartbeat(); // keepalive so a long, quiet turn doesn't idle-drop this socket

    // State will be set to 'connected' when we receive connection_status message
    // This ensures we don't miss the subscriptionRequired info
  }

  #handleClose(code: number, reason: string): void {
    this.#ws = null;
    this.#stopHeartbeat(); // socket gone — the next successful open re-arms it

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
    // Reactive re-auth: the browser hides a failed WS *upgrade*'s HTTP status, so an auth-rejected
    // reconnect (token expired/rotated/revoked/clock-skewed) is indistinguishable from a generic 1006 —
    // we can't read the 401 off the socket. So once the reconnect ITSELF has also failed (`>= 1` prior
    // attempt — a single drop is more likely a transient blip the SAME token recovers from), force a
    // token re-auth ONCE: null it so the next `#connectInternal` refreshes (`#needsTokenRefresh` → true).
    // The refresh ENDPOINT's response IS readable — 200 → fresh token (the reconnect then succeeds);
    // 401/403 → `#refreshToken` throws `LoginRequiredError` → `onLoginRequired`. Bounded by
    // `#reauthAttemptedThisCycle` (reset on a successful open), so a network outage costs at most one
    // extra refresh, never a refresh loop, and a freshly-refreshed token isn't re-nulled. Complements
    // the proactive `#needsTokenRefresh` exp-check (which only catches a readably-past `exp`); this also
    // covers BLUE/GREEN key rotation, revocation, and client/server clock skew.
    if (!this.#reauthAttemptedThisCycle && this.#accessToken && this.#reconnectAttempts >= 1) {
      this.#reauthAttemptedThisCycle = true;
      this.#accessToken = null;
    }

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
        this.#reconnectNow();
      }
    });

    // Window focus
    window.addEventListener('focus', () => {
      if (this.#connectionState === 'reconnecting') {
        this.#reconnectNow();
      }
    });

    // Online event
    window.addEventListener('online', () => {
      if (this.#connectionState === 'reconnecting' || this.#connectionState === 'disconnected') {
        this.#reconnectNow();
      }
    });
  }

  #setConnectionState(state: ConnectionState): void {
    if (this.#connectionState !== state) {
      this.#connectionState = state;
      if (this.#deferInitialStateCallback) {
        // Captured here; the constructor delivers it on a microtask once
        // construction (including any subclass) has completed.
        this.#pendingInitialState = state;
      } else {
        this.#config.onConnectionStateChange?.(state);
      }
    }
  }

  #clearReconnectTimeout(): void {
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
      this.#reconnectTimeoutId = undefined;
    }
  }

  /** Start the WS keepalive: send a small ping every `heartbeatIntervalMs` so the edge won't idle-close
   *  the socket during a long, quiet turn (the gateway auto-pongs without waking — see ws-heartbeat.ts).
   *  Idempotent (stops any prior timer first); `<= 0` disables it. Started on open, stopped on close. */
  #startHeartbeat(): void {
    this.#stopHeartbeat();
    const interval = this.#config.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
    if (interval <= 0) return;
    this.#heartbeatTimer = setInterval(() => {
      try {
        this.#ws?.send(WS_HEARTBEAT_PING);
      } catch {
        /* socket mid-close — the next reconnect re-arms */
      }
    }, interval);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  /** Reset backoff and reconnect immediately (used by wake-up sensing) */
  #reconnectNow(): void {
    this.#reconnectAttempts = 0;
    this.#clearReconnectTimeout();
    this.#connectInternal();
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
    } else if (typeof refresh === 'string') {
      // Endpoint URL - use custom fetch if provided (for cookie-aware requests)
      const fetchFn = this.#config.fetch ?? fetch;
      const response = await fetchFn(refresh, {
        method: 'POST',
        credentials: 'include', // Include cookies
      });

      if (!response.ok) {
        // Classify so the first-connect path (#connectInternal's catch) can be
        // symmetric with the mid-session close path (#handleClose): a 401/403
        // from the refresh endpoint means the (HttpOnly, path-scoped) refresh
        // cookie is expired/invalid → terminal, the user must re-login; any
        // other status (5xx, gateway) is transient → reconnect with backoff.
        if (response.status === 401 || response.status === 403) {
          throw new LoginRequiredError(
            `Token refresh failed: ${response.status}`,
            response.status,
            'Refresh token expired or invalid'
          );
        }
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

    const parsed = parseJwtUnsafe(this.#accessToken);
    if (!parsed) {
      throw new Error('Refresh returned a malformed access_token');
    }
    // Trust boundary: see the constructor's claims assignment.
    this.#claims = Object.freeze(parsed.payload) as unknown as Readonly<TClaims>;
  }

  /** Ensure a usable access token is in memory — refresh via the configured `refresh` source when it's
   *  MISSING or a readable `exp` says it's within 30s of expiry. De-dupes concurrent refreshes so a
   *  WS-connect refresh and an authedFetch refresh share one in-flight call (never two consumers of the
   *  rotating cookie). A present token with NO readable `exp` (an opaque / caller-supplied token, or a
   *  fake test token) is left ALONE — we can't judge its expiry, so trust it rather than force a refresh
   *  the caller may not have configured. The expiry refresh only kicks in once `#claims.exp` is known
   *  (i.e. after a prior refresh parsed it) — exactly the reconnect-after-idle case this fixes. */
  async #ensureFreshToken(): Promise<void> {
    if (!this.#needsTokenRefresh()) return;
    this.#refreshInFlight ??= this.#refreshToken().finally(() => { this.#refreshInFlight = null; });
    await this.#refreshInFlight;
  }

  /** Synchronous "would `#ensureFreshToken` refresh?" — true when the token is MISSING or a readable
   *  `exp` is within 30s of expiry. A present token with NO readable `exp` (opaque / caller-supplied /
   *  fake test token) returns false: we can't judge its expiry, so trust it. Used to GATE the await in
   *  `#connectInternal` so a fresh/opaque token keeps WS creation synchronous (many tests + the cold
   *  synchronous-connect path depend on the socket existing in the same tick). */
  #needsTokenRefresh(): boolean {
    if (!this.#accessToken) return true;
    const exp = (this.#claims as { exp?: number } | null)?.exp;
    if (typeof exp !== 'number') return false;
    return exp - TOKEN_REFRESH_AHEAD_SECONDS <= Math.floor(Date.now() / 1000);
  }

  /**
   * Make an authenticated HTTP request, injecting the in-memory access token as a `Bearer` header.
   *
   * The token NEVER leaves the client: subclasses (e.g. NebulaClient) use this to call authed HTTP
   * endpoints that are NOT on the mesh (a registry route), so app/page code never handles the
   * credential AND there is a SINGLE token authority — no second consumer racing the rotating
   * refresh cookie (the 2026-06-26 back-to-back-refresh hang). Refreshes if the token is missing /
   * near-expiry, and retries ONCE on a 401 (token rejected mid-flight). `protected`, not public,
   * precisely so the bearer is reachable by subclasses but never by callers of the client.
   */
  protected async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const fetchFn = this.#config.fetch ?? fetch;
    const withAuth = (token: string): RequestInit => ({
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    await this.#ensureFreshToken();
    let res = await fetchFn(url, withAuth(this.#accessToken!));
    if (res.status === 401) {
      this.#accessToken = null; // force a fresh mint, then retry once
      await this.#ensureFreshToken();
      res = await fetchFn(url, withAuth(this.#accessToken!));
    }
    return res;
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
    // Heartbeat auto-pong from the gateway — keepalive only, not a mesh message (and not JSON, so it
    // must be skipped BEFORE the parse below or it logs a spurious parse error every cadence).
    if (data === WS_HEARTBEAT_PONG) return;

    let message: GatewayMessage;
    try {
      // Use JSON.parse - postprocessing is done per-field as needed
      message = JSON.parse(data) as GatewayMessage;
    } catch (error) {
      const log = this.#debugFactory('lmz.mesh.LumenizeClient.#handleMessage');
      log.error('Failed to parse Gateway message', {
        error: error instanceof Error ? error.message : String(error),
      });
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
        this.onUnknownMessage(message);
    }
  }

  #handleConnectionStatus(message: ConnectionStatusMessage): void {
    // Now connected
    this.#setConnectionState('connected');

    // Flush queued messages
    this.#flushMessageQueue();

    // Notify if subscriptions need to be (re)established
    if (message.subscriptionRequired) {
      this.#config.onSubscriptionRequired?.();
    }
  }

  /**
   * Handle a RESULT for a client-originated 4-arg call (D16). Looks up the IN-HEAP handler by
   * callId, runs it with the delivered value OR Error (D6 — `handler($result)`), and removes it.
   * The delete-on-delivery IS the dedup: a duplicate RESULT for the same callId finds no handler
   * and is dropped (M4). An unknown callId (a 3-arg call, or an already-handled one) is dropped.
   */
  #handleCallResponse(message: CallResponseMessage): void {
    // A callId settles EITHER a callAsync Promise OR an in-heap 4-arg handler chain (never both).
    const pending = this.#pendingAsyncCalls.get(message.callId);
    if (pending) {
      this.#pendingAsyncCalls.delete(message.callId);  // delete-on-delivery IS the dedup (M4)
      // Normal settle → remove the abort listener (no leak).
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      if (message.success) {
        pending.resolve(postprocess(message.result));
      } else {
        const e = postprocess(message.error);
        pending.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }

    const handler = this.#inHeapHandlers.get(message.callId);
    if (!handler) {
      // No in-heap handler: a 3-arg fire-and-forget call, a duplicate RESULT (dedup), or an
      // unknown callId. All are safely dropped — never a stranded Promise.
      return;
    }
    this.#inHeapHandlers.delete(message.callId);

    // onErrorOnly (N6): skip the handler on a success RESULT (still removed above → dedup holds).
    if (handler.onErrorOnly && message.success) return;

    // result/error are preprocessed by the Gateway — postprocess here.
    const resultOrError = message.success
      ? postprocess(message.result)
      : (() => {
          const e = postprocess(message.error);
          return e instanceof Error ? e : new Error(String(e));
        })();

    // Run the handler under the captured call-site context (so it, and any nested call, see the
    // right context). Fire-and-forget with a defensive catch — a throwing handler must not crash.
    const finalChain = replaceNestedOperationMarkers(handler.handlerChain, resultOrError);
    const runHandler = async () => {
      const prev = this.#currentCallContext;
      this.#currentCallContext = handler.capturedContext ?? null;
      try {
        await executeOperationChain(finalChain, this, { requireMeshDecorator: false });
      } finally {
        this.#currentCallContext = prev;
      }
    };
    runHandler().catch((err) => {
      this.#debugFactory('lmz.mesh.LumenizeClient.#handleCallResponse').error(
        'in-heap call handler threw', { callId: message.callId, error: err instanceof Error ? err.message : String(err) },
      );
    });
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

      // Set up call context for this request. Setting #currentCallContext
      // synchronously is sufficient for `this.lmz.callContext` reads in user
      // code AND for the framework's own `lmz.call(...)` invocations — both
      // read this field directly (see #call below). No ALS wrap needed; the
      // browser can't preserve ALS across native await anyway, and the field
      // is correct for the synchronous portion of the handler before any
      // await yields control.
      this.#currentCallContext = callContext;

      // Run onBeforeCall hook
      this.onBeforeCall();

      // Execute the operation chain
      const result = await executeOperationChain(chain, this);

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

  #sendOrQueue(message: string, callId: string): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(message);
    } else {
      // Queue until reconnect (bounded). Dropped silently on overflow — the client holds
      // no awaited per-call Promise (4-arg handlers live in #inHeapHandlers → D8 reconcile
      // on reload; 3-arg is fire-and-forget), so there is nothing to reject.
      if (this.#messageQueue.length >= MAX_QUEUE_SIZE) {
        this.#debugFactory('lmz.mesh.LumenizeClient.#sendOrQueue').warn(
          'message queue full — dropping queued call', { callId },
        );
        return;
      }
      this.#messageQueue.push({ message, callId });
    }
  }

  #flushMessageQueue(): void {
    const queue = this.#messageQueue;
    this.#messageQueue = [];
    for (const queued of queue) this.#send(queued.message);
  }

  // ============================================
  // Private - RPC Methods
  // ============================================

  /**
   * Send a CALL message (no awaited Promise — the client never blocks on a result). `expectsResult`
   * tells the Gateway whether to attach a fire-back descriptor (4-arg → the callee fires a RESULT
   * back for this callId) or treat it as truly fire-and-forget (3-arg).
   */
  #sendCall(
    callId: string,
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chainOrContinuation: OperationChain | Continuation<any>,
    parentContext: CallContext | undefined,
    expectsResult: boolean,
    options?: CallOptions
  ): void {
    const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;

    const callerIdentity: NodeIdentity = {
      type: 'LumenizeClient',
      bindingName: this.#config.gatewayBindingName,
      instanceName: this.#instanceName!,
    };
    const callContext = buildClientOutgoingContext(callerIdentity, parentContext, options);

    const message: CallMessage = {
      type: GatewayMessageType.CALL,
      callId,
      binding: calleeBindingName,
      instance: calleeInstanceNameOrId,
      chain: preprocess(chain),
      expectsResult,
      callContext: {
        callChain: callContext.callChain,      // Plain strings - no preprocessing
        state: preprocess(callContext.state),  // User-defined - may contain extended types
      },
    };

    // Notify caller of the assigned callId before send/queue, so instrumentation can correlate.
    options?.onSent?.(callId);
    this.#sendOrQueue(JSON.stringify(message), callId);
  }

  #call<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation?: Continuation<any>,
    options?: CallOptions
  ): void {
    // 1. Extract + validate chains (sync-throw on an invalid continuation — D6 tier 1).
    const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);

    // 2. Capture the call-site context synchronously (threaded explicitly — no ALS in the browser).
    const capturedContext = this.#currentCallContext ?? undefined;

    // 3. A 4-arg call keeps its handler IN-HEAP keyed by callId (D16) — it survives tab freeze +
    //    reconnect, and the RESULT re-resolves to the current socket. A 3-arg call is truly
    //    fire-and-forget (no in-heap entry; expectsResult:false).
    const callId = crypto.randomUUID();
    if (handlerChain) {
      this.#inHeapHandlers.set(callId, { handlerChain, capturedContext, onErrorOnly: options?.onErrorOnly === true });
    }

    // 4. Send the CALL (no handler travels).
    this.#sendCall(callId, calleeBindingName, calleeInstanceNameOrId, remoteChain, capturedContext, !!handlerChain, options);
  }

  #callAsync<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    options?: CallOptions & { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Awaited<T>> {
    // 1. Validate + extract the remote chain synchronously (sync-throw on an invalid
    //    continuation — D6 tier 1, same as `call()`; a developer error, never a rejection).
    const { remoteChain } = extractCallChains(remoteContinuation, undefined);

    // 2. Compose the caller's signal (external cancel) with the built-in default timeout (D4), so
    //    the common path can't hang and `signal` stays free for unmount/user-cancel. 0/Infinity off.
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CALLASYNC_TIMEOUT_MS;
    const timeoutSignal = timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const signal = combineAbortSignals(options?.signal, timeoutSignal);

    // 3. Pre-aborted at the call site → reject immediately, don't dispatch (matches `fetch`).
    if (signal?.aborted) return Promise.reject(signal.reason);

    // 4. Capture the call-site context synchronously (threaded explicitly — no ALS in the browser).
    const capturedContext = this.#currentCallContext ?? undefined;
    const callId = crypto.randomUUID();

    return new Promise<Awaited<T>>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          // Abort BEFORE the RESULT: drop the entry (a late RESULT then finds nothing → dropped)
          // and reject with the abort reason (a DOMException: AbortError or TimeoutError). The
          // delete's return-value guards a settle/abort race — never double-settle.
          if (!this.#pendingAsyncCalls.delete(callId)) return;
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pendingAsyncCalls.set(callId, { resolve, reject, signal, onAbort });

      // 5. Send the CALL with expectsResult:true — no handler travels; the client holds the Promise,
      //    settled by the RESULT fired back for this callId (#handleCallResponse). Reuses the D17 path.
      this.#sendCall(
        callId, calleeBindingName, calleeInstanceNameOrId,
        remoteChain, capturedContext, true, options,
      );
    });
  }

  /**
   * Test-only: the number of in-flight `callAsync` Promises (`#pendingAsyncCalls` map size). The
   * D16 map is per-session heap-bounded, so cleanup (delete-on-delivery, delete-on-abort) is a real
   * correctness property — but a settled Promise no-ops a second settle, making double-settle
   * behaviorally invisible. This read-only count is the transient surface a test asserts to prove the
   * entry was actually removed (no leak). NOT part of the public API.
   */
  protected pendingAsyncCallCount(): number {
    return this.#pendingAsyncCalls.size;
  }
}

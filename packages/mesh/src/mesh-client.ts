import { debug } from '@lumenize/debug';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG, WS_HEARTBEAT_INTERVAL_MS } from './ws-heartbeat.js';
import { TOKEN_REFRESH_AHEAD_SECONDS } from './token-refresh.js';
import { splitAddress } from './client-address.js';
import { awaitFirstPush, type PendingPush } from './first-push.js';
import { mesh } from './mesh-decorator.js';
// Impersonation's own knowledge lives in its module; this class keeps the construction seam and
// the teardown its end-of-session doors call.
import {
  assertCanImpersonate, childInstanceName, parentTabIdFrom, mintImpersonation, registerChild,
  deregisterChild, childrenOf, onClientTornDown, isTornDown,
  ImpersonationMintError, ImpersonationAlreadyOpenError,
  type ImpersonateOptions, type RefreshFn,
} from './impersonation.js';
// Type-only, so nothing of the facade's or the Registry's server code reaches this Node- and
// browser-safe module: they type the continuations below and are erased at compile.
import type { AuthFacade } from './auth/auth-facade.js';
import type { AffectedScope, ScopeDeletionPlan } from './auth/auth-registry.js';
import type { AuthClaims, InviteeRequest, InviteSummary, ScopeNode } from './auth/types.js';
import {
  newContinuation,
  executeOperationChain,
  executeFilledChain,
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
  extractRemoteChain,
  type CallEnvelope,
} from './lmz-api.js';
import { broadcastShared, type BroadcastTarget, type BroadcastOptions } from './broadcast.js';

// ---------------------------------------------------------------------------
// Browser-safe call-context threading
// ---------------------------------------------------------------------------
//
// MeshClient runs in browsers where `node:async_hooks`'s AsyncLocalStorage
// isn't available, and the userland Promise-then patching approach can't
// preserve context across native `await` (V8 bypasses user-visible .then for
// async-function resumes). So the context of the chain running now lives in a
// synchronous instance field, `#currentCallContext`, rather than in ALS. It is
// set while an incoming call's chain or a filled result handler runs.
//
// `this.lmz.callContext` (the user-facing getter) and `onBeforeCall` read it.
// It is correct for code running SYNCHRONOUSLY inside a chain, and may be
// stale if read AFTER an await, once another chain has started meanwhile. No
// browser-side `@mesh()` handler in `apps/nebula/` reads `callContext` after
// an await. Outgoing calls never read it: the Gateway builds each call's
// `callChain` from the socket, so a Client sends no context of its own.
//
// See tasks/archive/playwright-test-template.md § Known blockers #2 for the
// alternatives considered (polyfill, refactor-everywhere).

/**
 * The context a client holds: exactly the type `this.lmz.callContext` exposes, so the two cannot
 * drift apart. It has no `originRequest`, which stays server-side.
 */
type ClientCallContext = LmzApiClient['callContext'];

/**
 * The options a client's call takes. `newChain` is not among them: every call a client makes
 * starts at the client, because its Gateway builds the whole context from the socket's verified
 * identity, so there is nothing for a client to start afresh.
 */
export type ClientCallOptions = Omit<CallOptions, 'newChain'>;

/** The options a client's broadcast takes: a node's, without `newChain`, as for its calls. */
export type ClientBroadcastOptions = Omit<BroadcastOptions, 'newChain'>;
import {
  GatewayMessageType,
  WS_CLOSE_GONE,
  WS_TOKEN_PREFIX,
  WS_PROTOCOL,
  type CallMessage,
  type ResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
  type ConnectionStatusMessage,
  type GatewayMessage
} from './gateway-messages.js';
import type { CallContext, CallOptions, NodeIdentity } from './types.js';
import { getOrCreateTabId, type TabIdDeps } from './tab-id.js';

// ============================================
// Constants
// ============================================

/**
 * The most calls a client holds while its socket is down or its token is being swapped. Past it a
 * call is refused, and whoever waits on it hears so: a `callAsync` rejects and a call's result
 * handler runs, each with a `QuotaExceededError`.
 */
const MAX_QUEUE_SIZE = 1000;

/**
 * Default `callAsync` timeout. A public awaitable escape hatch with no default would re-arm the
 * exact "Promise hangs to reload" gap `callAsync` exists to close, so the common path is bounded by
 * construction. `0`/`Infinity` disables (rare long awaits). 30s matches the mesh→client push budget
 * (`CLIENT_CALL_TIMEOUT_MS`, `client-gateway.ts`).
 */
const DEFAULT_CALLASYNC_TIMEOUT_MS = 30_000;

/**
 * How many recent answers a Client keeps, by `callId`. The Gateway sends a call again when the
 * socket it went down is replaced before the answer comes back, and a Client that has answered it
 * already sends the kept answer rather than running the handler twice. A repeat arrives within one
 * reconnect, so a short record is enough.
 */
export const ANSWER_RECORD_SIZE = 64;

/** Maximum reconnect backoff delay (30 seconds) */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Initial reconnect delay (1 second) */
const INITIAL_RECONNECT_DELAY_MS = 1000;


/** The refresh route's path, on the platform host when the config names one. */
const REFRESH_PATH = '/auth/refresh-token';

/**
 * The construction seam a child from {@link MeshClient.impersonate} is built through: its own
 * `refresh`, backed by its parent's mint, where any other Client has the cookie's. Private to this
 * module, so no config type reaches it, and a subclass's config that leaves `refresh` out still
 * builds no Client whose token and scope disagree.
 */
const CHILD_REFRESH = Symbol('lumenize.mesh.impersonation.refresh');

/** The companion seam: hands the child its parent, for the members that run after construction. */
const CHILD_PARENT = Symbol('lumenize.mesh.impersonation.parent');

// ============================================
// Types
// ============================================

/**
 * Connection state for MeshClient
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export { TOKEN_REFRESH_AHEAD_SECONDS };

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
 * The node hosting this Client was deleted: its host closed the socket with `WS_CLOSE_GONE` (4410).
 * Every pending `callAsync` is rejected with it, and `onHostDeleted` receives it. The Client does
 * not reconnect, since an upgrade would only build an empty object at the deleted name. Detect it by
 * `name`, the way every typed error here is detected.
 */
export class HostDeletedError extends Error {
  name = 'HostDeletedError';
}

/**
 * Configuration for MeshClient
 */
export interface MeshClientConfig {
  /**
   * The page's origin, whose host names the node that hosts this Client. The upgrade names only
   * the Client's id, `wss://tenant1.crm.acme.lumenize.dev/gateway/alice.9f2c41aa`; the Worker
   * routes it to the node the hostname spells, and that node names the Client
   * `acme.crm.tenant1/alice.9f2c41aa`.
   *
   * Default: current origin in browsers (e.g., `https://` → `wss://`)
   * Required in Node.js environments.
   */
  baseUrl?: string;

  /**
   * The platform host's origin, `https://platform.lumenize.dev`, where every session lives
   * (ADR-022). The default `refresh` posts to its refresh route, the browser sending the platform
   * host's cookies and naming this page in `Origin`, and `logout()` sends a top-level page to its
   * logout page. Without it the refresh posts to `/auth/refresh-token` on the page's own origin.
   */
  platformOrigin?: string;

  /**
   * The origin a framed page tells about its session ending: its galaxy's Studio, the one page
   * allowed to frame it. Absent on a top-level page, and a framed page without one posts nothing.
   */
  parentOrigin?: string;

  /**
   * How long a subscribe, `subscribeProfile` among them, waits for its first push before giving up,
   * in ms. Default 30000, the host node's own limit on a push to a Client. Lower it in a test that
   * asserts the abandon path; there is no reason to raise it in an app.
   */
  subscribeTimeoutMs?: number;

  /**
   * Unique client identifier
   *
   * Format: `${sub}.${tabId}` where `sub` is the JWT subject: the Client's id on the node that
   * hosts it.
   *
   * **Optional** — auto-generated from the `sub` returned by `refresh`
   * and a sessionStorage-backed `tabId` (with BroadcastChannel
   * duplicate-tab detection). Pass explicitly to override.
   */
  instanceName?: string;

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
   * Default: the platform host's refresh route, `${platformOrigin}/auth/refresh-token`, or
   * `/auth/refresh-token` without a `platformOrigin`. A 401 or 403 there means no cookie covers this
   * page, and `onLoginRequired` runs.
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
   * Called when the node hosting this Client was deleted. The Client has stopped as `disconnect()`
   * stops it, and its pending `callAsync`s were rejected with the same error.
   *
   * Typical action: leave the page, whose scope no longer exists.
   */
  onHostDeleted?: (error: HostDeletedError) => void;

  /**
   * Called when subscriptions need to be (re)established: on a first connection, and on a reconnect
   * the Gateway reports as a loss — a delivery to the client failed, which also closes a socket still
   * open with 4408, it was away past the 5-second grace period, or the Gateway lost its record of
   * it. Not on any other reconnect, a token rotation included. Use this as the single place to set up
   * all subscriptions, or override the client's `onSubscriptionRequired`.
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
 * LmzApi interface for MeshClient
 *
 * Provides identity properties and mesh communication methods.
 */
export interface LmzApiClient {
  /** Node type - always 'LumenizeClient' */
  readonly type: 'LumenizeClient';

  /**
   * The binding of the node hosting this Client, `STAR` say, from the address its host's
   * `connection_status` reports. Throws until that first arrives.
   */
  readonly bindingName: string;

  /**
   * This Client's id on its host node, `alice.9f2c41aa`: its `sub`, a `.`, and its tab id. The host
   * names it `acme.crm.tenant1/alice.9f2c41aa`, which a handler reads as `callContext.callee`.
   * Throws until known: from the config, or from the first connection's token.
   */
  readonly instanceName: string;

  /**
   * Current call context (only valid during @mesh handler execution).
   *
   * Typed without `originRequest`, which stays server-side: the Gateway never sends it to a
   * client, so reading it here fails to compile instead of returning a silent `undefined`.
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
   * No constraint on the server side (a Mesh Durable Object or MeshWorker) — those
   * use real `AsyncLocalStorage` and preserve context across awaits. The
   * same code pattern works there too, just isn't required.
   *
   * @throws Error if accessed outside of a mesh call context
   */
  readonly callContext: Omit<CallContext, 'originRequest'>;

  /**
   * One-way call whose outcome reaches `handlerContinuation`: the value, or the Error. A call that
   * cares only about failure passes `onErrorOnly`.
   *
   * Returns immediately. If disconnected, queues the call — up to 1000 of them. Past that the call
   * is refused, and the handler hears so as a `QuotaExceededError`.
   */
  call<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation: Continuation<any>,
    options?: ClientCallOptions
  ): void;

  /**
   * Send one continuation to many targets — one `call` per target, each over this client's socket
   * and stamped at its Gateway, so it grants nothing that many calls would not.
   *
   * `options.onResult` hears only failures. Each call starts at this client, as every client call
   * does. The handler runs under its answer's context, so `callContext.callee` names the target
   * that failed.
   *
   * @see `broadcast.ts` — the chain each target sees
   */
  broadcast<T = any>(
    targets: BroadcastTarget[],
    remoteContinuation: Continuation<T>,
    options: ClientBroadcastOptions
  ): void;

  /**
   * Resilient, `Promise`-returning cross-node call — **client-only**.
   *
   * **One message on the wire, two spellings in code.** A `callAsync` sends exactly what a `call`
   * sends: its result handler continuation is a call to a client method that settles the Promise
   * kept under its `callId`. Only the Promise and its timeout differ, and both stay in the tab,
   * whose memory survives a freeze and a WS reconnect (ADR-003). That is why it does NOT strand on a
   * dead socket the way the removed `callRaw` did.
   *
   * Rejects when the outcome is an Error, whether the node threw it or returned it, as a result
   * handler sees both alike; on `signal` abort; on the built-in default `timeoutMs` (`0`/`Infinity`
   * disables); or with a `QuotaExceededError` when the client already holds 1000 unsent calls.
   *
   * ⚠️ Prefer a higher-level SDK method (`client.resources.*`) when one exists, and a `subscribe` for
   * live UI data. `callAsync` is the SDK-layer awaitable escape hatch — the ONLY awaitable on
   * `client.lmz`; `call` stays one-way and `void`, its outcome going to a result handler.
   *
   * ⚠️ Abort cancels the WAIT. It cancels the server OPERATION only if the call had not yet left the
   * client — a queued call is dropped with its wait — and a call that has left runs regardless, so a
   * retry-after-abort is safe ONLY for idempotent ops (client-supplied UUID / ADR-005 eTag).
   */
  callAsync<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    options?: ClientCallOptions & { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Awaited<T>>;
}

// ============================================
// Internal Types
// ============================================

/**
 * A `callAsync` in-flight Promise, kept in the tab keyed by callId and settled when its result
 * handler continuation, `__settleCallAsync`, comes back filled. `signal`/`onAbort` are retained so
 * a normal settle can remove the abort listener (no leak) and an abort can drop the entry.
 */
interface PendingAsyncCall {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Compose the caller's optional `AbortSignal` (external cancel) with the built-in default-timeout
 * signal into one. Uses the web-standard `AbortSignal.any`; returns the lone signal unwrapped
 * when only one is present, `undefined` when neither is.
 */
function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Throw if a call's chains hold a function anywhere. The wire would carry one as an inert
 * placeholder, so the far side, or this Client's own handler when it comes back, would receive
 * something it cannot call. Runs before anything is sent or kept, so the caller gets a throw.
 */
function assertCrossable(...chains: OperationChain[]): void {
  if (chains.some((chain) => holdsFunction(chain))) {
    throw new TypeError(
      'A function cannot cross the mesh: bind data into a continuation, never a function. ' +
      'Pass what the handler needs as arguments, or keep it on the client and look it up there.',
    );
  }
}

/** Whether `value` holds a function anywhere, which no wire can carry. Cycle-safe. */
function holdsFunction(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) if (holdsFunction(k, seen) || holdsFunction(v, seen)) return true;
    return false;
  }
  // A typed array or a DataView holds only bytes, and walking it would copy every element.
  if (ArrayBuffer.isView(value)) return false;
  const items = value instanceof Set ? [...value] : Object.values(value);
  return items.some((v) => holdsFunction(v, seen));
}

/** Queued message waiting for connection */
interface QueuedMessage {
  message: string;
  callId: string;
}

/**
 * The snapshot the Profile channel delivers: a person's public fields and an eTag. A Profile is not
 * a resource, so it carries no resource metadata.
 */
export interface ProfileChannelSnapshot {
  value: unknown;
  meta: { eTag: string };
}

/**
 * A `using`-compatible handle from {@link MeshClient.subscribeProfile}. `snapshot` resolves on the
 * first push for the profile; later pushes reach `onProfileUpdate` but do not re-resolve it. Each
 * handle disposes once, and the subscription is released when the last handle for the profile is.
 */
export interface ProfileSubscription extends Disposable {
  /** The first push: the public fields, or `null` for a profile that does not exist. */
  readonly snapshot: Promise<ProfileChannelSnapshot | null>;
}

/**
 * The calls the Profile channel makes, typed structurally so the Profile class, a Durable Object,
 * never reaches this browser-bundled module. The instance is the `profileId`, never a scope.
 */
interface ProfileTarget {
  subscribe(): void;
  unsubscribe(): void;
  writeProfile(fields: { name?: string; nickname?: string; picture?: string }): Promise<void>;
}

// ============================================
// MeshClient
// ============================================

/**
 * MeshClient - Browser/Node.js client for Lumenize Mesh
 *
 * Clients are full mesh peers — they can both make and receive calls.
 * Extend this class and define `@mesh()` methods for incoming calls.
 *
 * It also holds the session: the token and its `claims`, the `activeScope` its page acts in,
 * `logout()`, `impersonate()`, `invite()`, the `scopes` the holder administers, and the Profile
 * channel. A subclass hears about each new token through {@link onClaimsChange}.
 *
 * @example
 * ```typescript
 * class EditorClient extends MeshClient {
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
export abstract class MeshClient<TClaims extends AuthClaims = AuthClaims> {
  // ============================================
  // Private Fields
  // ============================================

  #debugFactory = debug;
  #config: Required<Pick<MeshClientConfig, 'refresh'>> & MeshClientConfig;
  #instanceName: string | null = null;
  /**
   * This Client's address on its host node, from the last `connection_status`: the host's binding,
   * and the name the host holds it under. `undefined` until the first connection is accepted.
   */
  #address: { bindingName: string; instanceName: string } | undefined;
  /** Whether a `connection_status` has arrived before, so a later one is known as a reconnect. */
  #connectedBefore = false;
  #ws: WebSocket | null = null;
  #connectionState: ConnectionState = 'disconnected';

  /**
   * Stopped on purpose, by this Client's own `disconnect()` or by its host's deletion. A browser
   * wake-up does not reconnect it; only `connect()` does.
   */
  #stoppedOnPurpose = false;
  #accessToken: string | null = null;
  #claims: Readonly<TClaims> | null = null;
  #refreshInFlight: Promise<void> | null = null;
  /**
   * Minted once, when this Client is constructed, and stamped on every call; an answer echoes it,
   * and one that does not carry this Client's own is dropped. A new Client is a new load, so a
   * reloaded page, or a second Client on the same tab, never runs an answer meant for the one
   * before. Pairs with `tabId`, which survives a reload where this does not.
   */
  readonly #loadId: string = crypto.randomUUID();
  // callAsync: Promise settlers kept in the tab keyed by callId (survives freeze + reconnect).
  #pendingAsyncCalls = new Map<string, PendingAsyncCall>();
  /** The last {@link ANSWER_RECORD_SIZE} incoming calls by `callId`: the answer sent, or `null`
   *  while the handler still runs. Oldest first, as a `Map` keeps insertion order. */
  #answers = new Map<string, string | null>();
  /**
   * The `sub` of the last token this Client held, which `#followSub` compares a new one with. Kept
   * apart from `#claims` so `clearAccessToken()` does not erase it: a Client reused under another
   * identity must still move to that identity's name.
   */
  #lastSub: string | undefined;

  /** The token the current socket was opened with, which an `authedFetch` refresh compares against. */
  #socketToken: string | null = null;

  #messageQueue: QueuedMessage[] = [];
  #reconnectAttempts = 0;
  #reauthAttemptedThisCycle = false; // forced one token re-auth this disconnect cycle (reset on open)
  #reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  #heartbeatTimer?: ReturnType<typeof setInterval>; // WS keepalive while connected (started on open)
  #currentCallContext: ClientCallContext | null = null;
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

  // ── The session ───────────────────────────────────────────────────────────────────────────────

  /** The page host's scope, from the first token's `aud`; `undefined` until that token arrives. */
  #activeScope?: string;
  #resolveActiveScope!: (scope: string) => void;
  /** Settles with {@link #activeScope} once the first token arrives. */
  #activeScopeKnown: Promise<string> = new Promise((resolve) => { this.#resolveActiveScope = resolve; });
  /** The ids of children `impersonate()` is minting, each claimed until it is registered. */
  #childrenOpening = new Set<string>();
  /**
   * The parent this Client was minted from, when it is an impersonated child. Read only after
   * construction, by `logout()` and the teardown; the re-mint holds its parent in a closure instead,
   * since a `refresh` can run during `super()`, before this field exists.
   */
  #mintedFrom?: MeshClient<AuthClaims>;

  // ── The Profile channel ───────────────────────────────────────────────────────────────────────
  //
  // Keyed by bare `profileId`, apart from any subscription plane a subclass composes, so a
  // subclass's own subscription keys never collide with a profile's.

  /** Handles held per profile; the keys are the live subscriptions a restore sends again. */
  #profileRefcount = new Map<string, number>();
  /** Subscribes waiting for their first push. */
  #profilePending = new Map<string, PendingPush<ProfileChannelSnapshot | null>>();
  /** The factory's listener, which mirrors each push into its store. One at a time. */
  #profileListener: ((profileId: string, snapshot: ProfileChannelSnapshot | null) => void) | null = null;

  // ============================================
  // Constructor
  // ============================================

  constructor(config: MeshClientConfig) {
    // A child from `impersonate()` renews through its parent's mint; every other Client through the
    // refresh it names, or the platform host's cookie.
    const childRefresh = (config as unknown as Record<symbol, unknown>)[CHILD_REFRESH] as RefreshFn | undefined;
    this.#config = {
      ...config,
      refresh: childRefresh ?? config.refresh
        ?? (config.platformOrigin ? `${config.platformOrigin}${REFRESH_PATH}` : REFRESH_PATH),
    };
    this.#mintedFrom = (config as unknown as Record<symbol, unknown>)[CHILD_PARENT] as MeshClient<AuthClaims> | undefined;

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
        this.#lastSub = parsed.payload.sub;
        this.#learnActiveScope();
        // A seeded token, an impersonated child's first mint, is a new token like a refresh's. Told
        // on a microtask, once a subclass's fields exist.
        queueMicrotask(() => this.#tellClaimsChanged());
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
   * Typed `Readonly<TClaims> | null` — `TClaims` defaults to `AuthClaims`. A
   * subclass whose lifecycle guarantees claims before any caller runs may
   * re-declare this getter to drop the `| null`.
   */
  get claims(): Readonly<TClaims> | null {
    return this.#claims;
  }

  /**
   * The page host's scope, `acme.crm.tenant1` on `tenant1.crm.acme.lumenize.dev`: the `aud` the
   * first token carries, which the platform host's refresh set from this page's `Origin` (ADR-022).
   * `undefined` before the first token arrives; a page's host never changes under it.
   */
  get activeScope(): string | undefined {
    return this.#activeScope;
  }

  /** Settles with {@link activeScope} once the first token arrives: what a call made sooner waits on. */
  get activeScopeKnown(): Promise<string> {
    return this.#activeScopeKnown;
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

      get bindingName(): string {
        if (!self.#address) {
          throw new Error(
            'bindingName is only available once the host has accepted a connection: ' +
            'its connection_status names the binding.'
          );
        }
        return self.#address.bindingName;
      },

      get instanceName(): string {
        if (!self.#instanceName) {
          throw new Error(
            'instanceName is only available after connected state. ' +
            'When instanceName is auto-generated, it is constructed during the first connection.'
          );
        }
        return self.#instanceName;
      },

      get callContext(): ClientCallContext {
        if (!self.#currentCallContext) {
          throw new Error(
            'Cannot access callContext outside of a mesh call. ' +
            'callContext is only available during @mesh handler execution.'
          );
        }
        return self.#currentCallContext;
      },

      call: self.#call.bind(self),
      broadcast: (targets, remoteContinuation, options) =>
        broadcastShared(api, targets, remoteContinuation, options),
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
    this.#stoppedOnPurpose = false;

    // Clear any pending reconnect
    this.#clearReconnectTimeout();

    // Start connection
    this.#connectInternal();
  }

  /**
   * Close connection and clean up
   */
  disconnect(): void {
    this.#stoppedOnPurpose = true;
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

    this.#stop(new Error('MeshClient disconnected before the callAsync result arrived'));
  }

  /**
   * End this Client's calls and mark it disconnected, once its socket is gone and nothing will
   * reconnect it. callAsync Promises have an awaiting caller, so they are REJECTED with `error`
   * rather than dropped — otherwise the awaiter hangs until the default timeout — and each abort
   * listener is removed too (no leak).
   */
  #stop(error: Error): void {
    for (const pending of this.#pendingAsyncCalls.values()) {
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(error);
    }
    this.#pendingAsyncCalls.clear();

    // Drop any messages queued while disconnected: their result handlers travel with them, and
    // the callAsync Promises among them were rejected above.
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
   * End this Client without ending its session: disconnect, and end any impersonation it opened.
   * Distinct from {@link logout}, which also ends the session, so a disposed Client's page could
   * connect again on the same cookie and a logged-out one cannot. A subclass that holds work in
   * flight settles it first, then calls this.
   */
  async dispose(): Promise<void> {
    this.disconnect();
    this.#tearDownImpersonation();
  }

  /**
   * `using` support. An end-of-session door, so it ends any impersonation too.
   */
  [Symbol.dispose](): void {
    this.disconnect();
    this.#tearDownImpersonation();
  }

  /**
   * The impersonation teardown, called from the three end-of-session doors: `dispose()`, `logout()`
   * and `[Symbol.dispose]()`. It marks this Client unable to mint, ends its impersonated children,
   * and takes it off its own parent's list.
   *
   * ⚠️ **Not on `disconnect()`, though all three doors run it.** Application code also calls
   * `disconnect()` to pause a connection, which `connect()` reverses: tearing down there would end
   * impersonation for a session nobody ended, where a paused parent still mints.
   *
   * ⚠️ **And not on a connection-state change.** A dropped socket goes to `'reconnecting'`, never
   * `'disconnected'`, so tearing down on a state change would end an admin's impersonation on a
   * network blip.
   */
  #tearDownImpersonation(): void {
    onClientTornDown(this, this.#mintedFrom);
  }

  /**
   * Sign out, ending every session this browser holds.
   *
   * Sessions live on the platform host (ADR-022), so a page cannot end them itself: a top-level
   * page is sent to the platform host's logout page, which says what is about to end and posts the
   * logout there, `everywhere` preselected when asked. A framed page, the dev tab inside Studio,
   * holds its parent's session, so it disconnects and tells its parent instead. An impersonated
   * child holds no cookie at all and only tears down. Without a window (a script, the `/live`
   * harness) it disconnects only; the caller ends the session itself.
   *
   * @see https://lumenize.com/docs/nebula/api-reference#clientlogout
   */
  async logout(options: { everywhere?: boolean } = {}): Promise<void> {
    if (this.#mintedFrom) {
      // A derived session holds no refresh cookie of its own, so any logout would spend the
      // originator's. Ending an impersonation is teardown, whichever button was pressed
      // (`security.md` § derived sessions).
      await this.dispose();
      return;
    }
    this.clearAccessToken();
    this.disconnect();
    this.#tearDownImpersonation();
    if (typeof window === 'undefined') return;
    if (window.top !== window.self) {
      // The session is the parent's, and it decides. Posted only to the origin the serving layer
      // named, and not at all without one.
      if (this.#config.parentOrigin) window.parent.postMessage({ type: 'lumenize:logout' }, this.#config.parentOrigin);
      return;
    }
    const page = new URL(`${this.#config.platformOrigin ?? ''}/auth/logout`, window.location.href);
    if (options.everywhere) page.searchParams.set('everywhere', '1');
    window.location.assign(page.href);
  }

  /**
   * Produce a working Client that acts as another person: the admin's debugging tool for *"why
   * can't this user do X?"*.
   *
   * Dominion-reducing: the child carries the subject's permissions, which are narrower than the
   * caller's. It is this Client's own class, so a subclass's child keeps that subclass's surface,
   * and its `claims` answer both questions: the top-level `sub` and `profileId` are the subject's,
   * and an `act` claim marks the session as an impersonation.
   *
   * **The child acts on this Client's page.** Its `aud` is this Client's own, so no argument names
   * a scope: to debug a tenant, impersonate from that tenant's page.
   *
   * **The parent is the credential.** Nothing durable is created: the child renews by minting
   * through this Client again, so a revocation reaches it at its next token, and the session ends
   * with this Client rather than at its term.
   *
   * ⚠️ **Precondition:** this Client has an `instanceName`, by connecting once or by its config,
   * since the child's id derives from its tab id. A paused (`disconnect()`ed) parent, or one whose
   * token expired, still mints: its mint waits for the reconnect and refreshes first.
   *
   * @param sub The subject's surrogate `sub`: the person to act as.
   * @throws {ImpersonationChainError} when this Client is itself impersonating, before any network
   *   call. Impersonation does not chain.
   * @throws {ImpersonationAlreadyOpenError} when this Client already has an open child acting as
   *   `sub`, before any network call. Dispose that child first.
   * @throws {ImpersonationMintError} when the facade refuses, carrying its message.
   */
  async impersonate(sub: string, opts?: ImpersonateOptions): Promise<this> {
    // Decidable here, and enforced independently by the mint's root-identity gate.
    assertCanImpersonate(this.claims as { act?: unknown } | null);

    // One mint path, captured lexically rather than through the child's `#mintedFrom`, which does
    // not exist yet while the child's `refresh` may already run inside `super()`. `opts` rides
    // along, so every re-mint asks for the same `ttlSeconds` and the session keeps its cadence.
    const parent = this;
    const activeScope = this.#activeScope ?? await this.#activeScopeKnown;
    // A second child of one subject from this tab would share the first's id, and its host node
    // would close the first's socket on the second's upgrade, so it is refused before any mint.
    const instanceName = childInstanceName(sub, parentTabIdFrom(this.lmz.instanceName), activeScope);
    if (this.#childrenOpening.has(instanceName)
      || childrenOf(this).some((c) => (c as MeshClient).lmz.instanceName === instanceName)) {
      throw new ImpersonationAlreadyOpenError(
        `This tab is already impersonating ${sub}; dispose that client before opening another.`,
      );
    }
    // Assigned right after construction; see the note in the terminal branch below.
    let childRef: MeshClient | undefined;
    const mint = async () => {
      // Checked on every mint, the first included: ending the admin's session ends impersonation
      // by construction, rather than when the child's token lapses.
      if (isTornDown(parent)) {
        throw new ImpersonationMintError('The client that created this impersonation session has been torn down');
      }
      return mintImpersonation(() => parent.lmz.callAsync(
        'AUTH_FACADE', undefined,
        parent.ctn<AuthFacade>().impersonate(sub, { ttlSeconds: opts?.ttlSeconds }),
      ), sub);
    };

    // Mint first, then seed the child with the token. Constructing it tokenless, so that its own
    // connect is the mint, would move a refusal inside `super()`, where it becomes a scheduled
    // reconnect and the caller hears nothing. The id is claimed across the mint's await, so a
    // second call meanwhile, a double click, is refused too.
    this.#childrenOpening.add(instanceName);
    let minted: Awaited<ReturnType<typeof mint>>;
    try {
      minted = await mint();
    } finally {
      this.#childrenOpening.delete(instanceName);
    }

    const Child = this.constructor as new (config: MeshClientConfig) => this;
    const child = new Child({
      ...this.childConfig(),
      accessToken: minted.access_token,
      instanceName,
      [CHILD_REFRESH]: (async () => {
        try {
          return await mint();
        } catch (e) {
          // Only a mint that failed for good is terminal: the facade's typed refusal, or the
          // torn-down parent, both `ImpersonationMintError`. Everything else is transport, and
          // transient, so the child reconnects and retries.
          //
          // ⚠️ Terminal reuses `LoginRequiredError` on purpose: it is the one error the reconnect
          // treats as terminal, so a class of its own would leave the child retrying forever. What
          // keeps the admin from being sent to log in is that a child never holds their
          // `onLoginRequired`; `childConfig()` leaves it out.
          if (e instanceof ImpersonationMintError) {
            // The child ends here and `disconnect()` will not run, so it leaves its parent's list
            // now. Through `childRef` rather than `child`: this can run inside `super()`, where
            // `child` is still in its temporal dead zone, and `childRef` is then undefined because
            // the child was never registered.
            if (childRef) deregisterChild(parent, childRef);
            throw new LoginRequiredError(`Impersonation session ended: ${e.message}`, 403, 'impersonation_ended');
          }
          throw e;
        }
      }) as RefreshFn,
      [CHILD_PARENT]: this,
    } as MeshClientConfig);

    childRef = child;
    // After the mint, so a refused mint leaves no half-registered child holding a socket.
    registerChild(this, child);
    return child;
  }

  /**
   * The config a child from {@link impersonate} is built with: the page, the platform host and the
   * test overrides, never `refresh`, which the child gets from its parent's mint. It leaves out
   * `onLoginRequired` on purpose, so someone else's session ending never sends the admin to log
   * in. A subclass whose own config a child needs returns `{ ...super.childConfig(), … }`.
   */
  protected childConfig(): MeshClientConfig {
    const c = this.#config;
    return {
      baseUrl: c.baseUrl,
      platformOrigin: c.platformOrigin,
      fetch: c.fetch,
      // Passed through, `undefined` included: the `/live` harness supplies no `WebSocket` and relies
      // on the Node global.
      WebSocket: c.WebSocket,
      sessionStorage: c.sessionStorage,
      BroadcastChannel: c.BroadcastChannel,
      // So a child abandons an unanswered subscribe when its parent would.
      subscribeTimeoutMs: c.subscribeTimeoutMs,
    };
  }

  /**
   * Invite people into `targetScope`: a mesh call to the `AUTH_FACADE` Worker, so the verified
   * claims ride `callContext.originAuth` and never a Bearer header. Every member may invite plain
   * members into their own scope; dominion also permits inviting downward, and is the only thing
   * that grants a requested `scopeAdmin`. A refusal rejects with the facade's message.
   *
   * The summary reports what was minted; the mail finishes after it returns. In test mode `links`
   * carries the raw invite URLs, and a production summary never does.
   *
   * ⚠️ **`inviterName` is the inviter's own text, and is shown as their claim.** The invitee's
   * consent modal renders it as "{name} (supplied by the sender)", because the person it defends
   * against is the one who typed it. The facade caps its length and strips control characters; left
   * out, the modal says "Someone".
   */
  invite(targetScope: string, invitees: InviteeRequest[], inviterName?: string): Promise<InviteSummary> {
    return this.lmz.callAsync(
      'AUTH_FACADE', undefined,
      this.ctn<AuthFacade>().invite(targetScope, invitees, inviterName),
    );
  }

  /**
   * The scope tree a session manages: an account's apps, creating one, and deleting a scope. Each is
   * a mesh call to the `AUTH_FACADE` Worker, so the verified claims ride `callContext.originAuth`.
   * A deletion's Durable Objects are wiped before the answer arrives, so a caller wipes nothing.
   */
  get scopes() {
    // A fresh continuation per call: a chain is recorded onto its root.
    const facade = () => this.ctn<AuthFacade>();
    const call = <T>(remote: unknown): Promise<T> =>
      this.lmz.callAsync('AUTH_FACADE', undefined, remote as never) as Promise<T>;
    return {
      /**
       * One more level beneath this Client's own page: a universe page's apps. The parent is the
       * token's `aud`, never an argument. Pass the previous answer's `nextCursor` as `after` to go
       * on; its absence means the level is exhausted.
       */
      expand: (after?: string): Promise<{ children: ScopeNode[]; nextCursor?: string }> =>
        call(facade().expandScope(after ? { after } : undefined)),
      /** Create the Galaxy `{universe}.{galaxySlug}` and its `.dev` Star (dominion over the universe). */
      createGalaxy: (universe: string, galaxySlug: string): Promise<{ instanceName: string }> =>
        call(facade().createGalaxy(`${universe}.${galaxySlug}`)),
      /** What deleting `target` would take with it, for a confirm screen. Attached users never
       *  refuse a delete (ADR-015). */
      deletePlan: (target: string): Promise<ScopeDeletionPlan> =>
        call(facade().planScopeDeletion(target)),
      /** Delete `target` and every scope beneath it, answering with what went. */
      delete: (target: string): Promise<{ affected: AffectedScope[] }> =>
        call(facade().executeScopeDeletion(target)),
    };
  }

  // ============================================
  // The Profile channel
  // ============================================

  /**
   * Subscribe to a person's public profile, `name`, `nickname` and `picture`, by `profileId`
   * (ADR-012): any session holding the id may read it. The call goes to the `PROFILE` binding with
   * the id as the instance, whatever scope this page is in. Pushes reach {@link onProfileUpdate}'s
   * listener; the handle's `snapshot` resolves on the first. Handles are counted per profile, and
   * the subscription is released when the last one is disposed.
   */
  subscribeProfile(profileId: string): ProfileSubscription {
    this.#profileRefcount.set(profileId, (this.#profileRefcount.get(profileId) ?? 0) + 1);
    const snapshot = awaitFirstPush(
      this.#profilePending, profileId,
      () => this.#sendProfileSubscribe(profileId),
      (reason) => this.handleProfileUpdate(profileId, reason),
      this.#config.subscribeTimeoutMs,
    );
    let disposed = false;
    return {
      snapshot,
      [Symbol.dispose]: (): void => {
        if (disposed) return;
        disposed = true;
        this.#releaseProfile(profileId);
      },
    };
  }

  /** Release one handle on a profile: what one `[Symbol.dispose]()` of a `subscribeProfile` handle does. */
  unsubscribeProfile(profileId: string): void {
    this.#releaseProfile(profileId);
  }

  /**
   * Write the public fields of this session's own profile, the one its `profileId` claim names.
   * The Profile allows its owner or an admin; under impersonation the claim names the subject, so
   * the child edits the subject's profile as they would. The change reaches every subscriber.
   */
  updateMyProfile(fields: { name?: string; nickname?: string; picture?: string }): Promise<void> {
    const profileId = this.claims?.profileId;
    if (!profileId) return Promise.reject(new Error('updateMyProfile: this session has no profileId yet'));
    return this.lmz.callAsync('PROFILE', profileId, this.ctn<ProfileTarget>().writeProfile(fields)) as Promise<void>;
  }

  /**
   * Register the listener every profile push reaches: the factory's, which mirrors it into
   * `store.lmz.profiles[profileId]`. One at a time; a later call replaces it.
   */
  onProfileUpdate(handler: ((profileId: string, snapshot: ProfileChannelSnapshot | null) => void) | null): void {
    this.#profileListener = handler;
  }

  /**
   * A push from a Profile: the answer to a subscribe, or a later change. It reaches the listener,
   * and settles a subscribe still waiting for its first. `null`, a profile that does not exist,
   * reaches no listener; an Error, a refused subscribe, rejects the waiting one. `@mesh()`-decorated
   * below the class, by a call rather than by syntax.
   */
  handleProfileUpdate(profileId: string, result: ProfileChannelSnapshot | null | Error): void {
    const pending = this.#profilePending.get(profileId);
    if (result instanceof Error) {
      if (pending) { this.#profilePending.delete(profileId); pending.reject(result); }
      return;
    }
    if (result !== null) this.#profileListener?.(profileId, result);
    if (pending) { this.#profilePending.delete(profileId); pending.resolve(result); }
  }

  /** A profile subscribe's result handler, sent `onErrorOnly`: a refusal settles the waiting subscribe. */
  onProfileSubscribeRefused(profileId: string, result?: unknown): void {
    if (result instanceof Error) this.handleProfileUpdate(profileId, result);
  }

  /**
   * The result handler for a call whose refusal leaves nothing to settle, an unsubscribe say. Sent
   * `onErrorOnly`, so it hears only an Error, and logs it.
   */
  logRefusal(what: string, result?: unknown): void {
    if (result instanceof Error) {
      this.#debugFactory('lumenize.nebula-client').warn(`${what} was refused`, { error: result.message });
    }
  }

  #sendProfileSubscribe(profileId: string): void {
    this.lmz.call('PROFILE', profileId, this.ctn<ProfileTarget>().subscribe(),
      this.ctn<this>().onProfileSubscribeRefused(profileId), { onErrorOnly: true });
  }

  #releaseProfile(profileId: string): void {
    const n = this.#profileRefcount.get(profileId) ?? 0;
    if (n > 1) { this.#profileRefcount.set(profileId, n - 1); return; }
    this.#profileRefcount.delete(profileId);
    this.lmz.call('PROFILE', profileId, this.ctn<ProfileTarget>().unsubscribe(),
      this.ctn<this>().logRefusal('unsubscribeProfile'), { onErrorOnly: true });
  }

  // ============================================
  // Lifecycle Hooks (Override in Subclass)
  // ============================================

  /**
   * Called before each incoming mesh call is executed
   *
   * Override to add authentication/authorization.
   * Default: block a DIRECT client-to-client call — one whose IMMEDIATE caller
   * (`callChain.at(-1)`) is another Client. DO/Worker-mediated pushes
   * (fanout, direct-delivery, `lmz.broadcast`) have a DO/Worker as the caller and
   * are accepted — this is what every reactive app relies on, so no override is
   * needed for them. A call this Client made to itself through its host is its own,
   * and accepted: the caller is the address its host named it by. Override (and skip
   * `super`) to opt into peer communication; an app that does must then guard its own
   * push handlers, which this refusal was protecting.
   *
   * ⛔ **This default refusal stays. Do not remove it to make peer calls the default.**
   * Larry 2026-10-05: "If I ever try to remove this again, remind me that we've tried
   * several times before and failed." The last attempt, a design review on
   * 2026-10-05, opened peer calls and guarded each push handler instead. One review
   * found seven separate defects that existed only because peers were open: a passage
   * check asked in the wrong direction, a guard bypassed through the shared call
   * context during an await, overrides that silently dropped the guard, a slow peer
   * method costing its callee a reconnect, and the docs and tests each had to relearn
   * all of it. A peer feature goes through a node instead: a two-person chat is a
   * room on the server, with history and presence for free.
   *
   * It runs before the incoming chain is decoded, so nothing a refused sender wrote is ever
   * decoded; an override reads only `this.lmz.callContext`.
   *
   * Access context via `this.lmz.callContext`.
   */
  onBeforeCall(): void {
    // Check the IMMEDIATE caller, not the origin: a DO/Worker-mediated push has a
    // DO/Worker caller (accepted); only a direct peer call has a client caller.
    const caller = this.#currentCallContext?.callChain.at(-1);
    const self = this.#address;
    if (caller?.type === 'LumenizeClient'
      && (caller.bindingName !== self?.bindingName || caller.instanceName !== self?.instanceName)) {
      throw new Error(
        'Direct client-to-client calls are disabled by default. ' +
        'Override onBeforeCall() to allow them.'
      );
    }
  }

  /**
   * Called when this Client must re-establish its subscriptions, because a reaper may have dropped
   * them: on its first connection, and on a reconnect the Gateway reports `subscriptionRequired:
   * true`, which it does after any delivery to this Client failed, a 4408 close included. Not on a
   * network blip or a token rotation inside the grace period. Override it in a subclass, or pass
   * `onSubscriptionRequired` in the config, which this default calls.
   */
  onSubscriptionRequired(): void {
    // Every live profile, sent again: a Profile whose push to this Client failed dropped its row.
    for (const profileId of this.#profileRefcount.keys()) this.#sendProfileSubscribe(profileId);
    this.#config.onSubscriptionRequired?.();
  }

  /**
   * Called after every new token this Client takes: each refresh, and a seeded `accessToken`. Read
   * the new token's claims from `this.claims`. A subclass whose subscriptions depend on a claim
   * compares it here, and a reconnect after it carries the new token. Default: nothing.
   */
  onClaimsChange(): void {}

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

      // Stopped while a refresh or a tab id was awaited, by `disconnect()` or by its host's
      // deletion: no socket opens, since one would reconnect what was stopped on purpose.
      if (this.#stoppedOnPurpose) return;

      // Build WebSocket URL
      const url = this.#buildWebSocketUrl();

      // Build protocols array with token
      const protocols: string[] = [WS_PROTOCOL];
      if (this.#accessToken) {
        protocols.push(`${WS_TOKEN_PREFIX}${this.#accessToken}`);
      }

      // Create WebSocket
      this.#ws = new this.#WebSocketClass(url, protocols);
      this.#socketToken = this.#accessToken;

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
      throw new Error('MeshClient requires baseUrl in Node.js environments');
    }

    // Ensure wss:// or ws:// protocol
    if (baseUrl.startsWith('https://')) {
      baseUrl = baseUrl.replace('https://', 'wss://');
    } else if (baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'ws://');
    }

    // Build URL: /gateway/{instanceName}; the Worker derives the host node from the hostname
    const instance = this.#instanceName;
    if (!instance) {
      throw new Error('instanceName not available — connect has not completed');
    }

    return `${baseUrl}/gateway/${instance}`;
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

    if (code === WS_CLOSE_GONE) {
      // The node hosting this Client was deleted. Reconnecting would build an empty object at the
      // deleted name, so the Client stops and says why.
      const error = new HostDeletedError(`The node hosting this client was deleted${reason ? `: ${reason}` : ''}`);
      this.#stoppedOnPurpose = true;
      this.#clearReconnectTimeout();
      this.#stop(error);
      this.#config.onHostDeleted?.(error);
      return;
    }

    // Normal disconnection - schedule reconnect
    this.#scheduleReconnect();
  }

  async #handleTokenExpired(): Promise<void> {
    try {
      await this.#refreshToken();
      // A Client stopped while the refresh was in flight stays stopped.
      if (this.#stoppedOnPurpose) return;
      // Reconnect with new token
      this.#setConnectionState('reconnecting');
      this.#connectInternal();
    } catch (error) {
      // A Client stopped on purpose does not send its user to log in.
      if (this.#stoppedOnPurpose) return;
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
      const down = this.#connectionState === 'reconnecting' || this.#connectionState === 'disconnected';
      if (down && !this.#stoppedOnPurpose) {
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
    } else {
      // Endpoint URL - use custom fetch if provided (for cookie-aware requests)
      const fetchFn = this.#config.fetch ?? fetch;
      const response = await fetchFn(refresh, {
        method: 'POST',
        credentials: 'include', // Include cookies
      });

      if (!response.ok) {
        // Read the body to completion even though nothing wants it: an unread body keeps the
        // response open, and a page navigating away while it is pending logs a phantom failure for
        // an answered request. (Not `body.cancel()` — that aborts at the network layer and produces
        // the same phantom deterministically.)
        await response.text().catch(() => { /* nothing to drain is fine */ });
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
    }

    if (!this.#accessToken) {
      throw new Error('Refresh returned no token');
    }

    const parsed = parseJwtUnsafe(this.#accessToken);
    if (!parsed) {
      throw new Error('Refresh returned a malformed access_token');
    }
    const previousSub = this.#lastSub;
    // Trust boundary: see the constructor's claims assignment.
    this.#claims = Object.freeze(parsed.payload) as unknown as Readonly<TClaims>;
    this.#lastSub = parsed.payload.sub;
    this.#learnActiveScope();
    this.#followSub(previousSub);
    this.#tellClaimsChanged();
  }

  /** Take the page's scope from the token's `aud`, once: a page's host never changes under it. */
  #learnActiveScope(): void {
    if (this.#activeScope !== undefined) return;
    const aud = (this.#claims as { aud?: unknown } | null)?.aud;
    if (typeof aud !== 'string') return;
    this.#activeScope = aud;
    this.#resolveActiveScope(aud);
  }

  /** Run {@link onClaimsChange}; a throw there is logged, never thrown into the refresh. */
  #tellClaimsChanged(): void {
    try {
      this.onClaimsChange();
    } catch (err) {
      this.#debugFactory('lmz.mesh.LumenizeClient.onClaimsChange').error('onClaimsChange threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Move this Client to a new token's `sub`. A Client's name must start with its `sub`, so a token
   * resting on a different membership needs `{newSub}.{tabId}`: a fresh Gateway, which reports
   * `subscriptionRequired: true`. A membership never changes scope, so a token for another scope
   * always carries another `sub` (the Registry's `#mintIdentity` JSDoc says so).
   */
  #followSub(previousSub: string | undefined): void {
    const sub = (this.#claims as { sub?: string } | null)?.sub;
    if (!previousSub || !sub || sub === previousSub || !this.#instanceName) return;
    this.#instanceName = `${sub}${this.#instanceName.slice(this.#instanceName.indexOf('.'))}`;
    this.#debugFactory('lmz.mesh.LumenizeClient.#followSub').info('the token names a new sub; reconnecting under it', {
      instanceName: this.#instanceName,
    });
    // A socket open under the old name is replaced. A reconnect already under way builds its URL
    // after this refresh, so it takes the new name by itself.
    if (this.#ws?.readyState === WebSocket.OPEN && !this.#rotating) this.#rotateSocketForFreshToken();
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
    // An open socket opened with an older token than this one would lapse under the next call,
    // since judging the new token's `exp` never rotates it. Move it now, which also puts a changed
    // claim, such as an admin verdict, in front of the Gateway and its hosts. A socket a rotation or
    // reconnect already opened with this token is left alone.
    if (this.#accessToken !== this.#socketToken && this.#ws?.readyState === WebSocket.OPEN && !this.#rotating) {
      this.#rotateSocketForFreshToken();
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

      case GatewayMessageType.RESPONSE:
        this.#handleResponse(message as ResponseMessage);
        break;

      case GatewayMessageType.INCOMING_CALL:
        this.#handleIncomingCall(message as IncomingCallMessage);
        break;

      default:
        this.onUnknownMessage(message);
    }
  }

  #handleConnectionStatus(message: ConnectionStatusMessage): void {
    // The name the host holds this Client under, before anything reads it: `callee` on every call
    // that arrives, and what the peer check compares a caller with. A host that names none, one
    // still on an older version during a rollout, leaves the Client unable to call itself, which
    // the peer check then refuses, but connected: throwing here would leave it short of `connected`.
    this.#address = message.address ? splitAddress(message.address) : undefined;
    const reconnect = this.#connectedBefore;
    this.#connectedBefore = true;

    // Now connected
    this.#setConnectionState('connected');

    // Flush queued messages
    this.#flushMessageQueue();

    // Notify if subscriptions need to be (re)established. The Gateway's report is the one signal: it
    // records any delivery to this Client that failed, a 4408 close included.
    if (message.subscriptionRequired) {
      this.onSubscriptionRequired();
    } else if (reconnect) {
      // Nothing was lost, but a profile subscribe sent just as the last socket closed may never have
      // reached its Profile: one still waiting for its first push goes again.
      for (const profileId of this.#profilePending.keys()) this.#sendProfileSubscribe(profileId);
    }
  }

  /**
   * The response door: this Client's own result handler continuation, filled with the outcome, from
   * a node's fire-back or a refusal at its Gateway's early ack. It runs with the `@mesh()` check
   * off and no `onBeforeCall` — its Gateway wrote the return address and checked the continuation
   * on the way out — under the fire-back's context, so `callee` is its last hop: the node that
   * answered. An answer carrying another load's `loadId` is dropped, and this Client keeps nothing
   * per call for it.
   */
  #handleResponse(message: ResponseMessage): void {
    const log = this.#debugFactory('lmz.mesh.LumenizeClient.#handleResponse');
    if (message.loadId !== this.#loadId) {
      log.debug('dropped an answer meant for another load', { callId: message.callId, loadId: message.loadId });
      return;
    }
    let chain: OperationChain;
    try {
      chain = postprocess(message.chain) as OperationChain;
    } catch (error) {
      log.error('could not decode an answer', {
        callId: message.callId, error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const { callChain, originAuth } = message.callContext;
    this.#runFilledChain(message.callId, chain, { callChain, originAuth, callee: callChain.at(-1) });
  }

  /**
   * Run a filled result handler chain under `context`, with the `@mesh()` check off. A throwing
   * handler is logged, never thrown: nothing awaits it.
   */
  #runFilledChain(callId: string, chain: OperationChain, context: ClientCallContext): void {
    const run = async () => {
      const prev = this.#currentCallContext;
      this.#currentCallContext = context;
      try {
        await executeFilledChain(chain, this, { requireMeshDecorator: false });
      } finally {
        this.#currentCallContext = prev;
      }
    };
    run().catch((err) => {
      this.#debugFactory('lmz.mesh.LumenizeClient.#runFilledChain').error(
        'result handler threw', { callId, error: err instanceof Error ? err.message : String(err) },
      );
    });
  }

  /**
   * `callAsync`'s result handler continuation: settles the Promise kept under `callId`, rejecting
   * on an Error outcome. A Promise already settled, aborted or timed out is gone from the map, so a
   * late answer does nothing. No `@mesh()`: no other node can call it, and it runs only as this
   * Client's own continuation.
   *
   * @internal
   */
  __settleCallAsync(callId: string, result?: unknown): void {
    const pending = this.#pendingAsyncCalls.get(callId);
    if (!pending) return;
    this.#pendingAsyncCalls.delete(callId);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (result instanceof Error || (typeof DOMException !== 'undefined' && result instanceof DOMException)) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  }

  async #handleIncomingCall(message: IncomingCallMessage): Promise<void> {
    const { callId, chain: preprocessedChain, callContext: preprocessedCallContext } = message;
    // A call the Gateway sent again on a new socket is answered from the record, never run twice.
    // One still running answers on whatever socket is current when it finishes.
    if (this.#answers.has(callId)) {
      const kept = this.#answers.get(callId);
      if (kept) this.#send(kept);
      return;
    }
    this.#keepAnswer(callId, null);
    // Declared out here so the catch can name the member that failed. The WIRE form is not
    // readable for this — `preprocess` re-shapes the array — so the catch needs the postprocessed
    // one, and gets `undefined` when the caller check refused before decoding, or decoding threw.
    let chain: OperationChain | undefined;

    try {
      // No `originRequest`: it stays server-side, so the Gateway never sends one.
      const callContext: ClientCallContext = {
        callChain: preprocessedCallContext.callChain,  // Plain strings - no postprocessing
        originAuth: preprocessedCallContext.originAuth,  // From JWT - no postprocessing
        // This Client's own address, as every receiver stamps its own: never from the wire.
        callee: this.#selfIdentity(),
      };

      // The context this chain runs under, for `this.lmz.callContext` and `onBeforeCall` below.
      // Correct until the chain's first await yields; see the header of this file.
      this.#currentCallContext = callContext;

      // The caller check runs BEFORE the chain is decoded. It reads only the plain `callChain`, and
      // a refused sender's payload must never reach the decoder, which builds values from it.
      this.onBeforeCall();

      // Postprocess the chain, which was preprocessed for WebSocket transport
      chain = postprocess(preprocessedChain) as OperationChain;

      // Execute the operation chain
      const result = await executeOperationChain(chain, this);

      // Send success response (preprocess for structured clone handling)
      this.#answerIncoming(callId, {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: true,
        result: preprocess(result),
      });

    } catch (error) {
      // ⚠️ LOG BEFORE SENDING. The response below is the only other place this failure goes, and it
      // travels AWAY from the node that is usually stuck: a push refused here is typically the very
      // thing this client is awaiting, so the error leaves for the caller while the local waiter
      // hangs. The response leg already logs its handler throws (`#runFilledChain` above); the
      // request leg did not, and an override without `@mesh()` that shadowed a `@mesh()` method was
      // therefore invisible on every node — the refusal went onto the wire, the caller had no result
      // handler for a fire-and-forget push, and the symptom was a hang with no message anywhere.
      //
      // The MEMBER NAME and the message, never the args: an inbound chain's arguments are payload.
      const entry = chain?.[0];
      const entryKey = entry && entry.type === 'get' ? entry.key : undefined;
      this.#debugFactory('lmz.mesh.LumenizeClient.#handleIncomingCall').error(
        'inbound call refused or threw',
        {
          callId,
          member: entryKey === undefined ? '(unknown)' : String(entryKey),
          error: error instanceof Error ? error.message : String(error),
        },
      );

      // Send error response
      // Preprocess error (Error objects need special handling for JSON)
      this.#answerIncoming(callId, {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: false,
        error: preprocess(error),
      });

    } finally {
      this.#currentCallContext = null;
    }
  }

  /** Send the answer to an incoming call, and keep it, so a repeat of the call gets the same one. */
  #answerIncoming(callId: string, response: IncomingCallResponseMessage): void {
    const frame = JSON.stringify(response);
    this.#keepAnswer(callId, frame);
    this.#send(frame);
  }

  #keepAnswer(callId: string, frame: string | null): void {
    this.#answers.delete(callId); // so a re-set moves to the newest end
    this.#answers.set(callId, frame);
    // Oldest first, and never a call still running, whose repeat must keep waiting for it.
    for (const [id, kept] of this.#answers) {
      if (this.#answers.size <= ANSWER_RECORD_SIZE) break;
      if (kept !== null) this.#answers.delete(id);
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

  #sendOrQueue(message: string, callId: string, onRefused: (refusal: Error) => void): void {
    // ⚠️ An OPEN socket whose token is DUE is not a socket to send on. The Gateway checks the
    // ATTACHMENT's `exp` on every inbound message and closes 4401, dropping that message at the
    // door; the client then re-auths and reconnects, but a message already SENT is never replayed —
    // so a client idle past its TTL lost its first call, and a `callAsync` waited out its timeout
    // (bit 2026-09-03: `impersonation-expiry`, deterministic). Queue it instead and ROTATE the
    // socket — refresh, reconnect with the new token, and let the `connection_status` flush deliver
    // it on a socket whose attachment is fresh. The refresh-ahead window makes this proactive: a
    // token with under 30 s left rotates before it can lapse mid-flight.
    const socketOpen = this.#ws?.readyState === WebSocket.OPEN;
    if (socketOpen && !this.#needsTokenRefresh()) {
      this.#ws!.send(message);
      return;
    }
    // Queue until reconnect, up to MAX_QUEUE_SIZE; past that the call is refused, not queued.
    if (this.#messageQueue.length >= MAX_QUEUE_SIZE) {
      this.#refuseCall(callId, onRefused);
      return;
    }
    this.#messageQueue.push({ message, callId });
    if (socketOpen) this.#rotateSocketForFreshToken();
  }

  /**
   * Refuse a call the queue has no room for, and tell whoever waits on it: the call's result
   * handler runs here with a `QuotaExceededError`, and for a `callAsync` that rejects its Promise.
   *
   * The outcome is delivered on a later task, as an answer or a timeout is. Settled at once, a
   * caller that retries on failure would loop without ever yielding to the socket event that
   * empties the queue.
   */
  #refuseCall(callId: string, onRefused: (refusal: Error) => void): void {
    this.#debugFactory('lmz.mesh.LumenizeClient.#sendOrQueue').warn(
      'message queue full — refusing call', { callId, limit: MAX_QUEUE_SIZE },
    );
    const refusal = new DOMException(
      `MeshClient holds at most ${MAX_QUEUE_SIZE} calls while its socket is down; this one was refused`,
      'QuotaExceededError',
    );
    setTimeout(() => onRefused(refusal), 0);
  }

  #rotating = false;

  /**
   * Replace an open socket whose token is due with one authenticated by a fresh token. The queue
   * carries whatever was meant for the old socket; the new socket's `connection_status` flushes it.
   *
   * Order matters: the NEW socket is assigned before the old one is closed, so the old socket's
   * close event is the "stale close from superseded socket" the `onclose` guard already ignores —
   * no competing reconnect, no clobbered `#ws`. `#connectInternal` refreshes on its own when the
   * token is due, and `#ensureFreshToken` de-dupes, so the refresh happens exactly once.
   */
  #rotateSocketForFreshToken(): void {
    if (this.#rotating) return;
    this.#rotating = true;
    const old = this.#ws;
    this.#setConnectionState('reconnecting');
    this.#connectInternal()
      .then(() => { old?.close(1000, 'token rotated'); })
      .finally(() => { this.#rotating = false; });
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
   * This Client's own identity, as a node stamps its own: the address its host named it by,
   * `{ bindingName: 'STAR', instanceName: 'acme.crm.tenant1/alice.9f2c41aa' }`. `undefined` before
   * the first connection, when no host has named it.
   */
  #selfIdentity(): NodeIdentity | undefined {
    return this.#address && { type: 'LumenizeClient', ...this.#address };
  }

  /**
   * Send a `call` message carrying its result handler continuation, which travels to the node and
   * comes back filled (no awaited Promise — the client never blocks on a result). Its callers run
   * `assertCrossable` first. A call the queue has no room for runs its handler here, with a
   * `QuotaExceededError`.
   */
  #sendCall(
    callId: string,
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteChain: OperationChain,
    handlerChain: OperationChain,
    options?: ClientCallOptions
  ): void {
    const message: CallMessage = {
      type: GatewayMessageType.CALL,
      callId,
      loadId: this.#loadId,
      binding: calleeBindingName,
      instance: calleeInstanceNameOrId,
      chain: preprocess(remoteChain),
      handler: preprocess(handlerChain),
      ...(options?.onErrorOnly ? { onErrorOnly: true } : {}),
    };
    const json = JSON.stringify(message);

    // Notify caller of the assigned callId before send/queue, so instrumentation can correlate.
    options?.onSent?.(callId);
    this.#sendOrQueue(json, callId, (refusal) => {
      const self = this.#selfIdentity();
      this.#runFilledChain(callId, replaceNestedOperationMarkers(handlerChain, refusal),
        { callChain: self ? [self] : [], callee: self });
    });
  }

  #call<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation: Continuation<any>,
    options?: ClientCallOptions
  ): void {
    // Extract + validate chains (sync-throw on an invalid continuation), then send both: the
    // handler travels with the call and comes back filled, so nothing is kept here per call.
    const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);
    assertCrossable(remoteChain, handlerChain);
    this.#sendCall(crypto.randomUUID(), calleeBindingName, calleeInstanceNameOrId, remoteChain, handlerChain, options);
  }

  #callAsync<T = any>(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    options?: ClientCallOptions & { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Awaited<T>> {
    // 1. Validate + extract the remote chain synchronously (sync-throw on an invalid
    //    continuation, same as `call()`; a developer error, never a rejection).
    const remoteChain = extractRemoteChain(remoteContinuation);
    assertCrossable(remoteChain);

    // 2. Compose the caller's signal (external cancel) with the built-in default timeout, so
    //    the common path can't hang and `signal` stays free for unmount/user-cancel. 0/Infinity off.
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CALLASYNC_TIMEOUT_MS;
    const timeoutSignal = timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const signal = combineAbortSignals(options?.signal, timeoutSignal);

    // 3. Pre-aborted at the call site → reject immediately, don't dispatch (matches `fetch`).
    if (signal?.aborted) return Promise.reject(signal.reason);

    // 4. The result handler continuation settles the Promise kept under this callId.
    const callId = crypto.randomUUID();
    const handlerChain = getOperationChain((this.ctn() as any).__settleCallAsync(callId))!;

    return new Promise<Awaited<T>>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          // Abort BEFORE the answer: drop the entry (a late answer then finds nothing → dropped)
          // and reject with the abort reason (a DOMException: AbortError or TimeoutError). The
          // delete's return-value guards a settle/abort race — never double-settle.
          if (!this.#pendingAsyncCalls.delete(callId)) return;
          // A call still in the queue has not left: take it out, or reconnect would send an
          // operation its caller already gave up on — such as a write it has since rolled back.
          const queued = this.#messageQueue.findIndex((q) => q.callId === callId);
          if (queued !== -1) this.#messageQueue.splice(queued, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pendingAsyncCalls.set(callId, { resolve, reject, signal, onAbort });

      // 5. Send the call. Its continuation comes back filled and settles the Promise.
      this.#sendCall(callId, calleeBindingName, calleeInstanceNameOrId, remoteChain, handlerChain, options);
    });
  }

  /**
   * Test-only: the number of in-flight `callAsync` Promises (`#pendingAsyncCalls` map size). The
   * map is per-session heap-bounded, so cleanup (delete-on-delivery, delete-on-abort) is a real
   * correctness property — but a settled Promise no-ops a second settle, making double-settle
   * behaviorally invisible. This read-only count is the transient surface a test asserts to prove the
   * entry was actually removed (no leak). NOT part of the public API.
   */
  protected pendingAsyncCallCount(): number {
    return this.#pendingAsyncCalls.size;
  }

  /** Test-only: how many answers the record of recent incoming calls holds. NOT part of the public API. */
  protected answerRecordCount(): number {
    return this.#answers.size;
  }
}

// `@mesh()` applied by a call rather than by decorator syntax, so `@lumenize/mesh/client` holds no
// decorator syntax and loads through any TypeScript transform. A Vite config loaded through Vite's
// runner, which imports this module for `parseHost`, does not transform TC39 decorators, and a
// class decorated by syntax there fails to load.
mesh()(MeshClient.prototype.handleProfileUpdate, {} as ClassMethodDecoratorContext);

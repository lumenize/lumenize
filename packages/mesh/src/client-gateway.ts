import { preprocess, postprocess } from '@lumenize/structured-clone';
import { debug } from '@lumenize/debug';
import { WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG } from './ws-heartbeat.js';
import { fillHandler, fireResponse, resolveStub, type CallEnvelope, type EnvelopeResponse } from './lmz-api.js';
import { addressOf, hostInstanceOf } from './client-address.js';
import { validateOperationChain, type OperationChain } from './ocan/index.js';
import type { NodeType, NodeIdentity, CallContext, OriginAuth, OriginRequest, OriginCf } from './types.js';
import {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_TIMED_OUT,
  WS_PROTOCOL,
  type CallMessage,
  type ResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
  type ConnectionStatusMessage,
  type GatewayMessage,
  type GatewayConnectionInfo,
} from './gateway-messages.js';

/** Grace period before a Client's subscriptions are treated as lost (5 seconds) */
const PRODUCTION_GRACE_PERIOD_MS = 5000;

/**
 * Test-mode grace period (60 seconds). Used only when `LUMENIZE_MESH_TEST_MODE === 'true'`.
 *
 * The production default (5 s) is generous relative to real-world reconnect latencies —
 * even a mobile-network handoff or a tab wake-up typically completes in < 1 s. In the test
 * environment that breaks: vitest runs every mesh project in parallel, spinning up 10+ miniflare
 * workers at once, and under that contention a synthetic close/reconnect cycle can take >5 s of
 * wall-clock time, which expires the grace period mid-test and flips `subscriptionRequired` to
 * true. 60 s gives the reconnect headroom without changing production behavior.
 */
const TEST_GRACE_PERIOD_MS = 60_000;

/** Timeout for a Client to answer an incoming call (30 seconds) */
const CLIENT_CALL_TIMEOUT_MS = 30000;

/** The most characters Cloudflare allows a WebSocket tag, which a hosted Client's name becomes. */
const MAX_TAG_LENGTH = 256;

/** A call a node made to the Client, waiting for the Client's answer */
interface PendingCall {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** The Client it went to, the node's envelope and the frame sent down, so a socket that replaces
   *  the one it went down can be sent it again, under the same `callId`, after its own checks. */
  instanceName: string;
  envelope: CallEnvelope;
  frame: string;
}

/** A wait for the Client to reconnect within its grace period */
interface ReconnectWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * One Client's grace period: the timer that ends it, and the calls waiting for the Client to come
 * back. It runs exactly while its record exists, so no deadline is compared against a clock that
 * stands still within a request. Held in memory only — an evicted host has no record, so a
 * reconnecting Client is told `subscriptionRequired: true` and a call to it answers
 * `ClientDisconnectedError` at once, both of which are the safe direction.
 */
interface GracePeriod {
  timer: ReturnType<typeof setTimeout>;
  waiters: ReconnectWaiter[];
  /** A delivery to the Client failed while it was away, so its next connection must re-subscribe. */
  lost: boolean;
}

/**
 * What `ClientGateway` needs from the node that hosts it: the three hooks every host implements, and
 * the node's own request door. `ScopedMeshDO` is the host, and implements each hook; a subclass
 * overrides one to add to it.
 */
export interface ClientGatewayHost {
  /**
   * Connection-time hook, called during a Client's upgrade after its token is decoded. Every JWT
   * payload field becomes the connection's claims; a returned `Record` merges on top
   * (`{ ...jwtPayload, ...hookResult }`), and a returned `Response` refuses the upgrade.
   */
  onBeforeAccept(
    instanceName: string,
    sub: string,
    jwtPayload: Record<string, unknown>,
  ): Response | Record<string, unknown> | undefined;
  /**
   * Pre-dispatch hook: the context a Client's call carries, built from its socket's verified
   * attachment, returned enriched or as it is. `callId` is the inbound frame's, for tracing.
   */
  onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo, callId: string): CallContext;
  /**
   * Pre-forward hook: a node's call to the Client, after the ack and immediately before it goes down
   * the socket, with the Client's verified identity and claims. Throw to refuse it: the Error fills
   * the calling node's continuation, which fires back to it. It returns `undefined` rather than
   * `void` so that an `async` override, whose rejected Promise would refuse nothing, does not compile.
   */
  onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): undefined;
  /**
   * The host node's own request door. A Client's call to the node that hosts it runs through it as a
   * method call, so it passes the passage step, `onBeforeCall` and the `@mesh()` check exactly as an
   * RPC would.
   */
  __executeOperation(envelope: CallEnvelope): Promise<any>;
}

/**
 * ClientGateway — a Client's server-side half, as code a Durable Object composes.
 *
 * A Client and this half together are the equivalent of a server-side mesh node: this half holds
 * whatever must not depend on the browser's honesty. It accepts and supersedes a Client's socket,
 * builds the whole `callContext` of every call the Client makes from the socket's verified
 * attachment, acks a node's call to the Client and fills that node's continuation with the
 * Client's answer, and waits within a grace period for a Client whose socket closed.
 *
 * **Zero storage.** Nothing here touches `ctx.storage`. State is derived from the host's sockets,
 * each tagged with its Client's `instanceName`, from those sockets' attachments, and from two
 * in-memory records: a grace period per Client, and the node calls waiting for a Client's answer.
 * Both die with the isolate, and each says what that costs where it is declared. Every socket
 * lookup names its Client, so one host holds many. A Client's state, and what its next connection
 * is told:
 *
 * | Client's socket | Grace period | State | subscriptionRequired on reconnect |
 * |-----------------|--------------|-------|-----------------------------------|
 * | Open | — | Connected | `false` (a supersede) |
 * | None | Running (≤5 s) | Grace Period | `false`, or `true` once a delivery to it failed |
 * | None | None, or ended | Disconnected | `true` |
 *
 * An evicted host has no record of a grace period, so it reports `true`, the safe direction. A
 * delivery that failed is recorded on the grace period and on every socket the Client still holds,
 * open or closing, and the next connection is told `true` whatever the row says.
 *
 * The host reaches it only through its entry points and hands it only its `ctx`, its `env` and the
 * hooks in {@link ClientGatewayHost}.
 */
export class ClientGateway {
  #ctx: DurableObjectState;
  #env: any;
  #host: ClientGatewayHost;

  /** Calls a node made to a Client, waiting for that Client's answer, by the callId sent down */
  #pendingCalls = new Map<string, PendingCall>();

  /** Each Client's grace period, by `instanceName`, from its socket's close to its reconnect */
  #gracePeriods = new Map<string, GracePeriod>();

  constructor(ctx: DurableObjectState, env: any, host: ClientGatewayHost) {
    this.#ctx = ctx;
    this.#env = env;
    this.#host = host;
  }

  get #gracePeriodMs(): number {
    // Explicit numeric override takes precedence. Tests that observe post-grace behavior set it
    // small through miniflare's `bindings` block; it is unset in production.
    const override = this.#env.LUMENIZE_MESH_GRACE_PERIOD_MS;
    if (override !== undefined) {
      const parsed = Number(override);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return this.#env.LUMENIZE_MESH_TEST_MODE === 'true'
      ? TEST_GRACE_PERIOD_MS
      : PRODUCTION_GRACE_PERIOD_MS;
  }

  /**
   * Timeout for a mesh→client push (`#forwardToClient`). Overridable in test mode via the
   * `LUMENIZE_MESH_CLIENT_CALL_TIMEOUT_MS` miniflare binding — NOT prod-reachable — so grace→drop
   * paths are asserted deterministically without a real ~30 s wait. Production default otherwise.
   */
  get #clientCallTimeoutMs(): number {
    const override = this.#env.LUMENIZE_MESH_CLIENT_CALL_TIMEOUT_MS;
    if (override !== undefined) {
      const parsed = Number(override);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return CLIENT_CALL_TIMEOUT_MS;
  }

  // ============================================
  // Entry points (the host's delegate to these)
  // ============================================

  /** A WebSocket upgrade from a Client — the host's `fetch`. */
  async acceptUpgrade(request: Request): Promise<Response> {
    const log = debug('lmz.mesh.ClientGateway.acceptUpgrade');

    // Only handle WebSocket upgrades
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // A Client that offers only the previous protocol name speaks a wire this Gateway no longer
    // has. Refused before any side effect, so an open socket under the same name stays open.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
    if (!offered.includes(WS_PROTOCOL)) {
      log.warn('WebSocket upgrade refused: the Client does not offer the current protocol', { offered: offered.filter((p) => !p.startsWith('lmz.access-token.')) });
      return new Response(`Upgrade Required: offer the '${WS_PROTOCOL}' subprotocol`, { status: 426 });
    }

    // Extract verified JWT from Authorization header (set by auth hooks)
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      log.warn('WebSocket upgrade rejected: missing Authorization Bearer header');
      return new Response('Unauthorized: missing identity', { status: 401 });
    }

    // Decode JWT payload (no verification needed — Worker hooks already verified)
    const jwtToken = authHeader.slice(7); // Strip 'Bearer '
    let sub: string;
    let jwtPayload: Record<string, unknown>;
    try {
      const payloadB64 = jwtToken.split('.')[1];
      const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
      jwtPayload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
      sub = jwtPayload.sub as string;
    } catch (e) {
      log.warn('Failed to decode JWT from Authorization header');
      return new Response('Unauthorized: invalid token', { status: 401 });
    }

    if (!sub) {
      log.warn('WebSocket upgrade rejected: JWT missing sub claim');
      return new Response('Unauthorized: missing identity', { status: 401 });
    }

    // Extract routing headers (set by routeDORequest)
    const hostInstanceName = request.headers.get('X-Lumenize-DO-Instance-Name-Or-Id') ?? undefined;
    const bindingName = request.headers.get('X-Lumenize-DO-Binding-Name') ?? undefined;

    if (!hostInstanceName) {
      log.warn('WebSocket upgrade rejected: missing instance name header');
      return new Response('Forbidden: missing instance name', { status: 403 });
    }

    // A host node names each Client by its own name and the Client's id.
    const instanceName = clientNameFromPath(request, hostInstanceName);
    if (instanceName instanceof Response) {
      log.warn('WebSocket upgrade rejected: the path names no single client id', { hostInstanceName });
      return instanceName;
    }

    if (!bindingName) {
      log.warn('WebSocket upgrade rejected: missing binding name header');
      return new Response('Forbidden: missing binding name', { status: 403 });
    }

    // Delegate instance name validation + optional additional claims to hook
    const hookResult = this.#host.onBeforeAccept(instanceName, sub, jwtPayload);

    if (hookResult instanceof Response) {
      return hookResult;
    }

    // Auto-include all JWT payload fields; hook result (if Record) merges on top
    const claims: Record<string, unknown> = { ...jwtPayload, ...(hookResult ?? {}) };

    // Determine if client needs to (re)establish subscriptions
    const subscriptionRequired = this.#isSubscriptionRequired(instanceName);

    // Accept WebSocket with hibernation support
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Store verified identity in WebSocket attachment — plus the HTTP facts of THIS upgrade, which
    // become `callContext.originRequest` on every call the connection originates. Connection-scoped
    // by construction: a reconnect re-runs this handler and rebuilds the snapshot.
    const attachment: GatewayConnectionInfo = {
      sub,
      bindingName,
      instanceName,
      claims,
      originRequest: captureOriginRequest(request),
    };

    // Close this Client's existing sockets before accepting the new one: a second socket means the
    // Client reconnected, so the new connection supersedes the old.
    // This connection has been told about any loss, so the sockets it supersedes stop carrying it.
    for (const sock of this.#ctx.getWebSockets(instanceName)) {
      const old = sock.deserializeAttachment() as GatewayConnectionInfo | null;
      if (old?.subscriptionsLost) {
        const { subscriptionsLost: _told, ...rest } = old;
        writeAttachment(sock, rest);
      }
      sock.close(WS_CLOSE_SUPERSEDED, 'Superseded by new connection');
    }

    // Tagged with the Client's name, so every later lookup can find this Client's socket alone.
    this.#ctx.acceptWebSocket(server, [instanceName]);
    // Keepalive: auto-pong the client's heartbeat ping at the runtime level — keeps a long, quiet turn
    // from idle-dropping the socket, WITHOUT waking this hibernated DO (no per-ping wall-clock cost).
    this.#ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG));
    server.serializeAttachment(attachment);

    // The Client is back: release the calls waiting for it, and end its grace period.
    this.#endGracePeriod(instanceName);

    // Send connection status immediately after accepting
    // No complex types, use JSON.stringify directly
    const statusMessage: ConnectionStatusMessage = {
      type: GatewayMessageType.CONNECTION_STATUS,
      subscriptionRequired,
      address: addressOf({ bindingName, instanceName }),
    };
    server.send(JSON.stringify(statusMessage));

    // A call still waiting for this Client's answer went down a socket that is gone or going, a
    // supersede's or a dropped one's. Sent again here, under its own `callId`, after the host's
    // passage check against THIS socket's attachment, so a rotation or a blip costs no answer and
    // no 4408. Expiry needs no check: this socket's token was verified at the upgrade just now. The
    // Client answers a repeat from its record of recent answers without running the handler again.
    this.#resendPendingCalls(instanceName, server, attachment);

    log.info('WebSocket connection accepted', {
      sub,
      instanceName,
      subscriptionRequired,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'Sec-WebSocket-Protocol': WS_PROTOCOL,
      },
    });
  }

  /** A message from a Client's socket — the host's `webSocketMessage`. */
  async receiveMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const log = debug('lmz.mesh.ClientGateway.receiveMessage');

    // Only handle string messages (JSON)
    if (typeof message !== 'string') {
      log.warn('Received non-string message, ignoring');
      return;
    }

    // Check token expiration
    const attachment = ws.deserializeAttachment() as GatewayConnectionInfo | null;
    const tokenExp = attachment?.claims?.exp as number | undefined;
    if (tokenExp && tokenExp < Date.now() / 1000) {
      log.warn('Token expired, closing connection');
      ws.close(4401, 'Token expired');
      // Started here, as at the Gateway's other 4401: a push arriving before the Client's close
      // echo waits for its reconnect instead of finding no socket and no grace period.
      this.#startGracePeriod(attachment!.instanceName);
      return;
    }

    let parsed: GatewayMessage;
    try {
      // Use JSON.parse - chain is already preprocessed by client, keep it that way
      parsed = JSON.parse(message) as GatewayMessage;
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
   * A Client's socket closed — the host's `webSocketClose`. Starts that Client's grace period,
   * unless a new connection superseded the socket.
   */
  socketClosed(ws: WebSocket, code: number, reason: string): void {
    const log = debug('lmz.mesh.ClientGateway.socketClosed');
    const instanceName = this.#ctx.getTags(ws)[0];
    log.info('WebSocket closed', { code, reason, instanceName });

    // Skip the grace period for superseded connections — a new connection already exists — and
    // for a late close while the Client is connected again.
    if (code === WS_CLOSE_SUPERSEDED || instanceName === undefined || this.#activeSocket(instanceName)) {
      return;
    }

    this.#startGracePeriod(instanceName);
    if ((ws.deserializeAttachment() as GatewayConnectionInfo | null)?.subscriptionsLost) {
      this.#gracePeriods.get(instanceName)!.lost = true;
    }
    // The marker a test waits on to know the close was processed before it reconnects.
    log.debug('grace period started', { instanceName, gracePeriodMs: this.#gracePeriodMs });
  }

  /** A Client's socket errored — the host's `webSocketError`. */
  socketErrored(ws: WebSocket, error: unknown): void {
    debug('lmz.mesh.ClientGateway.socketErrored').error('WebSocket error', { error });
  }

  /**
   * Close every Client socket the host holds with `code`, as a host about to be deleted does with
   * `WS_CLOSE_GONE`, so each Client hears why rather than seeing its socket drop. A socket is a
   * Client's when it carries the Client's name as its tag, which every socket this half accepts does.
   */
  closeAll(code: number, reason: string): void {
    for (const ws of this.#ctx.getWebSockets()) {
      if (this.#ctx.getTags(ws)[0] === undefined) continue;
      try { ws.close(code, reason); } catch { /* already closing */ }
    }
  }

  /**
   * A node's call to a Client — the host's `__executeOperation`. Acks once the envelope's version
   * checks out, before it looks for a socket, as a node acks on admission. Everything after the ack
   * runs under `ctx.waitUntil` and ends in a fire-back to the node's `__handleResponse` with the
   * node's own continuation filled: the Client's answer, or why there is none. The Client never
   * sees the continuation.
   */
  async executeOperation(envelope: CallEnvelope): Promise<{ $ack: true } | { $error: any }> {
    if (!envelope.version || envelope.version !== 1) {
      return { $error: preprocess(new Error(`Unsupported RPC envelope version: ${envelope.version}`)) };
    }

    // The Client this call is addressed to. Every envelope the mesh builds names its callee; one
    // that does not cannot be matched to a socket.
    const callee = envelope.metadata?.callee;
    if (!callee?.instanceName) {
      return { $error: preprocess(new Error('Call to a client names no client: the envelope has no metadata.callee.instanceName')) };
    }

    this.#ctx.waitUntil(this.#deliverToClient(envelope, callee.bindingName, callee.instanceName));
    return { $ack: true };
  }

  /**
   * Deliver a node's call to its Client and fire the outcome back. Passage and expiry are checked
   * immediately before the send, against the attachment of the socket it goes down, after any wait
   * for a reconnect. Never rejects: every outcome becomes the node's answer.
   */
  async #deliverToClient(envelope: CallEnvelope, bindingName: string, instanceName: string): Promise<void> {
    // The Client answers as the fire-back's last hop. `ClientGateway` writes the type, since the
    // envelope types its callee as a DO; the names come from the socket's attachment once there is
    // one, and from the envelope until then.
    let answerer: NodeIdentity = { type: 'LumenizeClient', bindingName, instanceName };
    let outcome: unknown;
    let isError = false;
    try {
      const { ws, attachment } = await this.#socketToSendOn(instanceName);
      answerer = { type: 'LumenizeClient', bindingName: attachment.bindingName, instanceName: attachment.instanceName };
      this.#host.onBeforeCallToClient(envelope, attachment);
      outcome = await this.#forwardToClient(ws, envelope, instanceName);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
      isError = true;
      // Only the Gateway's own verdict carries this name: a Client's is renamed on the way in.
      if ((outcome as Error).name === 'ClientDisconnectedError') this.#subscriptionLost(instanceName);
    }
    // `originAuth` and `originRequest` are the envelope's, never the attachment's: the answer goes
    // back on the node's chain, under the node's claims.
    await fireResponse(
      answerer, this.#env, envelope.callContext, envelope.response, outcome, isError,
      'ClientGateway', `${answerer.bindingName}/${answerer.instanceName}`,
    );
  }

  /**
   * The Client's open socket and its attachment, waiting within the grace period when it has none.
   * A socket whose token has expired is closed with 4401, and the wait starts at that close: the
   * Client refreshes and comes back on a new socket, whose attachment is the one returned. A Client
   * whose session was revoked cannot refresh, so it never comes back, and the wait ends in
   * `ClientDisconnectedError`.
   */
  async #socketToSendOn(instanceName: string): Promise<{ ws: WebSocket; attachment: GatewayConnectionInfo }> {
    const log = debug('lmz.mesh.ClientGateway.deliverToClient');
    for (;;) {
      let ws = this.#activeSocket(instanceName);
      if (!ws) {
        if (!this.#inGracePeriod(instanceName)) throw new ClientDisconnectedError('Client is not connected');
        log.info('Client disconnected, waiting for reconnect during grace period', { instanceName });
        await this.#waitForReconnect(instanceName);
        ws = this.#activeSocket(instanceName);
        if (!ws) throw new ClientDisconnectedError('Client did not reconnect in time');
      }
      const attachment = ws.deserializeAttachment() as GatewayConnectionInfo | null;
      if (!attachment) {
        log.error('Null attachment on a call to its Client');
        throw new ClientDisconnectedError('Connection not properly initialized');
      }
      const tokenExp = attachment.claims?.exp as number | undefined;
      if (!tokenExp || tokenExp >= Date.now() / 1000) return { ws, attachment };
      log.warn('Token expired, closing connection to wait for the reconnect', { instanceName });
      ws.close(4401, 'Token expired');
      this.#startGracePeriod(instanceName);
    }
  }

  /**
   * The fire-back entry: a node fires a Client's filled result handler continuation back here, as
   * it would to any caller's `__handleResponse`, and this sends it down to the Client named in
   * `metadata.callee`, on whatever socket the Client is on now, so an answer outlives a reconnect.
   * With no socket inside the grace period it acks, and waits for one under `ctx.waitUntil`;
   * otherwise the answer is dropped, and logged under its `callId`.
   */
  async receiveFireBack(envelope: CallEnvelope): Promise<{ $ack: true }> {
    const log = debug('lmz.mesh.ClientGateway.receiveFireBack');
    const clientInstanceName = envelope.metadata?.callee?.instanceName;
    const { callId, loadId } = envelope;
    if (!clientInstanceName || callId === undefined || loadId === undefined) {
      log.warn('fire-back names no Client, callId or loadId — dropping it', { callId, clientInstanceName });
      return { $ack: true };
    }

    const message: ResponseMessage = {
      type: GatewayMessageType.RESPONSE,
      callId,
      loadId,
      chain: envelope.chain,
      callContext: {
        callChain: envelope.callContext.callChain,
        originAuth: envelope.callContext.originAuth,
      },
    };

    // Deliver on the CURRENT socket (re-resolved — NOT the socket the call left on).
    const ws = this.#activeSocket(clientInstanceName);
    if (ws) {
      ws.send(JSON.stringify(message));
    } else if (this.#inGracePeriod(clientInstanceName)) {
      this.#ctx.waitUntil(this.#sendAfterReconnect(clientInstanceName, message));
    } else {
      log.warn('no socket for the client\'s answer — dropping it', { callId, clientInstanceName });
    }
    return { $ack: true };
  }

  /** Send a Client's answer once it reconnects within its grace period, or drop it and say so. */
  async #sendAfterReconnect(clientInstanceName: string, message: ResponseMessage): Promise<void> {
    const log = debug('lmz.mesh.ClientGateway.receiveFireBack');
    try {
      await this.#waitForReconnect(clientInstanceName);
    } catch {
      log.warn('client did not reconnect within grace — dropping its answer', { callId: message.callId, clientInstanceName });
      return;
    }
    const ws = this.#activeSocket(clientInstanceName);
    if (ws) ws.send(JSON.stringify(message));
    else log.warn('no socket for the client\'s answer — dropping it', { callId: message.callId, clientInstanceName });
  }

  // ============================================
  // Call handling
  // ============================================

  /**
   * Handle a call from the client to a mesh node
   */
  async #handleClientCall(
    ws: WebSocket,
    message: CallMessage,
    attachment: GatewayConnectionInfo | null
  ): Promise<void> {
    const log = debug('lmz.mesh.ClientGateway.handleClientCall');
    const { callId, loadId, binding, instance, chain, handler, onErrorOnly } = message;

    // Guard: attachment must be present (set during WebSocket accept)
    if (!attachment) {
      log.error('Null attachment in #handleClientCall — closing WebSocket');
      ws.close(1011, 'Connection not properly initialized');
      return;
    }

    // The Client wrote its continuation, and it comes back to it alone, so the only harm a bad one
    // can do is to that Client. It is still checked before anything is dispatched: one the
    // executor cannot run, or one that does not end in the call an answer is filled into, would
    // otherwise be carried to the node and back for nothing.
    const refusal = refuseContinuation(handler);
    if (refusal) {
      log.warn('refused a call whose result handler continuation is malformed', { callId, binding, instance, refusal });
      return;
    }

    // Build origin identity from VERIFIED sources (WebSocket attachment)
    // This replaces whatever the client sent - Gateway is the trust boundary
    const verifiedOrigin: NodeIdentity = {
      type: 'LumenizeClient',
      bindingName: attachment.bindingName,
      instanceName: attachment.instanceName,
    };

    // Build originAuth from VERIFIED sources (WebSocket attachment)
    const originAuth: OriginAuth = {
      sub: attachment.sub,
      claims: attachment.claims,
    };

    // Build callContext - the chain is the verified origin ALONE. A client's frame carries no
    // chain (`CallMessage` has no field for one), and one a hostile frame adds is never read. A
    // receiver reads the chain to know who called: a subscribe stores `addressOf(callChain[0])` as
    // the address to push to, and `MeshClient.onBeforeCall` refuses a push whose last hop is
    // another client. A hop a client could append would be a caller it chose.
    // originRequest comes from the ATTACHMENT (snapshotted at upgrade), never from the client's
    // message — the same trust rule as originAuth: the Gateway is the boundary.
    const baseContext: CallContext = {
      callChain: [verifiedOrigin],
      originAuth,
      originRequest: attachment.originRequest,
    };

    // Determine callee type for metadata
    const calleeType: NodeType = instance ? 'LumenizeDO' : 'LumenizeWorker';
    // Whichever road a refusal takes, the Client's handler hears it from the target it called.
    const refusedBy: NodeIdentity = { type: calleeType, bindingName: binding, instanceName: instance };

    try {
      // Let the host enrich the context
      const callContext = this.#host.onBeforeCallToMesh(baseContext, attachment, callId);

      // The descriptor is the Gateway's to write: `kind` and `returnAddr` come from the socket's
      // attachment, so a Client can aim its continuation only at itself, and the Client supplies
      // only the continuation. `attachment.bindingName` is this Gateway's own binding (from the
      // routing header at WS accept), so the node's fire-back reaches this Gateway, which hands it
      // down to the Client's current socket.
      const clientIdentity: NodeIdentity = {
        type: 'LumenizeClient',
        bindingName: attachment.bindingName,
        instanceName: attachment.instanceName,
      };
      const response: EnvelopeResponse = {
        kind: 'mesh',
        returnAddr: clientIdentity,
        handler,
        ...(onErrorOnly ? { onErrorOnly: true } : {}),
        callId,
        loadId,
      };
      const envelope: CallEnvelope = {
        version: 1,
        chain, // Already preprocessed by client - pass through
        callContext,
        metadata: {
          caller: {
            type: 'LumenizeClient',
            bindingName: attachment.bindingName,
            instanceName: attachment.instanceName,
          },
          callee: {
            type: calleeType,
            bindingName: binding,
            instanceName: instance,
          },
        },
        response,
      };

      // Early ack: the callee acks on admission, BEFORE the chain runs, and its answer arrives
      // later at our __handleResponse door. A refusal at the ack takes the same road back: the
      // Client's continuation, filled with the Error, with the node that refused as the last hop.
      // A call to the host node itself, or to another Client it hosts, runs in place through the
      // host's own request door, so it passes the same checks an RPC would and costs no request.
      let ack: any;
      try {
        if (this.#isHostNode(binding, instance, attachment)) {
          log.debug('ran in place', { callId, binding, instance });
          ack = await this.#host.__executeOperation(envelope);
        } else {
          ack = await resolveStub(this.#env, binding, instance).__executeOperation(envelope);
        }
      } catch (error) {
        log.error('Call dispatch failed', { callId, binding, instance, error });
        ack = { $error: preprocess(error) };
      }
      if (ack && '$error' in ack) {
        this.#refuseToClient(ws, message, callContext, refusedBy, postprocess(ack.$error));
      }

    } catch (error) {
      log.error('Call dispatch failed', { callId, binding, instance, error });
      this.#refuseToClient(ws, message, baseContext, refusedBy, error);
    }
  }

  /**
   * Whether a Client's call to (`binding`, `instance`) is for the node hosting it, its own name or
   * another Client's on it. Such a call runs in place, through the host's own request door.
   */
  #isHostNode(binding: string, instance: string | undefined, attachment: GatewayConnectionInfo): boolean {
    return instance !== undefined
      && binding === attachment.bindingName
      && hostInstanceOf(instance) === hostInstanceOf(attachment.instanceName);
  }

  /**
   * Answer a Client's call that was refused before its node ran it: fill the Client's own
   * continuation with the Error and send it down as a `response`, as a fire-back would arrive.
   * The target it called is the last hop, so the handler's `callee` names it, whether that node
   * refused the call or the Gateway could not dispatch to it.
   */
  #refuseToClient(
    ws: WebSocket, message: CallMessage, callContext: CallContext,
    refusedBy: NodeIdentity, error: unknown,
  ): void {
    const outcome = error instanceof Error ? error : new Error(String(error));
    const callee = `${refusedBy.bindingName}${refusedBy.instanceName ? `/${refusedBy.instanceName}` : ''}`;
    const response: ResponseMessage = {
      type: GatewayMessageType.RESPONSE,
      callId: message.callId,
      loadId: message.loadId,
      chain: fillHandler(message.handler, outcome, callee),
      callContext: {
        callChain: [...callContext.callChain, refusedBy],
        originAuth: callContext.originAuth,
      },
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * Handle a response from the client to an incoming call
   */
  #handleIncomingCallResponse(message: IncomingCallResponseMessage): void {
    const { callId, success, result, error } = message;

    const pending = this.#pendingCalls.get(callId);
    if (!pending) {
      debug('lmz.mesh.ClientGateway.handleIncomingCallResponse').warn('Received response for unknown call', { callId });
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.#pendingCalls.delete(callId);

    // Decoded inside a try, after the call is taken off the pending list: an answer that will not
    // decode still settles the call, so the node hears the decode error rather than nothing.
    let decoded: unknown;
    try {
      decoded = postprocess(success ? result : error);
    } catch (decodeError) {
      pending.reject(decodeError instanceof Error ? decodeError : new Error(String(decodeError)));
      return;
    }
    if (success) {
      pending.resolve(renameClientDisconnected(decoded));
    } else {
      pending.reject(renameClientDisconnected(decoded instanceof Error ? decoded : new Error(String(decoded))));
    }
  }

  /**
   * Send a node's call down to its Client and wait for the answer, up to the call timeout. A
   * Client that misses it is answered `ClientDisconnectedError` and its socket is closed with 4408,
   * which tells it to re-subscribe: a reaper drops a row on that error.
   */
  async #forwardToClient(ws: WebSocket, envelope: CallEnvelope, instanceName: string): Promise<any> {
    const callId = crypto.randomUUID();

    // Build incoming call message for client
    // Chain is already preprocessed (the caller's call() preprocesses for consistency)
    // The context goes down field by field, never spread, so nothing reaches a client unless it is
    // named here. `originRequest` is left behind: it is the ORIGIN's IP, location and browser, and a
    // push that inherits a writer's chain (`lmz.broadcast` with `{ newChain: false }`) would hand them to every
    // subscriber.
    // `originAuth` goes down, so an app's own guards on the client can read the caller's claims.
    const message: IncomingCallMessage = {
      type: GatewayMessageType.INCOMING_CALL,
      callId,
      chain: envelope.chain, // Already preprocessed by caller
      callContext: {
        callChain: envelope.callContext.callChain,  // Plain strings - no preprocessing
        originAuth: envelope.callContext.originAuth,  // From JWT - no preprocessing
      },
    };

    const frame = JSON.stringify(message);
    return new Promise<any>((resolve, reject) => {
      // The timer only times the wait out: `ctx.waitUntil` is what holds the Gateway.
      const timeout = setTimeout(() => {
        this.#pendingCalls.delete(callId);
        reject(new ClientDisconnectedError('Client call timed out'));
      }, this.#clientCallTimeoutMs);
      this.#pendingCalls.set(callId, { resolve, reject, timeout, instanceName, envelope, frame });
      ws.send(frame);
    });
  }

  /**
   * The Gateway answered a node `ClientDisconnectedError` for this Client, and a reaper drops the
   * Client's subscriber row on that. A socket still open is closed with 4408, so a paused tab
   * reconnects when it wakes, and the loss is recorded on the grace period and on every socket the
   * Client holds. The Client's next connection is then told `subscriptionRequired: true` however
   * soon or late it comes back, and whether or not it ever saw the close: its socket may have been
   * gone before the Gateway gave up, or the close frame lost. That report is the one signal the
   * Client acts on.
   */
  #subscriptionLost(instanceName: string): void {
    // The mark also rides each socket the Client still holds, open or closing, so it outlives the
    // grace period and an eviction, and a late close carries it into the record it starts.
    for (const sock of this.#ctx.getWebSockets(instanceName)) {
      const attachment = sock.deserializeAttachment() as GatewayConnectionInfo | null;
      if (attachment && !attachment.subscriptionsLost) writeAttachment(sock, { ...attachment, subscriptionsLost: true });
    }
    const ws = this.#activeSocket(instanceName);
    if (ws) {
      ws.close(WS_CLOSE_TIMED_OUT, 'Client did not answer in time');
      this.#startGracePeriod(instanceName);
    }
    const grace = this.#gracePeriods.get(instanceName);
    if (grace) grace.lost = true;
  }

  /**
   * Send every call still waiting for `instanceName`'s answer down `ws`, its new socket. Each send
   * first passes the host's check against this socket's attachment; one refused there is answered
   * with the refusal instead.
   */
  #resendPendingCalls(instanceName: string, ws: WebSocket, attachment: GatewayConnectionInfo): void {
    for (const [callId, pending] of this.#pendingCalls) {
      if (pending.instanceName !== instanceName) continue;
      try {
        this.#host.onBeforeCallToClient(pending.envelope, attachment);
      } catch (error) {
        clearTimeout(pending.timeout);
        this.#pendingCalls.delete(callId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      ws.send(pending.frame);
    }
  }

  // ============================================
  // Connection state
  // ============================================

  /** The Client's open socket, if it has one */
  #activeSocket(instanceName: string): WebSocket | null {
    return this.#ctx.getWebSockets(instanceName).find(s => s.readyState === WebSocket.OPEN) ?? null;
  }

  /**
   * Whether a connecting Client must (re)establish its subscriptions.
   *
   * True when a delivery to the Client failed since its last connection was told, whether the
   * grace period or a socket it still holds records it. Otherwise false when the connection
   * supersedes one this Client still holds, or when the Client is back inside its grace period. True in every other case: a first connection, a reconnect after the grace period, and a
   * reconnect to a host with no record of the Client, such as one evicted since the Client's socket
   * closed.
   */
  #isSubscriptionRequired(instanceName: string): boolean {
    if (this.#gracePeriods.get(instanceName)?.lost) return true;
    const sockets = this.#ctx.getWebSockets(instanceName);
    if (sockets.some((s) => (s.deserializeAttachment() as GatewayConnectionInfo | null)?.subscriptionsLost)) return true;
    if (sockets.length > 0) return false;
    return !this.#inGracePeriod(instanceName);
  }

  // ============================================
  // Grace period
  // ============================================

  #inGracePeriod(instanceName: string): boolean {
    return this.#gracePeriods.has(instanceName);
  }

  #startGracePeriod(instanceName: string): void {
    const gracePeriodMs = this.#gracePeriodMs;
    const existing = this.#gracePeriods.get(instanceName);
    if (existing) clearTimeout(existing.timer);
    this.#gracePeriods.set(instanceName, {
      // The timer only ENDS the grace period. Each wait in it was handed to `ctx.waitUntil` by
      // whoever started it, so nothing here relies on a timer to keep the host resident.
      timer: setTimeout(() => this.#expireGracePeriod(instanceName), gracePeriodMs),
      waiters: existing?.waiters ?? [],
      lost: existing?.lost ?? false,
    });
  }

  /** The Client reconnected: release every call waiting for it */
  #endGracePeriod(instanceName: string): void {
    const grace = this.#gracePeriods.get(instanceName);
    if (!grace) return;
    clearTimeout(grace.timer);
    this.#gracePeriods.delete(instanceName);
    for (const waiter of grace.waiters) waiter.resolve();
  }

  /** The grace period ran out: fail every call waiting for the Client */
  #expireGracePeriod(instanceName: string): void {
    const grace = this.#gracePeriods.get(instanceName);
    if (!grace) return;
    this.#gracePeriods.delete(instanceName);
    debug('lmz.mesh.ClientGateway.expireGracePeriod').info('Grace period expired', { instanceName });
    const error = new ClientDisconnectedError('Client did not reconnect within grace period');
    for (const waiter of grace.waiters) waiter.reject(error);
  }

  /** Wait for the Client to reconnect within its grace period */
  #waitForReconnect(instanceName: string): Promise<void> {
    const grace = this.#gracePeriods.get(instanceName);
    if (!grace) {
      return Promise.reject(new ClientDisconnectedError('Client is not connected and no grace period active'));
    }
    return new Promise((resolve, reject) => {
      grace.waiters.push({ resolve, reject });
    });
  }
}

/**
 * A hosted Client's name: its host's instance name, a `/`, and the one path segment after that name,
 * which is the Client's id. `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa` names
 * `acme.crm.tenant1/alice.9f2c41aa`. A path whose second-to-last segment is not the host's name names
 * no single id, so a missing id and two ids are both refused, as is an id that decodes to hold a `/`
 * or makes a name longer than a tag may be.
 */
function clientNameFromPath(request: Request, hostInstanceName: string): string | Response {
  let segments: string[];
  try {
    segments = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return new Response('Bad Request: the upgrade path does not decode', { status: 400 });
  }
  const id = segments.at(-1);
  if (segments.length < 2 || segments.at(-2) !== hostInstanceName || !id || id.includes('/')) {
    return new Response('Bad Request: the upgrade path names no single client id', { status: 400 });
  }
  const name = `${hostInstanceName}/${id}`;
  if (name.length > MAX_TAG_LENGTH) {
    return new Response(`Bad Request: a client's name is at most ${MAX_TAG_LENGTH} characters`, { status: 400 });
  }
  return name;
}

/**
 * Rewrite a socket's attachment. A socket already closed may refuse the write, and what it carried
 * no longer matters once it is gone, so a refusal is logged and passed over.
 */
function writeAttachment(ws: WebSocket, attachment: GatewayConnectionInfo): void {
  try {
    ws.serializeAttachment(attachment);
  } catch (error) {
    debug('lmz.mesh.ClientGateway.writeAttachment').warn('a closed socket refused its attachment', { error });
  }
}

/**
 * The name `ClientDisconnectedError` is the Gateway's verdict that a Client is gone, and a reaper
 * drops the subscriber row of the Client it hears it from. So a Client's own answer carrying that
 * name, returned or thrown, is renamed before it fills the node's continuation, and only the
 * Gateway can say a Client is gone. The original name stays at the front of the message.
 */
function renameClientDisconnected<T>(value: T): T {
  if (value instanceof Error && value.name === 'ClientDisconnectedError') {
    value.message = `${value.name}: ${value.message}`;
    value.name = 'Error';
  }
  return value;
}

/**
 * Why a Client's result handler continuation cannot travel, or `undefined` when it can: it must be
 * a chain the executor accepts, and it must end in the apply its answer is filled into.
 */
function refuseContinuation(handler: unknown): string | undefined {
  let chain: OperationChain;
  try {
    chain = postprocess(handler as any) as OperationChain;
    validateOperationChain(chain);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (chain.at(-1)?.type !== 'apply') {
    return 'Invalid result handler continuation: it must end in a call, which its answer is filled into';
  }
  return undefined;
}

/**
 * The curated snapshot of an upgrade request that becomes `callContext.originRequest`.
 *
 * `cf` is a verbatim FIELD PICK, never the whole object — `request.cf` also carries
 * entitlement-gated and precision-creep fields the wire shape deliberately excludes (`OriginCf`'s
 * JSDoc lists them). `origin` is taken from the request URL — what routing delivered — and never
 * from a client header, which is what licenses building an emailed absolute URL from it.
 * Header-derived fields are omitted rather than set `undefined`, to keep the attachment small.
 */
function captureOriginRequest(request: Request): OriginRequest {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const pick: OriginCf | undefined = cf ? {
    continent: cf.continent, country: cf.country, isEUCountry: cf.isEUCountry,
    latitude: cf.latitude, longitude: cf.longitude,
    region: cf.region, regionCode: cf.regionCode, city: cf.city,
    colo: cf.colo, timezone: cf.timezone,
  } : undefined;
  const ip = request.headers.get('CF-Connecting-IP');
  const userAgent = request.headers.get('User-Agent');
  const acceptLanguage = request.headers.get('Accept-Language');
  return {
    ...(pick ? { cf: pick } : {}),
    ...(ip ? { ip } : {}),
    origin: new URL(request.url).origin,
    ...(userAgent ? { userAgent } : {}),
    ...(acceptLanguage ? { acceptLanguage } : {}),
  };
}

/**
 * BenchDO — the one Durable Object both arms call, so only where a client's socket lands differs.
 *
 * - **Arm A, `gateway`.** Each client connects to its own `LumenizeClientGateway`, which forwards a
 *   call here over Workers RPC. This object acks, runs the chain, and fires the result back to the
 *   Gateway, which writes it to the socket. That is mesh as it ships today.
 * - **Arm B, `hosted`.** Each client connects HERE. The socket handlers below do the work a Gateway
 *   does — build the call's context from the socket's verified attachment, then run the chain — and
 *   answer with `ws.send`, with no RPC either way.
 *
 * Arm B runs the same dispatch steps mesh's `executeEnvelope` runs: decode the chain, stamp
 * `callee`, run `onBeforeCall` as the guard, then `executeOperationChain` with the `@mesh()` check
 * on. It reaches mesh internals by relative path because the package does not export them; this is
 * a prototype of the capability, not a proposal for its API.
 *
 * Pushes model `tasks/mesh-calls-to-and-from-clients.md`'s D11 on the hosting side: one pending
 * entry and one 30 s timer per push, cleared when the client answers. Today's Gateway does the same
 * per push in `#forwardToClient`, so the bookkeeping is in both arms.
 */
import { LumenizeDO, mesh, getOperationChain, GatewayMessageType } from '@lumenize/mesh';
import type { CallContext } from '@lumenize/mesh';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { runWithCallContext } from '../../../packages/mesh/src/lmz-api';
import { executeOperationChain } from '../../../packages/mesh/src/ocan/execute';
import { WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG } from '../../../packages/mesh/src/ws-heartbeat';

/** What a hosted socket carries, mirroring the Gateway's `GatewayConnectionInfo`. */
interface HostedAttachment {
  sub: string;
  bindingName: string;
  instanceName: string;
  claims: Record<string, unknown>;
  originRequest: CallContext['originRequest'];
}

const CLIENT_ANSWER_TIMEOUT_MS = 30_000;

export class BenchDO extends LumenizeDO<Env> {
  /** Pushes awaiting the client's answer (D11's in-memory handler, reduced to its timer). */
  #pending = new Map<string, ReturnType<typeof setTimeout>>();

  onStart(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS writes (id INTEGER PRIMARY KEY, v INTEGER)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS subs (binding TEXT, instance TEXT, PRIMARY KEY (binding, instance))');
  }

  // ── The calls both arms make ───────────────────────────────────────────────────────────────

  /** No storage: the cost of the transport alone. */
  @mesh()
  echo(x: number): number {
    return x;
  }

  /** One SQL row per call, so each call carries a storage commit as a Star transaction does. */
  @mesh()
  write(x: number): number {
    this.ctx.storage.sql.exec('INSERT INTO writes (v) VALUES (?)', x);
    return x;
  }

  /**
   * About 2 ms of CPU plus one SQL row, standing in for a Star transaction's own work so the
   * throughput ratio is not read off near-empty calls. The loop's result is stored, so V8 cannot
   * drop it. Calibrated in Node on the driver's machine (2M iterations ≈ 1.8 ms); Cloudflare's
   * cores are likely slower, so read it as "a few milliseconds", not exactly two.
   */
  @mesh()
  heavy(x: number): number {
    let acc = x | 0;
    for (let i = 0; i < 2_000_000; i++) acc = (Math.imul(acc, 1103515245) + 12345) | 0;
    this.ctx.storage.sql.exec('INSERT INTO writes (v) VALUES (?)', acc);
    return x;
  }

  /** Records the caller's address as a subscriber, read from the chain the transport stamped. */
  @mesh()
  subscribe(): number {
    const caller = this.lmz.callContext.callChain.at(-1)!;
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO subs (binding, instance) VALUES (?, ?)', caller.bindingName, caller.instanceName,
    );
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM subs').one().n as number;
  }

  @mesh()
  clearSubscribers(): void {
    this.ctx.storage.sql.exec('DELETE FROM subs');
  }

  /** Pushes `handlePush(seq)` to every subscriber and returns how many it addressed. */
  @mesh()
  publish(seq: number): number {
    const rows = this.ctx.storage.sql.exec('SELECT binding, instance FROM subs').toArray() as
      Array<{ binding: string; instance: string }>;
    const remote = (this.ctn() as any).handlePush(seq);
    if (rows.length > 0 && rows[0].binding === 'BENCH_DO') {
      this.#pushToHostedSockets(rows, remote);
    } else {
      this.lmz.broadcast(
        rows.map((r) => ({ bindingName: r.binding, instanceName: r.instance })),
        remote,
        { onResult: (this.ctn() as any).onPushResult() },
      );
    }
    return rows.length;
  }

  /** Arm A's broadcast failures land here; no `@mesh()`, as a result handler needs none. */
  onPushResult(result?: unknown): void {
    if (result instanceof Error) console.log(`push failed: ${result.name}: ${result.message}`);
  }

  // ── Arm B: this object holds its clients' sockets ──────────────────────────────────────────

  onRequest(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const token = request.headers.get('Authorization')?.slice('Bearer '.length);
    const clientInstance = request.headers.get('X-Bench-Client');
    if (!token || !clientInstance) return new Response('Unauthorized', { status: 401 });
    const claims = decodeJwtPayload(token);
    const sub = claims.sub as string;
    if (!clientInstance.startsWith(`${sub}.`)) return new Response('Forbidden: identity mismatch', { status: 403 });

    for (const old of this.ctx.getWebSockets(clientInstance)) old.close(4409, 'Superseded by new connection');

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [clientInstance]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG));
    const attachment: HostedAttachment = {
      sub, bindingName: 'BENCH_DO', instanceName: clientInstance, claims,
      originRequest: {
        origin: new URL(request.url).origin,
        ip: request.headers.get('CF-Connecting-IP') ?? undefined,
        userAgent: request.headers.get('User-Agent') ?? undefined,
      },
    };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: GatewayMessageType.CONNECTION_STATUS, subscriptionRequired: true }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'lmz' } });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const attachment = ws.deserializeAttachment() as HostedAttachment | null;
    if (!attachment) { ws.close(1011, 'Connection not properly initialized'); return; }
    const exp = attachment.claims.exp as number | undefined;
    if (exp && exp < Date.now() / 1000) { ws.close(4401, 'Token expired'); return; }

    let parsed: any;
    try { parsed = JSON.parse(message); } catch { return; }

    if (parsed.type === GatewayMessageType.CALL) {
      await this.#hostedCall(ws, parsed, attachment);
    } else if (parsed.type === GatewayMessageType.INCOMING_CALL_RESPONSE) {
      const timer = this.#pending.get(parsed.callId);
      if (timer !== undefined) { clearTimeout(timer); this.#pending.delete(parsed.callId); }
    }
  }

  async webSocketClose(): Promise<void> {}

  /** What a Gateway's `#handleClientCall` plus the callee's `executeEnvelope` do, in one place. */
  async #hostedCall(ws: WebSocket, message: any, attachment: HostedAttachment): Promise<void> {
    const { callId, binding, instance, chain, expectsResult } = message;
    const answer = (success: boolean, payload: unknown) => {
      if (!expectsResult) return;
      ws.send(JSON.stringify(success
        ? { type: GatewayMessageType.CALL_RESPONSE, callId, success, result: payload }
        : { type: GatewayMessageType.CALL_RESPONSE, callId, success, error: payload }));
    };
    // A real host forwards a call addressed elsewhere; the benchmark only calls the host itself.
    if (binding !== 'BENCH_DO' || instance !== this.lmz.instanceName) {
      answer(false, preprocess(new Error('the prototype host serves only calls addressed to itself')));
      return;
    }

    let callContext: CallContext;
    let operationChain: any;
    try {
      operationChain = postprocess(chain);
      callContext = {
        callChain: [{ type: 'LumenizeClient', bindingName: attachment.bindingName, instanceName: attachment.instanceName }],
        originAuth: { sub: attachment.sub, claims: attachment.claims },
        originRequest: attachment.originRequest,
        state: {},
        callee: { type: this.lmz.type, bindingName: this.lmz.bindingName!, instanceName: this.lmz.instanceName },
      };
      runWithCallContext(callContext, () => { this.onBeforeCall(); });
    } catch (error) {
      answer(false, preprocess(error));
      return;
    }

    try {
      const outcome = await runWithCallContext(callContext, () =>
        executeOperationChain(operationChain, this, { requireMeshDecorator: true }));
      answer(true, preprocess(outcome));
    } catch (error) {
      answer(false, preprocess(error instanceof Error ? error : new Error(String(error))));
    }
  }

  /** Arm B's broadcast: one encoded chain, one `ws.send` per subscriber whose socket is here. */
  #pushToHostedSockets(rows: Array<{ instance: string }>, remote: unknown): void {
    const sockets = new Map<string, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const [tag] = this.ctx.getTags(ws);
      if (tag) sockets.set(tag, ws);
    }
    const chain = preprocess(getOperationChain(remote as any));
    const callContext = {
      callChain: [{ type: this.lmz.type, bindingName: this.lmz.bindingName, instanceName: this.lmz.instanceName }],
      state: preprocess({}),
    };
    for (const row of rows) {
      const ws = sockets.get(row.instance);
      if (!ws) continue; // a real host refuses here, and the broadcaster's reaper drops the row
      const callId = crypto.randomUUID();
      this.#pending.set(callId, setTimeout(() => this.#pending.delete(callId), CLIENT_ANSWER_TIMEOUT_MS));
      ws.send(JSON.stringify({ type: GatewayMessageType.INCOMING_CALL, callId, chain, callContext }));
    }
  }
}

/** The Worker gated the upgrade, so this only reads the payload, as the Gateway does. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payloadB64 = token.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
  return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
}

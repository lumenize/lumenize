/**
 * A raw Durable Object (no mesh) that burns a chosen amount of CPU per call, reached either over
 * its own hibernatable WebSockets or over Workers RPC, and that records its own evidence.
 *
 * Evidence it keeps, readable from `/stats/{instance}`:
 * - `boots` — how many times the constructor ran for this instance (a reset shows as +1).
 * - `bootId` — a random id per construction, also returned on every reply.
 * - `events` — every server-side `webSocketClose` / `webSocketError`, with code, reason and error.
 *
 * Burns, each `n` units repeated `reps` times in ONE synchronous event:
 * - `js`   — the `Math.imul` loop from gateway-vs-hosted's `heavy`; its speed depends on V8's JIT.
 * - `sql`  — a SQLite recursive CTE counting to `n`; native code, no JIT.
 * - `json` — `JSON.parse` of a ~100 KB string, `n` times; V8's C++ parser, no JIT.
 * - `echo` — nothing.
 *
 * Routes (every one gated by the shared secret: `x-bench-token` header, or for a WebSocket the
 * `bench.<token>` subprotocol):
 *   /ws/{instance}/{clientId}            → upgrade, socket held by the object
 *   /rpc/{instance}?kind=&n=&reps=       → Worker → `stub.work()` over RPC
 *   /stats/{instance}  /where/{instance}
 */
import { DurableObject } from 'cloudflare:workers';

type Kind = 'echo' | 'js' | 'sql' | 'json';

export class ProbeDO extends DurableObject<Env> {
  #bootId = crypto.randomUUID();
  #jsonText: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at TEXT, boot TEXT, kind TEXT, detail TEXT)',
    );
    const boots = ((ctx.storage.kv.get('boots') as number | undefined) ?? 0) + 1;
    ctx.storage.kv.put('boots', boots);
    this.#log('boot', `boot #${boots}`);
  }

  #log(kind: string, detail: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO events (at, boot, kind, detail) VALUES (?, ?, ?, ?)',
      new Date().toISOString(), this.#bootId, kind, detail,
    );
  }

  #burn(kind: Kind, n: number, reps: number): number {
    let r = 0;
    for (let k = 0; k < reps; k++) {
      if (kind === 'js') {
        let acc = (n + k) | 0;
        for (let i = 0; i < n; i++) acc = (Math.imul(acc, 1103515245) + 12345) | 0;
        r ^= acc;
      } else if (kind === 'sql') {
        r ^= this.ctx.storage.sql.exec(
          'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT max(x) AS m FROM c', n,
        ).one().m as number;
      } else if (kind === 'json') {
        this.#jsonText ??= JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, name: `item-${i}`, tags: ['a', 'b', 'c'], v: i * 1.5 })));
        for (let i = 0; i < n; i++) r ^= (JSON.parse(this.#jsonText) as unknown[]).length;
      }
    }
    return r;
  }

  work(kind: Kind, n: number, reps: number) {
    const r = this.#burn(kind, n, reps);
    return { bootId: this.#bootId, sockets: this.ctx.getWebSockets().length, r };
  }

  stats() {
    return {
      bootId: this.#bootId,
      boots: this.ctx.storage.kv.get('boots') as number,
      sockets: this.ctx.getWebSockets().length,
      events: this.ctx.storage.sql.exec('SELECT at, boot, kind, detail FROM events ORDER BY seq DESC LIMIT 80').toArray(),
    };
  }

  /** The colo this object runs in, from Cloudflare's trace endpoint (one outbound fetch). */
  async whereAmI() {
    const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
    return { bootId: this.#bootId, colo: /colo=(\w+)/.exec(text)?.[1] ?? '?' };
  }

  async fetch(request: Request): Promise<Response> {
    const clientId = request.headers.get('x-client-id') ?? 'anon';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [clientId]);
    server.serializeAttachment({ clientId });
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'bench' } });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const { id, kind, n, reps } = JSON.parse(message);
    const r = this.#burn(kind, n, reps ?? 1);
    ws.send(JSON.stringify({ id, bootId: this.#bootId, sockets: this.ctx.getWebSockets().length, r }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const { clientId } = (ws.deserializeAttachment() ?? {}) as { clientId?: string };
    this.#log('close', JSON.stringify({ clientId, code, reason, wasClean }));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const { clientId } = (ws.deserializeAttachment() ?? {}) as { clientId?: string };
    this.#log('error', JSON.stringify({ clientId, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    const secret = (env as unknown as Record<string, string | undefined>).BENCH_TOKEN;
    const offered = request.headers.get('x-bench-token')
      ?? (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim())
        .find((p) => p.startsWith('bench.'))?.slice('bench.'.length);
    if (!secret || offered !== secret) return new Response('Unauthorized', { status: 401 });

    const [, route, instance, clientId] = url.pathname.split('/');
    if (!instance) return new Response('Not Found', { status: 404 });
    const stub = env.PROBE.getByName(instance);

    if (route === 'ws') {
      const headers = new Headers(request.headers);
      headers.set('x-client-id', clientId ?? 'anon');
      return stub.fetch(new Request(request.url, { method: request.method, headers }));
    }
    if (route === 'rpc') {
      const q = url.searchParams;
      const out = await stub.work(q.get('kind') as Kind, Number(q.get('n') ?? 0), Number(q.get('reps') ?? 1));
      return Response.json(out);
    }
    if (route === 'stats') return Response.json(await stub.stats());
    if (route === 'where') return Response.json(await stub.whereAmI());
    return new Response('Not Found', { status: 404 });
  },
};

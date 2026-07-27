/**
 * Spike fixture for `createTestHarness()` — a minimal DO exercising exactly the surfaces the
 * spike asks about, and nothing else:
 *
 * - a SQLite table          → probed from Node via `getDurableObjectStorage().exec()`
 * - an in-memory counter    → proves `evictDurableObject()` really tears the instance down
 *                             (durable-objects.md forbids mutable instance state in real code;
 *                             here it IS the instrument)
 * - a hibernating WebSocket → probes `evictDurableObject(..., { webSockets: 'hibernate' })`
 * - a `console.log` marker  → probed from Node via `getLogs()`
 */
import { DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject<Env> {
  /** Deliberate mutable instance state — the evict detector. Never do this in real code. */
  #liveSince = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS Counters (id TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID`,
    );
    // getLogs() probe: a structured marker emitted on every cold construct.
    console.log(`[spike] Counter constructed incarnation=${this.#liveSince}`);
  }

  bump(id: string): { count: number; incarnation: string } {
    this.ctx.storage.sql.exec(
      `INSERT INTO Counters (id, count) VALUES (?, 1)
       ON CONFLICT(id) DO UPDATE SET count = count + 1`,
      id,
    );
    const count = [...this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT count FROM Counters WHERE id = ?`, id,
    )][0].count;
    return { count, incarnation: this.#liveSince };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      const pair = new WebSocketPair();
      // Hibernation API (not addEventListener) — required for the DO to survive eviction.
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const id = url.searchParams.get('id') ?? 'default';
    return Response.json({ ...this.bump(id), greeting: this.env.GREETING });
  }

  /** Hibernation handler — echoes the CURRENT incarnation so the driver can see a cold restore. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(JSON.stringify({ echo: String(message), incarnation: this.#liveSince }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/counter\/([^/]+)(\/ws)?$/);
    if (!match) return new Response('not found', { status: 404 });
    return env.COUNTER.get(env.COUNTER.idFromName(match[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;

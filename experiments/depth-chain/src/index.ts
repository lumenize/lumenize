import { DurableObject } from 'cloudflare:workers';

// Does Cloudflare's subrequest depth carry through a promise that a later WebSocket event
// resolves, as ClientGateway's `#deliverToClient` relies on, and does firing back from the
// answer's own event reset it? A `Node` calls a `Host` over RPC; the Host acks at once and, under
// `waitUntil`, sends a frame to a real WebSocket client and waits for its answer, which fires back
// to the Node, whose handler calls the Host again. Round after round, until something throws.
//
// mode `held`  — the fire-back is made by the code that awaited the answer (today's Gateway).
// mode `fresh` — the fire-back is made by the WebSocket event that carried the answer (option 1).
//
// `/pingpong` measures the limit itself: two objects calling each other, each call made from
// inside the handling of the last.

type Mode = 'held' | 'fresh';

const HOST = 'host';
const NODE = 'node';

export class Host extends DurableObject<Env> {
  #waiting = new Map<string, (answer: string) => void>();
  #fresh = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The Gateway's `executeOperation`: ack now, deliver later. */
  call(mode: Mode, round: number): { ack: true } {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) throw new Error('no client socket');
    const callId = crypto.randomUUID();
    if (mode === 'fresh') {
      this.#fresh.set(callId, round);
      ws.send(JSON.stringify({ callId }));
    } else {
      this.ctx.waitUntil(this.#deliverHeld(ws, callId, round));
    }
    return { ack: true };
  }

  async #deliverHeld(ws: WebSocket, callId: string, round: number): Promise<void> {
    const answer = await new Promise<string>((resolve) => {
      this.#waiting.set(callId, resolve);
      ws.send(JSON.stringify({ callId }));
    });
    await this.#fireBack(round, answer);
  }

  /** Fire the answer back to the Node; a failure is kept HERE, since another call from this
   *  context would fail the same way. */
  async #fireBack(round: number, answer: string): Promise<void> {
    try {
      await this.env.NODE.getByName(NODE).handleResponse(round, answer);
    } catch (e) {
      this.ctx.storage.kv.put('fireBackError', { round, error: (e as Error).message, at: new Date().toISOString() });
    }
  }

  result(): unknown {
    return this.ctx.storage.kv.get('fireBackError') ?? null;
  }

  reset(): void {
    this.ctx.storage.kv.delete('fireBackError');
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { callId } = JSON.parse(String(message)) as { callId: string };
    const held = this.#waiting.get(callId);
    if (held) { this.#waiting.delete(callId); held('answered'); return; }
    const round = this.#fresh.get(callId);
    if (round !== undefined) { this.#fresh.delete(callId); await this.#fireBack(round, 'answered'); }
  }

  async pong(n: number): Promise<number> {
    return await this.env.NODE.getByName(NODE).ping(n + 1);
  }
}

export class Node extends DurableObject<Env> {
  record(result: { round: number; error?: string; where?: string }): void {
    this.ctx.storage.kv.put('result', { ...result, at: new Date().toISOString() });
  }

  result(): unknown {
    return this.ctx.storage.kv.get('result') ?? null;
  }

  async start(mode: Mode, rounds: number): Promise<void> {
    this.ctx.storage.kv.put('plan', { mode, rounds });
    this.ctx.storage.kv.delete('result');
    await this.env.HOST.getByName(HOST).call(mode, 1);
  }

  /** The node's `__handleResponse`: the answer arrives, and the handler calls the host again. */
  async handleResponse(round: number, _answer: string): Promise<void> {
    const { mode, rounds } = this.ctx.storage.kv.get('plan') as { mode: Mode; rounds: number };
    this.ctx.storage.kv.put('result', { round, at: new Date().toISOString() });
    if (round >= rounds) return;
    try {
      await this.env.HOST.getByName(HOST).call(mode, round + 1);
    } catch (e) {
      this.record({ round, error: (e as Error).message, where: 'call' });
    }
  }

  async ping(n: number): Promise<number> {
    try {
      return await this.env.HOST.getByName(HOST).pong(n);
    } catch (e) {
      if ((e as Error).message.includes('depth')) return n;
      throw e;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return env.HOST.getByName(HOST).fetch(request);
    if (url.pathname === '/run') {
      const mode = url.searchParams.get('mode') === 'fresh' ? 'fresh' : 'held';
      await env.HOST.getByName(HOST).reset();
      await env.NODE.getByName(NODE).start(mode, Number(url.searchParams.get('rounds') ?? 40));
      return new Response('started\n');
    }
    if (url.pathname === '/result') {
      return Response.json({ node: await env.NODE.getByName(NODE).result(), host: await env.HOST.getByName(HOST).result() });
    }
    if (url.pathname === '/pingpong') {
      try {
        return Response.json({ reachedDepth: await env.NODE.getByName(NODE).ping(0) });
      } catch (e) {
        return Response.json({ error: (e as Error).message });
      }
    }
    return new Response('routes: /ws /run?mode=held|fresh&rounds=N /result /pingpong\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

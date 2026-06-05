import { DurableObject } from 'cloudflare:workers';

export class ProbeDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          'X-Probe-Fetch-Name': this.ctx.id.name ?? 'undefined',
          'X-Probe-Fetch-Id': this.ctx.id.toString(),
        },
      });
    }
    return new Response('not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): void {
    ws.send(JSON.stringify({
      name: this.ctx.id.name ?? null,
      id: this.ctx.id.toString(),
    }));
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): void {
    try { ws.close(code, wasClean ? 'ok' : 'error'); } catch {}
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {}
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/upgrade-by-name') {
      const name = url.searchParams.get('name');
      if (!name) return new Response('missing name', { status: 400 });
      const stub = env.PROBE_DO.getByName(name);
      const wsUrl = new URL(request.url);
      wsUrl.pathname = '/ws';
      return stub.fetch(wsUrl, request);
    }
    if (url.pathname === '/upgrade-by-id') {
      const idHex = url.searchParams.get('id');
      if (!idHex) return new Response('missing id', { status: 400 });
      const id = env.PROBE_DO.idFromString(idHex);
      const stub = env.PROBE_DO.get(id);
      const wsUrl = new URL(request.url);
      wsUrl.pathname = '/ws';
      return stub.fetch(wsUrl, request);
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

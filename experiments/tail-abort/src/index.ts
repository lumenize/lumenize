import { DurableObject } from 'cloudflare:workers';

// Does `wrangler tail` deliver the event of a Durable Object invocation that ends in
// `ctx.abort()`, when other work on the same object is still in flight? Found 2026-10-14: a Nebula
// Galaxy deleted mid-turn logged its teardown, Workers Issues recorded the invocation, and the
// tail never delivered it, while the same teardown on idle objects arrived every time.
//
// Each probe object first takes on one kind of in-flight work, then is killed by an RPC that logs a
// line and aborts, as `ScopedMeshDO.teardown` does:
//   idle      — nothing in flight
//   timer     — a `waitUntil` holding a 60 s timer, started by an earlier RPC
//   fetch     — a `waitUntil` holding a 25 s subrequest, as a streaming model call does
//   rpc       — an earlier RPC still awaiting a 25 s subrequest when the kill lands
//   socket    — a hibernatable WebSocket open on the object

const log = (tag: string, name: string) => console.log(JSON.stringify({ tag, name }));

export class Probe extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async hold(name: string, mode: string, slowUrl: string): Promise<void> {
    log('holding', name);
    if (mode === 'timer') this.ctx.waitUntil(new Promise((r) => setTimeout(r, 60_000)).then(() => log('timer done', name)));
    if (mode === 'fetch') this.ctx.waitUntil(fetch(slowUrl).then((r) => r.text()).then(() => log('fetch done', name)));
    if (mode === 'rpc') { await fetch(slowUrl).then((r) => r.text()); log('rpc done', name); }
  }

  async kill(name: string): Promise<void> {
    log('killing', name);
    await this.ctx.storage.deleteAll();
    await new Promise((r) => setTimeout(r, 0));
    this.ctx.abort('probe-abort');
  }

  webSocketMessage(): void {}
  webSocketClose(ws: WebSocket, code: number): void { ws.close(code === 1005 ? 1000 : code); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') ?? 'x';
    const stub = env.PROBE.getByName(name);
    if (url.pathname === '/slow') { await new Promise((r) => setTimeout(r, 25_000)); return new Response('slow\n'); }
    if (url.pathname === '/ws') return stub.fetch(request);
    if (url.pathname === '/hold') {
      const mode = url.searchParams.get('mode') ?? 'idle';
      const call = stub.hold(name, mode, `${url.origin}/slow`);
      if (mode === 'rpc') { ctx.waitUntil(call.catch(() => undefined)); return new Response('holding\n'); }
      await call;
      return new Response('held\n');
    }
    if (url.pathname === '/kill') {
      try { await stub.kill(name); return new Response('killed?\n'); } catch (e) { return new Response(`aborted: ${(e as Error).message}\n`); }
    }
    return new Response('routes: /hold?name=&mode= /kill?name= /ws?name= /slow\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

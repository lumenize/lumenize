import { DurableObject } from "cloudflare:workers";
import { routeDORequest, RouteOptions } from '@lumenize/utils';

export const ALLOWED_ORIGINS = [
  'https://example.com',
];

// Worker
export default {
  async fetch(request, env, ctx) {
    // Check origin
    // TODO: Uncomment to confirm origin checking
    // const origin = request.headers.get('Origin');
    // if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    //   return new Response('Origin missing or not allowed', { status: 403 });
    // }
    
    return (
      await routeDORequest(request, env) ||
      new Response("Not Found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

// Durable Object
export class MyDO extends DurableObject{
  constructor(readonly ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async sayHello(): Promise<string> {
    return "Hello, World!";
  }

  async #handleIncrement() {
    let count = (await this.ctx.storage.get<number>("count")) ?? 0;
    void this.ctx.storage.put("count", ++count);
    return count;
  }

  async #trackOperation(operationType: string, operationDetails: string) {
    const operations = (await this.ctx.storage.get<string[]>("operationsFromQueue")) ?? [];
    operations.push(`${operationType}-${operationDetails}`);
    await this.ctx.storage.put("operationsFromQueue", operations);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);    
    
    const operation = url.searchParams.get('op') || 'unknown';
    const delayMs = parseInt(url.searchParams.get('delay') || '0', 10);
    
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    await this.#trackOperation('fetch', operation);

    if (url.pathname.endsWith('/increment')) {
      const count = await this.#handleIncrement();
      return new Response(count.toString(), { 
        headers: { 'Content-Type': 'text/plain' } 
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      // Handle sub-protocol selection
      const requestedProtocols = request.headers.get('Sec-WebSocket-Protocol');
      const responseHeaders = new Headers();
      let selectedProtocol: string | undefined;
      if (requestedProtocols) {
        const protocols = requestedProtocols.split(',').map(p => p.trim());
        if (protocols.includes('correct.subprotocol')) {
          selectedProtocol = 'correct.subprotocol';
          responseHeaders.set('Sec-WebSocket-Protocol', selectedProtocol);
        }
      }
      
      const name = url.pathname.split('/').at(-1) ?? 'No name in path'
      
      // Collect all request headers for testing
      const headersObj: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      
      const attachment = { 
        name, 
        headers: headersObj
      };
      
      this.ctx.acceptWebSocket(server, [name]);
      server.serializeAttachment(attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders
      });
    }

    // Delegate to super.fetch() for unknown paths (e.g., testing endpoints)
    if (super.fetch) {
      return super.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }

  webSocketOpen(ws: WebSocket) {
    this.ctx.storage.kv.put("lastWebSocketOpen", Date.now());  // trying new sync KV API
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string' && message.startsWith('track-')) {
      await this.#trackOperation('message', message);
    }

    if (message === 'increment') {
      return ws.send((await this.#handleIncrement()).toString());
    }

    if (message === 'headers') {
      const webSockets = this.ctx.getWebSockets();
      const attachment = webSockets[0].deserializeAttachment();
      return ws.send(JSON.stringify(attachment.headers));
    }

    if (message === 'test-error') {
      throw new Error("Test error from DO");
    }

    if (message === 'test-server-close') {   
      return ws.close(4001, "Server initiated close for testing");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    await this.ctx.storage.put("lastWebSocketClose", new Date());
  }

  async webSocketError(ws: WebSocket, error: Error) {
    await this.ctx.storage.put("lastWebSocketError", { message: error.message, timestamp: Date.now() });
  }
};

import { DurableObject } from "cloudflare:workers";
import { getDOStubFromPathname, getDONamespaceFromPathname, isWebSocketUpgrade } from "@lumenize/utils";

// Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (isWebSocketUpgrade(request)) {
      try {
        // const stub = getDOStubFromPathname(url.pathname, env);  // TODO: Make this work with test by changing the test
        const id = env.MY_DO.newUniqueId();
        const stub = env.MY_DO.get(id);
        return stub.fetch(request);
      } catch (error: any) {
        const status = error.httpErrorCode || 500;
        return new Response(error.message, { status });
      }
    }

    // Handle ping endpoint
    if (url.pathname === '/ping') {
      return new Response("pong");
    }

    return new Response("Not Found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

// Durable Object
export class MyDO extends DurableObject{
  constructor(readonly ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Sets an application level auto response that does not wake hibernated WebSockets.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async #handleIncrement() {
    let count = (await this.ctx.storage.get<number>("count")) ?? 0;
    void this.ctx.storage.put("count", ++count);
    return count;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);    

    // if (isWebSocketUpgrade(request)) {
    if (url.protocol === 'wss:' || url.pathname === '/wss') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      // Create attachment with predictable data including WebSocket count
      const currentWsCount = this.ctx.getWebSockets().length;
      const id = crypto.randomUUID();
      const attachment = { 
        id, 
        count: currentWsCount + 1, // +1 because we're about to add this WebSocket
        timestamp: Date.now() 
      };
      
      this.ctx.acceptWebSocket(server, [id, 'tag2', 'tag3']);
      server.serializeAttachment(attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (url.pathname === '/increment' && request.method === 'GET') {
      return new Response((await this.#handleIncrement()).toString());
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketOpen(ws: WebSocket) {
    // Track connection opening - useful for testing lifecycle
    await this.ctx.storage.put("lastWebSocketOpen", Date.now());
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'increment') {
      ws.send((await this.#handleIncrement()).toString());
      return
    }

    if (message === 'id') {
      ws.send(ws.deserializeAttachment());
      return
    }

    if (message === 'test-error') {
      // Trigger an error for testing webSocketError
      throw new Error("Test error from DO");
    }

    ws.close(1003, "Not Found");  // Simulating a 404
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Track connection closing - useful for testing lifecycle
    await this.ctx.storage.put("lastWebSocketClose", { code, reason, wasClean, timestamp: Date.now() });
    ws.close(code, "Durable Object is closing WebSocket");
  }

  async webSocketError(ws: WebSocket, error: Error) {
    // Track errors - useful for testing lifecycle
    await this.ctx.storage.put("lastWebSocketError", { message: error.message, timestamp: Date.now() });
  }
};

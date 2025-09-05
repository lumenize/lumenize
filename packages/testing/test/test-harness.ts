import { DurableObject } from "cloudflare:workers";
import { getDOStubFromPathname, getDONamespaceFromPathname } from "@lumenize/utils";

// Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.protocol === "wss:") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket Upgrade header", { status: 426 });
      }
      if (request.method !== "GET") {
        return new Response("Expected GET method", { status: 400 });
      }

      try {
        const stub = getDOStubFromPathname(url.pathname, env);
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

    if (url.protocol === "wss:") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server);  // TODO: Add connection tags

      const id = crypto.randomUUID();
      server.serializeAttachment({ id });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    };

    if (url.pathname === '/increment' && request.method === 'GET') {
      return new Response((await this.#handleIncrement()).toString());
    }

    return new Response("Not Found", { status: 404 });
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

    ws.close(1003, "Not Found");  // Simulating a 404
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, "Durable Object is closing WebSocket");
  }
};

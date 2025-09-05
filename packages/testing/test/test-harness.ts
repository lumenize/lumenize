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
      let count = (await this.ctx.storage.get<number>("count")) ?? 0;
      void this.ctx.storage.put("count", ++count);
      return new Response(count.toString());
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Get the session data from the WebSocket attachment
    const session = ws.deserializeAttachment();
    
    // Get all active WebSocket connections
    const allWebSockets = this.ctx.getWebSockets();
    const totalConnections = allWebSockets.length;

    // Upon receiving a message from the client, the server replies with the same message, the session ID of the connection,
    // and the total number of connections with the "[Durable Object]: " prefix
    ws.send(
      `[Durable Object] message: ${message}, from: ${session?.id || 'unknown'}. Total connections: ${totalConnections}`,
    );

    // Send a message to all WebSocket connections, loop over all the connected WebSockets.
    allWebSockets.forEach((connectedWs) => {
      connectedWs.send(
        `[Durable Object] message: ${message}, from: ${session?.id || 'unknown'}. Total connections: ${totalConnections}`,
      );
    });

    // Send a message to all WebSocket connections except the connection (ws),
    // loop over all the connected WebSockets and filter out the connection (ws).
    allWebSockets.forEach((connectedWs) => {
      if (connectedWs !== ws) {
        connectedWs.send(
          `[Durable Object] message: ${message}, from: ${session?.id || 'unknown'}. Total connections: ${totalConnections}`,
        );
      }
    });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // If the client closes the connection, the runtime will invoke the webSocketClose() handler.
    ws.close(code, "Durable Object is closing WebSocket");
  }
};

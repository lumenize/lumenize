import { DurableObject } from "cloudflare:workers";
import { getDOStubFromPathname, getDONamespaceFromPathname } from "@lumenize/utils";

// Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.protocol === "ws:" || url.protocol === "wss:") {
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
export class MyDO extends DurableObject implements DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Sets an application level auto response that does not wake hibernated WebSockets.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request) {
    // Creates two ends of a WebSocket connection.
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
    // request within the Durable Object. It has the effect of "accepting" the connection,
    // and allowing the WebSocket to send and receive messages.
    // Unlike `ws.accept()`, `this.ctx.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
    // is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
    // the connection is open. During periods of inactivity, the Durable Object can be evicted
    // from memory, but the WebSocket connection will remain open. If at some later point the
    // WebSocket receives a message, the runtime will recreate the Durable Object
    // (run the `constructor`) and deliver the message to the appropriate handler.
    this.ctx.acceptWebSocket(server);

    // Generate a random UUID for the session.
    const id = crypto.randomUUID();

    // Attach the session ID to the WebSocket connection and serialize it.
    // This is necessary to restore the state of the connection when the Durable Object wakes up.
    server.serializeAttachment({ id });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
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

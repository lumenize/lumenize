import { DurableObject } from "cloudflare:workers";
import { getDOStubFromPathname, getDONamespaceFromPathname, isWebSocketUpgrade } from "@lumenize/utils";

// Allowed origins for WebSocket connections
export const ALLOWED_ORIGINS = [
  'https://example.com',
  'https://test.example.com'
];

// Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Check origin
    const origin = request.headers.get('Origin');
    if (!origin) {
      return new Response('Origin header required', { status: 403 });
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    
    // if (isWebSocketUpgrade(request)) {  // Recommend you use this in production
    if (url.protocol === 'wss:' || url.pathname === '/wss') {  // Specified this way to test protocol-based routing
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

  async #trackOperation(operationType: string, operationDetails: string) {
    const operations = (await this.ctx.storage.get<string[]>("operationsFromQueue")) ?? [];
    operations.push(`${operationType}-${operationDetails}`);
    await this.ctx.storage.put("operationsFromQueue", operations);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);    

    const operation = url.searchParams.get('op') || 'unknown';
    await this.#trackOperation('fetch', operation);

    // if (isWebSocketUpgrade(request)) {  // I recommend you route this way in reality
    if (url.protocol === 'wss:' || url.pathname === '/wss') {  // Show routing w/ protocol === 'wss:' works
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      
      // Handle sub-protocol selection
      const requestedProtocols = request.headers.get('Sec-WebSocket-Protocol');
      let selectedProtocol: string | undefined;
      const responseHeaders = new Headers();
      
      if (requestedProtocols) {
        const protocols = requestedProtocols.split(',').map(p => p.trim());
        // Always choose "correct.subprotocol" if present
        if (protocols.includes('correct.subprotocol')) {
          selectedProtocol = 'correct.subprotocol';
          responseHeaders.set('Sec-WebSocket-Protocol', selectedProtocol);
        }
      }
      
      // Create attachment with predictable data including WebSocket count
      const currentWsCount = this.ctx.getWebSockets().length;
      const name = url.pathname.split('/').at(-1) ?? 'No name in path'
      const attachment = { 
        name, 
        count: currentWsCount + 1, // +1 because we're about to add this WebSocket
        timestamp: Date.now(),
        selectedProtocol
      };
      
      this.ctx.acceptWebSocket(server, [name]);
      server.serializeAttachment(attachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketOpen(ws: WebSocket) {
    // Track connection opening - useful for testing lifecycle
    await this.ctx.storage.put("lastWebSocketOpen", Date.now());
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string' && message.startsWith('track-')) {
      await this.#trackOperation('message', message);
    }

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

    if (message === 'test-server-close') {
      // Trigger a server-initiated close for testing
      // Store the close info directly since server-initiated closes might not trigger webSocketClose
      const closeInfo = { 
        code: 4001, 
        reason: "Server initiated close for testing", 
        wasClean: true, 
        timestamp: Date.now(),
        initiatedBy: 'server'
      };
      await this.ctx.storage.put("lastServerInitiatedClose", closeInfo);
      await this.ctx.storage.put("lastWebSocketClose", closeInfo);
      
      ws.close(4001, "Server initiated close for testing");
      return; // Don't send a response message
    }

    // Default response for any other message
    ws.send('echo: ' + message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Track connection closing - useful for testing lifecycle
    // Determine if this is client-initiated or server-initiated based on the code
    const isClientInitiated = code !== 4001; // 4001 is our server-initiated test code
    
    const closeInfo = { 
      code, 
      reason, 
      wasClean, 
      timestamp: Date.now(),
      initiatedBy: isClientInitiated ? 'client' : 'server'
    };
    
    await this.ctx.storage.put("lastWebSocketClose", closeInfo);
    
    if (isClientInitiated) {
      // Store client-initiated closes separately for easier testing
      await this.ctx.storage.put("lastClientInitiatedClose", closeInfo);
    } else {
      // Store server-initiated closes separately for easier testing  
      await this.ctx.storage.put("lastServerInitiatedClose", closeInfo);
    }
  }

  async webSocketError(ws: WebSocket, error: Error) {
    // Track errors - useful for testing lifecycle
    await this.ctx.storage.put("lastWebSocketError", { message: error.message, timestamp: Date.now() });
  }
};

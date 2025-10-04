import { DurableObject } from 'cloudflare:workers';
import { handleRPCRequest, handleWebSocketRPCMessage } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';

export class MyDO extends DurableObject {
  #counter = 0;

  // Your DO methods (available via RPC)
  increment(): number {
    return ++this.#counter;
  }

  reset(): void {
    this.#counter = 0;
  }

  // Custom routing in fetch()
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Custom HTTP: Health check endpoint
    if (url.pathname.endsWith('/health')) {
      return new Response('OK');
    }

    // Custom HTTP: Counter status endpoint
    if (url.pathname.endsWith('/status')) {
      return Response.json({ counter: this.#counter });
    }

    // Custom WebSocket: Non-RPC WebSocket endpoint
    if (url.pathname.endsWith('/custom-ws')) {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, ['custom']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Handle RPC requests (both HTTP and WebSocket)
    return await handleRPCRequest(request, this);
  }

  // Handle all WebSocket messages
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);

    // Custom WebSocket protocol for tagged connections
    if (tags.includes('custom')) {
      if (message === 'PING') {
        ws.send('PONG');
        return;
      }
    }

    // Handle RPC WebSocket messages
    await handleWebSocketRPCMessage(ws, message, this);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Optional: cleanup for both custom and RPC WebSockets
  }
}

// Worker routes requests to DOs
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Try RPC routing first
    const rpcResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (rpcResponse) return rpcResponse;
    
    // For custom endpoints, also route to DO (without RPC prefix)
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Pattern: /binding-name/instance-id/...rest
    if (pathParts.length >= 2) {
      const bindingName = pathParts[0].toUpperCase().replace(/-/g, '_');
      const instanceId = pathParts[1];
      
      if (env[bindingName]) {
        const id = env[bindingName].idFromName(instanceId);
        const stub = env[bindingName].get(id);
        return stub.fetch(request);
      }
    }
    
    return new Response('Not Found', { status: 404 });
  },
};
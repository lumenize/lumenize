import { DurableObject } from "cloudflare:workers";
import { routeDORequest } from '@lumenize/utils';

const handleLogin = (request: Request): Response | undefined => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith('/login')) return undefined;
  
  const user = url.searchParams.get('user');
  if (user === 'test') {
    return new Response('OK', {
      headers: { 'Set-Cookie': 'token=abc123; Path=/' }
    });
  }
  return new Response('Invalid', { status: 401 });
};

const handleProtectedCookieEcho = (request: Request): Response | undefined => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith('/protected-cookie-echo')) return undefined;
  
  const cookies = request.headers.get('Cookie') || '';
  return new Response(`Cookies: ${cookies}`, {
    status: cookies.includes('token=') ? 200 : 401
  });
};

// Worker
export default {
  async fetch(request, env, ctx) {
    // CORS-protected route with prefix /cors/
    // Array form shown; also supports cors: true for permissive mode
    // See https://lumenize.com/docs/utils/route-do-request for routing details
    // See https://lumenize.com/docs/utils/cors-support for CORS configuration
    const routeCORSRequest = (req: Request, e: Env) => routeDORequest(req, e, {
      prefix: '/cors/',
      cors: { origin: ['https://safe.com', 'https://app.example.com'] },
    });
    
    // Worker handlers follow the hono convention:
    //   - return Response if the handler wants to handle the route
    //   - return undefined to fall through
    return (
      handleLogin(request) ||
      handleProtectedCookieEcho(request) ||
      await routeCORSRequest(request, env) ||
      await routeDORequest(request, env) ||
      new Response("Not Found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

// Durable Object
export class MyDO extends DurableObject<Env>{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ar-ping', 'ar-pong'),
    );
  }

  increment(): number {
    let count = (this.ctx.storage.kv.get<number>("count")) ?? 0;
    this.ctx.storage.kv.put("count", ++count);
    return count;
  }

  echo(value: any): any { return value; }

  async fetch(request: Request) {
    const url = new URL(request.url);    
    
    if (url.pathname.endsWith('/increment')) {
      const count = this.increment();
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
        if (protocols.includes('b')) {
          selectedProtocol = 'b';
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

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'increment') {
      return ws.send(this.increment().toString());
    }

    if (message === 'test-server-close') {   
      return ws.close(4001, "Server initiated close for testing");
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.ctx.storage.kv.put("lastWebSocketClose", { code, reason, wasClean });
    ws.close(code, reason);
  }
};

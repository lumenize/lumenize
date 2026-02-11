import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { LumenizeAuth } from '../../src/lumenize-auth.js';
import { ResendEmailSender } from '../../src/resend-email-sender.js';
import { createAuthRoutes, honoAuthMiddleware } from '../../src/index.js';

// Re-export the Auth DO for wrangler
export { LumenizeAuth };

// AuthEmailSender for the e2e test — sends real emails via Resend
// from the verified test.lumenize.com domain
export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@test.lumenize.com';
  appName = 'Lumenize Test';
}

// Minimal echo DO for WebSocket integration testing
export class EchoDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    ws.send(`echo: ${message}`);
  }

  webSocketClose() { /* required by hibernation API */ }
}

const app = new Hono<{ Bindings: Env }>();

// Auth routes (public endpoints)
app.all('/auth/*', async (c) => {
  const authRoutes = createAuthRoutes(c.env);
  return (await authRoutes(c.req.raw)) ?? c.text('Not Found', 404);
});

// Protected routes — HTTP + WebSocket, authenticated and forwarded to DO
app.all('/ws/:id', honoAuthMiddleware((c) => ({
  doNamespace: (c.env as any).ECHO_DO,
  doInstanceNameOrId: c.req.param('id'),
})));

// Catch-all for unmatched routes
app.all('*', (c) => c.text('Not Found', 404));

export default app;

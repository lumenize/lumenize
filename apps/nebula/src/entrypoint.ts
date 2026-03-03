/**
 * Nebula Worker entrypoint
 *
 * Composes nebula-auth routes with DO routing, applying JWT verification
 * at the entrypoint level for all WebSocket connections.
 *
 * Routing layers:
 * 1. /auth/... → routeNebulaAuthRequest (login, refresh, invite, etc.)
 * 2. /gateway/... → routeDORequest with prefix:'gateway' (WebSocket mesh connections)
 * 3. /{BINDING}/... → routeDORequest without prefix (blocked for now)
 * 4. Fallback → 404
 */

import { env } from 'cloudflare:workers';
import { routeNebulaAuthRequest, verifyNebulaAccessToken } from '@lumenize/nebula-auth';
import { routeDORequest } from '@lumenize/routing';
import { extractWebSocketToken } from '@lumenize/auth';

/** Verifies JWT from WebSocket subprotocol and forwards it as Authorization header. */
async function onBeforeConnect(request: Request): Promise<Response | Request> {
  const token = extractWebSocketToken(request);
  if (!token) {
    return new Response('Unauthorized: missing access token', { status: 401 });
  }
  const jwt = await verifyNebulaAccessToken(token, env);
  if (!jwt) {
    return new Response('Forbidden: invalid JWT', { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request) {
    // 1. Auth routes (login, refresh, invite, etc.)
    const authResponse = await routeNebulaAuthRequest(request, env);
    if (authResponse) return authResponse;

    // 2. Gateway routes (/gateway/{binding}/{instance})
    // LumenizeClient builds URLs with the /gateway/ prefix
    const gatewayResponse = await routeDORequest(request, env, {
      prefix: 'gateway',
      onBeforeRequest() {
        return new Response('Not Implemented', { status: 501 });
      },
      onBeforeConnect,
    });
    if (gatewayResponse) return gatewayResponse;

    // 3. Direct DO access (no /gateway/ prefix) — fully blocked for now
    const directResponse = await routeDORequest(request, env, {
      onBeforeRequest() {
        return new Response('Not Implemented', { status: 501 });
      },
      onBeforeConnect() {
        return new Response('Not Implemented', { status: 501 });
      },
    });
    if (directResponse) return directResponse;

    // 4. Fallback
    return new Response('Not Found', { status: 404 });
  },
};

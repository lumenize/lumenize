/**
 * Nebula Worker entrypoint
 *
 * Composes nebula-auth routes with DO routing, applying JWT verification
 * at the entrypoint level for all WebSocket connections.
 *
 * Routing layers:
 * 1. /auth/... → routeNebulaAuthRequest (login, refresh, invite, etc.)
 * 2. /gateway/... → routeDORequest with prefix:'gateway' (WebSocket mesh connections)
 * 3. /{BINDING}/... → routeDORequest without prefix — opened ONLY for static
 *    app serving: GET/HEAD to a Star/DevStar serving target reaches
 *    `Star.onRequest`; every other method is 405, every other binding is 404.
 * 4. Fallback → 404
 *
 * Cross-origin browser access is gated by the `LUMENIZE_APPROVED_ORIGINS` env
 * binding (comma-separated origins). Empty / unset → same-origin only.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { routeNebulaAuthRequest, verifyNebulaAccessToken } from '@lumenize/nebula-auth';
import { routeDORequest, type CorsOptions } from '@lumenize/routing';
import { extractWebSocketToken } from '@lumenize/auth';

/**
 * Parse the `LUMENIZE_APPROVED_ORIGINS` env var into a `CorsOptions` allowlist.
 * Returns `false` (no CORS) when the var is unset, empty, or all-whitespace.
 */
function buildCorsOptions(approvedOrigins: string | undefined): CorsOptions {
  const origins = (approvedOrigins ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0);
  return origins.length === 0 ? false : { origin: origins };
}

const corsOptions = buildCorsOptions(env.LUMENIZE_APPROVED_ORIGINS);

/** Verifies JWT from WebSocket subprotocol and forwards it as Authorization header. */
async function onBeforeConnect(request: Request): Promise<Response | Request> {
  const log = debug('nebula.entrypoint.onBeforeConnect');
  const token = extractWebSocketToken(request);
  if (!token) {
    log.debug('rejected: missing access token', { url: request.url });
    return new Response('Unauthorized: missing access token', { status: 401 });
  }
  const jwt = await verifyNebulaAccessToken(token, env);
  if (!jwt) {
    log.debug('rejected: invalid JWT', { url: request.url });
    return new Response('Forbidden: invalid JWT', { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request) {
    // 1. Auth routes (login, refresh, invite, etc.)
    const authResponse = await routeNebulaAuthRequest(request, env, { cors: corsOptions });
    if (authResponse) return authResponse;

    // 2. Gateway routes (/gateway/{binding}/{instance})
    // LumenizeClient builds URLs with the /gateway/ prefix
    const gatewayResponse = await routeDORequest(request, env, {
      prefix: 'gateway',
      cors: corsOptions,
      onBeforeRequest() {  // No plans to ever implement
        return new Response('Not Implemented', { status: 501 });
      },
      onBeforeConnect,
    });
    if (gatewayResponse) return gatewayResponse;

    // 3. Direct DO access (no /gateway/ prefix) — opened ONLY for the static
    //    app-serving GET. Bounded so it doesn't expose every method/binding:
    //    only GET/HEAD to a Star/DevStar serving target passes through to
    //    `Star.onRequest` (the ungated static read — no JWT, since browsers
    //    don't attach Authorization to document/sub-resource loads; the data is
    //    gated on the WS/mesh path). Other methods → 405; other bindings (incl.
    //    the raw NEBULA_AUTH GET handlers) → 404. WS to a DO is never allowed.
    const directResponse = await routeDORequest(request, env, {
      cors: corsOptions,
      onBeforeRequest(request, { doNamespace }) {
        // M3: DEV_CONTAINER serves the dev preview shell + vite assets via the DO
        // `fetch()` proxy (GET/HEAD) — the same ungated static read as the in-DO app
        // serve. (The `|| env.DEV_STAR` in-DO serve disjunct collapses out in Phase 4
        // when getPlatformAsset/the in-DO serve is deleted — don't half-collapse here.)
        const isServingTarget =
          doNamespace === env.STAR || doNamespace === env.DEV_STAR || doNamespace === env.DEV_CONTAINER;
        if (!isServingTarget) {
          return new Response('Not Found', { status: 404 });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        return undefined; // GET/HEAD to a serving target → Star.onRequest / DevContainer.fetch
      },
      onBeforeConnect(request, { doNamespace }) {
        // M2: the vite HMR WebSocket to DEV_CONTAINER is allowed, ungated — like the
        // preview shell. No tenant data flows over HMR (the scope is injected
        // server-side; DevContainer.onBeforeCall guards the mesh path, not fetch()).
        // Every OTHER direct WS to a DO stays closed — mesh WS terminates at the Gateway.
        if (doNamespace === env.DEV_CONTAINER) return undefined;
        return new Response('Not Implemented', { status: 501 });
      },
    });
    if (directResponse) return directResponse;

    // 4. Fallback
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Nebula Worker entrypoint
 *
 * Composes nebula-auth routes with DO routing, applying JWT verification
 * at the entrypoint level for all WebSocket connections.
 *
 * Routing layers:
 * 1. /auth/... → routeNebulaAuthRequest (login, refresh, invite, etc.)
 * 2. /gateway/... → routeDORequest with prefix:'gateway' (WebSocket mesh connections)
 * 3. Fallback → 404 (the built app's /app/* serve lands with the Phase-3 route table)
 *
 * Cross-origin browser access is gated by the `LUMENIZE_APPROVED_ORIGINS` env
 * binding (comma-separated origins). Empty / unset → same-origin only.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { routeNebulaAuthRequest, verifyNebulaAccessToken } from '@lumenize/nebula-auth';
import { routeDORequest, type CorsOptions } from '@lumenize/routing';
import { extractWebSocketToken } from '@lumenize/mesh/client';

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

// --- Build stamp (Phase 1) -----------------------------------------------------------
// These globals are injected ONLY by a real `wrangler deploy` via Wrangler `--define`
// (deploy.sh / deploy:test-worker). vitest-pool-workers, `wrangler dev`, and the bench
// worker's local-spawn inject NONE. entrypoint.ts is imported by the baseline app, the
// bench worker, and every test app — so a handler reading a BARE `__GIT_SHA__` would fail
// type-check (TS2304) and throw `ReferenceError` at request time, breaking the whole suite
// + dev loop. Read through `typeof`-guarded helpers that return a dev sentinel when absent.
declare const __GIT_SHA__: string;
declare const __DIRTY__: string;

/** The git SHA this bundle was built from, or `'dev'` for any non-deploy (unstamped) run. */
function buildSha(): string {
  return typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev';
}

/** Whether the deploy was cut from a dirty tree. `true` in dev (numbers never reproducible). */
function buildDirty(): boolean {
  return typeof __DIRTY__ !== 'undefined' ? __DIRTY__ === 'dirty' : true;
}

/**
 * `GET /_version?sha=<expected>` — a public, side-effect-free build-COMPARE endpoint that
 * never DISCLOSES the deployed SHA (nor buildTime, nor any dependency list). The caller
 * SUBMITS the SHA it expects; the worker replies `{ match, dirty }` after a plain compare
 * against the bundle-baked `__GIT_SHA__`. Because nothing sensitive leaves the worker, the
 * route is public and identical on prod and the bench worker — no Bearer gate, no public/
 * gated split. Its two callers are the Phase-2 staleness guard and the Phase-3 deploy
 * self-check; `{ match: true }` doubles as the liveness signal. Runs at the Worker HTTP
 * boundary before any DO dispatch (reads only the `--define` globals — no DO/storage/mesh).
 * Returns `undefined` for any other path so the caller falls through to the normal routing.
 */
function handleVersion(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== '/_version') return undefined;
  const expected = url.searchParams.get('sha');
  // A missing/empty ?sha never spuriously matches the dev sentinel or a real SHA.
  const match = expected != null && expected.length > 0 && expected === buildSha();
  return Response.json({ match, dirty: buildDirty() });
}

/** Verifies JWT from WebSocket subprotocol and forwards it as Authorization header. */
async function onBeforeConnect(request: Request): Promise<Response | Request> {
  const log = debug('nebula.entrypoint.onBeforeConnect');
  const token = extractWebSocketToken(request);
  if (!token) {
    // Log the pathname, NOT request.url — a full URL can carry a query-string secret (security.md
    // § Never log secrets). The WS token rides the subprotocol, so the pathname is all we need.
    log.debug('rejected: missing access token', { path: new URL(request.url).pathname });
    return new Response('Unauthorized: missing access token', { status: 401 });
  }
  const jwt = await verifyNebulaAccessToken(token, env);
  if (!jwt) {
    log.debug('rejected: invalid JWT', { path: new URL(request.url).pathname });
    return new Response('Forbidden: invalid JWT', { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request) {
    // 0. Build-compare fast-path — the LITERAL first statement (defense-in-depth: it can't be
    //    reordered behind a future handler). Public, side-effect-free, discloses nothing.
    //    (The real prod shadow-prevention is `/_version`'s presence in wrangler.jsonc's
    //    `run_worker_first` array, B1 — not this statement order.)
    const versionResponse = handleVersion(request);
    if (versionResponse) return versionResponse;

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

    // (The former direct-DO route — GET/HEAD `/dev-container/*` to the vite preview
    // proxy — died with the DevContainer node. The built app's `/app/*` serve, direct
    // from Galaxy's VFS, lands with the Phase-3 route table.)

    // 3. Fallback
    return new Response('Not Found', { status: 404 });
  },
};

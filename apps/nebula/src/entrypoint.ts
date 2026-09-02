/**
 * Nebula Worker entrypoint
 *
 * Composes nebula-auth routes with DO routing, applying JWT verification
 * at the entrypoint level for all WebSocket connections. The routes read as ONE
 * `createRouter` table (the Registry's routes-and-steps convention):
 *
 *   /_version        → the build-compare endpoint (public, discloses nothing)
 *   /app/{star}/*    → the built app, forwarded to the owning Galaxy's serve (GET/HEAD,
 *                      deliberately ungated — the bounding IS the security property)
 *   /auth/*          → routeNebulaAuthRequest (login, refresh, invite, etc.)
 *   /gateway/*       → routeDORequest prefix:'gateway' (WebSocket mesh connections)
 *   anything else    → 404 (`/studio/*` is Workers Assets' by being UNLISTED in
 *                      `run_worker_first` — it never reaches this Worker in prod)
 *
 * Cross-origin browser access is gated by the `LUMENIZE_APPROVED_ORIGINS` env
 * binding (comma-separated origins).
 *
 * ⚠️ **Empty / unset disables the server-side `Origin` check ENTIRELY — it does NOT mean
 * "same-origin only", which is what this comment used to claim.** `buildCorsOptions('')`
 * yields `false`, and `applyCorsPolicy(request, false)` returns `{ allowedOrigin: null }`
 * on its first branch — no comparison is made and nothing is refused. A cross-origin POST
 * therefore **reaches its handler and does its work**; the browser withholds only the
 * *response* from the calling page, for want of an `Access-Control-Allow-Origin` header.
 * For anything that mints, sends mail or writes, "the page could not read the answer" is
 * not "it did not happen". A NON-empty list is the stricter setting: a disallowed `Origin`
 * then gets a server-side 403 before dispatch.
 *
 * ⇒ What actually closes `/auth` today is per-route and not this variable: `SameSite=Strict`
 * on every cookie (`worker-token.ts`), the non-safelisted `Authorization` header forcing a
 * preflight that cross-origin pages cannot satisfy, and `turnstileGuard` on the open rows.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { routeNebulaAuthRequest, verifyNebulaAccessToken, createRouter, type Step, type RouteState } from '@lumenize/nebula-auth';
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

/**
 * `/app/{u}.{g}.{s}/*` — forward to the owning Galaxy's `fetch` handler, which serves
 * the built app from its own VFS via `serve.ts`. The URL's scope segment is a STAR
 * scope; the owning Galaxy is its first two segments — Studio composed the URL by the
 * inverse move (its own `{u}.{g}` + the star slug).
 *
 * The properties carried over from the retired `/dev-container/*` branch: **GET/HEAD-
 * bounded against ONE namespace, deliberately ungated** — browsers send no
 * `Authorization` on document/sub-asset loads (the preview iframe IS the consumer), and
 * data is gated on the mesh path; that bounding IS the security property. Never
 * `routeDORequest` here: it reads segment 0 as the binding and segment 1 as the
 * instance, and `/app/{star}` names neither — the identity headers it would have set
 * are set by hand instead, so the Galaxy's name stamp works on this entry too.
 */
const serveAppForward: Step<RouteState> = async (request, { params }) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const star = params.scope ?? '';
  const segs = star.split('.');
  // Only a star-tier scope names a dist; anything else has no app to serve.
  if (segs.length !== 3 || segs.some((s) => s.length === 0)) {
    return new Response('Not Found', { status: 404 });
  }
  const galaxy = `${segs[0]}.${segs[1]}`;
  const headers = new Headers(request.headers);
  headers.set('x-lumenize-do-binding-name', 'GALAXY');
  headers.set('x-lumenize-do-instance-name-or-id', galaxy);
  return await env.GALAXY.getByName(galaxy).fetch(new Request(request, { headers }));
};

/**
 * The Worker's routes as ONE table — the Registry's routes-and-steps convention
 * (`createRouter` from nebula-auth's route-pipeline). Gates are deliberately minimal:
 * `/_version` and the SPA carry none, the Gateway and Registry own theirs, `/app/*` is
 * GET/HEAD-bounded only. `/_version` is the FIRST row (defense-in-depth: it cannot be
 * reordered behind a future handler; the real prod shadow-prevention is its presence in
 * wrangler.jsonc's `run_worker_first`). The auth/gateway rows forward to their existing
 * routers, which answer everything under their prefixes — an in-prefix miss is THEIR
 * 404, converted here so the runner's ran-out-of-steps 500 stays what it means.
 */
const router = createRouter([
  { path: '/_version', steps: [(request) => handleVersion(request)] },
  { path: '/app/:scope', steps: [serveAppForward] },
  { path: '/app/:scope/*', steps: [serveAppForward] },
  {
    path: '/auth/*',
    steps: [async (request) =>
      (await routeNebulaAuthRequest(request, env, { cors: corsOptions }))
        ?? new Response('Not Found', { status: 404 })],
  },
  {
    path: '/gateway/*',
    steps: [async (request) =>
      (await routeDORequest(request, env, {
        prefix: 'gateway',
        cors: corsOptions,
        onBeforeRequest() {  // No plans to ever implement
          return new Response('Not Implemented', { status: 501 });
        },
        onBeforeConnect,
      })) ?? new Response('Not Found', { status: 404 })],
  },
]);

export default {
  async fetch(request: Request) {
    // Everything the Worker serves is a row above; an unmatched path is a 404, never a
    // fall-through to some implicit handler (`/studio/*` is Workers Assets' by being
    // UNLISTED in `run_worker_first` — it never reaches this code in prod).
    return (await router(request)) ?? new Response('Not Found', { status: 404 });
  },
};

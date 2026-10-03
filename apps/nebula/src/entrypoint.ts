/**
 * Nebula Worker entrypoint — three steps, each falling through to the next (ADR-021, ADR-022):
 *
 *  1. **The platform host's own routes.** On `platform.lumenize.dev`, `/` and every path under
 *     `/auth/` go to the `PlatformHost` entrypoint through its self-referencing binding: login and
 *     signup, Home, a link's page and its consume, acceptance, logout and the refresh.
 *  2. **The routes every host answers by path.** `/_version`, `/pictures` and `/gateway/*`; and
 *     `/auth/*`, which every host but the platform host answers with a 404, so a page step's
 *     single-page fallback never answers it with a 200.
 *  3. **A page chosen by host.** The apex redirects to the platform host; the platform host serves
 *     the auth app's static files; a universe or galaxy host serves Studio; a Star's or persona's
 *     host serves its galaxy's built app through the page track (`page-forward.ts`). A page loads
 *     without a session, so this step never asks the Registry whether a host's scope exists.
 *
 * Every page answer carries `Content-Security-Policy: frame-ancestors`: `'none'` on the platform
 * host, a universe page and Studio, and the galaxy's Studio origin on a Star's or persona's host,
 * so no page can be framed to trick a click out of Home or Studio.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { verifyNebulaAccessToken, createRouter, parseId } from '@lumenize/nebula-auth';
import { deploymentOrigin, hostOrigin, parseHost, type HostTarget } from '@lumenize/nebula-auth/claims';
import { handlePictureUpload, servePicture } from './profile-pictures';
import { forwardPage } from './page-forward';
import { LUMENIZE_ORIGIN_META } from './page-meta';
import { routeDORequest } from '@lumenize/routing';
import { extractWebSocketToken } from '@lumenize/mesh/client';

// --- Build stamp -----------------------------------------------------------------------
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
 * gated split. Its two callers are the client's staleness guard and the deploy
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

/** `response`, with `frame-ancestors` set to `ancestors`. */
function framed(response: Response, ancestors: string): Response {
  const out = new Response(response.body, response);
  out.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
  return out;
}

function isHtml(response: Response): boolean {
  return (response.headers.get('Content-Type') ?? '').includes('text/html');
}

/** The assets layer's answer, or a 404 where this Worker has no assets binding (a test worker). */
async function assets(request: Request): Promise<Response> {
  const binding = (env as Env & { ASSETS?: Fetcher }).ASSETS;
  return binding ? binding.fetch(request) : new Response('Not Found', { status: 404 });
}

/** Studio, for a universe or galaxy host: its single-page app, carrying the deployment's origin. */
async function studioPage(request: Request, deployment: string): Promise<Response> {
  const res = await assets(request);
  if (!isHtml(res)) return res;
  return new HTMLRewriter().on('head', {
    element(el) { el.prepend(`<meta name="${LUMENIZE_ORIGIN_META}" content="${deployment}">`, { html: true }); },
  }).transform(res);
}

/**
 * The last step: the page a host serves. The only step where the host decides what is shown.
 */
async function servePage(request: Request, url: URL, target: HostTarget | null, deployment: string): Promise<Response> {
  if (target === null) return new Response('Not Found', { status: 404 });
  switch (target.kind) {
    case 'apex':
      return Response.redirect(`${hostOrigin({ kind: 'platform' }, deployment, url.origin)}${url.pathname}${url.search}`, 302);
    case 'platform': {
      // Every page here is a route the platform entrypoint serves, so what reaches this step is the
      // auth app's static files; an HTML answer would be a single-page fallback no route claimed.
      const res = await assets(request);
      return isHtml(res) ? new Response('Not Found', { status: 404 }) : framed(res, "'none'");
    }
    case 'scope':
    case 'persona': {
      const parsed = parseId(target.scope);
      if (parsed.tier !== 'star') return framed(await studioPage(request, deployment), "'none'");
      const galaxy = `${parsed.universe}.${parsed.galaxy}`;
      const res = await forwardPage(request, env.GALAXY, { binding: 'GALAXY', instanceName: galaxy, scope: target.scope });
      return framed(res, hostOrigin({ kind: 'scope', scope: galaxy }, deployment, url.origin));
    }
  }
}

/**
 * The routes every host answers by path, as ONE table — the Registry's routes-and-steps convention
 * (`createRouter` from nebula-auth's route-pipeline). `/_version` is the FIRST row, so it cannot be
 * reordered behind a future handler. The gateway row forwards to its own router, which answers
 * everything under its prefix — an in-prefix miss is its 404, converted here so the runner's
 * ran-out-of-steps 500 stays what it means.
 */
const router = createRouter([
  { path: '/_version', steps: [(request) => handleVersion(request)] },
  // Profile pictures (`profile-pictures.ts`): the upload derives whose from the verified bearer;
  // the serve is public by design — an <img> carries no credential, and `picture` is a public field.
  { path: '/pictures', method: 'PUT', steps: [(request) => handlePictureUpload(request, env)] },
  { path: '/pictures/:key', method: 'GET', steps: [(_request, state) => servePicture(state.params.key, env)] },
  {
    path: '/gateway/*',
    steps: [async (request) =>
      (await routeDORequest(request, env, {
        prefix: 'gateway',
        // The client Gateway is the only Durable Object a browser connects to; any other binding
        // answers 404 before a Durable Object is constructed for it. The upgrade rests on its token,
        // which rides the subprotocol and which no cross-site page can obtain.
        bindings: ['NEBULA_CLIENT_GATEWAY'],
        onBeforeRequest() {  // No plans to ever implement
          return new Response('Not Implemented', { status: 501 });
        },
        onBeforeConnect,
      })) ?? new Response('Not Found', { status: 404 })],
  },
  // `/auth/*` answers only on the platform host, which step 1 already took.
  { path: '/auth', steps: [() => new Response('Not Found', { status: 404 })] },
  { path: '/auth/*', steps: [() => new Response('Not Found', { status: 404 })] },
]);

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const deployment = deploymentOrigin(env);
    const target = parseHost(url.host, deployment);
    if (target?.kind === 'platform' && (url.pathname === '/' || url.pathname.startsWith('/auth/'))) {
      // ⚠️ The body crosses the binding READ, never as this request's stream. A route that answers
      // without reading its body — Home's summary, a refusal before the parse — would otherwise
      // leave the binding pulling this stream after the answer went out, which throws "Can't read
      // from request stream after response has been sent" and takes a local `wrangler dev` down
      // with it. Every body on these routes is a small JSON object.
      const forwarded = request.body === null ? request : new Request(request, { body: await request.arrayBuffer() });
      return env.PLATFORM_HOST.fetch(forwarded);
    }
    return (await router(request)) ?? await servePage(request, url, target, deployment);
  },
};

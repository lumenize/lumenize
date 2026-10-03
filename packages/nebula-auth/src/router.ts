/**
 * Nebula Auth Worker router — the platform host's routes, composed into the default Worker.
 *
 * Every route here is a step in a session's lifecycle, and it answers only on the platform host:
 * `apps/nebula` reaches this router for that host alone and answers `/auth/*` on every other host
 * with a 404. The token and login flows run IN THE WORKER (see `worker-token.ts`) over Workers KV +
 * registry RPC; the two claims are forwarded to the singleton `NebulaAuthRegistry` DO after
 * Turnstile. No route reads an access token. What a session DOES with the Registry — listing,
 * creating, deleting, impersonating, inviting — enters mesh-side through `NebulaAuthFacade`.
 */
import { debug } from '@lumenize/debug';
import { verifyNebulaTurnstileToken } from './turnstile';
import { createRouter, type RouteEntry, type RouteRunner, type Step } from './route-pipeline';
import { NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME } from './types';
import { deploymentOrigin } from './hosts';
import type { ScopeLifecycleHooks } from './types';
import { verifyNebulaAccessToken } from './verify';
import {
  HOME_PATH,
  handleEmailMagicLink,
  handleMagicLinkLookup,
  handleMagicLinkConsume,
  handleAcceptMembership,
  handleRefreshToken,
  handleHomeSummary,
  handleLogout,
  handleSignupClaim,
  handlePendingMembership,
  handleComingSoon,
} from './worker-token';

/**
 * The built auth-SPA entry, and the origin the assets fetch is addressed to.
 *
 * The origin is arbitrary — Workers Assets routes on the PATH and ignores the host — but `fetch`
 * requires an absolute URL, so this supplies one that can never collide with a real route.
 */
const AUTH_APP_ORIGIN = 'https://assets.invalid';
const AUTH_APP_ENTRY = '/auth-app.html';

/** Options for {@link routeNebulaAuthRequest}. */
export interface RouteNebulaAuthOptions {
  /**
   * What the router asks the platform to do to Durable Objects it cannot name — today, wiping the
   * scopes a claim's first acceptance names. Required, as on `NebulaAuthFacade`, since an optional
   * seam would skip a teardown silently.
   */
  hooks: ScopeLifecycleHooks;
}

// ============================================
// Response helpers
// ============================================

function jsonError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================
// The route pipeline — every entry states its complete requirement, in order
// ============================================

/**
 * Build the route table for `env` — guards, terminals, and the entries they compose into.
 * Exported so a test can assert table-level properties (every entry declares a `method`) without
 * driving a request through each row.
 *
 * Guards close over `env` rather than importing the `cloudflare:workers` module-scope `env`, for
 * two verified reasons: this module is re-exported from the widely-imported package index, so that
 * import would drag `cloudflare:workers` into Node consumers (`packaging.md`'s bare-`SyntaxError`);
 * and a caller may doctor gating config with a per-call env spread
 * (`routeNebulaAuthRequest(request, { ...env, … })` — the Turnstile gating tests' mechanism),
 * which a module-scope read would silently ignore. `env` stays out of `routeState` either way —
 * it is ambient per isolate, not per-request.
 * Compiled once per `env` and `hooks` pair ({@link authPipeline}'s WeakMaps), so production compiles
 * once.
 */
export function buildAuthRouteTable(env: Env, hooks: ScopeLifecycleHooks): RouteEntry[] {
  /**
   * First on every `POST` but the refresh: only a page on the platform host may call it. A browser
   * says so in `Sec-Fetch-Site`, which page script cannot set; a request without the header is not a
   * browser's, and passes unless its `Origin` names another origin. Each refusal names the header
   * that decided it. This is what keeps a scope host's page, whose code may be a user-developer's,
   * from reading Home's data or acting on the session with the browser's cookies.
   */
  const sameOriginGuard: Step = (request) => {
    const site = request.headers.get('Sec-Fetch-Site');
    if (site !== null) {
      if (site === 'same-origin') return;
      return jsonError(403, 'cross_origin', `Only a page on this host may call this route (Sec-Fetch-Site: ${site})`);
    }
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== new URL(request.url).origin) {
      return jsonError(403, 'cross_origin', 'Only a page on this host may call this route (Origin)');
    }
  };

  /**
   * ONE connection-keyed limiter per route — none presents an access token, so there is no `sub` to
   * key on, and each reaches something expensive anonymously: a forged cookie or link token buys a
   * singleton round trip per request, and the open routes reach `turnstileGuard`'s `siteverify` and
   * the singleton.
   *
   * Key: `CF-Connecting-IP`. The absent-header fallback is ALLOW, matching the no-op when the
   * binding is unbound — miniflare supplies no such header, so a test lane would
   * otherwise collapse every caller onto one key and 429 the suite into what look like auth
   * failures. Cloudflare's edge always supplies it in production.
   */
  const connectionRateLimitGuard: Step = async (request) => {
    const limiter = (env as Env & { NEBULA_AUTH_CONNECTION_RATE_LIMITER?: RateLimit })
      .NEBULA_AUTH_CONNECTION_RATE_LIMITER;
    if (!limiter) return; // unbound → no-op; the Registry's boot-time check reports this state
    const key = request.headers.get('CF-Connecting-IP');
    if (!key) return;
    const { success } = await limiter.limit({ key });
    if (!success) return jsonError(429, 'rate_limited', 'Too many requests. Please try again later.');
  };

  /** Human-presence gate on the open routes, AFTER the connection limiter because it costs a
   *  `siteverify` round trip. Pass-through paths live in {@link checkTurnstile}. */
  const turnstileGuard: Step = async (request) =>
    (await checkTurnstile(request, env)) ?? undefined;

  /** Forwards the original request to the Registry, injecting nothing: `stub.fetch(request)` — no
   *  parse, no re-serialize, every header survives, and the DO reads `url.origin` off it and answers
   *  a malformed body with its own 400 `invalid_request` (`raw-comm.md` § *Edge Worker fronting a
   *  DO*). The two claims are the only rows that reach it. */
  const forwardRaw: Step = (request) =>
    env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME).fetch(request);

  /**
   * Serve the auth SPA's HTML for a GET navigation: Home, login, signup, the emails page, a link's
   * page and the logout page are one HTML entry, which reads `location.pathname` to pick its screen.
   *
   * ⚠️ **Under `wrangler dev` the assets layer is EMPTY by design** (the dev loop builds no dist —
   * the lanes `mkdir` it and the browser is served by vite instead), so this returns a 503 rather
   * than a confusing 404. A rendered check against a Worker-served page belongs in a lane that
   * built the dist.
   */
  const serveAuthApp: Step = async () => {
    // A page answer even when there is no page to give, so it is unframeable like every other.
    const unbuilt = (description: string) => Response.json({ error: 'assets_unavailable', error_description: description }, {
      status: 503, headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    });
    const assets = (env as Env & { ASSETS?: Fetcher }).ASSETS;
    if (!assets) return unbuilt('No ASSETS binding is configured');
    // A fixed asset path, not the request URL: the request path is a route (`/auth/login`), and
    // asking the assets layer for that would 404. The built entry is what we want, every time.
    const resp = await assets.fetch(new Request(`${AUTH_APP_ORIGIN}${AUTH_APP_ENTRY}`));
    if (!resp.ok) return unbuilt('The auth app has not been built');
    // Rebuilt so the status is ours, and unframeable: no page can trick a click out of Home.
    const page = new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    });
    // The deployment's origin, which the auth app reads to spell every scope's host — the meta
    // every Lumenize page carries.
    const origin = deploymentOrigin(env);
    return new HTMLRewriter().on('head', {
      element(el) { el.prepend(`<meta name="lumenize-origin" content="${origin}">`, { html: true }); },
    }).transform(page);
  };

  // ── Terminal steps — Worker-handled endpoints. No `Guard` suffix: every step that can refuse a
  // caller carries one; these produce the route's answer, and each validates its own credential.
  const emailMagicLinkStep: Step = (request) => handleEmailMagicLink(request, env);
  const magicLinkLookupStep: Step = (request) => handleMagicLinkLookup(request, env);
  const magicLinkConsumeStep: Step = (request) => handleMagicLinkConsume(request, env, hooks);
  const refreshTokenStep: Step = (request) => handleRefreshToken(request, env);
  const homeSummaryStep: Step = (request) => handleHomeSummary(request, env);
  const pendingMembershipStep: Step = (request) => handlePendingMembership(request, env);
  const acceptMembershipStep: Step = (request) => handleAcceptMembership(request, env, hooks);
  const logoutStep: Step = (request) => handleLogout(request, env);
  const signupClaimStep: Step = (request) => handleSignupClaim(request, env);
  const comingSoonStep: Step = (request) => handleComingSoon(request, env);

  // THE TABLE — the registration itself: a route cannot exist without a guard list, an absent
  // entry 404s reaching no handler, and a known path under a wrong verb answers 405 from the
  // runner. 🔒 Every entry states its `method` — the runner treats an absent one as ANY verb,
  // which is right for a consumer indifferent to verbs and wrong for all of these.
  //
  // The shape is DERIVED, not per-route — the same-origin rule on every `POST` but the refresh →
  // the connection limiter → Turnstile on a route that presents no credential → handle — so a new
  // route inherits its list rather than negotiating one.
  {
    const P = NEBULA_AUTH_PREFIX;
    return [
      // ── The auth SPA's navigations — one HTML entry, six addresses ──────────────────────────
      // GETs that render a page and change nothing, so a page that sends the tab here causes
      // nothing, and an emailed link's `GET` consumes nothing. They present no credential and carry
      // no `turnstileGuard`: serving static HTML mints nothing, sends nothing and touches no
      // singleton (the assets layer answers, not the Registry).
      { path: HOME_PATH, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/login`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/signup`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/emails`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/magic-link`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/logout`, method: 'GET', steps: [serveAuthApp] },
      // ── Open routes — no credential, so Turnstile ─────────────────────────────────────────────
      { path: `${P}/claim-universe`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, turnstileGuard, forwardRaw] },
      { path: `${P}/claim-star`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, turnstileGuard, forwardRaw] },
      // The login request. It names no scope because nothing is known about the address yet: the
      // link's page proves the mailbox and Home offers whatever it reaches. ⚠️ Its answer is uniform
      // for member, stranger and bootstrap address alike — the divergence is what would make it an
      // oracle, so nothing downstream may branch on the address.
      { path: `${P}/email-magic-link`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, turnstileGuard, emailMagicLinkStep] },
      // ── The link's page — credentialed by the link's token, so no Turnstile ──────────────────
      // The lookup writes nothing; the `POST` consumes. A garbage token is a singleton lookup, the
      // same faucet as a forged cookie, hence the limiter.
      { path: `${P}/magic-link/lookup`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, magicLinkLookupStep] },
      { path: `${P}/magic-link`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, magicLinkConsumeStep] },
      // ── Cookie routes ─────────────────────────────────────────────────────────────────────────
      // The refresh is the one route a page on another host calls, so it alone skips the
      // same-origin rule; it decides by `Origin` itself and answers CORS for that origin alone.
      { path: `${P}/refresh-token`, method: 'POST', steps: [connectionRateLimitGuard, refreshTokenStep] },
      { path: `${P}/home-summary`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, homeSummaryStep] },
      // Home's consent card and its Accept, the second of two acceptance writers; the link page's
      // `POST` is the first. Both call the Registry's one acceptance method.
      { path: `${P}/pending-membership`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, pendingMembershipStep] },
      { path: `${P}/accept-membership`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, acceptMembershipStep] },
      { path: `${P}/logout`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, logoutStep] },
      // The signup page's claim. Credentialed by the signup-ticket cookie — issued to a click on
      // mail that reached this address — so no Turnstile.
      { path: `${P}/signup`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, signupClaimStep] },
      // Demand signal for an unbuilt surface: a closed enum of tags in, a 204 out, nothing written
      // but a log line. ⚠️ It presents no credential yet carries no `turnstileGuard` — the one
      // deliberate exception to the credential rule, because a challenge here would cost a real
      // interaction to protect a route that mints nothing, sends nothing and stores nothing. The
      // connection limiter is what bounds it.
      { path: `${P}/coming-soon`, method: 'POST', steps: [sameOriginGuard, connectionRateLimitGuard, comingSoonStep] },
      // There is deliberately NO invite row: every invite enters mesh-side through the
      // NebulaAuthFacade (`@lumenize/nebula-auth/facade`), which owns the eligibility verdicts and
      // the bit cap. The invite's link is a magic link like any other, opened by the rows above.
    ];
  }
}

/** Compiled-table cache, keyed on the `env` OBJECT and then the `hooks` object. Production passes
 *  the same pair every request (one compile per isolate); a test passing a doctored `{ ...env }`
 *  spread, or its own recording hooks, gets its own compile, so per-test config actually takes
 *  effect. Never per-request state — the runner builds `routeState` fresh per call. */
const pipelineCache = new WeakMap<object, WeakMap<object, RouteRunner>>();

function authPipeline(env: Env, hooks: ScopeLifecycleHooks): RouteRunner {
  let byHooks = pipelineCache.get(env);
  if (byHooks === undefined) {
    byHooks = new WeakMap();
    pipelineCache.set(env, byHooks);
  }
  let runner = byHooks.get(hooks);
  if (runner === undefined) {
    runner = createRouter(buildAuthRouteTable(env, hooks));
    byHooks.set(hooks, runner);
  }
  return runner;
}

// ============================================
// Boot-time signal for unconfigured protections
// ============================================

/**
 * Every protection that NO-OPS when its config is absent, with the level its absence deserves.
 * The property is stated once — *a protection whose absent config silently disables it* — and the
 * check reads this list, so a new such protection is added HERE, never as its own warn site.
 *
 * The LEVEL is per-entry, and only the level: a protection that is supposed to be on and is not
 * gets `error` (which bypasses the `DEBUG` filter — a production signal); one deliberately off in
 * the current deployment gets `warn` (`TURNSTILE_SECRET_KEY` is intentionally unset in prod,
 * `.dev.vars`, and the vitest configs — an `error` for it would fire on every Registry
 * construction in every test run, training readers to ignore the one signal this exists to create).
 */
export const UNCONFIGURED_PROTECTIONS: readonly { config: string; level: 'error' | 'warn' }[] = [
  { config: 'NEBULA_AUTH_CONNECTION_RATE_LIMITER', level: 'error' },
  { config: 'TURNSTILE_SECRET_KEY', level: 'warn' },
];

/**
 * Report every {@link UNCONFIGURED_PROTECTIONS} entry whose config is absent from `env`. Called
 * from the Registry DO's constructor — the once-per-lifetime hook that sees `env`; a busy
 * singleton is never evicted, so this is a deploy-time notice rather than a per-request one.
 */
export function reportUnconfiguredProtections(env: object): void {
  for (const { config, level } of UNCONFIGURED_PROTECTIONS) {
    if (!(env as Record<string, unknown>)[config]) {
      debug('nebula-auth.Registry.protections')[level](
        'protection unconfigured — it silently no-ops', { protection: config });
    }
  }
}

// ============================================
// Router entry
// ============================================

export async function routeNebulaAuthRequest(
  request: Request,
  env: Env,
  options: RouteNebulaAuthOptions,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  // Home at the root, or a path under the prefix (not the bare prefix itself); anything else is not
  // ours, and the caller's chain composes with `||`, so `undefined` means "try the next one".
  const ours = url.pathname === HOME_PATH
    || (url.pathname.startsWith(NEBULA_AUTH_PREFIX + '/') && url.pathname.length > NEBULA_AUTH_PREFIX.length + 1);
  if (!ours) return undefined;

  try {
    // The route-pipeline table IS the registration — each entry states its complete requirement,
    // in order. A path the table knows under a different verb answers 405 from the runner itself;
    // a path it does not know reaches no handler and 404s here.
    const piped = await authPipeline(env, options.hooks)(request);
    return piped ?? new Response('Not Found', { status: 404 });
  } catch (err) {
    debug('nebula-auth.router.dispatch').error('dispatcher threw', {
      path: url.pathname,
      method: request.method,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
    return jsonError(500, 'internal_error', 'An unexpected error occurred');
  }
}

// ============================================
// Turnstile validation
// ============================================

/** Constant-time compare for the fixed-length Turnstile-bypass token (length short-circuit is fine). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Header carrying the authorized Turnstile-bypass token. */
export const TURNSTILE_BYPASS_HEADER = 'x-lumenize-turnstile-bypass';

/**
 * Whether a request carries the authorized Turnstile-bypass token. Skips ONLY Turnstile (never the
 * magic-link / JWT / scope checks), so it is not an auth bypass. False when the knob is unset or the
 * header is absent/wrong. The token is a secret — never log it.
 */
export function isTurnstileBypassed(request: Request, env: object): boolean {
  const bypassToken = (env as { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN?: string }).NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN;
  if (!bypassToken) return false;
  const presented = request.headers.get(TURNSTILE_BYPASS_HEADER);
  return presented !== null && constantTimeEqual(presented, bypassToken);
}

/**
 * `null` = pass through, a `Response` = refuse. Exactly two pass-through paths: an absent (or
 * empty) `TURNSTILE_SECRET_KEY` — how development and every vitest lane run (the configs bind it
 * `''` explicitly, which wins over a `.dev.vars` value) — and the authorized bypass header.
 * ⚠️ There is deliberately NO `NEBULA_AUTH_TEST_MODE` short-circuit here: one flag that both hands
 * out magic links AND disables the only bound on the unauthenticated endpoints is strictly worse
 * to leak than one that does the first alone (`security.md` — that binding has no second factor),
 * and the short-circuit made a gated endpoint byte-identical to an ungated one under every test
 * lane. A test that wants gating ON binds Cloudflare's always-fail dummy secret
 * (`2x0000000000000000000000000000000AA`) and drives the real path.
 */
async function checkTurnstile(request: Request, env: Env): Promise<Response | null> {
  const secretKey = (env as any).TURNSTILE_SECRET_KEY;
  if (!secretKey) return null; // No Turnstile configured — skip (development + test lanes)

  if (isTurnstileBypassed(request, env)) {
    debug('nebula-auth.router.turnstileBypass').info('Turnstile bypassed via authorized token', {
      path: new URL(request.url).pathname, // pathname only — never the token
    });
    return null;
  }

  const cloned = request.clone();
  let body: Record<string, any>;
  try { body = await cloned.json(); }
  catch (err) {
    debug('nebula-auth.router.turnstileBodyParse').debug('turnstile body not JSON', {
      path: new URL(request.url).pathname, error: err instanceof Error ? err.message : String(err),
    });
    return jsonError(400, 'invalid_request', 'Request body must be JSON');
  }

  const turnstileToken = body['cf-turnstile-response'] ?? body['turnstileToken'];
  if (!turnstileToken) return jsonError(403, 'turnstile_required', 'Turnstile verification token is required');

  const result = await verifyNebulaTurnstileToken(secretKey, turnstileToken);
  if (!result.success) return jsonError(403, 'turnstile_failed', 'Turnstile verification failed');
  return null;
}

// Re-export the token verifier for consuming packages (entrypoint, index).
export { verifyNebulaAccessToken };

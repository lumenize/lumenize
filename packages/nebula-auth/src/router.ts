/**
 * Nebula Auth Worker router — the single entry composed into the default Worker.
 *
 * Since tasks/archive/nebula-auth-surrogate-sub.md dissolved the per-scope `NebulaAuth` DO, this router
 * handles the token/login flows IN THE WORKER (see `worker-token.ts`) over Workers KV + registry RPC,
 * and forwards the registry endpoints (claim / create / scope-summary / delete-scope) to the
 * singleton `NebulaAuthRegistry` DO after Turnstile / JWT gating.
 *
 * @see tasks/archive/nebula-auth-surrogate-sub.md § The seam
 */
import { debug } from '@lumenize/debug';
import { verifyNebulaTurnstileToken } from './turnstile';
import { applyCorsPolicy, addCorsHeaders, type CorsOptions } from '@lumenize/routing';
import { parseId } from './parse-id';
import { createRouter, type RouteEntry, type RouteRunner, type RouteState, type Step } from './route-pipeline';
import { NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME } from './types';
import type { NebulaJwtPayload } from './types';
import { verifyNebulaAccessToken } from './verify';
import {
  handleEmailMagicLink,
  handleAcceptMembership,
  handleLogoutAll,
  handleMagicLinkClick,
  handleAcceptInvite,
  handleRefreshToken,
  handleLogout,
  handleSignupClaim,
  handlePendingMembership,
  handleComingSoon,
  mintNarrowerToken,
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
   * CORS configuration for cross-origin browser callers (see `@lumenize/routing`'s {@link CorsOptions}).
   * `false`/omitted (default): no CORS headers. `true`: reflect any Origin. `{ origin }`: allowlist.
   */
  cors?: CorsOptions;
}

// ============================================
// Response helpers
// ============================================

function jsonError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function json401(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="Nebula", error="${error}", error_description="${description}"`,
    },
  });
}

// ============================================
// The route pipeline — every entry states its complete requirement, in order
// ============================================

/** What `parseScopeGuard` adds: the VALIDATED addressed scope. Consumers read this by role
 *  (`Needs: { scope }`), never the raw `params` capture — a consumer reading `params.scope` before
 *  the parse ran would compare against a present-but-unvalidated capture and refuse or admit on a
 *  scope no grammar can produce, silently. */
type ScopeState = { scope: string };

/** What `verifyJwtGuard` adds: the verified claims every later step reads. Guards read
 *  `claims.access`; handlers take `claims` WHOLE — an authority change records the full acting
 *  token (`sub` + the complete `act` chain + `profileId` + `access`, ADR-016), and a reconstructed
 *  partial claims object projects a wrong-but-believed record. */
type ClaimsState = { claims: NebulaJwtPayload };

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
 * Compiled once per `env` object ({@link authPipeline}'s WeakMap), so production compiles once.
 */
export function buildAuthRouteTable(env: Env): RouteEntry[] {
  /**
   * First on every instance path: refuse a malformed scope segment at the edge, before any step
   * reads it and before anything expensive runs (parsing is local; a `limit()` is not). This is a
   * STEP, not something the table does implicitly — a route carrying no scope simply omits it.
   * The containment predicates are deliberately grammar-free string math (`isAtOrAbove` accepts
   * `{u}.{g}.{s}.{x}`), so this parse is the only thing refusing a scope no grammar can produce.
   */
  const parseScopeGuard: Step<RouteState, ScopeState> = (_request, routeState) => {
    const raw = routeState.params.scope ?? '';
    try { parseId(raw); }
    catch (err) {
      debug('nebula-auth.router.instanceParse').debug('invalid instance name', {
        instanceName: raw, error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(400, 'invalid_instance', 'Invalid instance name format');
    }
    routeState.scope = raw;
  };

  /**
   * Signature + expiry via the `Authorization: Bearer` header ONLY — the retired shared verifier's
   * WebSocket limb (`Sec-WebSocket-Protocol` via `extractWebSocketToken`) is DROPPED, a deliberate,
   * declared narrowing: no handler behind this guard opens a socket, and the Gateway reads the
   * subprotocol directly in `apps/nebula/src/entrypoint.ts`, untouched by this pipeline. A token
   * presented in the subprotocol on these routes now answers 401.
   */
  const verifyJwtGuard: Step<{}, ClaimsState> = async (request, routeState) => {
    const header = request.headers.get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return json401('invalid_request', 'Missing Authorization header with Bearer token');
    const payload = await verifyNebulaAccessToken(token, env);
    if (!payload) return json401('invalid_token', 'Token is invalid or expired');
    routeState.claims = payload;
  };

  /**
   * ONE `sub`-keyed limiter per JWT route, AFTER the verify — everything costly on a token-bearing
   * route (a Registry read, a DO write plus an email) sits after it, and `sub` is the identity the
   * verify establishes. Do not add a pre-verify limiter: a signature check is sub-millisecond local
   * CPU, so a limiter ahead of it pays roughly what it saves. No-ops when the binding is absent
   * ({@link checkRateLimit}); the Registry's boot-time check reports that state.
   */
  const subRateLimitGuard: Step<ClaimsState> = async (_request, routeState) =>
    (await checkRateLimit(env, routeState.claims.sub)) ?? undefined;

  /**
   * ONE connection-keyed limiter per route that presents no token — there is no `sub` yet to key
   * on, and each such route reaches something expensive anonymously: the cookie routes' forged
   * cookie buys a singleton round trip per request (`getRefreshRecord` / `revokeRefreshToken`),
   * the open routes reach `turnstileGuard`'s `siteverify` and the singleton, and `discover` is
   * additionally an enumeration oracle this bounds.
   *
   * Key: `CF-Connecting-IP`. The absent-header fallback is ALLOW, matching `checkRateLimit`'s
   * no-op-when-unbound contract — miniflare supplies no such header, so a test lane would
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

  // NOTE: the passage/dominion guard pair that used to live here served exactly one route —
  // `/auth/:scope/invite` — and died with it when every invite moved to the mesh facade
  // (`@lumenize/nebula-auth/facade` owns those verdicts now). The scoped registry routes that
  // `docs/vision/auth.md` § *The layers a call passes* describes (R4/R5 on `create-galaxy` et al.)
  // re-introduce the pair when their scope moves onto the URL; until then the table has no
  // JWT-bearing scoped row for them to serve, and dead guards cannot be redded by any test.

  // ── Forward terminals — three, NOT one, and which one a row takes is what the edge INJECTS
  // (`raw-comm.md` § *Edge Worker fronting a DO*: forward the ORIGINAL request whenever the edge
  // has nothing to add; rebuild ONLY to inject trusted claims the DO cannot derive). They also
  // declare different `Needs`, which one shared name could not.

  /** Injects NOTHING: `stub.fetch(request)` — no parse, no re-serialize, every header survives,
   *  and the DO reads `url.origin` off it and answers a malformed body with its own 400
   *  `invalid_request` rather than having it absorbed into `{}` at the edge. */
  const forwardRaw: Step = (request) =>
    env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME).fetch(request);

  /**
   * Serve the auth SPA's HTML for a GET navigation.
   *
   * ⚠️ **The Worker has to do this, unlike Studio.** `/auth/*` is listed in `run_worker_first`, so
   * the assets layer never gets first refusal on these paths the way it does for the Studio SPA's
   * bare scope paths (`/{scope}`) — a
   * navigation to `/auth/login` reaches this table or it reaches nothing. That is also why every auth
   * screen is one HTML entry: the SPA reads `location.pathname` and renders login, signup, home or
   * emails from it, so the serving rows differ only in their guards.
   *
   * ⚠️ **Under `wrangler dev` the assets layer is EMPTY by design** (the dev loop builds no dist —
   * the lanes `mkdir` it and the browser is served by vite instead), so this returns a 503 rather
   * than a confusing 404. A rendered check against a Worker-served page belongs in a lane that
   * built the dist.
   */
  const serveAuthApp: Step = async () => {
    const assets = (env as Env & { ASSETS?: Fetcher }).ASSETS;
    if (!assets) return jsonError(503, 'assets_unavailable', 'No ASSETS binding is configured');
    // A fixed asset path, not the request URL: the request path is a route (`/auth/u.g/home`), and
    // asking the assets layer for that would 404. The built entry is what we want, every time.
    const resp = await assets.fetch(new Request(`${AUTH_APP_ORIGIN}${AUTH_APP_ENTRY}`));
    if (!resp.ok) return jsonError(503, 'assets_unavailable', 'The auth app has not been built');
    // Rebuilt so the status is ours and the body streams through untouched.
    return new Response(resp.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  };

  /**
   * Injects the verified `profileId` + `sub` — the person-scoped reads' input.
   *
   * ⚠️ **Refuses a token carrying `act`.** These answer for a PERSON across every address and scope
   * they hold, and an impersonation token deliberately carries the SUBJECT's `profileId`
   * (`mint-narrower-token`) — so without this an admin impersonating someone would receive every
   * tenancy that person holds anywhere, including scopes the admin has no reach into. Presence
   * only, never identity, per `security.md`'s delegation rule: the licensed test is that
   * impersonation would otherwise grant the actor something they could not do themselves, and
   * reading another organization's tenancy list is exactly that.
   */
  const forwardWithSubject: Step<ClaimsState> = async (request, routeState) => {
    if (routeState.claims.act) {
      return jsonError(403, 'forbidden', 'This view answers for a person and is not available under impersonation');
    }
    const body = (await readJsonBody(request)) ?? {};
    // ⚠️ Trust boundary — ASSIGN, never merge (see forwardWithAccess).
    body.verifiedProfileId = routeState.claims.profileId;
    body.verifiedSub = routeState.claims.sub;
    return forwardToRegistry(request, env, body);
  };

  /** Injects the verified `access` claim (a rebuild, which is what licenses it). */
  const forwardWithAccess: Step<ClaimsState> = async (request, routeState) => {
    const body = (await readJsonBody(request)) ?? {}; // some of these carry no body
    // ⚠️ Trust boundary — ASSIGN, never merge (no `??=`, no spread): the carrier is a
    // client-supplied JSON body, and the registry's guards are presence-only, so they cannot tell
    // an injected value from a client-supplied one.
    body.verifiedAccess = routeState.claims.access;
    return forwardToRegistry(request, env, body);
  };

  /** Injects `verifiedAccess` + `callerSub` + `callerClaims` — ADR-016's fail-closed input for the
   *  destructive routes: a destructive action records the FULL verified claims of the acting
   *  token, and under impersonation `callerSub` alone names the person acted UPON as the actor.
   *  (`delete-scope-plan` writes no record and ignores `callerClaims`.) */
  const forwardWithClaims: Step<ClaimsState> = async (request, routeState) => {
    const body = await readJsonBody(request);
    if (!body) return jsonError(400, 'invalid_request', 'Request body must be JSON');
    // ⚠️ Trust boundary — ASSIGN, never merge (see forwardWithAccess). `executeScopeDeletion`
    // takes the claims as an explicit PARAMETER rather than reading a body key, so a future
    // branch that forgets this line fails closed instead of silently trusting input.
    body.verifiedAccess = routeState.claims.access;
    body.callerSub = routeState.claims.sub;
    body.callerClaims = routeState.claims;
    return forwardToRegistry(request, env, body);
  };

  // ── Terminal steps — Worker-handled endpoints. No `Guard` suffix: every step that can refuse a
  // caller carries one; these produce the route's answer. Handlers take `routeState.claims` WHOLE
  // (see {@link ClaimsState}); the flow handlers validate their own token/cookie credential.
  const mintNarrowerTokenStep: Step<ClaimsState> = (request, routeState) =>
    mintNarrowerToken(request, env, routeState.claims);
  // `scope` on the two click handlers only picks a landing surface for a FAILED consume's error
  // redirect; on `logout` it selects the cookie PATH. None of the three names a target — which is
  // why these rows carry no scope guard (accepted `docs/vision/auth.md` § *Endpoints that present
  // no access token*).
  const handleMagicLinkClickStep: Step<ScopeState> = (request, routeState) =>
    handleMagicLinkClick(request, env, routeState.scope);
  /** The same click handler with no scope segment to pass — the link named none. */
  const handleScopelessMagicLinkClickStep: Step = (request) => handleMagicLinkClick(request, env);
  const handleAcceptInviteStep: Step<ScopeState> = (request, routeState) =>
    handleAcceptInvite(request, env, routeState.scope);
  /** The same handler with no scope to pass — see the scope-less row's comment in the table. */
  const handleScopelessMagicLinkStep: Step = (request) => handleEmailMagicLink(request, env);
  const handleRefreshTokenStep: Step = (request) => handleRefreshToken(request, env);
  const handleLogoutStep: Step<ScopeState> = (request, routeState) =>
    handleLogout(request, env, routeState.scope);
  /** The scope segment selects which cookie the browser sends; the handler re-resolves it server-side. */
  const handleAcceptMembershipStep: Step<ScopeState> = (request) => handleAcceptMembership(request, env);
  /** Same shape as accept: the segment picks the cookie, the handler re-resolves it server-side. */
  const handleLogoutAllStep: Step<ScopeState> = (request) => handleLogoutAll(request, env);
  /** The ticket rides in a cookie, so the handler needs nothing from the route state. */
  const handleSignupClaimStep: Step = (request) => handleSignupClaim(request, env);
  /** Same shape as accept: the segment picks the cookie, the handler re-resolves it server-side. */
  const handlePendingMembershipStep: Step<ScopeState> = (request) => handlePendingMembership(request, env);
  const handleComingSoonStep: Step = (request) => handleComingSoon(request, env);

  // THE TABLE — the registration itself: a route cannot exist without a guard list, an absent
  // entry 404s reaching no handler, and a known path under a wrong verb answers 405 from the
  // runner. 🔒 Every entry states its `method` — the runner treats an absent one as ANY verb,
  // which is right for a consumer indifferent to verbs and wrong for all of these.
  //
  // The shape is DERIVED, not per-route — parse the segment → one limiter (keyed by whatever
  // identity exists at that point) → prove identity → prove passage → ask the endpoint's own
  // question → handle — so a new route inherits its list rather than negotiating one.
  {
    const P = NEBULA_AUTH_PREFIX;
    return [
      // ── Scope-less registry paths — forwarded to the Registry DO after edge gating ──────────
      { path: `${P}/claim-universe`, method: 'POST', steps: [connectionRateLimitGuard, turnstileGuard, forwardRaw] },
      { path: `${P}/claim-star`, method: 'POST', steps: [connectionRateLimitGuard, turnstileGuard, forwardRaw] },
      // The scope on these arrives in the BODY, deliberately (moving it onto the URL is a separate
      // task); the Registry DO keeps its own dominion checks, so their edge list ends at identity.
      // The Home screen's one read, and `expand` for a node opened past the frontier. Both are
      // person-scoped (`profileId`-keyed), so neither carries a target scope for R2/R5 to decide
      // about — the answer IS the set, exactly as the retired `my-scopes` was.
      { path: `${P}/scope-summary`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithSubject] },
      { path: `${P}/expand-scope`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithSubject] },
      { path: `${P}/create-galaxy`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithAccess] },
      { path: `${P}/create-star`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithAccess] },
      { path: `${P}/delete-scope`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithClaims] },
      { path: `${P}/delete-scope-plan`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, forwardWithClaims] },
      // SCOPE-LESS by design: the old URL segment was vestigial (the handler never received it, and
      // the only production caller posted their OWN scope, so containment compared a scope against
      // itself and dominion there reduced to the bare bit — the dead operand this table convicts
      // elsewhere). Every authorization decision is the handler's `canMintFor` against the SUBJECT's
      // scope; there is no URL scope for a guard to compare.
      { path: `${P}/mint-narrower-token`, method: 'POST', steps: [verifyJwtGuard, subRateLimitGuard, mintNarrowerTokenStep] },
      // ── Instance paths — token/cookie flows handled in the Worker ────────────────────────────
      // The two GET navigations carry a hashed one-time token; consuming one is a singleton
      // lookup, so a garbage token in a URL is the same faucet as a forged cookie — hence the
      // connection limiter on every row here.
      // The scope-less click — the other half of the front door. It presents a one-time token, which
      // is a credential, so no Turnstile: the token IS the proof that mail reached this address.
      { path: `${P}/magic-link`, method: 'GET', steps: [connectionRateLimitGuard, handleScopelessMagicLinkClickStep] },
      { path: `${P}/:scope/magic-link`, method: 'GET', steps: [parseScopeGuard, connectionRateLimitGuard, handleMagicLinkClickStep] },
      { path: `${P}/:scope/accept-invite`, method: 'GET', steps: [parseScopeGuard, connectionRateLimitGuard, handleAcceptInviteStep] },
      // The login request — the ONLY front door, and it names no scope because nothing is known
      // about the address yet: the click proves the mailbox and Home offers whatever it reaches.
      // ⚠️ Its answer is uniform for member, stranger and bootstrap address alike — the divergence
      // is what would make it an oracle, so nothing downstream may branch on the address.
      // ⚠️ A `/:scope/email-magic-link` sibling existed until 2026-09-01. Naming a scope up front is
      // what forced a caller to KNOW their scope before proving anything — the enumeration this
      // design deletes — so it is retired, not merely unused. The optional scope parameter that
      // survived that retirement is gone too (2026-09-02): the note here claimed the CLAIM paths
      // passed one, and they never did — `claimUniverse`/`claimStar` compose their own rows through
      // `#insertMagicLinkRow` and never reach this handler.
      // Presents no credential of any kind, so it carries `turnstileGuard` like its scoped sibling.
      // ⚠️ Its answer is uniform for member, stranger and bootstrap address alike — the divergence
      // is what would make it an oracle, so nothing downstream may branch on the address.
      { path: `${P}/email-magic-link`, method: 'POST', steps: [connectionRateLimitGuard, turnstileGuard, handleScopelessMagicLinkStep] },
      { path: `${P}/:scope/refresh-token`, method: 'POST', steps: [parseScopeGuard, connectionRateLimitGuard, handleRefreshTokenStep] },
      // Acceptance — the ONE writer, credentialed by the membership's own path-scoped cookie (so no
      // Turnstile: the cookie is a credential, and it reached this browser only via a proved mailbox).
      { path: `${P}/:scope/accept-membership`, method: 'POST', steps: [parseScopeGuard, connectionRateLimitGuard, handleAcceptMembershipStep] },
      // The consent modal's inputs, for a membership that has no session yet — same cookie, same
      // server-side re-resolution as accept. Without it Home cannot render the modal it exists for.
      { path: `${P}/:scope/pending-membership`, method: 'POST', steps: [parseScopeGuard, connectionRateLimitGuard, handlePendingMembershipStep] },
      { path: `${P}/:scope/logout`, method: 'POST', steps: [parseScopeGuard, connectionRateLimitGuard, handleLogoutStep] },
      // Logout everywhere for this address. Same credential as `logout` — the calling scope's own
      // cookie — because a scope-less path would receive no cookie at all and would have to take the
      // address from the client, which must never decide whose sessions end.
      { path: `${P}/:scope/logout-all`, method: 'POST', steps: [parseScopeGuard, connectionRateLimitGuard, handleLogoutAllStep] },
      // ── The auth SPA's navigations — one HTML entry, four addresses ─────────────────────────
      // GETs that render a page and read nothing. They present no credential, and they carry no
      // `turnstileGuard`: there is nothing to protect, since serving static HTML mints nothing,
      // sends nothing and touches no singleton (the assets layer answers, not the Registry).
      { path: `${P}/login`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/signup`, method: 'GET', steps: [serveAuthApp] },
      { path: `${P}/emails`, method: 'GET', steps: [serveAuthApp] },
      // The scope segment is format-validated so a malformed one 400s here rather than rendering a
      // shell that will fail its own bootstrap; the page's data still comes from `scope-summary`,
      // which re-derives everything server-side.
      { path: `${P}/:scope/home`, method: 'GET', steps: [parseScopeGuard, serveAuthApp] },
      // The fallback slug screen's claim. Credentialed by the signup-ticket cookie — issued to a
      // click on mail that reached this address — so no Turnstile, on the same footing as the
      // other cookie routes.
      { path: `${P}/signup`, method: 'POST', steps: [connectionRateLimitGuard, handleSignupClaimStep] },
      // Demand signal for an unbuilt surface: a closed enum of tags in, a 204 out, nothing written
      // but a log line. ⚠️ It presents no credential yet carries no `turnstileGuard` — the one
      // deliberate exception to the credential rule, because a challenge here would cost a real
      // interaction to protect a route that mints nothing, sends nothing and stores nothing. The
      // connection limiter is what bounds it.
      { path: `${P}/coming-soon`, method: 'POST', steps: [connectionRateLimitGuard, handleComingSoonStep] },
      // There is deliberately NO `/auth/:scope/invite` row: every invite enters mesh-side through
      // the NebulaAuthFacade (`@lumenize/nebula-auth/facade`), which owns the eligibility verdicts
      // and the bit cap. Only the session lifecycle stays HTTP — the accept-invite CLICK above is
      // unauthenticated by nature, so the issuing side is what moved.
    ];
  }
}

/** Compiled-table cache, keyed on the `env` OBJECT. Production passes the same `env` every request
 *  (one compile per isolate); a test passing a doctored `{ ...env }` spread gets its own compile,
 *  so per-test gating config actually takes effect. Never per-request state — the runner builds
 *  `routeState` fresh per call. */
const pipelineCache = new WeakMap<object, RouteRunner>();

function authPipeline(env: Env): RouteRunner {
  let runner = pipelineCache.get(env);
  if (runner === undefined) {
    runner = createRouter(buildAuthRouteTable(env));
    pipelineCache.set(env, runner);
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
  { config: 'NEBULA_AUTH_RATE_LIMITER', level: 'error' },
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
  options: RouteNebulaAuthOptions = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);

  // Not under the prefix (or the bare prefix itself) → not ours; the caller's router chain
  // composes with `||`, so `undefined` means "try the next one".
  if (!url.pathname.startsWith(NEBULA_AUTH_PREFIX + '/')) return undefined;
  if (url.pathname.length === NEBULA_AUTH_PREFIX.length + 1) return undefined;

  const corsDecision = applyCorsPolicy(request, options.cors ?? false);
  if (corsDecision.earlyResponse) return corsDecision.earlyResponse;
  const allowedOrigin = corsDecision.allowedOrigin;
  const withCors = (response: Response): Response =>
    allowedOrigin ? addCorsHeaders(response, allowedOrigin) : response;

  try {
    // The route-pipeline table IS the registration — each entry states its complete requirement,
    // in order. A path the table knows under a different verb answers 405 from the runner itself;
    // a path it does not know reaches no handler and 404s here.
    const piped = await authPipeline(env)(request);
    if (piped !== undefined) return withCors(piped);
    return withCors(new Response('Not Found', { status: 404 }));
  } catch (err) {
    debug('nebula-auth.router.dispatch').error('dispatcher threw', {
      path: url.pathname,
      method: request.method,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
    return withCors(jsonError(500, 'internal_error', 'An unexpected error occurred'));
  }
}

// ============================================
// Forward plumbing — the registry-bound terminals' shared pieces
// ============================================

/** Rebuild-and-forward to the registry DO — used ONLY by the injecting terminals
 *  (`forwardWithAccess` / `forwardWithClaims`), because a rebuild is licensed only to inject
 *  trusted claims the DO cannot derive (`raw-comm.md`). Note a rebuild drops every header but the
 *  one set here; the open rows forward RAW for exactly that reason. */
function forwardToRegistry(request: Request, env: Env, body: Record<string, any>): Promise<Response> {
  const registryStub = env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
  return registryStub.fetch(new Request(request.url, {
    method: request.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function readJsonBody(request: Request): Promise<Record<string, any> | null> {
  try { return await request.json() as Record<string, any>; }
  catch { return null; }
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

// ============================================
// Rate limiting
// ============================================

async function checkRateLimit(
  env: Env & { NEBULA_AUTH_RATE_LIMITER?: RateLimit }, sub: string,
): Promise<Response | null> {
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (!rateLimiter) return null;
  const { success } = await rateLimiter.limit({ key: sub });
  return success ? null : jsonError(429, 'rate_limited', 'Too many requests. Please try again later.');
}

// Re-export the token verifier for consuming packages (entrypoint, index).
export { verifyNebulaAccessToken };

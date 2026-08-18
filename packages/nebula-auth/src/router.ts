/**
 * Nebula Auth Worker router — the single entry composed into the default Worker.
 *
 * Since tasks/nebula-auth-surrogate-sub.md dissolved the per-scope `NebulaAuth` DO, this router
 * handles the token/login flows IN THE WORKER (see `worker-token.ts`) over Workers KV + registry RPC,
 * and forwards the registry endpoints (discover / claim / create / my-scopes / delete-scope) to the
 * singleton `NebulaAuthRegistry` DO after Turnstile / JWT gating.
 *
 * @see tasks/nebula-auth-surrogate-sub.md § The seam
 */
import { debug } from '@lumenize/debug';
import { verifyNebulaTurnstileToken } from './turnstile';
import { applyCorsPolicy, addCorsHeaders, type CorsOptions } from '@lumenize/routing';
import { hasDominionOver, hasPassageInto, parseId } from './parse-id';
import { createRouter, type RouteRunner, type RouteState, type Step } from './route-pipeline';
import { NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME } from './types';
import type { NebulaJwtPayload } from './types';
import { verifyNebulaAccessToken } from './verify';
import {
  handleEmailMagicLink,
  handleMagicLinkClick,
  handleAcceptInvite,
  handleRefreshToken,
  handleLogout,
  handleInvite,
  mintNarrowerToken,
} from './worker-token';

/** Options for {@link routeNebulaAuthRequest}. */
export interface RouteNebulaAuthOptions {
  /**
   * CORS configuration for cross-origin browser callers (see `@lumenize/routing`'s {@link CorsOptions}).
   * `false`/omitted (default): no CORS headers. `true`: reflect any Origin. `{ origin }`: allowlist.
   */
  cors?: CorsOptions;
}

// Registry endpoint suffixes (exact match after the prefix) — forwarded to the registry DO.
// `claim-*` = open self-signup (mints the claiming admin identity, emails); `create-*` = admin-gated, minting no identity.
const REGISTRY_ENDPOINTS = new Set([
  'discover', 'claim-universe', 'claim-star', 'create-galaxy', 'create-star', 'my-scopes',
  'delete-scope-plan', 'delete-scope',
]);

// Instance-path auth flows handled IN THE WORKER (no JWT — token/cookie validated by the flow itself).
const AUTH_FLOW_SUFFIXES = new Set(['email-magic-link', 'magic-link', 'accept-invite', 'refresh-token', 'logout']);

// Turnstile-gated endpoints.
//
// 🔒 Every UNAUTHENTICATED registry endpoint must be here. This `Set` is the ONLY bound on them:
// `checkRateLimit` keys on the verified `payload.sub`, so it never runs on a path with no JWT. The
// gate lives here and not in the registry method, so a method copied from an already-listed sibling
// arrives UNGATED and nothing reds — for `claim-star` that would mean an open mutation endpoint that
// mints `scopeAdmin` identities and sends mail. (Turnstile bounds scripted abuse — mass squatting, mail
// amplification — it is not an approval step.)
const TURNSTILE_ENDPOINTS = new Set(['email-magic-link', 'claim-universe', 'claim-star', 'discover']);

/**
 * Whether `endpoint` is Turnstile-gated.
 *
 * Exported for the same reason as {@link isTurnstileBypassed}: the decision is otherwise unassertable.
 * `checkTurnstile` short-circuits on `NEBULA_AUTH_TEST_MODE` **before** consulting this set, and every
 * test lane sets that binding — so no end-to-end assertion in the default project can tell a gated
 * endpoint from an ungated one. Set membership is the only thing that reds on the regression.
 */
export function isTurnstileGated(endpoint: string): boolean {
  return TURNSTILE_ENDPOINTS.has(endpoint);
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
// Path parsing
// ============================================

function parsePath(pathname: string):
  | { type: 'registry'; endpoint: string }
  | { type: 'instance'; instanceName: string; endpoint: string }
  | null {
  const prefix = NEBULA_AUTH_PREFIX;
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length + 1); // after '/auth/'
  if (!rest) return null;

  if (REGISTRY_ENDPOINTS.has(rest)) return { type: 'registry', endpoint: rest };

  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { type: 'instance', instanceName: rest, endpoint: '' };
  return { type: 'instance', instanceName: rest.slice(0, slashIdx), endpoint: rest.slice(slashIdx + 1) };
}

function endpointSuffix(endpoint: string): string {
  const lastSlash = endpoint.lastIndexOf('/');
  return lastSlash === -1 ? endpoint : endpoint.slice(lastSlash + 1);
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
 * Build the compiled route table for `env`.
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
function buildAuthPipeline(env: Env): RouteRunner {
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
   * The passage boundary — the same verdict the mesh boundary computes (`hasPassageInto`: the
   * caller's own scope at or below the addressed one, OR dominion over it).
   *
   * ⚠️ Strictly SUBSUMED on both of today's routes: `dominionOverScopeGuard` follows on each, and
   * dominion implies passage, so this guard can never DECIDE a verdict here. It is a uniform
   * boundary step, present so a route whose endpoint guard is weaker inherits the boundary rule
   * (which is what `/invite` becomes when it opens to members), and because accepted
   * `docs/vision/auth.md` § *The Registry* requires the same two rules as a mesh node. Not dead
   * code nobody noticed.
   */
  const passageGuard: Step<ScopeState & ClaimsState> = (request, routeState) => {
    const { claims, scope } = routeState;
    if (!hasPassageInto(claims.access, scope)) {
      debug('nebula-auth.router.guard.denied').warn('passage refused', {
        route: new URL(request.url).pathname, rule: 'passage', code: 'insufficient_scope',
        sub: claims.sub, authScope: claims.access.authScope, scope,
      });
      return jsonError(403, 'insufficient_scope',
        `Token scope "${claims.access.authScope}" has no passage into "${scope}"`);
    }
  };

  /**
   * The endpoint's own question on both routes today: dominion over the URL's instance —
   * `hasDominionOver(claims.access, scope)`, the bare bit ∧ containment as ONE call.
   *
   * ⚠️ `…OverScope`, never `…OverTarget`: this guard takes the URL's INSTANCE, and it sits one file
   * from the narrower-token mint's eligibility check, whose second argument is the SUBJECT's scope —
   * the same call, the wrong second argument, is the substitution a name must not invite.
   */
  const dominionOverScopeGuard: Step<ScopeState & ClaimsState> = (request, routeState) => {
    const { claims, scope } = routeState;
    if (!hasDominionOver(claims.access, scope)) {
      // POST-VERDICT message pick — the refusal names WHICH rule failed (`forbidden` = you lack the
      // authority; `insufficient_scope` = you have authority but asked beyond your scope). The bit
      // read here cannot change an authorization outcome: the single `hasDominionOver` call above
      // has already decided, so this is a message branch, not a bare-bit gate. Both messages name
      // only values the caller already holds (ADR-008).
      const code = claims.access.scopeAdmin ? 'insufficient_scope' : 'forbidden';
      // SHARED `denied` log — this guard serves every route whose list carries it, so the payload
      // carries the route (several criteria assert through the debug sink).
      debug('nebula-auth.router.guard.denied').warn('dominion refused', {
        route: new URL(request.url).pathname, rule: 'dominion', code,
        sub: claims.sub, authScope: claims.access.authScope, scope,
      });
      return code === 'insufficient_scope'
        ? jsonError(403, code,
            `Token scope "${claims.access.authScope}" does not administer "${scope}"`)
        : jsonError(403, code,
            `Admin access required: token scope "${claims.access.authScope}" holds no scopeAdmin over "${scope}"`);
    }
  };

  // Terminal steps — Worker-handled endpoints. No `Guard` suffix: every step that can refuse a
  // caller carries one; these produce the route's answer. Handlers take `routeState.claims` WHOLE
  // (see {@link ClaimsState}).
  const handleInviteStep: Step<ScopeState & ClaimsState> = (request, routeState) =>
    handleInvite(request, env, routeState.scope, routeState.claims);
  const mintNarrowerTokenStep: Step<ScopeState & ClaimsState> = (request, routeState) =>
    mintNarrowerToken(request, env, routeState.claims);

  // The table IS the registration: a route cannot exist without a guard list, and an absent entry
  // 404s rather than falling through to any handler. Every entry states its `method` — the runner
  // treats an absent one as ANY verb, which is wrong for all of these.
  return createRouter([
    {
      path: `${NEBULA_AUTH_PREFIX}/:scope/invite`, method: 'POST',
      steps: [parseScopeGuard, verifyJwtGuard, subRateLimitGuard, passageGuard, dominionOverScopeGuard, handleInviteStep],
    },
    {
      path: `${NEBULA_AUTH_PREFIX}/:scope/mint-narrower-token`, method: 'POST',
      steps: [parseScopeGuard, verifyJwtGuard, subRateLimitGuard, passageGuard, dominionOverScopeGuard, mintNarrowerTokenStep],
    },
  ]);
}

/** Compiled-table cache, keyed on the `env` OBJECT. Production passes the same `env` every request
 *  (one compile per isolate); a test passing a doctored `{ ...env }` spread gets its own compile,
 *  so per-test gating config actually takes effect. Never per-request state — the runner builds
 *  `routeState` fresh per call. */
const pipelineCache = new WeakMap<object, RouteRunner>();

function authPipeline(env: Env): RouteRunner {
  let runner = pipelineCache.get(env);
  if (runner === undefined) {
    runner = buildAuthPipeline(env);
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

  const parsed = parsePath(url.pathname);
  if (!parsed) return undefined;

  const corsDecision = applyCorsPolicy(request, options.cors ?? false);
  if (corsDecision.earlyResponse) return corsDecision.earlyResponse;
  const allowedOrigin = corsDecision.allowedOrigin;
  const withCors = (response: Response): Response =>
    allowedOrigin ? addCorsHeaders(response, allowedOrigin) : response;

  try {
    // The route-pipeline table owns every route migrated onto it (each entry states its complete
    // requirement, in order); anything it does not match falls through to the suffix dispatch
    // below. A path the table knows under a different verb answers 405 from the runner itself.
    const piped = await authPipeline(env)(request);
    if (piped !== undefined) return withCors(piped);

    if (parsed.type === 'registry') {
      return withCors(await handleRegistryPath(request, env, parsed.endpoint));
    }
    return withCors(await handleInstancePath(request, env, parsed.instanceName, parsed.endpoint));
  } catch (err) {
    debug('nebula-auth.router.dispatch').error('dispatcher threw', {
      path: url.pathname,
      method: request.method,
      parsedType: parsed.type,
      parsedTarget: parsed.type === 'registry' ? parsed.endpoint : parsed.instanceName,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
    return withCors(jsonError(500, 'internal_error', 'An unexpected error occurred'));
  }
}

// ============================================
// Registry path handler — Turnstile / JWT gating, then forward to the registry DO
// ============================================

/** Forward to the registry DO with the given body reconstructed (self-contained; avoids stream races). */
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

async function handleRegistryPath(request: Request, env: Env, endpoint: string): Promise<Response> {
  // Registry endpoints are POST-only. Forward a non-POST raw (no body-injection, which would build an
  // invalid GET-with-body) so the registry DO answers with its own 405.
  if (request.method !== 'POST') {
    return env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME).fetch(request);
  }

  if (TURNSTILE_ENDPOINTS.has(endpoint)) {
    const turnstileResult = await checkTurnstile(request, env);
    if (turnstileResult) return turnstileResult;
  }

  // create-galaxy / create-star / my-scopes — authenticated admin ops; inject the verified access claim.
  if (endpoint === 'create-galaxy' || endpoint === 'create-star' || endpoint === 'my-scopes') {
    const jwtResult = await checkJwtForRegistry(request, env);
    if ('error' in jwtResult) return jwtResult.error;
    const body = (await readJsonBody(request)) ?? {}; // my-scopes carries no body
    body.verifiedAccess = jwtResult.payload.access;
    return forwardToRegistry(request, env, body);
  }

  // delete-scope(-plan) — inject BOTH the verified access claim AND the verified caller `sub` (the
  // registry's caller-exclusion in the bounded `affectedUsers` warning needs a TRUSTED caller identity —
  // never client-supplied;
  // `sub`, resolved to email inside the registry, replaces the retired JWT `email` claim).
  if (endpoint === 'delete-scope-plan' || endpoint === 'delete-scope') {
    const jwtResult = await checkJwtForRegistry(request, env);
    if ('error' in jwtResult) return jwtResult.error;
    const body = await readJsonBody(request);
    if (!body) return jsonError(400, 'invalid_request', 'Request body must be JSON');
    // ⚠️ **Trust boundary — ASSIGN, never merge.** The carrier is a client-supplied JSON body this
    // router mutates, and the registry's guards are presence-only, so they cannot tell an injected
    // value from a client-supplied one. Assign unconditionally (no `??=`, no spread-merge), and note
    // that `executeScopeDeletion` takes the claims as an explicit PARAMETER rather than reading a body
    // key — so a future branch that forgets this line fails closed instead of silently trusting input.
    body.verifiedAccess = jwtResult.payload.access;
    body.callerSub = jwtResult.payload.sub;
    // ADR-016: a destructive action records the FULL verified claims of the ACTING token — the
    // subject `sub`, the complete `act` chain, `profileId`, and the `access` entry. Under
    // impersonation `callerSub` alone is the person acted UPON, so a `sub`-only record names them as
    // the person who acted. (`delete-scope-plan` writes no record and ignores this field.)
    body.callerClaims = jwtResult.payload;
    return forwardToRegistry(request, env, body);
  }

  // discover / claim-universe / claim-star — open (Turnstile only). These inject NOTHING, so forward
  // the ORIGINAL request rather than rebuilding it: no parse, no re-serialize, every header survives,
  // and the DO reads `url.origin` off it to build the emailed link. `checkTurnstile` clone()s for its
  // body read, so the body is still intact here. (Rebuilding also silently dropped every header but
  // Content-Type, and made a malformed body indistinguishable from an empty one — the registry's own
  // JSON guard now owns that, returning 400 `invalid_request` instead of a 500.)
  return env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME).fetch(request);
}

// ============================================
// Instance path handler — token flows in the Worker
// ============================================

async function handleInstancePath(
  request: Request, env: Env, instanceName: string, endpoint: string,
): Promise<Response> {
  try { parseId(instanceName); }
  catch (err) {
    debug('nebula-auth.router.instanceParse').debug('invalid instance name', {
      instanceName, error: err instanceof Error ? err.message : String(err),
    });
    return jsonError(400, 'invalid_instance', 'Invalid instance name format');
  }

  const suffix = endpointSuffix(endpoint);

  // Auth flows — handled in the Worker (Turnstile on email-magic-link).
  if (AUTH_FLOW_SUFFIXES.has(suffix)) {
    if (suffix === 'email-magic-link') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      const turnstileResult = await checkTurnstile(request, env);
      if (turnstileResult) return turnstileResult;
      return handleEmailMagicLink(request, env, instanceName);
    }
    // `instanceName` is passed only so a FAILED consume can pick a landing surface for its error
    // redirect — the success path derives that from the consumed token's scope instead.
    if (suffix === 'magic-link' && request.method === 'GET') return handleMagicLinkClick(request, env, instanceName);
    if (suffix === 'accept-invite' && request.method === 'GET') return handleAcceptInvite(request, env, instanceName);
    if (suffix === 'refresh-token' && request.method === 'POST') return handleRefreshToken(request, env);
    if (suffix === 'logout' && request.method === 'POST') return handleLogout(request, env, instanceName);
    return new Response('Method Not Allowed', { status: 405 });
  }

  // The authenticated instance routes (`invite`, `mint-narrower-token`) live in the route-pipeline
  // table, which ran before this dispatch — an unrecognized suffix lands here and 404s, reaching
  // no handler.
  return new Response('Not Found', { status: 404 });
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

async function checkTurnstile(request: Request, env: Env): Promise<Response | null> {
  if ((env as any).NEBULA_AUTH_TEST_MODE === 'true') return null;

  const secretKey = (env as any).TURNSTILE_SECRET_KEY;
  if (!secretKey) return null; // No Turnstile configured — skip (development)

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
// JWT verification for registry paths
// ============================================

/** Verify a Bearer access token for a registry admin op (no instance gate; the registry enforces admin). */
async function checkJwtForRegistry(
  request: Request,
  env: Env & { NEBULA_AUTH_RATE_LIMITER?: RateLimit },
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: json401('invalid_request', 'Missing Authorization header with Bearer token') };
  }
  const payload = await verifyNebulaAccessToken(authHeader.slice(7), env);
  if (!payload) return { error: json401('invalid_token', 'Token is invalid or expired') };

  const rateLimited = await checkRateLimit(env, payload.sub);
  if (rateLimited) return { error: rateLimited };
  return { payload };
}

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

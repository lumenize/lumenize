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
// ⚠️ The `/client` subpath, deliberately — this module is re-exported from `@lumenize/nebula-auth`'s
// widely-imported index, so a root-barrel import would drag `cloudflare:workers` through it (the
// bare-`SyntaxError` failure `packaging.md` documents). mesh owns this wire protocol: it PRODUCES
// the subprotocol in `lumenize-client.ts` and parses it here.
import { extractWebSocketToken } from '@lumenize/mesh/client';
import { applyCorsPolicy, addCorsHeaders, type CorsOptions } from '@lumenize/routing';
import { matchAccess, parseId } from './parse-id';
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

// Instance-path authenticated endpoints (JWT verified here, then handled in the Worker).
const AUTHENTICATED_SUFFIXES = new Set(['invite', 'mint-narrower-token']);

// Turnstile-gated endpoints.
//
// 🔒 Every UNAUTHENTICATED registry endpoint must be here. This `Set` is the ONLY bound on them:
// `checkRateLimit` keys on the verified `payload.sub`, so it never runs on a path with no JWT. The
// gate lives here and not in the registry method, so a method copied from an already-listed sibling
// arrives UNGATED and nothing reds — for `claim-star` that would mean an open mutation endpoint that
// mints `isAdmin` identities and sends mail. (Turnstile bounds scripted abuse — mass squatting, mail
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
    // authority `sub`, the complete `act` chain, `profileId`, and the `access` entry. Under
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

  // Authenticated flows — verify JWT (scope match) + rate limit, then handle in the Worker.
  if (AUTHENTICATED_SUFFIXES.has(suffix) && request.method === 'POST') {
    const authResult = await verifyInstanceJwt(request, env, instanceName);
    if ('error' in authResult) return authResult.error;
    if (suffix === 'invite') return handleInvite(request, env, instanceName, authResult.payload);
    return mintNarrowerToken(request, env, authResult.payload);
  }

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
// JWT verification for instance + registry paths
// ============================================

/** Verify a Bearer/WS access token AND gate it to the target instance's scope (no adminApproved gate). */
async function verifyInstanceJwt(
  request: Request,
  env: Env & { NEBULA_AUTH_RATE_LIMITER?: RateLimit },
  instanceName: string,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const token = isWebSocket
    ? extractWebSocketToken(request)
    : (request.headers.get('Authorization')?.startsWith('Bearer ')
      ? request.headers.get('Authorization')!.slice(7)
      : null);

  if (!token) return { error: json401('invalid_request', 'Missing Authorization header with Bearer token') };

  const payload = await verifyNebulaAccessToken(token, env);
  if (!payload) return { error: json401('invalid_token', 'Token is invalid or expired') };

  // The token must grant access to the target instance.
  if (!matchAccess(payload.access.authScopePattern, instanceName)) {
    return {
      error: jsonError(403, 'insufficient_scope',
        `Token access "${payload.access.authScopePattern}" does not grant access to "${instanceName}"`),
    };
  }

  const rateLimited = await checkRateLimit(env, payload.sub);
  if (rateLimited) return { error: rateLimited };
  return { payload };
}

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

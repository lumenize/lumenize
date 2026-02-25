/**
 * Auth hooks for routeDORequest — Nebula multi-tenant variant
 *
 * Forked from @lumenize/auth createRouteDORequestAuthHooks.
 * Key differences:
 * - JWT has `access: { id, admin? }` instead of flat isAdmin/emailVerified/adminApproved
 * - access.id is matched against the URL's universeGalaxyStarId using wildcard matching
 * - Access gate: `access.admin || adminApproved`
 * - Issuer/audience are hardcoded constants, not env vars
 *
 * @see tasks/nebula-auth.md § Auth Hooks
 */
import {
  verifyJwt,
  verifyJwtWithRotation,
  importPublicKey,
  parseJwtUnsafe,
  extractWebSocketToken,
} from '@lumenize/auth';
import { matchAccess } from './parse-id';
import { NEBULA_AUTH_PREFIX, NEBULA_AUTH_ISSUER, NEBULA_AUTH_AUDIENCE } from './types';
import type { NebulaJwtPayload } from './types';

// ============================================
// Hook Types
// ============================================

/**
 * Hook context from routeDORequest
 */
interface HookContext {
  doNamespace: any;
  doInstanceNameOrId: string;
}

/** Hook function signature for routeDORequest */
type RouteDORequestHook = (request: Request, context: HookContext) => Promise<Response | Request | undefined>;

// ============================================
// Internal Helpers
// ============================================

/**
 * Create a 401 Unauthorized response with proper WWW-Authenticate header
 */
function createUnauthorizedResponse(error: string, description: string): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Nebula", error="${error}", error_description="${description}"`,
      },
    },
  );
}

/**
 * Create a 403 Forbidden response for access gate failures
 */
function createForbiddenResponse(error: string, description: string): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: description,
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/**
 * Create a 429 Too Many Requests response for rate limit violations
 */
function createRateLimitResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      error_description: 'Too many requests. Please try again later.',
    }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer') return null;

  return parts[1]!;
}

/**
 * Extract the `universeGalaxyStarId` from the URL path.
 *
 * Expected URL shape: `http://host/{prefix}/{universeGalaxyStarId}/endpoint`
 *
 * The prefix is stripped and the next segment (which may contain dots) is the
 * universeGalaxyStarId. For example:
 *   `/auth/george-solopreneur.app.tenant/subjects` → `george-solopreneur.app.tenant`
 */
function extractInstanceName(url: string, prefix: string): string | null {
  const { pathname } = new URL(url);

  // Strip prefix (e.g. "/auth")
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length + 1); // after "/auth/"

  // The instanceName is everything before the next "/" (or the entire rest if no slash)
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return rest || null;
  return rest.slice(0, slashIdx) || null;
}

/**
 * Verify JWT and check nebula-specific access claims.
 *
 * Steps:
 * 1. Verify signature with key rotation support
 * 2. Validate iss, aud, sub
 * 3. Parse access claim and match against target instanceName
 * 4. Enforce access gate: access.admin || adminApproved
 */
async function verifyAndGate(
  token: string,
  publicKeys: CryptoKey[],
  targetInstanceName: string,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  // Verify JWT with rotation support
  let rawPayload: Record<string, unknown> | null;

  if (publicKeys.length === 1) {
    rawPayload = await verifyJwt(token, publicKeys[0]!) as Record<string, unknown> | null;
  } else {
    rawPayload = await verifyJwtWithRotation(token, publicKeys) as Record<string, unknown> | null;
  }

  if (!rawPayload) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token is invalid or expired') };
  }

  // Cast to our payload type
  const payload = rawPayload as unknown as NebulaJwtPayload;

  // Validate audience
  if (payload.aud !== NEBULA_AUTH_AUDIENCE) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token audience mismatch') };
  }

  // Validate issuer
  if (payload.iss !== NEBULA_AUTH_ISSUER) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token issuer mismatch') };
  }

  // Validate subject claim exists
  if (!payload.sub) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token missing subject claim') };
  }

  // Validate access claim exists
  if (!payload.access || !payload.access.id) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token missing access claim') };
  }

  // Match access.id against the target instanceName
  if (!matchAccess(payload.access.id, targetInstanceName)) {
    return {
      error: createForbiddenResponse(
        'insufficient_scope',
        `Token access "${payload.access.id}" does not grant access to "${targetInstanceName}"`,
      ),
    };
  }

  // Access gate: admin || adminApproved
  if (!payload.access.admin && !payload.adminApproved) {
    return { error: createForbiddenResponse('access_denied', 'Account not yet approved') };
  }

  return { payload };
}

/**
 * Build an enhanced request that forwards the verified JWT
 * in the standard Authorization: Bearer header
 */
function forwardJwtRequest(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is needed for streaming bodies
    duplex: request.body ? 'half' : undefined,
  });
}

// ============================================
// createRouteDORequestNebulaAuthHooks
// ============================================

/**
 * Create auth hooks for use with routeDORequest (Nebula variant).
 *
 * Reads JWT public keys from environment variables.
 * Issuer and audience are hardcoded Nebula constants.
 *
 * The hooks:
 * 1. Extract JWT from Authorization: Bearer header or WebSocket subprotocol
 * 2. Verify JWT signature with key rotation support
 * 3. Validate standard claims: iss, aud, exp
 * 4. Parse universeGalaxyStarId from the URL
 * 5. Match access.id against the URL target — exact or wildcard
 * 6. Enforce access gate: access.admin || adminApproved
 * 7. Per-subject rate limiting (when binding configured)
 * 8. Forward verified JWT to downstream DO
 *
 * @example
 * ```typescript
 * const { onBeforeRequest, onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
 *
 * routeDORequest(request, env, {
 *   onBeforeRequest,
 *   onBeforeConnect,
 * });
 * ```
 *
 * @param env - Worker Env (generated by `wrangler types`) with JWT public keys and rate limiter binding
 * @param options - Optional configuration
 * @param options.prefix - URL prefix (default: NEBULA_AUTH_PREFIX i.e. '/auth')
 * @throws If no JWT public keys found
 */
export async function createRouteDORequestNebulaAuthHooks(
  env: Env,
  options?: { prefix?: string },
): Promise<{ onBeforeRequest: RouteDORequestHook; onBeforeConnect: RouteDORequestHook }> {
  const prefix = options?.prefix ?? NEBULA_AUTH_PREFIX;

  // Import public keys from env
  const publicKeysPem = [
    env.JWT_PUBLIC_KEY_BLUE,
    env.JWT_PUBLIC_KEY_GREEN,
  ].filter(Boolean);
  const publicKeys = await Promise.all(publicKeysPem.map((pem) => importPublicKey(pem)));

  if (publicKeys.length === 0) {
    throw new Error('No JWT public keys found in env (JWT_PUBLIC_KEY_BLUE / JWT_PUBLIC_KEY_GREEN)');
  }

  // Resolve rate limiter binding
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (!rateLimiter) {
    console.warn(
      '[nebula-auth] NEBULA_AUTH_RATE_LIMITER binding not found — rate limiting is disabled. ' +
        'This leaves your authenticated routes unprotected against abuse. ' +
        'Add a rate_limits binding to your wrangler.jsonc. ' +
        'See https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/',
    );
  }

  // HTTP request hook: Bearer token from Authorization header
  const onBeforeRequest: RouteDORequestHook = async (request, _context) => {
    const token = extractBearerToken(request);

    if (!token) {
      return createUnauthorizedResponse('invalid_request', 'Missing Authorization header with Bearer token');
    }

    // Extract target instanceName from URL
    const targetInstanceName = extractInstanceName(request.url, prefix);
    if (!targetInstanceName) {
      return createUnauthorizedResponse('invalid_request', 'Could not determine target instance from URL');
    }

    const result = await verifyAndGate(token, publicKeys, targetInstanceName);
    if ('error' in result) return result.error;

    // Per-subject rate limiting (skipped when binding not configured)
    if (rateLimiter) {
      const { success } = await rateLimiter.limit({ key: result.payload.sub });
      if (!success) return createRateLimitResponse();
    }

    return forwardJwtRequest(request, token);
  };

  // WebSocket upgrade hook: token from subprotocol
  const onBeforeConnect: RouteDORequestHook = async (request, _context) => {
    const token = extractWebSocketToken(request);

    if (!token) {
      return new Response('Unauthorized: Missing access token in WebSocket subprotocol', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Extract target instanceName from URL
    const targetInstanceName = extractInstanceName(request.url, prefix);
    if (!targetInstanceName) {
      return new Response('Bad Request: Could not determine target instance from URL', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const result = await verifyAndGate(token, publicKeys, targetInstanceName);
    if ('error' in result) return result.error;

    // Per-subject rate limiting (skipped when binding not configured)
    if (rateLimiter) {
      const { success } = await rateLimiter.limit({ key: result.payload.sub });
      if (!success) return createRateLimitResponse();
    }

    return forwardJwtRequest(request, token);
  };

  return { onBeforeRequest, onBeforeConnect };
}

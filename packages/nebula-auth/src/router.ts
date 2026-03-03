/**
 * Nebula Auth Worker — hand-written router
 *
 * Single Worker that routes to NebulaAuth and NebulaAuthRegistry DOs.
 * Handles Turnstile, JWT verification, and per-subject rate limiting
 * at the edge before forwarding to DOs.
 *
 * @see tasks/nebula-auth.md § Phase 5: Worker Router
 */
import {
  verifyJwt,
  verifyJwtWithRotation,
  importPublicKey,
  extractWebSocketToken,
  verifyTurnstileToken,
} from '@lumenize/auth';
import { matchAccess, parseId } from './parse-id';
import {
  NEBULA_AUTH_PREFIX,
  NEBULA_AUTH_ISSUER,
  REGISTRY_INSTANCE_NAME,
} from './types';
import type { NebulaJwtPayload } from './types';

// Registry endpoint suffixes (exact match after prefix)
const REGISTRY_ENDPOINTS = new Set(['discover', 'claim-universe', 'claim-star', 'create-galaxy']);

// Auth-flow endpoints on NA instances (no JWT required — token/cookie validated by DO)
const AUTH_FLOW_SUFFIXES = new Set([
  'email-magic-link',
  'magic-link',
  'accept-invite',
  'refresh-token',
  'logout',
]);

// Turnstile-gated endpoints
const TURNSTILE_ENDPOINTS = new Set(['email-magic-link', 'claim-universe', 'claim-star', 'discover']);

// ============================================
// Response helpers
// ============================================

function jsonError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json401(error: string, description: string): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Nebula", error="${error}", error_description="${description}"`,
      },
    },
  );
}

// ============================================
// Worker
// ============================================

/**
 * Parse the path after the prefix to determine routing target.
 *
 * Returns:
 * - { type: 'registry', endpoint } for registry paths
 * - { type: 'instance', instanceName, endpoint } for NA instance paths
 * - null if path doesn't match the prefix
 */
function parsePath(pathname: string): {
  type: 'registry'; endpoint: string;
} | {
  type: 'instance'; instanceName: string; endpoint: string;
} | null {
  const prefix = NEBULA_AUTH_PREFIX;
  if (!pathname.startsWith(prefix + '/')) return null;

  const rest = pathname.slice(prefix.length + 1); // after '/auth/'
  if (!rest) return null;

  // Check if it's a registry endpoint (exact match, no instanceName segment)
  if (REGISTRY_ENDPOINTS.has(rest)) {
    return { type: 'registry', endpoint: rest };
  }

  // Instance path: {instanceName}/{endpoint} or {instanceName}
  // instanceName contains dots but no slashes
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    // Just instanceName, no endpoint — could be a bare path
    return { type: 'instance', instanceName: rest, endpoint: '' };
  }

  const instanceName = rest.slice(0, slashIdx);
  const endpoint = rest.slice(slashIdx + 1);
  return { type: 'instance', instanceName, endpoint };
}

/**
 * Get the last segment of an endpoint path.
 * e.g. "subject/abc123/actors" → "actors"
 * e.g. "refresh-token" → "refresh-token"
 */
function endpointSuffix(endpoint: string): string {
  const lastSlash = endpoint.lastIndexOf('/');
  return lastSlash === -1 ? endpoint : endpoint.slice(lastSlash + 1);
}

export async function routeNebulaAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  // 1. Match prefix — return undefined for non-matching paths (fallthrough pattern)
  const parsed = parsePath(url.pathname);
  if (!parsed) {
    return undefined;
  }

  try {
    if (parsed.type === 'registry') {
      return await handleRegistryPath(request, env, parsed.endpoint);
    } else {
      return await handleInstancePath(request, env, parsed.instanceName, parsed.endpoint);
    }
  } catch (err) {
    return jsonError(500, 'internal_error', 'An unexpected error occurred');
  }
}

// ============================================
// Registry path handler
// ============================================

async function handleRegistryPath(
  request: Request,
  env: Env,
  endpoint: string,
): Promise<Response> {
  // Turnstile gating for unauthenticated endpoints
  if (TURNSTILE_ENDPOINTS.has(endpoint)) {
    const turnstileResult = await checkTurnstile(request, env);
    if (turnstileResult) return turnstileResult;
  }

  // JWT gating for create-galaxy — pass verified payload in body
  if (endpoint === 'create-galaxy') {
    const jwtResult = await checkJwtForRegistry(request, env);
    if ('error' in jwtResult) return jwtResult.error;

    // Read the original body, inject verifiedAccess, and forward
    let body: Record<string, any>;
    try {
      body = await request.json() as Record<string, any>;
    } catch {
      return jsonError(400, 'invalid_request', 'Request body must be JSON');
    }
    body.verifiedAccess = jwtResult.payload.access;

    const registryStub = env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
    return registryStub.fetch(new Request(request.url, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // Forward to registry DO
  const registryStub = env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
  return registryStub.fetch(request);
}

// ============================================
// Instance path handler
// ============================================

async function handleInstancePath(
  request: Request,
  env: Env,
  instanceName: string,
  endpoint: string,
): Promise<Response> {
  // Validate instance name format (1–3 dot-separated slugs)
  try {
    parseId(instanceName);
  } catch {
    return jsonError(400, 'invalid_instance', 'Invalid instance name format');
  }

  const suffix = endpointSuffix(endpoint);

  // Auth-flow endpoints: Turnstile on email-magic-link, rest forwarded directly
  if (AUTH_FLOW_SUFFIXES.has(suffix)) {
    if (suffix === 'email-magic-link') {
      const turnstileResult = await checkTurnstile(request, env);
      if (turnstileResult) return turnstileResult;
    }
    const naStub = env.NEBULA_AUTH.getByName(instanceName);
    return naStub.fetch(request);
  }

  // Authenticated endpoints: JWT verify + scope match + rate limit
  const authResult = await checkJwtForInstance(request, env, instanceName);
  if (authResult) return authResult;

  const naStub = env.NEBULA_AUTH.getByName(instanceName);
  return naStub.fetch(request);
}

// ============================================
// Turnstile validation
// ============================================

async function checkTurnstile(
  request: Request,
  env: Env,
): Promise<Response | null> {
  // Skip in test mode
  if ((env as any).NEBULA_AUTH_TEST_MODE === 'true') return null;

  const secretKey = (env as any).TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    // No Turnstile configured — skip (development/test)
    return null;
  }

  // Clone request to read body without consuming it
  const cloned = request.clone();
  let body: Record<string, any>;
  try {
    body = await cloned.json();
  } catch {
    return jsonError(400, 'invalid_request', 'Request body must be JSON');
  }

  const turnstileToken = body['cf-turnstile-response'] ?? body['turnstileToken'];
  if (!turnstileToken) {
    return jsonError(403, 'turnstile_required', 'Turnstile verification token is required');
  }

  const result = await verifyTurnstileToken(secretKey, turnstileToken);
  if (!result.success) {
    return jsonError(403, 'turnstile_failed', 'Turnstile verification failed');
  }

  return null; // passed
}

// ============================================
// JWT verification — shared foundation
// ============================================

async function getPublicKeys(env: Env): Promise<CryptoKey[]> {
  const pems = [
    env.JWT_PUBLIC_KEY_BLUE,
    env.JWT_PUBLIC_KEY_GREEN,
  ].filter(Boolean);

  if (pems.length === 0) {
    throw new Error('No JWT public keys found in env');
  }

  return Promise.all(pems.map(pem => importPublicKey(pem)));
}

/**
 * Verify a Nebula access token: signature, standard claims, and
 * matchAccess(authScopePattern, aud) internal-consistency check.
 *
 * Returns the decoded payload if valid, null if invalid/expired.
 */
export async function verifyNebulaAccessToken(
  token: string,
  env: object,
): Promise<NebulaJwtPayload | null> {
  const publicKeys = await getPublicKeys(env as Env);

  const rawPayload = publicKeys.length === 1
    ? await verifyJwt(token, publicKeys[0]!)
    : await verifyJwtWithRotation(token, publicKeys);

  if (!rawPayload) return null;

  const payload = rawPayload as unknown as NebulaJwtPayload;

  // Standard claims validation
  if (!payload.aud || typeof payload.aud !== 'string') return null;
  if (payload.iss !== NEBULA_AUTH_ISSUER) return null;
  if (!payload.sub) return null;
  if (!payload.access?.authScopePattern) return null;

  // Internal consistency: the active scope (aud) must be covered by the auth scope pattern.
  // Phase 1.8's refresh handler already prevents minting tokens that violate this, but
  // belt-and-suspenders at verification time catches tampered or stale tokens.
  if (!matchAccess(payload.access.authScopePattern, payload.aud)) return null;

  return payload;
}

// ============================================
// JWT verification for instance paths
// ============================================

async function verifyAndGateJwt(
  token: string,
  env: Env,
  targetInstanceName: string,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const payload = await verifyNebulaAccessToken(token, env);
  if (!payload) {
    return { error: json401('invalid_token', 'Token is invalid or expired') };
  }

  // Target-specific check: does the auth scope pattern cover this specific instance?
  // This is a DIFFERENT check from verifyNebulaAccessToken's matchAccess(authScopePattern, aud).
  // That check validates internal consistency (aud within auth scope).
  // This check validates the token grants access to the target instance.
  if (!matchAccess(payload.access.authScopePattern, targetInstanceName)) {
    return {
      error: jsonError(403, 'insufficient_scope',
        `Token access "${payload.access.authScopePattern}" does not grant access to "${targetInstanceName}"`),
    };
  }

  // Access gate: admin || adminApproved
  if (!payload.access.admin && !payload.adminApproved) {
    return { error: jsonError(403, 'access_denied', 'Account not yet approved') };
  }

  return { payload };
}

async function checkJwtForInstance(
  request: Request,
  env: Env,
  instanceName: string,
): Promise<Response | null> {
  // Extract token from Bearer header or WebSocket subprotocol
  const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  let token: string | null;

  if (isWebSocket) {
    token = extractWebSocketToken(request);
  } else {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      token = null;
    }
  }

  if (!token) {
    return json401('invalid_request', 'Missing Authorization header with Bearer token');
  }

  const result = await verifyAndGateJwt(token, env, instanceName);
  if ('error' in result) return result.error;

  // Per-subject rate limiting
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (rateLimiter) {
    const { success } = await rateLimiter.limit({ key: result.payload.sub });
    if (!success) {
      return jsonError(429, 'rate_limited', 'Too many requests. Please try again later.');
    }
  }

  return null; // passed
}

// ============================================
// JWT check for registry create-galaxy
// ============================================

async function checkJwtForRegistry(
  request: Request,
  env: Env,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: json401('invalid_request', 'Missing Authorization header with Bearer token') };
  }

  const token = authHeader.slice(7);
  const payload = await verifyNebulaAccessToken(token, env);
  if (!payload) {
    return { error: json401('invalid_token', 'Token is invalid or expired') };
  }

  // Per-subject rate limiting
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (rateLimiter) {
    const { success } = await rateLimiter.limit({ key: payload.sub });
    if (!success) {
      return { error: jsonError(429, 'rate_limited', 'Too many requests. Please try again later.') };
    }
  }

  return { payload };
}

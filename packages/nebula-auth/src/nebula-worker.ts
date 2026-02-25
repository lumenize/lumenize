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
import { matchAccess } from './parse-id';
import {
  NEBULA_AUTH_PREFIX,
  NEBULA_AUTH_ISSUER,
  NEBULA_AUTH_AUDIENCE,
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
const TURNSTILE_ENDPOINTS = new Set(['email-magic-link', 'claim-universe', 'claim-star']);

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

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  // 1. Match prefix
  const parsed = parsePath(url.pathname);
  if (!parsed) {
    return new Response('Not Found', { status: 404 });
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
  // Turnstile gating for claim-universe, claim-star
  if (TURNSTILE_ENDPOINTS.has(endpoint)) {
    const turnstileResult = await checkTurnstile(request, env);
    if (turnstileResult) return turnstileResult;
  }

  // JWT gating for create-galaxy
  if (endpoint === 'create-galaxy') {
    const jwtResult = await checkJwtForRegistry(request, env);
    if (jwtResult) return jwtResult;
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
// JWT verification for instance paths
// ============================================

let _publicKeysCache: CryptoKey[] | null = null;

async function getPublicKeys(env: Env): Promise<CryptoKey[]> {
  if (_publicKeysCache) return _publicKeysCache;

  const pems = [
    env.JWT_PUBLIC_KEY_BLUE,
    env.JWT_PUBLIC_KEY_GREEN,
  ].filter(Boolean);

  if (pems.length === 0) {
    throw new Error('No JWT public keys found in env');
  }

  _publicKeysCache = await Promise.all(pems.map(pem => importPublicKey(pem)));
  return _publicKeysCache;
}

async function verifyAndGateJwt(
  token: string,
  publicKeys: CryptoKey[],
  targetInstanceName: string,
): Promise<{ payload: NebulaJwtPayload } | { error: Response }> {
  let rawPayload: Record<string, unknown> | null;

  if (publicKeys.length === 1) {
    rawPayload = await verifyJwt(token, publicKeys[0]!) as Record<string, unknown> | null;
  } else {
    rawPayload = await verifyJwtWithRotation(token, publicKeys) as Record<string, unknown> | null;
  }

  if (!rawPayload) {
    return { error: json401('invalid_token', 'Token is invalid or expired') };
  }

  const payload = rawPayload as unknown as NebulaJwtPayload;

  if (payload.aud !== NEBULA_AUTH_AUDIENCE) {
    return { error: json401('invalid_token', 'Token audience mismatch') };
  }
  if (payload.iss !== NEBULA_AUTH_ISSUER) {
    return { error: json401('invalid_token', 'Token issuer mismatch') };
  }
  if (!payload.sub) {
    return { error: json401('invalid_token', 'Token missing subject claim') };
  }
  if (!payload.access?.id) {
    return { error: json401('invalid_token', 'Token missing access claim') };
  }

  // Match access.id against the target instanceName
  if (!matchAccess(payload.access.id, targetInstanceName)) {
    return {
      error: jsonError(403, 'insufficient_scope',
        `Token access "${payload.access.id}" does not grant access to "${targetInstanceName}"`),
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

  const publicKeys = await getPublicKeys(env);
  const result = await verifyAndGateJwt(token, publicKeys, instanceName);
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
): Promise<Response | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json401('invalid_request', 'Missing Authorization header with Bearer token');
  }

  const token = authHeader.slice(7);
  const publicKeys = await getPublicKeys(env);

  // Verify JWT — use a placeholder instanceName for verification since
  // the registry will do its own authorization check on the access claim.
  // We just need to verify the signature and standard claims here.
  let rawPayload: Record<string, unknown> | null;

  if (publicKeys.length === 1) {
    rawPayload = await verifyJwt(token, publicKeys[0]!) as Record<string, unknown> | null;
  } else {
    rawPayload = await verifyJwtWithRotation(token, publicKeys) as Record<string, unknown> | null;
  }

  if (!rawPayload) {
    return json401('invalid_token', 'Token is invalid or expired');
  }

  const payload = rawPayload as unknown as NebulaJwtPayload;

  if (payload.aud !== NEBULA_AUTH_AUDIENCE) {
    return json401('invalid_token', 'Token audience mismatch');
  }
  if (payload.iss !== NEBULA_AUTH_ISSUER) {
    return json401('invalid_token', 'Token issuer mismatch');
  }
  if (!payload.sub) {
    return json401('invalid_token', 'Token missing subject claim');
  }

  // Per-subject rate limiting
  const rateLimiter = env.NEBULA_AUTH_RATE_LIMITER;
  if (rateLimiter) {
    const { success } = await rateLimiter.limit({ key: payload.sub });
    if (!success) {
      return jsonError(429, 'rate_limited', 'Too many requests. Please try again later.');
    }
  }

  return null; // passed — registry will check access claim authorization
}

// ============================================
// Default export
// ============================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

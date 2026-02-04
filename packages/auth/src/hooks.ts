import { verifyJwt, verifyJwtWithRotation, importPublicKey, parseJwtUnsafe } from './jwt';
import type { JwtPayload } from './types';

// WebSocket subprotocol prefix for access tokens
const WS_TOKEN_PREFIX = 'lmz.access-token.';

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
      error_description: description
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Lumenize", error="${error}", error_description="${description}"`
      }
    }
  );
}

/**
 * Create a 403 Forbidden response for access gate failures
 */
function createForbiddenResponse(error: string, description: string): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: description
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * Create a 429 Too Many Requests response for rate limit violations
 */
function createRateLimitResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      error_description: 'Too many requests. Please try again later.'
    }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Verify JWT and check access gate (emailVerified && adminApproved, or isAdmin)
 */
async function verifyAndGate(
  token: string,
  publicKeys: CryptoKey[],
  issuer: string,
  audience: string,
): Promise<{ payload: JwtPayload } | { error: Response }> {
  // Verify JWT with rotation support
  let payload: JwtPayload | null;

  if (publicKeys.length === 1) {
    payload = await verifyJwt(token, publicKeys[0]);
  } else {
    payload = await verifyJwtWithRotation(token, publicKeys);
  }

  if (!payload) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token is invalid or expired') };
  }

  // Validate audience
  if (payload.aud !== audience) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token audience mismatch') };
  }

  // Validate issuer
  if (payload.iss !== issuer) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token issuer mismatch') };
  }

  // Validate subject claim exists
  if (!payload.sub) {
    return { error: createUnauthorizedResponse('invalid_token', 'Token missing subject claim') };
  }

  // Access gate: isAdmin passes implicitly, otherwise need both flags
  if (!payload.isAdmin && !(payload.emailVerified && payload.adminApproved)) {
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
    duplex: request.body ? 'half' : undefined
  });
}

// ============================================
// createRouteDORequestAuthHooks
// ============================================

/**
 * Create auth hooks for use with routeDORequest.
 *
 * Reads all configuration from environment variables:
 * - Public keys: `JWT_PUBLIC_KEY_BLUE`, `JWT_PUBLIC_KEY_GREEN`
 * - Issuer: `LUMENIZE_AUTH_ISSUER` (default: 'https://lumenize.local')
 * - Audience: `LUMENIZE_AUTH_AUDIENCE` (default: 'https://lumenize.local')
 *
 * The hooks:
 * 1. Verify JWT signature and expiration
 * 2. Validate issuer and audience claims
 * 3. Check access gate: `isAdmin || (emailVerified && adminApproved)`
 * 4. Enforce per-subject rate limiting (keyed on `sub` from JWT)
 * 5. Forward the verified JWT to the DO in `Authorization: Bearer <jwt>`
 *
 * Returns `{ onBeforeRequest, onBeforeConnect }` for destructuring into routeDORequest options.
 *
 * @example
 * ```typescript
 * const { onBeforeRequest, onBeforeConnect } = await createRouteDORequestAuthHooks(env);
 *
 * routeDORequest(request, env, {
 *   onBeforeRequest,
 *   onBeforeConnect,
 * });
 * ```
 *
 * @throws If no JWT public keys found or rate limiter binding missing
 * @see https://lumenize.com/docs/auth/#server-side-token-verification
 */
export async function createRouteDORequestAuthHooks(
  env: Env,
): Promise<{ onBeforeRequest: RouteDORequestHook; onBeforeConnect: RouteDORequestHook }> {
  // Import public keys from env (typed in Env)
  const publicKeysPem = [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean);
  const publicKeys = await Promise.all(publicKeysPem.map((pem: string) => importPublicKey(pem)));

  if (publicKeys.length === 0) {
    throw new Error('No JWT public keys found in env (JWT_PUBLIC_KEY_BLUE / JWT_PUBLIC_KEY_GREEN)');
  }

  // Resolve rate limiter binding (cast required — not in generated Env type)
  const rateLimiter = (env as unknown as Record<string, unknown>)['LUMENIZE_AUTH_RATE_LIMITER'] as RateLimit | undefined;
  if (!rateLimiter) {
    throw new Error(
      "Rate limiter binding 'LUMENIZE_AUTH_RATE_LIMITER' not found in env. " +
      'Add a rate_limits binding to your wrangler.jsonc.'
    );
  }

  // Optional env vars not in wrangler.jsonc vars (cast required)
  const envRecord = env as unknown as Record<string, unknown>;
  const issuer = (envRecord.LUMENIZE_AUTH_ISSUER as string) || 'https://lumenize.local';
  const audience = (envRecord.LUMENIZE_AUTH_AUDIENCE as string) || 'https://lumenize.local';

  // HTTP request hook: Bearer token from Authorization header
  const onBeforeRequest: RouteDORequestHook = async (request, _context) => {
    const token = extractBearerToken(request);

    if (!token) {
      return createUnauthorizedResponse('invalid_request', 'Missing Authorization header with Bearer token');
    }

    const result = await verifyAndGate(token, publicKeys, issuer, audience);
    if ('error' in result) return result.error;

    // Per-subject rate limiting
    const { success } = await rateLimiter.limit({ key: result.payload.sub });
    if (!success) return createRateLimitResponse();

    return forwardJwtRequest(request, token);
  };

  // WebSocket upgrade hook: token from subprotocol
  const onBeforeConnect: RouteDORequestHook = async (request, _context) => {
    const token = extractWebSocketToken(request);

    if (!token) {
      return new Response('Unauthorized: Missing access token in WebSocket subprotocol', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const result = await verifyAndGate(token, publicKeys, issuer, audience);
    if ('error' in result) return result.error;

    // Per-subject rate limiting
    const { success } = await rateLimiter.limit({ key: result.payload.sub });
    if (!success) return createRateLimitResponse();

    return forwardJwtRequest(request, token);
  };

  return { onBeforeRequest, onBeforeConnect };
}

// ============================================
// WebSocket Utilities (used by DOs for message-level auth)
// ============================================

/**
 * Extract access token from WebSocket subprotocol header.
 *
 * Expected format in Sec-WebSocket-Protocol:
 * `lmz, lmz.access-token.{base64url-encoded-jwt}`
 *
 * The client should request both 'lmz' and 'lmz.access-token.{token}' as subprotocols.
 * We extract the token from the access-token protocol and accept 'lmz' as the actual protocol.
 *
 * @param request - WebSocket upgrade request
 * @returns Token string if found, null otherwise
 */
export function extractWebSocketToken(request: Request): string | null {
  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (!protocolHeader) {
    return null;
  }

  // Split by comma and trim whitespace
  const protocols = protocolHeader.split(',').map(p => p.trim());

  // Find the token protocol
  for (const protocol of protocols) {
    if (protocol.startsWith(WS_TOKEN_PREFIX)) {
      return protocol.slice(WS_TOKEN_PREFIX.length);
    }
  }

  return null;
}

/**
 * Result of WebSocket message token verification
 */
export interface WebSocketTokenVerifyResult {
  /** Whether the token is valid */
  valid: boolean;
  /** Subject ID from token (if valid) */
  sub?: string;
  /** Full JWT payload (if valid) */
  payload?: JwtPayload;
  /** Error message (if invalid) */
  error?: string;
  /** Whether token has expired (specific error case) */
  expired?: boolean;
}

/**
 * Verify a JWT token for WebSocket message authentication.
 *
 * Use this in your DO's webSocketMessage handler to verify the token
 * on each message, since WebSocket messages bypass the Worker after
 * the initial connection.
 *
 * @example
 * ```typescript
 * class MyDO extends LumenizeDO {
 *   #publicKeys: CryptoKey[] = [];
 *
 *   async webSocketMessage(ws: WebSocket, message: string) {
 *     const token = this.#getStoredToken(ws);
 *     const result = await verifyWebSocketToken(token, this.#publicKeys);
 *
 *     if (!result.valid) {
 *       if (result.expired) {
 *         ws.close(4401, 'Token expired');
 *       } else {
 *         ws.close(4403, 'Invalid token');
 *       }
 *       return;
 *     }
 *
 *     // Process message with result.sub
 *   }
 * }
 * ```
 */
export async function verifyWebSocketToken(
  token: string,
  publicKeys: CryptoKey[]
): Promise<WebSocketTokenVerifyResult> {
  if (!token) {
    return { valid: false, error: 'No token provided' };
  }

  if (publicKeys.length === 0) {
    return { valid: false, error: 'No public keys configured' };
  }

  // First, parse the token to check expiration separately from signature
  const parsed = parseJwtUnsafe(token);
  if (!parsed) {
    return { valid: false, error: 'Malformed token' };
  }

  // Check expiration before signature verification (fast fail)
  if (parsed.payload.exp && parsed.payload.exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, error: 'Token expired', expired: true };
  }

  // Verify signature
  let payload: JwtPayload | null;

  if (publicKeys.length === 1) {
    payload = await verifyJwt(token, publicKeys[0]);
  } else {
    payload = await verifyJwtWithRotation(token, publicKeys);
  }

  if (!payload) {
    return { valid: false, error: 'Invalid signature' };
  }

  if (!payload.sub) {
    return { valid: false, error: 'Token missing subject claim' };
  }

  return {
    valid: true,
    sub: payload.sub,
    payload
  };
}

/**
 * WebSocket close codes for authentication errors
 */
export const WS_CLOSE_CODES = {
  /** Token has expired - client should refresh and reconnect */
  TOKEN_EXPIRED: 4401,
  /** Token is invalid or unauthorized */
  UNAUTHORIZED: 4403,
  /** Token missing - no authentication provided */
  NO_TOKEN: 4400
} as const;

/**
 * Get seconds until token expiration.
 *
 * Useful for setting up alarms to close WebSocket connections before token expires.
 *
 * @param payload - JWT payload with exp claim (or partial payload for testing)
 * @returns Seconds until expiration, or 0 if already expired, or Infinity if no exp claim
 */
export function getTokenTtl(payload: { exp?: number }): number {
  if (!payload.exp) {
    return Infinity;
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = payload.exp - now;
  return ttl > 0 ? ttl : 0;
}

import { verifyJwt, verifyJwtWithRotation, importPublicKey, parseJwtUnsafe } from './jwt';
import type { JwtPayload } from './types';

// WebSocket subprotocol prefix for access tokens
const WS_TOKEN_PREFIX = 'lmz.access-token.';

/**
 * Configuration for the auth middleware
 */
export interface AuthMiddlewareConfig {
  /**
   * PEM-encoded Ed25519 public keys for JWT verification.
   * Multiple keys support rotation - verification tries each until one succeeds.
   * Order: active key first, then fallback keys.
   */
  publicKeysPem: string[];
  
  /**
   * Optional: Custom realm for WWW-Authenticate header (default: 'Lumenize')
   */
  realm?: string;
  
  /**
   * Optional: Expected audience claim in JWT (skips validation if not set)
   */
  audience?: string;
  
  /**
   * Optional: Expected issuer claim in JWT (skips validation if not set)
   */
  issuer?: string;
}

/**
 * Hook context from routeDORequest
 */
interface HookContext {
  doNamespace: any;
  doInstanceNameOrId: string;
}

/**
 * Result of JWT verification with user context
 */
export interface AuthContext {
  /** User ID from JWT subject claim */
  userId: string;
  /** Full JWT payload */
  payload: JwtPayload;
}

/**
 * Create a 401 Unauthorized response with proper WWW-Authenticate header
 */
function createUnauthorizedResponse(realm: string, error: string, description: string): Response {
  return new Response(
    JSON.stringify({ 
      error, 
      error_description: description 
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="${realm}", error="${error}", error_description="${description}"`
      }
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
 * Enhance request with auth context headers
 * 
 * Headers added:
 * - X-Auth-User-Id: User ID from JWT subject claim
 * - X-Auth-Verified: 'true' to indicate middleware verified the token
 */
function enhanceRequest(request: Request, context: AuthContext): Request {
  const headers = new Headers(request.headers);
  headers.set('X-Auth-User-Id', context.userId);
  headers.set('X-Auth-Verified', 'true');
  
  // Remove Authorization header from forwarded request
  // (DO doesn't need it, verification already done)
  headers.delete('Authorization');
  
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is needed for streaming bodies
    duplex: request.body ? 'half' : undefined
  });
}

/**
 * Create auth middleware for use with routeDORequest hooks.
 * 
 * This middleware:
 * - Extracts Bearer token from Authorization header
 * - Verifies JWT signature and expiration
 * - Validates audience and issuer claims (if configured)
 * - Enhances request with auth context headers on success
 * - Returns 401 response with WWW-Authenticate header on failure
 * 
 * @example
 * ```typescript
 * const authMiddleware = await createAuthMiddleware({
 *   publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN],
 *   audience: 'https://myapp.com',
 *   issuer: 'https://myapp.com'
 * });
 * 
 * routeDORequest(request, env, {
 *   onBeforeRequest: authMiddleware,
 *   onBeforeConnect: authMiddleware
 * });
 * ```
 */
export async function createAuthMiddleware(config: AuthMiddlewareConfig): Promise<
  (request: Request, context: HookContext) => Promise<Response | Request | undefined>
> {
  const realm = config.realm || 'Lumenize';
  
  // Import all public keys upfront
  const publicKeys = await Promise.all(
    config.publicKeysPem.filter(Boolean).map(pem => importPublicKey(pem))
  );
  
  if (publicKeys.length === 0) {
    throw new Error('At least one public key must be provided for auth middleware');
  }
  
  return async (request: Request, _context: HookContext): Promise<Response | Request | undefined> => {
    // Extract Bearer token
    const token = extractBearerToken(request);
    
    if (!token) {
      return createUnauthorizedResponse(
        realm,
        'invalid_request',
        'Missing Authorization header with Bearer token'
      );
    }
    
    // Verify JWT with rotation support
    let payload: JwtPayload | null;
    
    if (publicKeys.length === 1) {
      payload = await verifyJwt(token, publicKeys[0]);
    } else {
      payload = await verifyJwtWithRotation(token, publicKeys);
    }
    
    if (!payload) {
      return createUnauthorizedResponse(
        realm,
        'invalid_token',
        'Token is invalid or expired'
      );
    }
    
    // Validate audience (if configured)
    if (config.audience && payload.aud !== config.audience) {
      return createUnauthorizedResponse(
        realm,
        'invalid_token',
        'Token audience mismatch'
      );
    }
    
    // Validate issuer (if configured)
    if (config.issuer && payload.iss !== config.issuer) {
      return createUnauthorizedResponse(
        realm,
        'invalid_token',
        'Token issuer mismatch'
      );
    }
    
    // Validate subject claim exists
    if (!payload.sub) {
      return createUnauthorizedResponse(
        realm,
        'invalid_token',
        'Token missing subject claim'
      );
    }
    
    // Create auth context
    const authContext: AuthContext = {
      userId: payload.sub,
      payload
    };
    
    // Return enhanced request
    return enhanceRequest(request, authContext);
  };
}

// ============================================
// WebSocket Authentication
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
 * Configuration for WebSocket auth middleware
 */
export interface WebSocketAuthMiddlewareConfig {
  /**
   * PEM-encoded Ed25519 public keys for JWT verification.
   */
  publicKeysPem: string[];
  
  /**
   * Optional: Expected audience claim in JWT
   */
  audience?: string;
  
  /**
   * Optional: Expected issuer claim in JWT
   */
  issuer?: string;
}

/**
 * Create WebSocket auth middleware for use with routeDORequest's onBeforeConnect hook.
 * 
 * This middleware:
 * - Extracts JWT from WebSocket subprotocol (`lmz.access-token.{token}`)
 * - Verifies JWT signature and expiration
 * - Enhances request with auth context headers on success
 * - Returns 401 response on failure (connection rejected)
 * 
 * @example
 * ```typescript
 * const wsAuthMiddleware = await createWebSocketAuthMiddleware({
 *   publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN]
 * });
 * 
 * routeDORequest(request, env, {
 *   onBeforeConnect: wsAuthMiddleware
 * });
 * ```
 * 
 * Client-side usage:
 * ```javascript
 * const ws = new WebSocket(url, ['lmz', `lmz.access-token.${accessToken}`]);
 * ```
 */
export async function createWebSocketAuthMiddleware(config: WebSocketAuthMiddlewareConfig): Promise<
  (request: Request, context: HookContext) => Promise<Response | Request | undefined>
> {
  // Import all public keys upfront
  const publicKeys = await Promise.all(
    config.publicKeysPem.filter(Boolean).map(pem => importPublicKey(pem))
  );
  
  if (publicKeys.length === 0) {
    throw new Error('At least one public key must be provided for WebSocket auth middleware');
  }
  
  return async (request: Request, _context: HookContext): Promise<Response | Request | undefined> => {
    // Extract token from subprotocol
    const token = extractWebSocketToken(request);
    
    if (!token) {
      // No token - return 401 (WebSocket connection will be rejected)
      return new Response('Unauthorized: Missing access token in WebSocket subprotocol', { 
        status: 401,
        headers: {
          'Content-Type': 'text/plain'
        }
      });
    }
    
    // Verify JWT
    let payload: JwtPayload | null;
    
    if (publicKeys.length === 1) {
      payload = await verifyJwt(token, publicKeys[0]);
    } else {
      payload = await verifyJwtWithRotation(token, publicKeys);
    }
    
    if (!payload) {
      return new Response('Unauthorized: Invalid or expired access token', { 
        status: 401,
        headers: {
          'Content-Type': 'text/plain'
        }
      });
    }
    
    // Validate claims
    if (config.audience && payload.aud !== config.audience) {
      return new Response('Unauthorized: Token audience mismatch', { status: 401 });
    }
    
    if (config.issuer && payload.iss !== config.issuer) {
      return new Response('Unauthorized: Token issuer mismatch', { status: 401 });
    }
    
    if (!payload.sub) {
      return new Response('Unauthorized: Token missing subject claim', { status: 401 });
    }
    
    // Enhance request with auth context headers
    const headers = new Headers(request.headers);
    headers.set('X-Auth-User-Id', payload.sub);
    headers.set('X-Auth-Verified', 'true');
    
    // Store token expiration for DO to check on messages
    if (payload.exp) {
      headers.set('X-Auth-Token-Exp', String(payload.exp));
    }
    
    return new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - duplex needed for streaming bodies
      duplex: request.body ? 'half' : undefined
    });
  };
}

/**
 * Result of WebSocket message token verification
 */
export interface WebSocketTokenVerifyResult {
  /** Whether the token is valid */
  valid: boolean;
  /** User ID from token (if valid) */
  userId?: string;
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
 * class MyDO extends LumenizeBase {
 *   #publicKeys: CryptoKey[] = [];
 *   
 *   async webSocketMessage(ws: WebSocket, message: string) {
 *     const token = this.#getStoredToken(ws); // Store token from initial connection
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
 *     // Process message with result.userId
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
    userId: payload.sub,
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
 * @param payload - JWT payload with exp claim
 * @returns Seconds until expiration, or 0 if already expired, or Infinity if no exp claim
 */
export function getTokenTtl(payload: JwtPayload): number {
  if (!payload.exp) {
    return Infinity;
  }
  
  const now = Math.floor(Date.now() / 1000);
  const ttl = payload.exp - now;
  return ttl > 0 ? ttl : 0;
}


/**
 * User record stored in the Auth DO
 */
export interface User {
  id: string;
  email: string;
  created_at: number;
  last_login_at: number | null;
}

/**
 * Magic link record stored in the Auth DO
 */
export interface MagicLink {
  token: string;
  state: string;
  email: string;
  expires_at: number;
  used: boolean;
}

/**
 * Refresh token record stored in the Auth DO
 */
export interface RefreshToken {
  token_hash: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  revoked: boolean;
}

/**
 * JWT payload claims
 */
export interface JwtPayload {
  /** Issuer */
  iss: string;
  /** Audience */
  aud: string;
  /** Subject (user ID) */
  sub: string;
  /** Expiration time (Unix timestamp) */
  exp: number;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** JWT ID (unique identifier) */
  jti: string;
}

/**
 * JWT header
 */
export interface JwtHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  /** Key ID - identifies which key was used for signing */
  kid: string;
}

/**
 * Email service interface for sending magic links
 * Implement this interface to integrate with your email provider
 */
export interface EmailService {
  send(to: string, magicLinkUrl: string): Promise<void>;
}

/**
 * Auth configuration options
 * Used by both createAuthRoutes and LumenizeAuth.configure()
 */
export interface AuthConfig {
  /** URL to redirect to after magic link validation (REQUIRED) */
  redirect: string;
  /** Issuer identifier for JWTs (default: 'https://lumenize.local') */
  issuer?: string;
  /** Audience identifier for JWTs (default: 'https://lumenize.local') */
  audience?: string;
  /** Access token expiration in seconds (default: 900 = 15 minutes) */
  accessTokenTtl?: number;
  /** Refresh token expiration in seconds (default: 2592000 = 30 days) */
  refreshTokenTtl?: number;
  /** Magic link expiration in seconds (default: 1800 = 30 minutes) */
  magicLinkTtl?: number;
  /** Max magic link requests per email per hour (default: 5) */
  rateLimitPerHour?: number;
  /** URL prefix for auth endpoints (default: '/auth') */
  prefix?: string;
  /** DO binding name (default: 'LUMENIZE_AUTH') */
  gatewayBindingName?: string;
  /** DO instance name (default: 'default') */
  instanceName?: string;
  /** CORS configuration for auth endpoints */
  cors?: AuthCorsOptions;
}

/**
 * Environment variables expected by Auth DO
 */
export interface AuthEnv {
  /** Auth DO binding */
  LUMENIZE_AUTH: DurableObjectNamespace<any>;
  /** Private key for signing JWTs (BLUE key) */
  JWT_PRIVATE_KEY_BLUE?: string;
  /** Public key for verifying JWTs (BLUE key) */
  JWT_PUBLIC_KEY_BLUE?: string;
  /** Private key for signing JWTs (GREEN key) */
  JWT_PRIVATE_KEY_GREEN?: string;
  /** Public key for verifying JWTs (GREEN key) */
  JWT_PUBLIC_KEY_GREEN?: string;
  /** Which key is active for signing: 'BLUE' or 'GREEN' */
  ACTIVE_JWT_KEY?: 'BLUE' | 'GREEN';
  /** Enable test mode (returns magic link in response) */
  AUTH_TEST_MODE?: string;
}

/**
 * Login response returned after successful magic link validation
 */
export interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/**
 * Error response from auth endpoints
 */
export interface AuthError {
  error: string;
  error_description?: string;
}

/**
 * CORS configuration for auth routes
 */
export type AuthCorsOptions =
  | false // No CORS headers
  | true // Permissive: echo any Origin
  | { origin: string[] } // Whitelist of allowed origins
  | { origin: (origin: string, request: Request) => boolean }; // Custom validation function



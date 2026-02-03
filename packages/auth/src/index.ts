/**
 * @lumenize/auth - Authentication for Cloudflare Durable Objects
 *
 * Provides magic link login, JWT access tokens, refresh token rotation,
 * and built-in admin role with two-phase access control.
 *
 * @see https://lumenize.com/docs/auth/
 */

// Main Auth DO class and routing
export { LumenizeAuth, createAuthRoutes } from './lumenize-auth';

// JWT utilities
export {
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  generateRandomString,
  generateUuid,
  hashString,
  createJwtPayload,
  parseJwtUnsafe
} from './jwt';

// Email service implementations
export {
  ConsoleEmailService,
  HttpEmailService,
  MockEmailService,
  createDefaultEmailService,
  type HttpEmailServiceOptions
} from './email-service';

// Auth hooks for routeDORequest (renamed from middleware.ts)
export {
  createAuthMiddleware,
  type AuthMiddlewareConfig,
  type AuthContext
} from './hooks';

// WebSocket authentication
export {
  createWebSocketAuthMiddleware,
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES,
  type WebSocketAuthMiddlewareConfig,
  type WebSocketTokenVerifyResult
} from './hooks';

// Types
export type {
  Subject,
  MagicLink,
  InviteToken,
  RefreshToken,
  JwtPayload,
  JwtHeader,
  EmailService,
  AuthRoutesOptions,
  ActClaim,
  LoginResponse,
  AuthError,
  CorsOptions
} from './types';

// Schemas (for reference/customization)
export { ALL_SCHEMAS } from './schemas';

// Test helpers
export { testLoginWithMagicLink } from './test-helpers';

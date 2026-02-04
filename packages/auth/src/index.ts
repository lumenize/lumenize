/**
 * @lumenize/auth - Authentication for Cloudflare Durable Objects
 *
 * Provides magic link login, JWT access tokens, refresh token rotation,
 * and built-in admin role with two-phase access control.
 *
 * @see https://lumenize.com/docs/auth/
 */

// Main Auth DO class
export { LumenizeAuth } from './lumenize-auth';

// Worker-level routing wrapper
export { createAuthRoutes } from './create-auth-routes';

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

// Auth hooks for routeDORequest
export {
  createRouteDORequestAuthHooks,
  type RouteDORequestAuthHooksOptions
} from './hooks';

// WebSocket authentication utilities (used by DOs for message-level auth)
export {
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES,
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
  EmailMessage,
  EmailService,
  AuthRoutesOptions,
  ActClaim,
  LoginResponse,
  AuthError,
  CorsOptions
} from './types';

// Turnstile verification
export { verifyTurnstileToken, type TurnstileVerifyResult } from './turnstile';

// Schemas (for reference/customization)
export { ALL_SCHEMAS } from './schemas';

// Test helpers
export { testLoginWithMagicLink } from './test-helpers';

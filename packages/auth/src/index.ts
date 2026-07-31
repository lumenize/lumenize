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

// JWT utilities moved to `@lumenize/crypto` (2026-07-31): `signJwt`, `verifyJwt`,
// `verifyJwtWithRotation`, `importPrivateKey`, `importPublicKey`, `generateRandomString`,
// `hashString`, `createJwtPayload`, `parseJwtUnsafe`, plus the `JwtPayload` / `JwtHeader` /
// `ActClaim` types. Deliberately NOT re-exported — a compatibility shim would be a second
// reference to the code the extraction exists to give one owner. Import from
// `@lumenize/crypto` instead.

// Email sender entrypoints (WorkerEntrypoint pattern)
export {
  AuthEmailSenderBase,
  defaultMagicLinkHtml,
  defaultAdminNotificationHtml,
  defaultApprovalConfirmationHtml,
  defaultInviteExistingHtml,
  defaultInviteNewHtml,
} from './auth-email-sender-base';

// Auth hooks for routeDORequest
export {
  createRouteDORequestAuthHooks,
} from './hooks';

// Hono integration
export { honoAuthMiddleware } from './hono-middleware';

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
  AuthClaims,
  AuthJwtPayload,
  EmailMessage,
  ResolvedEmail,
  AuthRoutesOptions,
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

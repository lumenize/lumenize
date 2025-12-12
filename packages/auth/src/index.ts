/**
 * @lumenize/auth - Authentication for Cloudflare Durable Objects
 * 
 * Provides magic link login, JWT access tokens, and refresh token rotation.
 */

// Main Auth DO class
export { LumenizeAuth } from './lumenize-auth';

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

// Auth middleware for routeDORequest
export {
  createAuthMiddleware,
  type AuthMiddlewareConfig,
  type AuthContext
} from './middleware';

// WebSocket authentication
export {
  createWebSocketAuthMiddleware,
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES,
  type WebSocketAuthMiddlewareConfig,
  type WebSocketTokenVerifyResult
} from './middleware';

// Types
export type { 
  User,
  MagicLink,
  RefreshToken,
  JwtPayload,
  JwtHeader,
  EmailService,
  AuthConfig,
  AuthEnv,
  LoginResponse,
  AuthError
} from './types';

// Schemas (for reference/customization)
export { ALL_SCHEMAS } from './schemas';


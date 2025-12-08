/**
 * @lumenize/auth - Authentication for Cloudflare Durable Objects
 * 
 * Provides magic link login, JWT access tokens, and refresh token rotation.
 */

// Main Auth DO class
export { LumenizeAuth } from './lumenize-auth.js';

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
} from './jwt.js';

// Email service implementations
export {
  ConsoleEmailService,
  HttpEmailService,
  MockEmailService,
  createDefaultEmailService,
  type HttpEmailServiceOptions
} from './email-service.js';

// Auth middleware for routeDORequest
export {
  createAuthMiddleware,
  createAuthMiddlewareSync,
  type AuthMiddlewareConfig,
  type AuthContext
} from './middleware.js';

// WebSocket authentication
export {
  createWebSocketAuthMiddleware,
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES,
  type WebSocketAuthMiddlewareConfig,
  type WebSocketTokenVerifyResult
} from './middleware.js';

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
} from './types.js';

// Schemas (for reference/customization)
export { ALL_SCHEMAS } from './schemas.js';


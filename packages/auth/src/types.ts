/**
 * Actor claim for delegation per RFC 8693
 * Recursive: each layer records who delegated to whom
 */
export interface ActClaim {
  /** Actor ID (who is performing the action) */
  sub: string;
  /** Nested delegation chain */
  act?: ActClaim;
}

/**
 * Subject record stored in the Auth DO
 * @see https://lumenize.com/docs/auth/subject-management#subject-record
 */
export interface Subject {
  /** Subject ID (UUID, per RFC 7519) */
  sub: string;
  /** Email address (unique) */
  email: string;
  /** Subject clicked magic link or invite link */
  emailVerified: boolean;
  /** Admin granted access (or subject is admin) */
  adminApproved: boolean;
  /** Full admin access (implicitly satisfies adminApproved) */
  isAdmin: boolean;
  /** Actor IDs authorized to act for this subject (delegation) */
  authorizedActors: string[];
  /** Unix timestamp */
  createdAt: number;
  /** Unix timestamp of last login */
  lastLoginAt: number | null;
}

/**
 * Magic link record stored in the Auth DO
 */
export interface MagicLink {
  token: string;
  email: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Invite token record stored in the Auth DO
 */
export interface InviteToken {
  token: string;
  email: string;
  expiresAt: number;
}

/**
 * Refresh token record stored in the Auth DO
 */
export interface RefreshToken {
  tokenHash: string;
  subjectId: string;
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
}

/**
 * JWT payload claims
 * @see https://lumenize.com/docs/auth/#jwt-claims
 */
export interface JwtPayload {
  /** Issuer */
  iss: string;
  /** Audience */
  aud: string;
  /** Subject (UUID of the principal) */
  sub: string;
  /** Expiration time (Unix timestamp) */
  exp: number;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** JWT ID (unique identifier) */
  jti: string;
  /** Subject has confirmed email */
  emailVerified: boolean;
  /** Admin has granted access */
  adminApproved: boolean;
  /** Full admin access */
  isAdmin?: boolean;
  /** Delegation chain per RFC 8693 */
  act?: ActClaim;
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
 * Discriminated union for email messages sent by LumenizeAuth.
 *
 * Subject lines are controlled by `AuthEmailSenderBase` via overridable methods —
 * they are not part of this type.
 *
 * The `invite` type is split into `invite-existing` (notification to already-verified
 * users, links to the app) and `invite-new` (onboarding link for new/unverified users,
 * contains a one-time invite token).
 */
export type EmailMessage =
  | { type: 'magic-link'; to: string; magicLinkUrl: string }
  | { type: 'admin-notification'; to: string; subjectEmail: string; approveUrl: string }
  | { type: 'approval-confirmation'; to: string; redirectUrl: string }
  | { type: 'invite-existing'; to: string; redirectUrl: string }
  | { type: 'invite-new'; to: string; inviteUrl: string };

/**
 * Fully resolved email ready for delivery by a provider.
 * Passed to `AuthEmailSenderBase.sendEmail()` after template/subject resolution.
 */
export interface ResolvedEmail {
  to: string;
  subject: string;
  html: string;
  from: string;
  replyTo: string;
  appName: string;
}

/**
 * Options for createAuthRoutes — Worker-level routing only.
 * All auth configuration (redirect, TTLs, issuer, audience, prefix)
 * is read from environment variables.
 * @see https://lumenize.com/docs/auth/configuration#what-mustmight-be-in-env
 */
export interface AuthRoutesOptions {
  /** CORS configuration for auth endpoints */
  cors?: CorsOptions;
}

/**
 * CORS configuration for auth routes
 */
export type CorsOptions =
  | false // No CORS headers
  | true // Permissive: echo any Origin
  | { origin: string[] } // Whitelist of allowed origins
  | { origin: (origin: string, request: Request) => boolean }; // Custom validation function

/**
 * Login response returned after successful token refresh.
 *
 * The `sub` field allows clients to construct identity-based names
 * (e.g., `${sub}.${tabId}`) without parsing the JWT.
 * RFC 6749 explicitly allows additional fields in token responses.
 */
export interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  sub: string;
}

/**
 * Error response from auth endpoints
 */
export interface AuthError {
  error: string;
  error_description?: string;
}

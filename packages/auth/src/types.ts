// `ActClaim`, `JwtPayload` and `JwtHeader` moved to `@lumenize/crypto` (2026-07-31) — they are
// generic JWT shapes carrying no auth policy. Imported here only to build `AuthJwtPayload`;
// deliberately NOT re-exported, so there is exactly one home for them.
import type { JwtPayload } from '@lumenize/crypto';

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
 * The custom claims `@lumenize/auth` itself mints and gates on — this package's own access
 * policy, deliberately NOT part of {@link JwtPayload}.
 *
 * Both ends narrow through this one declaration: the mint site annotates the bag it hands to
 * `createJwtPayload`, and `hooks.ts`'s access gate reads the verified token through
 * {@link AuthJwtPayload}. Renaming a field here is therefore a compile error at both ends.
 *
 * ⚠️ **A `type` alias, not an `interface`, and that is load-bearing.** Only a type alias gets
 * TypeScript's implicit index signature, which is what lets it be passed as
 * `createJwtPayload`'s `customClaims: Record<string, unknown>`. An `interface` is open to
 * declaration merging and so gets none — converting this back would break the mint site.
 */
export type AuthClaims = {
  /** Subject has confirmed email */
  emailVerified: boolean;
  /** Admin has granted access */
  adminApproved: boolean;
  /** Full admin access (implicitly satisfies `adminApproved`) */
  isAdmin?: boolean;
};

/**
 * A token minted by `@lumenize/auth`: registered claims plus this package's own
 * {@link AuthClaims}, which arrive **flat** because `createJwtPayload` spreads the bag.
 *
 * The members are `Partial` because a token minted by another layer (or an older one) may
 * carry none of them — which the access gate treats as "not approved".
 */
export type AuthJwtPayload = JwtPayload & Partial<AuthClaims>;

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

// `ResolvedEmail` now lives in `@lumenize/email` (the transport foundation).
// Re-exported here so internal `./types` imports and the public `@lumenize/auth`
// surface stay unchanged.
export type { ResolvedEmail } from '@lumenize/email';

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

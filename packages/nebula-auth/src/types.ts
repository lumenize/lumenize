/**
 * Nebula Auth types
 *
 * @see tasks/nebula-auth.md for the full architecture
 */

// Import + re-export shared types from @lumenize/auth
// (import makes them available locally; export passes them to consumers)
import type { ActClaim, ResolvedEmail, EmailMessage } from '@lumenize/auth';
export type { ActClaim, ResolvedEmail, EmailMessage };

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** The three tiers of the Nebula hierarchy */
export type Tier = 'universe' | 'galaxy' | 'star';

// ---------------------------------------------------------------------------
// Parsed universeGalaxyStarId
// ---------------------------------------------------------------------------

/** Result of parsing a `universeGalaxyStarId` string */
export interface ParsedId {
  /** Original input string */
  raw: string;
  /** Universe slug (always present) */
  universe: string;
  /** Galaxy slug (present for galaxy and star tiers) */
  galaxy?: string;
  /** Star slug (present for star tier only) */
  star?: string;
  /** Detected tier based on segment count */
  tier: Tier;
}

// ---------------------------------------------------------------------------
// JWT Claims
// ---------------------------------------------------------------------------

/** Scoped access entry in the JWT `access` claim */
export interface AccessEntry {
  /** Auth scope pattern — universeGalaxyStarId or wildcard (e.g. "george-solopreneur.*") */
  authScopePattern: string;
  /** true = admin of this scope; omitted when false (keeps JWT compact) */
  admin?: boolean;
}

/** Nebula JWT payload — extends standard JWT claims with nebula-specific access */
export interface NebulaJwtPayload {
  /** Issuer — always NEBULA_AUTH_ISSUER */
  iss: string;
  /** Audience — the active universeGalaxyStarId this token is scoped to.
   *  Set from the required `activeScope` field in the refresh/delegation request body. */
  aud: string;
  /** Subject UUID (within the issuing DO instance) */
  sub: string;
  /** Expiration (Unix seconds) */
  exp: number;
  /** Issued at (Unix seconds) */
  iat: number;
  /** JWT ID (UUID) */
  jti: string;
  /** Whether the subject has been approved by an admin */
  adminApproved: boolean;
  /** Subject's email address */
  email: string;
  /** Scoped access (one entry per JWT, issued by one DO instance) */
  access: AccessEntry;
  /** Delegation chain per RFC 8693 (optional) */
  act?: ActClaim;
}

// ---------------------------------------------------------------------------
// Subjects (row shape from NebulaAuth SQLite)
// ---------------------------------------------------------------------------

export interface Subject {
  sub: string;
  email: string;
  emailVerified: boolean;
  adminApproved: boolean;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface MagicLink {
  token: string;
  email: string;
  expiresAt: number;
}

export interface InviteToken {
  token: string;
  email: string;
  expiresAt: number;
}

export interface RefreshToken {
  tokenHash: string;
  subjectId: string;
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface RegistryInstance {
  instanceName: string;
  createdAt: number;
}

export interface RegistryEmail {
  email: string;
  instanceName: string;
  isAdmin: boolean;
  createdAt: number;
}

/** Discovery result returned by POST {prefix}/discover */
export interface DiscoveryEntry {
  instanceName: string;
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reserved DO instance for platform admin */
export const PLATFORM_INSTANCE_NAME = 'nebula-platform';

/** Singleton instance name for NebulaAuthRegistry */
export const REGISTRY_INSTANCE_NAME = 'registry';

/** Default URL prefix for all auth routes */
export const NEBULA_AUTH_PREFIX = '/auth';

/** Access token lifetime in seconds (15 minutes) */
export const ACCESS_TOKEN_TTL = 900;

/** Refresh token lifetime in seconds (30 days) */
export const REFRESH_TOKEN_TTL = 2592000;

/** Magic link lifetime in seconds (30 minutes) */
export const MAGIC_LINK_TTL = 1800;

/** Invite token lifetime in seconds (7 days) */
export const INVITE_TTL = 604800;

/** JWT issuer */
export const NEBULA_AUTH_ISSUER = 'https://nebula.lumenize.com';

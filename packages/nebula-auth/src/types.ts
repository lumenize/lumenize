/**
 * Nebula Auth types
 *
 * @see tasks/archive/nebula-auth.md — original auth architecture (archived design record;
 *   the current identity model is per the inline citations below + ADR-013).
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

/**
 * Nebula JWT payload — standard claims + nebula-specific `access`.
 *
 * `email` and `adminApproved` are NOT claims (removed in tasks/nebula-auth-surrogate-sub.md):
 * `email` is a registry-only mutable attribute (resolved via the registry when needed, never keyed
 * off), and `adminApproved` is retired (enforced at MINT — a valid token proves authorized
 * membership by construction, so there is no edge gate to feed).
 */
export interface NebulaJwtPayload {
  /** Issuer — always NEBULA_AUTH_ISSUER */
  iss: string;
  /** Audience — the active universeGalaxyStarId this token is scoped to.
   *  Set from the required `activeScope` field in the refresh/delegation request body. */
  aud: string;
  /** Subject — the registry-minted surrogate `sub` (one per email-in-a-scope). */
  sub: string;
  /** Expiration (Unix seconds — JWT NumericDate, ADR-011 carve-out) */
  exp: number;
  /** Issued at (Unix seconds — JWT NumericDate) */
  iat: number;
  /** JWT ID (UUID) */
  jti: string;
  /** Scoped access (one entry per JWT). */
  access: AccessEntry;
  /**
   * The bearer's PUBLIC profile address (a UUID) — a bare, first-party CUSTOM claim (RFC 7519 §4.3),
   * NOT the OIDC `profile` page-URL claim. Sibling of `sub`. The Profile DO's owner check is a direct
   * `claims.profileId === instanceName` equality (no URL to parse). Optional: a KV record predating the
   * profileId rollout mints gracefully without it. tasks/nebula-profile-store.md § JWT decisions.
   */
  profileId?: string;
  /** Delegation chain per RFC 8693 (optional) */
  act?: ActClaim;
}

// ---------------------------------------------------------------------------
// Registry row shapes (NebulaAuthRegistry SQLite — see schemas.ts)
// Timestamps are ISO 8601 Zulu strings (ADR-011); bearer tokens stored HASHED (`tokenHash`).
// ---------------------------------------------------------------------------

/** `Scopes` row — scope existence (was `Instances`). */
export interface Scope {
  universeGalaxyStarId: string;
}

/** `Identities` row — person-in-a-scope (merged `Emails` + `Subjects`). */
export interface Identity {
  /** Registry-minted surrogate identity key (UUID). */
  sub: string;
  /** Registry-minted PUBLIC address (UUID) — minted WITH `sub`, distinct namespace. `sub → exactly
   *  one profileId`; `profileId ← 1..N subs` (the P2 unification substrate). tasks/nebula-profile-store.md. */
  profileId: string;
  universeGalaxyStarId: string;
  /** MUTABLE current login address (lowercased). The ONLY copy. */
  email: string;
  isAdmin: boolean;
  /** Per-scope proof-click. Replaces the retired `adminApproved` as the "authorized member" signal. */
  emailVerified: boolean;
  createdAt: string;
}

/** `RefreshTokenIndex` row — live-token index for reliable KV invalidation. */
export interface RefreshTokenIndex {
  tokenHash: string;
  sub: string;
  expiresAt: string;
}

/** The Workers-KV refresh record (`refresh:{tokenHash}`), read at the edge on refresh — no registry.
 *  `expiresAt` (absolute) is re-applied on a convergence re-put (CF KV drops expirationTtl on put). */
export interface RefreshTokenKV {
  sub: string;
  universeGalaxyStarId: string;
  isAdmin: boolean;
  expiresAt: string;
  /** The bearer's `profileId` — carried so the pure-KV refresh mint can emit the `profileId` JWT claim
   *  without a registry read. Written by all three record writers (record/converge/self-heal);
   *  tasks/nebula-profile-store.md Phase 1. */
  profileId: string;
}

/** `MagicLinks` row — login channel, token stored HASHED. */
export interface MagicLink {
  tokenHash: string;
  email: string;
  universeGalaxyStarId: string;
  expiresAt: string;
}

/** `InviteTokens` row — login channel, token stored HASHED, single-use. */
export interface InviteToken {
  tokenHash: string;
  email: string;
  universeGalaxyStarId: string;
  expiresAt: string;
}

/** Discovery result returned by POST {prefix}/discover. `sub`-free by design — `discover` is
 *  unauthenticated/unthrottled, so it must never leak the surrogate identity key. */
export interface DiscoveryEntry {
  universeGalaxyStarId: string;
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

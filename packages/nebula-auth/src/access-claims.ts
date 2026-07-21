/**
 * Shared Nebula access-claim construction — the single source of truth for the JWT
 * `access` shape and the full {@link NebulaJwtPayload}.
 *
 * Reused by BOTH mint paths so a token minted anywhere is byte-for-byte the shape the
 * server issues:
 *   - the production Worker mint — `worker-token.mintAccessToken` (refresh / delegated-token);
 *   - the test-util mint — {@link createNebulaTestToken} (a Node harness with the `.dev.vars` key).
 *
 * `email` and `adminApproved` are NOT claims (tasks/nebula-auth-surrogate-sub.md): `email` is a
 * registry-only mutable attribute (resolved via the registry when needed, never keyed off), and
 * `adminApproved` is retired — enforced at MINT (the registry refuses to mint for an absent/
 * unverified identity, so a valid token proves authorized membership by construction).
 *
 * This is the "factor out to share, don't copy" seam. A second (or third) hand-rolled copy
 * of the `access: { authScopePattern, admin? }` shape is exactly the drift the de-fork task
 * ([`on-hold/auth-token-core-compose-not-fork.md`]) is shrinking — so new mint sites compose
 * this, never re-emit `access:{...}` inline.
 *
 * PURE by construction: imports only `./parse-id`, `./types`, and the Node-safe
 * `@lumenize/auth/client` JWT primitives — no `cloudflare:workers` — so it is safe to pull
 * into the Node-safe `@lumenize/nebula-auth/testing` subpath. Signing stays with the caller
 * (the server resolves BLUE/GREEN from env; the test-util reads `.dev.vars`).
 */
import { generateUuid } from '@lumenize/auth/client';
import type { AccessEntry, NebulaJwtPayload } from './types';
import { ACCESS_TOKEN_TTL, NEBULA_AUTH_ISSUER } from './types';
import { buildAuthScopePattern, matchAccess } from './parse-id';

/** Inputs for {@link buildNebulaJwtPayload}. */
export interface NebulaAccessClaimInput {
  /** The registry-minted surrogate `sub` (one per email-in-a-scope) — the identity key. */
  sub: string;
  /** Issuing scope (universeGalaxyStarId) — drives the `authScopePattern`. */
  instanceName: string;
  /** JWT `aud` — the active scope this token is bound to. MUST be covered by the pattern. */
  activeScope: string;
  /** `access.admin` is set only when true (kept omitted otherwise to keep the JWT compact). */
  isAdmin: boolean;
  /** The bearer's PUBLIC profile address (UUID) → the bare custom `profileId` claim. Omitted when
   *  absent (a pre-rollout KV record mints gracefully without it). tasks/nebula-profile-store.md. */
  profileId?: string;
  /** RFC 8693 delegation actor sub (`act.sub`) — omitted when absent. */
  actorSub?: string;
  /**
   * Override the minted `access.authScopePattern` (default: {@link buildAuthScopePattern} of `instanceName`).
   * Set ONLY by the `/delegated-token` mint, to bind the token to the **caller's** covered scope
   * (scope-bounded delegation) — never the issuing instance's pattern nor the target's. MUST still cover
   * `activeScope` (the internal-consistency self-check below enforces it).
   */
  authScopePattern?: string;
  /** Token TTL in seconds. Default {@link ACCESS_TOKEN_TTL}. */
  ttlSeconds?: number;
  /** "now" in Unix seconds. Default `Math.floor(Date.now() / 1000)`; injectable for tests. */
  nowSeconds?: number;
}

/**
 * Build the scoped `access` entry: the tier-aware auth-scope pattern for `instanceName`,
 * plus `admin: true` iff `isAdmin`.
 *
 * `authScopePatternOverride` bounds the pattern to something other than the issuing instance's
 * (the `/delegated-token` scope-bounded mint passes the caller's covered scope); default derives
 * from `instanceName`, the shape every non-delegated mint keeps.
 *
 * ✅ **The MINT-SIDE half of the confinement invariant.** This is the single site where `admin` and
 * `authScopePattern` are produced together, so `admin` is never emitted without a pattern — which
 * is what lets `hasAdminOverScope` treat a missing pattern as fail-closed rather than as a normal
 * case. `buildNebulaJwtPayload` below adds the other mint-side guarantee: `aud` ⊆ `authScopePattern`.
 *
 * ⚠️ **`aud` ⊆ pattern is NOT the property the guards need.** The old `dag-tree.ts` comment
 * justified a bare-bit bypass by appealing to exactly this invariant — correct, but it establishes
 * only that the caller's ACTIVE SCOPE sits inside their authority. The guards ask a different
 * question: does the pattern cover **the callee node**? `enforceScopeReach`'s tenant branch
 * deliberately admits callers whose `aud` sits BELOW the node, so the two are not the same, and the
 * gap between them was the escalation. See tasks/nebula-confine-admin-bypass.md.
 */
export function buildNebulaAccessEntry(
  instanceName: string,
  isAdmin: boolean,
  authScopePatternOverride?: string,
): AccessEntry {
  const authScopePattern = authScopePatternOverride ?? buildAuthScopePattern(instanceName);
  const access: AccessEntry = { authScopePattern };
  if (isAdmin) access.admin = true;
  return access;
}

/**
 * Build the full Nebula JWT payload (unsigned).
 *
 * Enforces the internal-consistency invariant — the active scope (`aud`) must be covered by
 * the derived `authScopePattern` — throwing the same error the server mint does. This is
 * defense-in-depth mirrored at `router.verifyNebulaAccessToken`: it makes an inconsistent
 * token impossible to construct here, not merely rejected downstream.
 */
export function buildNebulaJwtPayload(input: NebulaAccessClaimInput): NebulaJwtPayload {
  const access = buildNebulaAccessEntry(input.instanceName, input.isAdmin, input.authScopePattern);
  if (!matchAccess(access.authScopePattern, input.activeScope)) {
    throw new Error(
      `Requested scope "${input.activeScope}" not covered by access pattern "${access.authScopePattern}"`,
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iss: NEBULA_AUTH_ISSUER,
    aud: input.activeScope,
    sub: input.sub,
    exp: now + (input.ttlSeconds ?? ACCESS_TOKEN_TTL),
    iat: now,
    jti: generateUuid(),
    access,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.actorSub ? { act: { sub: input.actorSub } } : {}),
  };
}

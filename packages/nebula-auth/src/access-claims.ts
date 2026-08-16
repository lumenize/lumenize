/**
 * Shared Nebula access-claim construction — the single source of truth for the JWT
 * `access` shape and the full {@link NebulaJwtPayload}.
 *
 * Reused by BOTH mint paths so a token minted anywhere is byte-for-byte the shape the
 * server issues:
 *   - the production Worker mint — `worker-token.mintAccessToken` (refresh / mint-narrower-token);
 *   - the test-util mint — {@link createNebulaTestToken} (a Node harness with the `.dev.vars` key).
 *
 * `email` and `adminApproved` are NOT claims (tasks/nebula-auth-surrogate-sub.md): `email` is a
 * registry-only mutable attribute (resolved via the registry when needed, never keyed off), and
 * `adminApproved` is retired — enforced at MINT (the registry refuses to mint for an absent/
 * unverified identity, so a valid token proves authorized membership by construction).
 *
 * This is the "factor out to share, don't copy" seam. A second (or third) hand-rolled copy
 * of the `access: { authScope, scopeAdmin? }` shape is exactly the drift the de-fork task
 * ([`tasks/archive/nebula-auth-decouple-from-auth.md`]) is shrinking — so new mint sites compose
 * this, never re-emit `access:{...}` inline.
 *
 * PURE by construction: imports only `./parse-id` and `./types` — no `cloudflare:workers`, and as of
 * 2026-07-31 no crypto import either (the `jti` is a direct `crypto.randomUUID()` call) — so it is
 * safe to pull into the Node-safe `@lumenize/nebula-auth/testing` subpath. Signing stays with the caller
 * (the server resolves BLUE/GREEN from env; the test-util reads `.dev.vars`).
 */
import type { AccessEntry, NebulaJwtPayload } from './types';
import { ACCESS_TOKEN_TTL, NEBULA_AUTH_ISSUER } from './types';
import { isAtOrAbove } from './parse-id';

/** Inputs for {@link buildNebulaJwtPayload}. */
export interface NebulaAccessClaimInput {
  /** The registry-minted surrogate `sub` (one per email-in-a-scope) — the identity key. */
  sub: string;
  /** Issuing scope (universeGalaxyStarId) — becomes the minted `access.authScope`. */
  instanceName: string;
  /** JWT `aud` — the active scope this token is bound to. MUST sit at or below `access.authScope`. */
  activeScope: string;
  /** `access.scopeAdmin` is set only when true (kept omitted otherwise to keep the JWT compact). */
  scopeAdmin: boolean;
  /** The bearer's PUBLIC profile address (UUID) → the bare custom `profileId` claim. Omitted when
   *  absent (a pre-rollout KV record mints gracefully without it). tasks/nebula-profile-store.md. */
  profileId?: string;
  /**
   * RFC 8693 delegation **actor pair** → the `act` claim. Omitted entirely when absent.
   *
   * The claims of a narrower token describe two people: the top-level `sub`/`profileId` pair is the
   * SUBJECT (whose access this is) and `act` is the ACTOR (who is driving). `actor.profileId` is
   * omitted from the emitted claim when the actor's own token carries none.
   */
  actor?: { sub: string; profileId?: string };
  /**
   * Override the minted `access.authScope` (default: `instanceName`).
   * Set ONLY by the `/mint-narrower-token` mint, to bind the token to the **requested** `activeScope`
   * — never the issuing instance's scope. That scope is separately bounded by BOTH the caller's
   * dominion and the subject's (`worker-token.mintNarrowerToken`), so it can exceed neither. MUST
   * still sit at or above `activeScope` (the internal-consistency self-check below enforces it).
   */
  authScopeOverride?: string;
  /** Token TTL in seconds. Default {@link ACCESS_TOKEN_TTL}. */
  ttlSeconds?: number;
  /** "now" in Unix seconds. Default `Math.floor(Date.now() / 1000)`; injectable for tests. */
  nowSeconds?: number;
}

/**
 * Build the scoped `access` entry: the issuing scope verbatim, plus `scopeAdmin: true` iff admin.
 *
 * `authScopeOverride` binds the claim to something other than the issuing instance's scope (the
 * `/mint-narrower-token` scope-bounded mint passes the requested `activeScope`); the default is
 * `instanceName` itself, the shape every ordinary mint keeps.
 *
 * ⚠️ **Neither argument is parsed here, deliberately.** Both live callers pass a server-trusted
 * `instanceName` — a registry row or a verified claim — and the one client-supplied value that
 * reaches the override (`/mint-narrower-token`'s `activeScope`) is parsed at its own request
 * boundary, where a malformed value can answer 400 instead of a blanket 500.
 *
 * ✅ **The MINT-SIDE half of the confinement invariant.** This is the single site where `scopeAdmin`
 * and `authScope` are produced together, so the bit is never emitted without a scope — which is what
 * lets `hasDominionOver` treat a missing scope as fail-closed rather than as a normal case.
 * `buildNebulaJwtPayload` below adds the other mint-side guarantee: `aud` is at or below `authScope`.
 *
 * ⚠️ **That containment is NOT the property the guards need.** The old `dag-tree.ts` comment
 * justified a bare-bit bypass by appealing to exactly this invariant — correct, but it establishes
 * only that the caller's ACTIVE SCOPE sits inside their dominion. The guards ask a different
 * question: is **the callee node** at or below `authScope`? `requirePassage`'s tenant branch
 * deliberately admits callers whose `aud` sits BELOW the node, so the two are not the same, and the
 * gap between them was the escalation. See tasks/nebula-confine-admin-bypass.md.
 */
export function buildNebulaAccessEntry(
  instanceName: string,
  scopeAdmin: boolean,
  authScopeOverride?: string,
): AccessEntry {
  const access: AccessEntry = { authScope: authScopeOverride ?? instanceName };
  if (scopeAdmin) access.scopeAdmin = true;
  return access;
}

/**
 * Build the full Nebula JWT payload (unsigned).
 *
 * Enforces the internal-consistency invariant — the active scope (`aud`) must sit at or below
 * the minted `authScope` — throwing the same error the server mint does. This is
 * defense-in-depth mirrored at `router.verifyNebulaAccessToken`: it makes an inconsistent
 * token impossible to construct here, not merely rejected downstream.
 */
/** The acting-principal record: every party to an action, projected from verified claims. */
export interface ActingTokenRecord {
  /** The AUTHORITY principal — the token's subject. ⚠️ Under impersonation this is the person acted
   *  UPON, not the actor; the actor is `act.sub`. Never read this alone to answer "who did it". */
  sub: string;
  /** The complete delegation chain, or absent when the subject acted for themselves. */
  act?: NebulaJwtPayload['act'];
  profileId?: string;
  /** Authority as ASSERTED at write time. Immutable history — never read back as an authz input. */
  access?: NebulaJwtPayload['access'];
}

/**
 * Project verified claims into the ADR-016 acting-principal record — **the one shared projection; no
 * site assembles its own.**
 *
 * ⚠️ **Named for the TOKEN, never for a role.** `actingToken.sub` reads as *the token's subject*,
 * which is what it is. Every role name inverts: `actor.sub` reads as "the actor" but holds the person
 * acted *upon* — the misreading ADR-016 exists to prevent, and it would be believed. `actingClaims`
 * is the same defect one step removed, since "the acting claims" still invites "the acting sub".
 *
 * ⚠️ **Pass the CLAIMS, never a pre-picked `sub`.** A bare string cannot carry the `act` chain, so a
 * caller that narrows to `claims.sub` before calling here silently produces a record naming the wrong
 * human under impersonation — which ADR-016 calls affirmatively wrong and worse than no record. Taking
 * the whole payload is what makes that shape impossible to write.
 */
export function projectActingToken(claims: NebulaJwtPayload): ActingTokenRecord {
  return { sub: claims.sub, act: claims.act, profileId: claims.profileId, access: claims.access };
}

export function buildNebulaJwtPayload(input: NebulaAccessClaimInput): NebulaJwtPayload {
  const access = buildNebulaAccessEntry(input.instanceName, input.scopeAdmin, input.authScopeOverride);
  // Structural — two strings, no `scopeAdmin` operand. It asserts the token is internally
  // consistent, never that the subject holds dominion anywhere.
  if (!isAtOrAbove(access.authScope, input.activeScope)) {
    throw new Error(
      `Requested scope "${input.activeScope}" is not at or below auth scope "${access.authScope}"`,
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iss: NEBULA_AUTH_ISSUER,
    aud: input.activeScope,
    sub: input.sub,
    exp: now + (input.ttlSeconds ?? ACCESS_TOKEN_TTL),
    iat: now,
    jti: crypto.randomUUID(),
    access,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    // ⚠️ The `profileId` key is spread CONDITIONALLY inside `act`, never `act` itself conditionally:
    // `!claims.act` (the Profile owner guard) keys on the presence of `act`, so an `act` that
    // disappeared when the actor had no `profileId` would silently defeat that guard.
    ...(input.actor
      ? { act: { sub: input.actor.sub, ...(input.actor.profileId ? { profileId: input.actor.profileId } : {}) } }
      : {}),
  };
}

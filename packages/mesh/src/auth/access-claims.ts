/**
 * Shared Nebula access-claim construction — the single source of truth for the JWT
 * `access` shape and the full {@link AuthClaims}.
 *
 * Reused by BOTH mint paths so a token minted anywhere is byte-for-byte the shape the
 * server issues:
 *   - the production Worker mint — `worker-token.mintAccessToken` (the refresh and the impersonation mint);
 *   - the test-util mint — {@link createTestToken} (a Node harness with the `.dev.vars` key).
 *
 * `email` and `adminApproved` are NOT claims (tasks/archive/nebula-auth-surrogate-sub.md): `email` is a
 * registry-only mutable attribute (resolved via the registry when needed, never keyed off), and
 * `adminApproved` is retired — enforced at MINT (the registry refuses to mint for an absent/
 * unverified identity, so a valid token proves authorized membership by construction).
 *
 * This is the "factor out to share, don't copy" seam. A second (or third) hand-rolled copy
 * of the `access: { authScope, scopeAdmin? }` shape is exactly the drift the de-fork task
 * ([`tasks/archive/nebula-auth-decouple-from-auth.md`]) is shrinking — so new mint sites compose
 * this, never re-emit `access:{...}` inline.
 *
 * PURE by construction: imports only `./parse-id` and `./types` — no `cloudflare:workers`, and as
 * of 2026-07-31 no crypto import either (the `jti` is a direct `crypto.randomUUID()` call) — so the
 * Node-safe `@lumenize/mesh/auth/testing` subpath and `@lumenize/mesh/client` re-export from it. That
 * is the route by which a module in a Node-safe value graph (e.g. Resources' `snapshots.ts`, reachable
 * from its client subpath) takes `projectActingToken` without the Registry DO (`cloudflare:workers`).
 * Signing stays with the caller (the server resolves BLUE/GREEN from env; the test-util reads
 * `.dev.vars`).
 */
import type { AccessEntry, ActClaim, AuthClaims } from './types';
import { ACCESS_TOKEN_TTL } from './types';
import { isAtOrAbove } from './parse-id';

/** Inputs for {@link buildAuthClaims}. */
export interface AccessClaimInput {
  /** The deployment's issuer, `platformOrigin(deploymentOrigin(env))`. A parameter, because this
   *  module has no `env`: each mint site threads it from the Worker's own. */
  issuer: string;
  /** The registry-minted surrogate `sub` (one per email-in-a-scope) — the identity key. */
  sub: string;
  /** Issuing scope (universeGalaxyStarId) — becomes the minted `access.authScope`. */
  instanceName: string;
  /** JWT `aud` — the active scope this token is bound to. MUST sit at or below `access.authScope`. */
  activeScope: string;
  /** `access.scopeAdmin` is set only when true (kept omitted otherwise to keep the JWT compact). */
  scopeAdmin: boolean;
  /** The bearer's PUBLIC profile address (UUID) → the bare custom `profileId` claim. ADR-013's
   *  licensed JWT copy. */
  profileId: string;
  /**
   * RFC 8693 delegation **actor pair** → the `act` claim. Omitted entirely when absent.
   *
   * The claims of a narrower token describe two people: the top-level `sub`/`profileId` pair is the
   * SUBJECT (whose access this is) and `act` is the ACTOR (who is driving).
   */
  actor?: { sub: string; profileId: string };
  /** Token TTL in seconds. Default {@link ACCESS_TOKEN_TTL}. */
  ttlSeconds?: number;
  /** "now" in Unix seconds. Default `Math.floor(Date.now() / 1000)`; injectable for tests. */
  nowSeconds?: number;
}

/**
 * Build the scoped `access` entry: the issuing scope verbatim, plus `scopeAdmin: true` iff admin.
 * Every mint binds the claim to `instanceName` itself — there is no override, so a token whose
 * `authScope` is decoupled from its issuing scope is not constructible (the impersonation mint
 * passes the SUBJECT's scope as `instanceName`, which is the point).
 *
 * ⚠️ **The argument is not parsed here, deliberately.** Every live caller passes a server-trusted
 * `instanceName` — a registry row or a verified claim — parsed (where client-supplied input feeds
 * it) at its own request boundary, where a malformed value can answer 400 instead of a blanket 500.
 *
 * ✅ **The MINT-SIDE half of the confinement invariant.** This is the single site where `scopeAdmin`
 * and `authScope` are produced together, so the bit is never emitted without a scope — which is what
 * lets `hasDominionOver` treat a missing scope as fail-closed rather than as a normal case.
 * `buildAuthClaims` below adds the other mint-side guarantee: `aud` is at or below `authScope`.
 *
 * ⚠️ **That containment is NOT the property the guards need.** The old `org-tree.ts` comment
 * justified a bare-bit bypass by appealing to exactly this invariant — correct, but it establishes
 * only that the caller's ACTIVE SCOPE sits inside their dominion. The guards ask a different
 * question: is **the callee node** at or below the page's host, `aud`, for an admin? Passage
 * deliberately admits callers whose `aud` sits BELOW the node, so the two are not the same, and the
 * gap between them was the escalation. See tasks/archive/nebula-confine-admin-bypass.md.
 */
export function buildAccessEntry(
  instanceName: string,
  scopeAdmin: boolean,
): AccessEntry {
  const access: AccessEntry = { authScope: instanceName };
  if (scopeAdmin) access.scopeAdmin = true;
  return access;
}

/**
 * RFC 8693 §4.1 chain nesting, written ONCE: prepend `actor` as the NEW OUTERMOST `act` entry,
 * preserving any pre-existing verified chain beneath it. Flattening/overwriting DROPS the
 * delegation chain — the wrong shape this helper exists to make unwritable. Callers: the
 * server-composed actor on an `actingToken` RECORD (`apps/nebula` snapshots.ts
 * `#buildActingToken`) and any later cross-node mint path, so the two cannot drift on the
 * RFC semantics.
 *
 * ⚠️ **Applies to an actingToken RECORD only — never to a TOKEN.** A live refusal keys on an actor
 * chain being PRESENT and would fire on a session token that grew one: `worker-token.ts`'s
 * root-identity gate refuses to re-narrow. Prepend an actor into somebody's own session token and
 * they lose their ability to impersonate, for a reason nobody intended. If a token ever seems to
 * need this, the fix is to keep it off that path — never to start comparing the chain's identity to
 * the subject's, which `security.md` rule (1) forbids outright.
 *
 * The actor arrives as the PAIR — a bare `actorSub` would drop the `profileId` the chain is
 * supposed to carry for display — and the emitted entry matches `buildAuthClaims`'s `act`
 * shape.
 */
export function prependActor(
  base: ActClaim | undefined,
  actor: { sub: string; profileId: string },
): ActClaim {
  return {
    sub: actor.sub,
    profileId: actor.profileId,
    ...(base ? { act: base } : {}),
  };
}

/** The acting-principal record: every party to an action, projected from verified claims. */
export interface ActingTokenRecord {
  /** The AUTHORITY principal — the token's subject. ⚠️ Under impersonation this is the person acted
   *  UPON, not the actor; the actor is `act.sub`. Never read this alone to answer "who did it". */
  sub: string;
  /** The complete delegation chain, or absent when the subject acted for themselves. */
  act?: AuthClaims['act'];
  profileId: string;
  /** Authority as ASSERTED at write time. Immutable history — never read back as an authz input. */
  access?: AuthClaims['access'];
  /** The page the call came from, whose scope bounds how far it reaches (ADR-016). Asserted history,
   *  like `access`. */
  aud?: string;
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
export function projectActingToken(claims: AuthClaims): ActingTokenRecord {
  return { sub: claims.sub, act: claims.act, profileId: claims.profileId, access: claims.access, aud: claims.aud };
}

/**
 * Build the full Nebula JWT payload (unsigned).
 *
 * Enforces the two internal-consistency invariants verification checks — the active scope (`aud`)
 * sits at or below the minted `authScope`, and equals it for a plain membership — throwing as the
 * server mint does. This is defense-in-depth mirrored at `verifyAccessToken`: it makes an
 * inconsistent token impossible to construct here, not merely rejected downstream.
 */
export function buildAuthClaims(input: AccessClaimInput): AuthClaims {
  const access = buildAccessEntry(input.instanceName, input.scopeAdmin);
  // Structural — two strings, no `scopeAdmin` operand. It asserts the token is internally
  // consistent, never that the subject holds dominion anywhere.
  if (!isAtOrAbove(access.authScope, input.activeScope)) {
    throw new Error(
      `Requested scope "${input.activeScope}" is not at or below auth scope "${access.authScope}"`,
    );
  }
  // A plain membership mints on its own host alone, so its token's host scope is its membership's.
  // Verification refuses anything else, since passage reads `aud` and would otherwise reach below.
  if (!access.scopeAdmin && input.activeScope !== access.authScope) {
    throw new Error(
      `A plain membership at "${access.authScope}" mints only for its own scope, not "${input.activeScope}"`,
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iss: input.issuer,
    aud: input.activeScope,
    sub: input.sub,
    exp: now + (input.ttlSeconds ?? ACCESS_TOKEN_TTL),
    iat: now,
    jti: crypto.randomUUID(),
    access,
    profileId: input.profileId,
    ...(input.actor ? { act: { sub: input.actor.sub, profileId: input.actor.profileId } } : {}),
  };
}

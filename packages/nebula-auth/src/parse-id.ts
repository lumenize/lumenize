/**
 * universeGalaxyStarId parsing and validation
 *
 * Slugs: lowercase letters, digits, and hyphens only (`[a-z0-9-]+`).
 * No periods within a slug. 1–3 dot-separated slugs determine the tier.
 *
 * This module is the source of truth for the id format and for the two structural containment
 * predicates the coarse-grained verdicts are built from (ADR-015 § *Predicate pair*).
 *
 * ---
 *
 * ## The containment allow-list
 *
 * **A call to {@link isAtOrAbove} or {@link isAtOrBelow} outside {@link hasDominionOver},
 * {@link hasPassageInto}, or this list is non-conformant by definition** — that is what makes the
 * next one show up in a grep rather than in a review:
 *
 * ```sh
 * grep -rn 'isAtOrAbove(\|isAtOrBelow(' packages/*&#47;src apps/nebula/src --include='*.ts' \
 *   | grep -vE ':[0-9]+: *(\*|//|/\*)' | grep -v 'parse-id.ts'
 * ```
 *
 * ⚠️ **A short list of EXCEPTIONS, never an inventory of sites.** An inventory rots on the next
 * unrelated edit; this fails loudly the moment a hit appears that is not on it. Every entry carries
 * its class and its reason, because "it looked fine" is how the wrong one gets added:
 *
 * - **`verify.ts` — token-internal consistency · STRUCTURAL.** Asserts `aud` is at or below the
 *   token's own `authScope`. There is no principal question here and it takes **no `scopeAdmin`
 *   conjunction**; the Gateway's outbound `aud` fence assumes this holds.
 * - **`access-claims.ts` `buildNebulaJwtPayload` — mint-side construction invariant · STRUCTURAL.**
 *   The same assertion on the way out, so an inconsistent token is impossible to *construct* rather
 *   than merely rejected downstream. Again no `scopeAdmin` operand.
 * - **`router.ts` `verifyInstanceJwt` — DOMINION, split across a FILE boundary · sibling named.**
 *   The containment half only. `worker-token.ts`'s `handleInvite` completes the conjunction with its
 *   bare `scopeAdmin` read, and that split is *required*: `raw-comm.md` puts expected client-errors
 *   on the Worker before the RPC. ⚠️ Adding the bit here hardens nothing and breaks every
 *   non-admin route; the two halves are one decision and must be read together.
 * - **`worker-token.ts` `handleRefreshToken` — the `activeScope` confine · STRUCTURAL.** Bounds a
 *   client-supplied scope inside the KV record's server-trusted one. The record *is* the authority,
 *   so no claim is consulted and no bit applies.
 * - **`worker-token.ts` `mintNarrowerToken` caller bound — DOMINION, split within THIS file.**
 *   Completed by the `hasDominionOver` eligibility check a few lines below; it survives for its
 *   distinct `insufficient_scope` code and its caller-facing message.
 * - **`worker-token.ts` `mintNarrowerToken` subject bound — STRUCTURAL.** Bounds `activeScope`
 *   inside the *subject's* own scope so the minted token mirrors that person. Not a question about
 *   any principal's authority, so it takes no bit.
 *
 * ⚠️ **A second class this grep is structurally blind to: containment computed BY VALUE.**
 * `b === a || b.startsWith(a + '.')` in TypeScript and `LIKE ${prefix + '.%'}` in SQL both compute
 * `isAtOrAbove` without spelling it. Two such sites are allow-listed, both in
 * `nebula-auth-registry.ts` (`myScopeTree`'s enumeration and `#computeDeletionPlan`'s cascade), each
 * with its reason at the site: the query **is** the bound, and routing per row would require
 * fetching every scope first — the work those arms exist to avoid. Sweep them with
 * `grep -rnE "startsWith\(.*'\.'|\. *%"`.
 */

import type { AccessEntry, ParsedId, Tier } from './types';
import { PLATFORM_SCOPE } from './types';

/** Regex for a single slug segment: lowercase alphanumeric + hyphens, at least 1 char */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a single slug segment.
 * Must be lowercase alphanumeric + hyphens, cannot start or end with a hyphen,
 * and cannot contain consecutive hyphens.
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || !SLUG_RE.test(slug)) return false;
  if (slug.endsWith('-')) return false;
  if (slug.includes('--')) return false;
  return true;
}

/**
 * Parse and validate a `universeGalaxyStarId` string.
 *
 * @param id - Dot-separated string of 1–3 slug segments
 * @returns Parsed result with tier, individual slugs, and raw input
 * @throws {Error} If the id is invalid
 *
 * @example
 * ```typescript
 * parseId("george-solopreneur") // { tier: "universe", universe: "george-solopreneur", raw: "george-solopreneur" }
 * parseId("george-solopreneur.app") // { tier: "galaxy", universe: "george-solopreneur", galaxy: "app", raw: "..." }
 * parseId("george-solopreneur.app.tenant") // { tier: "star", universe: "george-solopreneur", galaxy: "app", star: "tenant", raw: "..." }
 * ```
 */
export function parseId(id: string): ParsedId {
  if (!id || typeof id !== 'string') {
    throw new Error('universeGalaxyStarId must be a non-empty string');
  }

  const segments = id.split('.');

  if (segments.length < 1 || segments.length > 3) {
    throw new Error(
      `universeGalaxyStarId must have 1–3 dot-separated segments, got ${segments.length}: "${id}"`
    );
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!isValidSlug(seg)) {
      throw new Error(
        `Invalid slug at position ${i + 1}: "${seg}". ` +
        'Slugs must contain only lowercase letters, digits, and hyphens, ' +
        'cannot start or end with a hyphen, and cannot contain consecutive hyphens.'
      );
    }
  }

  const tiers: Tier[] = ['universe', 'galaxy', 'star'];
  const tier = tiers[segments.length - 1]!;

  const result: ParsedId = {
    raw: id,
    universe: segments[0]!,
    tier,
  };

  if (segments.length >= 2) result.galaxy = segments[1]!;
  if (segments.length === 3) result.star = segments[2]!;

  return result;
}

/**
 * Check if a universeGalaxyStarId is the reserved platform instance.
 */
export function isPlatformScope(id: string): boolean {
  return id === PLATFORM_SCOPE;
}

/**
 * Derive the parent instanceName from a parsed id.
 * Universe-tier instances have no parent (returns undefined).
 *
 * @example
 * ```typescript
 * getParentId(parseId("acme.crm.tenant")) // "acme.crm"
 * getParentId(parseId("acme.crm"))        // "acme"
 * getParentId(parseId("acme"))            // undefined
 * ```
 */
export function getParentId(parsed: ParsedId): string | undefined {
  if (parsed.tier === 'universe') return undefined;
  if (parsed.tier === 'galaxy') return parsed.universe;
  // star tier
  return `${parsed.universe}.${parsed.galaxy}`;
}

/**
 * Structural fact: does `myScope` cover `targetScope` — the same scope, or an ancestor of it?
 *
 * The reserved platform scope is the **root** of the scope tree, so it is at or above every scope.
 * That branch lives here, once, which is what lets a superuser work without a special arm at any
 * call site (ADR-015 § *Predicate pair*).
 *
 * ⚠️ **Comparison is by WHOLE dot-separated segments — a contract, not an implementation detail.**
 * The obvious `targetScope.startsWith(myScope)` silently makes `u.g.s1` cover `u.g.s10`, and `acme`
 * cover `acme-2`; both are legal slugs, so both would be a cross-tenant hole.
 *
 * ⚠️ Unconditional by design — two strings in, a boolean out. It knows nothing about tokens,
 * principals, or the 1–3-segment tier grammar; a caller that needs the grammar enforced parses at
 * its own request boundary. Absent-claim handling belongs to the verdicts, never here.
 */
export function isAtOrAbove(myScope: string, targetScope: string): boolean {
  if (isPlatformScope(myScope)) return true;
  if (myScope === targetScope) return true;
  return targetScope.startsWith(myScope + '.');
}

/**
 * Structural fact: does `myScope` sit at or beneath `targetScope` — the same scope, or a descendant?
 *
 * Exactly {@link isAtOrAbove} with the arguments flipped, and implemented that way deliberately: the
 * identity `isAtOrAbove(A, B) === isAtOrBelow(B, A)` becomes structural rather than a property two
 * functions must both remember, and the platform-root branch is inherited rather than repeated.
 * Every scope is at or below the platform root.
 *
 * ⚠️ Both predicates take `(myScope, targetScope)` in that order, always. A transposed call is not a
 * type error and not a test failure — it silently inverts the security model. That risk is why this
 * symbol exists at all, rather than callers spelling the upward arm with swapped arguments.
 */
export function isAtOrBelow(myScope: string, targetScope: string): boolean {
  return isAtOrAbove(targetScope, myScope);
}

/**
 * **The single dominion predicate**: is this access claim admin *over `targetScope`*?
 *
 * `scopeAdmin` alone is never dominion — it is dominion only over what the claim's `authScope`
 * actually covers. Every guard that consults `access.scopeAdmin` must ask this question about the
 * scope it is acting on, or an admin of a child scope acts as admin on its ancestors.
 *
 * Fail-closed on an absent or empty claim: no principal, no dominion. A verified token always
 * carries `authScope`, so that arm guards hand-constructed and partially-populated claims rather
 * than a live path.
 *
 * One predicate, one place to audit (ADR-007) — do not re-inline this conjunction anywhere.
 */
export function hasDominionOver(access: AccessEntry | undefined, targetScope: string): boolean {
  if (!access?.scopeAdmin || !access.authScope) return false;
  return isAtOrAbove(access.authScope, targetScope);
}

/**
 * **The single passage predicate**: may this access claim reach `targetScope` at all?
 *
 * The **union** of two arms, not the upward one alone (ADR-015 § *Terminology*):
 *  - the caller's own scope sits **at or below** the target — a member of a child reaching its
 *    parent, which confers no dominion whatsoever; OR
 *  - the caller holds **dominion** there, which is the whole downward rule.
 *
 * ⚠️ **Writing this as the upward arm alone refuses the entire downward rule** — an admin at `{u}`
 * calling `{u}.{g}.{s}` has passage *because* they hold dominion there. Writing it as dominion alone
 * refuses every non-admin their own scope. Both arms, always.
 *
 * ⚠️ **Passage is NOT dominion, and lacking dominion is not a denial.** A caller with passage may
 * still be granted a great deal by the methods it reaches — that is the callee's own guards' call,
 * not this predicate's.
 *
 * ⚠️ **Fail-closed on an absent or empty claim: no principal, no passage — and it returns `false`
 * rather than throwing.** Stated here because it cannot be inherited: {@link hasDominionOver} is
 * accidentally protected by its own `scopeAdmin` test, but the upward arm has **no `scopeAdmin`
 * operand** by construction and the mint omits the bit for every non-admin — so without this guard
 * an absent claim would reach an unguarded string op on the ordinary non-admin path. Deliberately
 * NOT pushed down onto {@link isAtOrAbove}, which is an unconditional two-string fact.
 *
 * One predicate, one place to audit (ADR-007) — do not re-inline this disjunction anywhere.
 */
export function hasPassageInto(access: AccessEntry | undefined, targetScope: string): boolean {
  if (!access?.authScope) return false;
  return isAtOrBelow(access.authScope, targetScope) || hasDominionOver(access, targetScope);
}

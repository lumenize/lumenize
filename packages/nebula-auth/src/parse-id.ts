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
 * grep -rn 'isAtOrAbove(\|isAtOrBelow(' apps/nebula/src apps/nebula-studio-ui/src packages --include='*.ts' \
 *   --exclude-dir=test --exclude-dir=node_modules --exclude-dir=dist \
 *   | grep -vE ':[0-9]+: *(\*|//|/\*)' | grep -v 'parse-id.ts' | grep -v 'platform-embed.ts'
 * ```
 *
 * ⚠️ **The paths are spelled to avoid a literal `*` followed by `/`, which would close this comment.**
 * Do NOT "tidy" them back to a `packages/<star>/src` glob — the obvious dodges are worse than the
 * problem: an HTML entity is literal in the source and silently mangles the command (an `&` there
 * backgrounds the grep and comments out the rest, so it returns NOTHING and reads as conformant),
 * and a `[/]` character class does not expand, because a glob cannot match `/` at all. Both were
 * tried here; both produced an instrument incapable of failing.
 *
 * ⚠️ **A short list of EXCEPTIONS, never an inventory of sites.** An inventory rots on the next
 * unrelated edit; this fails loudly the moment a hit appears that is not on it. Every entry carries
 * its class and its reason, because "it looked fine" is how the wrong one gets added:
 *
 * - **`home-logic.ts` `needsFreshLogin` (Studio's auth app) — a client mirror of the refresh's pick.**
 *   Marks a Home row whose host this browser could not open: covered by the row's own cookie, or by
 *   a cookie at or above it whose record carries the admin bit, read as the refresh reads it. It
 *   decides how a row looks and never what anyone may do; the refresh decides that.
 * - **`verify.ts` — token-internal consistency · STRUCTURAL.** Asserts `aud` is at or below the
 *   token's own `authScope`. There is no principal question here and the containment takes **no
 *   `scopeAdmin` conjunction**. Beside it, a plain membership's `aud` must EQUAL its `authScope`:
 *   an equality rather than a containment, so it is not on this list, and it is what keeps reading
 *   `aud` from widening a plain member below their own scope.
 * - **`access-claims.ts` `buildNebulaJwtPayload` — mint-side construction invariant · STRUCTURAL.**
 *   The same assertions on the way out, so an inconsistent token is impossible to *construct* rather
 *   than merely rejected downstream.
 * - **`worker-token.ts` `handleRefreshToken` — the candidate selection · STRUCTURAL.** Reads only the
 *   cookies whose scope is at or above the host's. The KV record behind each is the authority, so no
 *   claim is consulted; the admin bit picks among the candidates afterwards, never which are read.
 * - **`worker-token.ts` `mintImpersonationToken` `aud` validation — STRUCTURAL.** Bounds the caller's
 *   host (the minted `aud`) inside the *subject's* own scope — a mirror of `verify.ts`'s checks, answered early as a 403 instead of late as a token that
 *   verifies nowhere. A validation, never an authorization (authorization is `canMintFor`, which
 *   calls `hasDominionOver`); not a question about any principal's authority.
 *
 * ⚠️ **A second class this grep is structurally blind to: containment computed BY VALUE.**
 * `b === a || b.startsWith(a + '.')` in TypeScript and a {@link descendantRange} bound in SQL both
 * compute `isAtOrAbove` without spelling it. The licensed sites all live in `nebula-auth-registry.ts` and
 * share one reason, stated at each: **the query IS the bound.** Routing per row would mean fetching
 * every scope first, which is the work those arms exist to avoid — `#scopesAtOrBeneath`, which a
 * deletion's cascade, an acceptance's teardown and claim convergence share, and `getScopeSummary`'s
 * descent (`#levelClause`, and `expandScope`'s own coverage check). That is a property, not a tally: an arm that bounds a read by prefix inherits the
 * licence, and one that decides a principal's authority does not, whatever it is named.
 *
 * ⚠️ **Sweep with `grep -rnE "startsWith\(|LIKE |descendantRange\(" packages/nebula-auth/src/*.ts`,
 * and do NOT narrow it back to a quoted `'.'`.** The earlier form here was `startsWith\(.*'\.'`, which
 * returned **zero** against `parent.startsWith(\`${s}.\`)` — the template-literal spelling is the one
 * the newest arm actually uses, so the instrument was blind to precisely what it existed to find. The
 * wider grep is noisier by design: it also returns this comment, `isAtOrAbove` and `descendantRange`
 * themselves (definitions, not bypasses), three prefix tests on a cookie name or a path, and
 * `NOT LIKE '%.%'` in `#convergePendingClaims` (a tier test — "has no dot, so it is a universe" — not
 * containment). Eyeball those; a grep that returns nothing here is far likelier to be broken than to
 * be clean.
 */

import type { AccessEntry, NebulaJwtPayload, ParsedId, Tier } from './types';
import { PLATFORM_SCOPE } from './types';

/** Regex for a single slug segment: lowercase alphanumeric + hyphens, at least 1 char */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The longest slug, so a persona and its Star fit one 63-character host label as
 * `{persona}--{star}`, 30 + 2 + 30 (ADR-021). `warehouse-management-system` is 27.
 *
 * It also keeps an id from parsing as a scope: a `profileId`, a persona's version-5 id and a
 * Gateway's `{sub}.{tabId}` each carry a 36-character UUID, which the slug grammar alone accepts.
 */
export const MAX_SLUG_LENGTH = 30;

/**
 * Validate a single slug segment.
 * Must be lowercase alphanumeric + hyphens, at most {@link MAX_SLUG_LENGTH} characters, cannot
 * start or end with a hyphen, and cannot contain consecutive hyphens.
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) return false;
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
 * The SQL range holding exactly `scope`'s strict descendants, `id >= lo AND id < hi`:
 * `acme.crm`'s are the strings from `acme.crm.` up to, not including, `acme.crm/`, because `/` is
 * the byte after `.`. It is {@link isAtOrAbove}'s whole-segment test computed by value, so
 * `acme.crm-2` falls outside it, and it compares any string exactly, so nothing needs escaping.
 *
 * ⚠️ **Use this, never `LIKE ${scope + '.%'}`.** The SQLite inside a Durable Object caps a `LIKE` or
 * `GLOB` pattern at 50 bytes and refuses a longer one with `LIKE or GLOB pattern too complex`, so a
 * pattern built from a scope works for `acme.crm` and fails for three long slugs. A run's test
 * scopes reached that length on 2026-10-03 and took account deletion down with them. A pattern
 * that names no scope, such as `'%.%'`, stays short and is fine.
 */
export function descendantRange(scope: string): { lo: string; hi: string } {
  return { lo: `${scope}.`, hi: `${scope}/` };
}

/**
 * The verified claims a verdict reads: `aud`, the scope of the host the token was minted for, and
 * `access`, the membership it rests on. A whole `NebulaJwtPayload` satisfies it.
 */
export type VerdictClaims = Pick<NebulaJwtPayload, 'aud'> & { access?: Partial<AccessEntry> };

/**
 * **The single dominion predicate**: do these claims hold dominion *over `targetScope`*?
 *
 * Dominion runs downward from the host the token was minted for, its `aud`, and only for a
 * membership carrying `scopeAdmin` (the host rule, ADR-015 and ADR-022). A universe admin's token
 * minted on `tenant1.crm.acme.lumenize.dev` holds dominion over `acme.crm.tenant1` and nothing else:
 * not its sibling `acme.crm.tenant2`, and not `acme.crm` or `acme` above it, though the membership
 * covers all of them. The same membership on `acme.lumenize.dev` holds all of them. So the host a
 * call came from bounds what its page's code can do, whoever's membership the token rests on.
 *
 * `scopeAdmin` alone is never dominion; every guard that consults it must ask this question about
 * the scope it is acting on. Reading `aud` only ever narrows: verification holds `aud` at or below
 * `authScope`, and equal to it for a plain membership.
 *
 * Fail-closed on an absent claim: no host, no membership, or no bit, no dominion.
 *
 * One predicate, one place to audit (ADR-007) — do not re-inline this conjunction anywhere.
 */
export function hasDominionOver(claims: VerdictClaims | undefined, targetScope: string): boolean {
  if (!claims?.aud || !claims.access?.authScope || !claims.access.scopeAdmin) return false;
  return isAtOrAbove(claims.aud, targetScope);
}

/**
 * **The single passage predicate**: may these claims reach `targetScope` at all?
 *
 * The **union** of two arms, both read from the host the token was minted for, its `aud`
 * (ADR-015 § *Terminology*, the host rule):
 *  - the host's scope sits **at or below** the target — a page on a tenant's host reaching its
 *    app and account, which confers no dominion whatsoever; OR
 *  - the claims hold **dominion** there, which is the whole downward rule.
 *
 * So a token reaches its host's subtree and the host's ancestors, and nothing beside it: a token
 * from `acme.crm.tenant1`'s host has no passage into `acme.crm.tenant2`, whatever its membership.
 *
 * ⚠️ **Writing this as the upward arm alone refuses the entire downward rule**, and writing it as
 * dominion alone refuses every non-admin their own scope. Both arms, always.
 *
 * ⚠️ **Passage is NOT dominion, and lacking dominion is not a denial.** A caller with passage may
 * still be granted a great deal by the methods it reaches — that is the callee's own guards' call.
 *
 * ⚠️ **Fail-closed on an absent claim: no host or no membership, no passage — returning `false`
 * rather than throwing.** Stated here because it cannot be inherited: the upward arm has no
 * `scopeAdmin` operand, so {@link hasDominionOver}'s bit test does not cover it.
 *
 * One predicate, one place to audit (ADR-007) — do not re-inline this disjunction anywhere.
 */
export function hasPassageInto(claims: VerdictClaims | undefined, targetScope: string): boolean {
  if (!claims?.aud || !claims.access?.authScope) return false;
  return isAtOrBelow(claims.aud, targetScope) || hasDominionOver(claims, targetScope);
}

/**
 * What a refused passage says, naming both scopes: the one passage was computed from, then the one
 * it was asked into. One wording for every passage refusal, so a test or a reader matches one
 * message wherever passage is checked.
 */
export function noPassageMessage(fromScope: string | undefined, intoScope: string): string {
  return `No passage from "${fromScope ?? '(no scope)'}" into "${intoScope}"`;
}

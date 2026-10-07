/**
 * Tests for universeGalaxyStarId parsing, validation, and the two structural containment predicates.
 *
 * The id format and the containment contract are specified by the code under test — see
 * ../src/parse-id.ts (module header for the id format; `isAtOrAbove`'s JSDoc for the whole-segment
 * contract and the platform-root branch).
 */
import {
  parseId,
  isValidSlug,
  isPlatformScope,
  getParentId,
  isAtOrAbove,
  isAtOrBelow,
  hasDominionOver,
  hasPassageInto,
  PLATFORM_SCOPE,
} from '../src/index';

// ---------------------------------------------------------------------------
// isValidSlug
// ---------------------------------------------------------------------------

describe('isValidSlug', () => {
  it('accepts simple lowercase slugs', () => {
    expect(isValidSlug('acme')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('acme-corp')).toBe(true);
    expect(isValidSlug('my-app-2')).toBe(true);
    expect(isValidSlug('x1')).toBe(true);
    expect(isValidSlug('123')).toBe(true);
  });

  it('rejects empty and non-string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('ACME')).toBe(false);
  });

  it('rejects periods (segments are dot-separated)', () => {
    expect(isValidSlug('acme.corp')).toBe(false);
  });

  it('rejects spaces and special characters', () => {
    expect(isValidSlug('acme corp')).toBe(false);
    expect(isValidSlug('acme_corp')).toBe(false);
    expect(isValidSlug('acme@corp')).toBe(false);
  });

  it('rejects leading hyphens', () => {
    expect(isValidSlug('-acme')).toBe(false);
  });

  it('rejects trailing hyphens', () => {
    expect(isValidSlug('acme-')).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(isValidSlug('acme--corp')).toBe(false);
  });

  it('caps a slug at 30 characters', () => {
    expect(isValidSlug('northwind-traders-international')).toBe(false); // 31
    expect(isValidSlug('warehouse-management-system')).toBe(true);      // 27
    expect(isValidSlug('a'.repeat(30))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseId
// ---------------------------------------------------------------------------

describe('parseId', () => {
  describe('universe tier (1 segment)', () => {
    it('parses a universe id', () => {
      const result = parseId('george-solopreneur');
      expect(result).toEqual({
        raw: 'george-solopreneur',
        universe: 'george-solopreneur',
        tier: 'universe',
      });
    });

    it('parses a domain-style universe', () => {
      const result = parseId('lumenize-com');
      expect(result).toEqual({
        raw: 'lumenize-com',
        universe: 'lumenize-com',
        tier: 'universe',
      });
    });
  });

  describe('galaxy tier (2 segments)', () => {
    it('parses a galaxy id', () => {
      const result = parseId('george-solopreneur.georges-first-app');
      expect(result).toEqual({
        raw: 'george-solopreneur.georges-first-app',
        universe: 'george-solopreneur',
        galaxy: 'georges-first-app',
        tier: 'galaxy',
      });
    });
  });

  describe('star tier (3 segments)', () => {
    it('parses a star id', () => {
      const result = parseId('george-solopreneur.georges-first-app.acme-corp');
      expect(result).toEqual({
        raw: 'george-solopreneur.georges-first-app.acme-corp',
        universe: 'george-solopreneur',
        galaxy: 'georges-first-app',
        star: 'acme-corp',
        tier: 'star',
      });
    });
  });

  describe('validation errors', () => {
    it('throws for empty string', () => {
      expect(() => parseId('')).toThrow('non-empty string');
    });

    it('throws for too many segments', () => {
      expect(() => parseId('a.b.c.d')).toThrow('1–3 dot-separated segments');
    });

    it('throws for invalid slug in any position', () => {
      expect(() => parseId('UPPER')).toThrow('Invalid slug at position 1');
      expect(() => parseId('ok.UPPER')).toThrow('Invalid slug at position 2');
      expect(() => parseId('ok.ok.UPPER')).toThrow('Invalid slug at position 3');
    });

    it('throws for slugs with special characters', () => {
      expect(() => parseId('acme_corp')).toThrow('Invalid slug');
    });

    it('throws for empty segments (double dots)', () => {
      expect(() => parseId('acme..corp')).toThrow('Invalid slug');
    });

    it('throws for trailing dot', () => {
      expect(() => parseId('acme.')).toThrow('Invalid slug');
    });

    it('throws for leading dot', () => {
      expect(() => parseId('.acme')).toThrow('Invalid slug');
    });
  });

  // The root is a name, never a scope a request may address: a reader that needs it checks
  // `isPlatformScope` before it parses, as the refresh's cookie classification and `requirePassage` do.
  describe('platform instance', () => {
    it('refuses the root, which the slug grammar refuses by its leading underscore', () => {
      expect(isValidSlug(PLATFORM_SCOPE)).toBe(false);
      expect(() => parseId(PLATFORM_SCOPE)).toThrow('Invalid slug');
      expect(isPlatformScope(PLATFORM_SCOPE)).toBe(true);
    });

    it('refuses the root as a segment too', () => {
      expect(() => parseId(`${PLATFORM_SCOPE}.app`)).toThrow('Invalid slug');
    });
  });

  // A node named by an id is not a scope, so its name must not parse as one: a scope's guard decides
  // passage from the parsed name. Each carries a 36-character UUID, which the grammar alone accepts.
  describe('an id-shaped name', () => {
    const uuid = '6f1d9c2e-4b7a-4c1e-9a3f-2d8b5e7c1a90';
    it.each([
      ['a profileId', uuid],
      ["a persona's version-5 id", '0c3e9a57-1f2b-5d84-8a6e-3b9f2c7d4e15'],
      ["a Gateway's {sub}.{tabId}", `${uuid}.k2f9x7`],
    ])('%s does not parse', (_label, name) => {
      expect(() => parseId(name)).toThrow('Invalid slug at position 1');
    });
  });

  // A Client a scope's node hosts is named by that scope, a `/` and its id. A claimless chain whose
  // first hop parses as a scope acts as a member of it, so a Client's name must never parse as one,
  // at any tier, and its `/` is what keeps it from parsing.
  describe('a hosted Client\'s name', () => {
    const id = '6f1d9c2e-4b7a-4c1e-9a3f-2d8b5e7c1a90.k2f9x7';
    it.each([
      ['on a Universe', `acme/${id}`],
      ['on a Galaxy', `acme.crm/${id}`],
      ['on a Star', `acme.crm.tenant1/${id}`],
      ['an impersonation child on a Star', `acme.crm.tenant1/${id}.acme-crm-tenant1`],
    ])('%s does not parse', (_label, name) => {
      expect(() => parseId(name)).toThrow();
    });

    // A full id also breaks the slug length and the segment count, so these short ids are what
    // shows the `/` alone refused.
    it.each([
      ['on a Universe', 'acme/x', 1],
      ['on a Galaxy', 'acme.crm/x', 2],
      ['on a Star', 'acme.crm.tenant1/x', 3],
    ])('a short id %s is refused for its /', (_label, name, position) => {
      expect(() => parseId(name)).toThrow(`Invalid slug at position ${position}`);
    });
  });
});

// ---------------------------------------------------------------------------
// isPlatformScope
// ---------------------------------------------------------------------------

describe('isPlatformScope', () => {
  it('identifies the reserved platform instance', () => {
    expect(isPlatformScope(PLATFORM_SCOPE)).toBe(true);
    expect(isPlatformScope('_platform')).toBe(true);
  });

  it('rejects other instances', () => {
    expect(isPlatformScope('acme')).toBe(false);
    expect(isPlatformScope('_platform.something')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getParentId
// ---------------------------------------------------------------------------

describe('getParentId', () => {
  it('returns undefined for universe tier', () => {
    expect(getParentId(parseId('acme'))).toBeUndefined();
  });

  it('returns universe for galaxy tier', () => {
    expect(getParentId(parseId('acme.crm'))).toBe('acme');
  });

  it('returns galaxy for star tier', () => {
    expect(getParentId(parseId('acme.crm.tenant-a'))).toBe('acme.crm');
  });
});

// ---------------------------------------------------------------------------
// isAtOrAbove / isAtOrBelow — the two structural containment predicates the
// coarse-grained verdicts are built from (ADR-015 § *Predicate pair*).
// ---------------------------------------------------------------------------

describe('isAtOrAbove', () => {
  describe('the reserved platform scope is the ROOT of the tree', () => {
    it('is at or above a universe', () => {
      expect(isAtOrAbove('_platform', 'george-solopreneur')).toBe(true);
    });

    it('is at or above a star', () => {
      expect(isAtOrAbove('_platform', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('is at or above itself', () => {
      expect(isAtOrAbove('_platform', '_platform')).toBe(true);
    });

    it('covers a target no grammar can produce — it reads only its FIRST argument', () => {
      // Deliberate: the root branch returns before comparing. A caller needing the 1–3-segment
      // grammar enforced parses at its own request boundary.
      expect(isAtOrAbove('_platform', 'a.b.c.d')).toBe(true);
    });

    it('does NOT make the platform scope reachable from below', () => {
      expect(isAtOrAbove('george-solopreneur', '_platform')).toBe(false);
    });
  });

  describe('a universe scope', () => {
    it('is at or above itself', () => {
      expect(isAtOrAbove('george-solopreneur', 'george-solopreneur')).toBe(true);
    });

    it('is above its galaxies', () => {
      expect(isAtOrAbove('george-solopreneur', 'george-solopreneur.app')).toBe(true);
    });

    it('is above its stars', () => {
      expect(isAtOrAbove('george-solopreneur', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('is not above a different universe', () => {
      expect(isAtOrAbove('george-solopreneur', 'other-universe')).toBe(false);
    });
  });

  describe('a galaxy scope', () => {
    it('is at or above itself', () => {
      expect(isAtOrAbove('george-solopreneur.app', 'george-solopreneur.app')).toBe(true);
    });

    it('is above its stars', () => {
      expect(isAtOrAbove('george-solopreneur.app', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('is NOT above its own universe — upward is nil', () => {
      expect(isAtOrAbove('george-solopreneur.app', 'george-solopreneur')).toBe(false);
    });

    it('is not above a sibling galaxy', () => {
      expect(isAtOrAbove('george-solopreneur.app', 'george-solopreneur.other')).toBe(false);
    });
  });

  describe('a star scope', () => {
    it('is at or above itself', () => {
      expect(isAtOrAbove('george-solopreneur.app.tenant', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('is not above a sibling star', () => {
      expect(isAtOrAbove('george-solopreneur.app.tenant', 'george-solopreneur.app.other')).toBe(false);
    });

    it('is NOT above its own galaxy — upward is nil', () => {
      expect(isAtOrAbove('george-solopreneur.app.tenant', 'george-solopreneur.app')).toBe(false);
    });
  });

  // ⚠️ The contract, not an implementation detail. The obvious `target.startsWith(mine)` passes every
  // case above and silently makes each of these `true` — every one a cross-tenant hole, and every
  // colliding name here a legal slug.
  describe('comparison is by WHOLE dot-separated segments', () => {
    it('a star does not cover a prefix-colliding sibling star', () => {
      expect(isAtOrAbove('george-solopreneur.app.s1', 'george-solopreneur.app.s10')).toBe(false);
    });

    it('a universe does not cover a prefix-colliding sibling universe', () => {
      expect(isAtOrAbove('acme', 'acme-2')).toBe(false);
    });

    it('a galaxy does not cover a prefix-colliding sibling galaxy', () => {
      expect(isAtOrAbove('acme.app', 'acme.app-2')).toBe(false);
    });

    it('a universe does not cover a universe merely extending its name', () => {
      expect(isAtOrAbove('george-solopreneur', 'george-solopreneur-extra')).toBe(false);
    });
  });
});

describe('isAtOrBelow', () => {
  // Implemented AS `isAtOrAbove` with the arguments flipped, so the identity is structural rather
  // than a property two functions must both remember. These assert the identity itself.
  it('is exactly isAtOrAbove with the arguments flipped', () => {
    const pairs: [string, string][] = [
      ['george-solopreneur', 'george-solopreneur.app'],
      ['george-solopreneur.app', 'george-solopreneur'],
      ['_platform', 'george-solopreneur.app.tenant'],
      ['acme', 'acme-2'],
      ['george-solopreneur.app.s1', 'george-solopreneur.app.s10'],
    ];
    for (const [a, b] of pairs) {
      expect(isAtOrBelow(a, b)).toBe(isAtOrAbove(b, a));
    }
  });

  it('a star sits below its galaxy and its universe', () => {
    expect(isAtOrBelow('george-solopreneur.app.tenant', 'george-solopreneur.app')).toBe(true);
    expect(isAtOrBelow('george-solopreneur.app.tenant', 'george-solopreneur')).toBe(true);
  });

  it('a scope sits at or below itself', () => {
    expect(isAtOrBelow('george-solopreneur.app', 'george-solopreneur.app')).toBe(true);
  });

  it('EVERY scope sits at or below the platform root', () => {
    expect(isAtOrBelow('george-solopreneur', '_platform')).toBe(true);
    expect(isAtOrBelow('george-solopreneur.app.tenant', '_platform')).toBe(true);
  });

  it('a galaxy does NOT sit below its own star — downward is not upward', () => {
    expect(isAtOrBelow('george-solopreneur.app', 'george-solopreneur.app.tenant')).toBe(false);
  });

  it('honours the whole-segment boundary', () => {
    expect(isAtOrBelow('acme-2', 'acme')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two VERDICTS — hasDominionOver / hasPassageInto.
//
// ⚠️ Added 2026-08-16 after a verifier noticed this file imported every predicate in the module
// EXCEPT the two that actually decide anything: both were exercised only indirectly, through
// `requirePassage` in `apps/nebula`. In particular the **empty**-scope half of the pinned
// fail-closed contract was exercised nowhere at all. The scope both read is the token's `aud`.
// ---------------------------------------------------------------------------

/**
 * The claims a verdict reads, built inline: `aud`, the scope of the host the token was minted for,
 * and the membership it rests on. The membership defaults to the host's scope, as a plain member's
 * must; the host-rule tests below pull them apart.
 */
const claim = (aud?: string, scopeAdmin?: boolean, authScope = aud) => ({
  ...(aud !== undefined ? { aud } : {}),
  access: { ...(authScope !== undefined ? { authScope } : {}), ...(scopeAdmin ? { scopeAdmin } : {}) },
}) as any;

describe('the host rule — both verdicts read the host\'s scope, never the membership\'s', () => {
  // A universe admin's token minted for a tenant's host: the membership covers everything, the host
  // covers the tenant and nothing beside or above it.
  const fromTenant = claim('acme.app.t1', true, 'acme');

  it('dominion runs down from the host, not from the membership', () => {
    expect(hasDominionOver(fromTenant, 'acme.app.t1')).toBe(true);
    expect(hasDominionOver(fromTenant, 'acme.app.t2')).toBe(false);
    expect(hasDominionOver(fromTenant, 'acme.app')).toBe(false);
    expect(hasDominionOver(fromTenant, 'acme')).toBe(false);
  });

  it('passage runs up from the host, and never sideways', () => {
    expect(hasPassageInto(fromTenant, 'acme.app')).toBe(true);
    expect(hasPassageInto(fromTenant, 'acme')).toBe(true);
    expect(hasPassageInto(fromTenant, 'acme.app.t2')).toBe(false);
  });

  it('the same membership from the universe\'s host holds all three', () => {
    const fromUniverse = claim('acme', true);
    for (const target of ['acme.app.t2', 'acme.app', 'acme']) expect(hasDominionOver(fromUniverse, target)).toBe(true);
  });
});

describe('hasDominionOver', () => {
  it('is the CONJUNCTION — the bit alone is never dominion', () => {
    // Same scope, same target; only the bit differs. This is the operand that has shipped as a bug
    // twice, so it is probed on its own rather than as part of a larger case.
    expect(hasDominionOver(claim('acme', true), 'acme.app')).toBe(true);
    expect(hasDominionOver(claim('acme'), 'acme.app')).toBe(false);
  });

  it('is bounded by the scope — the bit does not travel sideways or upward', () => {
    expect(hasDominionOver(claim('acme', true), 'other')).toBe(false);
    expect(hasDominionOver(claim('acme.app', true), 'acme')).toBe(false);
  });

  it('a platform admin holds dominion everywhere (the root branch, inherited)', () => {
    expect(hasDominionOver(claim('_platform', true), 'acme.app.tenant')).toBe(true);
  });

  it('fails closed on an absent, empty or bit-less claim', () => {
    expect(hasDominionOver(undefined, 'acme')).toBe(false);
    expect(hasDominionOver(claim(undefined, true), 'acme')).toBe(false);
    expect(hasDominionOver(claim('', true), 'acme')).toBe(false);
  });
});

describe('hasPassageInto', () => {
  // ⚠️ Each arm is probed where the OTHER cannot supply the answer. A case both arms satisfy would
  // pass with either one deleted, which is the whole failure mode this pair exists to catch.
  it('the UPWARD arm alone: a non-admin reaches its own scope and its ancestors', () => {
    expect(hasPassageInto(claim('acme.app.tenant'), 'acme.app.tenant')).toBe(true);
    expect(hasPassageInto(claim('acme.app.tenant'), 'acme.app')).toBe(true);
    expect(hasPassageInto(claim('acme.app.tenant'), 'acme')).toBe(true);
    // No dominion anywhere here, so deleting the upward arm reds every line above.
    expect(hasDominionOver(claim('acme.app.tenant'), 'acme')).toBe(false);
  });

  it('the DOMINION arm alone: an admin reaches downward, where upward cannot help', () => {
    expect(hasPassageInto(claim('acme', true), 'acme.app.tenant')).toBe(true);
    // The upward arm is false for this pair, so deleting dominion reds the line above.
    expect(isAtOrBelow('acme', 'acme.app.tenant')).toBe(false);
  });

  it('a NON-admin has no passage beneath its own scope — the union is not "anything related"', () => {
    expect(hasPassageInto(claim('acme'), 'acme.app')).toBe(false);
    expect(hasPassageInto(claim('acme'), 'acme.app.tenant')).toBe(false);
  });

  it('no passage sideways, admin or not', () => {
    expect(hasPassageInto(claim('acme.app.a'), 'acme.app.b')).toBe(false);
    expect(hasPassageInto(claim('acme.app.a', true), 'acme.app.b')).toBe(false);
  });

  it('EVERY authenticated caller has passage to the platform root, by construction', () => {
    // Not a leak — the root is at or above nothing, but everything is at or below IT, so the
    // upward arm admits. `nebula-do.ts`'s name reservation is what stands in front of it.
    expect(hasPassageInto(claim('acme.app.tenant'), '_platform')).toBe(true);
  });

  it('honours the whole-segment boundary', () => {
    expect(hasPassageInto(claim('acme-2'), 'acme')).toBe(false);
    expect(hasPassageInto(claim('acme', true), 'acme-2')).toBe(false);
  });

  // 🔒 The pinned contract: RETURNS false, never throws. It cannot be inherited from
  // `hasDominionOver` — the upward arm has no `scopeAdmin` operand to be accidentally protected by,
  // and the mint omits the bit for every non-admin, so this is the ordinary non-admin path.
  it('fails closed on an absent or EMPTY claim, by returning false rather than throwing', () => {
    expect(() => hasPassageInto(undefined, 'acme')).not.toThrow();
    expect(hasPassageInto(undefined, 'acme')).toBe(false);
    expect(hasPassageInto(claim(undefined), 'acme')).toBe(false);
    expect(hasPassageInto({} as any, 'acme')).toBe(false);
    // The EMPTY half, which the JSDoc pins and nothing exercised before this test. An empty string
    // is falsy, so it must not fall through to a comparison — `''` would otherwise be a prefix of
    // everything under a naive implementation.
    expect(hasPassageInto(claim(''), 'acme')).toBe(false);
    expect(hasPassageInto(claim('', true), 'acme')).toBe(false);
  });
});

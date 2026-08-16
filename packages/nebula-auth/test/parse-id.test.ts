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

  describe('platform instance', () => {
    it('parses nebula-platform as a universe', () => {
      const result = parseId('nebula-platform');
      expect(result.tier).toBe('universe');
      expect(result.universe).toBe('nebula-platform');
    });
  });
});

// ---------------------------------------------------------------------------
// isPlatformScope
// ---------------------------------------------------------------------------

describe('isPlatformScope', () => {
  it('identifies the reserved platform instance', () => {
    expect(isPlatformScope(PLATFORM_SCOPE)).toBe(true);
    expect(isPlatformScope('nebula-platform')).toBe(true);
  });

  it('rejects other instances', () => {
    expect(isPlatformScope('acme')).toBe(false);
    expect(isPlatformScope('nebula-platform.something')).toBe(false);
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
      expect(isAtOrAbove('nebula-platform', 'george-solopreneur')).toBe(true);
    });

    it('is at or above a star', () => {
      expect(isAtOrAbove('nebula-platform', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('is at or above itself', () => {
      expect(isAtOrAbove('nebula-platform', 'nebula-platform')).toBe(true);
    });

    it('covers a target no grammar can produce — it reads only its FIRST argument', () => {
      // Deliberate: the root branch returns before comparing. A caller needing the 1–3-segment
      // grammar enforced parses at its own request boundary.
      expect(isAtOrAbove('nebula-platform', 'a.b.c.d')).toBe(true);
    });

    it('does NOT make the platform scope reachable from below', () => {
      expect(isAtOrAbove('george-solopreneur', 'nebula-platform')).toBe(false);
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
      ['nebula-platform', 'george-solopreneur.app.tenant'],
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
    expect(isAtOrBelow('george-solopreneur', 'nebula-platform')).toBe(true);
    expect(isAtOrBelow('george-solopreneur.app.tenant', 'nebula-platform')).toBe(true);
  });

  it('a galaxy does NOT sit below its own star — downward is not upward', () => {
    expect(isAtOrBelow('george-solopreneur.app', 'george-solopreneur.app.tenant')).toBe(false);
  });

  it('honours the whole-segment boundary', () => {
    expect(isAtOrBelow('acme-2', 'acme')).toBe(false);
  });
});

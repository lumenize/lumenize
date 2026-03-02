/**
 * Tests for universeGalaxyStarId parsing, validation, and access matching.
 *
 * @see tasks/nebula-auth.md § universeGalaxyStarId Format Constraints
 * @see tasks/nebula-auth.md § Wildcard Matching Examples
 */
import {
  parseId,
  isValidSlug,
  isPlatformInstance,
  getParentId,
  buildAuthScopePattern,
  matchAccess,
  PLATFORM_INSTANCE_NAME,
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
// isPlatformInstance
// ---------------------------------------------------------------------------

describe('isPlatformInstance', () => {
  it('identifies the reserved platform instance', () => {
    expect(isPlatformInstance(PLATFORM_INSTANCE_NAME)).toBe(true);
    expect(isPlatformInstance('nebula-platform')).toBe(true);
  });

  it('rejects other instances', () => {
    expect(isPlatformInstance('acme')).toBe(false);
    expect(isPlatformInstance('nebula-platform.something')).toBe(false);
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
// buildAuthScopePattern
// ---------------------------------------------------------------------------

describe('buildAuthScopePattern', () => {
  it('returns "*" for platform instance', () => {
    expect(buildAuthScopePattern('nebula-platform')).toBe('*');
  });

  it('returns wildcard for universe tier', () => {
    expect(buildAuthScopePattern('george-solopreneur')).toBe('george-solopreneur.*');
  });

  it('returns wildcard for galaxy tier', () => {
    expect(buildAuthScopePattern('george-solopreneur.app')).toBe('george-solopreneur.app.*');
  });

  it('returns exact id for star tier', () => {
    expect(buildAuthScopePattern('george-solopreneur.app.tenant')).toBe('george-solopreneur.app.tenant');
  });
});

// ---------------------------------------------------------------------------
// matchAccess — examples from tasks/nebula-auth.md § Wildcard Matching Examples
// ---------------------------------------------------------------------------

describe('matchAccess', () => {
  describe('platform admin ("*")', () => {
    it('matches any universe', () => {
      expect(matchAccess('*', 'george-solopreneur')).toBe(true);
    });

    it('matches any star', () => {
      expect(matchAccess('*', 'george-solopreneur.app.tenant')).toBe(true);
    });
  });

  describe('universe wildcard', () => {
    it('matches own universe', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur')).toBe(true);
    });

    it('matches galaxy beneath', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur.app')).toBe(true);
    });

    it('matches star beneath', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('does not match different universe', () => {
      expect(matchAccess('george-solopreneur.*', 'other-universe')).toBe(false);
    });

    it('does not match universe with shared prefix', () => {
      // "george-solopreneur-extra" starts with "george-solopreneur" but is a different universe
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur-extra')).toBe(false);
    });
  });

  describe('galaxy wildcard', () => {
    it('matches own galaxy', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur.app')).toBe(true);
    });

    it('matches star beneath', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('does not match parent universe (upward access denied)', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur')).toBe(false);
    });

    it('does not match sibling galaxy', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur.other')).toBe(false);
    });
  });

  describe('exact match (star tier)', () => {
    it('matches exact id', () => {
      expect(matchAccess('george-solopreneur.app.tenant', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('does not match different star', () => {
      expect(matchAccess('george-solopreneur.app.tenant', 'george-solopreneur.app.other')).toBe(false);
    });

    it('does not match parent galaxy', () => {
      expect(matchAccess('george-solopreneur.app.tenant', 'george-solopreneur.app')).toBe(false);
    });
  });

  describe('edge cases from task file', () => {
    // All examples from tasks/nebula-auth.md § Wildcard Matching Examples
    it('matchAccess("*", "george-solopreneur") → true', () => {
      expect(matchAccess('*', 'george-solopreneur')).toBe(true);
    });

    it('matchAccess("*", "george-solopreneur.app.tenant") → true', () => {
      expect(matchAccess('*', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('matchAccess("george-solopreneur.*", "george-solopreneur") → true', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur')).toBe(true);
    });

    it('matchAccess("george-solopreneur.*", "george-solopreneur.app") → true', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur.app')).toBe(true);
    });

    it('matchAccess("george-solopreneur.*", "george-solopreneur.app.tenant") → true', () => {
      expect(matchAccess('george-solopreneur.*', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('matchAccess("george-solopreneur.app.*", "george-solopreneur") → false', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur')).toBe(false);
    });

    it('matchAccess("george-solopreneur.app.*", "george-solopreneur.app") → true', () => {
      expect(matchAccess('george-solopreneur.app.*', 'george-solopreneur.app')).toBe(true);
    });

    it('matchAccess("george-solopreneur.app.tenant", "george-solopreneur.app.tenant") → true', () => {
      expect(matchAccess('george-solopreneur.app.tenant', 'george-solopreneur.app.tenant')).toBe(true);
    });

    it('matchAccess("george-solopreneur.app.tenant", "george-solopreneur.app.other") → false', () => {
      expect(matchAccess('george-solopreneur.app.tenant', 'george-solopreneur.app.other')).toBe(false);
    });
  });
});

/**
 * universeGalaxyStarId parsing and validation
 *
 * Slugs: lowercase letters, digits, and hyphens only (`[a-z0-9-]+`).
 * No periods within a slug. 1–3 dot-separated slugs determine the tier.
 *
 * @see tasks/nebula-auth.md § universeGalaxyStarId Format Constraints
 */

import type { ParsedId, Tier } from './types';
import { PLATFORM_INSTANCE_NAME } from './types';

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
export function isPlatformInstance(id: string): boolean {
  return id === PLATFORM_INSTANCE_NAME;
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
 * Build the auth scope pattern for a JWT issued by a given instance.
 *
 * - Star-level → exact id (e.g. `"acme.crm.tenant"`)
 * - Galaxy-level → wildcard (e.g. `"acme.crm.*"`)
 * - Universe-level → wildcard (e.g. `"acme.*"`)
 * - Platform admin → `"*"`
 */
export function buildAuthScopePattern(instanceName: string): string {
  if (isPlatformInstance(instanceName)) return '*';
  const parsed = parseId(instanceName);
  if (parsed.tier === 'star') return parsed.raw;
  return `${parsed.raw}.*`;
}

/**
 * Match an auth scope pattern against a target `universeGalaxyStarId`.
 *
 * Rules:
 * - `"*"` matches everything (platform admin)
 * - `"foo.*"` matches `"foo"`, `"foo.bar"`, `"foo.bar.baz"` (and anything beneath)
 * - Exact string match for non-wildcard patterns
 *
 * @example
 * ```typescript
 * matchAccess("*", "george-solopreneur")                                // true
 * matchAccess("george-solopreneur.*", "george-solopreneur.app.tenant")  // true
 * matchAccess("george-solopreneur.app.*", "george-solopreneur")         // false
 * matchAccess("george-solopreneur.app.tenant", "george-solopreneur.app.tenant") // true
 * ```
 */
export function matchAccess(authScopePattern: string, targetId: string): boolean {
  // Platform admin — matches everything
  if (authScopePattern === '*') return true;

  // Wildcard pattern — "prefix.*"
  if (authScopePattern.endsWith('.*')) {
    const prefix = authScopePattern.slice(0, -2); // strip ".*"
    // Exact match on the prefix itself (universe-level access to own scope)
    if (targetId === prefix) return true;
    // Target is beneath the prefix (e.g. "acme.crm" under "acme")
    if (targetId.startsWith(prefix + '.')) return true;
    return false;
  }

  // Exact match
  return authScopePattern === targetId;
}

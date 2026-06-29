/**
 * Structural tier-DO scope binding (Fix 1).
 *
 * Each tier DO (Star / Galaxy / Universe) accepts a mesh call iff the caller's
 * `aud` is covered by the scope encoded in the DO's instance name — there is no
 * trust-on-first-use lock. This suite is the per-tier positive/negative grid;
 * the broader capable-of-failing matrix (pre-claim, fail-closed branches,
 * widening invariant, platform sink, malformed names) lives in
 * `scope-isolation.test.ts`.
 *
 * @see tasks/nebula-do-scope-isolation.md
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import {
  createAuthenticatedClient,
  uniqueGalaxyScope,
  uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('structural tier-DO scope binding', () => {
  describe('star-level', () => {
    it('accepts the matching star aud, rejects a foreign star aud', async () => {
      const starA = uniqueStar();
      const starB = uniqueStar();

      const browserA = new Browser();
      const { client: clientA } = await createAuthenticatedClient(
        NebulaClientTest, browserA, starA, starA, 'alice@example.com',
      );

      // Own star → accepted (exact pattern matches the aud).
      clientA.callStarGetConfig(starA);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toBeDefined();

      // A different star's aud reaching star A → rejected.
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
        NebulaClientTest, browserB, starB, starB, 'bob@example.com',
      );
      clientB.callStarGetConfig(starA);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toContain('Active-scope mismatch');

      clientA[Symbol.dispose]();
      clientB[Symbol.dispose]();
    });

    it('admin wildcard: a universe admin refreshed to the star activeScope is accepted', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // Universe admin authenticates at the universe but refreshes activeScope to
      // the star — its aud is the star, so the Star's exact pattern accepts it.
      const { client: adminClient } = await createAuthenticatedClient(
        NebulaClientTest, browser, universe, star, 'admin@example.com',
      );
      adminClient.callStarGetConfig(star);
      await vi.waitFor(() => { expect(adminClient.callCompleted).toBe(true); });
      expect(adminClient.lastError).toBeUndefined();
      expect(adminClient.lastResult).toBeDefined();

      adminClient[Symbol.dispose]();
    });
  });

  describe('galaxy-level', () => {
    it('accepts sibling stars under the galaxy, rejects a foreign galaxy', async () => {
      const browser = new Browser();
      const { galaxy, starA, starB } = uniqueGalaxyScope();

      // Two sibling stars share the one Galaxy DO; the `<galaxy>.*` pattern
      // covers both descendants (widening positive — the multi-star case).
      const { client: clientA } = await createAuthenticatedClient(
        NebulaClientTest, browser, galaxy, starA, 'admin@example.com',
      );
      const { client: clientB } = await createAuthenticatedClient(
        NebulaClientTest, browser, galaxy, starB, 'admin@example.com',
      );

      clientA.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toEqual({});

      clientB.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toBeUndefined();
      expect(clientB.lastResult).toEqual({});

      clientA[Symbol.dispose]();
      clientB[Symbol.dispose]();

      // A different galaxy's aud reaching this Galaxy → rejected.
      const otherGalaxy = uniqueGalaxyScope().galaxy;
      const browserOther = new Browser();
      const { client: clientOther } = await createAuthenticatedClient(
        NebulaClientTest, browserOther, otherGalaxy, otherGalaxy, 'carol@example.com',
      );
      clientOther.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => { expect(clientOther.callCompleted).toBe(true); });
      expect(clientOther.lastError).toContain('Active-scope mismatch');
      clientOther[Symbol.dispose]();
    });
  });

  describe('universe-level', () => {
    it('accepts the matching universe aud, rejects a foreign universe', async () => {
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const otherUniverse = `other-${generateUuid().slice(0, 8)}`;

      const browser = new Browser();
      const { client: clientA } = await createAuthenticatedClient(
        NebulaClientTest, browser, universe, universe, 'admin@example.com',
      );
      clientA.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toEqual({});
      clientA[Symbol.dispose]();

      // A different universe's aud reaching this Universe → rejected.
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
        NebulaClientTest, browserB, otherUniverse, otherUniverse, 'bob@example.com',
      );
      clientB.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toContain('Active-scope mismatch');
      clientB[Symbol.dispose]();
    });
  });
});

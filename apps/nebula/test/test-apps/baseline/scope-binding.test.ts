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
  adminClientAt, universeAdminClient,
  createInvitedClient,
  createSubject,
  foundAndLogin,
  uniqueGalaxyScope,
  uniqueStar,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('structural tier-DO scope binding', () => {
  describe('star-level', () => {
    // ⚠️ INVITED MEMBERS, not founders. This test's whole subject is the TENANT branch
    // (`matchAccess(buildAuthScopePattern(name), aud)`), which requires an **exact-star**
    // `authScopePattern` — mintable only by invite, since `claim-universe` (the sole founder path)
    // always yields a universe-tier `{u}.*`. With founders here, `enforceScopeReach` would return
    // early at the REACH clause and the tenant branch would never run: green, but testing the
    // sibling test's mechanism instead of its own. It would also collapse the deliberate contrast
    // with the `admin wildcard` case below into a duplicate.
    it('accepts the matching star aud, rejects a foreign star aud (TENANT branch)', async () => {
      const starA = uniqueStar();
      const starB = uniqueStar();

      // One founder per universe, used only to issue each star's invite.
      const adminA = new Browser();
      const { accessToken: tokenA } = await foundAndLogin(adminA, starA, 'admin@example.com', starA);
      await createSubject(adminA, starA, tokenA, 'alice@example.com');
      const adminB = new Browser();
      const { accessToken: tokenB } = await foundAndLogin(adminB, starB, 'admin@example.com', starB);
      await createSubject(adminB, starB, tokenB, 'bob@example.com');

      const browserA = new Browser();
      const { client: clientA, payload: payloadA } = await createInvitedClient(
        NebulaClientTest, browserA, starA, starA, 'alice@example.com',
      );
      // Fixture guard: an exact-star pattern is the premise. A `{u}.*` here silently moves the
      // positive case onto the reach branch.
      expect(payloadA.access?.authScopePattern).toBe(starA);

      // Own star → accepted, and specifically BY the tenant branch (the caller is non-admin, so
      // the reach clause is gated off entirely).
      clientA.callStarGetConfig(starA);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toBeDefined();

      // A different star's aud reaching star A → rejected.
      const browserB = new Browser();
      const { client: clientB } = await createInvitedClient(
        NebulaClientTest, browserB, starB, starB, 'bob@example.com',
      );
      clientB.callStarGetConfig(starA);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toContain('Active-scope mismatch');

      clientA[Symbol.dispose]();
      clientB[Symbol.dispose]();
    });

    // The deliberate CONTRAST to the tenant-branch test above: same DO, same accepted outcome,
    // different mechanism. Here the caller is a founder (`{u}.*`, admin), so `enforceScopeReach`
    // returns at the REACH clause and the tenant branch is never reached. Keeping the two distinct
    // is the point — if both used the same principal shape this test would prove nothing the
    // other doesn't.
    it('admin wildcard: a universe admin refreshed to the star activeScope is accepted (REACH branch)', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // Universe admin authenticates at the universe but refreshes activeScope to the star. Its
      // pattern is `{universe}.*`, which COVERS the Star's instance name → admitted by reach.
      const { client: adminClient, payload } = await universeAdminClient(
        NebulaClientTest, browser, universe, star, 'admin@example.com',
      );
      // Fixture guard: the wildcard pattern is the premise of this case.
      expect(payload.access?.authScopePattern).toBe(`${universe}.*`);
      expect(payload.access?.admin).toBe(true);
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

      // Two sibling stars share the one Galaxy DO, and both auds reach it. ⚠️ The covering pattern
      // is the FOUNDER's `{universe}.*`, not `<galaxy>.*` — `claim-universe` is the only
      // founder-minting path, so a founder is always universe-tier. The widening under test is
      // therefore the universe wildcard; the galaxy wildcard is not mintable as a founder today.
      const { client: clientA } = await universeAdminClient(
        NebulaClientTest, browser, galaxy, starA, 'admin@example.com',
      );
      const { client: clientB } = await universeAdminClient(
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
      const { client: clientOther } = await adminClientAt(
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
      const { client: clientA } = await adminClientAt(
        NebulaClientTest, browser, universe, universe, 'admin@example.com',
      );
      clientA.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toEqual({});
      clientA[Symbol.dispose]();

      // A different universe's aud reaching this Universe → rejected.
      const browserB = new Browser();
      const { client: clientB } = await adminClientAt(
        NebulaClientTest, browserB, otherUniverse, otherUniverse, 'bob@example.com',
      );
      clientB.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toContain('Active-scope mismatch');
      clientB[Symbol.dispose]();
    });
  });
});

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
    // ⚠️ INVITED MEMBERS, not star admins. This test's whole subject is the TENANT branch
    // (`matchAccess(buildAuthScopePattern(name), aud)`), which requires an **exact-star**
    // `authScopePattern` — mintable only by invite, since `claim-universe` (the sole admin-minting path)
    // always yields a universe-tier `{u}.*`. With star admins here, `enforceScopeReach` would return
    // early at the REACH clause and the tenant branch would never run: green, but testing the
    // sibling test's mechanism instead of its own. It would also collapse the deliberate contrast
    // with the `admin wildcard` case below into a duplicate.
    it('accepts the matching star aud, rejects a foreign star aud (TENANT branch)', async () => {
      const starA = uniqueStar();
      const starB = uniqueStar();

      // One admin per universe, used only to issue each star's invite.
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
    // different mechanism. Here the caller is a universe admin (`{u}.*`, admin), so `enforceScopeReach`
    // returns at the REACH clause and the tenant branch is never reached. Keeping the two distinct
    // is the point — if both used the same principal shape this test would prove nothing the
    // other doesn't.
    it('admin wildcard: a universe admin refreshed to the star activeScope is accepted (REACH branch)', async () => {
      const browser = new Browser();
      const universe = `uni-${crypto.randomUUID().slice(0, 8)}`;
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
      // admin-minting path, so such an admin is always universe-tier. The widening under test is
      // therefore the universe wildcard; the galaxy wildcard is not mintable as an admin today.
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
      const { client: clientOther } = await universeAdminClient(
        NebulaClientTest, browserOther, otherGalaxy, otherGalaxy, 'carol@example.com',
      );
      clientOther.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => { expect(clientOther.callCompleted).toBe(true); });
      expect(clientOther.lastError).toContain('Active-scope mismatch');
      clientOther[Symbol.dispose]();
    });
  });

  // 🔒 The star-tier precondition on `adminClientAt` is what keeps the intent-split honest, and it is
  // load-bearing for the star-scoped-admin change: once that helper mints a real exact-star-scoped admin, a
  // galaxy or universe `scope` becomes unservable, not merely mis-tiered. It is a runtime check
  // rather than a grep because every call site passes an identifier, never a dotted literal — some
  // via a wrapper param two indirections away. It found 6 mis-tiered sites when introduced (one of
  // them masked by another in the same test, which a single-pass grep would also have missed).
  describe('adminClientAt tier precondition', () => {
    it.each([
      ['universe', 'uni-abc'],
      ['galaxy', 'uni-abc.app'],
      ['4-segment', 'uni-abc.app.star.extra'],
    ])('refuses a %s scope', async (_label, scope) => {
      await expect(
        adminClientAt(NebulaClientTest, new Browser(), scope, scope, 'admin@example.com'),
      ).rejects.toThrow(/star-tier only/);
    });

    it('accepts a star scope, and mints a REAL star-scoped admin — exact-star, never {u}.*', async () => {
      // Two jobs. (1) Discriminator for the precondition: without a passing case, deleting the
      // segment check and hardcoding `throw` would satisfy every refusal above.
      const { starA } = uniqueGalaxyScope();
      const { client, payload } = await adminClientAt(
        NebulaClientTest, new Browser(), starA, starA, 'admin@example.com',
      );
      expect(client.connectionState).toBe('connected');

      // (2) 🔒 The star-scoped-admin re-grounding itself. This is the assertion the whole intent-split
      // was built to make possible — under the old body it returned `{u}.*` and reds here. An
      // exact-star pattern is what makes the star-scoped admin inert at every ancestor (ADR-015); if the mint
      // ever widens, open self-signup silently becomes an escalation.
      expect(payload.access?.authScopePattern).toBe(starA);
      expect(payload.access?.authScopePattern).not.toContain('*');
      expect(payload.access?.admin).toBe(true);
      expect(payload.aud).toBe(starA);
    });
  });

  describe('universe-level', () => {
    it('accepts the matching universe aud, rejects a foreign universe', async () => {
      const universe = `uni-${crypto.randomUUID().slice(0, 8)}`;
      const otherUniverse = `other-${crypto.randomUUID().slice(0, 8)}`;

      const browser = new Browser();
      const { client: clientA } = await universeAdminClient(
        NebulaClientTest, browser, universe, universe, 'admin@example.com',
      );
      clientA.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientA.callCompleted).toBe(true); });
      expect(clientA.lastError).toBeUndefined();
      expect(clientA.lastResult).toEqual({});
      clientA[Symbol.dispose]();

      // A different universe's aud reaching this Universe → rejected.
      const browserB = new Browser();
      const { client: clientB } = await universeAdminClient(
        NebulaClientTest, browserB, otherUniverse, otherUniverse, 'bob@example.com',
      );
      clientB.callUniverseGetConfig(universe);
      await vi.waitFor(() => { expect(clientB.callCompleted).toBe(true); });
      expect(clientB.lastError).toContain('Active-scope mismatch');
      clientB[Symbol.dispose]();
    });
  });
});

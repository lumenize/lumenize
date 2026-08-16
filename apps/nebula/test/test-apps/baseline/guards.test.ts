/**
 * Guard enforcement tests
 *
 * Tests @mesh(guard) decorators: admin-only methods, guard rejection,
 * lifecycle ordering (onBeforeCall rejects before guard runs),
 * and cross-admin access.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { adminClientAt, universeAdminClient, createInvitedClient, browserLogin, foundAndLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('guard enforcement', () => {

  describe('star-level guards', () => {
    it('non-admin cannot call setStarConfig, can call getStarConfig and whoAmI', async () => {
      const browser = new Browser();
      const star = `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;

      // Bootstrap admin
      const { accessToken: adminToken } = await foundAndLogin(browser, star, 'admin@example.com');

      // Create non-admin subject
      const userBrowser = new Browser();
      await createSubject(browser, star, adminToken, 'user@example.com');
      const { client: userClient } = await createInvitedClient(
        NebulaClientTest, userBrowser, star, star, 'user@example.com',
      );

      // Non-admin calls setStarConfig → rejected by requireDominionHere guard
      userClient.callStarSetConfig(star, 'key', 'value');
      await vi.waitFor(() => {
        expect(userClient.lastError).toContain('Admin access required');
      });

      // Non-admin calls getStarConfig → succeeds (no guard beyond @mesh())
      // Config bag may contain defaults bootstrapped by Resources (e.g., coalesceWindowMs)
      userClient.callStarGetConfig(star);
      await vi.waitFor(() => {
        expect(userClient.lastResult).toBeDefined();
        expect(userClient.lastError).toBeUndefined();
      });

      // Non-admin calls whoAmI → succeeds
      userClient.callStarWhoAmI(star);
      await vi.waitFor(() => {
        expect(userClient.lastResult).toContain('You are');
      });

      userClient[Symbol.dispose]();
    });

    it('star-level admin can call setStarConfig', async () => {
      const browser = new Browser();
      const star = `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;

      // Bootstrap admin and create client
      const { client: adminClient } = await adminClientAt(
        NebulaClientTest, browser, star, star, 'admin@example.com',
      );

      // Admin calls setStarConfig → succeeds
      adminClient.callStarSetConfig(star, 'theme', 'dark');
      await vi.waitFor(() => {
        expect(adminClient.callCompleted).toBe(true);
      });

      // Read it back — config bag also contains defaults bootstrapped by Resources
      adminClient.callStarGetConfig(star);
      await vi.waitFor(() => {
        expect(adminClient.lastResult).toMatchObject({ theme: 'dark' });
      });

      adminClient[Symbol.dispose]();
    });

    // ⚠️ ONE admin per universe. `claim-universe` is the only admin-minting path and the slug is
    // unique, so a universe cannot hold two distinct admins — the old fixture's separate
    // `star-admin@` + `universe-admin@` identities are unmintable. There is likewise no "star-level
    // admin" tier: an invite mints `scopeAdmin: false`, so every admin's pattern is `{u}.*` (or `*`).
    // The property under test survives intact, and is now exercised more precisely: the second client
    // holds aud = the UNIVERSE while calling a STAR DO, so admission comes from the *dominion* branch
    // (pattern covers the callee node) rather than the tenant branch — which is exactly what
    // "universe admin reaches star-level admin methods" means.
    it('universe admin (wildcard) can call star-level setStarConfig', async () => {
      const browser = new Browser();
      const universe = `uni-${crypto.randomUUID().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // Universe admin (pattern `{universe}.*`) at the star aud — creates the Star DO.
      const starBrowser = new Browser();
      const { client: starClient } = await adminClientAt(
        NebulaClientTest, starBrowser, star, star, 'admin@example.com',
      );
      starClient.callStarSetConfig(star, 'initial', 'value');
      await vi.waitFor(() => {
        expect(starClient.callCompleted).toBe(true);
      });
      starClient[Symbol.dispose]();

      // Same identity, now with aud = the UNIVERSE, reaching down into the Star.
      const { client: universeAdmin, payload } = await universeAdminClient(
        NebulaClientTest, browser, universe, universe, 'admin@example.com',
      );
      // Guard the fixture: aud must be the universe, or this stops testing cross-tier dominion.
      expect(payload.aud).toBe(universe);
      expect(payload.access?.authScope).toBe(`${universe}`);

      // Universe admin calls star-level setStarConfig → succeeds (cross-admin access)
      universeAdmin.callStarSetConfig(star, 'cross', 'admin');
      await vi.waitFor(() => {
        expect(universeAdmin.callCompleted).toBe(true);
      });

      // Read it back
      universeAdmin.callStarGetConfig(star);
      await vi.waitFor(() => {
        expect(universeAdmin.lastResult).toMatchObject({ cross: 'admin' });
      });

      universeAdmin[Symbol.dispose]();
    });
  });

  describe('lifecycle ordering', () => {
    it('onBeforeCall rejects wrong active scope before guard runs', async () => {
      const browser = new Browser();
      const starA = `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
      const starB = `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-b`;

      // Create Star A with admin
      const { client: clientA } = await adminClientAt(
        NebulaClientTest, browser, starA, starA, 'admin@example.com',
      );
      clientA.callStarWhoAmI(starA); // Initialize Star A binding
      await vi.waitFor(() => {
        expect(clientA.callCompleted).toBe(true);
      });
      clientA[Symbol.dispose]();

      // Create client B with different active scope
      const browserB = new Browser();
      const { client: clientB } = await adminClientAt(
        NebulaClientTest, browserB, starB, starB, 'bob@example.com',
      );

      // Client B calls whoAmI on Star A → rejected by onBeforeCall (scope mismatch)
      // NOT by guard (whoAmI has no guard)
      clientB.callStarWhoAmI(starA);
      await vi.waitFor(() => {
        expect(clientB.lastError).toContain('Active-scope mismatch');
      });

      clientB[Symbol.dispose]();
    });
  });

  // The no-aud (branch c) and missing-callee (branch a) fail-closed paths of
  // onBeforeCall are covered by T5 in scope-isolation.test.ts (driven below the
  // public API via a hand-built envelope, since the normal client path always
  // carries an aud and callee metadata).
});

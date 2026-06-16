/**
 * Guard enforcement tests
 *
 * Tests @mesh(guard) decorators: admin-only methods, guard rejection,
 * lifecycle ordering (onBeforeCall rejects before guard runs),
 * and cross-admin access.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

describe('guard enforcement', () => {

  describe('star-level guards', () => {
    it('non-admin cannot call setStarConfig, can call getStarConfig and whoAmI', async () => {
      const browser = new Browser();
      const star = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;

      // Bootstrap admin
      const { accessToken: adminToken } = await browserLogin(browser, star, 'admin@example.com');

      // Create non-admin subject
      const userBrowser = new Browser();
      await createSubject(browser, star, adminToken, 'user@example.com');
      const { client: userClient } = await createAuthenticatedClient(
        NebulaClientTest, userBrowser, star, star, 'user@example.com',
      );

      // Non-admin calls setStarConfig → rejected by requireAdmin guard
      userClient.callStarSetConfig(star, 'key', 'value');
      await vi.waitFor(() => {
        expect(userClient.lastError).toContain('Admin access required');
      });

      // Non-admin calls getStarConfig → succeeds (no guard beyond @mesh())
      // Config bag may contain defaults bootstrapped by Resources (e.g., debounceMs)
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
      const star = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;

      // Bootstrap admin and create client
      const { client: adminClient } = await createAuthenticatedClient(
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

    it('universe admin (wildcard) can call star-level setStarConfig', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // First, bootstrap a star-level admin so the Star DO gets created
      const starBrowser = new Browser();
      const { client: starClient } = await createAuthenticatedClient(
        NebulaClientTest, starBrowser, star, star, 'star-admin@example.com',
      );
      starClient.callStarSetConfig(star, 'initial', 'value');
      await vi.waitFor(() => {
        expect(starClient.callCompleted).toBe(true);
      });
      starClient[Symbol.dispose]();

      // Universe admin authenticates and connects to the star
      const { client: universeAdmin } = await createAuthenticatedClient(
        NebulaClientTest, browser, universe, star, 'universe-admin@example.com',
      );

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
      const starA = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
      const starB = `acme-${generateUuid().slice(0, 8)}.app.tenant-b`;

      // Create Star A with admin
      const { client: clientA } = await createAuthenticatedClient(
        NebulaClientTest, browser, starA, starA, 'admin@example.com',
      );
      clientA.callStarWhoAmI(starA); // Initialize Star A binding
      await vi.waitFor(() => {
        expect(clientA.callCompleted).toBe(true);
      });
      clientA[Symbol.dispose]();

      // Create client B with different active scope
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
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

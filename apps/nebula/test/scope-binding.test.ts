/**
 * universeGalaxyStarId binding tests
 *
 * Tests NebulaDO.onBeforeCall() — permanently locks each DO instance to
 * the active scope that first accessed it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createAuthenticatedClient, browserLogin, refreshToken } from './test-helpers.js';

describe('universeGalaxyStarId binding', () => {

  // ============================================
  // Star-level binding
  // ============================================

  describe('star-level binding', () => {
    it('binds Star and ResourceHistory to the creating active scope, rejects cross-scope access', async () => {
      const browser = new Browser();
      const starA = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
      const starB = `acme-${generateUuid().slice(0, 8)}.app.tenant-b`;
      const resourceId = generateUuid();

      // Create admin + subject for star A
      const { client: clientA } = await createAuthenticatedClient(
        browser, starA, starA, 'alice@example.com',
      );

      // Call Star method → universeGalaxyStarId stored
      clientA.callStarWhoAmI(starA);
      await vi.waitFor(() => {
        expect(clientA.lastResult).toContain('You are');
      });

      // Call ResourceHistory → universeGalaxyStarId stored from callContext
      clientA.callResourceHistoryGetHistory(resourceId);
      await vi.waitFor(() => {
        expect(clientA.lastResult).toContain(resourceId);
      });

      // Create client for star B (different active scope)
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
        browserB, starB, starB, 'bob@example.com',
      );

      // Client B tries to call the SAME ResourceHistory UUID → active-scope mismatch
      clientB.callResourceHistoryGetHistory(resourceId);
      await vi.waitFor(() => {
        expect(clientB.lastError).toContain('Active-scope mismatch');
      });

      // Cleanup
      clientA[Symbol.dispose]();
      clientB[Symbol.dispose]();
    });

    it('admin with wildcard JWT can access star-level ResourceHistory', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;
      const resourceId = generateUuid();

      // Create star-level subject and access ResourceHistory
      const { client: starClient } = await createAuthenticatedClient(
        browser, star, star, 'alice@example.com',
      );
      starClient.callResourceHistoryGetHistory(resourceId);
      await vi.waitFor(() => {
        expect(starClient.lastResult).toContain(resourceId);
      });
      starClient[Symbol.dispose]();

      // Now universe admin accesses same ResourceHistory with matching active scope
      const adminBrowser = new Browser();
      const { client: adminClient } = await createAuthenticatedClient(
        adminBrowser, universe, star, 'admin@example.com',
      );
      adminClient.callResourceHistoryGetHistory(resourceId);
      await vi.waitFor(() => {
        expect(adminClient.lastResult).toContain(resourceId);
      });
      adminClient[Symbol.dispose]();
    });
  });

  // ============================================
  // Galaxy-level binding
  // ============================================

  describe('galaxy-level binding', () => {
    it('binds Galaxy to creating active scope, rejects different galaxy', async () => {
      const browser = new Browser();
      const galaxy = `acme-${generateUuid().slice(0, 8)}.app`;
      const otherGalaxy = `acme-${generateUuid().slice(0, 8)}.other`;

      // Client with aud = galaxy connects, calls Galaxy method
      const { client: clientA } = await createAuthenticatedClient(
        browser, galaxy, galaxy, 'alice@example.com',
      );
      clientA.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => {
        expect(clientA.lastResult).toEqual({});
      });
      clientA[Symbol.dispose]();

      // Different client with different galaxy aud tries same Galaxy instance → rejected
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
        browserB, otherGalaxy, otherGalaxy, 'bob@example.com',
      );
      clientB.callGalaxyGetConfig(galaxy);
      await vi.waitFor(() => {
        expect(clientB.lastError).toContain('Active-scope mismatch');
      });
      clientB[Symbol.dispose]();
    });
  });

  // ============================================
  // Universe-level binding
  // ============================================

  describe('universe-level binding', () => {
    it('binds Universe to creating active scope, rejects different universe', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const otherUniverse = `other-${generateUuid().slice(0, 8)}`;

      // Client with aud = universe connects, calls Universe method
      const { client: clientA } = await createAuthenticatedClient(
        browser, universe, universe, 'alice@example.com',
      );
      clientA.callUniverseGetConfig(universe);
      await vi.waitFor(() => {
        expect(clientA.lastResult).toEqual({});
      });
      clientA[Symbol.dispose]();

      // Different client with different universe aud tries same Universe instance → rejected
      const browserB = new Browser();
      const { client: clientB } = await createAuthenticatedClient(
        browserB, otherUniverse, otherUniverse, 'bob@example.com',
      );
      clientB.callUniverseGetConfig(universe);
      await vi.waitFor(() => {
        expect(clientB.lastError).toContain('Active-scope mismatch');
      });
      clientB[Symbol.dispose]();
    });
  });
});

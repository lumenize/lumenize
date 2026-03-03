/**
 * Gateway abuse case tests
 *
 * Tests mesh→client active-scope verification, direct HTTP rejection,
 * and token expiry/no auth scenarios.
 */
import { describe, it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createAuthenticatedClient, browserLogin, createSubject, refreshToken } from './test-helpers.js';
import { NebulaClientTest, StarTest } from './test-worker-and-dos.js';

describe('gateway abuse cases', () => {

  // ============================================
  // Direct HTTP to NebulaDO
  // ============================================

  describe('direct HTTP rejection', () => {
    it('returns 501 for direct HTTP to Star binding', async () => {
      const resp = await SELF.fetch('http://localhost/STAR/acme.app.tenant-a', {
        method: 'GET',
      });
      expect(resp.status).toBe(501);
    });

    it('returns 501 for direct HTTP to ResourceHistory binding', async () => {
      const resp = await SELF.fetch(`http://localhost/RESOURCE_HISTORY/${generateUuid()}`, {
        method: 'GET',
      });
      expect(resp.status).toBe(501);
    });

    it('returns 501 for direct HTTP to Universe binding', async () => {
      const resp = await SELF.fetch('http://localhost/UNIVERSE/acme', {
        method: 'GET',
      });
      expect(resp.status).toBe(501);
    });

    it('returns 501 for HTTP to gateway route', async () => {
      const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/sub.tab1', {
        method: 'GET',
      });
      expect(resp.status).toBe(501);
    });

    it('returns 501 for direct WebSocket to DO binding (no gateway prefix)', async () => {
      const resp = await SELF.fetch('http://localhost/NEBULA_CLIENT_GATEWAY/sub.tab1', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz',
        },
      });
      expect(resp.status).toBe(501);
    });
  });

  // ============================================
  // Token expiry / no auth
  // ============================================

  describe('token expiry and missing auth', () => {
    it('rejects WebSocket upgrade with no JWT', async () => {
      const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/sub.tab1', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz',
        },
      });
      expect(resp.status).toBe(401);
    });

    it('rejects WebSocket upgrade with invalid JWT', async () => {
      const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/sub.tab1', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.invalid-jwt-token',
        },
      });
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Mesh → client active-scope verification
  // ============================================

  describe('mesh → client active-scope verification', () => {
    it('happy path: StarTest calls client echo on same active scope', async () => {
      const browser = new Browser();
      const star = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;

      // Create admin client
      const { client: adminClient } = await createAuthenticatedClient(
        browser, star, star, 'admin@example.com',
      );

      // Get the client's gateway instance name (sub.tabId)
      const gwInstanceName = adminClient.lmz.instanceName;

      // Initialize the Star so it knows its binding
      adminClient.callStarSetConfig(star, 'test', 'value');
      await vi.waitFor(() => {
        expect(adminClient.callCompleted).toBe(true);
      });

      // Client calls StarTest.callClient which calls back to client's echo method
      // StarTest.callClient is @mesh(requireAdmin) — admin JWT passes the guard
      adminClient.lmz.call(
        'STAR',
        star,
        adminClient.ctn<StarTest>().callClient(gwInstanceName!, 'echo', 'hello'),
      );

      // Verify echo was called on the client
      await vi.waitFor(() => {
        expect(adminClient.lastEchoMessage).toBe('hello');
      });

      adminClient[Symbol.dispose]();
    });

    it('client-side guard: adminEcho passes for admin-originated call', async () => {
      const browser = new Browser();
      const star = `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;

      const { client: adminClient } = await createAuthenticatedClient(
        browser, star, star, 'admin@example.com',
      );

      const gwInstanceName = adminClient.lmz.instanceName;

      // Initialize the Star so it knows its binding
      adminClient.callStarSetConfig(star, 'test', 'value');
      await vi.waitFor(() => {
        expect(adminClient.callCompleted).toBe(true);
      });

      // StarTest (admin) calls client's adminEcho — requires admin caller
      adminClient.lmz.call(
        'STAR',
        star,
        adminClient.ctn<StarTest>().callClient(gwInstanceName!, 'adminEcho', 'hello'),
      );

      // Verify adminEcho was called on the client
      await vi.waitFor(() => {
        expect(adminClient.lastAdminEchoMessage).toBe('hello');
      });

      adminClient[Symbol.dispose]();
    });
  });

  // ============================================
  // 404 for unknown routes
  // ============================================

  describe('routing', () => {
    it('returns 404 for unknown paths', async () => {
      const resp = await SELF.fetch('http://localhost/unknown/path');
      expect(resp.status).toBe(404);
    });
  });
});

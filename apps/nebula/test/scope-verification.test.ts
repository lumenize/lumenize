/**
 * Entrypoint auth-scope verification tests
 *
 * Tests the belt-and-suspenders matchAccess(authScopePattern, aud) check
 * inside verifyNebulaAccessToken, plus admin active-scope switching.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { generateUuid, signJwt, importPrivateKey, createJwtPayload } from '@lumenize/auth';
import { NEBULA_AUTH_ISSUER } from '@lumenize/nebula-auth';
import { createAuthenticatedClient, browserLogin, refreshToken } from './test-helpers.js';
import { NebulaClientTest } from './test-worker-and-dos.js';

/**
 * Craft a JWT with specific authScopePattern and aud for unit testing.
 * Signs with the real private key so signature verification passes.
 */
async function craftJwt(options: {
  authScopePattern: string;
  aud: string;
  admin?: boolean;
  sub?: string;
}): Promise<string> {
  const privateKeyPem = (env as any).JWT_PRIVATE_KEY_BLUE;
  const privateKey = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: options.aud,
    sub: options.sub ?? generateUuid(),
    exp: now + 900,
    iat: now,
    jti: generateUuid(),
    emailVerified: true,
    adminApproved: true,
    email: 'test@example.com',
    access: {
      authScopePattern: options.authScopePattern,
      admin: options.admin ?? false,
    },
  };

  return await signJwt(payload, privateKey, 'BLUE');
}

describe('entrypoint auth-scope verification', () => {

  // ============================================
  // Belt-and-suspenders: crafted JWTs with mismatched auth/active scope
  // ============================================

  describe('matchAccess(authScopePattern, aud) at entrypoint', () => {
    it('rejects JWT where authScopePattern does not cover aud', async () => {
      // JWT with aud = "acme.app.tenant-a" but authScopePattern = "acme.app.tenant-b"
      const token = await craftJwt({
        authScopePattern: 'acme.app.tenant-b',
        aud: 'acme.app.tenant-a',
      });

      // Attempt WebSocket upgrade through the gateway route
      // The entrypoint should reject this with 403 (matchAccess fails)
      const resp = await SELF.fetch('http://localhost/gateway/NEBULA_CLIENT_GATEWAY/test.tab1', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
        },
      });
      expect(resp.status).toBe(403);
    });

    it('allows JWT where wildcard authScopePattern covers aud', async () => {
      const token = await craftJwt({
        authScopePattern: 'acme.*',
        aud: 'acme.app.tenant-a',
        admin: true,
      });

      // This JWT should pass verification (wildcard covers the active scope)
      // We verify by importing verifyNebulaAccessToken directly
      const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result!.aud).toBe('acme.app.tenant-a');
      expect(result!.access.authScopePattern).toBe('acme.*');
    });

    it('allows JWT where exact authScopePattern matches aud', async () => {
      const token = await craftJwt({
        authScopePattern: 'acme.app.tenant-a',
        aud: 'acme.app.tenant-a',
      });

      const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
      const result = await verifyNebulaAccessToken(token, env);
      expect(result).not.toBeNull();
      expect(result!.aud).toBe('acme.app.tenant-a');
    });

    it('rejects JWT where authScopePattern is narrower than aud', async () => {
      const token = await craftJwt({
        authScopePattern: 'acme.app.tenant-a',
        aud: 'acme.app',  // aud is broader than authScopePattern
      });

      const { verifyNebulaAccessToken } = await import('@lumenize/nebula-auth');
      const result = await verifyNebulaAccessToken(token, env);
      expect(result).toBeNull();
    });
  });

  // ============================================
  // Admin active-scope switching
  // ============================================

  describe('admin active-scope switching', () => {
    it('universe admin can refresh with different activeScope values', async () => {
      const browser = new Browser();
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const starA = `${universe}.app.tenant-a`;
      const starB = `${universe}.app.tenant-b`;

      // Bootstrap universe admin
      const { accessToken: adminToken, payload: adminPayload } = await browserLogin(
        browser, universe, 'admin@example.com', universe,
      );
      expect(adminPayload.access.authScopePattern).toContain(universe);
      expect(adminPayload.access.admin).toBe(true);

      // Admin refreshes with activeScope = starA
      const { accessToken: tokenA, payload: payloadA } = await refreshToken(browser, universe, starA);
      expect(payloadA.aud).toBe(starA);

      // Create client with starA scope, verify it connects and works
      const ctxA = browser.context('http://localhost');
      const clientA = new NebulaClientTest({
        baseUrl: 'http://localhost',
        authScope: universe,
        activeScope: starA,
        fetch: browser.fetch,
        WebSocket: browser.WebSocket,
        sessionStorage: ctxA.sessionStorage,
        BroadcastChannel: ctxA.BroadcastChannel,
      });
      await vi.waitFor(() => { expect(clientA.connectionState).toBe('connected'); });
      clientA[Symbol.dispose]();

      // Admin refreshes with activeScope = starB
      const { accessToken: tokenB, payload: payloadB } = await refreshToken(browser, universe, starB);
      expect(payloadB.aud).toBe(starB);

      // Verify the two tokens have different aud claims
      expect(payloadA.aud).not.toBe(payloadB.aud);

      // Create client with starB scope
      const ctxB = browser.context('http://localhost');
      const clientB = new NebulaClientTest({
        baseUrl: 'http://localhost',
        authScope: universe,
        activeScope: starB,
        fetch: browser.fetch,
        WebSocket: browser.WebSocket,
        sessionStorage: ctxB.sessionStorage,
        BroadcastChannel: ctxB.BroadcastChannel,
      });
      await vi.waitFor(() => { expect(clientB.connectionState).toBe('connected'); });
      clientB[Symbol.dispose]();
    });
  });
});

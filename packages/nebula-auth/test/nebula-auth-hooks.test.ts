/**
 * Tests for createRouteDORequestNebulaAuthHooks
 *
 * Covers:
 * - Star-level endpoint accepts JWTs from its own Star DO
 * - Star-level endpoint accepts JWTs from Universe/Galaxy admins (wildcard)
 * - Rejects JWTs from unrelated stars
 * - Rejects lower-tier admins trying to access higher tiers
 * - Platform admin ("*") access works everywhere
 * - adminApproved gate enforcement
 * - Rate limiting behavior
 * - WebSocket subprotocol token extraction
 * - Missing/invalid tokens
 * - Wrong issuer/audience
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { signJwt, importPrivateKey, generateUuid } from '@lumenize/auth';
import { createRouteDORequestNebulaAuthHooks } from '../src/hooks';
import { NEBULA_AUTH_ISSUER, NEBULA_AUTH_AUDIENCE, NEBULA_AUTH_PREFIX } from '../src/types';
import type { NebulaJwtPayload, AccessEntry } from '../src/types';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'

/** Mock context for hook calls */
const mockContext = { doNamespace: {}, doInstanceNameOrId: 'test-instance' };

/**
 * Helper: create a Nebula JWT with the given access claim.
 * Uses the BLUE private key from env by default.
 */
async function createNebulaJwt(opts: {
  accessId: string;
  accessAdmin?: boolean;
  adminApproved?: boolean;
  sub?: string;
  iss?: string;
  aud?: string;
  expiresInSeconds?: number;
  keyColor?: 'BLUE' | 'GREEN';
}): Promise<string> {
  const keyColor = opts.keyColor ?? 'BLUE';
  const privateKeyPem = keyColor === 'GREEN'
    ? env.JWT_PRIVATE_KEY_GREEN
    : env.JWT_PRIVATE_KEY_BLUE;
  const privateKey = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const access: AccessEntry = { id: opts.accessId };
  if (opts.accessAdmin) access.admin = true;

  const payload: NebulaJwtPayload = {
    iss: opts.iss ?? NEBULA_AUTH_ISSUER,
    aud: opts.aud ?? NEBULA_AUTH_AUDIENCE,
    sub: opts.sub ?? generateUuid(),
    exp: now + (opts.expiresInSeconds ?? 900),
    iat: now,
    jti: generateUuid(),
    adminApproved: opts.adminApproved ?? false,
    access,
  };

  return signJwt(payload as any, privateKey, keyColor);
}

/** Build a URL for a given instance + endpoint */
function hookUrl(instanceName: string, endpoint: string): string {
  return `http://localhost${PREFIX}/${instanceName}/${endpoint}`;
}

describe('@lumenize/nebula-auth - createRouteDORequestNebulaAuthHooks', () => {

  // ============================================
  // onBeforeRequest: Basic auth failures
  // ============================================

  describe('onBeforeRequest — basic auth failures', () => {
    it('returns 401 when no Authorization header', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'));
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const resp = result as Response;
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Missing Authorization');

      // WWW-Authenticate header
      const wwwAuth = resp.headers.get('WWW-Authenticate');
      expect(wwwAuth).toContain('Bearer');
      expect(wwwAuth).toContain('realm="Nebula"');
    });

    it('returns 401 for invalid Authorization header format', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': 'Basic sometoken' },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid JWT', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': 'Bearer invalid.jwt.token' },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const resp = result as Response;
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('returns 401 for wrong audience', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
        aud: 'https://wrong-audience.com',
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      const body = await (result as Response).json() as any;
      expect(body.error_description).toContain('audience');
    });

    it('returns 401 for wrong issuer', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
        iss: 'https://wrong-issuer.com',
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      const body = await (result as Response).json() as any;
      expect(body.error_description).toContain('issuer');
    });
  });

  // ============================================
  // onBeforeRequest: Access matching — star-level
  // ============================================

  describe('onBeforeRequest — star-level access matching', () => {
    it('accepts JWT from its own Star DO', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
      const enhanced = result as Request;
      expect(enhanced.headers.get('Authorization')).toBe(`Bearer ${token}`);
    });

    it('rejects JWT from an unrelated star', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.other-tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const resp = result as Response;
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });
  });

  // ============================================
  // onBeforeRequest: Wildcard matching — hierarchy
  // ============================================

  describe('onBeforeRequest — wildcard access matching', () => {
    it('universe admin (acme.*) can access a star beneath (acme.crm.tenant)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      // admin flag on access serves as the gate pass
      expect(result).toBeInstanceOf(Request);
    });

    it('universe admin (acme.*) can access the universe itself (acme)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('galaxy admin (acme.crm.*) can access a star beneath (acme.crm.tenant)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('galaxy admin (acme.crm.*) can access its own galaxy (acme.crm)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('galaxy admin CANNOT access the parent universe (upward)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
      const body = await (result as Response).json() as any;
      expect(body.error).toBe('insufficient_scope');
    });

    it('star-level JWT CANNOT access a sibling star', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant-a',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant-b', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });

    it('star-level JWT CANNOT access its parent galaxy (upward)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });
  });

  // ============================================
  // onBeforeRequest: Platform admin
  // ============================================

  describe('onBeforeRequest — platform admin ("*")', () => {
    it('platform admin can access any star', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: '*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('platform admin can access any universe', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: '*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('platform admin can access any galaxy', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: '*',
        accessAdmin: true,
      });
      const request = new Request(hookUrl('acme.crm', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });
  });

  // ============================================
  // onBeforeRequest: Access gate enforcement
  // ============================================

  describe('onBeforeRequest — access gate (admin || adminApproved)', () => {
    it('allows access when adminApproved=true (non-admin, exact match)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        accessAdmin: false,
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('allows access when access.admin=true (without adminApproved)', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        accessAdmin: true,
        adminApproved: false,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('denies access when neither admin nor adminApproved', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        accessAdmin: false,
        adminApproved: false,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const resp = result as Response;
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('access_denied');
      expect(body.error_description).toContain('not yet approved');
    });

    it('wildcard admin passes gate without adminApproved', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.*',
        accessAdmin: true,
        adminApproved: false,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      // admin flag on the access entry passes the gate
      expect(result).toBeInstanceOf(Request);
    });

    it('wildcard non-admin with adminApproved=true passes gate', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.*',
        accessAdmin: false,
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('wildcard non-admin without adminApproved is denied', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.*',
        accessAdmin: false,
        adminApproved: false,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });
  });

  // ============================================
  // onBeforeRequest: Key rotation
  // ============================================

  describe('onBeforeRequest — key rotation', () => {
    it('accepts tokens signed with BLUE key', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
        keyColor: 'BLUE',
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('accepts tokens signed with GREEN key', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
        keyColor: 'GREEN',
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });
  });

  // ============================================
  // onBeforeRequest: Rate limiting
  // ============================================

  describe('onBeforeRequest — rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);

      // Use a fixed sub so all requests hit the same rate limit key
      const fixedSub = 'rate-limit-test-sub';
      const requests: Promise<Response | Request | undefined>[] = [];

      for (let i = 0; i < 110; i++) {
        const token = await createNebulaJwt({
          accessId: 'acme.crm.tenant',
          adminApproved: true,
          sub: fixedSub,
        });
        requests.push(
          onBeforeRequest(
            new Request(hookUrl('acme.crm.tenant', 'resource'), {
              headers: { 'Authorization': `Bearer ${token}` },
            }),
            mockContext,
          ),
        );
      }

      const results = await Promise.all(requests);
      const rateLimited = results.filter(
        (r) => r instanceof Response && r.status === 429,
      );

      // With 100/min limit and 110 requests, at least some should be rate limited
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // onBeforeRequest: Forwards JWT
  // ============================================

  describe('onBeforeRequest — JWT forwarding', () => {
    it('forwards the verified JWT in Authorization header', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
      const enhanced = result as Request;
      expect(enhanced.headers.get('Authorization')).toBe(`Bearer ${token}`);
    });
  });

  // ============================================
  // onBeforeConnect (WebSocket subprotocol)
  // ============================================

  describe('onBeforeConnect — WebSocket subprotocol token', () => {
    it('returns 401 when no token in subprotocol', async () => {
      const { onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
      const request = new Request(hookUrl('acme.crm.tenant', 'ws'), {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz',
        },
      });
      const result = await onBeforeConnect(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const { onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
      const request = new Request(hookUrl('acme.crm.tenant', 'ws'), {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.invalid-token',
        },
      });
      const result = await onBeforeConnect(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 403 when access gate fails', async () => {
      const { onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        accessAdmin: false,
        adminApproved: false,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'ws'), {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
        },
      });
      const result = await onBeforeConnect(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });

    it('forwards JWT for valid WebSocket token', async () => {
      const { onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'ws'), {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
        },
      });
      const result = await onBeforeConnect(request, mockContext);

      expect(result).toBeInstanceOf(Request);
      const enhanced = result as Request;
      expect(enhanced.headers.get('Authorization')).toBe(`Bearer ${token}`);
    });

    it('rejects WebSocket with insufficient scope', async () => {
      const { onBeforeConnect } = await createRouteDORequestNebulaAuthHooks(env);
      const token = await createNebulaJwt({
        accessId: 'acme.crm.other-tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'ws'), {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`,
        },
      });
      const result = await onBeforeConnect(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });
  });

  // ============================================
  // Integration: end-to-end with real DO-issued JWTs
  // ============================================

  describe('integration — real DO-issued JWTs', () => {
    it('star DO issues a JWT that is accepted by the hook for the same star', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);

      // Login to a star DO and get a real JWT
      const instanceName = 'hook-int-test.app.tenant1';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // Request magic link
      const mlResp = await stub.fetch(new Request(
        `http://localhost${PREFIX}/${instanceName}/email-magic-link?_test=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'hook-test@example.com' }),
        },
      ));
      expect(mlResp.status).toBe(200);
      const { magic_link } = await mlResp.json() as any;

      // Click magic link
      const clickResp = await stub.fetch(new Request(magic_link, { redirect: 'manual' }));
      expect(clickResp.status).toBe(302);
      const setCookie = clickResp.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

      // Exchange refresh token for access token
      const refreshResp = await stub.fetch(new Request(
        `http://localhost${PREFIX}/${instanceName}/refresh-token`,
        {
          method: 'POST',
          headers: { 'Cookie': `refresh-token=${refreshToken}` },
        },
      ));
      expect(refreshResp.status).toBe(200);
      const { access_token } = await refreshResp.json() as any;

      // Now test the hook with this real JWT
      const request = new Request(hookUrl(instanceName, 'resource'), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });

    it('universe DO issues a wildcard JWT that is accepted for stars beneath', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);

      // Login at universe level — first user becomes founder (admin)
      const universeName = 'hook-universe-test';
      const stub = env.NEBULA_AUTH.getByName(universeName);

      const mlResp = await stub.fetch(new Request(
        `http://localhost${PREFIX}/${universeName}/email-magic-link?_test=true`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'universe-admin@example.com' }),
        },
      ));
      expect(mlResp.status).toBe(200);
      const { magic_link } = await mlResp.json() as any;

      const clickResp = await stub.fetch(new Request(magic_link, { redirect: 'manual' }));
      expect(clickResp.status).toBe(302);
      const setCookie = clickResp.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

      const refreshResp = await stub.fetch(new Request(
        `http://localhost${PREFIX}/${universeName}/refresh-token`,
        {
          method: 'POST',
          headers: { 'Cookie': `refresh-token=${refreshToken}` },
        },
      ));
      expect(refreshResp.status).toBe(200);
      const { access_token } = await refreshResp.json() as any;

      // Universe admin JWT should grant access to stars beneath
      const starRequest = new Request(hookUrl('hook-universe-test.app.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      const result = await onBeforeRequest(starRequest, mockContext);

      expect(result).toBeInstanceOf(Request);

      // But should NOT grant access to a different universe
      const otherRequest = new Request(hookUrl('other-universe.app.tenant', 'subjects'), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      const otherResult = await onBeforeRequest(otherRequest, mockContext);

      expect(otherResult).toBeInstanceOf(Response);
      expect((otherResult as Response).status).toBe(403);
    });
  });

  // ============================================
  // Edge cases
  // ============================================

  describe('edge cases', () => {
    it('rejects JWT missing access claim entirely', async () => {
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env);

      // Manually create a JWT without access claim (simulating @lumenize/auth format)
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: NEBULA_AUTH_ISSUER,
        aud: NEBULA_AUTH_AUDIENCE,
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        emailVerified: true,
        adminApproved: true,
        // no access claim!
      };
      const token = await signJwt(payload as any, privateKey, 'BLUE');

      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      const body = await (result as Response).json() as any;
      expect(body.error_description).toContain('access');
    });

    it('throws when no public keys in env', async () => {
      const emptyEnv = {} as any;
      await expect(
        createRouteDORequestNebulaAuthHooks(emptyEnv),
      ).rejects.toThrow('No JWT public keys');
    });

    it('warns but works when rate limiter binding is missing', async () => {
      // Create env without rate limiter
      const envWithoutRateLimiter = { ...env } as any;
      delete envWithoutRateLimiter.NEBULA_AUTH_RATE_LIMITER;

      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(envWithoutRateLimiter);

      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
      });
      const request = new Request(hookUrl('acme.crm.tenant', 'resource'), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      // Should still work (rate limiting just skipped)
      expect(result).toBeInstanceOf(Request);
    });

    it('supports custom prefix option', async () => {
      const customPrefix = '/custom-auth';
      const { onBeforeRequest } = await createRouteDORequestNebulaAuthHooks(env, {
        prefix: customPrefix,
      });

      const token = await createNebulaJwt({
        accessId: 'acme.crm.tenant',
        adminApproved: true,
      });

      // Request with custom prefix should work
      const request = new Request(`http://localhost${customPrefix}/acme.crm.tenant/resource`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
    });
  });
});

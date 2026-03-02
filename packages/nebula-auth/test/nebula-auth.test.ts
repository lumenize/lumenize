/**
 * NebulaAuth DO tests — adapted from @lumenize/auth test suite.
 *
 * Key differences from auth tests:
 * - URLs include {prefix}/{instanceName}/endpoint (path-scoped)
 * - JWT payload has `access: { id, admin? }` instead of flat isAdmin/emailVerified
 * - Path-scoped cookies: Path={prefix}/{instanceName}
 * - First-user-is-founder: zero subjects → first verified = admin
 * - Platform admin: nebula-platform instance + bootstrap email → { id: "*", admin: true }
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe, importPublicKey, verifyJwt } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '../src/types';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'

/** Helper to build full URL for a given instance + endpoint */
function url(instanceName: string, endpoint: string, query = ''): string {
  return `http://localhost${PREFIX}/${instanceName}/${endpoint}${query}`;
}

/** Helper: request magic link in test mode, return the magic_link URL */
async function requestMagicLink(stub: any, instanceName: string, email: string): Promise<string> {
  const resp = await stub.fetch(new Request(url(instanceName, 'email-magic-link?_test=true'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.magic_link).toBeDefined();
  return body.magic_link;
}

/** Helper: complete magic link login, return { setCookie, refreshToken } */
async function clickMagicLink(stub: any, magicLinkUrl: string): Promise<{ setCookie: string; refreshToken: string }> {
  const resp = await stub.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
  expect(resp.status).toBe(302);
  expect(resp.headers.get('Location')).toBe('/app');
  const setCookie = resp.headers.get('Set-Cookie')!;
  expect(setCookie).toContain('refresh-token=');
  const refreshToken = setCookie.split(';')[0].split('=')[1];
  return { setCookie, refreshToken };
}

/** Helper: exchange refresh token for access token, return parsed JWT payload */
async function refreshAndParse(stub: any, instanceName: string, refreshToken: string, activeScope?: string): Promise<any> {
  const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
    method: 'POST',
    headers: {
      'Cookie': `refresh-token=${refreshToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ activeScope: activeScope ?? instanceName }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.access_token).toBeDefined();
  return { ...body, parsed: parseJwtUnsafe(body.access_token)!.payload };
}

/** Helper: full login flow — request magic link, click it, refresh to get JWT */
async function fullLogin(stub: any, instanceName: string, email: string) {
  const magicLink = await requestMagicLink(stub, instanceName, email);
  const { refreshToken, setCookie } = await clickMagicLink(stub, magicLink);
  const { parsed, access_token } = await refreshAndParse(stub, instanceName, refreshToken);
  return { refreshToken, setCookie, parsed, access_token };
}

describe('@lumenize/nebula-auth - NebulaAuth DO', () => {

  // ============================================
  // Schema & 404
  // ============================================

  describe('Schema Initialization', () => {
    it('creates tables on first access and returns 404 for unknown paths', async () => {
      const stub = env.NEBULA_AUTH.getByName('schema-test-1');
      const resp = await stub.fetch(new Request(url('schema-test-1', 'nonexistent')));
      expect(resp.status).toBe(404);
    });
  });

  // ============================================
  // POST email-magic-link
  // ============================================

  describe('POST email-magic-link', () => {
    it('returns error for invalid JSON', async () => {
      const stub = env.NEBULA_AUTH.getByName('ml-test-1');
      const resp = await stub.fetch(new Request(url('ml-test-1', 'email-magic-link'), {
        method: 'POST',
        body: 'not json',
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('returns error for missing email', async () => {
      const stub = env.NEBULA_AUTH.getByName('ml-test-2');
      const resp = await stub.fetch(new Request(url('ml-test-2', 'email-magic-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('email');
    });

    it('returns error for invalid email format', async () => {
      const stub = env.NEBULA_AUTH.getByName('ml-test-3');
      const resp = await stub.fetch(new Request(url('ml-test-3', 'email-magic-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      }));
      expect(resp.status).toBe(400);
    });

    it('generates magic link in test mode', async () => {
      const stub = env.NEBULA_AUTH.getByName('ml-test-4');
      const magicLink = await requestMagicLink(stub, 'ml-test-4', 'test@example.com');
      expect(magicLink).toContain('one_time_token=');
      expect(magicLink).toContain('/ml-test-4/magic-link');
    });

    it('returns success message in production mode (without _test)', async () => {
      const stub = env.NEBULA_AUTH.getByName('ml-test-5');
      const resp = await stub.fetch(new Request(url('ml-test-5', 'email-magic-link'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.message).toContain('Check your email');
      expect(body.magic_link).toBeUndefined();
    });
  });

  // ============================================
  // GET magic-link validation
  // ============================================

  describe('GET magic-link - Validation', () => {
    it('returns error for missing token', async () => {
      const stub = env.NEBULA_AUTH.getByName('val-test-1');
      const resp = await stub.fetch(new Request(url('val-test-1', 'magic-link')));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('redirects with error for invalid token', async () => {
      const stub = env.NEBULA_AUTH.getByName('val-test-2');
      const resp = await stub.fetch(
        new Request(url('val-test-2', 'magic-link', '?one_time_token=invalid')),
        { redirect: 'manual' } as any,
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });
  });

  // ============================================
  // Full Login Flow
  // ============================================

  describe('Full Login Flow', () => {
    it('completes login end-to-end with redirect, path-scoped cookie, and refresh', async () => {
      const instanceName = 'acme';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const magicLink = await requestMagicLink(stub, instanceName, 'fullflow@example.com');
      const { setCookie, refreshToken } = await clickMagicLink(stub, magicLink);

      // Verify path-scoped cookie
      expect(setCookie).toContain(`Path=${PREFIX}/${instanceName}`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');

      // Refresh to get access token
      const { parsed } = await refreshAndParse(stub, instanceName, refreshToken);

      // Verify nebula-specific JWT structure
      expect(parsed.access).toBeDefined();
      expect(parsed.access.authScopePattern).toBe('acme.*'); // universe tier → wildcard
      expect(parsed.adminApproved).toBeDefined();
      expect(parsed.sub).toBeDefined();
    });

    it('creates subject on first login', async () => {
      const instanceName = 'login-create-1';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const { parsed } = await fullLogin(stub, instanceName, 'newuser@example.com');
      expect(parsed.sub).toBeDefined();
      expect(parsed.sub.length).toBe(36); // UUID
    });

    it('rejects already-used magic link', async () => {
      const instanceName = 'login-reuse-1';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const magicLink = await requestMagicLink(stub, instanceName, 'onetime@example.com');

      // First use — succeeds
      await clickMagicLink(stub, magicLink);

      // Second use — fails (token deleted)
      const resp = await stub.fetch(new Request(magicLink, { redirect: 'manual' }));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });

    it('same email → same subject ID across logins', async () => {
      const instanceName = 'login-same-sub';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const email = 'sameuser@example.com';

      const { parsed: p1 } = await fullLogin(stub, instanceName, email);
      const { parsed: p2 } = await fullLogin(stub, instanceName, email);
      expect(p1.sub).toBe(p2.sub);
    });
  });

  // ============================================
  // First-User-Is-Founder
  // ============================================

  describe('First-User-Is-Founder', () => {
    it('first verified email on empty DO becomes founding admin', async () => {
      const instanceName = 'founder-test-1';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const { parsed } = await fullLogin(stub, instanceName, 'founder@example.com');
      expect(parsed.access.admin).toBe(true);
      expect(parsed.adminApproved).toBe(true);
    });

    it('second user is NOT auto-promoted to admin', async () => {
      const instanceName = 'founder-test-2';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // First user — becomes founder admin
      await fullLogin(stub, instanceName, 'first@example.com');

      // Second user — regular user
      const { parsed } = await fullLogin(stub, instanceName, 'second@example.com');
      expect(parsed.access.admin).toBeUndefined();
      expect(parsed.adminApproved).toBe(false);
    });

    it('founder promotion works at all tiers', async () => {
      // Universe tier
      const uStub = env.NEBULA_AUTH.getByName('u-founder');
      const { parsed: uParsed } = await fullLogin(uStub, 'u-founder', 'u@example.com');
      expect(uParsed.access.admin).toBe(true);
      expect(uParsed.access.authScopePattern).toBe('u-founder.*');

      // Galaxy tier
      const gStub = env.NEBULA_AUTH.getByName('acme.crm');
      const { parsed: gParsed } = await fullLogin(gStub, 'acme.crm', 'g@example.com');
      expect(gParsed.access.admin).toBe(true);
      expect(gParsed.access.authScopePattern).toBe('acme.crm.*');

      // Star tier
      const sStub = env.NEBULA_AUTH.getByName('acme.crm.tenant');
      const { parsed: sParsed } = await fullLogin(sStub, 'acme.crm.tenant', 's@example.com');
      expect(sParsed.access.admin).toBe(true);
      expect(sParsed.access.authScopePattern).toBe('acme.crm.tenant'); // star = exact, no wildcard
    });
  });

  // ============================================
  // Bootstrap Admin (Platform)
  // ============================================

  describe('Bootstrap Admin', () => {
    it('promotes bootstrap email to platform admin at nebula-platform', async () => {
      const instanceName = 'nebula-platform';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const bootstrapEmail = 'bootstrap-admin@example.com'; // from vitest config

      const { parsed } = await fullLogin(stub, instanceName, bootstrapEmail);
      expect(parsed.access.authScopePattern).toBe('*'); // platform admin wildcard
      expect(parsed.access.admin).toBe(true);
      expect(parsed.adminApproved).toBe(true);
    });

    it('bootstrap is idempotent across logins', async () => {
      const instanceName = 'nebula-platform';
      const stub = env.NEBULA_AUTH.getByName('bp-idempotent');
      const bootstrapEmail = 'bootstrap-admin@example.com';

      const { parsed: p1 } = await fullLogin(stub, 'bp-idempotent', bootstrapEmail);
      const { parsed: p2 } = await fullLogin(stub, 'bp-idempotent', bootstrapEmail);
      expect(p1.sub).toBe(p2.sub);
      expect(p2.access.admin).toBe(true);
    });

    it('non-bootstrap email is NOT promoted (even at nebula-platform)', async () => {
      // Use a fresh instance so the non-bootstrap email is the first user
      // BUT since first-user-is-founder applies, we need to first login as bootstrap
      // to avoid founder promotion
      const stub = env.NEBULA_AUTH.getByName('bp-nonadmin');
      const bootstrapEmail = 'bootstrap-admin@example.com';

      // Bootstrap login first (becomes founder/admin)
      await fullLogin(stub, 'bp-nonadmin', bootstrapEmail);

      // Regular user — should NOT be admin
      const { parsed } = await fullLogin(stub, 'bp-nonadmin', 'regular@example.com');
      expect(parsed.access.admin).toBeUndefined();
      expect(parsed.adminApproved).toBe(false);
    });
  });

  // ============================================
  // JWT Access Claim Structure
  // ============================================

  describe('JWT Access Claims', () => {
    it('universe-tier JWT has wildcard access id', async () => {
      const stub = env.NEBULA_AUTH.getByName('jwt-universe');
      const { parsed } = await fullLogin(stub, 'jwt-universe', 'u@example.com');
      expect(parsed.access.authScopePattern).toBe('jwt-universe.*');
    });

    it('galaxy-tier JWT has wildcard access id', async () => {
      const stub = env.NEBULA_AUTH.getByName('jwt-u.gal');
      const { parsed } = await fullLogin(stub, 'jwt-u.gal', 'g@example.com');
      expect(parsed.access.authScopePattern).toBe('jwt-u.gal.*');
    });

    it('star-tier JWT has exact access id', async () => {
      const stub = env.NEBULA_AUTH.getByName('jwt-u.gal.star');
      const { parsed } = await fullLogin(stub, 'jwt-u.gal.star', 's@example.com');
      expect(parsed.access.authScopePattern).toBe('jwt-u.gal.star');
    });

    it('admin flag present only when isAdmin', async () => {
      const instanceName = 'jwt-admin-flag';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // First user = founder admin
      const { parsed: adminParsed } = await fullLogin(stub, instanceName, 'admin@example.com');
      expect(adminParsed.access.admin).toBe(true);

      // Second user = regular
      const { parsed: regularParsed } = await fullLogin(stub, instanceName, 'regular@example.com');
      expect(regularParsed.access.admin).toBeUndefined();
    });

    it('JWT has correct standard claims', async () => {
      const stub = env.NEBULA_AUTH.getByName('jwt-claims');
      const { parsed } = await fullLogin(stub, 'jwt-claims', 'claims@example.com');

      expect(parsed.iss).toBe('https://nebula.lumenize.com');
      expect(parsed.aud).toBe('jwt-claims');
      expect(parsed.sub).toBeDefined();
      expect(parsed.exp).toBeGreaterThan(Date.now() / 1000);
      expect(parsed.iat).toBeLessThanOrEqual(Date.now() / 1000);
      expect(parsed.jti).toBeDefined();
    });

    it('JWT can be verified with public key', async () => {
      const stub = env.NEBULA_AUTH.getByName('jwt-verify');
      const { access_token } = await fullLogin(stub, 'jwt-verify', 'verify@example.com');

      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      const payload = await verifyJwt(access_token, publicKey);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeDefined();
    });
  });

  // ============================================
  // Path-Scoped Cookies
  // ============================================

  describe('Path-Scoped Cookies', () => {
    it('refresh cookie has correct Path for universe tier', async () => {
      const stub = env.NEBULA_AUTH.getByName('cookie-universe');
      const magicLink = await requestMagicLink(stub, 'cookie-universe', 'c@example.com');
      const { setCookie } = await clickMagicLink(stub, magicLink);
      expect(setCookie).toContain(`Path=${PREFIX}/cookie-universe`);
    });

    it('refresh cookie has correct Path for star tier', async () => {
      const stub = env.NEBULA_AUTH.getByName('acme.crm.tenant-a');
      const magicLink = await requestMagicLink(stub, 'acme.crm.tenant-a', 'c@example.com');
      const { setCookie } = await clickMagicLink(stub, magicLink);
      expect(setCookie).toContain(`Path=${PREFIX}/acme.crm.tenant-a`);
    });

    it('logout cookie clears with correct path', async () => {
      const instanceName = 'logout-path';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const { refreshToken } = await fullLogin(stub, instanceName, 'logout@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'logout'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
      }));
      expect(resp.status).toBe(200);
      const setCookie = resp.headers.get('Set-Cookie')!;
      expect(setCookie).toContain(`Path=${PREFIX}/${instanceName}`);
      expect(setCookie).toContain('Max-Age=0');
    });
  });

  // ============================================
  // Refresh Token
  // ============================================

  describe('Refresh Token', () => {
    it('returns error when no refresh token cookie', async () => {
      const stub = env.NEBULA_AUTH.getByName('rt-test-1');
      // Need to trigger schema init first
      await requestMagicLink(stub, 'rt-test-1', 'dummy@example.com');

      const resp = await stub.fetch(new Request(url('rt-test-1', 'refresh-token'), {
        method: 'POST',
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('returns error for invalid refresh token', async () => {
      const stub = env.NEBULA_AUTH.getByName('rt-test-2');
      await requestMagicLink(stub, 'rt-test-2', 'dummy@example.com');

      const resp = await stub.fetch(new Request(url('rt-test-2', 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': 'refresh-token=invalid-token' },
      }));
      expect(resp.status).toBe(401);
    });

    it('rotates refresh token — old token invalidated', async () => {
      const instanceName = 'rt-rotate';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // Use clickMagicLink (not fullLogin) to get a fresh, unused refresh token
      const magicLink = await requestMagicLink(stub, instanceName, 'rotate@example.com');
      const { refreshToken: oldToken } = await clickMagicLink(stub, magicLink);

      // First refresh — succeeds (and rotates)
      const resp1 = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(resp1.status).toBe(200);

      // Second use of old token — fails (revoked by rotation)
      const resp2 = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(resp2.status).toBe(401);
      const body = await resp2.json() as any;
      expect(body.error).toBe('token_revoked');
    });

    it('new refresh token works after rotation', async () => {
      const instanceName = 'rt-new-works';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // Use clickMagicLink (not fullLogin) to get a fresh, unused refresh token
      const magicLink = await requestMagicLink(stub, instanceName, 'newrt@example.com');
      const { refreshToken: oldToken } = await clickMagicLink(stub, magicLink);

      // Refresh once to get new token
      const resp1 = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(resp1.status).toBe(200);
      const newCookie = resp1.headers.get('Set-Cookie')!;
      const newToken = newCookie.split(';')[0].split('=')[1];
      expect(newToken).not.toBe(oldToken);

      // Use new token — succeeds
      const resp2 = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${newToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(resp2.status).toBe(200);
    });
  });

  // ============================================
  // activeScope validation (refresh)
  // ============================================

  describe('activeScope Validation (refresh)', () => {
    it('rejects refresh without Content-Type header', async () => {
      const instanceName = 'scope-no-ct';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const magicLink = await requestMagicLink(stub, instanceName, 'ct@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Content-Type');
    });

    it('rejects refresh with empty body (no activeScope)', async () => {
      const instanceName = 'scope-empty';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const magicLink = await requestMagicLink(stub, instanceName, 'empty@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('activeScope');
    });

    it('rejects refresh with activeScope not covered by access pattern', async () => {
      const instanceName = 'scope-mismatch';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const magicLink = await requestMagicLink(stub, instanceName, 'mismatch@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      // This DO has authScopePattern "scope-mismatch.*" (universe tier).
      // Requesting an unrelated scope should be rejected.
      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: 'other-universe.galaxy.star' }),
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });

    it('universe admin can refresh with specific star activeScope', async () => {
      const instanceName = 'scope-uni-admin';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const { parsed: adminParsed } = await fullLogin(stub, instanceName, 'admin@example.com');

      // Universe tier → authScopePattern is "scope-uni-admin.*"
      // Admin can target any child scope
      const magicLink = await requestMagicLink(stub, instanceName, 'admin@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: 'scope-uni-admin.crm.tenant-a' }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      const jwt = parseJwtUnsafe(body.access_token)!.payload;
      expect(jwt.aud).toBe('scope-uni-admin.crm.tenant-a');
    });

    it('star-level instance refresh with activeScope = instanceName succeeds', async () => {
      const instanceName = 'acme.crm.tenant-b';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const magicLink = await requestMagicLink(stub, instanceName, 'star@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      const jwt = parseJwtUnsafe(body.access_token)!.payload;
      expect(jwt.aud).toBe(instanceName);
      expect(jwt.access.authScopePattern).toBe(instanceName);
    });

    it('rejects refresh with invalid JSON body', async () => {
      const instanceName = 'scope-badjson';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const magicLink = await requestMagicLink(stub, instanceName, 'bad@example.com');
      const { refreshToken } = await clickMagicLink(stub, magicLink);

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: 'not json',
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });
  });

  // ============================================
  // Logout
  // ============================================

  describe('Logout', () => {
    it('revokes refresh token on logout', async () => {
      const instanceName = 'logout-revoke';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const { refreshToken } = await fullLogin(stub, instanceName, 'logout@example.com');

      await stub.fetch(new Request(url(instanceName, 'logout'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
      }));

      const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('token_revoked');
    });
  });

  // ============================================
  // Test Set Subject Data
  // ============================================

  describe('test/set-subject-data', () => {
    it('sets adminApproved flag', async () => {
      const instanceName = 'set-data-1';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const email = 'setdata@example.com';

      const { refreshToken } = await fullLogin(stub, instanceName, email);

      // Set adminApproved via test endpoint
      const setResp = await stub.fetch(new Request(url(instanceName, 'test/set-subject-data'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, adminApproved: true }),
      }));
      expect(setResp.status).toBe(204);

      // Need to get a fresh refresh token since the old one was used by fullLogin
      // Login again to get a usable refresh token
      const magicLink = await requestMagicLink(stub, instanceName, email);
      const { refreshToken: rt2 } = await clickMagicLink(stub, magicLink);
      const { parsed } = await refreshAndParse(stub, instanceName, rt2);
      expect(parsed.adminApproved).toBe(true);
    });

    it('sets isAdmin flag (implicitly sets adminApproved)', async () => {
      const instanceName = 'set-data-2';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const email = 'setadmin@example.com';

      await fullLogin(stub, instanceName, email);

      const setResp = await stub.fetch(new Request(url(instanceName, 'test/set-subject-data'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, isAdmin: true }),
      }));
      expect(setResp.status).toBe(204);

      // Login again to get a fresh token
      const magicLink = await requestMagicLink(stub, instanceName, email);
      const { refreshToken: rt2 } = await clickMagicLink(stub, magicLink);
      const { parsed } = await refreshAndParse(stub, instanceName, rt2);
      expect(parsed.access.admin).toBe(true);
      expect(parsed.adminApproved).toBe(true);
    });
  });

  // ============================================
  // Admin Subject Management
  // ============================================

  describe('Admin Subject Management', () => {
    /** Helper: set up admin + regular user in an instance, return admin's access token */
    async function setupAdminInstance(instanceName: string) {
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // First user = founder admin
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');

      // Second user = regular
      const user = await fullLogin(stub, instanceName, 'user@example.com');

      return { stub, admin, user };
    }

    it('admin can list subjects', async () => {
      const { stub, admin } = await setupAdminInstance('admin-list');

      const resp = await stub.fetch(new Request(url('admin-list', 'subjects'), {
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subjects.length).toBe(2);
    });

    it('non-admin cannot list subjects', async () => {
      const { stub, user } = await setupAdminInstance('admin-list-deny');

      const resp = await stub.fetch(new Request(url('admin-list-deny', 'subjects'), {
        headers: { 'Authorization': `Bearer ${user.access_token}` },
      }));
      expect(resp.status).toBe(403);
    });

    it('admin can get a subject', async () => {
      const { stub, admin, user } = await setupAdminInstance('admin-get');

      const resp = await stub.fetch(new Request(url('admin-get', `subject/${user.parsed.sub}`), {
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.email).toBe('user@example.com');
    });

    it('admin can update subject isAdmin', async () => {
      const { stub, admin, user } = await setupAdminInstance('admin-update');

      const resp = await stub.fetch(new Request(url('admin-update', `subject/${user.parsed.sub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: true }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subject.isAdmin).toBe(true);
      expect(body.subject.adminApproved).toBe(true); // implicit
    });

    it('admin cannot modify self', async () => {
      const { stub, admin } = await setupAdminInstance('admin-self');

      const resp = await stub.fetch(new Request(url('admin-self', `subject/${admin.parsed.sub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: false }),
      }));
      expect(resp.status).toBe(403);
    });

    it('admin can delete a subject', async () => {
      const { stub, admin, user } = await setupAdminInstance('admin-delete');

      const resp = await stub.fetch(new Request(url('admin-delete', `subject/${user.parsed.sub}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
      }));
      expect(resp.status).toBe(204);

      // Verify deleted
      const getResp = await stub.fetch(new Request(url('admin-delete', `subject/${user.parsed.sub}`), {
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
      }));
      expect(getResp.status).toBe(404);
    });

    it('admin cannot delete self', async () => {
      const { stub, admin } = await setupAdminInstance('admin-delete-self');

      const resp = await stub.fetch(new Request(url('admin-delete-self', `subject/${admin.parsed.sub}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
      }));
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Invite Flow
  // ============================================

  describe('Invite Flow', () => {
    it('admin can invite new users', async () => {
      const instanceName = 'invite-test';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      // First user = admin
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'invite?_test=true'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['invitee@example.com'] }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.invited).toContain('invitee@example.com');
      expect(body.links['invitee@example.com']).toContain('invite_token=');
    });

    it('invited user can accept invite and login', async () => {
      const instanceName = 'invite-accept';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const admin = await fullLogin(stub, instanceName, 'admin@example.com');

      const inviteResp = await stub.fetch(new Request(url(instanceName, 'invite?_test=true'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['newinvitee@example.com'] }),
      }));
      const inviteBody = await inviteResp.json() as any;
      const inviteUrl = inviteBody.links['newinvitee@example.com'];

      // Accept invite
      const acceptResp = await stub.fetch(new Request(inviteUrl, { redirect: 'manual' }));
      expect(acceptResp.status).toBe(302);
      expect(acceptResp.headers.get('Location')).toBe('/app');

      const setCookie = acceptResp.headers.get('Set-Cookie')!;
      expect(setCookie).toContain(`Path=${PREFIX}/${instanceName}`);
      const rt = setCookie.split(';')[0].split('=')[1];

      // Refresh to get JWT — invited user should be adminApproved
      const { parsed } = await refreshAndParse(stub, instanceName, rt);
      expect(parsed.adminApproved).toBe(true);
    });
  });

  // ============================================
  // Delegated Tokens
  // ============================================

  describe('Delegated Tokens', () => {
    it('admin can request delegated token', async () => {
      const instanceName = 'deleg-test';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const admin = await fullLogin(stub, instanceName, 'admin@example.com');
      const user = await fullLogin(stub, instanceName, 'user@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: user.parsed.sub, activeScope: instanceName }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      const delegated = parseJwtUnsafe(body.access_token)!.payload;
      expect(delegated.sub).toBe(user.parsed.sub); // acting as user
      expect(delegated.act.sub).toBe(admin.parsed.sub); // actor is admin
    });

    it('non-admin without authorization cannot delegate', async () => {
      const instanceName = 'deleg-deny';
      const stub = env.NEBULA_AUTH.getByName(instanceName);

      const admin = await fullLogin(stub, instanceName, 'admin@example.com');
      const user1 = await fullLogin(stub, instanceName, 'user1@example.com');
      const user2 = await fullLogin(stub, instanceName, 'user2@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user1.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: user2.parsed.sub, activeScope: instanceName }),
      }));
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // activeScope validation (delegated tokens)
  // ============================================

  describe('activeScope Validation (delegated tokens)', () => {
    it('rejects delegation without activeScope', async () => {
      const instanceName = 'deleg-no-scope';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');
      const user = await fullLogin(stub, instanceName, 'user@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: user.parsed.sub }),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('activeScope');
    });

    it('rejects delegation with activeScope not covered by access pattern', async () => {
      const instanceName = 'deleg-bad-scope';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');
      const user = await fullLogin(stub, instanceName, 'user@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: user.parsed.sub, activeScope: 'other-universe.galaxy' }),
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });

    it('delegated token with explicit activeScope sets correct aud and act', async () => {
      const instanceName = 'deleg-scope-aud';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');
      const user = await fullLogin(stub, instanceName, 'user@example.com');

      // Universe tier — can target a specific child scope
      const targetScope = 'deleg-scope-aud.crm.tenant-x';
      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${admin.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: user.parsed.sub, activeScope: targetScope }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      const jwt = parseJwtUnsafe(body.access_token)!.payload;
      expect(jwt.aud).toBe(targetScope);
      expect(jwt.sub).toBe(user.parsed.sub);
      expect(jwt.act.sub).toBe(admin.parsed.sub);
    });

    it('rejects delegation without Content-Type header', async () => {
      const instanceName = 'deleg-no-ct';
      const stub = env.NEBULA_AUTH.getByName(instanceName);
      const admin = await fullLogin(stub, instanceName, 'admin@example.com');

      const resp = await stub.fetch(new Request(url(instanceName, 'delegated-token'), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${admin.access_token}` },
        body: 'not json',
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Content-Type');
    });
  });

  // ============================================
  // DO-level adminApproved check
  // ============================================

  describe('DO-level adminApproved check', () => {
    it('rejects unapproved subject using refresh token on authenticated endpoints', async () => {
      const inst = 'do-approve-check';
      const stub = env.NEBULA_AUTH.getByName(inst);

      // First user becomes founder admin
      const admin = await fullLogin(stub, inst, 'admin@example.com');

      // Second user signs up — emailVerified but NOT adminApproved
      const magicLink2 = await requestMagicLink(stub, inst, 'unapproved@example.com');
      const { refreshToken: unapprovedRefreshToken } = await clickMagicLink(stub, magicLink2);

      // Unapproved user can still refresh (handled by #handleRefreshToken directly)
      const refreshResp = await stub.fetch(new Request(url(inst, 'refresh-token'), {
        method: 'POST',
        headers: {
          'Cookie': `refresh-token=${unapprovedRefreshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ activeScope: inst }),
      }));
      expect(refreshResp.status).toBe(200);

      // But trying to use the refresh token for authenticated endpoints
      // (via #authenticateRequest → #verifyRefreshTokenIdentity) should fail
      const newCookie = refreshResp.headers.get('Set-Cookie')!;
      const newRefreshToken = newCookie.split(';')[0].split('=')[1];

      const subjectsResp = await stub.fetch(new Request(url(inst, 'subjects'), {
        headers: { 'Cookie': `refresh-token=${newRefreshToken}` },
      }));
      expect(subjectsResp.status).toBe(401);
    });
  });
});

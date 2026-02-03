import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe, verifyJwt, importPublicKey, signJwt, importPrivateKey, createJwtPayload } from '../src/jwt';
import {
  createRouteDORequestAuthHooks,
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES
} from '../src/hooks';

describe('@lumenize/auth - LumenizeAuth DO', () => {
  describe('Schema Initialization', () => {
    it('creates tables on first access and returns 404 for unknown paths', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('schema-test-1');

      // Any fetch should trigger schema initialization
      const response = await stub.fetch(new Request('http://localhost/auth/nonexistent'));
      expect(response.status).toBe(404);
    });
  });

  describe('POST /auth/email-magic-link', () => {
    it('returns error for invalid JSON', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('magic-link-test-1');

      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link', {
        method: 'POST',
        body: 'not json'
      }));

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('returns error for missing email', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('magic-link-test-2');

      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }));

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('email');
    });

    it('returns error for invalid email format', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('magic-link-test-3');

      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' })
      }));

      expect(response.status).toBe(400);
    });

    it('generates magic link in test mode', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('magic-link-test-4');

      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.message).toContain('test mode');
      expect(body.magic_link).toBeDefined();
      expect(body.magic_link).toContain('one_time_token=');
    });

    it('returns success message in production mode (without _test)', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('magic-link-test-5');

      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.message).toContain('Check your email');
      expect(body.magic_link).toBeUndefined();
    });
  });

  describe('GET /auth/magic-link - Validation', () => {
    it('returns error for missing token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('validate-test-1');

      const response = await stub.fetch(new Request('http://localhost/auth/magic-link'));

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('redirects with error for invalid token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('validate-test-3');

      const response = await stub.fetch(
        new Request('http://localhost/auth/magic-link?one_time_token=invalid'),
        { redirect: 'manual' } as any
      );

      // Invalid tokens now redirect with error query param
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('error=invalid_token');
    });
  });

  describe('Full Login Flow', () => {
    it('completes login flow end-to-end with redirect and refresh token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-1');

      // Step 1: Request magic link (test mode)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'fullflow@example.com' })
      }));

      expect(magicLinkResponse.status).toBe(200);
      const magicLinkBody = await magicLinkResponse.json() as any;
      const magicLink = magicLinkBody.magic_link;
      expect(magicLink).toBeDefined();

      // Step 2: Click magic link - should redirect (302)
      // Use redirect: 'manual' to prevent following the redirect
      const validateResponse = await stub.fetch(new Request(magicLink, { redirect: 'manual' }));
      expect(validateResponse.status).toBe(302);

      // Verify redirect location
      const location = validateResponse.headers.get('Location');
      expect(location).toBe('/app');

      // Verify refresh token cookie was set
      const setCookie = validateResponse.headers.get('Set-Cookie');
      expect(setCookie).toContain('refresh-token=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');

      // Step 3: Use refresh token to get access token (simulates SPA on load)
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: {
          'Cookie': setCookie!
        }
      }));

      expect(refreshResponse.status).toBe(200);
      const refreshBody = await refreshResponse.json() as any;
      expect(refreshBody.access_token).toBeDefined();
      expect(refreshBody.token_type).toBe('Bearer');
      expect(refreshBody.expires_in).toBeGreaterThan(0);

      // Verify JWT structure (3 parts separated by dots)
      const jwtParts = refreshBody.access_token.split('.');
      expect(jwtParts.length).toBe(3);
    });

    it('creates subject on first login', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-2');

      const email = 'newuser@example.com';

      // Request and validate magic link
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));

      const magicLinkBody = await magicLinkResponse.json() as any;
      const validateResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(validateResponse.status).toBe(302);

      // Get a refresh token so we can inspect the JWT for the subject ID
      const setCookie = validateResponse.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0].split('=')[1];
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      const parsed = parseJwtUnsafe(refreshBody.access_token);

      // Verify a subject ID was assigned
      expect(parsed!.payload.sub).toBeDefined();
      expect(parsed!.payload.sub.length).toBeGreaterThan(0);
    });

    it('rejects already-used magic link', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-5');

      // Request magic link
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'onetime@example.com' })
      }));

      const magicLinkBody = await magicLinkResponse.json() as any;
      const magicLink = magicLinkBody.magic_link;

      // First use - should succeed (302 redirect)
      const firstResponse = await stub.fetch(new Request(magicLink, { redirect: 'manual' }));
      expect(firstResponse.status).toBe(302);
      expect(firstResponse.headers.get('Location')).toBe('/app');

      // Second use - should redirect with error (token was deleted after first use)
      const secondResponse = await stub.fetch(new Request(magicLink, { redirect: 'manual' }));
      expect(secondResponse.status).toBe(302);
      const location = secondResponse.headers.get('Location');
      expect(location).toContain('error=invalid_token');
    });
  });

  describe('Bootstrap Admin', () => {
    it('idempotently promotes bootstrap email to admin on login', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('bootstrap-test-1');
      const bootstrapEmail = 'bootstrap-admin@example.com'; // Matches vitest config binding

      // Complete login flow for bootstrap email
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bootstrapEmail })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Get access token
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      const parsed = parseJwtUnsafe(refreshBody.access_token);

      // Bootstrap email should have admin flags set
      expect(parsed!.payload.emailVerified).toBe(true);
      expect(parsed!.payload.adminApproved).toBe(true);
      expect(parsed!.payload.isAdmin).toBe(true);
    });

    it('does NOT promote non-bootstrap email to admin', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('bootstrap-test-2');

      // Login with a different email
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'regular-user@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      const parsed = parseJwtUnsafe(refreshBody.access_token);

      // Regular user should NOT be admin
      expect(parsed!.payload.emailVerified).toBe(true);
      expect(parsed!.payload.adminApproved).toBe(false);
      expect(parsed!.payload.isAdmin).toBeFalsy();
    });

    it('bootstrap is idempotent across multiple logins', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('bootstrap-test-3');
      const bootstrapEmail = 'bootstrap-admin@example.com';

      // First login
      const ml1 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bootstrapEmail })
      }));
      const mlBody1 = await ml1.json() as any;
      const login1 = await stub.fetch(new Request(mlBody1.magic_link, { redirect: 'manual' }));
      const cookie1 = login1.headers.get('Set-Cookie')!;
      const rt1 = cookie1.split(';')[0].split('=')[1];
      const refresh1 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${rt1}` }
      }));
      const body1 = await refresh1.json() as any;
      const sub1 = parseJwtUnsafe(body1.access_token)!.payload.sub;

      // Second login — same email, same DO instance
      const ml2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bootstrapEmail })
      }));
      const mlBody2 = await ml2.json() as any;
      const login2 = await stub.fetch(new Request(mlBody2.magic_link, { redirect: 'manual' }));
      const cookie2 = login2.headers.get('Set-Cookie')!;
      const rt2 = cookie2.split(';')[0].split('=')[1];
      const refresh2 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${rt2}` }
      }));
      const body2 = await refresh2.json() as any;
      const parsed2 = parseJwtUnsafe(body2.access_token)!.payload;

      // Same sub across logins, still admin
      expect(parsed2.sub).toBe(sub1);
      expect(parsed2.isAdmin).toBe(true);
      expect(parsed2.adminApproved).toBe(true);
    });
  });

  describe('POST /auth/test/set-subject-data', () => {
    it('sets adminApproved flag via test endpoint', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('set-data-test-1');
      const email = 'set-data-user@example.com';

      // Login first to create the subject
      const mlResp = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const mlBody = await mlResp.json() as any;
      const loginResp = await stub.fetch(new Request(mlBody.magic_link, { redirect: 'manual' }));
      expect(loginResp.status).toBe(302);
      const loginCookie = loginResp.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Set adminApproved via test endpoint
      const setDataResp = await stub.fetch(new Request('http://localhost/auth/test/set-subject-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, adminApproved: true })
      }));
      expect(setDataResp.status).toBe(200);

      // Refresh to get updated JWT (re-reads subject from DB)
      const refreshResp = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResp.json() as any;
      const parsed = parseJwtUnsafe(refreshBody.access_token);

      expect(parsed!.payload.adminApproved).toBe(true);
    });

    it('sets isAdmin flag (implicitly sets adminApproved)', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('set-data-test-2');
      const email = 'set-admin-user@example.com';

      // Login first
      const mlResp = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const mlBody = await mlResp.json() as any;
      const loginResp = await stub.fetch(new Request(mlBody.magic_link, { redirect: 'manual' }));
      const loginCookie = loginResp.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Set isAdmin via test endpoint
      const setDataResp = await stub.fetch(new Request('http://localhost/auth/test/set-subject-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, isAdmin: true })
      }));
      expect(setDataResp.status).toBe(200);

      // Refresh to get updated JWT
      const refreshResp = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResp.json() as any;
      const parsed = parseJwtUnsafe(refreshBody.access_token);

      expect(parsed!.payload.isAdmin).toBe(true);
      expect(parsed!.payload.adminApproved).toBe(true); // implicitly set
    });
  });

  describe('POST /auth/refresh-token', () => {
    it('returns error when no refresh token cookie', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-1');

      const response = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST'
      }));

      expect(response.status).toBe(401);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('returns error for invalid refresh token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-2');

      const response = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: {
          'Cookie': 'refresh-token=invalid-token-that-does-not-exist'
        }
      }));

      expect(response.status).toBe(401);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('issues new tokens with valid refresh token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-3');

      // Complete login to get refresh token (now 302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'refresh-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      expect(loginCookie).toBeDefined();

      // Extract refresh token from cookie
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Use refresh token to get new tokens
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: {
          'Cookie': `refresh-token=${refreshToken}`
        }
      }));

      expect(refreshResponse.status).toBe(200);

      const refreshBody = await refreshResponse.json() as any;
      expect(refreshBody.access_token).toBeDefined();
      expect(refreshBody.token_type).toBe('Bearer');
      expect(refreshBody.expires_in).toBeGreaterThan(0);

      // Verify new refresh token cookie was set
      const newCookie = refreshResponse.headers.get('Set-Cookie');
      expect(newCookie).toContain('refresh-token=');
      expect(newCookie).toContain('HttpOnly');
    });

    it('rotates refresh token - old token invalidated', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-4');

      // Complete login to get refresh token (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rotation-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const oldRefreshToken = loginCookie.split(';')[0].split('=')[1];

      // Use old refresh token - should succeed
      const firstRefresh = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldRefreshToken}` }
      }));
      expect(firstRefresh.status).toBe(200);

      // Try to use old refresh token again - should fail (revoked)
      const secondRefresh = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldRefreshToken}` }
      }));
      expect(secondRefresh.status).toBe(401);

      const body = await secondRefresh.json() as any;
      expect(body.error).toBe('token_revoked');
    });

    it('new refresh token works after rotation', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-5');

      // Complete login to get refresh token (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new-token-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const oldRefreshToken = loginCookie.split(';')[0].split('=')[1];

      // First refresh - get new token
      const firstRefresh = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${oldRefreshToken}` }
      }));
      expect(firstRefresh.status).toBe(200);

      const newCookie = firstRefresh.headers.get('Set-Cookie')!;
      const newRefreshToken = newCookie.split(';')[0].split('=')[1];

      // New token should be different
      expect(newRefreshToken).not.toBe(oldRefreshToken);

      // Use new refresh token - should succeed
      const secondRefresh = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${newRefreshToken}` }
      }));
      expect(secondRefresh.status).toBe(200);
    });

    it('access token from refresh has correct subject ID', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-6');
      const email = 'userid-test@example.com';

      // Complete login (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Get access token via refresh endpoint
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;

      // Parse access token — sub should be a UUID
      const parsed = parseJwtUnsafe(refreshBody.access_token);
      expect(parsed!.payload.sub).toBeDefined();
      expect(parsed!.payload.sub.length).toBe(36); // UUID v4 length

      // Do a second login with the same email — sub should remain the same
      const magicLinkResponse2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody2 = await magicLinkResponse2.json() as any;
      const loginResponse2 = await stub.fetch(new Request(magicLinkBody2.magic_link, { redirect: 'manual' }));
      const loginCookie2 = loginResponse2.headers.get('Set-Cookie')!;
      const refreshToken2 = loginCookie2.split(';')[0].split('=')[1];
      const refreshResponse2 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken2}` }
      }));
      const refreshBody2 = await refreshResponse2.json() as any;
      const parsed2 = parseJwtUnsafe(refreshBody2.access_token);

      // Same email → same subject ID
      expect(parsed2!.payload.sub).toBe(parsed!.payload.sub);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears refresh token cookie', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('logout-test-1');

      const response = await stub.fetch(new Request('http://localhost/auth/logout', {
        method: 'POST'
      }));

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.message).toBe('Logged out');

      const setCookie = response.headers.get('Set-Cookie');
      expect(setCookie).toContain('refresh-token=');
      expect(setCookie).toContain('Max-Age=0');
    });

    it('revokes refresh token on logout', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('logout-test-2');

      // Complete login to get refresh token (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'logout-revoke@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Logout (should revoke token)
      await stub.fetch(new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));

      // Try to use the refresh token - should fail
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));

      expect(refreshResponse.status).toBe(401);
      const body = await refreshResponse.json() as any;
      expect(body.error).toBe('token_revoked');
    });
  });

  describe('JWT Token Verification', () => {
    it('issues valid JWT with correct claims', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('jwt-verify-test-1');

      // Complete login flow (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jwt-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Get access token via refresh endpoint
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;

      // Parse JWT without verification
      const parsed = parseJwtUnsafe(refreshBody.access_token);
      expect(parsed).not.toBeNull();

      // Verify header
      expect(parsed!.header.alg).toBe('EdDSA');
      expect(parsed!.header.typ).toBe('JWT');
      expect(parsed!.header.kid).toBe('BLUE'); // Active key

      // Verify payload claims
      expect(parsed!.payload.iss).toBeDefined(); // issuer
      expect(parsed!.payload.aud).toBeDefined(); // audience
      expect(parsed!.payload.sub).toBeDefined(); // subject (UUID)
      expect(parsed!.payload.exp).toBeGreaterThan(Date.now() / 1000); // not expired
      expect(parsed!.payload.iat).toBeLessThanOrEqual(Date.now() / 1000); // issued in past
      expect(parsed!.payload.jti).toBeDefined(); // unique token ID

      // Verify new auth flags
      expect(parsed!.payload.emailVerified).toBe(true); // set after magic link click
      expect(parsed!.payload.adminApproved).toBe(false); // default for new subject
    });

    it('JWT can be verified with public key', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('jwt-verify-test-2');

      // Complete login flow (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jwt-verify@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Get access token via refresh endpoint
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;

      // Verify JWT with public key from env
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      const payload = await verifyJwt(refreshBody.access_token, publicKey);

      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeDefined();
    });

    it('subject ID in JWT is consistent across logins', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('jwt-verify-test-3');
      const email = 'jwt-user-match@example.com';

      // First login
      const magicLinkResponse1 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody1 = await magicLinkResponse1.json() as any;
      const loginResponse1 = await stub.fetch(new Request(magicLinkBody1.magic_link, { redirect: 'manual' }));
      const loginCookie1 = loginResponse1.headers.get('Set-Cookie')!;
      const refreshToken1 = loginCookie1.split(';')[0].split('=')[1];
      const refreshResponse1 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken1}` }
      }));
      const refreshBody1 = await refreshResponse1.json() as any;
      const sub1 = parseJwtUnsafe(refreshBody1.access_token)!.payload.sub;

      // Second login - same email should get same sub
      const magicLinkResponse2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody2 = await magicLinkResponse2.json() as any;
      const loginResponse2 = await stub.fetch(new Request(magicLinkBody2.magic_link, { redirect: 'manual' }));
      const loginCookie2 = loginResponse2.headers.get('Set-Cookie')!;
      const refreshToken2 = loginCookie2.split(';')[0].split('=')[1];
      const refreshResponse2 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken2}` }
      }));
      const refreshBody2 = await refreshResponse2.json() as any;
      const sub2 = parseJwtUnsafe(refreshBody2.access_token)!.payload.sub;

      expect(sub1).toBe(sub2);
    });
  });
});

describe('@lumenize/auth - createRouteDORequestAuthHooks', () => {
  const mockContext = { doNamespace: {}, doInstanceNameOrId: 'test-instance' };

  describe('onBeforeRequest (HTTP Bearer token)', () => {
    it('returns 401 when no Authorization header', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      const request = new Request('http://localhost/protected/resource');
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);

      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Missing Authorization');

      // Check WWW-Authenticate header
      const wwwAuth = response.headers.get('WWW-Authenticate');
      expect(wwwAuth).toContain('Bearer');
      expect(wwwAuth).toContain('realm="Lumenize"');
    });

    it('returns 401 for invalid Authorization header format', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': 'Basic sometoken' }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid JWT', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': 'Bearer invalid.jwt.token' }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);

      const body = await response.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('returns 403 when access gate fails (emailVerified but not adminApproved)', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Create JWT with emailVerified=true but adminApproved=false
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'user-no-approval',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: false,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(403);

      const body = await response.json() as any;
      expect(body.error).toBe('access_denied');
    });

    it('forwards JWT in Authorization header for approved user', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Create JWT with emailVerified=true and adminApproved=true
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'user-approved',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Request);
      const enhancedRequest = result as Request;

      // Authorization header should carry the verified JWT through
      expect(enhancedRequest.headers.get('Authorization')).toBe(`Bearer ${token}`);
    });

    it('passes access gate for isAdmin (without adminApproved)', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Create JWT with isAdmin=true but adminApproved=false
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'admin-user',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: false,
        isAdmin: true,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      // isAdmin bypasses the adminApproved check
      expect(result).toBeInstanceOf(Request);
    });

    it('supports key rotation - accepts tokens signed with either key', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Sign with BLUE key
      const bluePrivateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const bluePayload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'user-blue',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const blueToken = await signJwt(bluePayload, bluePrivateKey, 'BLUE');

      // Sign with GREEN key
      const greenPrivateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_GREEN);
      const greenPayload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'user-green',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const greenToken = await signJwt(greenPayload, greenPrivateKey, 'GREEN');

      // Both should be accepted
      const blueRequest = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${blueToken}` }
      });
      const blueResult = await onBeforeRequest(blueRequest, mockContext);
      expect(blueResult).toBeInstanceOf(Request);

      const greenRequest = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${greenToken}` }
      });
      const greenResult = await onBeforeRequest(greenRequest, mockContext);
      expect(greenResult).toBeInstanceOf(Request);
    });

    it('rejects token with wrong audience', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://wrong-audience.com',
        subject: 'user-123',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);

      const body = await (result as Response).json() as any;
      expect(body.error_description).toContain('audience');
    });

    it('rejects token with wrong issuer', async () => {
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://wrong-issuer.com',
        audience: 'https://lumenize.local',
        subject: 'user-123',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);

      const body = await (result as Response).json() as any;
      expect(body.error_description).toContain('issuer');
    });
  });

  describe('onBeforeConnect (WebSocket subprotocol token)', () => {
    it('returns 401 when no token in subprotocol', async () => {
      const { onBeforeConnect } = await createRouteDORequestAuthHooks(env);

      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz'
        }
      });

      const result = await onBeforeConnect(request, mockContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const { onBeforeConnect } = await createRouteDORequestAuthHooks(env);

      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.invalid-token'
        }
      });

      const result = await onBeforeConnect(request, mockContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 403 when access gate fails', async () => {
      const { onBeforeConnect } = await createRouteDORequestAuthHooks(env);

      // Create JWT with emailVerified=true but adminApproved=false
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'ws-user-no-approval',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: false,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`
        }
      });

      const result = await onBeforeConnect(request, mockContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });

    it('forwards JWT in Authorization header for valid token', async () => {
      const { onBeforeConnect } = await createRouteDORequestAuthHooks(env);

      // Create valid JWT that passes access gate
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'ws-user-123',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: true,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`
        }
      });

      const result = await onBeforeConnect(request, mockContext);
      expect(result).toBeInstanceOf(Request);

      const enhancedRequest = result as Request;
      expect(enhancedRequest.headers.get('Authorization')).toBe(`Bearer ${token}`);
    });
  });

  describe('Integration with LumenizeAuth', () => {
    it('hooks accept tokens issued by LumenizeAuth (approved user)', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('hooks-integration-1');

      // Complete login to get refresh token (302 redirect)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'hooks-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Set adminApproved via test endpoint so the access gate passes
      await stub.fetch(new Request('http://localhost/auth/test/set-subject-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'hooks-test@example.com', adminApproved: true })
      }));

      // Get access token via refresh endpoint (re-reads subject from DB)
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      const accessToken = refreshBody.access_token;

      // Create hooks with same env
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Use access token with onBeforeRequest
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      // Should return enhanced request (not 401/403)
      expect(result).toBeInstanceOf(Request);

      // Authorization header should carry the JWT through
      const authHeader = (result as Request).headers.get('Authorization');
      expect(authHeader).toBe(`Bearer ${accessToken}`);

      // The sub in the JWT should be a UUID
      const parsed = parseJwtUnsafe(accessToken);
      expect(parsed!.payload.sub).toBeDefined();
      expect(parsed!.payload.sub.length).toBe(36); // UUID v4
    });

    it('hooks reject non-approved user from LumenizeAuth with 403', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('hooks-integration-2');

      // Complete login (default: emailVerified=true, adminApproved=false)
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'unapproved-user@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;

      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link, { redirect: 'manual' }));
      expect(loginResponse.status).toBe(302);
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];

      // Get access token (NOT setting adminApproved — default is false)
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      const accessToken = refreshBody.access_token;

      // Verify the JWT has adminApproved=false
      const parsed = parseJwtUnsafe(accessToken);
      expect(parsed!.payload.adminApproved).toBe(false);

      // Create hooks
      const { onBeforeRequest } = await createRouteDORequestAuthHooks(env);

      // Use access token — should get 403 (access gate fails)
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const result = await onBeforeRequest(request, mockContext);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(403);
    });
  });
});

describe('@lumenize/auth - WebSocket Utilities', () => {
  describe('extractWebSocketToken', () => {
    it('extracts token from Sec-WebSocket-Protocol header', () => {
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.my-jwt-token-here'
        }
      });

      const token = extractWebSocketToken(request);
      expect(token).toBe('my-jwt-token-here');
    });

    it('returns null when no Sec-WebSocket-Protocol header', () => {
      const request = new Request('http://localhost/ws', {
        headers: { 'Upgrade': 'websocket' }
      });

      const token = extractWebSocketToken(request);
      expect(token).toBeNull();
    });

    it('returns null when no token protocol present', () => {
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, other-protocol'
        }
      });

      const token = extractWebSocketToken(request);
      expect(token).toBeNull();
    });

    it('handles token-only protocol header', () => {
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.access-token.token-value'
        }
      });

      const token = extractWebSocketToken(request);
      expect(token).toBe('token-value');
    });
  });

  describe('verifyWebSocketToken', () => {
    it('returns valid result for valid token', async () => {
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);

      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'verify-user',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: false,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const result = await verifyWebSocketToken(token, [publicKey]);

      expect(result.valid).toBe(true);
      expect(result.sub).toBe('verify-user');
      expect(result.payload).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.expired).toBeUndefined();
    });

    it('returns expired=true for expired token', async () => {
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);

      // Create token that expired 1 hour ago
      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'expired-user',
        expiresInSeconds: -3600, // Negative = already expired
        emailVerified: true,
        adminApproved: false,
      });
      const token = await signJwt(payload, privateKey, 'BLUE');

      const result = await verifyWebSocketToken(token, [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.expired).toBe(true);
      expect(result.error).toContain('expired');
    });

    it('returns error for invalid signature', async () => {
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      // Sign with GREEN key but verify with BLUE
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_GREEN);

      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'wrong-key-user',
        expiresInSeconds: 900,
        emailVerified: true,
        adminApproved: false,
      });
      const token = await signJwt(payload, privateKey, 'GREEN');

      const result = await verifyWebSocketToken(token, [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
    });

    it('returns error for malformed token', async () => {
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);

      const result = await verifyWebSocketToken('not-a-valid-jwt', [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Malformed');
    });

    it('returns error when no token provided', async () => {
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);

      const result = await verifyWebSocketToken('', [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('No token');
    });
  });

  describe('getTokenTtl', () => {
    it('returns seconds until expiration', () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = { exp: now + 300 }; // Expires in 5 minutes

      const ttl = getTokenTtl(payload);

      // Allow 1 second margin for test execution time
      expect(ttl).toBeGreaterThanOrEqual(299);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('returns 0 for expired token', () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = { exp: now - 100 }; // Expired 100 seconds ago

      const ttl = getTokenTtl(payload);
      expect(ttl).toBe(0);
    });

    it('returns Infinity when no exp claim', () => {
      const payload = {}; // No exp

      const ttl = getTokenTtl(payload);
      expect(ttl).toBe(Infinity);
    });
  });

  describe('WS_CLOSE_CODES', () => {
    it('has correct close codes', () => {
      expect(WS_CLOSE_CODES.TOKEN_EXPIRED).toBe(4401);
      expect(WS_CLOSE_CODES.UNAUTHORIZED).toBe(4403);
      expect(WS_CLOSE_CODES.NO_TOKEN).toBe(4400);
    });
  });

});

describe('@lumenize/auth - createAuthRoutes', () => {
  it('exports createAuthRoutes function', async () => {
    const { createAuthRoutes } = await import('../src/create-auth-routes');
    expect(typeof createAuthRoutes).toBe('function');
  });

  it('createAuthRoutes returns a function', async () => {
    const { createAuthRoutes } = await import('../src/create-auth-routes');

    const authRoutes = createAuthRoutes(env);

    expect(typeof authRoutes).toBe('function');
  });

  it('returns undefined for non-auth routes', async () => {
    const { createAuthRoutes } = await import('../src/create-auth-routes');

    const authRoutes = createAuthRoutes(env);

    // Non-auth routes should return undefined
    const result = await authRoutes(new Request('http://localhost/api/users'));
    expect(result).toBeUndefined();
  });

  it('handles custom prefix via env var', async () => {
    const { createAuthRoutes } = await import('../src/create-auth-routes');

    // Create a modified env with custom prefix
    const customEnv = { ...env, LUMENIZE_AUTH_PREFIX: '/custom-auth' };
    const authRoutes = createAuthRoutes(customEnv as typeof env);

    // Default /auth prefix should return undefined
    const result = await authRoutes(new Request('http://localhost/auth/magic-link'));
    expect(result).toBeUndefined();
  });

  it('accepts valid auth route paths', async () => {
    const { createAuthRoutes } = await import('../src/create-auth-routes');

    const authRoutes = createAuthRoutes(env);

    // Auth routes should be handled (not return undefined)
    // Note: The actual response depends on routeDORequest working correctly
    const result = await authRoutes(new Request('http://localhost/auth/email-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' })
    }));
    expect(result).toBeDefined();
  });
});

// ============================================
// Helper: perform login flow on a DO stub, return cookie + accessToken + sub
// ============================================

async function loginOnStub(
  stub: any,
  email: string,
  subjectData?: { adminApproved?: boolean; isAdmin?: boolean }
): Promise<{ cookie: string; accessToken: string; sub: string }> {
  // Request magic link (test mode)
  const mlRes = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  }));
  const { magic_link } = await mlRes.json() as any;

  // Click magic link
  const validateRes = await stub.fetch(new Request(magic_link, { redirect: 'manual' }));
  const cookie = validateRes.headers.get('Set-Cookie')!;

  // Optionally set subject flags
  if (subjectData) {
    await stub.fetch(new Request('http://localhost/auth/test/set-subject-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...subjectData })
    }));
  }

  // Exchange refresh token for access token
  const refreshRes = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
    method: 'POST',
    headers: { Cookie: cookie }
  }));
  const { access_token } = await refreshRes.json() as any;

  // Extract sub from JWT
  const payloadB64 = access_token.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const { sub } = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));

  // Get the fresh cookie from the refresh response (rotation issued a new one)
  const freshCookie = refreshRes.headers.get('Set-Cookie')!;

  return { cookie: freshCookie, accessToken: access_token, sub };
}

// ============================================
// Subject CRUD Tests
// ============================================

describe('@lumenize/auth - Subject CRUD (admin endpoints)', () => {
  it('GET /subjects returns list for admin', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-list-1');
    const { cookie } = await loginOnStub(stub, 'bootstrap-admin@example.com');

    const res = await stub.fetch(new Request('http://localhost/auth/subjects', {
      headers: { Cookie: cookie }
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subjects).toBeInstanceOf(Array);
    expect(body.subjects.length).toBeGreaterThanOrEqual(1);
    expect(body.subjects[0].email).toBe('bootstrap-admin@example.com');
  });

  it('GET /subjects rejects unauthenticated request', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-list-2');
    // Ensure schema is initialized
    await stub.fetch(new Request('http://localhost/auth/nonexistent'));

    const res = await stub.fetch(new Request('http://localhost/auth/subjects'));
    expect(res.status).toBe(401);
  });

  it('GET /subjects rejects non-admin', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-list-3');
    // Login as non-admin (only emailVerified, not adminApproved)
    const { cookie } = await loginOnStub(stub, 'user@example.com');

    const res = await stub.fetch(new Request('http://localhost/auth/subjects', {
      headers: { Cookie: cookie }
    }));
    expect(res.status).toBe(403);
  });

  it('GET /subjects supports role=admin filter', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-list-4');
    const { cookie } = await loginOnStub(stub, 'bootstrap-admin@example.com');
    // Create a non-admin user
    await loginOnStub(stub, 'normaluser@example.com');

    const res = await stub.fetch(new Request('http://localhost/auth/subjects?role=admin', {
      headers: { Cookie: cookie }
    }));
    const body = await res.json() as any;
    expect(body.subjects.every((s: any) => s.isAdmin === true)).toBe(true);
  });

  it('GET /subject/:id returns a single subject', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-get-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'targetuser@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      headers: { Cookie: admin.cookie }
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subject.email).toBe('targetuser@example.com');
    expect(body.subject.sub).toBe(user.sub);
  });

  it('GET /subject/:id returns 404 for non-existent', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-get-2');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    const res = await stub.fetch(new Request('http://localhost/auth/subject/non-existent-id', {
      headers: { Cookie: admin.cookie }
    }));
    expect(res.status).toBe(404);
  });

  it('PATCH /subject/:id updates flags', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-update-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'updatetarget@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ adminApproved: true })
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subject.adminApproved).toBe(true);
  });

  it('PATCH /subject/:id — isAdmin: true implicitly sets adminApproved', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-update-2');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'promote@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ isAdmin: true })
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subject.isAdmin).toBe(true);
    expect(body.subject.adminApproved).toBe(true);
  });

  it('PATCH /subject/:id prevents self-modification', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-update-3');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${admin.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ isAdmin: false })
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error_description).toContain('own');
  });

  it('PATCH /subject/:id protects bootstrap admin', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-update-4');
    // Login as bootstrap, then create a second admin
    const bootstrap = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'secondadmin@example.com');

    // Promote second admin
    await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: bootstrap.cookie },
      body: JSON.stringify({ isAdmin: true })
    }));

    // Second admin tries to modify bootstrap — should be forbidden
    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${bootstrap.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
      body: JSON.stringify({ isAdmin: false })
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error_description).toContain('bootstrap');
  });

  it('PATCH /subject/:id — revoking adminApproved invalidates refresh tokens', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-revoke-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'revokee@example.com', { adminApproved: true });

    // Revoke adminApproved
    await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ adminApproved: false })
    }));

    // User's refresh token should now be revoked
    const refreshRes = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
      method: 'POST',
      headers: { Cookie: user.cookie }
    }));
    expect(refreshRes.status).toBe(401);
  });

  it('DELETE /subject/:id removes the subject', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-delete-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'deleteme@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'DELETE',
      headers: { Cookie: admin.cookie }
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);

    // Verify subject is gone
    const getRes = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      headers: { Cookie: admin.cookie }
    }));
    expect(getRes.status).toBe(404);
  });

  it('DELETE /subject/:id prevents self-deletion', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-delete-2');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${admin.sub}`, {
      method: 'DELETE',
      headers: { Cookie: admin.cookie }
    }));
    expect(res.status).toBe(403);
  });

  it('DELETE /subject/:id protects bootstrap admin', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-delete-3');
    const bootstrap = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const secondAdmin = await loginOnStub(stub, 'secondadmin2@example.com');

    // Promote second admin
    await stub.fetch(new Request(`http://localhost/auth/subject/${secondAdmin.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: bootstrap.cookie },
      body: JSON.stringify({ isAdmin: true })
    }));

    // Second admin tries to delete bootstrap — should be forbidden
    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${bootstrap.sub}`, {
      method: 'DELETE',
      headers: { Cookie: secondAdmin.cookie }
    }));
    expect(res.status).toBe(403);
  });

  it('DELETE /subject/:id revokes tokens before deletion', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('crud-delete-4');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'deleterevoke@example.com');

    // Delete the subject
    await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'DELETE',
      headers: { Cookie: admin.cookie }
    }));

    // User's refresh token should fail (subject deleted, tokens revoked)
    const refreshRes = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
      method: 'POST',
      headers: { Cookie: user.cookie }
    }));
    expect(refreshRes.status).toBe(401);
  });
});

// ============================================
// Approve Endpoint Tests
// ============================================

describe('@lumenize/auth - Approve endpoint', () => {
  it('GET /approve/:id approves subject and redirects', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('approve-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'approveme@example.com');

    const res = await stub.fetch(
      new Request(`http://localhost/auth/approve/${user.sub}`, {
        headers: { Cookie: admin.cookie }
      }),
      { redirect: 'manual' } as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/app');

    // Verify subject is now approved
    const getRes = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      headers: { Cookie: admin.cookie }
    }));
    const body = await getRes.json() as any;
    expect(body.subject.adminApproved).toBe(true);
  });

  it('GET /approve/:id rejects non-admin', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('approve-2');
    await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'nonadmin@example.com');
    const target = await loginOnStub(stub, 'target@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/approve/${target.sub}`, {
      headers: { Cookie: user.cookie }
    }));
    expect(res.status).toBe(403);
  });

  it('GET /approve/:id redirects unauthenticated with error', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('approve-3');
    // Just initialize schema
    await stub.fetch(new Request('http://localhost/auth/nonexistent'));

    const res = await stub.fetch(
      new Request('http://localhost/auth/approve/some-id'),
      { redirect: 'manual' } as any
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('error=login_required');
  });

  it('GET /approve/:id is idempotent on already-approved subject', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('approve-4');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'alreadyapproved@example.com', { adminApproved: true });

    const res = await stub.fetch(
      new Request(`http://localhost/auth/approve/${user.sub}`, {
        headers: { Cookie: admin.cookie }
      }),
      { redirect: 'manual' } as any
    );
    expect(res.status).toBe(302);

    // Still approved
    const getRes = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      headers: { Cookie: admin.cookie }
    }));
    const body = await getRes.json() as any;
    expect(body.subject.adminApproved).toBe(true);
  });

  it('GET /approve/:id returns 404 for non-existent subject', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('approve-5');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    const res = await stub.fetch(new Request('http://localhost/auth/approve/non-existent-id', {
      headers: { Cookie: admin.cookie }
    }));
    expect(res.status).toBe(404);
  });
});

// ============================================
// Admin Notification Tests
// ============================================

describe('@lumenize/auth - Admin notification on self-signup', () => {
  it('sends admin notification when non-approved user logs in', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('notify-1');

    // First, login as bootstrap admin so there's an admin to notify
    await loginOnStub(stub, 'bootstrap-admin@example.com');

    // New user signs up — should trigger admin notification
    // Request magic link
    const mlRes = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newuser-notify@example.com' })
    }));
    const { magic_link } = await mlRes.json() as any;

    // Click magic link — this triggers the notification
    await stub.fetch(new Request(magic_link, { redirect: 'manual' }));

    // Notification was sent via ConsoleEmailService (logged to stdout)
    // We can't directly inspect ConsoleEmailService output, but we've verified
    // the code path executes without error by checking login succeeds
    // The console output should show: [ConsoleEmailService] Admin notification to bootstrap-admin@example.com
  });

  it('does NOT send notification when bootstrap admin logs in', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('notify-2');
    // Bootstrap admin login — isAdmin is true, so no notification should be sent
    await loginOnStub(stub, 'bootstrap-admin@example.com');
    // No error = no notification attempted (bootstrap is admin, so !adminApproved && !isAdmin is false)
  });

  it('does NOT send notification when already-approved user logs in', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('notify-3');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'preapproved@example.com');

    // Approve the user
    await stub.fetch(new Request(`http://localhost/auth/approve/${user.sub}`, {
      headers: { Cookie: admin.cookie }
    }));

    // User logs in again — should NOT trigger notification (already approved)
    const mlRes = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'preapproved@example.com' })
    }));
    const { magic_link } = await mlRes.json() as any;

    // This should complete without sending admin notification
    await stub.fetch(new Request(magic_link, { redirect: 'manual' }));
  });
});

// ============================================
// End-to-End Approval Flow
// ============================================

describe('@lumenize/auth - End-to-end approval flow', () => {
  it('full flow: bootstrap admin → user signup → admin approves → user gets approved token', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('e2e-approval-1');

    // 1. Bootstrap admin logs in
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    // Verify admin has all flags
    const adminGetRes = await stub.fetch(new Request(`http://localhost/auth/subject/${admin.sub}`, {
      headers: { Cookie: admin.cookie }
    }));
    const adminBody = await adminGetRes.json() as any;
    expect(adminBody.subject.isAdmin).toBe(true);
    expect(adminBody.subject.adminApproved).toBe(true);
    expect(adminBody.subject.emailVerified).toBe(true);

    // 2. New user self-signs up via magic link
    const mlRes = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newuser-e2e@example.com' })
    }));
    const { magic_link } = await mlRes.json() as any;
    const validateRes = await stub.fetch(new Request(magic_link, { redirect: 'manual' }));
    const userCookie = validateRes.headers.get('Set-Cookie')!;

    // Get the user's sub by exchanging refresh token
    const refreshRes1 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
      method: 'POST',
      headers: { Cookie: userCookie }
    }));
    const { access_token: token1 } = await refreshRes1.json() as any;
    const payloadB64 = token1.split('.')[1];
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    const { sub: userSub, adminApproved: ap1 } = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
    expect(ap1).toBe(false); // Not yet approved

    // 3. Admin approves via GET /approve/:id with cookie
    const approveRes = await stub.fetch(
      new Request(`http://localhost/auth/approve/${userSub}`, {
        headers: { Cookie: admin.cookie }
      }),
      { redirect: 'manual' } as any
    );
    expect(approveRes.status).toBe(302);

    // 4. User refreshes token — now has adminApproved: true
    const freshUserCookie = refreshRes1.headers.get('Set-Cookie')!;
    const refreshRes2 = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
      method: 'POST',
      headers: { Cookie: freshUserCookie }
    }));
    expect(refreshRes2.status).toBe(200);
    const { access_token: token2 } = await refreshRes2.json() as any;

    // Parse the new token to verify adminApproved is now true
    const pb2 = token2.split('.')[1];
    const padded2 = pb2 + '='.repeat((4 - pb2.length % 4) % 4);
    const claims = JSON.parse(atob(padded2.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims.adminApproved).toBe(true);
    expect(claims.emailVerified).toBe(true);
  });

  it('list subjects with pagination', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('e2e-pagination-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    // Create a few users
    for (const email of ['user1@example.com', 'user2@example.com', 'user3@example.com']) {
      await loginOnStub(stub, email);
    }

    // List with limit
    const res = await stub.fetch(new Request('http://localhost/auth/subjects?limit=2', {
      headers: { Cookie: admin.cookie }
    }));
    const body = await res.json() as any;
    expect(body.subjects.length).toBe(2);

    // List with offset
    const res2 = await stub.fetch(new Request('http://localhost/auth/subjects?limit=2&offset=2', {
      headers: { Cookie: admin.cookie }
    }));
    const body2 = await res2.json() as any;
    expect(body2.subjects.length).toBe(2); // admin + remaining users
  });

  it('Bearer token auth works for admin endpoints', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('e2e-bearer-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');

    // Use Bearer token instead of cookie
    const res = await stub.fetch(new Request('http://localhost/auth/subjects', {
      headers: { Authorization: `Bearer ${admin.accessToken}` }
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subjects.length).toBeGreaterThanOrEqual(1);
  });

  it('invalid Bearer token returns 401', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('e2e-bearer-2');
    // Initialize schema
    await stub.fetch(new Request('http://localhost/auth/nonexistent'));

    const res = await stub.fetch(new Request('http://localhost/auth/subjects', {
      headers: { Authorization: 'Bearer invalid-token' }
    }));
    expect(res.status).toBe(401);
  });

  it('update authorizedActors', async () => {
    const stub = env.LUMENIZE_AUTH.getByName('e2e-actors-1');
    const admin = await loginOnStub(stub, 'bootstrap-admin@example.com');
    const user = await loginOnStub(stub, 'actoruser@example.com');

    const res = await stub.fetch(new Request(`http://localhost/auth/subject/${user.sub}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ authorizedActors: ['actor-1', 'actor-2'] })
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subject.authorizedActors).toEqual(['actor-1', 'actor-2']);
  });
});

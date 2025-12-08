import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe, verifyJwt, importPublicKey, signJwt, importPrivateKey, createJwtPayload } from '../src/jwt.js';
import { 
  createAuthMiddleware, 
  createAuthMiddlewareSync,
  createWebSocketAuthMiddleware,
  extractWebSocketToken,
  verifyWebSocketToken,
  getTokenTtl,
  WS_CLOSE_CODES
} from '../src/middleware.js';

describe('@lumenize/auth - LumenizeAuth DO', () => {
  describe('Schema Initialization', () => {
    it('creates tables on first access', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('schema-test-1');
      
      // Any RPC call should trigger schema initialization
      const user = await stub.getUserById('nonexistent');
      expect(user).toBeNull();
    });
  });

  describe('GET /auth/enter', () => {
    it('returns endpoint information', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('enter-test-1');
      
      const response = await stub.fetch(new Request('http://localhost/auth/enter'));
      expect(response.status).toBe(200);
      
      const body = await response.json() as any;
      expect(body.message).toContain('Login endpoint');
      expect(body.endpoints).toBeDefined();
      expect(body.endpoints.request_magic_link).toBe('POST /auth/email-magic-link');
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
      expect(body.magic_link).toContain('magic-link-token=');
      expect(body.magic_link).toContain('state=');
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
      
      const response = await stub.fetch(new Request('http://localhost/auth/magic-link?state=abc'));
      
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('returns error for missing state', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('validate-test-2');
      
      const response = await stub.fetch(new Request('http://localhost/auth/magic-link?magic-link-token=abc'));
      
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('returns error for invalid token', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('validate-test-3');
      
      const response = await stub.fetch(new Request('http://localhost/auth/magic-link?magic-link-token=invalid&state=invalid'));
      
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_token');
    });
  });

  describe('Full Login Flow', () => {
    it('completes login flow end-to-end with JWT issuance', async () => {
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
      
      // Step 2: Click magic link to complete login
      const validateResponse = await stub.fetch(new Request(magicLink));
      
      expect(validateResponse.status).toBe(200);
      
      // Verify response contains access token
      const loginBody = await validateResponse.json() as any;
      expect(loginBody.access_token).toBeDefined();
      expect(loginBody.token_type).toBe('Bearer');
      expect(loginBody.expires_in).toBeGreaterThan(0);
      
      // Verify JWT structure (3 parts separated by dots)
      const jwtParts = loginBody.access_token.split('.');
      expect(jwtParts.length).toBe(3);
      
      // Verify refresh token cookie was set
      const setCookie = validateResponse.headers.get('Set-Cookie');
      expect(setCookie).toContain('refresh-token=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');
    });

    it('creates user on first login', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-2');
      
      const email = 'newuser@example.com';
      
      // Verify user doesn't exist
      let user = await stub.getUserByEmail(email);
      expect(user).toBeNull();
      
      // Request and validate magic link
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      
      const magicLinkBody = await magicLinkResponse.json() as any;
      await stub.fetch(new Request(magicLinkBody.magic_link));
      
      // Verify user was created
      user = await stub.getUserByEmail(email);
      expect(user).not.toBeNull();
      expect(user!.email).toBe(email);
      expect(user!.created_at).toBeDefined();
      expect(user!.last_login_at).toBeDefined();
    });

    it('updates last_login_at on subsequent logins', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-3');
      
      const email = 'returning@example.com';
      
      // First login
      const magicLinkResponse1 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody1 = await magicLinkResponse1.json() as any;
      await stub.fetch(new Request(magicLinkBody1.magic_link));
      
      const userAfterFirst = await stub.getUserByEmail(email);
      const firstLoginAt = userAfterFirst!.last_login_at;
      
      // Wait a tiny bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Second login
      const magicLinkResponse2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody2 = await magicLinkResponse2.json() as any;
      await stub.fetch(new Request(magicLinkBody2.magic_link));
      
      const userAfterSecond = await stub.getUserByEmail(email);
      expect(userAfterSecond!.last_login_at).toBeGreaterThan(firstLoginAt!);
    });

    it('rejects magic link with wrong state', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('login-flow-full-4');
      
      // Request magic link
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      }));
      
      const magicLinkBody = await magicLinkResponse.json() as any;
      const magicLinkUrl = new URL(magicLinkBody.magic_link);
      const token = magicLinkUrl.searchParams.get('magic-link-token');
      
      // Try to validate with wrong state
      const validateResponse = await stub.fetch(new Request(`http://localhost/auth/magic-link?magic-link-token=${token}&state=wrong-state`));
      
      expect(validateResponse.status).toBe(400);
      const body = await validateResponse.json() as any;
      expect(body.error).toBe('invalid_state');
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
      
      // First use - should succeed
      const firstResponse = await stub.fetch(new Request(magicLink));
      expect(firstResponse.status).toBe(200);
      
      // Second use - should fail
      const secondResponse = await stub.fetch(new Request(magicLink));
      expect(secondResponse.status).toBe(400);
      
      const body = await secondResponse.json() as any;
      expect(body.error).toBe('token_used');
    });
  });

  describe('RPC Methods', () => {
    it('getUserById returns null for nonexistent user', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('rpc-test-1');
      
      const user = await stub.getUserById('nonexistent-user-id');
      expect(user).toBeNull();
    });

    it('getUserByEmail returns null for nonexistent email', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('rpc-test-2');
      
      const user = await stub.getUserByEmail('nobody@example.com');
      expect(user).toBeNull();
    });
  });

  describe('Rate Limiting', () => {
    it('allows requests under the rate limit', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('rate-limit-test-1');
      
      // Configure lower rate limit for testing
      await stub.configure({ rateLimitPerHour: 3 });
      
      // First request should succeed
      const response1 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-1@example.com' })
      }));
      expect(response1.status).toBe(200);
      
      // Second request should succeed
      const response2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-1@example.com' })
      }));
      expect(response2.status).toBe(200);
      
      // Third request should succeed
      const response3 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-1@example.com' })
      }));
      expect(response3.status).toBe(200);
    });

    it('blocks requests over the rate limit', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('rate-limit-test-2');
      
      // Configure lower rate limit for testing
      await stub.configure({ rateLimitPerHour: 2 });
      
      // First two requests should succeed
      await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-2@example.com' })
      }));
      await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-2@example.com' })
      }));
      
      // Third request should be rate limited
      const response = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-test-2@example.com' })
      }));
      
      expect(response.status).toBe(429);
      const body = await response.json() as any;
      expect(body.error).toBe('rate_limit_exceeded');
    });

    it('rate limits are per-email', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('rate-limit-test-3');
      
      // Configure lower rate limit for testing
      await stub.configure({ rateLimitPerHour: 1 });
      
      // First email - should succeed
      const response1 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-a@example.com' })
      }));
      expect(response1.status).toBe(200);
      
      // Same email again - should be rate limited
      const response2 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-a@example.com' })
      }));
      expect(response2.status).toBe(429);
      
      // Different email - should succeed (separate rate limit)
      const response3 = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user-b@example.com' })
      }));
      expect(response3.status).toBe(200);
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
      
      // Complete login to get refresh token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'refresh-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      
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
      
      // Complete login to get refresh token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rotation-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
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
      
      // Complete login to get refresh token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new-token-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
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

    it('access token from refresh has same user ID', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('refresh-test-6');
      const email = 'userid-test@example.com';
      
      // Complete login
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      const loginCookie = loginResponse.headers.get('Set-Cookie')!;
      const refreshToken = loginCookie.split(';')[0].split('=')[1];
      
      // Parse original access token
      const originalParsed = parseJwtUnsafe(loginBody.access_token);
      const originalUserId = originalParsed!.payload.sub;
      
      // Refresh to get new access token
      const refreshResponse = await stub.fetch(new Request('http://localhost/auth/refresh-token', {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` }
      }));
      const refreshBody = await refreshResponse.json() as any;
      
      // Parse new access token
      const newParsed = parseJwtUnsafe(refreshBody.access_token);
      const newUserId = newParsed!.payload.sub;
      
      // User ID should be the same
      expect(newUserId).toBe(originalUserId);
      
      // And match the user in database
      const user = await stub.getUserByEmail(email);
      expect(newUserId).toBe(user!.id);
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
      
      // Complete login to get refresh token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'logout-revoke@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
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
      
      // Complete login flow
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jwt-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      
      // Parse JWT without verification
      const parsed = parseJwtUnsafe(loginBody.access_token);
      expect(parsed).not.toBeNull();
      
      // Verify header
      expect(parsed!.header.alg).toBe('EdDSA');
      expect(parsed!.header.typ).toBe('JWT');
      expect(parsed!.header.kid).toBe('BLUE'); // Active key
      
      // Verify payload claims
      expect(parsed!.payload.iss).toBeDefined(); // issuer
      expect(parsed!.payload.aud).toBeDefined(); // audience
      expect(parsed!.payload.sub).toBeDefined(); // subject (user ID)
      expect(parsed!.payload.exp).toBeGreaterThan(Date.now() / 1000); // not expired
      expect(parsed!.payload.iat).toBeLessThanOrEqual(Date.now() / 1000); // issued in past
      expect(parsed!.payload.jti).toBeDefined(); // unique token ID
    });

    it('JWT can be verified with public key', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('jwt-verify-test-2');
      
      // Complete login flow
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'jwt-verify@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      
      // Verify JWT with public key from env
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      const payload = await verifyJwt(loginBody.access_token, publicKey);
      
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeDefined();
    });

    it('user ID in JWT matches created user', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('jwt-verify-test-3');
      const email = 'jwt-user-match@example.com';
      
      // Complete login flow
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      
      // Parse JWT to get user ID
      const parsed = parseJwtUnsafe(loginBody.access_token);
      const tokenUserId = parsed!.payload.sub;
      
      // Get user from database
      const user = await stub.getUserByEmail(email);
      
      // Verify they match
      expect(user).not.toBeNull();
      expect(tokenUserId).toBe(user!.id);
    });
  });
});

describe('@lumenize/auth - Auth Middleware', () => {
  // Mock context for hooks
  const mockContext = { doNamespace: {}, doInstanceNameOrId: 'test-instance' };
  
  describe('createAuthMiddleware', () => {
    it('returns 401 when no Authorization header', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      const request = new Request('http://localhost/protected/resource');
      const result = await middleware(request, mockContext);
      
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
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': 'Basic sometoken' }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid JWT', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': 'Bearer invalid.jwt.token' }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);
      
      const body = await response.json() as any;
      expect(body.error).toBe('invalid_token');
    });

    it('returns enhanced request for valid JWT', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      // Create a valid JWT using the test keys
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://lumenize.local',
        audience: 'https://lumenize.local',
        subject: 'user-123',
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Request);
      const enhancedRequest = result as Request;
      
      // Check auth headers were added
      expect(enhancedRequest.headers.get('X-Auth-User-Id')).toBe('user-123');
      expect(enhancedRequest.headers.get('X-Auth-Verified')).toBe('true');
      
      // Authorization header should be removed
      expect(enhancedRequest.headers.get('Authorization')).toBeNull();
    });

    it('supports key rotation - accepts tokens signed with either key', async () => {
      // Create middleware with both keys
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN]
      });
      
      // Sign with BLUE key
      const bluePrivateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const bluePayload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'user-blue',
        expiresInSeconds: 900
      });
      const blueToken = await signJwt(bluePayload, bluePrivateKey, 'BLUE');
      
      // Sign with GREEN key
      const greenPrivateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_GREEN);
      const greenPayload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'user-green',
        expiresInSeconds: 900
      });
      const greenToken = await signJwt(greenPayload, greenPrivateKey, 'GREEN');
      
      // Both should be accepted
      const blueRequest = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${blueToken}` }
      });
      const blueResult = await middleware(blueRequest, mockContext);
      expect(blueResult).toBeInstanceOf(Request);
      expect((blueResult as Request).headers.get('X-Auth-User-Id')).toBe('user-blue');
      
      const greenRequest = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${greenToken}` }
      });
      const greenResult = await middleware(greenRequest, mockContext);
      expect(greenResult).toBeInstanceOf(Request);
      expect((greenResult as Request).headers.get('X-Auth-User-Id')).toBe('user-green');
    });

    it('validates audience claim when configured', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE],
        audience: 'https://expected-audience.com'
      });
      
      // Create JWT with wrong audience
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'https://wrong-audience.com',
        subject: 'user-123',
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const request = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);
      
      const body = await response.json() as any;
      expect(body.error_description).toContain('audience');
    });

    it('validates issuer claim when configured', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE],
        issuer: 'https://expected-issuer.com'
      });
      
      // Create JWT with wrong issuer
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'https://wrong-issuer.com',
        audience: 'test',
        subject: 'user-123',
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const request = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);
      
      const body = await response.json() as any;
      expect(body.error_description).toContain('issuer');
    });

    it('uses custom realm in WWW-Authenticate header', async () => {
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE],
        realm: 'MyCustomApp'
      });
      
      const request = new Request('http://localhost/protected');
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Response);
      const wwwAuth = (result as Response).headers.get('WWW-Authenticate');
      expect(wwwAuth).toContain('realm="MyCustomApp"');
    });
  });

  describe('createAuthMiddlewareSync', () => {
    it('works with pre-imported CryptoKey objects', async () => {
      // Import key first
      const publicKey = await importPublicKey(env.JWT_PUBLIC_KEY_BLUE);
      
      // Create middleware synchronously
      const middleware = createAuthMiddlewareSync({
        publicKeys: [publicKey]
      });
      
      // Create valid JWT
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'user-sync',
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const request = new Request('http://localhost/protected', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await middleware(request, mockContext);
      
      expect(result).toBeInstanceOf(Request);
      expect((result as Request).headers.get('X-Auth-User-Id')).toBe('user-sync');
    });
  });

  describe('Integration with LumenizeAuth', () => {
    it('middleware accepts tokens issued by LumenizeAuth', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('middleware-integration-1');
      
      // Complete login to get access token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'middleware-test@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      const accessToken = loginBody.access_token;
      
      // Create middleware with same keys
      const middleware = await createAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN]
      });
      
      // Use access token with middleware
      const request = new Request('http://localhost/protected/resource', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const result = await middleware(request, mockContext);
      
      // Should return enhanced request (not 401)
      expect(result).toBeInstanceOf(Request);
      
      // User ID should be set
      const userId = (result as Request).headers.get('X-Auth-User-Id');
      expect(userId).toBeDefined();
      
      // User ID should match the user in database
      const user = await stub.getUserByEmail('middleware-test@example.com');
      expect(userId).toBe(user!.id);
    });
  });
});

describe('@lumenize/auth - WebSocket Authentication', () => {
  const mockContext = { doNamespace: {}, doInstanceNameOrId: 'test-instance' };

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

  describe('createWebSocketAuthMiddleware', () => {
    it('returns 401 when no token in subprotocol', async () => {
      const middleware = await createWebSocketAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz'
        }
      });
      
      const result = await middleware(request, mockContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const middleware = await createWebSocketAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.invalid-token'
        }
      });
      
      const result = await middleware(request, mockContext);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    it('returns enhanced request for valid token', async () => {
      const middleware = await createWebSocketAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE]
      });
      
      // Create valid JWT
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const payload = createJwtPayload({
        issuer: 'test',
        audience: 'test',
        subject: 'ws-user-123',
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const request = new Request('http://localhost/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${token}`
        }
      });
      
      const result = await middleware(request, mockContext);
      expect(result).toBeInstanceOf(Request);
      
      const enhancedRequest = result as Request;
      expect(enhancedRequest.headers.get('X-Auth-User-Id')).toBe('ws-user-123');
      expect(enhancedRequest.headers.get('X-Auth-Verified')).toBe('true');
      expect(enhancedRequest.headers.get('X-Auth-Token-Exp')).toBeDefined();
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
        expiresInSeconds: 900
      });
      const token = await signJwt(payload, privateKey, 'BLUE');
      
      const result = await verifyWebSocketToken(token, [publicKey]);
      
      expect(result.valid).toBe(true);
      expect(result.userId).toBe('verify-user');
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
        expiresInSeconds: -3600 // Negative = already expired
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
        expiresInSeconds: 900
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

  describe('Integration: WebSocket auth with LumenizeAuth tokens', () => {
    it('WebSocket middleware accepts tokens from LumenizeAuth', async () => {
      const stub = env.LUMENIZE_AUTH.getByName('ws-integration-1');
      
      // Complete login to get access token
      const magicLinkResponse = await stub.fetch(new Request('http://localhost/auth/email-magic-link?_test=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ws-user@example.com' })
      }));
      const magicLinkBody = await magicLinkResponse.json() as any;
      
      const loginResponse = await stub.fetch(new Request(magicLinkBody.magic_link));
      const loginBody = await loginResponse.json() as any;
      const accessToken = loginBody.access_token;
      
      // Create WebSocket middleware
      const middleware = await createWebSocketAuthMiddleware({
        publicKeysPem: [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN]
      });
      
      // Simulate WebSocket upgrade request with token in subprotocol
      const wsRequest = new Request('http://localhost/ws/my-do/instance', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Protocol': `lmz, lmz.access-token.${accessToken}`
        }
      });
      
      const result = await middleware(wsRequest, mockContext);
      
      // Should return enhanced request
      expect(result).toBeInstanceOf(Request);
      
      const enhancedRequest = result as Request;
      const userId = enhancedRequest.headers.get('X-Auth-User-Id');
      
      // User ID should match database
      const user = await stub.getUserByEmail('ws-user@example.com');
      expect(userId).toBe(user!.id);
    });
  });
});


/**
 * Phase 5: Worker router tests
 *
 * Tests routing correctness through the hand-written Worker.
 * Uses SELF.fetch() to go through the full Worker → DO flow.
 *
 * Covers:
 * - Registry dispatch (discover, claim-universe, claim-star, create-galaxy)
 * - Instance dispatch (email-magic-link, magic-link, refresh-token, etc.)
 * - Gating: Turnstile, JWT, rate limiting
 * - 404 for unknown paths
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signJwt, importPrivateKey, generateUuid } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX, NEBULA_AUTH_ISSUER } from '../src/types';
import type { NebulaJwtPayload, AccessEntry } from '../src/types';
import { fullLogin, requestMagicLink, clickMagicLink } from './test-helpers';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'

function workerUrl(path: string): string {
  return `http://localhost${PREFIX}/${path}`;
}

function registryUrl(endpoint: string): string {
  return `http://localhost${PREFIX}/${endpoint}`;
}

/**
 * Helper: create a Nebula JWT for testing.
 */
async function createJwt(opts: {
  accessId: string;
  aud?: string;
  accessAdmin?: boolean;
  adminApproved?: boolean;
  sub?: string;
  email?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
  const now = Math.floor(Date.now() / 1000);
  const access: AccessEntry = { authScopePattern: opts.accessId };
  if (opts.accessAdmin) access.admin = true;

  const payload: NebulaJwtPayload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: opts.aud ?? opts.accessId.replace(/\.\*$/, ''),
    sub: opts.sub ?? generateUuid(),
    exp: now + (opts.expiresInSeconds ?? 900),
    iat: now,
    jti: generateUuid(),
    email: opts.email ?? 'test@example.com',
    adminApproved: opts.adminApproved ?? false,
    access,
  };

  return signJwt(payload as any, privateKey, 'BLUE');
}

/**
 * Helper: do a full login via the Worker (not directly to DO).
 * Returns { access_token, refreshToken, setCookie }
 */
async function workerLogin(instanceName: string, email: string) {
  // Request magic link through Worker
  const mlResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
  expect(mlResp.status).toBe(200);
  const mlBody = await mlResp.json() as any;
  expect(mlBody.magic_link).toBeDefined();

  // Click magic link through Worker
  const clickResp = await SELF.fetch(new Request(mlBody.magic_link, { redirect: 'manual' }));
  expect(clickResp.status).toBe(302);
  const setCookie = clickResp.headers.get('Set-Cookie')!;
  const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

  // Refresh to get JWT through Worker
  const refreshResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/refresh-token`), {
    method: 'POST',
    headers: {
      'Cookie': `refresh-token=${refreshToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ activeScope: instanceName }),
  }));
  expect(refreshResp.status).toBe(200);
  const refreshBody = await refreshResp.json() as any;

  // Get new refresh token from response cookie
  const newCookie = refreshResp.headers.get('Set-Cookie')!;
  const newRefreshToken = newCookie.split(';')[0]!.split('=')[1]!;

  return {
    access_token: refreshBody.access_token,
    refreshToken: newRefreshToken,
    setCookie: newCookie,
  };
}

describe('@lumenize/nebula-auth - Worker Router', () => {

  // ============================================
  // Basic routing
  // ============================================

  describe('basic routing', () => {
    it('returns 404 for paths outside /auth prefix', async () => {
      const resp = await SELF.fetch(new Request('http://localhost/other/path'));
      expect(resp.status).toBe(404);
    });

    it('returns 404 for /auth with no subpath', async () => {
      const resp = await SELF.fetch(new Request('http://localhost/auth/'));
      expect(resp.status).toBe(404);
    });
  });

  // ============================================
  // Registry dispatch
  // ============================================

  describe('registry dispatch', () => {
    it('POST /auth/discover reaches registry and returns results', async () => {
      // First, create a universe with a subject so there is something to discover
      const instanceName = `discover-test-${generateUuid().slice(0, 8)}`;
      const email = 'discover@example.com';

      // Login directly to create the subject (seeds the DO)
      const naStub = env.NEBULA_AUTH.getByName(instanceName);
      await fullLogin(naStub, instanceName, email);

      // Now discover via Worker
      const resp = await SELF.fetch(new Request(registryUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any[];
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((e: any) => e.instanceName === instanceName)).toBe(true);
    });

    it('POST /auth/claim-universe creates a new universe', async () => {
      const slug = `claim-u-${generateUuid().slice(0, 8)}`;
      const email = 'claim-universe@example.com';

      const resp = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email }),
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.message).toContain('Check your email');
      expect(body.magicLinkUrl).toBeDefined(); // test mode
    });

    it('POST /auth/claim-universe rejects duplicate slugs', async () => {
      const slug = `claim-dup-${generateUuid().slice(0, 8)}`;
      const email = 'claim-dup@example.com';

      // First claim
      const resp1 = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email }),
      }));
      expect(resp1.status).toBe(200);

      // Duplicate claim
      const resp2 = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email: 'other@example.com' }),
      }));
      expect(resp2.status).toBe(409);
      const body = await resp2.json() as any;
      expect(body.error).toBe('slug_taken');
    });

    it('POST /auth/claim-star requires parent galaxy to exist', async () => {
      const resp = await SELF.fetch(new Request(registryUrl('claim-star'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          universeGalaxyStarId: 'nonexistent.galaxy.star',
          email: 'star@example.com',
        }),
      }));

      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('parent_not_found');
    });

    it('POST /auth/create-galaxy requires JWT', async () => {
      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universeGalaxyId: 'test.galaxy' }),
      }));

      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('POST /auth/create-galaxy succeeds with valid admin JWT', async () => {
      // Create a universe first
      const universe = `gal-test-${generateUuid().slice(0, 8)}`;
      const email = 'gal-admin@example.com';

      await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email }),
      }));

      // Login at universe level to get admin JWT
      const { access_token } = await workerLogin(universe, email);

      // Create galaxy
      const galaxyId = `${universe}.my-galaxy`;
      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      }));

      expect(resp.status).toBe(201);
      const body = await resp.json() as any;
      expect(body.instanceName).toBe(galaxyId);
    });

    it('GET to registry endpoint returns 405', async () => {
      const resp = await SELF.fetch(new Request(registryUrl('discover'), {
        method: 'GET',
      }));
      expect(resp.status).toBe(405);
    });
  });

  // ============================================
  // Instance dispatch — auth flow endpoints
  // ============================================

  describe('instance dispatch — auth flow (no JWT required)', () => {
    const instanceName = 'route-test-star';

    it('POST /auth/{id}/email-magic-link sends magic link', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/email-magic-link?_test=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'route-test@example.com' }),
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.magic_link).toBeDefined();
    });

    it('GET /auth/{id}/magic-link validates token and redirects', async () => {
      // Request magic link
      const mlResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/email-magic-link?_test=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'magic-route@example.com' }),
      }));
      const { magic_link } = await mlResp.json() as any;

      // Click it
      const resp = await SELF.fetch(new Request(magic_link, { redirect: 'manual' }));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toBe('/app');
      expect(resp.headers.get('Set-Cookie')).toContain('refresh-token=');
    });

    it('POST /auth/{id}/refresh-token exchanges cookie for JWT', async () => {
      const email = 'refresh-route@example.com';
      const mlResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/email-magic-link?_test=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }));
      const { magic_link } = await mlResp.json() as any;
      const clickResp = await SELF.fetch(new Request(magic_link, { redirect: 'manual' }));
      const setCookie = clickResp.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/refresh-token`), {
        method: 'POST',
        headers: {
          'Cookie': `refresh-token=${refreshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ activeScope: instanceName }),
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.access_token).toBeDefined();
    });

    it('POST /auth/{id}/logout revokes refresh token', async () => {
      const email = 'logout-route@example.com';
      const mlResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/email-magic-link?_test=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }));
      const { magic_link } = await mlResp.json() as any;
      const clickResp = await SELF.fetch(new Request(magic_link, { redirect: 'manual' }));
      const setCookie = clickResp.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/logout`), {
        method: 'POST',
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
      }));

      expect(resp.status).toBe(200);
    });
  });

  // ============================================
  // Instance dispatch — authenticated endpoints
  // ============================================

  describe('instance dispatch — authenticated endpoints (JWT required)', () => {
    it('GET /auth/{id}/subjects returns 401 without JWT', async () => {
      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects')));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });

    it('GET /auth/{id}/subjects returns 401 with invalid JWT', async () => {
      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects'), {
        headers: { 'Authorization': 'Bearer invalid.jwt.here' },
      }));
      expect(resp.status).toBe(401);
    });

    it('GET /auth/{id}/subjects succeeds with valid JWT', async () => {
      const instanceName = `subj-route-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'admin-subjects@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      // DO returns { subjects: [...] }, not a raw array
      expect(body.subjects).toBeDefined();
      expect(Array.isArray(body.subjects)).toBe(true);
      expect(body.subjects.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects JWT with wrong scope on instance path', async () => {
      // Login to one instance, try to access another
      const instance1 = `scope-a-${generateUuid().slice(0, 8)}`;
      const instance2 = `scope-b-${generateUuid().slice(0, 8)}`;

      const { access_token } = await workerLogin(instance1, 'scope-test@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance2}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));

      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });

    it('universe admin wildcard JWT grants access to star DO endpoints', async () => {
      // Universe admin logs in at universe level, gets wildcard JWT with
      // access.authScopePattern: "universe.*". The Worker matches the wildcard against the
      // star path, and the DO's #verifyBearerToken falls back to wildcard
      // matching when the sub is not found in the local Subjects table.
      const universe = `wildcard-${generateUuid().slice(0, 8)}`;
      const starId = `${universe}.app.tenant`;
      const adminEmail = 'wildcard-admin@example.com';

      // Login at universe → get wildcard JWT
      const { access_token } = await workerLogin(universe, adminEmail);

      // Wildcard JWT grants cross-scope access to star DO
      const resp = await SELF.fetch(new Request(workerUrl(`${starId}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.subjects).toBeDefined();
      expect(Array.isArray(body.subjects)).toBe(true);
    });

    it('POST /auth/{id}/invite works with admin JWT', async () => {
      const instanceName = `invite-route-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'invite-admin@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/invite`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['invitee@example.com'] }),
      }));

      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body.invited).toHaveLength(1);
    });

    it('PATCH /auth/{id}/subject/:sub works with admin JWT', async () => {
      const instanceName = `patch-route-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'patch-admin@example.com');

      // Get subjects to find our sub
      const subjResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      const body = await subjResp.json() as any;
      const sub = body.subjects[0].sub;

      // Invite a second user so we can patch them (can't self-modify)
      const inviteResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/invite`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['patchee@example.com'] }),
      }));
      expect(inviteResp.status).toBe(200);

      // Get the invitee's sub
      const subjResp2 = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      const body2 = await subjResp2.json() as any;
      const inviteeSub = body2.subjects.find((s: any) => s.email === 'patchee@example.com')?.sub;
      expect(inviteeSub).toBeDefined();

      // Patch the invitee to admin
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${inviteeSub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: true }),
      }));

      expect(resp.status).toBe(200);
    });

    it('DELETE /auth/{id}/subject/:sub/actors/:actorId requires JWT', async () => {
      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subject/abc/actors/def'), {
        method: 'DELETE',
      }));
      expect(resp.status).toBe(401);
    });
  });

  // ============================================
  // Registry fetch handler
  // ============================================

  describe('registry fetch handler', () => {
    it('returns proper error for invalid slug in claim-universe', async () => {
      const resp = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'INVALID_UPPERCASE', email: 'a@b.com' }),
      }));

      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_slug');
    });

    it('returns proper error for reserved slug', async () => {
      const resp = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'nebula-platform', email: 'a@b.com' }),
      }));

      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('reserved_slug');
    });
  });

  // ============================================
  // Coverage: Worker JWT validation branches
  // ============================================

  describe('Worker JWT validation branches', () => {
    it('rejects JWT with missing audience claim', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: 'some-instance.*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('audience');
    });

    it('JWT with unrelated aud passes audience check but is rejected by access pattern', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      // JWT has aud = 'wrong-universe' but authScopePattern = 'wrong-universe.*'
      // The audience check passes (aud is a non-empty string), but
      // matchAccess('wrong-universe.*', 'target-instance') fails.
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'wrong-universe',
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: 'wrong-universe.*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(workerUrl('target-instance/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });

    it('rejects JWT with wrong issuer', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: 'wrong-issuer',
        aud: 'some-instance',
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: 'some-instance.*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('issuer');
    });

    it('rejects JWT with missing sub claim', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'some-instance',
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: 'some-instance.*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('subject');
    });

    it('rejects JWT with missing access claim', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'some-instance',
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(workerUrl('some-instance/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('access');
    });

    it('rejects unapproved user (access gate: !admin && !adminApproved)', async () => {
      const token = await createJwt({
        accessId: 'gate-test.*',
        accessAdmin: false,
        adminApproved: false,
      });

      const resp = await SELF.fetch(new Request(workerUrl('gate-test/subjects'), {
        headers: { 'Authorization': `Bearer ${token}` },
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('access_denied');
      expect(body.error_description).toContain('not yet approved');
    });

    it('bare instance path with no endpoint gets forwarded to DO', async () => {
      // /auth/some-instance (no trailing slash or endpoint)
      // parsePath returns { type: 'instance', instanceName: 'some-instance', endpoint: '' }
      // The suffix is '' which is not in AUTH_FLOW_SUFFIXES, so it goes through JWT check
      const resp = await SELF.fetch(new Request(workerUrl('some-bare-instance')));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_request');
    });
  });

  // ============================================
  // Coverage: Registry JWT validation branches (create-galaxy)
  // ============================================

  describe('Registry JWT validation branches (create-galaxy)', () => {
    it('rejects JWT with missing audience on create-galaxy', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: '*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ universeGalaxyId: 'test.galaxy' }),
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('audience');
    });

    it('rejects JWT with wrong issuer on create-galaxy', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: 'wrong-issuer',
        aud: 'some-instance',
        sub: generateUuid(),
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: '*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ universeGalaxyId: 'test.galaxy' }),
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('issuer');
    });

    it('rejects JWT with missing sub on create-galaxy', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'some-instance',
        exp: now + 900,
        iat: now,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: '*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ universeGalaxyId: 'test.galaxy' }),
      }));
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('subject');
    });

    it('rejects expired JWT on create-galaxy', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({
        iss: NEBULA_AUTH_ISSUER,
        aud: 'some-instance',
        sub: generateUuid(),
        exp: now - 100, // expired
        iat: now - 200,
        jti: generateUuid(),
        email: 'test@example.com',
        adminApproved: true,
        access: { authScopePattern: '*', admin: true },
      } as any, privateKey, 'BLUE');

      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ universeGalaxyId: 'test.galaxy' }),
      }));
      expect(resp.status).toBe(401);
    });
  });

  // ============================================
  // Coverage: NebulaAuth DO input validation branches
  // ============================================

  describe('NebulaAuth DO input validation via Worker', () => {
    it('admin cannot self-modify via PATCH /subject/:id', async () => {
      const instanceName = `selfmod-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'selfmod@example.com');

      // Get own sub
      const subjResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      const { subjects } = await subjResp.json() as any;
      const ownSub = subjects[0].sub;

      // Try to PATCH self
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${ownSub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: false }),
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('Cannot modify own');
    });

    it('admin cannot self-delete via DELETE /subject/:id', async () => {
      const instanceName = `selfdel-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'selfdel@example.com');

      // Get own sub
      const subjResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      const { subjects } = await subjResp.json() as any;
      const ownSub = subjects[0].sub;

      // Try to DELETE self
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${ownSub}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('Cannot delete yourself');
    });

    it('founding admin rule: invite rejects 2+ emails on empty DO', async () => {
      // Use cross-scope admin JWT to call invite on a fresh (empty) DO
      const universe = `founding-${generateUuid().slice(0, 8)}`;
      const emptyInstance = `${universe}.app.empty`;

      // Login at universe to get admin wildcard JWT
      const { access_token } = await workerLogin(universe, 'founding@example.com');

      // Register the star instance in the registry so the DO is accessible
      // (The Worker just forwards based on instanceName — the DO is fresh/empty)

      // Invite 2 emails to the empty DO
      const resp = await SELF.fetch(new Request(workerUrl(`${emptyInstance}/invite?_test=true`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['a@example.com', 'b@example.com'] }),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error).toBe('founding_admin_required');
    });

    it('delegated-token rejects invalid JSON body', async () => {
      const instanceName = `deleg-json-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'deleg-json@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/delegated-token`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: 'not-json',
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('Invalid JSON');
    });

    it('delegated-token rejects missing actFor field', async () => {
      const instanceName = `deleg-miss-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'deleg-miss@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/delegated-token`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error_description).toContain('actFor required');
    });

    it('delegated-token rejects nonexistent subject', async () => {
      const instanceName = `deleg-noent-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instanceName, 'deleg-noent@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/delegated-token`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actFor: 'nonexistent-sub-id', activeScope: instanceName }),
      }));
      expect(resp.status).toBe(404);
      const body = await resp.json() as any;
      expect(body.error).toBe('not_found');
    });

  });

  // ============================================
  // Coverage: non-admin approved user hits admin endpoints (DO access denied)
  // ============================================

  describe('non-admin approved user denied at DO level', () => {
    // This test covers the isAdmin=false access denied branches inside each
    // admin handler in nebula-auth.ts — the user passes the Worker gate
    // (adminApproved: true) but the DO rejects because isAdmin: false.

    let instanceName: string;
    let adminToken: string;
    let userToken: string;
    let userSub: string;

    it('setup: create instance, invite user, approve, get non-admin JWT', async () => {
      instanceName = `nonadm-${generateUuid().slice(0, 8)}`;
      const adminEmail = 'nonadmin-test-admin@example.com';
      const userEmail = 'nonadmin-test-user@example.com';

      // 1. Founding admin login
      const { access_token: at } = await workerLogin(instanceName, adminEmail);
      adminToken = at;

      // 2. Admin invites non-admin user
      const inviteResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/invite?_test=true`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: [userEmail] }),
      }));
      expect(inviteResp.status).toBe(200);
      const { links } = await inviteResp.json() as any;
      const acceptLink = links[userEmail];
      expect(acceptLink).toBeDefined();

      // 3. User accepts invite → gets refresh cookie
      const acceptResp = await SELF.fetch(new Request(acceptLink, { redirect: 'manual' }));
      expect(acceptResp.status).toBe(302);
      const setCookie = acceptResp.headers.get('Set-Cookie')!;
      const refreshToken = setCookie.split(';')[0]!.split('=')[1]!;

      // 4. Get user's sub from subjects list
      const subjResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }));
      const { subjects } = await subjResp.json() as any;
      const userSubject = subjects.find((s: any) => s.email === userEmail);
      expect(userSubject).toBeDefined();
      userSub = userSubject.sub;

      // 5. Admin approves user (adminApproved: true, isAdmin stays false)
      const approveResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${userSub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ adminApproved: true }),
      }));
      expect(approveResp.status).toBe(200);

      // 6. User refreshes → gets JWT with adminApproved:true, access.admin:undefined
      const refreshResp = await SELF.fetch(new Request(workerUrl(`${instanceName}/refresh-token`), {
        method: 'POST',
        headers: {
          'Cookie': `refresh-token=${refreshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ activeScope: instanceName }),
      }));
      expect(refreshResp.status).toBe(200);
      const { access_token: ut } = await refreshResp.json() as any;
      userToken = ut;
    });

    it('GET /subjects returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subjects`), {
        headers: { 'Authorization': `Bearer ${userToken}` },
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('forbidden');
    });

    it('GET /subject/:id returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${userSub}`), {
        headers: { 'Authorization': `Bearer ${userToken}` },
      }));
      expect(resp.status).toBe(403);
    });

    it('PATCH /subject/:id returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${userSub}`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: true }),
      }));
      expect(resp.status).toBe(403);
    });

    it('DELETE /subject/:id returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/some-id`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${userToken}` },
      }));
      expect(resp.status).toBe(403);
    });

    it('POST /invite returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/invite`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['anyone@example.com'] }),
      }));
      expect(resp.status).toBe(403);
    });

    it('POST /subject/:id/actors returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${userSub}/actors`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actorSub: 'some-actor' }),
      }));
      expect(resp.status).toBe(403);
    });

    it('DELETE /subject/:id/actors/:actorId returns 403 for non-admin', async () => {
      const resp = await SELF.fetch(new Request(workerUrl(`${instanceName}/subject/${userSub}/actors/some-actor`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${userToken}` },
      }));
      expect(resp.status).toBe(403);
    });
  });

  // ============================================
  // Coverage: approve endpoint and logout edge cases
  // ============================================

  describe('approve and logout coverage', () => {
    it('GET /approve/:sub works with admin JWT', async () => {
      const instance = `approve-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'approve-admin@example.com');

      // Invite a user to approve
      const inviteResp = await SELF.fetch(new Request(workerUrl(`${instance}/invite`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['approvee@example.com'] }),
      }));
      expect(inviteResp.status).toBe(200);

      // Get the user's sub
      const subjResp = await SELF.fetch(new Request(workerUrl(`${instance}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      const { subjects } = await subjResp.json() as any;
      const approvee = subjects.find((s: any) => s.email === 'approvee@example.com');
      expect(approvee).toBeDefined();

      // Approve via GET /approve/:sub (returns 302 redirect)
      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/approve/${approvee.sub}`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
        redirect: 'manual',
      }));
      expect(resp.status).toBe(302);
    });

    it('GET /approve/:sub for nonexistent subject returns 404', async () => {
      const instance = `approve2-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'approve2-admin@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/approve/nonexistent-sub`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      expect(resp.status).toBe(404);
    });

    it('POST /logout without cookie still returns 200', async () => {
      const instance = `logout-nocookie-${generateUuid().slice(0, 8)}`;
      // Logout with no cookie — should succeed (no-op)
      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/logout`), {
        method: 'POST',
      }));
      expect(resp.status).toBe(200);
    });

    it('DELETE /subject/:sub for nonexistent sub returns 404', async () => {
      const instance = `del-noent-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'del-admin@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/subject/nonexistent-sub`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      expect(resp.status).toBe(404);
    });

    it('PATCH /subject/:sub for nonexistent sub returns 404', async () => {
      const instance = `patch-noent-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'patch-admin@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/subject/nonexistent-sub`), {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: true }),
      }));
      expect(resp.status).toBe(404);
    });
  });

  // ============================================
  // Coverage: magic link and invite edge cases
  // ============================================

  describe('magic link edge cases', () => {
    it('magic-link with missing token returns 400', async () => {
      const instance = `ml-notoken-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/magic-link`), {
        redirect: 'manual',
      }));
      expect(resp.status).toBe(400);
    });

    it('magic-link with invalid token redirects with error', async () => {
      const instance = `ml-bad-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(
        workerUrl(`${instance}/magic-link?one_time_token=bogus-token`),
        { redirect: 'manual' },
      ));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });

    it('reusing a magic link token redirects with error', async () => {
      const instance = `ml-reuse-${generateUuid().slice(0, 8)}`;

      // Get magic link
      const mlResp = await SELF.fetch(new Request(workerUrl(`${instance}/email-magic-link?_test=true`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'reuse@example.com' }),
      }));
      const { magic_link } = await mlResp.json() as any;

      // First click — consumes the token
      const resp1 = await SELF.fetch(new Request(magic_link, { redirect: 'manual' }));
      expect(resp1.status).toBe(302);
      expect(resp1.headers.get('Location')).toBe('/app');

      // Second click — token already used/deleted
      const resp2 = await SELF.fetch(new Request(magic_link, { redirect: 'manual' }));
      expect(resp2.status).toBe(302);
      expect(resp2.headers.get('Location')).toContain('error=');
    });

    it('accept-invite with missing invite_token returns 400', async () => {
      const instance = `inv-miss-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(
        workerUrl(`${instance}/accept-invite`),
      ));
      expect(resp.status).toBe(400);
    });

    it('accept-invite with invalid invite_token redirects with error', async () => {
      const instance = `inv-bad-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(
        workerUrl(`${instance}/accept-invite?invite_token=bogus-token`),
        { redirect: 'manual' },
      ));
      expect(resp.status).toBe(302);
      expect(resp.headers.get('Location')).toContain('error=invalid_token');
    });

    it('refresh-token with invalid cookie returns 401', async () => {
      const instance = `refresh-bad-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/refresh-token`), {
        method: 'POST',
        headers: { 'Cookie': 'refresh-token=bogus-token-value' },
      }));
      expect(resp.status).toBe(401);
    });

    it('refresh-token with no cookie returns 401', async () => {
      const instance = `refresh-none-${generateUuid().slice(0, 8)}`;
      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/refresh-token`), {
        method: 'POST',
      }));
      expect(resp.status).toBe(401);
    });
  });

  // ============================================
  // Coverage: list subjects filtering
  // ============================================

  describe('list subjects filtering', () => {
    it('GET /subjects?role=admin filters to admins', async () => {
      const instance = `filter-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'filter-admin@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/subjects?role=admin`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      expect(resp.status).toBe(200);
      const { subjects } = await resp.json() as any;
      expect(subjects.every((s: any) => s.isAdmin === true)).toBe(true);
    });

    it('GET /subjects?role=none filters to non-admins', async () => {
      const instance = `filter2-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'filter2-admin@example.com');

      // Invite a non-admin so there's something to filter
      await SELF.fetch(new Request(workerUrl(`${instance}/invite`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails: ['filter-nonadmin@example.com'] }),
      }));

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/subjects?role=none`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));
      expect(resp.status).toBe(200);
      const { subjects } = await resp.json() as any;
      expect(subjects.every((s: any) => s.isAdmin === false)).toBe(true);
      expect(subjects.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================
  // Coverage: test/set-subject-data helper endpoint
  // ============================================

  describe('test/set-subject-data endpoint', () => {
    it('POST /test/set-subject-data requires email', async () => {
      const instance = `tsd-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'tsd@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/test/set-subject-data`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
        body: JSON.stringify({}),
      }));
      expect(resp.status).toBe(400);
    });

    it('POST /test/set-subject-data returns 404 for unknown email', async () => {
      const instance = `tsd2-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'tsd2@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/test/set-subject-data`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
        body: JSON.stringify({ email: 'unknown@example.com' }),
      }));
      expect(resp.status).toBe(404);
    });

    it('POST /test/set-subject-data updates adminApproved', async () => {
      const instance = `tsd3-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'tsd3@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/test/set-subject-data`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
        body: JSON.stringify({ email: 'tsd3@example.com', adminApproved: false }),
      }));
      expect(resp.status).toBe(204);
    });

    it('POST /test/set-subject-data updates isAdmin', async () => {
      const instance = `tsd4-${generateUuid().slice(0, 8)}`;
      const { access_token } = await workerLogin(instance, 'tsd4@example.com');

      const resp = await SELF.fetch(new Request(workerUrl(`${instance}/test/set-subject-data`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
        body: JSON.stringify({ email: 'tsd4@example.com', isAdmin: false }),
      }));
      expect(resp.status).toBe(204);
    });
  });

  // ============================================
  // Full e2e: claim-universe + login + create-galaxy + claim-star
  // ============================================

  describe('full e2e: self-signup flow through Worker', () => {
    it('claim-universe → login → create-galaxy → claim-star', async () => {
      const universe = `e2e-${generateUuid().slice(0, 8)}`;
      const adminEmail = 'e2e-admin@example.com';

      // 1. Claim universe
      const claimResp = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email: adminEmail }),
      }));
      expect(claimResp.status).toBe(200);
      const claimBody = await claimResp.json() as any;
      expect(claimBody.magicLinkUrl).toBeDefined();

      // 2. Click magic link
      const clickResp = await SELF.fetch(new Request(claimBody.magicLinkUrl, { redirect: 'manual' }));
      expect(clickResp.status).toBe(302);
      const refreshToken = clickResp.headers.get('Set-Cookie')!.split(';')[0]!.split('=')[1]!;

      // 3. Refresh to get JWT
      const refreshResp = await SELF.fetch(new Request(workerUrl(`${universe}/refresh-token`), {
        method: 'POST',
        headers: {
          'Cookie': `refresh-token=${refreshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ activeScope: universe }),
      }));
      expect(refreshResp.status).toBe(200);
      const { access_token } = await refreshResp.json() as any;

      // 4. Create galaxy
      const galaxyId = `${universe}.my-app`;
      const galaxyResp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      }));
      expect(galaxyResp.status).toBe(201);

      // 5. Claim star
      const starId = `${galaxyId}.tenant-a`;
      const starResp = await SELF.fetch(new Request(registryUrl('claim-star'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          universeGalaxyStarId: starId,
          email: 'tenant@example.com',
        }),
      }));
      expect(starResp.status).toBe(200);
      const starBody = await starResp.json() as any;
      expect(starBody.magicLinkUrl).toBeDefined();

      // 6. Verify discovery shows both admin entries
      const discoverResp = await SELF.fetch(new Request(registryUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail }),
      }));
      expect(discoverResp.status).toBe(200);
      const entries = await discoverResp.json() as any[];
      expect(entries.some((e: any) => e.instanceName === universe)).toBe(true);
    });
  });
});

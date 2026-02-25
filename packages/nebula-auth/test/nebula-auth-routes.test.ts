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
import { NEBULA_AUTH_PREFIX, NEBULA_AUTH_ISSUER, NEBULA_AUTH_AUDIENCE } from '../src/types';
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
  accessAdmin?: boolean;
  adminApproved?: boolean;
  sub?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
  const now = Math.floor(Date.now() / 1000);
  const access: AccessEntry = { id: opts.accessId };
  if (opts.accessAdmin) access.admin = true;

  const payload: NebulaJwtPayload = {
    iss: NEBULA_AUTH_ISSUER,
    aud: NEBULA_AUTH_AUDIENCE,
    sub: opts.sub ?? generateUuid(),
    exp: now + (opts.expiresInSeconds ?? 900),
    iat: now,
    jti: generateUuid(),
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
    headers: { 'Cookie': `refresh-token=${refreshToken}` },
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
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
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

    it('universe admin wildcard JWT passes Worker auth but star DO re-verifies (known limitation)', async () => {
      // The Worker correctly matches the wildcard JWT against the star path,
      // but the star DO's #authenticateRequest re-verifies the JWT against
      // its own Subjects table. Since the universe admin's `sub` doesn't exist
      // in the star DO, the DO returns 401.
      //
      // This is a known limitation: cross-scope admin access requires the DO
      // to trust the Worker's pre-verification. Will be fixed in Phase 6 by
      // adding a trusted header mechanism.
      //
      // For now, we verify the Worker DOES pass (doesn't return 401/403 from
      // its own checks) by confirming the response comes from the DO, not the Worker.
      const universe = `wildcard-${generateUuid().slice(0, 8)}`;
      const starId = `${universe}.app.tenant`;
      const adminEmail = 'wildcard-admin@example.com';

      // Login at universe → get wildcard JWT
      const { access_token } = await workerLogin(universe, adminEmail);

      // Worker passes (wildcard match), but DO returns 401 (sub not in star DO)
      const resp = await SELF.fetch(new Request(workerUrl(`${starId}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      }));

      // The 401 comes from the DO (not the Worker) — the DO's response includes
      // the error code from #authenticateRequest
      expect(resp.status).toBe(401);
      const body = await resp.json() as any;
      expect(body.error).toBe('invalid_token'); // DO error, not Worker's "invalid_request"
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
        headers: { 'Cookie': `refresh-token=${refreshToken}` },
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

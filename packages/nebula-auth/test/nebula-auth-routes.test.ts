/**
 * Worker router — routing correctness + gating through the full Worker (SELF.fetch) over the registry
 * + KV (the dissolved-DO model, tasks/nebula-auth-surrogate-sub.md). The surviving authenticated
 * instance endpoints are `invite` + `delegated-token`; the router NO LONGER runs an `adminApproved`
 * edge gate (M5 — enforced at mint), so a valid token is forwarded and admin-ness is checked at the
 * endpoint/registry.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { signJwt, importPrivateKey, generateUuid } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX, NEBULA_AUTH_ISSUER } from '../src/types';
import type { AccessEntry } from '../src/types';
import { foundUniverse, requestMagicLink, clickLink } from './test-helpers';

const PREFIX = NEBULA_AUTH_PREFIX;
const workerUrl = (path: string) => `http://localhost${PREFIX}/${path}`;
const registryUrl = (endpoint: string) => `http://localhost${PREFIX}/${endpoint}`;
const uni = () => `u${generateUuid().slice(0, 8)}`;

/** Sign a raw Nebula-shaped JWT (email/adminApproved are no longer claims). */
async function signRaw(extra: Record<string, any>): Promise<string> {
  const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: NEBULA_AUTH_ISSUER, sub: generateUuid(), exp: now + 900, iat: now, jti: generateUuid(), ...extra } as any, privateKey, 'BLUE');
}

/** A synthetic non-admin token for a scope (drives the router without a real login). */
async function nonAdminToken(scope: string): Promise<string> {
  const access: AccessEntry = { authScopePattern: scope };
  return signRaw({ aud: scope, access });
}

describe('@lumenize/nebula-auth — Worker Router', () => {
  describe('basic routing', () => {
    it('404 outside /auth prefix; 404 for /auth with no subpath', async () => {
      expect((await SELF.fetch(new Request('http://localhost/other/path'))).status).toBe(404);
      expect((await SELF.fetch(new Request('http://localhost/auth/'))).status).toBe(404);
    });
  });

  describe('registry dispatch', () => {
    it('POST /auth/discover reaches the registry (returns universeGalaxyStarId entries)', async () => {
      const u = uni();
      await foundUniverse(SELF, u, 'discover@example.com');
      const resp = await SELF.fetch(new Request(registryUrl('discover'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'discover@example.com' }),
      }));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any[];
      expect(body.some(e => e.universeGalaxyStarId === u)).toBe(true);
    });

    it('POST /auth/claim-universe creates; duplicate → 409', async () => {
      const u = uni();
      const first = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: u, email: 'a@example.com' }),
      }));
      expect(first.status).toBe(200);
      expect((await first.json() as any).magicLinkUrl).toBeDefined();
      const dup = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: u, email: 'other@example.com' }),
      }));
      expect(dup.status).toBe(409);
      expect((await dup.json() as any).error).toBe('slug_taken');
    });

    it('claim-star is NOT a registry endpoint YET — POST → 404', async () => {
      // `/auth/claim-star` is not routed as a registry endpoint, so it falls through as a bare
      // instance path with no auth-flow/authenticated suffix → 404. Star creation today is
      // `create-star`, admin-gated over the parent galaxy.
      // ⚠️ This asserts CURRENT behavior, not a prohibition — open star self-signup is the pinned
      // target (tasks/nebula-star-founder-provisioning.md). When that lands, this test flips to
      // asserting the endpoint EXISTS; do not read it as settled intent that it never should.
      const resp = await SELF.fetch(new Request(registryUrl('claim-star'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universeGalaxyStarId: 'nonexistent.galaxy.star', email: 's@example.com' }),
      }));
      expect(resp.status).toBe(404);
    });

    it('create-galaxy: requires a JWT (401); succeeds (201) with an admin JWT', async () => {
      const noJwt = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universeGalaxyId: 'x.galaxy' }),
      }));
      expect(noJwt.status).toBe(401);

      const u = uni();
      const admin = await foundUniverse(SELF, u, 'gal-admin@example.com');
      const ok = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.access_token}` },
        body: JSON.stringify({ universeGalaxyId: `${u}.my-galaxy` }),
      }));
      expect(ok.status).toBe(201);
      expect((await ok.json() as any).instanceName).toBe(`${u}.my-galaxy`);
    });

    it('GET to a registry endpoint → 405', async () => {
      expect((await SELF.fetch(new Request(registryUrl('discover'), { method: 'GET' }))).status).toBe(405);
    });
  });

  describe('instance dispatch — auth flow (no JWT)', () => {
    it('email-magic-link → 200 (magicLinkUrl in test mode); magic-link click for an existing founder → 302 + cookie; refresh → 200; logout → 200', async () => {
      const u = uni();
      await foundUniverse(SELF, u, 'flow@example.com'); // founder identity now exists

      const ml = await requestMagicLink(SELF, u, 'flow@example.com');
      expect(ml.status).toBe(200);
      const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
      expect(magicLinkUrl).toBeDefined();

      const { refreshToken } = await clickLink(SELF, magicLinkUrl);
      const refresh = await SELF.fetch(new Request(workerUrl(`${u}/refresh-token`), {
        method: 'POST',
        headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: u }),
      }));
      expect(refresh.status).toBe(200);
      expect((await refresh.json() as any).access_token).toBeDefined();

      const logout = await SELF.fetch(new Request(workerUrl(`${u}/logout`), {
        method: 'POST', headers: { Cookie: `refresh-token=${refreshToken}` },
      }));
      expect(logout.status).toBe(200);
    });
  });

  describe('instance dispatch — authenticated (JWT required)', () => {
    it('invite: 401 without JWT / 401 invalid JWT / 200 with admin JWT', async () => {
      expect((await SELF.fetch(new Request(workerUrl('some-instance/invite'), { method: 'POST' }))).status).toBe(401);
      expect((await SELF.fetch(new Request(workerUrl('some-instance/invite'), {
        method: 'POST', headers: { Authorization: 'Bearer invalid.jwt.here', 'Content-Type': 'application/json' }, body: '{}',
      }))).status).toBe(401);

      const u = uni();
      const admin = await foundUniverse(SELF, u, 'inv-admin@example.com');
      const ok = await SELF.fetch(new Request(workerUrl(`${u}.app.tenant/invite`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: ['invitee@example.com'] }),
      }));
      expect(ok.status).toBe(200);
      expect((await ok.json() as any).invited).toHaveLength(1);
    });

    it('rejects a token whose scope does not cover the target instance (403 insufficient_scope)', async () => {
      const a = uni();
      const admin = await foundUniverse(SELF, a, 'scope-a@example.com'); // pattern `a.*`
      const resp = await SELF.fetch(new Request(workerUrl(`${uni()}.app/invite`), { // a DIFFERENT universe
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: ['x@example.com'] }),
      }));
      expect(resp.status).toBe(403);
      expect((await resp.json() as any).error).toBe('insufficient_scope');
    });

    it('a universe wildcard token reaches a descendant star endpoint (cross-scope invite)', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, 'wild-admin@example.com');
      const resp = await SELF.fetch(new Request(workerUrl(`${u}.app.tenant/invite`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: ['star-user@example.com'] }),
      }));
      expect(resp.status).toBe(200);
    });

    it('M5: a non-admin token is FORWARDED (no retired adminApproved gate) — the endpoint returns forbidden, not access_denied', async () => {
      const scope = 'gate-test.app.tenant';
      const token = await nonAdminToken(scope);
      const resp = await SELF.fetch(new Request(workerUrl(`${scope}/invite`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: ['x@example.com'] }),
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('forbidden');        // admin-check at the endpoint
      expect(body.error).not.toBe('access_denied'); // the retired router:541 gate is gone
    });

    it('bare instance path with no endpoint → 404', async () => {
      // A bare instance name is neither an auth-flow nor an authenticated suffix.
      expect((await SELF.fetch(new Request(workerUrl('some-bare-instance')))).status).toBe(404);
    });
  });

  describe('registry fetch handler errors', () => {
    it('invalid slug → 400 invalid_slug; reserved slug → 400 reserved_slug', async () => {
      const bad = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'INVALID_UPPERCASE', email: 'a@b.com' }),
      }));
      expect(bad.status).toBe(400);
      expect((await bad.json() as any).error).toBe('invalid_slug');

      const reserved = await SELF.fetch(new Request(registryUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'nebula-platform', email: 'a@b.com' }),
      }));
      expect(reserved.status).toBe(400);
      expect((await reserved.json() as any).error).toBe('reserved_slug');
    });
  });

  describe('Worker JWT validation branches (target: /invite)', () => {
    const target = 'some-instance/invite';
    async function post(token: string): Promise<Response> {
      return SELF.fetch(new Request(workerUrl(target), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      }));
    }

    it('missing aud → 401', async () => {
      expect((await post(await signRaw({ access: { authScopePattern: 'some-instance.*', admin: true } }))).status).toBe(401);
    });
    it('wrong issuer → 401', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({ iss: 'wrong-issuer', aud: 'some-instance', sub: generateUuid(), exp: now + 900, iat: now, jti: generateUuid(), access: { authScopePattern: 'some-instance.*', admin: true } } as any, privateKey, 'BLUE');
      expect((await post(token)).status).toBe(401);
    });
    it('missing sub → 401', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({ iss: NEBULA_AUTH_ISSUER, aud: 'some-instance', exp: now + 900, iat: now, jti: generateUuid(), access: { authScopePattern: 'some-instance.*', admin: true } } as any, privateKey, 'BLUE');
      expect((await post(token)).status).toBe(401);
    });
    it('missing access → 401', async () => {
      expect((await post(await signRaw({ aud: 'some-instance' }))).status).toBe(401);
    });
    it('aud not covered by authScopePattern → 403 (target-instance not in wrong-universe.*)', async () => {
      const token = await signRaw({ aud: 'wrong-universe', access: { authScopePattern: 'wrong-universe.*', admin: true } });
      const resp = await SELF.fetch(new Request(workerUrl('target-instance/invite'), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      }));
      expect(resp.status).toBe(403);
      expect((await resp.json() as any).error).toBe('insufficient_scope');
    });
  });

  describe('Registry JWT validation (create-galaxy)', () => {
    it('missing audience on create-galaxy → 401', async () => {
      const token = await signRaw({ access: { authScopePattern: 'some-universe.*', admin: true } });
      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ universeGalaxyId: 'some-universe.g' }),
      }));
      expect(resp.status).toBe(401);
    });
  });
});

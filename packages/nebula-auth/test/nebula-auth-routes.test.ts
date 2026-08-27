/**
 * Worker router — routing correctness + gating through the full Worker (SELF.fetch) over the registry
 * + KV (the dissolved-DO model, tasks/nebula-auth-surrogate-sub.md). The one surviving authenticated
 * route is the scope-less `mint-narrower-token` (invites moved to the mesh facade — POST
 * `/auth/{scope}/invite` is a 404, asserted below); the router NO LONGER runs an `adminApproved`
 * edge gate (M5 — enforced at mint), so a valid token is forwarded and admin-ness is checked at the
 * endpoint/registry.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { NEBULA_AUTH_PREFIX, NEBULA_AUTH_ISSUER, REGISTRY_INSTANCE_NAME } from '../src/types';
import type { AccessEntry } from '../src/types';
import {
  foundUniverse, requestMagicLink, clickLink, claimStar, createGalaxy, refreshAndParse, claimUniverse,
} from './test-helpers';

const PREFIX = NEBULA_AUTH_PREFIX;
const workerUrl = (path: string) => `http://localhost${PREFIX}/${path}`;
const registryUrl = (endpoint: string) => `http://localhost${PREFIX}/${endpoint}`;
const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;

/** Sign a raw Nebula-shaped JWT (email/adminApproved are no longer claims). */
async function signRaw(extra: Record<string, any>): Promise<string> {
  const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: NEBULA_AUTH_ISSUER, sub: crypto.randomUUID(), exp: now + 900, iat: now, jti: crypto.randomUUID(), ...extra } as any, privateKey, 'BLUE');
}

/** A synthetic non-admin token for a scope (drives the router without a real login). */
async function nonAdminToken(scope: string): Promise<string> {
  const access: AccessEntry = { authScope: scope };
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

    // ── claim-star: OPEN Star self-signup ────────────────────────────────────────────────────────
    //
    // Every assertion here rides `SELF.fetch`, never a direct registry RPC: raw Workers RPC DROPS
    // custom own properties (`raw-comm.md` § Errors), so a `status`/`error` assertion through an RPC
    // helper sees nothing and passes vacuously.
    describe('claim-star (open self-signup)', () => {
      /** A universe + galaxy that really exist, plus an admin token over them. */
      async function realGalaxy() {
        const u = uni();
        const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const galaxy = `${u}.app`;
        expect((await createGalaxy(SELF, galaxy, access_token)).status).toBe(201);
        return { universe: u, galaxy, adminToken: access_token };
      }
      /** Rows the registry singleton holds for a scope — the observable "nothing was written" check. */
      async function rowsFor(scope: string): Promise<{ scopes: number; links: number }> {
        const stub = env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
        return (runInDurableObject as any)(stub, (_i: any, ctx: any) => ({
          scopes: [...ctx.storage.sql.exec('SELECT 1 FROM Scopes WHERE universeGalaxyStarId = ?', scope)].length,
          links: [...ctx.storage.sql.exec('SELECT 1 FROM MagicLinks WHERE universeGalaxyStarId = ?', scope)].length,
        }));
      }

      it('a stranger founds a Star and holds an EXACT-STAR authScope — never {u}', async () => {
        const { galaxy } = await realGalaxy();
        const star = `${galaxy}.tenant`;

        const resp = await claimStar(SELF, star, 'stranger@example.com');
        expect(resp.status).toBe(200);
        const { magicLinkUrl } = await resp.json() as { magicLinkUrl?: string };
        expect(magicLinkUrl).toBeDefined();

        // Through the real claim link → login → inspect the MINTED token. This is the assertion that
        // makes open signup safe: a star-scoped `authScope` is inert at every ancestor (ADR-015), so
        // a squatter gains a slug and nothing else. Widen the mint to `{u}` and this reds.
        const { refreshToken } = await clickLink(SELF, magicLinkUrl!);
        const { parsed } = await refreshAndParse(SELF, star, refreshToken);
        expect(parsed.access.authScope).toBe(star);
        expect(parsed.access.scopeAdmin).toBe(true);
      });

      it('a phantom parent galaxy is rejected BEFORE any write', async () => {
        // The universe exists but the galaxy was never created — so this is precisely the
        // orphan-star / namespace-squat case, not a malformed id.
        const u = uni();
        await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const star = `${u}.never-created.tenant`;

        const resp = await claimStar(SELF, star, 'squatter@example.com');
        expect(resp.status).toBe(400);
        expect((await resp.json() as any).error).toBe('parent_not_found');
        // Reds if the claimUniverse-shaped body (which has no parent check) is copied: without it an
        // unauthenticated caller writes an scopeAdmin identity under a galaxy that never existed.
        expect(await rowsFor(star)).toEqual({ scopes: 0, links: 0 });
      });

      it('the reserved `dev` slug is rejected FOR BEING RESERVED, with no write', async () => {
        // ⚠️ The parent galaxy is created on purpose: without it `parent_not_found` fires first and
        // produces IDENTICAL observables (400, no rows), so the test would pass whether or not the
        // reserved list exists at all.
        const { galaxy } = await realGalaxy();
        const devStar = `${galaxy}.dev`;

        const resp = await claimStar(SELF, devStar, 'squatter@example.com');
        expect(resp.status).toBe(400);
        // Assert the CODE, not just the status — that is what distinguishes this from the sibling
        // rejects. A squatter here would 409 the user-developer's own Studio forever AND clear
        // resetDevData's requireDominionHere, i.e. they could wipe it.
        expect((await resp.json() as any).error).toBe('reserved_slug');
        expect(await rowsFor(devStar)).toEqual({ scopes: 0, links: 0 });
      });

      it('rejects run in the PINNED order — first failure wins', async () => {
        const { galaxy } = await realGalaxy();
        const star = `${galaxy}.order-test`;
        await claimStar(SELF, star, 'first@example.com'); // now taken

        // Format precedes registry data: both malformed AND taken → invalid_email.
        const both = await claimStar(SELF, star, 'not-an-email');
        expect((await both.json() as any).error).toBe('invalid_email');

        // Reserved precedes parent-exists: reserved slug under a PHANTOM parent → reserved_slug.
        const reservedPhantom = await claimStar(SELF, `${uni()}.nope.dev`, 'x@example.com');
        expect((await reservedPhantom.json() as any).error).toBe('reserved_slug');

        // ⚠️ Without these two, the cases are indistinguishable — both are 400s with no rows written.
        const taken = await claimStar(SELF, star, 'second@example.com');
        expect(taken.status).toBe(409);
        expect((await taken.json() as any).error).toBe('slug_taken');
      });

      it('a taken slug is owner-aware but NOT observable in the response', async () => {
        const { galaxy } = await realGalaxy();
        const star = `${galaxy}.resume`;
        const starAdmin = 'scope-admin@example.com';
        expect((await claimStar(SELF, star, starAdmin)).status).toBe(200);
        const afterClaim = await rowsFor(star);

        // (a) A DIFFERENT email → plain slug_taken, NO new link row.
        const other = await claimStar(SELF, star, 'someone-else@example.com');
        const otherBody = await other.text();
        expect(other.status).toBe(409);
        expect((await rowsFor(star)).links).toBe(afterClaim.links);

        // (b) The star-scoped admin's OWN email while emailVerified = 0 → the resume: a NEW link row, delivered
        //     only by email — and a byte-identical response.
        const resume = await claimStar(SELF, star, starAdmin);
        const resumeBody = await resume.text();
        expect(resume.status).toBe(409);
        expect((await rowsFor(star)).links).toBe(afterClaim.links + 1);

        // 🔒 The anti-oracle property. Reds if the resume returns a fresh-claim-shaped success, which
        // would confirm that a probed address is that slug's unverified admin (and mail them).
        expect(resumeBody).toBe(otherBody);
        expect(JSON.parse(resumeBody).magicLinkUrl).toBeUndefined();
      });

      it('the resume adds a link row ONLY — it never mutates the identity', async () => {
        const { galaxy } = await realGalaxy();
        const star = `${galaxy}.no-mutate`;
        const starAdmin = 'star-admin-2@example.com';
        expect((await claimStar(SELF, star, starAdmin)).status).toBe(200);

        const stub = env.NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
        const readIdentity = async (email: string) => (runInDurableObject as any)(stub, (_i: any, ctx: any) =>
          [...ctx.storage.sql.exec(
            `SELECT m.sub AS sub, e.profileId AS profileId, m.scopeAdmin AS scopeAdmin, m.acceptedAt AS acceptedAt
             FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
             WHERE e.email = ? AND m.universeGalaxyStarId = ?`,
            email, star,
          )][0]);

        const before = await readIdentity(starAdmin);
        await claimStar(SELF, star, starAdmin);
        expect(await readIdentity(starAdmin)).toEqual(before);

        // A PENDING INVITEE at the same scope is (scopeAdmin 0, never taken up) — exactly what a looser
        // predicate would match. Resuming one must not promote it to star admin through an
        // unauthenticated endpoint, and must send it nothing.
        const invitee = 'invitee@example.com';
        const inviteeEmailId = crypto.randomUUID();
        await (runInDurableObject as any)(stub, (_i: any, ctx: any) => {
          ctx.storage.sql.exec(
            'INSERT INTO Emails (emailId, email, profileId, emailVerified, createdAt) VALUES (?,?,?,0,?)',
            inviteeEmailId, invitee, crypto.randomUUID(), '2026-01-01T00:00:00.000Z',
          );
          ctx.storage.sql.exec(
            'INSERT INTO Memberships (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt) VALUES (?,?,?,0,NULL,?)',
            crypto.randomUUID(), inviteeEmailId, star, '2026-01-01T00:00:00.000Z',
          );
        });
        const linksBefore = (await rowsFor(star)).links;
        const resp = await claimStar(SELF, star, invitee);
        expect(resp.status).toBe(409);
        expect((await readIdentity(invitee)).scopeAdmin).toBe(0);
        expect((await rowsFor(star)).links).toBe(linksBefore); // no link row → nothing was sent
      });

      it('a malformed body is a clean 400 on every raw-forwarded endpoint, never a 500', async () => {
        // ⚠️ A REGRESSION the raw forward introduces: the Worker used to `?? {}` a bad body, so the
        // registry never saw one. Now `await request.json()` would throw a SyntaxError — not a
        // RegistryError — and fall to the 500 fallback.
        for (const endpoint of ['claim-star', 'claim-universe', 'discover']) {
          const resp = await SELF.fetch(new Request(registryUrl(endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{',
          }));
          expect(resp.status, `${endpoint} must 400 on a malformed body`).toBe(400);
          expect((await resp.json() as any).error, endpoint).toBe('invalid_request');
        }
      });
    });

    // ── Login redirect: the TIER SPLIT ───────────────────────────────────────────────────────────
    //
    // 🔒 This is a wire-level decision: it bakes into every emailed link, so it cannot be fixed after
    // the fact. A **star-scoped** admin is an end user and lands on the built-app surface (`/app`, which is
    // hardcoded because the routing scheme fixes it). Every other tier is a user-developer landing on
    // their own control plane, and rides `NEBULA_AUTH_REDIRECT` — which the Galaxy collapse flips from
    // `/app` to `/studio`.
    //
    // ⚠️ The binding is `/app` project-wide (test/wrangler.jsonc), which would make both branches
    // produce the SAME string and the test vacuous. Each test below mutates it to `/studio` for its
    // duration and restores it, so the branches genuinely diverge. Do NOT flip it project-wide:
    // `test-helpers.ts` `clickLink` asserts `/^\/app(\/|$)/` at its call sites throughout this suite.
    describe('login redirect tier split', () => {
      async function withStudioRedirect<T>(fn: () => Promise<T>): Promise<T> {
        const original = (env as any).NEBULA_AUTH_REDIRECT;
        (env as any).NEBULA_AUTH_REDIRECT = '/studio';
        try { return await fn(); } finally { (env as any).NEBULA_AUTH_REDIRECT = original; }
      }
      const locationOf = async (linkUrl: string) =>
        (await SELF.fetch(new Request(linkUrl, { redirect: 'manual' }))).headers.get('Location');

      it('a STAR-scoped admin lands on /app/{scope} even when the control plane has moved to /studio', async () => {
        const u = uni();
        const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const galaxy = `${u}.app`;
        await createGalaxy(SELF, galaxy, access_token);
        const star = `${galaxy}.tenant`;
        const { magicLinkUrl } = await (await claimStar(SELF, star, 'scope-admin@example.com')).json() as any;

        await withStudioRedirect(async () => {
          expect(await locationOf(magicLinkUrl)).toBe(`/app/${encodeURIComponent(star)}`);
        });
      });

      it('a UNIVERSE-scoped admin rides NEBULA_AUTH_REDIRECT — /studio/{scope}', async () => {
        const u = uni();
        const magicLinkUrl = await claimUniverse(SELF, u, `owner-${u}@example.com`);
        await withStudioRedirect(async () => {
          expect(await locationOf(magicLinkUrl)).toBe(`/studio/${u}`);
        });
      });

      it('an EXPIRED/invalid star link errors to /app, not into the control plane', async () => {
        // ⚠️ The case the split matters most for. MAGIC_LINK_TTL is 30 min and the resumable claim
        // exists precisely because these expire — an unsplit error branch would drop a star-scoped admin
        // into the user-developer's Studio.
        const u = uni();
        const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const galaxy = `${u}.app`;
        await createGalaxy(SELF, galaxy, access_token);
        const star = `${galaxy}.tenant`;

        await withStudioRedirect(async () => {
          const bad = `http://localhost${PREFIX}/${star}/magic-link?one_time_token=never-issued`;
          expect(await locationOf(bad)).toBe('/app?error=invalid_token');
          // The non-star tier still errors to the control plane.
          const badUni = `http://localhost${PREFIX}/${u}/magic-link?one_time_token=never-issued`;
          expect(await locationOf(badUni)).toBe('/studio?error=invalid_token');
        });
      });

      it('the TOKEN decides the tier, not the URL path', async () => {
        // A universe-scope token consumed through a STAR-shaped URL must still land where the TOKEN
        // says. `parseScopeGuard` only format-validates that path segment and never cross-checks it
        // against the token (the registry keys on tokenHash alone), so keying the redirect off the URL
        // would let a caller pick another tier's landing surface.
        const u = uni();
        const magicLinkUrl = await claimUniverse(SELF, u, `owner-${u}@example.com`);
        const token = new URL(magicLinkUrl).searchParams.get('one_time_token')!;
        const starShapedUrl = `http://localhost${PREFIX}/${u}.fake.star/magic-link?one_time_token=${token}`;

        await withStudioRedirect(async () => {
          expect(await locationOf(starShapedUrl)).toBe(`/studio/${u}`);
        });
      });
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
    it('email-magic-link → 200 (magicLinkUrl in test mode); magic-link click for an existing identity → 302 + cookie; refresh → 200; logout → 200', async () => {
      const u = uni();
      await foundUniverse(SELF, u, 'flow@example.com'); // admin identity now exists

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

  describe('authenticated dispatch (JWT required — vehicle: mint-narrower-token, the surviving authed route)', () => {
    // The `/auth/{scope}/invite` vehicle these used to ride is deleted — every invite enters
    // mesh-side through the NebulaAuthFacade (guard coverage: apps/nebula baseline
    // `invite-facade.test.ts`). The route-layer properties keep their coverage on the mint route.
    it('401 without JWT / 401 invalid JWT', async () => {
      expect((await SELF.fetch(new Request(registryUrl('mint-narrower-token'), { method: 'POST' }))).status).toBe(401);
      expect((await SELF.fetch(new Request(registryUrl('mint-narrower-token'), {
        method: 'POST', headers: { Authorization: 'Bearer invalid.jwt.here', 'Content-Type': 'application/json' }, body: '{}',
      }))).status).toBe(401);
    });

    it('M5: a non-admin token is FORWARDED (no retired adminApproved gate) — the endpoint refuses forbidden, not access_denied', async () => {
      const scope = 'gate-test.app.tenant';
      const token = await nonAdminToken(scope);
      const resp = await SELF.fetch(new Request(registryUrl('mint-narrower-token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subOfNarrowerToken: crypto.randomUUID(), activeScope: scope }),
      }));
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('forbidden');        // the endpoint's own refusal
      expect(body.error).not.toBe('access_denied'); // the retired router:541 gate is gone
    });

    it('POST /auth/{scope}/invite → 404 (no HTTP invite surface; issuance is mesh-side)', async () => {
      const resp = await SELF.fetch(new Request(workerUrl('some-instance/invite'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
      expect(resp.status).toBe(404);
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

  describe('Worker JWT validation branches (vehicle: mint-narrower-token)', () => {
    // These exercise `verifyJwtGuard`/`verifyNebulaAccessToken`'s per-claim rejections, which are
    // route-independent — the mint route is simply the authed row that survived the invite route's
    // move to the mesh facade. (The old fifth branch — a consistent token refused 403 by the URL
    // scope's passage/dominion guards — died with that route; scope-verdict refusals are the
    // facade's, asserted with distinguishable messages in apps/nebula's `invite-facade.test.ts`.)
    async function post(token: string): Promise<Response> {
      return SELF.fetch(new Request(registryUrl('mint-narrower-token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      }));
    }

    it('missing aud → 401', async () => {
      expect((await post(await signRaw({ access: { authScope: 'some-instance', scopeAdmin: true } }))).status).toBe(401);
    });
    it('wrong issuer → 401', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({ iss: 'wrong-issuer', aud: 'some-instance', sub: crypto.randomUUID(), exp: now + 900, iat: now, jti: crypto.randomUUID(), access: { authScope: 'some-instance', scopeAdmin: true } } as any, privateKey, 'BLUE');
      expect((await post(token)).status).toBe(401);
    });
    it('missing sub → 401', async () => {
      const privateKey = await importPrivateKey(env.JWT_PRIVATE_KEY_BLUE);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJwt({ iss: NEBULA_AUTH_ISSUER, aud: 'some-instance', exp: now + 900, iat: now, jti: crypto.randomUUID(), access: { authScope: 'some-instance', scopeAdmin: true } } as any, privateKey, 'BLUE');
      expect((await post(token)).status).toBe(401);
    });
    it('missing access → 401', async () => {
      expect((await post(await signRaw({ aud: 'some-instance' }))).status).toBe(401);
    });
  });

  describe('Registry JWT validation (create-galaxy)', () => {
    it('missing audience on create-galaxy → 401', async () => {
      const token = await signRaw({ access: { authScope: 'some-universe', scopeAdmin: true } });
      const resp = await SELF.fetch(new Request(registryUrl('create-galaxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ universeGalaxyId: 'some-universe.g' }),
      }));
      expect(resp.status).toBe(401);
    });
  });
});

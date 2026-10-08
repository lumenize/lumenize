/**
 * Worker router — routing correctness + gating through the full Worker (SELF.fetch) over the registry
 * + KV (the dissolved-DO model, tasks/archive/nebula-auth-surrogate-sub.md). Every route is a step in a
 * session's lifecycle on the platform host, and none reads an access token: what a session does
 * moved to the mesh facade (POST `/auth/{scope}/invite` is a 404, asserted below), and Home reads by
 * cookie.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { REGISTRY_INSTANCE_NAME } from '../../src/auth/types';
import { buildAuthRouteTable } from '../../src/auth/router';
import { recordingHooks } from './test-worker-and-dos';
import {
  foundUniverse, requestMagicLink, clickLink, claimStar, createGalaxy, claimUniverse, consumeLink,
  authUrl, scopeOrigin, refresh, refreshCookie, logoutRequest, PLATFORM,
} from './test-helpers';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;

describe('@lumenize/mesh/auth — Worker Router', () => {
  describe('basic routing', () => {
    it('404 outside /auth prefix; 404 for /auth with no subpath', async () => {
      expect((await SELF.fetch(new Request(`${PLATFORM}/other/path`))).status).toBe(404);
      expect((await SELF.fetch(new Request(`${PLATFORM}/auth/`))).status).toBe(404);
    });
  });

  describe('registry dispatch', () => {
    it('POST /auth/claim-universe creates; duplicate → 409', async () => {
      const u = uni();
      const first = await SELF.fetch(new Request(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: u, appSlug: 'first', email: 'a@example.com' }),
      }));
      expect(first.status).toBe(200);
      expect((await first.json() as any).magicLinkUrl).toBeDefined();
      const dup = await SELF.fetch(new Request(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: u, appSlug: 'first', email: 'other@example.com' }),
      }));
      expect(dup.status).toBe(409);
      expect((await dup.json() as any).error).toBe('slug_taken');
    });

    // ── claim-star: OPEN Star self-signup ────────────────────────────────────────────────────────
    //
    // Every assertion here rides `SELF.fetch`, never a direct registry RPC: this route forwards to
    // the Registry's own `fetch()`, whose `RegistryError` → `Response` conversion makes the status
    // and `error` body a client sees — an RPC call to `claimStar` would skip it.
    describe('claim-star (open self-signup)', () => {
      /** A universe + galaxy that really exist, plus an admin token over them. */
      async function realGalaxy() {
        const u = uni();
        const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const galaxy = `${u}.app`;
        await createGalaxy(galaxy, access_token);
        return { universe: u, galaxy, adminToken: access_token };
      }
      /** Rows the registry singleton holds for a scope — the observable "nothing was written" check. */
      async function rowsFor(scope: string): Promise<{ scopes: number; links: number }> {
        const stub = env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
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
        const { tokenFor } = await clickLink(SELF, magicLinkUrl!); // the claim page's Accept
        const minted = await refresh(SELF, star, refreshCookie(star, tokenFor(star)));
        const { access_token } = await minted.json() as { access_token: string };
        const parsed = JSON.parse(atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
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
        // ONE scopes row and zero links: the row is the legitimate `.dev` born WITH the
        // galaxy (createGalaxy bundles it), and the refused claim added nothing — no
        // squatter membership, no link. The property is "the claim wrote NOTHING".
        expect(await rowsFor(devStar)).toEqual({ scopes: 1, links: 0 });
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

        const stub = env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
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
        for (const endpoint of ['claim-star', 'claim-universe']) {
          const resp = await SELF.fetch(new Request(authUrl(endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{',
          }));
          expect(resp.status, `${endpoint} must 400 on a malformed body`).toBe(400);
          expect((await resp.json() as any).error, endpoint).toBe('invalid_request');
        }
      });
    });

    // ── Where a link sends the person: its record's `returnTo`, else Home ─────────────────────────
    //
    // The server writes `returnTo` when it mints the link — a claim's first Studio host, a star
    // claim's own host, an invite's scope host, or a login page's checked `return_to` — and the
    // consume answers it. Nothing the page posts can change it.
    describe('where a consume sends the person', () => {
      const redirectOf = async (linkUrl: string, body: Record<string, unknown> = {}) => {
        const resp = await consumeLink(SELF, linkUrl, body);
        expect(resp.status).toBe(200);
        return (await resp.json() as { redirect: string }).redirect;
      };

      it('a universe claim lands in its first app\'s Studio', async () => {
        const u = uni();
        expect(await redirectOf(await claimUniverse(SELF, u, `owner-${u}@example.com`, 'crm')))
          .toBe(`${scopeOrigin(`${u}.crm`)}/`);
      });

      it('a star claim lands on the star\'s own host', async () => {
        const u = uni();
        const { access_token } = await foundUniverse(SELF, u, `owner-${u}@example.com`);
        const galaxy = `${u}.app`;
        await createGalaxy(galaxy, access_token);
        const star = `${galaxy}.tenant`;
        const { magicLinkUrl } = await (await claimStar(SELF, star, 'scope-admin@example.com')).json() as any;
        expect(await redirectOf(magicLinkUrl)).toBe(`${scopeOrigin(star)}/`);
      });

      it('a plain login lands on Home', async () => {
        const u = uni();
        const email = `owner-${u}@example.com`;
        await foundUniverse(SELF, u, email);
        const { magicLinkUrl } = await (await requestMagicLink(SELF, email)).json() as { magicLinkUrl: string };
        expect(await redirectOf(magicLinkUrl)).toBe('/');
      });

      // The page passes only the token, but a client that is not the page can post anything.
      it('a return_to in the consume\'s body is ignored for the record\'s', async () => {
        const u = uni();
        const link = await claimUniverse(SELF, u, `owner-${u}@example.com`, 'crm');
        expect(await redirectOf(link, { return_to: 'https://evil.example/', returnTo: 'https://evil.example/' }))
          .toBe(`${scopeOrigin(`${u}.crm`)}/`);
      });

      it('an unknown token is refused with 400 invalid_token and no cookie', async () => {
        const resp = await consumeLink(SELF, `${PLATFORM}/auth/magic-link?token=never-issued`);
        expect(resp.status).toBe(400);
        expect((await resp.json() as { error: string }).error).toBe('invalid_token');
        expect(resp.headers.getSetCookie()).toEqual([]);
      });
    });

    it('GET to a registry endpoint → 405', async () => {
      expect((await SELF.fetch(new Request(authUrl('claim-universe'), { method: 'GET' }))).status).toBe(405);
    });
  });

  describe('the session lifecycle, end to end through the routes', () => {
    it('email-magic-link → 200 (magicLinkUrl in test mode); the page\'s Continue → 200 + cookie; refresh → 200; logout → 200', async () => {
      const u = uni();
      await foundUniverse(SELF, u, 'flow@example.com'); // admin identity now exists

      const ml = await requestMagicLink(SELF, 'flow@example.com');
      expect(ml.status).toBe(200);
      const { magicLinkUrl } = await ml.json() as { magicLinkUrl: string };
      expect(magicLinkUrl).toBeDefined();

      const { refreshToken } = await clickLink(SELF, magicLinkUrl);
      const minted = await refresh(SELF, u, refreshCookie(u, refreshToken));
      expect(minted.status).toBe(200);
      expect((await minted.json() as any).access_token).toBeDefined();

      const logout = await SELF.fetch(logoutRequest([refreshCookie(u, refreshToken)]));
      expect(logout.status).toBe(200);
    });
  });

  describe('no route reads an access token', () => {
    // Every session-lifecycle route authenticates by a link, a cookie or nothing; what a session
    // does is a facade method over the socket. So a valid token buys nothing at any route, and no
    // route answers a person's summary to one. The walk reads the table, so a route added later is
    // walked too.
    it('a valid Bearer token and no cookie get no summary from any route', async () => {
      const u = uni();
      const admin = await foundUniverse(SELF, u, `walk-${u}@example.com`);
      const routes = buildAuthRouteTable(env as Env, recordingHooks);
      expect(routes.length).toBeGreaterThan(10);
      let guarded = 0;
      for (const { path, method } of routes) {
        // Sent as a page on the platform host sends it, so `sameOriginGuard` passes and every row's
        // handler is what answers: a handler that read the token would be reached.
        const resp = await SELF.fetch(new Request(`${PLATFORM}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json',
            Origin: PLATFORM, 'Sec-Fetch-Site': 'same-origin',
          },
          body: method === 'POST' ? '{}' : undefined,
        }));
        const text = await resp.text();
        if (text.includes('cross_origin')) guarded++;
        expect(text, `${method} ${path}`).not.toContain(admin.parsed.profileId);
        expect(text, `${method} ${path}`).not.toContain(u);
      }
      expect(guarded, 'the walk must reach each handler, never the same-origin refusal').toBe(0);
    });

    it('POST /auth/scope-summary → 404, at the Worker and at the Registry', async () => {
      expect((await SELF.fetch(new Request(authUrl('scope-summary'), { method: 'POST' }))).status).toBe(404);
      // In-lane, since nothing reaches the Registry's `fetch` but the Worker's forward: a request
      // straight to it, carrying a forged subject, is not answered with that subject's summary.
      const u = uni();
      const admin = await foundUniverse(SELF, u, `forged-${u}@example.com`);
      const stub = env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
      const resp = await stub.fetch(new Request(authUrl('scope-summary'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifiedProfileId: admin.parsed.profileId, verifiedSub: admin.parsed.sub }),
      }));
      expect(resp.status).toBe(404);
    });

    it('POST /auth/{scope}/invite → 404 (no HTTP invite surface; issuance is mesh-side)', async () => {
      const resp = await SELF.fetch(new Request(authUrl('some-instance/invite'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
      expect(resp.status).toBe(404);
    });

    it('bare instance path with no endpoint → 404', async () => {
      expect((await SELF.fetch(new Request(authUrl('some-bare-instance')))).status).toBe(404);
    });
  });

  describe('registry fetch handler errors', () => {
    it('invalid slug → 400 invalid_slug; reserved slug → 400 reserved_slug', async () => {
      const bad = await SELF.fetch(new Request(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'INVALID_UPPERCASE', email: 'a@b.com' }),
      }));
      expect(bad.status).toBe(400);
      expect((await bad.json() as any).error).toBe('invalid_slug');

      const reserved = await SELF.fetch(new Request(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'platform', email: 'a@b.com' }),
      }));
      expect(reserved.status).toBe(400);
      expect((await reserved.json() as any).error).toBe('reserved_slug');

      // A universe slug that a platform host label already spells is refused, since a universe's host
      // is its slug under `lumenize.dev` (ADR-021). Reds against dropping the RESERVED_UNIVERSE_SLUGS
      // check. Each is a valid slug shape (passes isValidSlug), so only the reservation stops it —
      // this cannot false-pass on the format guard.
      for (const slug of ['platform', 'email', 'www', 'app', 'auth', 'gateway', 'assets', 'studio', 'pictures']) {
        const collide = await SELF.fetch(new Request(authUrl('claim-universe'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, appSlug: 'first', email: 'a@b.com' }),
        }));
        expect(collide.status, `slug "${slug}" must be reserved`).toBe(400);
        expect((await collide.json() as any).error, `slug "${slug}"`).toBe('reserved_slug');
      }
    });
  });
});

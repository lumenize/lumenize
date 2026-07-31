/**
 * Integration — full stack through the Worker router over the registry + KV (the dissolved-DO model,
 * tasks/nebula-auth-surrogate-sub.md). Uses `Browser` from `@lumenize/testing` for automatic RFC 6265
 * path-scoped cookie handling (the same browser holds multiple path-scoped refresh cookies and sends
 * only the matching one per request).
 *
 * Grounding: rung 2 (test-mode issuance) through the real claim → magic-link → refresh → invite paths.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { NEBULA_AUTH_PREFIX } from '../src/types';
import type { NebulaJwtPayload } from '../src/types';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'
const ORIGIN = 'http://localhost';
const authUrl = (path: string) => `${ORIGIN}${PREFIX}/${path}`;
const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;

/** Found a Universe through the browser: claim (mints founder) → click → refresh → admin JWT. */
async function browserFoundUniverse(browser: Browser, slug: string, email: string): Promise<NebulaJwtPayload> {
  const claim = await browser.fetch(authUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, email }),
  });
  expect(claim.status).toBe(200);
  const { magicLinkUrl } = await claim.json() as { magicLinkUrl: string };
  await browser.fetch(magicLinkUrl); // browser captures the path-scoped refresh cookie
  const refresh = await browser.fetch(authUrl(`${slug}/refresh-token`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: slug }),
  });
  expect(refresh.status).toBe(200);
  const { access_token } = await refresh.json() as { access_token: string };
  return parseJwtUnsafe(access_token)!.payload as unknown as NebulaJwtPayload;
}

describe('@lumenize/nebula-auth — Integration', () => {
  describe('Multi-session with path-scoped cookies', () => {
    it('a single browser maintains independent path-scoped sessions across two universes; logout isolates', async () => {
      const browser = new Browser();
      const a = uni();
      const b = uni();
      await browserFoundUniverse(browser, a, 'carol-a@example.com');
      await browserFoundUniverse(browser, b, 'carol-b@example.com');

      // Two distinct path-scoped refresh cookies coexist.
      const cookies = browser.getAllCookies().filter(c => c.name === 'refresh-token');
      expect(cookies.some(c => c.path === `${PREFIX}/${a}`)).toBe(true);
      expect(cookies.some(c => c.path === `${PREFIX}/${b}`)).toBe(true);

      // Both refresh independently.
      for (const s of [a, b]) {
        const r = await browser.fetch(authUrl(`${s}/refresh-token`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeScope: s }),
        });
        expect(r.status).toBe(200);
      }

      // Logout from B revokes only B.
      expect((await browser.fetch(authUrl(`${b}/logout`), { method: 'POST' })).status).toBe(200);
      const afterB = await browser.fetch(authUrl(`${b}/refresh-token`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: b }),
      });
      expect(afterB.status).toBe(401); // B revoked
      const afterA = await browser.fetch(authUrl(`${a}/refresh-token`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: a }),
      });
      expect(afterA.status).toBe(200); // A intact
    });
  });

  describe('Universe admin wildcard reach (cross-scope) + upward-denied', () => {
    it('a universe admin invites a member into a descendant STAR (cross-scope); the member logs in non-admin; a member token cannot reach UP', async () => {
      const browser = new Browser();
      const u = uni();
      const admin = await browserFoundUniverse(browser, u, 'admin@example.com');
      expect(admin.access.authScopePattern).toBe(`${u}.*`);
      expect(admin.access.admin).toBe(true);
      const adminToken = await currentToken(browser, u);

      // Cross-scope invite into a star under the universe (admin's `{u}.*` reaches it).
      const star = `${u}.app.tenant`;
      const inviteResp = await browser.fetch(authUrl(`${star}/invite`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ emails: ['member@example.com'] }),
      });
      expect(inviteResp.status).toBe(200);
      const { links } = await inviteResp.json() as { links: Record<string, string> };
      expect(links['member@example.com']).toBeDefined();

      // The member accepts + logs in — non-admin, exact star pattern.
      const memberBrowser = new Browser();
      await memberBrowser.fetch(links['member@example.com']);
      const memberRefresh = await memberBrowser.fetch(authUrl(`${star}/refresh-token`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: star }),
      });
      expect(memberRefresh.status).toBe(200);
      const memberToken = (await memberRefresh.json() as { access_token: string }).access_token;
      const memberPayload = parseJwtUnsafe(memberToken)!.payload as unknown as NebulaJwtPayload;
      expect(memberPayload.access.authScopePattern).toBe(star);
      expect(memberPayload.access.admin).toBeUndefined();

      // Upward-denied: the member's descendant-scoped token cannot act at the UNIVERSE scope.
      const upward = await memberBrowser.fetch(authUrl(`${u}/invite`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ emails: ['x@example.com'] }),
      });
      expect(upward.status).toBe(403);
      expect((await upward.json() as any).error).toBe('insufficient_scope');
    });
  });

  describe('Self-signup + discovery', () => {
    it('universe self-signup e2e: claim → magic link → founding admin; no email/adminApproved claims; discover records it', async () => {
      const browser = new Browser();
      const slug = uni();
      const email = 'self-signup@example.com';
      const payload = await browserFoundUniverse(browser, slug, email);

      expect(payload.access.admin).toBe(true);
      expect(payload.access.authScopePattern).toBe(`${slug}.*`);
      expect(payload.sub).toBeDefined();
      expect((payload as any).email).toBeUndefined();          // email is NOT a claim
      expect((payload as any).adminApproved).toBeUndefined();  // adminApproved retired

      const discover = await browser.fetch(authUrl('discover'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const entries = await discover.json() as Array<{ universeGalaxyStarId: string; isAdmin: boolean }>;
      expect(entries).toEqual([{ universeGalaxyStarId: slug, isAdmin: true }]);
      expect(entries[0]).not.toHaveProperty('sub');

      // Duplicate claim rejected.
      const dup = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email: 'other@example.com' }),
      });
      expect(dup.status).toBe(409);
    });

    it('star creation e2e (current model): a universe admin creates a galaxy then a star in-session — Scopes-only, wildcard-managed', async () => {
      const browser = new Browser();
      const u = uni();
      await browserFoundUniverse(browser, u, 'owner@example.com');
      const adminToken = await currentToken(browser, u);
      const galaxyId = `${u}.app`;
      expect((await browser.fetch(authUrl('create-galaxy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      })).status).toBe(201);

      // The current star-creation path is create-star (admin, in-session) — a Scopes row, no founder,
      // no email, managed via the admin's `${u}.*` wildcard. (Open star self-signup is a future flow.)
      const starId = `${galaxyId}.dev`;
      const createStar = await browser.fetch(authUrl('create-star'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ universeGalaxyStarId: starId }),
      });
      expect(createStar.status).toBe(201);
      expect((await createStar.json() as any).instanceName).toBe(starId);

      // No local founder identity was minted — the admin manages it via wildcard reach (their `${u}.*`
      // token already covers the star).
      const disc = await SELF.fetch(new Request(authUrl('discover'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com' }),
      }));
      const scopes = (await disc.json() as Array<{ universeGalaxyStarId: string }>).map(e => e.universeGalaxyStarId);
      expect(scopes).toEqual([u]); // only the universe founder identity; no star founder
    });

    it('discovery: two universes for one email → delete one scope → re-discover shows the other', async () => {
      const email = 'multi@example.com';
      const a = uni();
      const b = uni();
      const bA = new Browser();
      await browserFoundUniverse(bA, a, email);
      const bB = new Browser();
      await browserFoundUniverse(bB, b, email);

      const disc = async (): Promise<string[]> => {
        const r = await SELF.fetch(new Request(authUrl('discover'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        }));
        return (await r.json() as Array<{ universeGalaxyStarId: string }>).map(e => e.universeGalaxyStarId).sort();
      };
      expect(await disc()).toEqual([a, b].sort());

      // The B-founder deletes universe B (solo scope → no blockers). Its identity is removed.
      const bToken = await currentToken(bB, b);
      const del = await bB.fetch(authUrl('delete-scope'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bToken}` },
        body: JSON.stringify({ target: b }),
      });
      expect(del.status).toBe(200);
      expect(await disc()).toEqual([a]);
    });
  });
});

/** Re-mint a fresh access token for `scope` from the browser's stored refresh cookie. */
async function currentToken(browser: Browser, scope: string): Promise<string> {
  const r = await browser.fetch(`${ORIGIN}${PREFIX}/${scope}/refresh-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: scope }),
  });
  return (await r.json() as { access_token: string }).access_token;
}

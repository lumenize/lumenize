/**
 * Integration — full stack through the Worker router over the registry + KV (the dissolved-DO model,
 * tasks/archive/nebula-auth-surrogate-sub.md). Uses `Browser` from `@lumenize/testing`, whose jar admits a
 * cookie as a browser does: a `__Host-` cookie set on the platform host stays there, and a page on a
 * scope host gets its token by a credentialed `fetch` that carries the platform host's cookies and
 * names the page in `Origin`.
 *
 * Grounding: rung 2 (test-mode issuance) through the real claim → link page → refresh → invite paths.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import type { AuthClaims } from '../../src/auth/types';
import {
  issueInvitesAs, membershipsOf, registryStub, verifiedClaims, authUrl, scopeOrigin,
} from './test-helpers';

const getRegistry = (): any => env.AUTH_REGISTRY.getByName('registry');
const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;

/** Press a link page's button in `browser`, as the page's own same-origin `POST` does. */
async function consumeIn(browser: Browser, linkUrl: string): Promise<Response> {
  const token = new URL(linkUrl).searchParams.get('token');
  return browser.fetch(authUrl('magic-link'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ token }),
  });
}

/** The refresh as a page on `scope`'s host sends it: credentialed, no body, `Origin` set by the context. */
function refreshFromPage(browser: Browser, scope: string): Promise<Response> {
  return browser.context(scopeOrigin(scope)).fetch(authUrl('refresh-token'), {
    method: 'POST', credentials: 'include',
  });
}

/** Found a Universe through the browser: claim (mints the admin) → the claim page's Accept → refresh. */
async function browserFoundUniverse(browser: Browser, slug: string, email: string): Promise<AuthClaims> {
  const claim = await browser.fetch(authUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, appSlug: 'first', email }),
  });
  expect(claim.status).toBe(200);
  const { magicLinkUrl } = await claim.json() as { magicLinkUrl: string };
  expect((await consumeIn(browser, magicLinkUrl)).status).toBe(200); // the jar captures the cookies
  const refresh = await refreshFromPage(browser, slug);
  expect(refresh.status).toBe(200);
  const { access_token } = await refresh.json() as { access_token: string };
  return parseJwtUnsafe(access_token)!.payload as unknown as AuthClaims;
}

describe('@lumenize/mesh/auth — Integration', () => {
  describe('One browser, one cookie per membership, all on the platform host', () => {
    it('a single browser holds a session per universe, each page gets its own, and one logout ends both', async () => {
      const browser = new Browser();
      const a = uni();
      const b = uni();
      await browserFoundUniverse(browser, a, 'carol-a@example.com');
      await browserFoundUniverse(browser, b, 'carol-b@example.com');

      // Two refresh cookies coexist, each named for its scope, both on the platform host at `/`.
      const cookies = browser.getAllCookies().filter((c) => c.name.startsWith('__Host-refresh-token.'));
      expect(cookies.map((c) => c.name).sort()).toEqual([`__Host-refresh-token.${a}`, `__Host-refresh-token.${b}`].sort());
      for (const c of cookies) expect(c.path).toBe('/');

      // Each page gets a token for its own host.
      for (const s of [a, b]) {
        const r = await refreshFromPage(browser, s);
        expect(r.status).toBe(200);
        const { access_token } = await r.json() as { access_token: string };
        expect(parseJwtUnsafe(access_token)!.payload.aud).toBe(s);
      }

      // Logging out ends every session the browser's cookies name.
      expect((await browser.fetch(authUrl('logout'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}',
      })).status).toBe(200);
      for (const s of [a, b]) expect((await refreshFromPage(browser, s)).status).toBe(401);
    });
  });

  describe('Universe admin wildcard reach (cross-scope invite → member login)', () => {
    // The upward-refusal limb that used to close this test rode the deleted HTTP `/invite` route;
    // that verdict is the mesh facade's now, asserted with distinguishable messages in
    // apps/nebula's baseline lane (`invite-facade.test.ts` — negatives, message-asserted).
    it('a universe admin invites a member into a descendant STAR (cross-scope); the member logs in non-admin', async () => {
      const browser = new Browser();
      const u = uni();
      const admin = await browserFoundUniverse(browser, u, 'admin@example.com');
      expect(admin.access.authScope).toBe(`${u}`);
      expect(admin.access.scopeAdmin).toBe(true);
      const adminToken = await currentToken(browser, u);

      // Cross-scope invite into a star under the universe (admin's `{u}` is above it) — registry
      // issuance under the admin's real claims, as the facade performs it.
      const star = `${u}.app.tenant`;
      const mint = await issueInvitesAs(adminToken, star, [{ email: 'member@example.com' }]);
      expect(mint.errors).toHaveLength(0);
      const link = mint.results[0]?.inviteUrl;
      expect(link).toBeDefined();

      // The member accepts on the invite's page and refreshes from the star's — non-admin, exact star.
      const memberBrowser = new Browser();
      const memberAccept = await consumeIn(memberBrowser, link!);
      expect(memberAccept.status).toBe(200);
      expect((await memberAccept.json() as { redirect: string }).redirect).toBe(`${scopeOrigin(star)}/`);
      const memberRefresh = await refreshFromPage(memberBrowser, star);
      expect(memberRefresh.status).toBe(200);
      const memberToken = (await memberRefresh.json() as { access_token: string }).access_token;
      const memberPayload = parseJwtUnsafe(memberToken)!.payload as unknown as AuthClaims;
      expect(memberPayload.access.authScope).toBe(star);
      expect(memberPayload.access.scopeAdmin).toBeUndefined();
    });
  });

  describe('Self-signup', () => {
    it('universe self-signup e2e: claim → magic link → founding admin; no email/adminApproved claims; the membership records it', async () => {
      const browser = new Browser();
      const slug = uni();
      const email = 'self-signup@example.com';
      const payload = await browserFoundUniverse(browser, slug, email);

      expect(payload.access.scopeAdmin).toBe(true);
      expect(payload.access.authScope).toBe(`${slug}`);
      expect(payload.sub).toBeDefined();
      expect((payload as any).email).toBeUndefined();          // email is NOT a claim
      expect((payload as any).adminApproved).toBeUndefined();  // adminApproved retired

      const entries = await membershipsOf(getRegistry(), email);
      expect(entries).toEqual([{ universeGalaxyStarId: slug, scopeAdmin: true }]);
      expect(entries[0]).not.toHaveProperty('sub');

      // Duplicate claim rejected.
      const dup = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, appSlug: 'first', email: 'other@example.com' }),
      });
      expect(dup.status).toBe(409);
    });

    it('two universes for one email → delete one scope → the other membership remains', async () => {
      const email = 'multi@example.com';
      const a = uni();
      const b = uni();
      const bA = new Browser();
      await browserFoundUniverse(bA, a, email);
      const bB = new Browser();
      await browserFoundUniverse(bB, b, email);

      const disc = async (): Promise<string[]> =>
        (await membershipsOf(getRegistry(), email)).map(e => e.universeGalaxyStarId).sort();
      expect(await disc()).toEqual([a, b].sort());

      // The B admin deletes universe B (solo scope → no blockers). Its identity is removed.
      const bToken = await currentToken(bB, b);
      // The Registry's own method, handed the token's verified claims as the facade hands them.
      await registryStub().executeScopeDeletion(b, await verifiedClaims(bToken));
      expect(await disc()).toEqual([a]);
    });
  });
});

/** Re-mint a fresh access token from a page on `scope`'s host. */
async function currentToken(browser: Browser, scope: string): Promise<string> {
  return (await (await refreshFromPage(browser, scope)).json() as { access_token: string }).access_token;
}

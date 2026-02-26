/**
 * Phase 6: Integration tests — full stack through Worker router
 *
 * Tests the Coach Carol multi-session scenario, cross-scope admin access
 * via wildcard JWTs, and registry flows (self-signup, discovery, galaxy
 * creation) end-to-end through the Worker router with Browser cookie management.
 *
 * Uses Browser from @lumenize/testing for automatic RFC 6265 cookie path
 * scoping — the same browser instance holds multiple path-scoped cookies
 * and sends only the matching one per request.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe, generateUuid } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '../src/types';
import type { NebulaJwtPayload } from '../src/types';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'
const ORIGIN = 'http://localhost';

function authUrl(path: string): string {
  return `${ORIGIN}${PREFIX}/${path}`;
}

/**
 * Browser-based login through Worker router.
 * Returns access token + decoded payload. Browser stores the path-scoped
 * refresh cookie automatically.
 */
async function browserLogin(
  browser: Browser,
  instanceName: string,
  email: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  // 1. Request magic link (test mode returns URL in response)
  const mlResp = await browser.fetch(authUrl(`${instanceName}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as any;
  expect(magic_link).toBeDefined();

  // 2. Click magic link — Browser captures Set-Cookie with path scope
  const clickResp = await browser.fetch(magic_link);
  // Browser follows redirect, but we need the intermediate 302's cookie.
  // Browser.fetch handles redirects and captures cookies from all responses.
  // The final response should be the redirect target (200 from /app or a 404 if /app doesn't exist).

  // 3. Refresh to get JWT — Browser auto-sends matching refresh cookie
  const refreshResp = await browser.fetch(authUrl(`${instanceName}/refresh-token`), {
    method: 'POST',
  });
  expect(refreshResp.status).toBe(200);
  const { access_token } = await refreshResp.json() as any;
  expect(access_token).toBeDefined();

  const { payload } = parseJwtUnsafe(access_token)!;
  return { accessToken: access_token, payload: payload as NebulaJwtPayload };
}

describe('@lumenize/nebula-auth — Integration Tests', () => {

  // ============================================
  // Coach Carol: Multi-Session with Path-Scoped Cookies
  // ============================================

  describe('Coach Carol multi-session scenario', () => {
    it('single browser maintains independent path-scoped sessions across two stars', async () => {
      const browser = new Browser();
      const starA = `acme-${generateUuid().slice(0, 8)}.crm.acme-corp`;
      const starB = `bigco-${generateUuid().slice(0, 8)}.hr.bigco-hq`;
      const carolEmailA = 'carol-a@example.com';
      const carolEmailB = 'carol-b@example.com';

      // --- Step 1: Login to Star A ---
      const loginA = await browserLogin(browser, starA, carolEmailA);
      expect(loginA.payload.access.id).toBe(starA);
      expect(loginA.payload.email).toBe(carolEmailA);

      // Verify refresh cookie is set with correct path
      const cookiesAfterA = browser.getAllCookies();
      const refreshCookieA = cookiesAfterA.find(
        c => c.name === 'refresh-token' && c.path === `${PREFIX}/${starA}`,
      );
      expect(refreshCookieA).toBeDefined();

      // --- Step 2: Login to Star B (same browser) ---
      const loginB = await browserLogin(browser, starB, carolEmailB);
      expect(loginB.payload.access.id).toBe(starB);
      expect(loginB.payload.email).toBe(carolEmailB);

      // Verify second refresh cookie with different path — Star A cookie still exists
      const cookiesAfterB = browser.getAllCookies();
      const refreshCookies = cookiesAfterB.filter(c => c.name === 'refresh-token');
      expect(refreshCookies.length).toBeGreaterThanOrEqual(2);
      expect(refreshCookies.some(c => c.path === `${PREFIX}/${starA}`)).toBe(true);
      expect(refreshCookies.some(c => c.path === `${PREFIX}/${starB}`)).toBe(true);

      // --- Step 3: Refresh Star A --- (only Star A cookie sent)
      const refreshA = await browser.fetch(authUrl(`${starA}/refresh-token`), { method: 'POST' });
      expect(refreshA.status).toBe(200);
      const bodyA = await refreshA.json() as any;
      const payloadA = (parseJwtUnsafe(bodyA.access_token)!.payload as NebulaJwtPayload);
      expect(payloadA.access.id).toBe(starA);

      // --- Step 4: Refresh Star B --- (only Star B cookie sent)
      const refreshB = await browser.fetch(authUrl(`${starB}/refresh-token`), { method: 'POST' });
      expect(refreshB.status).toBe(200);
      const bodyB = await refreshB.json() as any;
      const payloadB = (parseJwtUnsafe(bodyB.access_token)!.payload as NebulaJwtPayload);
      expect(payloadB.access.id).toBe(starB);

      // --- Step 5: Logout from Star B ---
      // Carol logs out from Star B. The logout endpoint revokes the refresh token.
      const logoutResp = await browser.fetch(authUrl(`${starB}/logout`), { method: 'POST' });
      expect(logoutResp.status).toBe(200);

      // Star B refresh now fails (token revoked)
      const refreshB2 = await browser.fetch(authUrl(`${starB}/refresh-token`), { method: 'POST' });
      expect(refreshB2.status).toBe(401);

      // Star A refresh still works
      const refreshA2 = await browser.fetch(authUrl(`${starA}/refresh-token`), { method: 'POST' });
      expect(refreshA2.status).toBe(200);

      // --- Step 6: Cookie isolation assertion ---
      const cookiesForA = browser.getCookiesForRequest(authUrl(`${starA}/refresh-token`));
      const cookiesForB = browser.getCookiesForRequest(authUrl(`${starB}/refresh-token`));
      // Star A has a valid cookie; Star B's was cleared by logout
      expect(cookiesForA).toBeTruthy();
      expect(cookiesForA).not.toContain(starB);
      // Star B should have no cookies (logout cleared them) or they shouldn't reference Star A
      if (cookiesForB) {
        expect(cookiesForB).not.toContain(starA);
      }
    });
  });

  // ============================================
  // Universe Admin: Cross-Scope Wildcard Access
  // ============================================

  describe('Universe admin wildcard access', () => {
    it('universe admin JWT grants access to star-level endpoints via wildcard fallback', async () => {
      const browser = new Browser();
      const universe = `univ-${generateUuid().slice(0, 8)}`;
      const galaxyId = `${universe}.my-app`;
      const starId = `${galaxyId}.tenant-a`;
      const adminEmail = 'universe-admin@example.com';
      const starEmail = 'star-user@example.com';

      // 1. Claim universe via Worker
      const claimResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email: adminEmail }),
      });
      expect(claimResp.status).toBe(200);
      const { magicLinkUrl } = await claimResp.json() as any;

      // 2. Click magic link (founding admin)
      await browser.fetch(magicLinkUrl);

      // 3. Refresh to get wildcard JWT
      const refreshResp = await browser.fetch(authUrl(`${universe}/refresh-token`), {
        method: 'POST',
      });
      expect(refreshResp.status).toBe(200);
      const { access_token } = await refreshResp.json() as any;
      const adminPayload = (parseJwtUnsafe(access_token)!.payload as NebulaJwtPayload);
      expect(adminPayload.access.id).toBe(`${universe}.*`);
      expect(adminPayload.access.admin).toBe(true);
      expect(adminPayload.email).toBe(adminEmail);

      // 4. Create galaxy
      const galaxyResp = await browser.fetch(authUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      });
      expect(galaxyResp.status).toBe(201);

      // 5. Create a star user so the star DO has subjects
      const starBrowser = new Browser();
      await browserLogin(starBrowser, starId, starEmail);

      // 6. Universe admin accesses star-level subjects endpoint (cross-scope)
      const starSubjResp = await browser.fetch(authUrl(`${starId}/subjects`), {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      expect(starSubjResp.status).toBe(200);
      const { subjects } = await starSubjResp.json() as any;
      expect(subjects.some((s: any) => s.email === starEmail)).toBe(true);

      // 7. Cookie path isolation: universe cookie does NOT match star auth path
      const cookiesForStar = browser.getCookiesForRequest(authUrl(`${starId}/refresh-token`));
      // Universe cookie path is /auth/{universe} which should not match /auth/{universe}.my-app.tenant-a
      // (RFC 6265: next char after prefix must be '/', but it's '.')
      if (cookiesForStar) {
        expect(cookiesForStar).not.toContain(`${PREFIX}/${starId}`);
      }
    });

    it('galaxy admin JWT is rejected when accessing universe-level endpoints (upward denied)', async () => {
      const browser = new Browser();
      const universe = `upward-${generateUuid().slice(0, 8)}`;
      const galaxyId = `${universe}.my-app`;
      const adminEmail = 'upward-admin@example.com';
      const galaxyAdminEmail = 'galaxy-admin@example.com';

      // Set up universe + galaxy
      const claimResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email: adminEmail }),
      });
      const { magicLinkUrl } = await claimResp.json() as any;
      await browser.fetch(magicLinkUrl);

      const refreshResp = await browser.fetch(authUrl(`${universe}/refresh-token`), {
        method: 'POST',
      });
      const { access_token: universeToken } = await refreshResp.json() as any;

      // Create galaxy
      await browser.fetch(authUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${universeToken}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      });

      // Login as galaxy admin (founding admin of galaxy DO)
      const galaxyBrowser = new Browser();
      const { accessToken: galaxyToken } = await browserLogin(galaxyBrowser, galaxyId, galaxyAdminEmail);
      const galaxyPayload = (parseJwtUnsafe(galaxyToken)!.payload as NebulaJwtPayload);
      expect(galaxyPayload.access.id).toBe(`${galaxyId}.*`);

      // Galaxy admin tries to access universe-level endpoint → rejected by Worker
      const resp = await galaxyBrowser.fetch(authUrl(`${universe}/subjects`), {
        headers: { 'Authorization': `Bearer ${galaxyToken}` },
      });
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error).toBe('insufficient_scope');
    });
  });

  // ============================================
  // Registry Integration: Self-Signup + Discovery
  // ============================================

  describe('registry integration flows', () => {
    it('universe self-signup e2e: claim → magic link → founding admin → registry records', async () => {
      const browser = new Browser();
      const slug = `signup-${generateUuid().slice(0, 8)}`;
      const email = 'self-signup@example.com';

      // 1. Claim universe
      const claimResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email }),
      });
      expect(claimResp.status).toBe(200);
      const { magicLinkUrl } = await claimResp.json() as any;

      // 2. Click magic link → founding admin
      await browser.fetch(magicLinkUrl);

      // 3. Refresh to get JWT
      const refreshResp = await browser.fetch(authUrl(`${slug}/refresh-token`), {
        method: 'POST',
      });
      expect(refreshResp.status).toBe(200);
      const { access_token } = await refreshResp.json() as any;
      const payload = (parseJwtUnsafe(access_token)!.payload as NebulaJwtPayload);

      // 4. Verify founding admin status
      expect(payload.access.admin).toBe(true);
      expect(payload.adminApproved).toBe(true);
      expect(payload.email).toBe(email);
      expect(payload.access.id).toBe(`${slug}.*`);

      // 5. Verify registry records via discovery
      const discoverResp = await browser.fetch(authUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      expect(discoverResp.status).toBe(200);
      const entries = await discoverResp.json() as any[];
      expect(entries.some((e: any) => e.instanceName === slug && e.isAdmin === true)).toBe(true);

      // 6. Duplicate claim rejected
      const dupResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, email: 'other@example.com' }),
      });
      expect(dupResp.status).toBe(409);
    });

    it('star self-signup e2e: create galaxy → claim star → founding admin', async () => {
      const browser = new Browser();
      const universe = `star-su-${generateUuid().slice(0, 8)}`;
      const galaxyId = `${universe}.my-app`;
      const starId = `${galaxyId}.new-tenant`;
      const universeEmail = 'universe-owner@example.com';
      const starEmail = 'star-founder@example.com';

      // Set up universe + galaxy
      const claimResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email: universeEmail }),
      });
      const { magicLinkUrl } = await claimResp.json() as any;
      await browser.fetch(magicLinkUrl);

      const refreshResp = await browser.fetch(authUrl(`${universe}/refresh-token`), {
        method: 'POST',
      });
      const { access_token } = await refreshResp.json() as any;

      await browser.fetch(authUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      });

      // Claim star (new browser — different user)
      const starBrowser = new Browser();
      const starClaimResp = await starBrowser.fetch(authUrl('claim-star'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universeGalaxyStarId: starId, email: starEmail }),
      });
      expect(starClaimResp.status).toBe(200);
      const starClaim = await starClaimResp.json() as any;
      expect(starClaim.magicLinkUrl).toBeDefined();

      // Click magic link
      await starBrowser.fetch(starClaim.magicLinkUrl);

      // Refresh to get JWT
      const starRefresh = await starBrowser.fetch(authUrl(`${starId}/refresh-token`), {
        method: 'POST',
      });
      expect(starRefresh.status).toBe(200);
      const starBody = await starRefresh.json() as any;
      const starPayload = (parseJwtUnsafe(starBody.access_token)!.payload as NebulaJwtPayload);

      // Verify founding admin
      expect(starPayload.access.id).toBe(starId);
      expect(starPayload.access.admin).toBe(true);
      expect(starPayload.adminApproved).toBe(true);
      expect(starPayload.email).toBe(starEmail);

      // Verify discovery shows star
      const discoverResp = await starBrowser.fetch(authUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: starEmail }),
      });
      expect(discoverResp.status).toBe(200);
      const entries = await discoverResp.json() as any[];
      expect(entries.some((e: any) => e.instanceName === starId)).toBe(true);
    });

    it('discovery flow: multiple scopes → revoke one → re-discover', async () => {
      const browser = new Browser();
      const universe = `disc-${generateUuid().slice(0, 8)}`;
      const galaxyId = `${universe}.app`;
      const starA = `${galaxyId}.star-a`;
      const starB = `${galaxyId}.star-b`;
      const sharedEmail = 'shared-user@example.com';
      const adminEmail = 'disc-admin@example.com';

      // Set up universe + galaxy
      const claimResp = await browser.fetch(authUrl('claim-universe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: universe, email: adminEmail }),
      });
      const { magicLinkUrl } = await claimResp.json() as any;
      await browser.fetch(magicLinkUrl);

      const refreshResp = await browser.fetch(authUrl(`${universe}/refresh-token`), {
        method: 'POST',
      });
      const { access_token: adminToken } = await refreshResp.json() as any;

      await browser.fetch(authUrl('create-galaxy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ universeGalaxyId: galaxyId }),
      });

      // Create two stars with the same email
      const browserA = new Browser();
      await browserLogin(browserA, starA, sharedEmail);

      const browserB = new Browser();
      await browserLogin(browserB, starB, sharedEmail);

      // Discover — both scopes returned
      const discResp1 = await browser.fetch(authUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sharedEmail }),
      });
      expect(discResp1.status).toBe(200);
      const entries1 = await discResp1.json() as any[];
      expect(entries1.some((e: any) => e.instanceName === starA)).toBe(true);
      expect(entries1.some((e: any) => e.instanceName === starB)).toBe(true);

      // Delete subject from Star B (admin uses wildcard JWT)
      // First get the subject's sub
      const subjResp = await browser.fetch(authUrl(`${starB}/subjects`), {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      expect(subjResp.status).toBe(200);
      const { subjects } = await subjResp.json() as any;
      const sharedSub = subjects.find((s: any) => s.email === sharedEmail)?.sub;
      expect(sharedSub).toBeDefined();

      // Delete subject (triggers NA→R registry update)
      const deleteResp = await browser.fetch(authUrl(`${starB}/subject/${sharedSub}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      expect(deleteResp.status).toBe(204);

      // Re-discover — only Star A returned
      const discResp2 = await browser.fetch(authUrl('discover'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sharedEmail }),
      });
      expect(discResp2.status).toBe(200);
      const entries2 = await discResp2.json() as any[];
      expect(entries2.some((e: any) => e.instanceName === starA)).toBe(true);
      expect(entries2.some((e: any) => e.instanceName === starB)).toBe(false);
    });

    it('email field is present in JWT payload', async () => {
      const browser = new Browser();
      const instanceName = `email-jwt-${generateUuid().slice(0, 8)}`;
      const email = 'jwt-email-check@example.com';

      const { payload } = await browserLogin(browser, instanceName, email);

      expect(payload.email).toBe(email);
      expect(payload.sub).toBeDefined();
      expect(payload.access).toBeDefined();
    });
  });
});

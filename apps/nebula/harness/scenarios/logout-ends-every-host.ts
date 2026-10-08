/**
 * **"Log out" ends every host in the browser, records whose sessions ended, and is bounded however
 * many cookies a request forges.**
 *
 * Every refresh cookie lives on the platform host, so one logout there receives all of them, and it
 * ends each: it expires every refresh cookie it was sent and revokes the sessions behind them. A
 * page on any host then finds no session and goes to log in.
 *
 * The cast: **L** owns account `one` and is a member of `two`'s app, so two hosts serve two of L's
 * memberships. **S** is the superuser, holding the platform membership beside an account of their own.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Every host is signed out.** Two of L's pages, on hosts different memberships serve, both
 *     land on the platform host's login when reloaded after one logout. *Reds if the logout ends
 *     only the cookie behind the page that asked.*
 *  2. **The logout records whose sessions ended.** Its revocation lines, read by the logout's own
 *     id, name each of L's two `sub`s with the reason `logout`. *Reds if the revocation is batched
 *     with no subject.*
 *  3. **The platform membership is ended too.** Home lists S's platform row before the logout; after
 *     it, S's old platform cookie, presented again, mints nothing on S's account's page. *Reds if
 *     the logout classifies names with `parseId` alone, which no platform name passes.*
 *  4. **A hundred forged cookies cost a bounded read, and every one is expired.** Home's summary
 *     resolves at most 2 × `MINT_ALL_COOKIE_CAP` of them and never reads a name that parses as no
 *     scope; the logout expires every one and logs one truncation warning. *Reds if either route
 *     resolves past the bound, or the logout expires only what it resolved.*
 *
 * Limbs 2 and 4 read the stack's stdio, which a deployed target does not capture; they say so there.
 *
 * `needsContainer = false` — auth, the Registry and Studio's shell only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { MINT_ALL_COOKIE_CAP } from '@lumenize/nebula-auth/claims';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { inviteViaMesh, readDevVar, waitForHost, NEW_HOST_TIMEOUT_MS, superuserEmail } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite } from '../lib/browser';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, refreshAccessToken, requestUniverseClaim, refreshFromPage, refreshCookie,
  setCookieHeaders,
} from '../../test/lib/email-login';

const SUPERUSER = superuserEmail('logout-superuser@lumenize-test.dev');

export const needsContainer = false;
export const bootVars = {
  NEBULA_AUTH_BOOTSTRAP_EMAIL: SUPERUSER,
  DEBUG: 'nebula-auth.worker.logout,nebula-auth.worker.homeSummary,nebula-auth.Registry.token.revoked',
};

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const observable = stack.logs !== undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const one = testSlug('lo1');
  const two = testSlug('lo2');

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  try {
    /** The one letter a send produces, armed before the send and filtered by its unique recipient. */
    const letterTo = async (to: string, send: () => Promise<unknown>): Promise<string> => {
      const waiter = waitForEmail({ testToken, to, timeout: 120_000 });
      try {
        await send();
        const mail = await waiter.emailPromise;
        const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
        return href ? href.replace(/&amp;/g, '&') : extractMagicLink(mail);
      } finally {
        waiter.cleanup();
      }
    };
    /** Accept on a link's page and wait to land on `host`. */
    const acceptLink = async (page: Page, link: string, host: string) => {
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('consent-checkbox').check();
      await page.getByTestId('consent-nickname').fill('Lou');
      await page.getByTestId('consent-accept').click();
      await page.waitForURL((u) => u.origin === host, { timeout: NEW_HOST_TIMEOUT_MS });
    };
    /** Log out on the platform host's page, as the account menu sends a person there. */
    const logOut = async (page: Page) => {
      await page.goto(`${origin}/auth/logout`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('logout-confirm').click();
      await page.waitForURL((u) => u.origin === origin && u.pathname === '/auth/login', { timeout: 30_000 });
    };
    const onLogin = (u: URL) => u.origin === origin && u.pathname === '/auth/login';

    // ── LIMB 1: every host is signed out ───────────────────────────────────────────────────────
    const l = uniqueTestEmail();
    const context = await browser.newContext();
    const first = await context.newPage();
    await acceptLink(first, await letterTo(l, () => requestUniverseClaim({ baseUrl: origin, universe: one, appSlug: 'crm', email: l })),
      vite.scopeUrl(`${one}.crm`));
    const owner = await provisionAndLogin({ baseUrl: origin, scope: `${two}.web`, testToken });
    const atTwo = await refreshAccessToken(origin, owner.session, `${two}.web`);
    // Before the waiter is armed: on a deployed target this app's host answers only once its certificate
    // is issued, which can outlast the waiter, and the invite dials it.
    await waitForHost(vite.scopeUrl(`${two}.web`));
    const second = await context.newPage();
    await acceptLink(second, await letterTo(l, () => inviteViaMesh(stack, atTwo, `${two}.web`, [{ email: l }], undefined, { scopeUrl: vite.scopeUrl, platformOrigin: origin })),
      vite.scopeUrl(`${two}.web`));
    // Each page's own refresh names the membership its host rests on.
    const subOn = (page: Page) => page.evaluate(async (refresh) => {
      const res = await fetch(refresh, { method: 'POST', credentials: 'include' });
      return (await res.json() as { sub?: string }).sub;
    }, `${origin}/auth/refresh-token`);
    const subs = [await subOn(first), await subOn(second)];
    assert.ok(subs[0] && subs[1] && subs[0] !== subs[1], `L's two hosts must rest on two memberships: ${JSON.stringify(subs)}`);
    await logOut(second);
    for (const [page, host] of [[first, `${one}.crm`], [second, `${two}.web`]] as const) {
      await page.goto(`${vite.scopeUrl(host)}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(onLogin, { timeout: 30_000 });
    }
    console.error("  ✓ limb 1 — after one logout, both of L's hosts sent their reload to log in");

    // ── LIMB 2: the logout records whose sessions ended ────────────────────────────────────────
    if (observable) {
      // L's is this run's first logout. Its app invite co-minted a `.dev` membership too, so it ends
      // three sessions; the two whose pages were open must each be named.
      const isDone = (x: DebugLine) => x.namespace === 'nebula-auth.worker.logout' && x.message === 'logged out';
      const all = await waitForDebugLines(stack, (a) => a.some(isDone), "L's logout completion line");
      const op = all.find(isDone)!.data.operationId;
      const named = all.filter((x) => x.namespace === 'nebula-auth.Registry.token.revoked' && x.data.operationId === op)
        .map((x) => `${x.data.subjectSub}:${x.data.reason}`);
      for (const sub of subs) {
        assert.ok(named.includes(`${sub}:logout`), `the logout's revocations must name ${sub}, reason logout: ${JSON.stringify(named)}`);
      }
      console.error('  ✓ limb 2 — the logout recorded both of L\'s subs, reason logout');
    } else {
      console.error('[logout-ends-every-host] limb 2: not observable on a deployed target');
    }
    await context.close();

    // ── LIMB 3: the platform membership is ended too ───────────────────────────────────────────
    const sContext = await browser.newContext();
    const sPage = await sContext.newPage();
    const own = testSlug('lo3');
    await acceptLink(sPage, await letterTo(SUPERUSER, () => requestUniverseClaim({ baseUrl: origin, universe: own, appSlug: 'crm', email: SUPERUSER })),
      vite.scopeUrl(`${own}.crm`));
    // The claim's consume placed the platform membership's cookie too, pending; Home lists it under
    // S's address with a Confirm badge, and its Accept takes it up.
    // Pending on every local boot; a deployed target keeps its superuser, so after the first run the
    // membership is accepted already and its row has nothing to open.
    await sPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const platformRow = sPage.getByRole('button', { name: /_platform/ });
    await platformRow.waitFor({ state: 'visible', timeout: 30_000 });
    if (await platformRow.isEnabled()) {
      await platformRow.click();
      await sPage.getByTestId('consent-checkbox').check();
      await sPage.getByTestId('consent-nickname').fill('Sue');
      await sPage.getByTestId('consent-accept').click();
      await sPage.getByTestId('consent-checkbox').waitFor({ state: 'detached', timeout: 30_000 });
    }
    // Read through the context's own request client, which carries its cookies and no page's origin.
    const listed = await (await sContext.request.post(`${origin}/auth/home-summary`, { data: {} })).text();
    assert.match(listed, /"scope":"_platform"/, "Home's summary must list S's platform row before the logout");
    const platformCookie = (await sContext.cookies()).find((c) => c.name === '__Host-refresh-token._platform');
    assert.ok(platformCookie, 'S must hold the platform cookie before the logout — the positive control');
    await logOut(sPage);
    // Within KV's propagation window, about 60 s (`security.md` § *Refresh tokens*): the Registry
    // deletes the record from its own colo, and a refresh served from another reads its cached copy
    // until then. Checked at once, it minted on a deployed sweep at concurrency 4 (2026-10-07). A
    // logout that missed the platform session never turns 401.
    const mintAfterLogout = () => refreshFromPage(stack.baseUrl, own, refreshCookie('_platform', platformCookie.value));
    const loggedOutAt = Date.now();
    let after = await mintAfterLogout();
    while (after.status !== 401 && Date.now() - loggedOutAt < 75_000) {
      await after.body?.cancel();
      await new Promise((r) => setTimeout(r, 2_000));
      after = await mintAfterLogout();
    }
    assert.equal(after.status, 401, "within 75 s of the logout, S's platform cookie must mint nothing");
    await sContext.close();
    console.error("  ✓ limb 3 — the logout ended S's platform session as well as the account's");

    // ── LIMB 4: a hundred forged cookies cost a bounded read, and every one is expired ─────────
    const bound = 2 * MINT_ALL_COOKIE_CAP;
    const forged = Array.from({ length: 100 }, (_, i) => refreshCookie(`forge${i}${suffix}`, crypto.randomUUID()));
    const unparseable = refreshCookie('not.a.real.scope.at.all', crypto.randomUUID());
    const cookie = [...forged, unparseable].join('; ');
    const summary = await fetch(`${stack.baseUrl}/auth/home-summary`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }, body: '{}',
    });
    assert.equal(summary.status, 401, 'a hundred forged cookies hold no live session');
    const logout = await fetch(`${stack.baseUrl}/auth/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }, body: '{}',
    });
    assert.equal(logout.status, 200, 'the logout must answer a forged jar too');
    const expired = setCookieHeaders(logout).filter((c) => /Max-Age=0/.test(c));
    assert.equal(expired.length, 101, 'the logout must expire every refresh cookie it was sent, unparseable ones included');
    // The unparseable name on its own, beside one forged cookie and far under the bound, where only
    // dropping it keeps it from being read: in the hundred it sorts last, past the bound either way.
    const lone = testSlug('lone');
    const small = await fetch(`${stack.baseUrl}/auth/home-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: [refreshCookie(lone, crypto.randomUUID()), unparseable].join('; ') },
      body: '{}',
    });
    assert.equal(small.status, 401, 'two forged cookies hold no live session');
    await small.text();
    if (observable) {
      const truncation = (ns: string) => (x: DebugLine) => x.namespace === ns && x.message === 'truncated' && x.data.received === 100;
      const all = await waitForDebugLines(stack, (a) => a.some(truncation('nebula-auth.worker.homeSummary'))
        && a.some(truncation('nebula-auth.worker.logout')), 'both routes\' truncation warnings');
      const op = all.find(truncation('nebula-auth.worker.homeSummary'))!.data.operationId;
      const resolved = all.filter((x) => x.namespace === 'nebula-auth.worker.homeSummary' && x.message === 'resolve' && x.data.operationId === op);
      assert.equal(resolved.length, bound, `Home's summary must resolve exactly the bound, ${bound}`);
      const isLone = (x: DebugLine) => x.namespace === 'nebula-auth.worker.homeSummary' && x.message === 'resolve' && x.data.scope === lone;
      const withLone = await waitForDebugLines(stack, (a) => a.some(isLone), "the small summary's resolve line");
      const smallOp = withLone.find(isLone)!.data.operationId;
      assert.deepEqual(withLone.filter((x) => x.namespace === 'nebula-auth.worker.homeSummary' && x.message === 'resolve'
        && x.data.operationId === smallOp).map((x) => x.data.scope), [lone], 'a name that parses as no scope must be dropped unread');
      assert.equal(all.filter(truncation('nebula-auth.worker.logout')).length, 1, 'the logout must log one truncation warning');
      console.error(`  ✓ limb 4 — the summary resolved ${bound} of 100, the logout expired all 101 and warned once`);
    } else {
      console.error('[logout-ends-every-host] limb 4: the stdio half is not observable on a deployed target');
    }
  } finally {
    await vite.close();
    await browser.close();
  }
}

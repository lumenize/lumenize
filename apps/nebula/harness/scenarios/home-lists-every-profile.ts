/**
 * **Home shows every Profile the browser holds, marks what this browser cannot open, asks for
 * nothing but picking and consent, and steps aside for someone with one place to work.**
 *
 * Home lives on the platform host and reads one route, `POST /auth/home-summary`, by the browser's
 * cookies. A browser can hold two people's sessions — two addresses, two Profiles — and a Profile can
 * hold a membership this browser has no cookie for, accepted on another device. Home has to show the
 * first and say so about the second, because opening that row's host here would only answer 401.
 *
 * The cast: **A** and **B** sign up in one browser, X, each with an account and its first app. **C**
 * owns a third account and invites A into its app; A accepts in a second browser, Y. **D** signs up
 * alone in a third.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Two addresses in one browser show as two Profiles.** Home's summary request carries both
 *     accounts' cookie names, and Home renders a group for each. *Reds if the summary reads only the
 *     first cookie — B's group is missing.*
 *  2. **A membership this browser holds no cookie for is marked for a fresh login.** After A accepts
 *     C's invite in Y, Home in X lists that app under A, marked; A's own account is not. *Reds if
 *     every row reads as reachable from here.*
 *  3. **Home's page sends no request but the summary and the consent pair.** Every request the page
 *     made across both loads was a `home-summary`, a `pending-membership` or an `accept-membership`
 *     `POST`, and it opened no socket. *Reds if Home gains an acting route.*
 *  4. **Someone whose one account holds one app goes straight into its Studio.** D, signed up alone,
 *     opens Home and lands on the app's host. *Reds if Home stops at the account's page instead.*
 *
 * `needsContainer = false` — auth, Home and Studio's shell only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { inviteViaMesh, readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';

export const needsContainer = false;

/** The routes Home may call. Anything else it sends is an action it does not own. */
const HOME_ROUTES = new Set(['POST /auth/home-summary', 'POST /auth/pending-membership', 'POST /auth/accept-membership']);

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const suffix = crypto.randomUUID().slice(0, 8);
  const [ua, ub, uc, ud] = ['ha', 'hb', 'hc', 'hd'].map((p) => `${p}${suffix}`);
  const [a, b, c, d] = [uniqueTestEmail(), uniqueTestEmail(), uniqueTestEmail(), uniqueTestEmail()];

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  try {
    // A and B sign up in one browser, X; C in its own; each lands in its first app's Studio.
    const x = await instrumentedPage(browser);
    await signUpInBrowser(x, origin, { universe: ua, appSlug: 'crm', email: a, nickname: 'Ay', testToken });
    await signUpInBrowser(x, origin, { universe: ub, appSlug: 'crm', email: b, nickname: 'Bee', testToken });
    const w = await instrumentedPage(browser);
    await signUpInBrowser(w, origin, { universe: uc, appSlug: 'crm', email: c, nickname: 'Cee', testToken });

    // Home in a new tab of X, recording every request the page makes that is not a page load.
    const home = await x.page.context().newPage();
    const sent: string[] = [];
    // A WebSocket handshake never fires `request`, only `websocket`. Only the Gateway's counts: the
    // local stack's vite also opens its hot-reload socket on every page it serves.
    home.on('websocket', (ws) => {
      const path = new URL(ws.url()).pathname;
      if (path.startsWith('/gateway')) sent.push(`SOCKET ${path}`);
    });
    home.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() !== 'GET' || u.pathname.startsWith('/auth/')) sent.push(`${r.method()} ${u.pathname}`);
    });
    const loadHome = async (page: Page) => {
      const summary = page.waitForRequest((r) => new URL(r.url()).pathname === '/auth/home-summary');
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      const cookies = (await (await summary).allHeaders()).cookie ?? '';
      await page.getByTestId('home-group').first().waitFor({ state: 'visible', timeout: 30_000 });
      return cookies;
    };

    // ── LIMB 1: two addresses in one browser show as two Profiles ──────────────────────────────
    const cookieHeader = await loadHome(home);
    for (const u of [ua, ub]) {
      assert.ok(cookieHeader.includes(`__Host-refresh-token.${u}=`), `Home's summary request must carry ${u}'s cookie`);
    }
    const groups = home.getByTestId('home-group');
    await groups.nth(1).waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await groups.count(), 2, "two addresses' sessions must show as two Profiles");
    const texts = await groups.allInnerTexts();
    for (const u of [ua, ub]) {
      assert.ok(texts.some((t) => t.includes(u)), `a Profile group must list ${u}: ${JSON.stringify(texts)}`);
    }
    console.error('  ✓ limb 1 — both cookies rode the summary, and Home showed a group for each Profile');

    // ── LIMB 2: a membership this browser holds no cookie for is marked ────────────────────────
    const atC = await w.page.evaluate(async (refresh) => {
      const res = await fetch(refresh, { method: 'POST', credentials: 'include' });
      return await res.json() as { access_token: string; sub: string };
    }, `${origin}/auth/refresh-token`);
    const waiter = waitForEmail({ testToken, to: a, timeout: 120_000 });
    let link: string;
    try {
      await inviteViaMesh(stack, { accessToken: atC.access_token, sub: atC.sub }, `${uc}.crm`, [{ email: a }], 'Cee',
        { scopeUrl: vite.scopeUrl, platformOrigin: origin });
      const mail = await waiter.emailPromise;
      link = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1]?.replace(/&amp;/g, '&') ?? extractMagicLink(mail);
    } finally {
      waiter.cleanup();
    }
    const y = await (await browser.newContext()).newPage();
    await y.goto(link, { waitUntil: 'domcontentloaded' });
    await y.getByTestId('consent-checkbox').check({ timeout: 30_000 });
    await y.getByTestId('consent-nickname').fill('Ay');
    await y.getByTestId('consent-accept').click();
    await y.waitForURL((u) => u.origin === vite.scopeUrl(`${uc}.crm`), { timeout: 30_000 });
    await y.context().close();

    await loadHome(home);
    const row = (scope: string) => home.locator(`[data-testid="home-row"][data-scope="${scope}"]`);
    await row(`${uc}.crm`).waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await row(`${uc}.crm`).getByTestId('home-relogin').count(), 1,
      "the app A accepted elsewhere must be marked for a fresh login here");
    assert.equal(await row(ua).getByTestId('home-relogin').count(), 0,
      "A's own account, whose cookie this browser holds, must not be marked — the positive control");
    console.error("  ✓ limb 2 — the app A accepted in another browser was marked; A's own account was not");

    // ── LIMB 3: Home's page sends no request but the summary and the consent pair ──────────────
    assert.ok(sent.includes('POST /auth/home-summary'), "Home must read its summary — the positive control");
    const stray = sent.filter((s) => !HOME_ROUTES.has(s));
    assert.deepEqual(stray, [], `Home must send nothing but its summary and the consent pair: ${JSON.stringify(stray)}`);
    console.error('  ✓ limb 3 — across two loads Home sent only its summary, and opened no socket');

    // ── LIMB 4: one account with one app goes straight into its Studio ─────────────────────────
    const z = await instrumentedPage(browser);
    await signUpInBrowser(z, origin, { universe: ud, appSlug: 'crm', email: d, nickname: 'Dee', testToken });
    await z.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await z.page.waitForURL((u) => u.origin === vite.scopeUrl(`${ud}.crm`), { timeout: 30_000 });
    console.error("  ✓ limb 4 — D's Home stepped aside into the one app's Studio");
  } finally {
    await browser.close();
    await vite.close();
  }
}

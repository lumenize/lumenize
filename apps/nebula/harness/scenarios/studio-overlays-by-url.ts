/**
 * **An overlay a person would send a link to has the URL as its ONLY opener (ADR-017).**
 *
 * The profile editor and the Universe page's create form are what a person is
 * LOOKING AT, so they ride the URL like a tab: a button navigates, Back closes, a reload keeps
 * them, and the page renders them from the URL — or declines when the state does not allow. Before
 * this, each was a local boolean nothing outside the page could reach, so a scenario had to click
 * its way in and a shared link could not point at any of them.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Signed out, `?profile` is declined**: the page goes to log in, and no editor opens. First,
 *     so a mutation that lets the URL summon an overlay regardless of state reds HERE and nowhere
 *     earlier.
 *  2. **An account with no apps arrives at `?create`, the form open.** The claim wrote a first app,
 *     so the person deletes it first, through their own session and the facade's `delete`.
 *     *Reds if the auto-open goes back to local state, or stops firing on an empty account.*
 *  3. **Creating an app through that form lands in its workspace** — the fixture for everything
 *     below, made by the real flow.
 *  4. **`?profile` by URL alone opens the editor, seeded from the live profile.** *Reds if the
 *     editor stops reading the URL, or if the seed only runs on the button path.*
 *  5. **Back closes it** and leaves the workspace in place.
 *  6. **The button path goes THROUGH the URL**: the avatar menu's Profile lands on `?profile`, and
 *     Back closes it without leaving the page. *Reds if open rewrote the entry in place.*
 *  8. **A shared link opened signed out comes BACK after the real letter, in another browser,
 *     fragment included** — the page sends the visitor to log in, the letter is opened in a second
 *     browser context, and that context lands on the link's own URL with its view open, not Home
 *     and not the scope root. *Reds if `return_to` is not carried on the letter's record, not
 *     honoured, or if Home's fast-forward wins.*
 *
 * Retired with the Manage panel this build deletes (Home takes its list): limb 7, `?manage` opening
 * the panel by URL with its rows loaded.
 *
 * The stream transcript (`?transcript={messageId}`) needs a live turn and is covered where one
 * exists, `first-app-built`. `needsContainer = false` — no build.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { refreshAccessToken, refreshCookie } from '../../test/lib/email-login';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';

export const needsContainer = false;

const COMPOSER = 'Describe a change…';
const NICKNAME = 'Robin Overlay';

/** Wait for the profile editor's nickname field to hold `NICKNAME`, failing with `message`. */
async function seeded(page: import('playwright').Page, message: string): Promise<void> {
  try {
    await page.waitForFunction((expected) =>
      (document.querySelector('[data-testid="profile-nickname"]') as HTMLInputElement | null)?.value === expected,
    NICKNAME, { timeout: 20_000 });
  } catch {
    assert.fail(`${message}: the field holds ${JSON.stringify(await page.getByTestId('profile-nickname').inputValue())}`);
  }
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('overlay');
  const galaxy = `${universe}.wishlist`;
  const person = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    const studio = vite.scopeUrl(galaxy);
    const onLogin = (u: URL) => u.origin === vite.viteBaseUrl && u.pathname === '/auth/login';
    // The claim writes the account's first app, `first`; limb 2 deletes it.
    await signUpInBrowser(inst, vite.viteBaseUrl, {
      universe, appSlug: 'first', email: person, nickname: NICKNAME, testToken,
    });

    // ── LIMB 1: signed out, the URL is declined ────────────────────────────────────────────────
    // At the first app, which exists by now: on a deployed target a host answers only for an app
    // that does, since its certificate comes with the app.
    const stranger = await browser.newContext();
    try {
      const p2 = await stranger.newPage();
      await p2.goto(`${vite.scopeUrl(`${universe}.first`)}/?profile`, { waitUntil: 'domcontentloaded' });
      await p2.waitForURL(onLogin, { timeout: 30_000 });
      await p2.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 20_000 });
      assert.equal(await p2.getByTestId('profile-nickname').count(), 0, 'signed out, ?profile must not open an editor');
    } finally {
      await stranger.close();
    }
    console.error('  ✓ limb 1 — signed out, ?profile goes to log in and opens no editor');

    // ── LIMB 2: an account with no apps arrives at ?create, the form open ─────────────────────
    // The person deletes the claim's first app with their own session — the cookie this browser
    // holds, refreshed into a token — through the facade, which is the call the client makes.
    const cookieName = refreshCookie(universe, '').slice(0, -1);
    const cookie = (await page.context().cookies()).find((c) => c.name === cookieName);
    assert.ok(cookie, `the signed-up browser holds no ${cookieName} cookie`);
    const owner = await connectDriver(stack, {
      scope: universe,
      session: await refreshAccessToken(stack.baseUrl, { refreshToken: cookie.value, authScope: universe }, universe),
    });
    try {
      await owner.client.scopes.delete(`${universe}.first`);
    } finally {
      owner.dispose();
    }
    await page.goto(`${vite.scopeUrl(universe)}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\?create(?:[&#]|$)/, { timeout: 30_000 });
    await page.getByText('No apps yet. Create your first one to start building.')
      .waitFor({ state: 'visible', timeout: 20_000 });
    const slugField = page.getByPlaceholder('crm');
    await slugField.waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 2 — an account with no apps arrives at ?create with the form open');

    // ── LIMB 3: create the app through the form ────────────────────────────────────────────────
    await slugField.fill('wishlist');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    // On the deployed target the new app's host has no certificate yet, so the account's page holds
    // behind the count-up first; locally the host answers at once and none renders.
    if (process.env.HARNESS_TARGET_URL) {
      const accountPage = new URL(page.url()).origin;
      await page.getByTestId('host-wait').waitFor({ state: 'visible', timeout: 60_000 });
      assert.equal(new URL(page.url()).origin, accountPage, "the count-up must hold on the account's page");
    }
    await page.waitForURL((u) => u.origin === studio, { timeout: NEW_HOST_TIMEOUT_MS });
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    console.error('  ✓ limb 3 — the app exists and its workspace is open');

    // ── LIMB 4: ?profile by URL alone ──────────────────────────────────────────────────────────
    await page.goto(`${studio}/?profile`, { waitUntil: 'domcontentloaded' });
    const nick = page.getByTestId('profile-nickname');
    await nick.waitFor({ state: 'visible', timeout: 30_000 });
    await seeded(page, 'the editor opened by URL must be seeded from the live profile');
    console.error('  ✓ limb 4 — ?profile opens the editor by URL, seeded from the profile');

    // ── LIMB 5: Back closes it, workspace intact ───────────────────────────────────────────────
    await page.goBack();
    await nick.waitFor({ state: 'hidden', timeout: 20_000 });
    assert.ok(!new URL(page.url()).searchParams.has('profile'), 'Back must leave a URL without ?profile');
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 30_000 });
    console.error('  ✓ limb 5 — Back closes the editor and the workspace is still there');

    // ── LIMB 6: the button path goes through the URL, and Back closes without leaving ──────────
    await page.locator('button[title="Account"]').click();
    await page.getByTestId('menu-profile').click();
    await nick.waitFor({ state: 'visible', timeout: 20_000 });
    assert.ok(new URL(page.url()).searchParams.has('profile'), 'the Profile button must open the editor BY NAVIGATING to ?profile');
    await page.goBack();
    await nick.waitFor({ state: 'hidden', timeout: 20_000 });
    assert.ok(new URL(page.url()).origin === studio && new URL(page.url()).pathname === '/',
      `Back must close the editor in place, not leave the workspace (now at ${page.url()})`);
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 6 — the button navigates to ?profile; Back closes it in place');

    // ── LIMB 8: a shared link opened signed out comes BACK after the real letter ───────────────
    // The whole point of a shareable URL, for the person it is most for: signed out, the page sends
    // them to log in, and the letter — opened in ANOTHER browser, as on a phone — lands on the link's
    // own URL, fragment included, not Home and not the scope root. Home's fast-forward would send a
    // lone-membership account to the universe's page; the record's `return_to` outranks it.
    const shared = `${studio}/?profile#limb-8`;
    const sender = await browser.newContext();
    const receiver = await browser.newContext();
    try {
      const p3 = await sender.newPage();
      await p3.goto(shared, { waitUntil: 'domcontentloaded' });
      await p3.waitForURL(onLogin, { timeout: 30_000 });
      assert.equal(new URL(p3.url()).searchParams.get('return_to'), shared, 'the login must carry the whole URL, fragment included');
      await p3.getByPlaceholder('you@example.com').fill(person);
      const waiter = waitForEmail({ testToken, to: person, timeout: 120_000 });
      let link: string;
      try {
        await p3.getByRole('button', { name: /Email me a link/ }).click();
        await p3.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
        link = extractMagicLink(await waiter.emailPromise);
      } finally {
        waiter.cleanup();
      }
      const p4 = await receiver.newPage();
      await p4.goto(link, { waitUntil: 'domcontentloaded' });
      await p4.getByTestId('link-continue').click();
      await p4.waitForURL((u) => u.href === shared, { timeout: 30_000 });
      await p4.getByTestId('profile-nickname').waitFor({ state: 'visible', timeout: 30_000 });
      // A cold load opens the editor before the profile arrives, and the editor seeds itself when it
      // does (App.vue's seed watcher) — so wait for the seed rather than read the field at once.
      await seeded(p4, "the shared link's view must open, seeded from the profile");
    } finally {
      await sender.close();
      await receiver.close();
    }
    console.error('  ✓ limb 8 — the shared ?profile link opened signed out came back, fragment and all, in another browser');

  } finally {
    await vite.close();
    await browser.close();
  }
}

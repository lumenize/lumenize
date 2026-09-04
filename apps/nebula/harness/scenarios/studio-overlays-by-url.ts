/**
 * **An overlay a person would send a link to has the URL as its ONLY opener (ADR-017).**
 *
 * The profile editor, the manage panel and the Universe page's create form are what a person is
 * LOOKING AT, so they ride the URL like a tab: a button navigates, Back closes, a reload keeps
 * them, and the page renders them from the URL — or declines when the state does not allow. Before
 * this, each was a local boolean nothing outside the page could reach, so a scenario had to click
 * its way in and a shared link could not point at any of them.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Signed out, `?profile` is declined**: the landing renders, no editor. First, so a mutation
 *     that lets the URL summon an overlay regardless of state reds HERE and nowhere earlier.
 *  2. **An empty account's create form IS the URL.** Arriving with no apps rewrites to `?create`
 *     and the form is open. *Reds if the auto-open goes back to local state.*
 *  3. **Creating the app lands in its workspace** — the fixture for everything below, made by the
 *     real flow.
 *  4. **`?profile` by URL alone opens the editor, seeded from the live profile.** *Reds if the
 *     editor stops reading the URL, or if the seed only runs on the button path.*
 *  5. **Back closes it** and leaves the workspace in place.
 *  6. **The button path goes THROUGH the URL**: the avatar menu's Profile lands on `?profile`, and
 *     Back closes it without leaving the page. *Reds if open rewrote the entry in place.*
 *  7. **`?manage` by URL alone opens the panel WITH its rows loaded.** The rows are the
 *     discriminating half — the heading alone would pass a panel the URL opened but never loaded.
 *
 * The stream transcript (`?transcript={messageId}`) needs a live turn and is covered where one
 * exists, `first-app-built`. `needsContainer = false` — no build.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';

export const needsContainer = false;

const COMPOSER = 'Describe a change…';

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = `overlay-${crypto.randomUUID().slice(0, 8)}`;
  const galaxy = `${universe}.wishlist`;
  const NICKNAME = 'Robin Overlay';

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    // ── LIMB 1: signed out, the URL is declined (before any sign-up — the app need not exist) ──────
    const stranger = await browser.newContext();
    try {
      const p2 = await stranger.newPage();
      await p2.goto(`${vite.viteBaseUrl}/${galaxy}?profile`, { waitUntil: 'domcontentloaded' });
      await p2.getByTestId('landing').waitFor({ state: 'visible', timeout: 30_000 });
      // A closed <dialog> keeps its inputs in the DOM; visibility is the property.
      assert.equal(await p2.getByTestId('profile-nickname').isVisible(), false, 'signed out, ?profile must not open an editor');
    } finally {
      await stranger.close();
    }
    console.error('  ✓ limb 1 — signed out, ?profile renders the landing and no editor');

    await signUpInBrowser(inst, vite.viteBaseUrl, { universe, email: uniqueTestEmail(), nickname: NICKNAME, testToken });

    // ── LIMB 2: the empty account's create form is the URL ─────────────────────────────────────
    await page.waitForURL(/\?create(?:[&#]|$)/, { timeout: 30_000 });
    const slugField = page.getByPlaceholder('crm');
    await slugField.waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 2 — an empty account arrives at ?create with the form open');

    // ── LIMB 3: create the app through the form ────────────────────────────────────────────────
    await slugField.fill('wishlist');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(new RegExp(`//[^/]+/${galaxy.replace('.', '\\.')}(?:[/?#]|$)`), { timeout: 60_000 });
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
    console.error('  ✓ limb 3 — the app exists and its workspace is open');

    // ── LIMB 4: ?profile by URL alone ──────────────────────────────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/${galaxy}?profile`, { waitUntil: 'domcontentloaded' });
    const nick = page.getByTestId('profile-nickname');
    await nick.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await nick.inputValue(), NICKNAME, 'the editor opened by URL must be seeded from the live profile');
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
    assert.ok(new URL(page.url()).pathname.endsWith(`/${galaxy}`), `Back must close the editor in place, not leave the workspace (now at ${page.url()})`);
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 6 — the button navigates to ?profile; Back closes it in place');

    // ── LIMB 7: ?manage by URL, rows loaded ────────────────────────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/${galaxy}?manage`, { waitUntil: 'domcontentloaded' });
    const panel = page.getByTestId('manage-panel');
    await panel.waitFor({ state: 'visible', timeout: 30_000 });
    await panel.getByText(galaxy, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    console.error('  ✓ limb 7 — ?manage opens the panel by URL and its rows are loaded');

  } finally {
    await vite.close();
    await browser.close();
  }
}

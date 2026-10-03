/**
 * **An invite lands on the invited scope's host — and a person stopped by a 401 there is offered
 * the consent they still owe, rather than a login that would bring them back to the same 401.**
 *
 * Every invite here is sent from the inviter's page on vite's port, the way a person sends one from
 * Studio, so the Gateway stamps that page's origin and every link the invite composes names the
 * page a person would be on.
 *
 * The cast: **O** owns the account. **M** is a member already, invited again. **P** was invited and
 * signed in through a plain link without accepting. **R** opens an invite whose query someone has
 * extended with a `return_to` of their own.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **A re-invite lands on its scope's host.** M's second letter carries no token and links to
 *     the galaxy's own host; followed as sent in M's browser, it lands there and Studio connects.
 *     *Reds if the letter links to a path the host model deleted.*
 *  2. **A 401 with a pending membership offers its consent.** P, holding the invite's cookie but no
 *     acceptance, visits the invite's host; its 401 sends P to the platform host, which shows that
 *     membership's consent rather than the login form. *Reds if the login is shown — P would sign
 *     in and come back to the same 401.*
 *  3. **An invite's destination is the server's, whatever the link's query says.** R's invite link
 *     with `return_to` naming another app's host still lands on the invite's host after Accept.
 *     *Reds if the consume takes `return_to` from the link.*
 *
 * `needsContainer = false` — auth, the facade and Studio's shell only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { inviteViaMesh, readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite } from '../lib/browser';
import { provisionAndLogin, refreshAccessToken, requestMagicLink } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';

export const needsContainer = false;

const COMPOSER = 'Describe a change…';

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  // The run's shared app; `other` names an app this scenario never creates, for a tampered return.
  const app = await sharedApp(stack, testToken);
  const universe = app.universe;
  const galaxy = app.galaxy;
  const other = `${universe}.${testSlug('web')}`;

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  try {
    const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: app.ownerEmail, testToken });
    const atGalaxy = await refreshAccessToken(origin, owner.session, galaxy);

    /** O's invite, sent from the galaxy's page on vite's port, and the letter's one link. */
    const invite = async (email: string): Promise<string> => {
      const waiter = waitForEmail({ testToken, to: email, timeout: 120_000 });
      try {
        const summary = await inviteViaMesh(stack, atGalaxy, galaxy, [{ email }], 'Olive',
          { scopeUrl: vite.scopeUrl, platformOrigin: origin });
        assert.deepEqual(summary.errors, [], `the invite failed: ${JSON.stringify(summary.errors)}`);
        const href = /href="([^"]+)"/.exec((await waiter.emailPromise).html ?? '')?.[1];
        assert.ok(href, 'the invite letter carried no link');
        return href.replace(/&amp;/g, '&');
      } finally {
        waiter.cleanup();
      }
    };
    /** Accept on a link's page, as a person does. */
    const acceptOn = async (page: import('playwright').Page) => {
      await page.getByTestId('consent-checkbox').check();
      await page.getByTestId('consent-nickname').fill('Guest');
      await page.getByTestId('consent-accept').click();
    };

    // ── LIMB 1: a re-invite lands on its scope's host ──────────────────────────────────────────
    const m = uniqueTestEmail();
    const mPage = await (await browser.newContext()).newPage();
    await mPage.goto(await invite(m), { waitUntil: 'domcontentloaded' });
    await acceptOn(mPage);
    await mPage.waitForURL((u) => u.origin === vite.scopeUrl(galaxy), { timeout: 30_000 });
    const again = await invite(m);
    assert.equal(again, `${vite.scopeUrl(galaxy)}/`, "a re-invite's letter must link to the invited scope's own host");
    await mPage.goto(again, { waitUntil: 'domcontentloaded' });
    await mPage.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(new URL(mPage.url()).origin, vite.scopeUrl(galaxy), 'following the re-invite must land on its host');
    await mPage.context().close();
    console.error("  ✓ limb 1 — the re-invite linked to the galaxy's host, and M landed in its Studio");

    // ── LIMB 2: a 401 with a pending membership offers its consent ─────────────────────────────
    const p = uniqueTestEmail();
    await invite(p); // never opened
    const waiter = waitForEmail({ testToken, to: p, timeout: 120_000 });
    let plain: string;
    try {
      await requestMagicLink({ baseUrl: origin, email: p });
      plain = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    const pPage = await (await browser.newContext()).newPage();
    await pPage.goto(plain, { waitUntil: 'domcontentloaded' });
    await pPage.getByTestId('link-continue').click();
    await pPage.waitForURL((u) => u.origin === origin && u.pathname === '/', { timeout: 30_000 });
    await pPage.goto(`${vite.scopeUrl(galaxy)}/`, { waitUntil: 'domcontentloaded' });
    await pPage.waitForURL((u) => u.origin === origin && u.pathname === '/auth/login', { timeout: 30_000 });
    await pPage.getByTestId('consent-checkbox').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await pPage.getByPlaceholder('you@example.com').count(), 0,
      'a 401 with a pending membership must offer its consent, never the login form');
    await pPage.context().close();
    console.error("  ✓ limb 2 — P's 401 on the invite's host was answered with the membership's consent");

    // ── LIMB 3: an invite's destination is the server's ────────────────────────────────────────
    const r = uniqueTestEmail();
    const link = new URL(await invite(r));
    link.searchParams.set('return_to', `${vite.scopeUrl(other)}/`);
    const rPage = await (await browser.newContext()).newPage();
    await rPage.goto(link.href, { waitUntil: 'domcontentloaded' });
    await acceptOn(rPage);
    await rPage.waitForURL((u) => u.origin === vite.scopeUrl(galaxy), { timeout: 30_000 });
    await rPage.context().close();
    console.error("  ✓ limb 3 — the link's own return_to was ignored; Accept landed on the invite's host");
  } finally {
    await vite.close();
    await browser.close();
  }
}

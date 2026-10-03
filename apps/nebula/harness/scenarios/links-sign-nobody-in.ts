/**
 * **Loading or following someone's emailed link signs nobody in — only its page's button does.**
 *
 * An emailed link opens a page on the platform host, and that page's `GET` changes nothing: it reads
 * the link through a lookup that writes no state. So a mail scanner fetching the link, generated code
 * loading it as an `<img>`, or a page sending the top window to it signs nobody in. What the page
 * shows comes from the lookup too, and an invite's page pre-fills a nickname only for someone the
 * address has already been: one who holds an accepted membership somewhere.
 *
 * The cast: **O** owns the account and invites everyone, signing invites as "Olive". **A** is invited
 * and has never signed in. **B** accepted a membership in an account of their own as "Bee". **C**
 * accepted one as "Cee" and deleted that account, so C holds a nickname and no accepted membership.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **An invite's page shows its sender and pre-fills only for someone who has accepted
 *     something.** Each invitee opens their own invite in an empty browser: B's page pre-fills
 *     "Bee", A's names "Olive" and pre-fills nothing, and C's pre-fills nothing. *Reds if the page
 *     reads through `pending-membership` (B's has nothing to show) or reads display names whatever
 *     the address holds (C's shows "Cee").*
 *  2. **Loading a link as an image signs nobody in.** A browser holding none of A's cookies opens a
 *     page on the dev Star's host and adds A's magic link and A's invite link as `<img>`s; both
 *     requests complete and the browser's jar gains nothing. *Reds if either `GET` consumes.*
 *  3. **Sending the top window to a link signs nobody in.** The same browser navigates to A's magic
 *     link and lands on "Continue as A", its jar still empty. *Reds if the navigation consumes.*
 *  4. **Rendering the page proves nothing.** Before Continue, the stack holds no `mailboxProved`
 *     line for A, read after the page's own lookup line; after Continue, it does. *Reds if the
 *     lookup runs the proving consume.*
 *  5. **Continue signs the browser in as A, and the invite is still A's to accept.** The jar now
 *     holds A's cookies, and Home's summary lists the invite as pending. *Reds if the image's `GET`
 *     accepted the invite.*
 *
 * Limb 4 reads the stack's stdio, which a deployed target does not capture; it says so there.
 *
 * `needsContainer = false` — the dev Star's host answers with no app built, which is all a page
 * there needs to be for limb 2.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar, waitForHost } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite } from '../lib/browser';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, refreshAccessToken, requestUniverseClaim, requestMagicLink, consumeLink,
} from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.worker.lookup,nebula-auth.Registry.identity.mailboxProved' };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const observable = stack.logs !== undefined;
  const universe = testSlug('links');
  const galaxy = `${universe}.crm`;

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
    /** A universe of `email`'s own, accepted on its claim link's page under `nickname`. */
    const ownAccount = async (email: string, slug: string, nickname: string) => {
      const link = await letterTo(email, () => requestUniverseClaim({ baseUrl: origin, universe: slug, appSlug: 'own', email }));
      const accepted = await consumeLink(link, fetch, { nickname });
      assert.equal(accepted.status, 200, `${nickname}'s own claim could not be accepted (${accepted.status})`);
    };

    // ── The cast ────────────────────────────────────────────────────────────────────────────────
    const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, testToken });
    const atGalaxy = await refreshAccessToken(origin, owner.session, galaxy);
    // Before the waiter is armed: on a deployed target this app's host answers only once its certificate
    // is issued, which can outlast the waiter, and the invite dials it.
    await waitForHost(vite.scopeUrl(galaxy));
    const invite = (email: string) => letterTo(email, () => inviteViaMesh(stack, atGalaxy, galaxy, [{ email }], 'Olive', { scopeUrl: vite.scopeUrl, platformOrigin: origin }));

    const a = uniqueTestEmail();
    const b = uniqueTestEmail();
    const c = uniqueTestEmail();
    const cee = testSlug('cee');
    await ownAccount(b, testSlug('bee'), 'Bee');
    await ownAccount(c, cee, 'Cee');
    const cSession = await provisionAndLogin({ baseUrl: origin, scope: cee, email: c, testToken });
    const cDriver = await connectDriver(stack, { scope: cee, session: cSession });
    try {
      await cDriver.client.scopes.delete(cee);
    } finally {
      cDriver.dispose();
    }
    const aInvite = await invite(a);
    const bInvite = await invite(b);
    const cInvite = await invite(c);
    const aMagic = await letterTo(a, () => requestMagicLink({ baseUrl: origin, email: a }));

    /** A page in a browser holding none of our cookies. */
    const freshPage = async (): Promise<Page> => (await browser.newContext()).newPage();
    const platformCookies = async (page: Page) =>
      (await page.context().cookies()).filter((ck) => origin.includes(ck.domain));

    // ── LIMB 1: an invite's page shows its sender, and pre-fills only for an accepted someone ──
    const opened = async (link: string) => {
      const page = await freshPage();
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      try {
        await page.getByTestId('consent-checkbox').waitFor({ state: 'visible', timeout: 30_000 });
      } catch (e) {
        throw new Error(`the invite page showed no consent card; it says: ${(await page.locator('body').innerText()).slice(0, 300)}`, { cause: e });
      }
      return { page, nickname: await page.getByTestId('consent-nickname').inputValue() };
    };
    const bPage = await opened(bInvite);
    assert.equal(bPage.nickname, 'Bee', "B's invite page must pre-fill the nickname B accepted under — the positive control");
    const aPage = await opened(aInvite);
    assert.equal(aPage.nickname, '', "A has accepted nothing, so A's invite page must pre-fill nothing");
    await aPage.page.getByText(/Olive/).first().waitFor({ state: 'visible', timeout: 10_000 });
    const cPage = await opened(cInvite);
    assert.equal(cPage.nickname, '', "C holds a nickname but no accepted membership, so C's page must pre-fill nothing");
    for (const p of [aPage, bPage, cPage]) await p.page.context().close();
    console.error("  ✓ limb 1 — B's page pre-filled Bee; A's named Olive and pre-filled nothing; C's pre-filled nothing");

    // ── LIMB 2: loading a link as an image signs nobody in ─────────────────────────────────────
    const page = await freshPage();
    await waitForHost(vite.scopeUrl(`${galaxy}.dev`)); // its galaxy is new, so on a deployed target its certificate is too
    await page.goto(`${vite.scopeUrl(`${galaxy}.dev`)}/`, { waitUntil: 'domcontentloaded' });
    // Each image request's own end, finished or failed: Chromium blocks an HTML answer to an <img>
    // from another origin (ORB) after it arrives, which is still the request completing.
    const ended = (url: string) => Promise.race([
      page.waitForEvent('requestfinished', { predicate: (r) => r.url() === url, timeout: 30_000 }).then(() => 'finished'),
      page.waitForEvent('requestfailed', { predicate: (r) => r.url() === url, timeout: 30_000 })
        .then((r) => `failed: ${r.failure()?.errorText}`),
    ]);
    const loaded = Promise.all([aMagic, aInvite].map(ended));
    await page.evaluate((urls) => {
      for (const src of urls) { const img = document.createElement('img'); img.src = src; document.body.appendChild(img); }
    }, [aMagic, aInvite]);
    const outcomes = await loaded;
    assert.ok(outcomes.every((o) => o === 'finished' || /ERR_BLOCKED_BY_ORB/.test(o)),
      `both image requests must complete — the positive control: ${JSON.stringify(outcomes)}`);
    assert.deepEqual(await platformCookies(page), [], "loading A's links as images must sign this browser in as nobody");
    console.error('  ✓ limb 2 — both links loaded as images; the jar gained nothing');

    // ── LIMB 3: sending the top window to a link signs nobody in ───────────────────────────────
    await page.goto(aMagic, { waitUntil: 'domcontentloaded' });
    const continueButton = page.getByTestId('link-continue');
    await continueButton.waitFor({ state: 'visible', timeout: 30_000 });
    assert.match(await continueButton.innerText(), new RegExp(`Continue as ${a.replace(/[.+]/g, '\\$&')}`));
    assert.deepEqual(await platformCookies(page), [], 'navigating to the link must sign nobody in before the click');
    console.error('  ✓ limb 3 — the navigation landed on "Continue as A", the jar still empty');

    // ── LIMB 4: rendering the page proves nothing ──────────────────────────────────────────────
    const isLookup = (l: DebugLine) => l.namespace === 'nebula-auth.worker.lookup' && l.message === 'looked up' && l.data.email === a;
    const isProved = (l: DebugLine) => l.namespace === 'nebula-auth.Registry.identity.mailboxProved' && l.data.email === a;
    if (observable) {
      const before = await waitForDebugLines(stack, (all) => all.some(isLookup), "the page's lookup line for A");
      assert.equal(before.filter(isProved).length, 0, "rendering A's link page must not prove A's mailbox");
    } else {
      console.error('[links-sign-nobody-in] limb 4: not observable on a deployed target');
    }

    // ── LIMB 5: Continue signs in as A, and the invite is still A's to accept ──────────────────
    await continueButton.click();
    await page.waitForURL((u) => u.origin === origin && u.pathname === '/', { timeout: 30_000 });
    assert.ok((await platformCookies(page)).length > 0, "Continue must sign this browser in as A — the positive control");
    if (observable) {
      await waitForDebugLines(stack, (all) => all.some(isProved), "A's mailboxProved line after Continue");
      console.error("  ✓ limb 4 — no mailboxProved for A until Continue, and one after it");
    }
    const summary = await page.evaluate(async () => {
      const res = await fetch('/auth/home-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return res.json() as Promise<{ pending: string[] }>;
    });
    // The invite co-mints the galaxy's `.dev` membership beside it; the invite's own is what matters.
    assert.ok(summary.pending.includes(galaxy),
      `the invite must still be pending — the image's GET must not have accepted it: ${JSON.stringify(summary.pending)}`);
    console.error('  ✓ limb 5 — Continue signed the browser in as A; the invite is still pending');
  } finally {
    await vite.close();
    await browser.close();
  }
}

/**
 * **A link signs in once: its page's button spends it, and every replay finds it used.**
 *
 * Every emailed link that carries a token is a magic link — an invite is one that lives a week — and
 * the `POST` its page sends spends it once the sessions are recorded, whatever the acceptance then
 * answers. Each replay below runs in a FRESH browser, so only the server's record of the spend can
 * refuse it: no cookie of the first browser's is there to help.
 *
 * The cast: **O** owns the account and invites. **I** and **J** are invitees. **N** is an address with
 * no memberships at all.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **An invite is a magic link: its page is the consent card, its Accept signs in, and its replay
 *     is refused.** The letter links to `/auth/magic-link?token=…`; once the page has loaded its
 *     address carries no token; Accept signs the browser in; the same link in a fresh browser finds
 *     the used page and its jar gains nothing. *Reds if the invite link stays multi-use, or the page
 *     keeps the token in its address.*
 *  2. **A magic link's Continue signs in, and its replay is refused the same way.** *Reds if the
 *     magic link stays multi-use.*
 *  3. **The link page's Accept is an acceptance writer, and the galaxy cap refuses it there.** An
 *     owner at the cap claims another account and opens its link: Accept shows the cap's message on
 *     the page, the browser holds the cookies of the owner's accepted memberships, Home's summary
 *     lists the new claim as pending, and a replay finds the link used. *Reds if the page's `POST`
 *     accepts past the cap, or leaves a refused link unspent.*
 *  4. **A link for an address with no memberships is spent with its ticket.** Continue lands on the
 *     signup page holding a ticket; the replay finds the link used and is handed no ticket. *Reds
 *     if the spend happens only where sessions are recorded.*
 *  5. **Past the page, a spent token is refused by the consume itself.** A Node `POST` of a magic
 *     link and of an invite each signs in once, and answers `409 link_used` with no cookie the
 *     second time. *Reds if the consume ignores the spend while the lookup still reports it.*
 *
 * `needsContainer = false` — auth, the Registry and the facade only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { GALAXY_CAP_MESSAGE, MAX_GALAXIES_PER_OWNER, SIGNUP_TICKET_COOKIE } from '@lumenize/mesh/client';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite } from '../lib/browser';
import {
  provisionAndLogin, refreshAccessToken, requestUniverseClaim, requestMagicLink, consumeLink, setCookieHeaders,
} from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('once');
  const galaxy = `${universe}.crm`;
  const ownerEmail = uniqueTestEmail();

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
    const freshPage = async (): Promise<Page> => (await browser.newContext()).newPage();
    const jar = async (page: Page) => (await page.context().cookies()).map((c) => c.name);
    /** The link in a fresh browser: the used page, and nothing in its jar. */
    const replayIsRefused = async (link: string, what: string) => {
      const replay = await freshPage();
      await replay.goto(link, { waitUntil: 'domcontentloaded' });
      await replay.getByTestId('link-used').waitFor({ state: 'visible', timeout: 30_000 });
      assert.deepEqual(await jar(replay), [], `${what}'s replay must sign nobody in`);
      await replay.context().close();
    };

    const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: ownerEmail, testToken });
    const atUniverse = await refreshAccessToken(origin, owner.session, universe);
    const invite = (email: string) =>
      letterTo(email, () => inviteViaMesh(stack, atUniverse, galaxy, [{ email }], 'Olive', { scopeUrl: vite.scopeUrl, platformOrigin: origin }));

    // ── LIMB 1: an invite is a magic link, its Accept signs in, its replay is refused ───────────
    const inviteLink = await invite(uniqueTestEmail());
    assert.match(new URL(inviteLink).pathname, /^\/auth\/magic-link$/, 'an invite must link to the magic-link page');
    const first = await freshPage();
    await first.goto(inviteLink, { waitUntil: 'domcontentloaded' });
    await first.getByTestId('consent-checkbox').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(new URL(first.url()).searchParams.has('token'), false, 'once the page has loaded, its address carries no token');
    await first.getByTestId('consent-checkbox').check();
    await first.getByTestId('consent-nickname').fill('Ivy');
    await first.getByTestId('consent-accept').click();
    await first.waitForURL((u) => u.origin === vite.scopeUrl(galaxy), { timeout: NEW_HOST_TIMEOUT_MS });
    assert.ok((await jar(first)).length > 0, "the invite's Accept must sign the browser in — the positive control");
    await first.context().close();
    await replayIsRefused(inviteLink, 'the invite');
    console.error("  ✓ limb 1 — the invite's page dropped its token, its Accept signed in, and its replay was refused");

    // ── LIMB 2: a magic link's Continue signs in, and its replay is refused ────────────────────
    const magic = await letterTo(ownerEmail, () => requestMagicLink({ baseUrl: origin, email: ownerEmail }));
    const second = await freshPage();
    await second.goto(magic, { waitUntil: 'domcontentloaded' });
    await second.getByTestId('link-continue').click();
    await second.waitForURL((u) => u.origin !== origin || u.pathname === '/', { timeout: 30_000 });
    assert.ok((await jar(second)).length > 0, "the magic link's Continue must sign the browser in");
    await second.context().close();
    await replayIsRefused(magic, 'the magic link');
    console.error("  ✓ limb 2 — the magic link's Continue signed in, and its replay was refused");

    // ── LIMB 3: the link page's Accept is refused at the cap, and the link is spent ────────────
    const driver = await connectDriver(stack, { scope: universe, session: atUniverse });
    try {
      for (let i = 2; i <= MAX_GALAXIES_PER_OWNER; i++) await driver.client.scopes.createGalaxy(universe, `g${i}`);
    } finally {
      driver.dispose();
    }
    const another = `${universe}b`;
    const claimLink = await letterTo(ownerEmail, () =>
      requestUniverseClaim({ baseUrl: origin, universe: another, appSlug: 'web', email: ownerEmail }));
    const capped = await freshPage();
    await capped.goto(claimLink, { waitUntil: 'domcontentloaded' });
    await capped.getByTestId('consent-checkbox').check();
    await capped.getByTestId('consent-nickname').fill('Olive');
    await capped.getByTestId('consent-accept').click();
    const error = capped.getByTestId('link-error');
    await error.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await error.innerText(), GALAXY_CAP_MESSAGE, "the page must show the cap's refusal, by its message");
    assert.ok((await jar(capped)).includes(`__Host-refresh-token.${universe}`),
      "a refused Accept still sets the cookies of the owner's accepted memberships");
    const summary = await capped.evaluate(async () => {
      const res = await fetch('/auth/home-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return res.json() as Promise<{ pending: string[] }>;
    });
    assert.deepEqual(summary.pending, [another], 'the claim the cap refused must stay pending');
    await capped.context().close();
    await replayIsRefused(claimLink, 'the refused claim');
    console.error("  ✓ limb 3 — the cap refused the page's Accept by message, the claim stayed pending, and the link was spent");

    // ── LIMB 4: a link for an address with no memberships is spent with its ticket ─────────────
    const newcomer = uniqueTestEmail();
    const ticketLink = await letterTo(newcomer, () => requestMagicLink({ baseUrl: origin, email: newcomer }));
    const signup = await freshPage();
    await signup.goto(ticketLink, { waitUntil: 'domcontentloaded' });
    await signup.getByTestId('link-continue').click();
    await signup.waitForURL((u) => u.pathname === '/auth/signup', { timeout: 30_000 });
    assert.ok((await jar(signup)).includes(SIGNUP_TICKET_COOKIE), 'the first Continue must hand a ticket — the positive control');
    await signup.context().close();
    await replayIsRefused(ticketLink, 'the ticket link');
    console.error('  ✓ limb 4 — the ticket link was spent with its ticket; the replay got none');

    // ── LIMB 5: past the page, a spent token is refused by the consume itself ──────────────────
    const viaNode = async (link: string, what: string) => {
      const firstPost = await consumeLink(link);
      assert.equal(firstPost.status, 200, `${what}: the first POST must sign in (${firstPost.status})`);
      const again = await consumeLink(link);
      assert.equal(again.status, 409, `${what}: a spent token must be refused`);
      assert.equal((await again.json() as { error?: string }).error, 'link_used', `${what}: refused as used`);
      assert.deepEqual(setCookieHeaders(again), [], `${what}: the refusal must set no cookie`);
    };
    await viaNode(await letterTo(ownerEmail, () => requestMagicLink({ baseUrl: origin, email: ownerEmail })), 'a magic link');
    await viaNode(await invite(uniqueTestEmail()), 'an invite');
    console.error('  ✓ limb 5 — a spent magic link and a spent invite were each refused 409 link_used, with no cookie');
  } finally {
    await vite.close();
    await browser.close();
  }
}

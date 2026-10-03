/**
 * **The clean signup, driven entirely through the rendered UI — no app is created by API.**
 *
 * This is the scenario the dead-end got past. Every other browser scenario provisions its galaxy
 * with `provisionAndLogin` and then logs the browser in, so the path a real first-time user walks —
 * sign up naming the account and its first app, open the letter, consent and name yourself, land in
 * that app's Studio — had no coverage at all. Four defects shipped behind a green suite because of
 * it: a Universe with no surface (an unclickable account row), a signed-out landing at bare `/`, a
 * `session expired` banner at the new galaxy, and the universe's page rendering Studio instead of
 * the Universe page.
 *
 * ⚠️ **The defining property: the app is created by the FORM, not by a POST the scenario makes.**
 * The moment this scenario reaches for a provisioning helper to "get set up", it stops covering the
 * thing it exists for. Every step below is a step a person takes (`live.md` — a helper may only do what production
 * does), and the emailed link is followed AS SENT.
 *
 * Limbs, each isolated (`live.md` — mutation-check PER LIMB, not per scenario):
 *
 *  1. **The declared-newbie form sends one letter, naming the account and its first app.** *Reds if
 *     the create-account affordance stops reaching `claim-universe` — the newbie then spends two
 *     emails, or none — or stops sending the first app's slug, which the claim then refuses.*
 *  2. **The letter names the origin the person is browsing.** *Reds on the links-point-at-prod class
 *     of bug — the one a compensating helper hid from every lane until 2026-09-02.*
 *  3. **Consent on the letter's page needs the box AND a nickname, and Accept lands in the first
 *     app's Studio.** *Reds if the claim's link stops naming that Studio as where to land — the
 *     person would stop on Home or the Universe page and have to learn both first — and, via the
 *     disabled-Accept half, against the nickname silently becoming optional.*
 *  4. **The Universe page lists the app the claim wrote, unblocked.** *Reds if the claim stops
 *     writing its first app (no row), and, by the dialog count, if a blocking gate returns to this
 *     screen.*
 *  5. **Studio connects on a LIVE session.** Its refresh from the galaxy's page is not refused, and
 *     no `session expired` banner shows. *Reds if the cookie the Accept set does not mint on the
 *     app's host. Asserted as the absence of a refused refresh, not just of the banner.*
 *  6. **A connected, empty thread shows its hint.** *Reds if the hint stops being conditional and
 *     goes back to being a logged message pinned to the bottom of every conversation.*
 *  7. **The nickname taken at consent is the byline on a posted message.** *Reds if the accept
 *     handler stops writing it — the byline falls back to "Someone", which nothing on the consent
 *     screen itself could detect. The only end-to-end proof that field reaches the Profile.*
 *  8. **The profile editor, reached from the avatar menu, renames an existing byline LIVE — and a
 *     picture uploaded there is served back from R2 and reaches the avatar button.** *Reds if the
 *     editor opens blank (an edit that silently wipes what was on file), if a save stops reaching the
 *     subscription — the fanout the deleted completion modal's back-fill limb used to cover — and if
 *     the upload stops storing, sniffing, or serving.*
 *  9. **The universe's host stays the Universe page, and its app row opens Studio.** *Reds against
 *     the auto-forward that sent a lone-galaxy account straight into Studio — a view the address
 *     did not name (ADR-017) — against the list flavour never rendering, and against a row that
 *     goes nowhere.*
 * 10. **A revisit does NOT re-open the create form.** *Reds if the auto-open reads `apps` before the
 *     scope load resolves: Flavour B is a list with Create one click away, not a modal in your face.*
 * 11. **The claim refuses a missing first app, and writes three scopes when given one.** A Node
 *     `POST` to `claim-universe` without `appSlug` is refused with the slug message; with it, the
 *     claim's record names the universe, the galaxy and its `.dev` Star. *Reds if the claim
 *     accepts no first app — it would write a universe alone.*
 * 12. **The ticket path's rendered signup page sends both slugs too.** In the same browser, a new
 *     address presses its link's Continue, lands on `/auth/signup`, fills the page's two fields and
 *     submits, and Home offers the new account's consent; the ticket claim's record names three
 *     scopes. `signup-one-email` posts its ticket claim from Node, so nothing else renders
 *     `SignupScreen.vue`. *Reds if that page drops the field.*
 *
 * `needsContainer = false` — signup, routing and auth only. Nothing here builds an app; that is
 * `first-app-built`, which picks up where limb 6 leaves off.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import { requestMagicLink } from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = {
  DEBUG: 'nebula-auth.Registry.claimUniverse,nebula-auth.Registry.claimUniverseWithTicket',
};

/** The composer placeholder — Studio's "you are connected and can act" tell, in both scenarios. */
const COMPOSER = 'Describe a change…';

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  // Fresh slug + fresh address per run: a deployed target's state is durable, so a fixed pair
  // replays an already-claimed universe (409) down a branch this scenario is not covering.
  const universe = `signup-${crypto.randomUUID().slice(0, 8)}`;
  const appSlug = 'wishlist';
  const galaxy = `${universe}.${appSlug}`;
  const person = uniqueTestEmail();
  const NICKNAME = 'Robin Newcomer';

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;

    // ── LIMB 1: sign up through the rendered form ──────────────────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Create a new account/ }).click();
    await page.getByPlaceholder('you@example.com').fill(person);
    await page.getByPlaceholder('acme').fill(universe);
    await page.getByPlaceholder('crm').fill(appSlug);

    // ⚠️ Arm the waiter BEFORE the click — the EmailTestDO pushes to already-connected sockets and
    // never replays. Filtered by RECIPIENT only: the address is unique per run, which discriminates
    // unconditionally, whereas an `instance` tag would have to anticipate which branch the server
    // takes (`live.md` — a waiter armed on the wrong tag waits out its whole timeout and reports a
    // delivery failure for what is a filter bug).
    const waiter = waitForEmail({ testToken, to: person, timeout: 120_000 });
    let link: string;
    try {
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    console.error('  ✓ limb 1 — the declared-newbie form, naming account and first app, sent exactly one letter');

    // ── LIMB 2: the link names the origin the person is on, and is followed AS SENT ────────────
    assert.ok(link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the browsing origin as sent (got ${new URL(link).origin}, page is ${vite.viteBaseUrl})`);
    // ⚠️ ONE navigation: a second `goto` would cancel this page's in-flight lookup — an abort the
    // scenario causes itself. Readiness comes from the auto-waiting locator below, not from a delay.
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    console.error('  ✓ limb 2 — the letter points at the origin being browsed; opened unmodified');

    // ── LIMB 3: consent — the box AND a nickname — then Studio ─────────────────────────────────
    // Opening the letter does NOT enrol its claimer: the link's page is the consent screen, and only
    // its Accept signs in (a mail scanner's fetch is not consent). It is also the ONE place a
    // nickname is collected, which is what lets every app surface drop its own blocking name modal.
    const checkbox = page.getByTestId('consent-checkbox');
    await checkbox.waitFor({ state: 'visible', timeout: 30_000 });
    const accept = page.getByTestId('consent-accept');
    await checkbox.check();
    // ⚠️ This half is what proves the nickname is genuinely a CONDITION rather than a field someone
    // may skip: box ticked, field empty, Accept must still refuse. Without it, the fill below would
    // pass against a button that was already enabled.
    assert.equal(await accept.isDisabled(), true,
      'Accept must stay disabled until a nickname is supplied — the consent box alone is not enough');
    await page.getByTestId('consent-nickname').fill(NICKNAME);
    assert.equal(await accept.isEnabled(), true,
      'Accept must enable once the box is ticked AND a nickname is present');
    await accept.click();
    const studioHost = new URL(vite.scopeUrl(galaxy)).host;
    await page.waitForURL((u) => u.host === studioHost, { timeout: 30_000 });
    console.error(`  ✓ limb 3 — the box alone did not suffice; consent + nickname lands in ${galaxy}'s Studio`);

    // ── LIMB 5: Studio connects on a LIVE session ──────────────────────────────────────────────
    try {
      await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'signup-studio-connect-failed');
      throw e;
    }
    // ⚠️ Assert the REFUSAL, not just the banner. "Session expired" is the symptom a person reads;
    // the defect is a 401 from a refresh aimed at a path the cookie was never scoped to, and the
    // banner could be suppressed while the 401 remained.
    const refusals = inst.failedRequests.filter(
      (r) => r.url.endsWith('/auth/refresh-token') && (r.status === 401 || r.status === 'failed'),
    );
    assert.deepEqual(refusals, [],
      `the new galaxy's refresh was REFUSED — the Accept's cookie does not mint on its host: ${JSON.stringify(refusals)}`);
    assert.equal(await page.getByText('Your session expired').count(), 0,
      'a freshly-created app must not greet its creator with an expired session');
    console.error(`  ✓ limb 5 — Studio for ${galaxy} connected with a live session`);

    // ── LIMB 6: a connected, empty thread shows its hint ───────────────────────────────────────
    await page.getByText('Connected. Describe the app you want to build.')
      .waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 6 — the empty thread shows its hint');

    // ── LIMB 7: the nickname taken at consent is the byline in the thread ──────────────────────
    // The payoff for collecting it there at all, and the only end-to-end proof that the consent
    // field reached the Profile: post a marker and read the name off its own bubble. Reds if the
    // accept handler stops writing it (the byline falls back to "Someone"), which no assertion on
    // the consent screen itself could see.
    const marker = `hello from ${NICKNAME} ${Date.now().toString(36)}`;
    await page.getByPlaceholder(COMPOSER).fill(marker);
    await page.getByPlaceholder(COMPOSER).press('Enter');
    const myChat = page.locator('div.chat', { hasText: marker }).first();
    await myChat.waitFor({ state: 'visible', timeout: 30_000 });
    await myChat.locator('.chat-header').getByText(NICKNAME).first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 7 — the consent nickname renders as the byline on a posted message');
    const created = await captureArtifacts(inst, 'signup-to-first-app-studio');

    // ── LIMB 8: the profile editor renames the byline LIVE ────────────────────────────────────
    // The avatar menu is the only way to change these after consent, and the payoff is that a save
    // lands on the SUBSCRIPTION: the byline on the message posted above re-renders with no reload.
    // That mechanism is what the deleted completion modal's back-fill limb used to assert, so this
    // is where that coverage now lives.
    const RENAMED = 'Robin Renamed';
    await page.locator('button[title="Account"]').click();
    await page.getByTestId('menu-profile').click();
    const nicknameField = page.getByTestId('profile-nickname');
    await nicknameField.waitFor({ state: 'visible', timeout: 20_000 });
    // Seeded from the LIVE snapshot, not opened blank — reds if the editor stops reading the
    // profile it is about to overwrite, which is how an edit silently becomes a wipe.
    assert.equal(await nicknameField.inputValue(), NICKNAME,
      'the profile editor must open seeded with the nickname already on file');
    await nicknameField.fill(RENAMED);
    await page.getByTestId('profile-name').fill('Robin Q. Newcomer');
    // A picture, through R2 for real: the file goes in via the editor's input, is uploaded the
    // moment it is picked, and the preview that appears IS the served object — asserted by
    // fetching its src through the same origin and checking a real image came back.
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    await page.getByTestId('profile-picture-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: onePixelPng });
    const pictureImg = page.getByTestId('profile-picture-img');
    await pictureImg.waitFor({ state: 'visible', timeout: 30_000 });
    const pictureSrc = await pictureImg.getAttribute('src');
    // Relative, so the stored value names no host and each page resolves it against its own.
    assert.ok(pictureSrc && /^\/pictures\/[0-9a-f-]{36}\.png$/.test(pictureSrc),
      `the upload must answer the relative /pictures/{uuid}.png, got ${pictureSrc}`);
    const served = await page.context().request.get(new URL(pictureSrc!, page.url()).href);
    assert.equal(served.status(), 200, 'the uploaded picture must be served back');
    assert.equal(served.headers()['content-type'], 'image/png', 'served with the SNIFFED type, not a guess');
    assert.ok((served.headers()['cache-control'] ?? '').includes('immutable'), 'a picture URL is immutable — a change is a new key');
    await page.getByTestId('profile-save').click();
    await myChat.locator('.chat-header').getByText(RENAMED).first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    // …and after Save the avatar button wears it — the Profile write fanned the picture out.
    await page.getByTestId('account-picture').waitFor({ state: 'visible', timeout: 20_000 });
    // The FULL name is the hover: the byline keeps showing the nickname, and its title carries the
    // name the editor just saved. A `title` (not a hover-only widget) so assistive tech gets it too.
    await myChat.locator('[data-testid="byline"]').first().waitFor({ state: 'visible' });
    // The face beside my own message is the picture I just uploaded — the Profile fanout reached
    // the thread's per-author subscription, not only the avatar button.
    await myChat.locator('[data-testid="party-avatar-img"]').first().waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await myChat.locator('[data-testid="party-avatar-img"]').first().getAttribute('src'), pictureSrc,
      'the avatar beside my message must be the uploaded picture, stored as the relative path');
    assert.equal(await myChat.locator('[data-testid="byline"]').first().getAttribute('title'), 'Robin Q. Newcomer',
      'hovering a byline must reveal the full name; the byline itself stays the nickname');
    console.error('  ✓ limb 8 — the profile editor renames an existing byline live, and the uploaded picture reaches the avatar');

    // ── LIMB 4: the Universe page lists the app the claim wrote, with NOTHING blocking it ──────
    // No name modal here — the nickname was taken at consent, so a person arrives ready to work. The
    // dialog count is the regression guard against a blocking gate coming back.
    await page.goto(`${vite.scopeUrl(universe)}/`, { waitUntil: 'domcontentloaded' });
    const appRow = page.getByRole('button', { name: appSlug, exact: true });
    try {
      await appRow.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'signup-universe-revisit-failed');
      throw e;
    }
    assert.equal(await page.locator('dialog.modal[open]').count(), 0,
      'a fresh account with its first app must open on the list, interrupted by no dialog');
    console.error('  ✓ limb 4 — the Universe page lists the claim\'s first app, unblocked');

    // ── LIMB 10: a revisit does NOT re-open the create form ────────────────────────────────────
    // Flavour B is a list with Create one click away. An auto-open here means the modal fired off a
    // not-yet-loaded app list, which every returning visit would then reproduce.
    assert.equal(await page.getByPlaceholder('crm').isVisible(), false,
      'an account that already has apps must open on the LIST — the create form is behind the button');
    console.error('  ✓ limb 10 — the revisit opens on the list, not the create form');

    const revisit = await captureArtifacts(inst, 'signup-to-first-app-universe');

    // ── LIMB 9: the universe's host is the Universe page, and its row opens the app ─────────────
    assert.equal(await page.getByPlaceholder(COMPOSER).count(), 0,
      "the URL is the view (ADR-017): the universe's host must render the Universe page, never a galaxy Studio");
    await appRow.click();
    await page.waitForURL((u) => u.host === studioHost, { timeout: 30_000 });
    await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 30_000 });
    console.error("  ✓ limb 9 — the universe's host stays the Universe page, and its row opens Studio");

    // ── LIMB 11: the claim refuses a missing first app, and writes three scopes with one ───────
    // Over HTTP from Node, through vite's port as the form posts. The record is the only place the
    // three rows are observable before anyone accepts; it is stdio, so a deployed run cannot read it.
    const observable = stack.logs !== undefined;
    const claimNs = 'nebula-auth.Registry.claimUniverse';
    const recordNames = (ns: string, u: string, app: string) => (all: DebugLine[]) =>
      all.some((l) => l.namespace === ns && l.data.universe === u && l.data.galaxy === `${u}.${app}`
        && l.data.devStar === `${u}.${app}.dev`);
    const bare = `bare-${crypto.randomUUID().slice(0, 8)}`;
    const post = (body: Record<string, unknown>) => fetch(`${vite.viteBaseUrl}/auth/claim-universe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const refused = await post({ slug: bare, email: uniqueTestEmail() });
    assert.equal(refused.status, 400, 'a claim without its first app must be refused');
    assert.equal((await refused.json() as { error_description: string }).error_description,
      'Invalid app slug format', 'the refusal names the app slug');
    const admitted = await post({ slug: bare, appSlug: 'crm', email: uniqueTestEmail() });
    assert.equal(admitted.status, 200, 'the same claim with both slugs must be admitted');
    if (observable) {
      await waitForDebugLines(stack, recordNames(claimNs, bare, 'crm'), `${claimNs} naming ${bare}'s three scopes`);
    }
    console.error(`  ✓ limb 11 — no first app is refused by message; with one, the claim records three scopes${observable ? '' : ' (record not observable on a deployed target)'}`);

    // ── LIMB 12: the ticket path's rendered page sends both slugs ──────────────────────────────
    // A new address with no memberships, in the same browser: its link's Continue lands on
    // `/auth/signup` holding a ticket, and the page's two fields are the claim.
    const newcomer = uniqueTestEmail();
    const ticketUniverse = `ticket-${crypto.randomUUID().slice(0, 8)}`;
    const ticketWaiter = waitForEmail({ testToken, to: newcomer, timeout: 120_000 });
    let ticketLink: string;
    try {
      await requestMagicLink({ baseUrl: vite.viteBaseUrl, email: newcomer });
      ticketLink = extractMagicLink(await ticketWaiter.emailPromise);
    } finally {
      ticketWaiter.cleanup();
    }
    await page.goto(ticketLink, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('link-continue').click();
    await page.waitForURL(/\/auth\/signup(?:[?#]|$)/, { timeout: 30_000 });
    await page.getByPlaceholder('acme').fill(ticketUniverse);
    await page.getByPlaceholder('crm').fill('notes');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    // Home, offering the new account's consent: a ticket-backed claim has no link to accept it on.
    // This browser also holds the first person's session, so Home lists the pending account rather
    // than opening its consent at once, and the row opens it.
    await page.waitForURL((u) => u.origin === vite.viteBaseUrl && u.pathname === '/', { timeout: 30_000 });
    await page.getByTestId('home-pending').getByRole('button', { name: new RegExp(ticketUniverse) }).click();
    await page.getByTestId('consent-checkbox').waitFor({ state: 'visible', timeout: 30_000 });
    if (observable) {
      const ticketNs = 'nebula-auth.Registry.claimUniverseWithTicket';
      await waitForDebugLines(stack, recordNames(ticketNs, ticketUniverse, 'notes'),
        `${ticketNs} naming ${ticketUniverse}'s three scopes`);
    }
    console.error(`  ✓ limb 12 — the rendered signup page claimed ${ticketUniverse} with its first app${observable ? '' : ' (record not observable on a deployed target)'}`);

    const { existsSync, statSync } = await import('node:fs');
    for (const cap of [created, revisit]) {
      assert.ok(existsSync(cap.screenshotPath) && statSync(cap.screenshotPath).size > 0,
        `${cap.label}: the harness must produce a non-empty screenshot`);
    }
    console.error(`  ── a stranger signed up and reached their first app's Studio (captures: ${revisit.dir})`);
  } finally {
    await vite.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

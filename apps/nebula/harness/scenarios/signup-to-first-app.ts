/**
 * **The clean signup, driven entirely through the rendered UI — no app is created by API.**
 *
 * This is the scenario the dead-end got past. Every other browser scenario provisions its galaxy
 * with `provisionAndLogin` and then logs the browser in, so the path a real first-time user walks —
 * sign up, click the letter, consent, name yourself, create your FIRST app, land in its Studio —
 * had no coverage at all. Four defects shipped behind a green suite because of it: a Universe with
 * no surface (an unclickable account row), a signed-out landing at bare `/`, a `session expired`
 * banner at the new galaxy, and `/{universe}` rendering Studio instead of the Universe page.
 *
 * ⚠️ **The defining property: the app is created by CLICKING, not by POSTing.** The moment this
 * scenario reaches for a provisioning helper to "get set up", it stops covering the thing it exists
 * for. Every step below is a step a person takes (`live.md` — a helper may only do what production
 * does), and the emailed link is followed AS SENT.
 *
 * Limbs, each isolated (`live.md` — mutation-check PER LIMB, not per scenario):
 *
 *  1. **The declared-newbie form sends one letter.** *Reds if the create-account affordance stops
 *     reaching `claim-universe` — the newbie then spends two emails, or none.*
 *  2. **The letter names the origin the person is browsing.** *Reds on the links-point-at-prod class
 *     of bug — the one a compensating helper hid from every lane until 2026-09-02.*
 *  3. **Consent needs the box AND a nickname, then Home fast-forwards to the Universe page.**
 *     *Reds against `surfaceFor(universe)` returning undefined again — the original dead end, where
 *     the account rendered as an unclickable label with nowhere to go — and, via the disabled-Accept
 *     half, against the nickname silently becoming optional.*
 *  4. **The empty account opens straight into Create, unblocked.** *Reds if the auto-open stops
 *     firing (a day-1 user sees an empty card and no next step), and the dialog count reds if a
 *     blocking gate returns to this screen.*
 *  5. **Creating an app lands in its Studio on a LIVE session.** *Reds on the `session expired`
 *     defect: the refresh cookie sits at `/auth/{universe}` and RFC-6265 never sends it to
 *     `/auth/{universe}.{app}/…`, so without the hand-off hint Studio refreshes against a path
 *     holding no cookie and 401s. Asserted as the absence of that 401, not just of the banner.*
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
 *  9. **`/{universe}` stays the Universe page, and lists the app.** *Reds against the auto-forward
 *     that sent a lone-galaxy account straight into Studio — a view the address did not name
 *     (ADR-017) — and against the list flavour never rendering.*
 * 10. **A revisit does NOT re-open the create form.** *Reds if the auto-open reads `apps` before the
 *     scope load resolves: Flavour B is a list with Create one click away, not a modal in your face.*
 *
 * `needsContainer = false` — signup, routing and auth only. Nothing here builds an app; that is
 * `first-app-built`, which picks up where limb 6 leaves off.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';

export const needsContainer = false;

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
    console.error('  ✓ limb 1 — the declared-newbie form sent exactly one letter');

    // ── LIMB 2: the link names the origin the person is on, and is followed AS SENT ────────────
    assert.ok(link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the browsing origin as sent (got ${new URL(link).origin}, page is ${vite.viteBaseUrl})`);
    // ⚠️ ONE navigation: the link already lands on Home (`landingFor` sends every arrival there), and
    // a second `goto` would cancel this page's in-flight bootstrap — an abort the scenario causes
    // itself. Readiness comes from the auto-waiting locator below, not from a delay.
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(new RegExp(`/auth/${universe}/home(?:[/?#]|$)`), { timeout: 30_000 });
    console.error('  ✓ limb 2 — the letter points at the origin being browsed; clicked unmodified');

    // ── LIMB 3: consent — the box AND a nickname — then the fast-forward ───────────────────────
    // A claim does NOT enrol its claimer: the cookie is inert until accepted, deliberately (a link
    // click is not consent — mail scanners click links). Home is where that decision is made, and
    // it is also the ONE place a nickname is collected, which is what lets every app surface drop
    // its own blocking name modal.
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
    // The whole dead end in one wait: one accepted membership, so Home skips itself and goes to the
    // surface. Before the Universe page existed there was no surface to go to.
    await page.waitForURL(new RegExp(`//[^/]+/${universe}(?:[/?#]|$)`), { timeout: 30_000 });
    console.error('  ✓ limb 3 — the box alone did not suffice; consent + nickname reaches /{universe}');

    // ── LIMB 4: the empty account opens straight into Create, with NOTHING blocking it ─────────
    // No name modal here any more — the nickname was taken at consent, so a person arrives ready to
    // work. The dialog count is the regression guard against a blocking gate coming back.
    await page.getByText('No apps yet. Create your first one to start building.')
      .waitFor({ state: 'visible', timeout: 20_000 });
    const slugField = page.getByPlaceholder('crm');
    await slugField.waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await page.locator('dialog.modal[open]').count(), 1,
      'the create form must be the ONLY open dialog — a fresh account is not interrupted by a gate');
    console.error('  ✓ limb 4 — the empty account opens straight into Create, unblocked');

    // ── LIMB 5: create the app BY CLICKING, and land in its Studio on a LIVE session ───────────
    await slugField.fill(appSlug);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(new RegExp(`//[^/]+/${universe}\\.${appSlug}(?:[/?#]|$)`), { timeout: 60_000 });
    try {
      await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'signup-studio-connect-failed');
      throw e;
    }
    // ⚠️ Assert the REFUSAL, not just the banner. "Session expired" is the symptom a person reads;
    // the defect is a 401 from a refresh aimed at a path the cookie was never scoped to, and the
    // banner could be suppressed while the 401 remained.
    const galaxyRefusals = inst.failedRequests.filter(
      (r) => r.url.includes(`/auth/${galaxy}/refresh-token`) && (r.status === 401 || r.status === 'failed'),
    );
    assert.deepEqual(galaxyRefusals, [],
      `the new galaxy's refresh was REFUSED — Studio is spending a cookie that is not scoped to it: ` +
      `${JSON.stringify(galaxyRefusals)}`);
    assert.equal(await page.getByText('Your session expired').count(), 0,
      'a freshly-created app must not greet its creator with an expired session');
    console.error(`  ✓ limb 5 — created ${galaxy} by clicking; Studio connected with a live session`);

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
    assert.ok(pictureSrc && /\/pictures\/[0-9a-f-]{36}\.png$/.test(pictureSrc),
      `the preview must be the served object under /pictures/{uuid}.png, got ${pictureSrc}`);
    const served = await page.context().request.get(pictureSrc!);
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
    assert.equal(await myChat.locator('[data-testid="byline"]').first().getAttribute('title'), 'Robin Q. Newcomer',
      'hovering a byline must reveal the full name; the byline itself stays the nickname');
    console.error('  ✓ limb 8 — the profile editor renames an existing byline live, and the uploaded picture reaches the avatar');

    // ── LIMB 9: /{universe} is the Universe page and lists the app ─────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/${universe}`, { waitUntil: 'domcontentloaded' });
    const appRow = page.getByRole('button', { name: appSlug, exact: true });
    try {
      await appRow.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'signup-universe-revisit-failed');
      throw e;
    }
    assert.equal(await page.getByPlaceholder(COMPOSER).count(), 0,
      'the URL is the view (ADR-017): /{universe} must render the Universe page, never a galaxy Studio');
    console.error('  ✓ limb 9 — /{universe} stays the Universe page and lists the app');

    // ── LIMB 10: a revisit does NOT re-open the create form ────────────────────────────────────
    // Flavour B is a list with Create one click away. An auto-open here means the modal fired off a
    // not-yet-loaded app list, which every returning visit would then reproduce.
    assert.equal(await page.getByPlaceholder('crm').isVisible(), false,
      'an account that already has apps must open on the LIST — the create form is behind the button');
    console.error('  ✓ limb 10 — the revisit opens on the list, not the create form');

    const revisit = await captureArtifacts(inst, 'signup-to-first-app-universe');
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

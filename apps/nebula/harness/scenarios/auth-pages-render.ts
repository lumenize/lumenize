/**
 * **The auth screens actually render — the half a green suite cannot see.**
 *
 * The pool-workers lane asserts the auth screens' server side: the routes exist, the ticket is spendable only
 * at the claim, the coming-soon tag is a closed set. None of that says a person sees a form. The
 * capability that was fully present in code and never wired into the UI is this repo's own cautionary
 * tale (`live.md`), and these screens are where a repeat would be most expensive — they are every
 * pre-alpha user's first contact.
 *
 * ⚠️ **Asserts CONTENT, never a status code.** A 200 proves the Worker answered; it does not prove
 * the bundle mounted, and a blank page returns 200 all day. Every limb below reaches for something a
 * person would look at — the email field, the consent checkbox, the notice.
 *
 * ⚠️ **Driven through VITE, not the Worker's asset layer.** The dev loop builds no `dist` (the lanes
 * `mkdir` an empty one), so the Worker's `serveAuthApp` correctly answers 503 here and vite's
 * mirroring middleware is what serves these paths — which is exactly what a developer sees. The
 * built-asset path is covered by the ui-smoke lane, which builds.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **`/auth/login` renders the form**, including the create-account affordance. *Reds if the
 *     bundle fails to mount — a blank 200 — or if the affordance is dropped.*
 *  2. **The affordance expands to a name field.** *Reds against a dead toggle: the control renders
 *     but the newbie path behind it does not open.*
 *  3. **A claim link's page renders the CONSENT SCREEN, and loading it signs nobody in**: the
 *     checkbox and a disabled Accept render, the token has left the address bar, and the browser
 *     holds no cookie. *Reds against a modal bypass — the failure that would let a click enrol
 *     someone silently — against Accept being live before the box is ticked, and against a page
 *     load that consumes.*
 *  4. **The box AND a nickname enable Accept; the box alone does not.** The positive control for
 *     limb 3 (without it, "disabled" would also pass on a button that is never enabled at all),
 *     plus the guard on the nickname staying a genuine condition rather than an optional field.
 *  5. **The self flavour carries the data-use notice.** *Reds against dropping the notice from the
 *     placement where a person actually commits.*
 *  6. **The page reached the server cleanly** — no console errors, no failed requests. The link
 *     page holds no token, so it makes no refresh to be refused. *Reds against a screen that looks
 *     right and is quietly 404ing its own bundle.*
 *  7. **The identity block: an optional full name, and a placeholder avatar that points at the
 *     editor.** *Reds if the consent screen grows an uploader (nothing here holds a session that
 *     could be authorized to store one) or regresses to the retired coming-soon stub.*
 *
 * `needsContainer = false` — auth screens only, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { requestUniverseClaim } from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = `render-${crypto.randomUUID().slice(0, 8)}`;
  const person = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;

    // ── LIMB 1: the login form renders ─────────────────────────────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: /Email me a link/ }).waitFor({ state: 'visible' });
    const affordance = page.getByRole('button', { name: /Create a new account/ });
    await affordance.waitFor({ state: 'visible' });
    console.error('  ✓ limb 1 — /auth/login renders the form and the create-account affordance');

    // ── LIMB 2: the affordance expands ─────────────────────────────────────────────────────────
    await affordance.click();
    await page.getByPlaceholder('acme').waitFor({ state: 'visible', timeout: 10_000 });
    console.error('  ✓ limb 2 — the affordance opens the name field');

    // ── Set up an UNACCEPTED membership by the real claim path, then land on Home ───────────────
    const waiter = waitForEmail({ testToken, instance: universe, to: person, timeout: 60_000 });
    let link: string;
    try {
      // ⚠️ Request the claim THROUGH vite — the same origin the page drives — never at the wrangler
      // port directly. The Worker builds the emailed link from the request origin, so requesting
      // where the page lives is what makes the link land there (the Studio proxy forwards the real
      // Host). Until 2026-09-02 this requested at the wrangler port and a helper re-pointed the
      // link at vite afterwards, which is exactly the compensating-helper shape that hid the
      // links-point-at-prod bug from every lane; the link is now followed AS SENT.
      const claimed = await requestUniverseClaim({ baseUrl: vite.viteBaseUrl, universe, appSlug: 'first', email: person });
      assert.notEqual(claimed, null, 'the claim was refused — the slug should be free');
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    assert.ok(link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the page's own origin as sent (got ${new URL(link).origin}, page is ${vite.viteBaseUrl})`);
    // The link opens its page on the platform host, which for a claim is the consent screen.
    //
    // ⚠️ **ONE navigation, not two.** A second `goto` here is not merely redundant: it CANCELS this
    // page's in-flight lookup, which Chromium reports as `net::ERR_ABORTED` on a request nothing was
    // wrong with — a failure the scenario causes itself and then trips limb 6 over. Readiness is
    // established by the auto-waiting locator below, never by a quiet-period heuristic
    // (`networkidle` is Playwright-discouraged for exactly this reason) and never by a fixed delay.
    await page.goto(link, { waitUntil: 'domcontentloaded' });

    // ── LIMB 3: the link's page renders the consent screen, Accept disabled, nobody signed in ──
    const checkbox = page.getByTestId('consent-checkbox');
    await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
    const accept = page.getByTestId('consent-accept');
    assert.equal(await accept.isDisabled(), true,
      'Accept must be disabled until the box is checked — the checkbox is what makes this a decision');
    const landed = new URL(page.url());
    assert.equal(landed.pathname, '/auth/magic-link', `the consent screen must be the link's own page, got ${landed.pathname}`);
    assert.equal(landed.searchParams.has('token'), false, 'the token must leave the address bar once the page loads');
    assert.deepEqual((await page.context().cookies()).map((c) => c.name), [],
      'loading the link must sign nobody in — the browser must hold no cookie before Accept');
    console.error('  ✓ limb 3 — the link page renders consent with Accept disabled; no token, no cookie');

    // ── LIMB 5 (read before clicking): the self flavour carries the notice ─────────────────────
    await page.getByTestId('data-use-notice').waitFor({ state: 'visible' });
    const selfWarning = await page.getByText('Only accept if you initiated this signup.').count();
    assert.equal(selfWarning, 1, 'the SELF flavour must lead with its warning');
    console.error('  ✓ limb 5 — the self flavour shows the warning and the data-use notice');

    // ── LIMB 4: the box AND a nickname enable Accept ───────────────────────────────────────────
    // ⚠️ Two conditions since 2026-09-02 (`canAccept`): the nickname is collected here, once, which
    // is what lets every app surface drop its own blocking name modal. The middle assertion is the
    // one that would notice it quietly becoming optional again.
    await checkbox.check();
    assert.equal(await accept.isDisabled(), true,
      'the box alone must NOT enable Accept — a nickname is the second condition');
    await page.getByTestId('consent-nickname').fill('Robin Render');
    assert.equal(await accept.isEnabled(), true,
      'Accept must become enabled once the box is checked AND a nickname is present — the positive '
      + 'control for limb 3');
    console.error('  ✓ limb 4 — the box alone is not enough; box + nickname enables Accept');

    // ── LIMB 7 (before 6, which reads cumulative state): the identity block ────────────────────
    // The optional full name renders beside the required nickname, and the avatar is a PLACEHOLDER
    // with a pointer, not an uploader: there is no session yet (no cookie exists until Accept), so
    // nothing here could be authorized to write a picture. The uploader lives in the Profile
    // editor, which `signup-to-first-app` drives end to end through R2.
    await page.getByTestId('consent-name').waitFor({ state: 'visible' });
    await page.getByText("Add a picture from your profile once you're in.").waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'I want this' }).count(), 0,
      'the consent avatar must not be a coming-soon stub any more — pictures are real');
    console.error('  ✓ limb 7 — optional full name renders; the avatar points at the profile editor');

    // ── LIMB 6: the page reached the server cleanly ─────────────────────────────────────────────
    const capture = await captureArtifacts(inst, 'auth-pages-render');
    const failed = capture.failedRequests.filter((r) => !r.url.includes('/favicon'));
    assert.deepEqual(failed, [], `the auth screens made failing requests: ${JSON.stringify(failed)}`);
    assert.deepEqual(capture.consoleErrors, [],
      `the auth screens logged console errors: ${capture.consoleErrors.join(' | ')}`);
    console.error(`  ✓ limb 6 — no failed requests, no console errors (capture: ${capture.dir})`);
  } finally {
    await vite.close();
    await browser.close();
  }

  console.error('  ── the auth screens render what a person is supposed to see');
}

/**
 * **The auth screens actually render — the half a green suite cannot see.**
 *
 * Phase 6 built the SPA and asserted its server side: the routes exist, the ticket is spendable only
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
 *  3. **`/auth/{scope}/home` renders the CONSENT MODAL for an unaccepted membership**, with its
 *     checkbox and a disabled Accept. *Reds against a modal bypass — the failure that would let a
 *     click enrol someone silently — and against Accept being live before the box is ticked.*
 *  4. **The box AND a nickname enable Accept; the box alone does not.** The positive control for
 *     limb 3 (without it, "disabled" would also pass on a button that is never enabled at all),
 *     plus the guard on the nickname staying a genuine condition rather than an optional field.
 *  5. **The self flavour carries the data-use notice.** *Reds against dropping the notice from the
 *     placement where a person actually commits.*
 *  6. **The page reached the server cleanly** — no console errors, no failed requests. *Reds
 *     against a screen that looks right and is quietly 404ing its own bundle.*
 *  7. **The identity block: an optional full name, and an avatar that opens a coming-soon panel.**
 *     *Reds if the picture affordance starts pretending to work, and — by clicking through to the
 *     confirmation — if its tag is not one the server's closed set recognises, which is the mistake
 *     every new coming-soon stub makes and which a 400 would otherwise hide behind a generic error.*
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
      const claimed = await requestUniverseClaim({ baseUrl: vite.viteBaseUrl, universe, email: person });
      assert.notEqual(claimed, null, 'the claim was refused — the slug should be free');
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    assert.ok(link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the page's own origin as sent (got ${new URL(link).origin}, page is ${vite.viteBaseUrl})`);
    // The click lands the cookies on the page's own origin because the link already names it.
    // ⚠️ `networkidle`, not `domcontentloaded`: the landing page starts its own bootstrap fetches,
    // and navigating to Home below while one is in flight CANCELS it — which Chromium reports as
    // `net::ERR_ABORTED` on a request nothing was wrong with, reddening limb 6 for a failure this
    // scenario caused itself. Letting the page it is leaving finish is the fix; filtering the abort
    // would have blinded the guard instead.
    await page.goto(link, { waitUntil: 'networkidle' });

    // ── LIMB 3: Home renders the consent modal, Accept disabled ────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/auth/${universe}/home`, { waitUntil: 'domcontentloaded' });
    const checkbox = page.getByTestId('consent-checkbox');
    await checkbox.waitFor({ state: 'visible', timeout: 20_000 });
    const accept = page.getByTestId('consent-accept');
    assert.equal(await accept.isDisabled(), true,
      'Accept must be disabled until the box is checked — the checkbox is what makes this a decision');
    console.error('  ✓ limb 3 — the consent modal renders with Accept disabled');

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
    // The optional full name renders beside the required nickname…
    await page.getByTestId('consent-name').waitFor({ state: 'visible' });
    // …and the avatar is a COMING-SOON affordance rather than an uploader, because nothing writes
    // `picture` yet. Clicking it must open the panel.
    await page.getByTestId('consent-avatar').click();
    const wantIt = page.getByRole('button', { name: 'I want this' });
    await wantIt.waitFor({ state: 'visible', timeout: 10_000 });
    // ⚠️ **Clicking through is what proves the TAG is in the server's closed set.** The endpoint
    // refuses an unrecognised tag with a 400, which the component shows as a failure — so the
    // success text below reds on a stub wired to a tag nobody registered, which is exactly the
    // mistake a new coming-soon surface makes.
    await wantIt.click();
    await page.getByText('Noted — thank you.').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('coming-soon-close').click();
    // Back to the consent decision, undisturbed — the panel is a detour, not a replacement.
    assert.equal(await accept.isEnabled(), true,
      'closing the coming-soon panel must leave the consent decision exactly as it was');
    console.error('  ✓ limb 7 — optional full name renders; the avatar opens a coming-soon panel that records');

    // ── LIMB 6: the page reached the server cleanly, and its ONE refusal is the designed one ───
    const capture = await captureArtifacts(inst, 'auth-pages-render');

    // ⚠️ **The bootstrap 401 is EXPECTED and is asserted rather than filtered away.** Home refreshes
    // on arrival; the membership is unaccepted; the server refuses. That refusal is the
    // inert-until-accepted design working, and it is the thing that sends Home to the
    // pending-membership card — so a run WITHOUT it means the modal rendered off a live session,
    // which is the failure this whole flow exists to prevent. A blanket "no failed requests" check
    // would have to swallow it, and would then swallow a real one too.
    const isBootstrapRefusal = (r: { url: string; status: number | 'failed' }) =>
      r.url.includes(`/auth/${universe}/refresh-token`) && (r.status === 401 || r.status === 'failed');
    assert.ok(capture.failedRequests.some((r) => isBootstrapRefusal(r) && r.status === 401),
      'the arrival refresh did NOT 401 — the modal would then be decorating a live session');

    const unexpected = capture.failedRequests
      .filter((r) => !r.url.includes('/favicon'))
      .filter((r) => !isBootstrapRefusal(r));
    assert.deepEqual(unexpected, [],
      `the auth screens made UNEXPECTED failing requests: ${JSON.stringify(unexpected)}`);
    // The browser also logs the same designed 401 as a console error — excluded by its exact shape,
    // never by muting the channel, so a genuine script error still reds this.
    const noisyConsole = capture.consoleErrors
      .filter((m) => !/Failed to load resource.*401/.test(m));
    assert.deepEqual(noisyConsole, [],
      `the auth screens logged console errors: ${noisyConsole.join(' | ')}`);
    console.error(`  ✓ limb 6 — the only refusal is the designed 401; no console errors (capture: ${capture.dir})`);
  } finally {
    await vite.close();
    await browser.close();
  }

  console.error('  ── the auth screens render what a person is supposed to see');
}

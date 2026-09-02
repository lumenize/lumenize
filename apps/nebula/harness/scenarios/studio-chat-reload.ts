/**
 * Drive the rendered Studio through login → post → reload, ASSERTING ON RENDER (the collapse's
 * Phase 4 rewrite — the old optimistic-echo assumption is gone): the posted marker must render from
 * the durable Message SUBSCRIPTION before the reload, and render AGAIN after it (fresh-heap history
 * restore). Captures (screenshot + a11y + console/network) ride every leg.
 *
 * Login uses the REAL magic-link loop (reusing the ui-smoke email helpers) — the proven path. See
 * FINDINGS.md for why cookie/token injection (skip-login) resists: the Studio SPA drives its own
 * cookie-based refresh, so there's no client-side accessToken injection point without editing the SPA.
 *
 * ⚠️ **The profile-completion limbs were REMOVED on 2026-09-02, and that is a design change rather
 * than a coverage cut.** They asserted a blocking "what should we call you?" modal in Studio, plus
 * the byline back-filling on a message posted before the identity had a name. The nickname is now
 * collected once at the consent modal every arrival passes through (`ConsentModal.vue` /
 * `canAccept`), so Studio has no completion gate to assert and a human can no longer reach a thread
 * unnamed — the transient those limbs watched is unreachable by construction. The underlying
 * mechanism (a profile write fans out and updates a live subscriber's byline) is still exercised at
 * the API level by `baseline/profile-subscribe.test.ts` § *the back-fill leg*, which is where it
 * belongs now that only a PROGRAMMATIC identity can be in that state.
 *
 * @see tasks/archive/claude-live-verification.md — Phase 2
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { bootStudioVite, launchChromium, instrumentedPage, captureArtifacts } from '../lib/browser';
// Reuse the ui-smoke email loop (Node-safe, filters by scope) rather than duplicating it.
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { provisionAndLogin } from '../../test/lib/email-login';

/** The UNIVERSE the browser logs in at (login never mints — membership must exist, and the
 *  member's membership is AT the universe), and the workspace GALAXY beneath it that Studio
 *  opens — post-collapse Studio's working scope is `{u}.{g}`; the `.dev` star exists only
 *  inside the preview iframe. Provisioned by the API driver (`provisionAndLogin`) before the
 *  browser drives the SAME email through the rendered login form. */
const UNIVERSE = 'claude-browser';
const SCOPE = `${UNIVERSE}.app`;
/** The galaxy's slug — what the Universe page labels its app row with. */
const APP_SLUG = SCOPE.slice(UNIVERSE.length + 1);
/** Login email — MUST be an `@lumenize.io` address CF Email Routing forwards to the email-test
 *  Worker (the catch-all). A fresh address per run keeps the claim path clean. */
const LOGIN_EMAIL = process.env.HARNESS_LOGIN_EMAIL ?? `test-${Date.now().toString(36)}@lumenize.io`;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');

  // 0. PROVISION through the real claim path (API): claims the universe for LOGIN_EMAIL and
  //    creates the workspace galaxy beneath it. Login never mints, so a browser login only
  //    works for an email with a membership — this is what creates it, by the same path a
  //    real user's first visit does.
  await provisionAndLogin({ baseUrl: stack.baseUrl, scope: SCOPE, email: LOGIN_EMAIL, testToken });

  const { viteBaseUrl, close: closeVite } = await bootStudioVite(stack.baseUrl);
  const browser = await launchChromium();

  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    const ctx = page.context();

    // 1. The front door is the AUTH SPA, not Studio. Studio no longer carries a login of its own —
    //    a person proves their address first and chooses a destination afterwards, so there is no
    //    scope to name here and nothing about the address is known before the click.
    await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });

    // 2. Real-email login: arm the waiter, drive the form, extract the link, land the cookies on the
    //    vite origin (ctx.request shares the context cookie jar).
    //    The email loop is a real external dependency (CF Email Sending → Routing → email-test Worker)
    //    and its latency varies — a generous timeout keeps the harness from flaking on a slow delivery
    //    (a `No email received` timeout here is that flake, NOT a code defect). See FINDINGS.md.
    //    ⚠️ `_scopeless`: the request names no scope, so its mail carries no scope tag.
    const waiter = waitForEmail({ testToken, instance: '_scopeless', to: LOGIN_EMAIL, timeout: 120_000 });
    let link: string;
    try {
      await page.getByPlaceholder('you@example.com').fill(LOGIN_EMAIL);
      await page.getByRole('button', { name: /Email me a link/ }).click();
      await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    const u = new URL(link);
    await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);

    // 2b. Enter through HOME — the real journey, and the only thing that makes the GALAXY reachable.
    //     The cookie sits at `/auth/{universe}` and never travels to `/auth/{universe}.{galaxy}/…`
    //     (RFC 6265 stops at the `.`), so Studio learns which cookie to spend from the hand-off hint
    //     written on the way out.
    //     ⚠️ **Home renders no row to pick.** A lone ACCEPTED membership fast-forwards to its own
    //     surface, which for a universe is its Universe page — so the galaxy is entered by clicking
    //     the app there (`surfaceFor`/`fastForwardTarget`, 2026-09-02).
    await page.goto(`${viteBaseUrl}/auth/${UNIVERSE}/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(new RegExp(`//[^/]+/${UNIVERSE}(?:[/?#]|$)`), { timeout: 30_000 });
    const appRow = page.getByRole('button', { name: APP_SLUG, exact: true });
    await appRow.waitFor({ state: 'visible', timeout: 30_000 });
    await appRow.click();
    await page.waitForURL(new RegExp(`//[^/]+/${SCOPE.replace(/\./g, "\\.")}(?:[/?#]|$)`), { timeout: 30_000 });

    // 3. Connected → the chat input renders. This is the harness's real gate (login worked).
    //    On failure, capture the page + console + network FIRST — "never connected" has many
    //    causes and the artifacts disambiguate (transient-surface discipline, testing.md).
    try {
      await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'studio-chat-connect-failed');
      throw e;
    }

    // 4. Submit a chat turn with a marker. There is NO optimistic echo any more (the
    //    collapse's Phase 4): the sender's own message renders from the durable Message
    //    SUBSCRIPTION like everyone else's — so this wait ASSERTS the whole
    //    post → commit → fanout → subscription-render pipeline, capable of failing.
    const marker = `harness browser check ${Date.now()}`;
    await page.getByPlaceholder('Describe a change…').fill(marker);
    await page.getByPlaceholder('Describe a change…').press('Enter');
    await page.getByText(marker).first().waitFor({ state: 'visible', timeout: 20_000 });
    // 5a. CAPTURE BEFORE reload — proof of what the turn actually produced on screen (or that it
    //     didn't echo). Without this, "empty after reload" is ambiguous (never-posted vs lost).
    const before = await captureArtifacts(inst, 'studio-chat-before-reload');

    // 5b. RELOAD — the fresh-heap path: the SPA reconnects, re-opens the thread
    //    subscription, and the marker renders AGAIN from the durable Message (history
    //    restore). Asserted, not reported — this is exactly what the old scenario's
    //    optimistic echo could not distinguish.
    await page.goto(`${viteBaseUrl}/${SCOPE}`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText(marker).first().waitFor({ state: 'visible', timeout: 20_000 });
    const after = await captureArtifacts(inst, 'studio-chat-after-reload');
    const renderedAfterReload = (await page.getByText(marker).count()) > 0;

    // ⚠️ No dialog may be open on a settled Studio. Asserted on the [open] ATTRIBUTE, not on
    // visibility — daisyUI transitions `visibility` over .3s, so isVisible() can catch the tail of a
    // closing flash. Studio has no completion gate any more (see the header), so this is the
    // regression guard against one coming back by accident.
    assert.equal(await page.locator('dialog.modal[open]').count(), 0,
      'a settled Studio must show no blocking dialog — the nickname is taken at consent, not here');

    // Assert the HARNESS produced BOTH captures (capable-of-failing on the harness, not the feature).
    const { existsSync, statSync } = await import('node:fs');
    for (const cap of [before, after]) {
      assert.ok(existsSync(cap.screenshotPath) && statSync(cap.screenshotPath).size > 0,
        `${cap.label}: harness must produce a non-empty screenshot`);
      assert.ok(existsSync(cap.a11yPath) && statSync(cap.a11yPath).size > 0,
        `${cap.label}: harness must produce an a11y snapshot`);
    }

    console.error(`[studio-chat-reload] turn rendered via the subscription, pre- AND post-reload`);
    console.error(`[studio-chat-reload] turn present after reload:  ${renderedAfterReload}`);
    console.error(`[studio-chat-reload] captures → ${before.dir} , ${after.dir}`);
    const refresh401 = after.failedRequests.filter((r) => r.url.includes('/refresh-token'));
    console.error(`[studio-chat-reload] cumulative console errors: ${after.consoleErrors.length}, failed requests: ${after.failedRequests.length} (refresh-token failures: ${refresh401.length})`);
  } finally {
    await browser.close().catch(() => {});
    await closeVite().catch(() => {});
  }
}

/**
 * Drive the rendered Studio through login → post → reload, ASSERTING ON RENDER (the
 * collapse's Phase 4 rewrite — the old optimistic-echo assumption is gone): the posted
 * marker must render from the durable Message SUBSCRIPTION before the reload, and render
 * AGAIN after it (fresh-heap history restore). Captures (screenshot + a11y +
 * console/network) ride every leg for the evidence trail.
 *
 * Login uses the REAL magic-link loop (reusing the ui-smoke email helpers) — the proven path. See
 * FINDINGS.md for why cookie/token injection (skip-login) resists: the Studio SPA drives its own
 * cookie-based refresh, so there's no client-side accessToken injection point without editing the SPA.
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
/** Login email — MUST be an `@lumenize.io` address CF Email Routing forwards to the email-test
 *  Worker (the catch-all). A fresh address per run keeps the claim path clean. */
const LOGIN_EMAIL = process.env.HARNESS_LOGIN_EMAIL ?? `test-${Date.now().toString(36)}@lumenize.io`;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');

  // 0. PROVISION through the real claim path (API): claims the universe for LOGIN_EMAIL and
  //    creates the workspace galaxy beneath it. Login never mints, so a browser login only
  //    works for an email with a membership — this is what creates it, by the same path a
  //    real user's first visit does.
  const provisioned = await provisionAndLogin({
    baseUrl: stack.baseUrl, scope: SCOPE, email: LOGIN_EMAIL, testToken,
  });
  void provisioned; // the browser establishes its OWN session below — the API one just provisioned

  const { viteBaseUrl, close: closeVite } = await bootStudioVite(stack.baseUrl);
  const browser = await launchChromium();

  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    const ctx = page.context();

    // 1. Load the Studio at the UNIVERSE (where the membership lives — the form targets the
    //    URL scope, and a galaxy-scoped magic link would find no membership).
    await page.goto(`${viteBaseUrl}/studio/${UNIVERSE}`, { waitUntil: 'domcontentloaded' });

    // 2. Real-email login: arm the waiter, drive the form, extract the link, land the cookie on the
    //    vite origin (ctx.request shares the context cookie jar), then reload → auto-connect.
    //    The email loop is a real external dependency (CF Email Sending → Routing → email-test Worker)
    //    and its latency varies — a generous timeout keeps the harness from flaking on a slow delivery
    //    (a `No email received` timeout here is that flake, NOT a code defect). See FINDINGS.md.
    const waiter = waitForEmail({ testToken, instance: UNIVERSE, to: LOGIN_EMAIL, timeout: 120_000 });
    let link: string;
    try {
      await page.getByPlaceholder('you@example.com').fill(LOGIN_EMAIL);
      await page.getByRole('button', { name: /Send magic link/ }).click();
      await page.getByText(/Magic link sent to/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    const u = new URL(link);
    await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);
    // Reload at the universe → auto-connect → nudgeNextStep sees exactly ONE galaxy and opens
    // its workspace (`openWorkspace`), which is where the chat input renders. This drives the
    // REAL post-collapse journey: universe login → workspace at the galaxy.
    await page.goto(`${viteBaseUrl}/studio/${UNIVERSE}`, { waitUntil: 'domcontentloaded' });

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
    await page.goto(`${viteBaseUrl}/studio/${SCOPE}`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText(marker).first().waitFor({ state: 'visible', timeout: 20_000 });
    const after = await captureArtifacts(inst, 'studio-chat-after-reload');
    const renderedAfterReload = (await page.getByText(marker).count()) > 0;

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

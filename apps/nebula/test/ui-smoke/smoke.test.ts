/**
 * Studio UI smoke — raw Playwright drives the *rendered* Studio under the model-A
 * dev stack (vite-served SPA → proxy → `wrangler dev` + Docker DevContainer).
 *
 * The layer above ①'s routing-contract test and the API-level `smoke.test.ts`: it
 * confirms the Studio actually works end-to-end through the UI before F&F invites.
 *
 * Gated `describe.runIf(HAS_DOCKER && HAS_CF_CREDS)` — skips cleanly with no failure
 * when the real infra is absent (default `npm test` doesn't even enumerate this
 * project; run it with `npx vitest run --project ui-smoke`).
 *
 * Login uses the REAL email magic-link loop (never test-mode), so the same test body
 * runs identically local + (later) prod. Reuses only the Node-side `waitForEmail` /
 * `extractMagicLink` helpers; Playwright itself navigates the magic-link URL THROUGH
 * the vite origin so the `Secure;SameSite=Strict;Path=/auth/{scope}` refresh cookie
 * lands natively in the BrowserContext (no Node-`Browser`-jar → context transfer).
 *
 * Structure (per feedback_e2e_test_granularity): one cheap pre-login shell check, then
 * one narrative authenticated flow (login → connected → prompt → preview), with the
 * destructive `.dev` wipe LAST in afterAll.
 *
 * @see tasks/nebula-local-smoke.md
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { waitForEmail, extractMagicLink } from '../browser/auth-bootstrap';
import { HAS_DOCKER, HAS_CF_CREDS } from './gates';

/** Dedicated test scope — `test-` prefix is the reaper's auto-reap marker. Must be valid
 *  for BOTH slug validators: dag-ops `SLUG_REGEX` (no leading/trailing hyphen) AND the
 *  stricter nebula-auth `parse-id.isValidSlug` (ALSO no consecutive hyphens), so a single
 *  hyphen — NOT `test--`. Separate from any manually-claimed scope; ends in `.dev` so
 *  `resetDevData` (the teardown) accepts it. */
const TEST_SCOPE = 'test-u0.test-g0.dev';
/** Bootstrap admin email = the address CF Email Routing forwards to the email-test Worker. */
const ADMIN_EMAIL = 'test@lumenize.io';

describe.runIf(HAS_DOCKER && HAS_CF_CREDS)('Studio UI smoke (wrangler dev + Docker)', () => {
  let browser: Browser;
  let viteBaseUrl: string;
  let workerBaseUrl: string;
  let testToken: string;
  /** Authenticated context, shared by the narrative steps + the wipe teardown. */
  let authed: { ctx: BrowserContext; page: Page } | null = null;

  beforeAll(async () => {
    viteBaseUrl = inject('viteBaseUrl');
    workerBaseUrl = inject('workerBaseUrl');
    testToken = inject('emailTestToken');
    browser = await chromium.launch();
  });

  afterAll(async () => {
    // Destructive cleanup LAST: wipe the .dev Star data via the Studio's own "Wipe"
    // button (Star.resetDevData). Best-effort — a leftover DO with no traffic costs
    // ~nothing, and a chat turn regenerates source+preview over any stale state.
    if (authed) {
      try {
        await authed.page.getByRole('button', { name: /Wipe/ }).click();
        await authed.page.getByText('Wiped .dev data.').waitFor({ state: 'visible', timeout: 15_000 });
      } catch {
        /* best-effort */
      }
      await authed.ctx.close();
    }
    await browser?.close();
  });

  it('Studio shell renders at the vite origin (pre-login)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${viteBaseUrl}/app/${TEST_SCOPE}`, { waitUntil: 'domcontentloaded' });

      // Capable-of-failing: each waitFor auto-waits and THROWS (fails the test) if the
      // element never appears — reds if the SPA fails to mount (build/bundle break) or
      // the shell doesn't render. The send-magic-link control (email field + "Send magic
      // link" submit) is the DISCRIMINATING unauthenticated marker — the post-login chat
      // ALSO renders a <form>+<input>, so "a form exists" would be vacuous. Its presence
      // confirms auto-connect correctly FAILED with no cookie (the auth-path negative control).
      await page.getByRole('heading', { name: 'Nebula Studio' }).waitFor({ state: 'visible' });
      await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Send magic link/ }).waitFor({ state: 'visible' });
      expect(await page.locator('iframe[title="Preview"]').count()).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('real-email login via the in-UI form → Studio reaches connected + shell renders', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // 1. Load the Studio at the explicit test scope via the canonical path form (`/app/{scope}`,
    //    the same form the magic link redirects to). ui-smoke DELIBERATELY uses the explicit-scope
    //    path — it covers the FORM WIRING, NOT App.vue's discovery-resolve branch (discovery's
    //    automated coverage is the deferred random-scope-per-run upgrade, backlog.md:110). Don't
    //    over-credit this as discovery cover.
    await page.goto(`${viteBaseUrl}/app/${TEST_SCOPE}`, { waitUntil: 'domcontentloaded' });

    // 2. Arm the email waiter BEFORE driving the form (listen first, then send), then DRIVE the
    //    real-email login form — type the email + click "Send magic link" — in place of the old
    //    Node-side fetch POST. This gives the form capable-of-failing coverage under vite-dev.
    const waiter = waitForEmail({ testToken, instance: TEST_SCOPE });
    let link: string;
    try {
      await page.getByPlaceholder('you@example.com').fill(ADMIN_EMAIL);
      await page.getByRole('button', { name: /Send magic link/ }).click();
      // The "sent" confirmation only renders if the POST succeeded (sendMagicLink sets it on the
      // 2xx path only) — reds if the form misfired or the magic-link POST 4xx'd.
      await page.getByText(/Magic link sent to/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }

    // 3. Navigate the magic link THROUGH the vite origin (not the worker host) so the
    //    Set-Cookie lands on the Studio origin. context.request shares the context's
    //    cookie jar, so the refresh cookie is captured without loading a page.
    const u = new URL(link);
    await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);

    // 4. Reload the authenticated Studio → onMounted auto-connect uses the cookie.
    await page.goto(`${viteBaseUrl}/app/${TEST_SCOPE}`, { waitUntil: 'domcontentloaded' });

    // Capable-of-failing: reds if the shell fails to render or the /gateway connect never
    // completes. The chat input ("Describe a change…") only renders when `connected` (the v-else
    // form), AND the send-magic-link control is gone (count==0). The count==0 is load-bearing: the
    // email-login form sits in the SAME `v-if="!connected"` slot, so a failed connect would leave
    // it present — removing that gate (mutation) would red this.
    await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.getByRole('button', { name: /Send magic link/ }).count()).toBe(0);
    await page.getByRole('heading', { name: 'Nebula Studio' }).waitFor({ state: 'visible' });
    expect(await page.locator('iframe[title="Preview"]').count()).toBe(1);

    authed = { ctx, page }; // hand off to the prompt step + the wipe teardown
  });

  it('prompt → DevStudio.chat codegen loop updates the preview (env.AI + Docker)', async () => {
    expect(authed, 'login step must have established a session').not.toBeNull();
    const { page } = authed!;

    // Snapshot the preview src; a completed chat turn appends a ?t= cache-buster
    // (App.vue reloadPreview), so its appearance proves the full
    // chat → DevStudio.chat → codegen → /dev-container preview loop ran.
    const srcBefore = await page.locator('iframe[title="Preview"]').getAttribute('src');

    await page.getByPlaceholder('Describe a change…').fill('Make a simple counter with an increment button');
    await page.getByPlaceholder('Describe a change…').press('Enter');

    // The model call + Rung-1 compile gate + container preview can take a while
    // (cold container build on the first /dev-container hit). Generous timeout.
    await page.waitForFunction(
      (prev) => {
        const src = document.querySelector('iframe[title="Preview"]')?.getAttribute('src') ?? '';
        return src.includes('?t=') && src !== prev;
      },
      srcBefore,
      { timeout: 180_000, polling: 500 },
    );

    // The regenerated app actually RENDERS in the container-served preview — catches the
    // blank-`<script setup>` bug (sfc-compile-needs-bindingmetadata) AND proves the container
    // received the new source, not just that the chat turn completed + the iframe reloaded.
    const previewBody = page.frameLocator('iframe[title="Preview"]').locator('body');
    await expect
      .poll(async () => (await previewBody.textContent().catch(() => ''))?.trim().length ?? 0, {
        timeout: 60_000,
        interval: 1000,
      })
      .toBeGreaterThan(0);

    // A studio reply bubble landed (the turn produced a response, not an error).
    const errorBubbles = await page.locator('.chat-bubble-error').count();
    expect(errorBubbles, 'the chat turn should not have errored').toBe(0);
  });

  it('preview ignores a request-supplied scope decoy + the command-port header (security)', async () => {
    // The public `/dev-container` GET injects the SERVER-DERIVED scope (from the URL path),
    // never a request-supplied one, and can't be redirected to the container command port.
    // Rides the warm container the prompt step spun up for TEST_SCOPE (Node-side fetch — the
    // preview GET is ungated). Replaces the old in-process `?activeScope=evil`/`cf-container-
    // target-port:9000` decoy `it.skip` with a top-down check.
    const res = await fetch(`${workerBaseUrl}/dev-container/${TEST_SCOPE}/?activeScope=evil.other.dev`, {
      headers: { 'cf-container-target-port': '9000' },
    });
    expect(res.ok, `preview GET should succeed: ${res.status}`).toBe(true);
    const html = await res.text();

    const meta = html.match(/name="nebula-scope" content='([^']*)'/)?.[1];
    expect(meta, 'preview HTML must carry the injected nebula-scope meta').toBeTruthy();
    const scope = JSON.parse(meta!) as { activeScope: string };
    // Capable-of-failing: if fetch() trusted the query, activeScope would be the decoy.
    expect(scope.activeScope).toBe(TEST_SCOPE); // server-derived from the URL path
    expect(scope.activeScope).not.toContain('evil'); // the `?activeScope=` decoy is ignored
    // The preview HTML (with its injected meta) being served at all proves the
    // `cf-container-target-port:9000` header did NOT route us to the command server.
  });
});

/**
 * Studio UI smoke — raw Playwright drives the *rendered* Studio under the model-A
 * dev stack (vite-served SPA → proxy → `wrangler dev` + Docker DevContainer).
 *
 * The layer above ①'s routing-contract test and the API-level `smoke.test.ts`: it
 * confirms the Studio actually works end-to-end through the UI before F&F invites.
 *
 * Gated `describe.runIf(HAS_DOCKER && HAS_AI_PATH)` — skips cleanly with no failure
 * when the real infra is absent (default `npm test` doesn't even enumerate this
 * project; run it with `npx vitest run --project ui-smoke`).
 *
 * Login uses the REAL email magic-link loop (never test-mode), so the same test body
 * runs identically local + (later) prod. Playwright follows the emailed link as sent, to the
 * platform host's link page, and its Continue sets the `__Host-refresh-token.{scope}` cookie
 * there natively in the BrowserContext (no Node-`Browser`-jar → context transfer).
 *
 * Structure (per feedback_e2e_test_granularity): one cheap pre-login shell check, then
 * one narrative authenticated flow (login → connected → prompt → preview), with the
 * destructive `.dev` wipe LAST in afterAll.
 *
 * @see tasks/nebula-local-smoke.md
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { provisionAndLogin, scopeOriginFrom } from '../lib/email-login';
import { HAS_DOCKER, HAS_AI_PATH } from './gates';
import { launchChromium, loginToStudio } from './helpers';

/** Dedicated test scope — `test-` prefix is the reaper's auto-reap marker. Must pass
 *  Mesh's `isValidSlug` (no leading, trailing or consecutive hyphens, at most 30
 *  characters), so a single hyphen — NOT `test--`. Separate from any manually-claimed scope; the working scope is the
 *  GALAXY post-collapse — the Wipe teardown targets its `.dev` star (`{scope}.dev`). */
const TEST_SCOPE = 'test-u0.test-g0';
/** The account that owns the workspace; its page is where an app is created. */
const TEST_UNIVERSE = TEST_SCOPE.split('.')[0];
/** Fresh per run, so no other lane's mail can answer this lane's waiter (`testing.md`). */
const ADMIN_EMAIL = uniqueTestEmail('ui-smoke');

describe.runIf(HAS_DOCKER && HAS_AI_PATH)('Studio UI smoke (wrangler dev + Docker)', () => {
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
    browser = await launchChromium();
  });

  afterAll(async () => {
    // Destructive cleanup LAST: wipe the .dev Star data via the Studio's own "Wipe"
    // button (Star.resetDevData). Best-effort — a leftover DO with no traffic costs
    // ~nothing, and a chat turn regenerates source+preview over any stale state.
    if (authed) {
      try {
        await authed.page.getByRole('button', { name: /Wipe/ }).click();
        await authed.page.getByText('Wiped the development test data.').waitFor({ state: 'visible', timeout: 15_000 });
      } catch {
        /* best-effort */
      }
      await authed.ctx.close();
    }
    await browser?.close();
  });

  it("a signed-out visit to Studio's host is sent to the platform host's login, and back", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const studio = scopeOriginFrom(viteBaseUrl, TEST_SCOPE);
      await page.goto(`${studio}/`, { waitUntil: 'domcontentloaded' });

      // Capable-of-failing: reds if the SPA fails to mount (it is what sends the visit on) or the
      // refresh stops answering 401 to a browser holding no cookie. The login names Studio as where
      // to return, so a person signing in lands back where they started.
      await page.waitForURL((u) => u.origin === viteBaseUrl && u.pathname === '/auth/login', { timeout: 30_000 });
      expect(new URL(page.url()).searchParams.get('return_to')).toBe(`${studio}/`);
      await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible' });
      // Nothing of Studio rendered on the way: no composer, and no preview of the workspace.
      expect(await page.getByPlaceholder('Describe a change…').count()).toBe(0);
      expect(await page.locator('iframe[title="Preview"]').count()).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it("real-email login on the platform host → Home's fast-forward → into the app workspace", async () => {
    // 0. PROVISION through the real claim path (API): claims `test-u0` for ADMIN_EMAIL and
    //    creates the workspace galaxy beneath it — global-setup wipes `.wrangler/state`, so
    //    every run claims fresh. Login never mints; this is what creates the membership the
    //    in-UI form's magic link needs, by the same path a real user's first visit does.
    await provisionAndLogin({ baseUrl: workerBaseUrl, scope: TEST_SCOPE, email: ADMIN_EMAIL, testToken });

    // 1–4. The login form on the platform host, the emailed link followed as sent, Continue, and
    //      Home, which fast-forwards an account holding one app straight into that app's Studio
    //      on the workspace's own host.
    const { ctx, page } = await loginToStudio({ browser, viteBaseUrl, testToken, scope: TEST_SCOPE, email: ADMIN_EMAIL });

    // 5. Studio, on the workspace's host, with nothing to complete on arrival. The composer
    //    `loginToStudio` waited for renders only once the /gateway connect completes, and that
    //    connect needs this host's refresh to find the universe's cookie on the platform host. The
    //    nickname is collected once at the consent modal, so Studio has no blocking gate of its
    //    own — asserted as the absence of an open dialog, which is what would red if one came back.
    await page.getByRole('heading', { name: 'Lumenize Studio' }).waitFor({ state: 'visible' });
    expect(await page.locator('dialog.modal[open]').count()).toBe(0);
    expect(await page.locator('iframe[title="Preview"]').count()).toBe(1);
    // The preview renders on connect with NO refresh cue: `dist/` serves from the Galaxy's VFS, so
    // the iframe frames the dev Star's own host and only a build's reply ever bumps it.
    expect(await page.locator('iframe[title="Preview"]').getAttribute('src'))
      .toBe(`${scopeOriginFrom(viteBaseUrl, `${TEST_SCOPE}.dev`)}/`);

    authed = { ctx, page }; // hand off to the prompt step + the wipe teardown
  });

  it("create an app from the account's page — the flow with zero automated coverage until now", async () => {
    // ⚠️ **This is the create-app flow `backlog.md` § *Nebula* recorded as having NO automated
    // coverage.** A break would surface as a user-developer unable to make their second app.
    expect(authed, 'login step must have established a session').not.toBeNull();
    // A second tab of the same person, so the workspace page the codegen case shares stays put.
    const page = await authed!.ctx.newPage();
    try {
      // The account already has an app, so the page lists it, and `?create` opens the form.
      await page.goto(`${scopeOriginFrom(viteBaseUrl, TEST_UNIVERSE)}/?create`, { waitUntil: 'domcontentloaded' });
      const slugField = page.getByPlaceholder('crm');
      await slugField.waitFor({ state: 'visible', timeout: 30_000 });

      // A fresh name per run — global-setup wipes state, but a retry inside one run must not 409.
      const appSlug = `smoke-${Date.now().toString(36).slice(-6)}`;
      await slugField.fill(appSlug);
      await page.getByRole('button', { name: 'Create', exact: true }).click();

      // ⚠️ Landing in the NEW app's Studio is the assertion, not the absence of an error: it happens
      // only once the galaxy really exists and its host's refresh mints there.
      await page.waitForURL((u) => u.origin === scopeOriginFrom(viteBaseUrl, `${TEST_UNIVERSE}.${appSlug}`), { timeout: 60_000 });
      await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 60_000 });
    } finally {
      await page.close();
    }
  });

  // Un-skipped 2026-08-29: the "no kernel FUSE locally so the build can't run" premise was
  // FALSE — it was the root-level VFS seeding bug observed locally (the mount serves the
  // VFS's /workspace SUBTREE; local computerd materializes it onto the container's real
  // disk, so real processes see it). With WS_ROOT paths the full build runs under local
  // `wrangler dev` + Docker — harness/scenarios/build-box.ts passes its whole contract
  // locally. Timeout 240s: the inner waitForFunction budget is 180s.
  it('prompt → Galaxy chat codegen loop + build updates the preview (env.AI + Docker)', { timeout: 240_000 }, async () => {
    expect(authed, 'login step must have established a session').not.toBeNull();
    const { page } = authed!;

    // ⚠️ A preview that serves its shell but mounts nothing leaves `<div id="app"></div>` and no
    // other trace — the failure is a JS error or a missing bundle INSIDE the iframe, and neither
    // reaches the test otherwise. These listeners cover every frame on the page, so the sample
    // below can say WHICH of the two it was instead of only that the text stayed empty.
    const previewErrors: string[] = [];
    page.on('pageerror', (err) => previewErrors.push(`pageerror: ${String(err).split('\n')[0]}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') previewErrors.push(`console: ${msg.text().slice(0, 200)}`);
    });
    page.on('requestfailed', (req) => {
      previewErrors.push(`requestfailed: ${req.url().slice(-80)} ${req.failure()?.errorText ?? ''}`);
    });

    // Snapshot the preview src; a completed chat turn appends a ?t= cache-buster
    // (App.vue reloadPreview), so its appearance proves the full
    // chat → Galaxy codegen → build → /app preview loop ran.
    const srcBefore = await page.locator('iframe[title="Preview"]').getAttribute('src');

    await page.getByPlaceholder('Describe a change…').fill('Make a simple counter with an increment button');
    await page.getByPlaceholder('Describe a change…').press('Enter');

    // The model call + the ephemeral container build job (ontology compile + type
    // check + vite build — every check runs in the box now) can take a while (cold
    // container + FUSE mount on the first build). Generous timeout.
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
    //
    // ⚠️ The sample REPORTS what it saw. An earlier cut was `.catch(() => '')`, which collapsed
    // "the app rendered nothing", "the frame was unreadable" and "the iframe points at a 404" into
    // the same `expected 0 to be greater than 0` — a failure that says only that the number stayed
    // zero, which is the least useful thing about it. Every diagnosis then costs a 2-minute rerun.
    const previewBody = page.frameLocator('iframe[title="Preview"]').locator('body');
    let seen = 'never sampled';
    const renderedTextLength = async (): Promise<number> => {
      const src = await page.locator('iframe[title="Preview"]').getAttribute('src') ?? '(no src)';
      try {
        const text = ((await previewBody.textContent()) ?? '').trim();
        const html = (await previewBody.innerHTML()).replace(/\s+/g, ' ').trim();
        seen = `src=${src} textLen=${text.length} html(300)=${JSON.stringify(html.slice(0, 300))}`;
        return text.length;
      } catch (err) {
        seen = `src=${src} frame unreadable: ${String(err).split('\n')[0]}`;
        return 0;
      }
    };
    try {
      await expect.poll(renderedTextLength, { timeout: 60_000, interval: 1000 }).toBeGreaterThan(0);
    } catch (err) {
      throw new Error(
        `the rebuilt preview rendered no text in 60s — last sample: ${seen}\n`
        + `  in-frame errors (${previewErrors.length}): ${previewErrors.slice(0, 6).join(" | ") || "none"}`,
        { cause: err },
      );
    }

    // A studio reply bubble landed (the turn produced a response, not an error).
    const errorBubbles = await page.locator('.chat-bubble-error').count();
    expect(errorBubbles, 'the chat turn should not have errored').toBe(0);
  });

  // (The old preview-decoy skip — `?activeScope=evil` + `cf-container-target-port` against the
  // retired `/dev-container/*` proxy — was DELETED with its subject: the proxy no longer exists,
  // the serve derives scope from the URL path alone, and its spirit is re-homed as
  // test/serve-app.test.ts's containment suite + the routing-contract's server-derived
  // nebula-scope assertions.)
});

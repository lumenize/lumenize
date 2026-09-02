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
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { provisionAndLogin } from '../lib/email-login';
import { HAS_DOCKER, HAS_AI_PATH } from './gates';
import { resolveChromiumExecutable } from './helpers';

/**
 * Chromium executable for the raw-Playwright driver. Returns `undefined` (→ Playwright's
 * default launch) when the version Playwright pins is installed — GHA/local, where
 * `playwright install` provides it. When that pinned build is ABSENT but a pre-installed
 * Chromium exists under `PLAYWRIGHT_BROWSERS_PATH` (the Claude Code web image ships a build
 * that may not match the pinned version), fall back to launching it by path — the image's
 * documented contract is "use executablePath, never `playwright install`". Skips the
 * `chromium_headless_shell-` dirs (reduced binary) in favor of the full browser under a
 * `chromium-` dir (its `chrome-linux/chrome` or `chrome-linux64/chrome`), which drives
 * headless fine.
 */
// (Moved to ./helpers so the delete-scope scenario can share it — two copies of this
// resolution logic would drift.)

/** Dedicated test scope — `test-` prefix is the reaper's auto-reap marker. Must be valid
 *  for BOTH slug validators: dag-ops `SLUG_REGEX` (no leading/trailing hyphen) AND the
 *  stricter nebula-auth `parse-id.isValidSlug` (ALSO no consecutive hyphens), so a single
 *  hyphen — NOT `test--`. Separate from any manually-claimed scope; the working scope is the
 *  GALAXY post-collapse — the Wipe teardown targets its `.dev` star (`{scope}.dev`). */
const TEST_SCOPE = 'test-u0.test-g0';
/** Login lands at the UNIVERSE — login never mints, the claim's membership is AT the
 *  universe, and a galaxy-scoped magic link finds no membership. `/{universe}`
 *  then auto-opens the one workspace (nudgeNextStep), same as the harness scenario. */
const TEST_UNIVERSE = TEST_SCOPE.split('.')[0];
/** Bootstrap admin email = the address CF Email Routing forwards to the email-test Worker. */
const ADMIN_EMAIL = 'test@lumenize.io';

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
    browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
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

  it('Studio shell renders at the vite origin (pre-login)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${viteBaseUrl}/${TEST_SCOPE}`, { waitUntil: 'domcontentloaded' });

      // Capable-of-failing: each waitFor auto-waits and THROWS if the element never appears —
      // reds if the SPA fails to mount (build/bundle break) or the shell doesn't render.
      //
      // ⚠️ The DISCRIMINATING unauthenticated marker is now the "Sign in" button, not a login
      // form: Studio no longer HAS a login form — the auth SPA owns every front door — so the old
      // email-field probe would red for the wrong reason. Its presence still confirms what it
      // always did: auto-connect correctly FAILED with no cookie (the auth-path negative control).
      await page.getByRole('heading', { name: 'Nebula Studio' }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Sign in/ }).waitFor({ state: 'visible' });
      // And the login form is GONE from Studio — reds if a login block is ever reintroduced here.
      expect(await page.getByPlaceholder('you@example.com').count()).toBe(0);
      // The preview iframe is correctly ABSENT pre-login: the stage is the help/intro until you
      // connect AND open a dev workspace (it's `v-else` after help/manage). A `1` here would mean a
      // preview leaked into the unauthenticated shell. (Was `1` before the help/manage/preview stage
      // refactor, when the iframe was always mounted.)
      expect(await page.locator('iframe[title="Preview"]').count()).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('real-email login through the auth SPA → Home → into the app workspace', async () => {
    // 0. PROVISION through the real claim path (API): claims `test-u0` for ADMIN_EMAIL and
    //    creates the workspace galaxy beneath it — global-setup wipes `.wrangler/state`, so
    //    every run claims fresh. Login never mints; this is what creates the membership the
    //    in-UI form's magic link needs, by the same path a real user's first visit does.
    await provisionAndLogin({ baseUrl: workerBaseUrl, scope: TEST_SCOPE, email: ADMIN_EMAIL, testToken });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // 1. The front door is SCOPE-LESS now, and it is not in Studio. Nothing about the address is
    //    known before the click, so the form names no scope and the page is the auth SPA's.
    await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });

    // 2. Arm the email waiter BEFORE driving the form (listen first, then send). ⚠️ The instance
    //    tag is `_scopeless`, not the universe — a scope-less request cannot name a scope, so a
    //    waiter filtered on TEST_UNIVERSE would hang for its full timeout and read as a slow boot.
    const waiter = waitForEmail({ testToken, instance: '_scopeless' });
    let link: string;
    try {
      await page.getByPlaceholder('you@example.com').fill(ADMIN_EMAIL);
      await page.getByRole('button', { name: /Email me a link/ }).click();
      // The confirmation only renders on the 2xx path — reds if the form misfired or the POST 4xx'd.
      await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }

    // 3. Navigate the magic link THROUGH the vite origin (not the worker host) so the Set-Cookie
    //    lands on the Studio origin. `context.request` shares the context's cookie jar, so the
    //    refresh cookies are captured without loading a page. One click, one cookie per membership.
    const u = new URL(link);
    await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);

    // 4. HOME is where the click lands, and where the person chooses. The tree renders with the
    //    galaxy beneath the universe; clicking that row is the hand-off into Studio.
    //    ⚠️ **This identity does NOT fast-forward, and the reason is worth knowing before "fixing"
    //    it.** `fastForwardTarget` skips Home only for a LONE accepted membership, and ADMIN_EMAIL
    //    is the BOOTSTRAP address (`--var NEBULA_AUTH_BOOTSTRAP_EMAIL` in global-setup), so it also
    //    holds the platform membership — two, so Home renders. A one-membership identity lands on
    //    its Universe page instead and enters the galaxy by its SLUG from there, which is the path
    //    `harness/scenarios/signup-to-first-app.ts` drives.
    await page.goto(`${viteBaseUrl}/auth/${TEST_UNIVERSE}/home`, { waitUntil: 'domcontentloaded' });
    const galaxyRow = page.getByRole('button', { name: new RegExp(TEST_SCOPE.replace('.', '\\.')) });
    await galaxyRow.waitFor({ state: 'visible', timeout: 30_000 });
    await galaxyRow.click();

    // 5. Studio, entered from Home. Capable-of-failing: reds if the shell fails to render or the
    //    /gateway connect never completes — and specifically reds if the HAND-OFF HINT is wrong,
    //    because the cookie lives at `/auth/test-u0` while this page is `/test-u0.test-g0` (scope-first),
    //    so without the hint Studio refreshes against a path holding no cookie.
    await page.waitForURL(new RegExp(`//[^/]+/${TEST_SCOPE.replace(/\./g, '\\.')}(?:[/?#]|$)`), { timeout: 30_000 });
    await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });
    // The sign-in control sits in the SAME `v-if="!connected"` slot, so a failed connect leaves it
    // present — count==0 is what makes the assertion above non-vacuous.
    expect(await page.getByRole('button', { name: /^Sign in$/ }).count()).toBe(0);

    // 4b. NOTHING to complete on arrival. The nickname is collected once at the consent modal
    //     (`ConsentModal.vue` / `canAccept`), so Studio has no blocking gate of its own — asserted
    //     here as the absence of an open dialog, which is what would red if one came back.
    await page.getByRole('heading', { name: 'Nebula Studio' }).waitFor({ state: 'visible' });
    expect(await page.locator('dialog.modal[open]').count()).toBe(0);
    expect(await page.locator('iframe[title="Preview"]').count()).toBe(1);

    // Auto-refresh: connect() fired warmPreview(); the Galaxy's handlePreviewReady push (immediate
    // post-collapse — dist serves from its VFS) triggers reloadPreview, bumping the iframe src with
    // a `?t=` cache-buster — with NO manual Reload click. Capable-of-failing: without the
    // warmPreview→onPreviewReady path nothing bumps the src on login, so this times out (the src
    // stays the bare `/app/{scope}.dev/`).
    await page.waitForFunction(
      () => (document.querySelector('iframe[title="Preview"]')?.getAttribute('src') ?? '').includes('?t='),
      undefined,
      { timeout: 180_000, polling: 500 },
    );

    authed = { ctx, page }; // hand off to the prompt step + the wipe teardown
  });

  it('create an app from the manage panel — the flow with zero automated coverage until now', async () => {
    // ⚠️ **This is the create-app flow `backlog.md` § *Nebula* recorded as having NO automated
    // coverage.** It is reachable only by hand through the avatar menu, so nothing exercised it and
    // a break would have surfaced as a user-developer unable to make their second app.
    expect(authed, 'login step must have established a session').not.toBeNull();
    const { page } = authed!;

    // Open the manage panel from the avatar menu, the way a person does.
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Manage my account' }).click();
    await page.getByRole('heading', { name: 'Manage my account' }).waitFor({ state: 'visible' });

    // ⚠️ **Target the row by NAME, never `.first()`.** A bootstrap address holds an UNACCEPTED
    // `nebula-platform` membership that sorts above every real one, so `.first()` picked the platform
    // row and tried to create an app in the platform ROOT — which is how the unaccepted-row
    // affordance bug was found. Both halves are asserted now: the unaccepted row offers no button,
    // and the right row is addressed explicitly.
    //
    // ⚠️ Unconditional, because the row is GUARANTEED here: `global-setup.ts` pins
    // `--var NEBULA_AUTH_BOOTSTRAP_EMAIL:test@lumenize.io`, and every consume by a bootstrap address
    // mints that platform membership UNACCEPTED. Guarding this behind `if (count)` would let it pass
    // silently on a build where the row stopped rendering at all.
    const platformRow = page.locator('.rounded-box').filter({ hasText: 'nebula-platform' }).first();
    await platformRow.getByText('Not accepted').waitFor({ state: 'visible', timeout: 15_000 });
    // Reds against offering superuser actions on a membership nobody consented to.
    expect(await platformRow.getByRole('button', { name: /^App$/ }).count()).toBe(0);
    expect(await platformRow.getByRole('button', { name: /Delete/ }).count()).toBe(0);

    // Opening the right row reveals the name field AND the data-use notice — the notice's SECOND
    // placement, which nothing else asserts renders.
    const universeRow = page.locator('.rounded-box')
      .filter({ has: page.getByText(TEST_UNIVERSE, { exact: true }) }).first();
    await universeRow.getByRole('button', { name: /^App$/ }).click();
    const nameField = page.getByPlaceholder('name your app');
    await nameField.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('data-use-notice').waitFor({ state: 'visible' });

    // A fresh name per run — global-setup wipes state, but a retry inside one run must not 409.
    const appName = `smoke-app-${Date.now().toString(36).slice(-6)}`;
    await nameField.fill(appName);
    await page.getByRole('button', { name: /^Add$/ }).click();

    // ⚠️ The ROW is the assertion, not the absence of an error. `create-galaxy` treats 409 as
    // success elsewhere, and a silently-failed create leaves the panel looking fine — so this reds
    // only if the scope was really created and the tree really re-read.
    //
    // ⚠️ Racing the row against the error bubble turns a bare 30 s timeout into a DIAGNOSIS. A
    // create that fails logs into the chat; without this the failure reads "element never
    // appeared", which is true of both a broken create and a broken render and distinguishes
    // neither.
    const row = page.getByText(`${TEST_UNIVERSE}.${appName}`);
    const errorBubble = page.locator('.chat-bubble-error').last();
    await Promise.race([
      row.waitFor({ state: 'visible', timeout: 30_000 }),
      errorBubble.waitFor({ state: 'visible', timeout: 30_000 }).then(async () => {
        const claims = await page.evaluate(async () => {
          const hints = Object.fromEntries(Object.entries(localStorage)
            .filter(([k]) => k.startsWith('nebula.authScope:')));
          const authScope = Object.values(hints)[0] as string | undefined;
          if (!authScope) return { hints, note: 'no auth hint written' };
          const r = await fetch(`/auth/${authScope}/refresh-token`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ activeScope: location.pathname.split('/')[2] }),
          });
          if (!r.ok) return { hints, refresh: r.status, body: (await r.text()).slice(0, 200) };
          const { access_token } = await r.json() as { access_token: string };
          return { hints, payload: JSON.parse(atob(access_token.split('.')[1])) };
        });
        throw new Error(`create-app reported: ${await errorBubble.innerText()}\nDIAG ${JSON.stringify(claims)}`);
      }),
    ]);
    await row.waitFor({ state: 'visible' });

    // ⚠️ Leave the stage as we found it. The codegen case that follows shares this page and reads
    // the preview iframe, which is `v-else` after the manage panel — so a panel left open makes
    // THAT test fail for a reason that has nothing to do with it. (It did, on the first run.)
    await page.getByRole('button', { name: /Back/ }).click();
    await page.locator('iframe[title="Preview"]').waitFor({ state: 'visible', timeout: 15_000 });
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

  // (The old preview-decoy skip — `?activeScope=evil` + `cf-container-target-port` against the
  // retired `/dev-container/*` proxy — was DELETED with its subject: the proxy no longer exists,
  // the serve derives scope from the URL path alone, and its spirit is re-homed as
  // test/serve-app.test.ts's containment suite + the routing-contract's server-derived
  // nebula-scope assertions.)
});

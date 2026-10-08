/**
 * **Studio frames its dev tab, and the frame and Studio keep to their own sessions and their own
 * origins.**
 *
 * The dev tab is the galaxy's dev Star's own host, framed by the galaxy's Studio and by nothing else.
 * Its client gets its own token from the platform host; it talks to Studio only by `postMessage` at
 * the origin the serving layer injected, and Studio reads only a message from the frame it created.
 *
 * The app in the frame is the scenario's own, standing in for the model the way `build-box` does: it
 * renders the org tree the factory mirrors and leaves its client on `window`, so a limb can read
 * what the tab holds and drive its logout. Nothing else here is constructed.
 *
 * The cast: **O** owns the account. **P** is a plain member of its app, whose dev tab gets its token
 * from the `.dev` membership an app invite co-mints.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Studio's own frame of the dev tab loads, and nothing else may frame Home or Studio.** On a
 *     page of the dev Star's host, holding a token and staying put, two iframes standing in for
 *     generated code — Home and Studio — both show Chromium's error frame. *Reds if vite's
 *     `frame-ancestors` stamp is dropped: the Home frame renders.*
 *  2. **A change Studio makes to the dev Star reaches the dev tab as a push, with no reload.** A node
 *     created in the dev Star from the galaxy's page appears in the frame, whose window keeps a mark
 *     set before the change. *Reds if the tab's host node refuses the push into the tab.*
 *  3. **Studio reads a message only from the frame it created, at the origin it framed**, each check
 *     on its own: a second frame of the dev tab inside Studio posts from the right origin and the
 *     wrong window, and Studio's own frame, navigated to a `data:` page, posts from the right window
 *     and the wrong origin. Neither shows a notice; limb 4's notice is the positive control. *Reds if
 *     Studio drops the source check, or the origin check.*
 *  4. **A sign-out inside the dev tab leaves Studio's session alive.** The frame's `logout()` posts
 *     its teardown to Studio, which says so; the top window's URL is unchanged and its composer is
 *     still there. *Reds if the framed logout navigates the top window.*
 *  5. **A frame that cannot get a token posts once and leaves the tab where it is.** With P's `.dev`
 *     membership gone, P's Studio frames a dev tab whose refresh is refused; Studio receives one
 *     login-required message and stays on its own URL. *Reds if the frame navigates the tab — Studio
 *     would be replaced by a login page carrying the frame's own `return_to`.*
 *
 * `needsContainer = true` — the dev tab is a built app.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { BrowserContext, Frame, Page } from 'playwright';
import type { BuildReport } from '../../src/build-report';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite } from '../lib/browser';
import { provisionAndLogin, refreshAccessToken, requestMagicLink } from '../../test/lib/email-login';

export const needsContainer = true;

const COMPOSER = 'Describe a change…';
const BUILD_CALL_TIMEOUT_MS = 240_000;

/** The dev tab's app: the factory's mirrored org tree, and its client left where a limb can reach it. */
const APP_VUE = `<script setup lang="ts">
import { computed } from 'vue';
import { client, store } from './nebula';
(window as unknown as Record<string, unknown>).__devTabClient = client;
// The tree is Maps and Sets, which JSON drops, so the tab renders its nodes' slugs.
const tree = computed(() => {
  const state = (store as unknown as { lmz: { orgTree: { value?: { nodes?: Map<string, { slug?: string }> } } } }).lmz.orgTree.value;
  return state?.nodes ? \`slugs: \${[...state.nodes.values()].map((n) => n.slug ?? '?').join(',')}\` : 'no tree';
});
</script>

<template>
  <main class="p-4"><p data-testid="dev-tab-tree">{{ tree }}</p></main>
</template>
`;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('devtab');
  const galaxy = `${universe}.crm`;
  const devStar = `${galaxy}.dev`;
  const ownerEmail = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  const studio = vite.scopeUrl(galaxy);
  const devTab = vite.scopeUrl(devStar);
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
    /** Studio's frame of the dev tab, once it has rendered the app. */
    const devTabFrame = async (page: Page): Promise<Frame> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const frame = page.frames().find((f) => f.url().startsWith(devTab));
        if (frame && await frame.locator('[data-testid="dev-tab-tree"]').count() > 0) return frame;
        assert.ok(Date.now() < deadline, `Studio never framed the dev tab (frames: ${page.frames().map((f) => f.url()).join(', ')})`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    /** A browser counting the login-required messages its top window receives, from first load. */
    const countingContext = async (): Promise<BrowserContext> => {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener('message', (e) => {
          if ((e.data as { type?: string } | null)?.type === 'lumenize:login-required') {
            const w = window as unknown as { __loginRequired?: number };
            w.__loginRequired = (w.__loginRequired ?? 0) + 1;
          }
        });
      });
      return context;
    };

    // ── The fixture: O's app, built from the scenario's own source ─────────────────────────────
    const owner = await provisionAndLogin({ baseUrl: origin, scope: galaxy, email: ownerEmail, testToken });
    const driver = await connectDriver(stack, { scope: galaxy, session: { accessToken: owner.accessToken, sub: owner.sub } });
    try {
      await driver.client.lmz.callAsync('GALAXY', galaxy, driver.client.ctn<Galaxy>().writeSource('src/App.vue', APP_VUE));
      const report = await driver.client.lmz.callAsync('GALAXY', galaxy, driver.client.ctn<Galaxy>().buildNow(),
        { timeoutMs: BUILD_CALL_TIMEOUT_MS }) as BuildReport;
      assert.ok(report.bundle.ran && report.bundle.ok === true, `the dev tab's app must build: ${JSON.stringify(report.bundle).slice(0, 400)}`);

      const context = await countingContext();
      const page = await context.newPage();
      await page.goto(await letterTo(ownerEmail, () => requestMagicLink({ baseUrl: origin, email: ownerEmail })), { waitUntil: 'domcontentloaded' });
      await page.getByTestId('link-continue').click();
      await page.waitForURL((u) => u.origin !== origin, { timeout: 30_000 });
      await page.goto(`${studio}/`, { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
      let frame = await devTabFrame(page);

      // ── LIMB 1: Studio's own frame loads; nothing else may frame Home or Studio ──────────────
      const host = await context.newPage();
      await host.goto(`${devTab}/`, { waitUntil: 'domcontentloaded' });
      await host.getByTestId('dev-tab-tree').waitFor({ state: 'visible', timeout: 30_000 });
      // Each iframe is named, so each verdict reads its own frame and never the other's error page.
      await host.evaluate((frames) => {
        for (const [name, src] of frames) {
          const f = document.createElement('iframe'); f.name = name; f.src = src; document.body.appendChild(f);
        }
      }, [['home', `${origin}/`], ['studio', `${studio}/`]]);
      const blocked = async (name: string, src: string) => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const f = host.frame({ name });
          if (f && f.url() === 'chrome-error://chromewebdata/') return true;
          if (f && f.url().startsWith(src) && await f.locator('body *').count() > 0) return false;
          if (Date.now() > deadline) throw new Error(`the ${name} frame neither loaded nor showed an error (${f?.url() ?? 'no frame'})`);
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      assert.equal(await blocked('home', `${origin}/`), true, "a page on the dev Star's host must not be able to frame Home");
      assert.equal(await blocked('studio', `${studio}/`), true, "a page on the dev Star's host must not be able to frame Studio");
      assert.ok(await frame.locator('[data-testid="dev-tab-tree"]').count() > 0, "Studio's own frame of the dev tab must load — the positive control");
      await host.close();
      console.error("  ✓ limb 1 — Studio's dev tab loaded; the dev Star's page could frame neither Home nor Studio");

      // ── LIMB 2: a change Studio makes to the dev Star reaches the dev tab as a push ──────────
      // The tab holds its tree before the change — the positive control for the push.
      await frame.locator('[data-testid="dev-tab-tree"]', { hasText: 'slugs:' }).waitFor({ state: 'visible', timeout: 30_000 });
      await frame.evaluate(() => { (window as unknown as { __mark?: string }).__mark = 'kept'; });
      await driver.client.lmz.callAsync('STAR', devStar,
        driver.client.ctn<Star>().resources.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'pushed', 'Pushed'));
      try {
        await frame.locator('[data-testid="dev-tab-tree"]', { hasText: 'pushed' }).waitFor({ state: 'visible', timeout: 30_000 });
      } catch (e) {
        throw new Error(`the node never reached the dev tab, which holds: ${(await frame.locator('[data-testid="dev-tab-tree"]').innerText()).slice(0, 400)}`, { cause: e });
      }
      assert.equal(await frame.evaluate(() => (window as unknown as { __mark?: string }).__mark), 'kept',
        'the dev tab must take the change as a push, never a reload');
      console.error('  ✓ limb 2 — the node created from the galaxy reached the dev tab as a push, no reload');

      // ── LIMB 3: Studio reads a message only from its frame, at the origin it framed ──────────
      // The right origin from the wrong window: a second frame of the dev tab, inside Studio.
      await page.evaluate((src) => {
        const f = document.createElement('iframe'); f.name = 'intruder'; f.src = src; document.body.appendChild(f);
      }, `${devTab}/`);
      const intruderDeadline = Date.now() + 30_000;
      for (;;) {
        const intruder = page.frame({ name: 'intruder' });
        if (intruder && await intruder.locator('[data-testid="dev-tab-tree"]').count() > 0) {
          await intruder.evaluate(() => parent.postMessage({ type: 'lumenize:login-required' }, '*'));
          break;
        }
        assert.ok(Date.now() < intruderDeadline, 'the second dev-tab frame never loaded');
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 1_000));
      assert.equal(await page.getByTestId('preview-notice').count(), 0,
        "Studio must ignore a message from another window, even at its frame's origin");
      await page.evaluate(() => document.querySelector('iframe[name="intruder"]')?.remove());
      // The right window at the wrong origin: Studio's own frame, navigated to a `data:` page, whose
      // origin is `null`.
      await frame.evaluate(() => {
        location.href = 'data:text/html,<script>parent.postMessage({type:%22lumenize:login-required%22},%22*%22)</script>';
      }).catch(() => { /* the navigation ends the evaluation's context */ });
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(await page.getByTestId('preview-notice').count(), 0,
        'Studio must ignore its own frame once it shows another origin');
      // The limbs after this one need the dev tab back.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 60_000 });
      frame = await devTabFrame(page);
      console.error("  ✓ limb 3 — Studio ignored its frame's origin from another window, and its own frame at another origin");

      // ── LIMB 4: a sign-out inside the dev tab leaves Studio's session alive ──────────────────
      const before = page.url();
      await frame.evaluate(() => (window as unknown as { __devTabClient: { logout(): Promise<void> } }).__devTabClient.logout());
      await page.getByTestId('preview-notice').filter({ hasText: 'You logged out inside the preview' })
        .waitFor({ state: 'visible', timeout: 20_000 });
      assert.equal(page.url(), before, "a logout inside the dev tab must not move Studio's window");
      await page.getByPlaceholder(COMPOSER).waitFor({ state: 'visible', timeout: 10_000 });
      await context.close();
      console.error("  ✓ limb 4 — the dev tab's logout told Studio, which stayed put and signed in");

      // ── LIMB 5: a frame that cannot get a token posts once and leaves the tab where it is ────
      const p = uniqueTestEmail();
      const atGalaxy = await refreshAccessToken(origin, owner.session, galaxy);
      const pContext = await countingContext();
      const pPage = await pContext.newPage();
      await pPage.goto(await letterTo(p, () => inviteViaMesh(stack, atGalaxy, galaxy, [{ email: p }], undefined, { scopeUrl: vite.scopeUrl, platformOrigin: origin })), { waitUntil: 'domcontentloaded' });
      await pPage.getByTestId('consent-checkbox').check();
      await pPage.getByTestId('consent-nickname').fill('Pat');
      await pPage.getByTestId('consent-accept').click();
      await pPage.waitForURL((u) => u.origin === studio, { timeout: 30_000 });
      await devTabFrame(pPage); // positive control: the co-minted .dev membership gives P's tab a token
      await driver.client.scopes.delete(devStar);
      // The deletion revokes P's `.dev` session, which a page served from a colo other than the
      // Registry's can still refresh for up to about 60 s (`security.md` § *Refresh tokens*), so the
      // tab reloads until the frame has no token, within that window. The assertions below read the
      // load that showed the notice.
      const noSession = pPage.getByTestId('preview-notice').filter({ hasText: 'no session for its workspace' });
      for (const deadline = Date.now() + 75_000; ;) {
        await pPage.goto(`${studio}/`, { waitUntil: 'domcontentloaded' });
        try {
          await noSession.waitFor({ state: 'visible', timeout: 15_000 });
          break;
        } catch (e) {
          if (Date.now() > deadline) throw e;
        }
      }
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(new URL(pPage.url()).origin, studio, "a frame with no token must leave Studio's window where it is");
      assert.equal(await pPage.evaluate(() => (window as unknown as { __loginRequired?: number }).__loginRequired), 1,
        'the frame must post login-required exactly once');
      await pContext.close();
      console.error('  ✓ limb 5 — the tokenless dev tab posted once, and Studio stayed on its own URL');
    } finally {
      driver.dispose();
    }
  } finally {
    await vite.close();
    await browser.close();
  }
}

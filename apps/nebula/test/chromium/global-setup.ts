/**
 * Vitest globalSetup for the real-chromium `chromium` project — boots the stack, and signs the
 * test page's browser in as the admin of the Star its host names.
 *
 * Under the host model a page acts only at its own host's scope, and its session lives on the
 * platform host (ADR-022). So the lane runs as production does:
 *
 *   1. `wrangler dev` on the browser test-app worker (`StarTest`, the real-email
 *      `TestNebulaEmailSender`), on plain http — Chromium treats `*.localhost` as a secure context,
 *      so the `Secure` `__Host-` cookies land — with its own persist dir so it never contends with
 *      the Node-side `browser` project's.
 *   2. Studio's vite in front of it (`bootStudioVite`), which serves the link page and proxies the
 *      Worker's paths, exactly as the `/live` harness does.
 *   3. The tree above the page's Star: its owner claims `acme` with `crm` as the first app, in Node.
 *   4. The Star's own admin claims {@link PAGE_STAR} through vite's port, so the emailed link opens
 *      the page vite serves. The link is followed by a real navigation in Chromium and accepted on
 *      the consent card, which sets the `__Host-refresh-token.acme.crm.tenant-a` cookie on the
 *      platform host.
 *   5. That browser's cookies are written to {@link STORAGE_STATE}, which the project's provider
 *      starts every test's context from — so each test's page is that same signed-in browser.
 *
 * Tests read where to reach the Worker through `inject('pageBaseUrl')` (this page's Star host on
 * vite's port, for the socket) and `inject('platformOrigin')` (the platform host there, for the
 * refresh). The address is fresh per run, so no other lane's mail can answer its waiter.
 *
 * No AUTH_TEST_MODE: ADR-009 rung 1 throughout, the same real magic-link flow as the
 * Node-side harness. `audit-test-mode.sh` does not scan `.ts`, so keeping this spawn test-mode-free
 * is a discipline here, not an enforced gate.
 */

import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { hostOrigin } from '@lumenize/nebula-auth/claims';
import { bootStudioVite, launchChromium } from '../../harness/lib/browser';
import { provisionAndLogin, requestStarClaim } from '../lib/email-login';
import { PAGE_STAR } from './page-star';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with `npm run dev`.
import { LOCAL_ORIGIN } from '../../scripts/local-config.mjs';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';

// Under a `.wrangler/` dir, so the existing `.gitignore` rule covers it — never committed.
const PERSIST_DIR = './test/chromium/.wrangler';

/** The signed-in browser's cookies, which `vitest.config.js` hands the provider as `storageState`. */
export const STORAGE_STATE = `${PERSIST_DIR}/storage-state.json`;

let teardown: (() => Promise<void>) | null = null;

/** The email-test deployment's TEST_TOKEN, from the root `.dev.vars` the package symlinks. */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const match = readFileSync(path, 'utf8').match(/^TEST_TOKEN=(.*)$/m);
  if (!match) throw new Error(`TEST_TOKEN not found in ${path}. Required for the chromium harness's real-email flow.`);
  return match[1].trim();
}

export default async function setup(project: TestProject) {
  const testToken = readTestToken();

  // wrangler-dev state survives across runs; start each run clean.
  rmSync(resolvePath(process.cwd(), PERSIST_DIR), { recursive: true, force: true });

  const { baseUrl: wranglerUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    extraArgs: [
      '--persist-to', `${PERSIST_DIR}/state`,
      // The config names the Node-side lane's https origin; this lane's Worker serves plain http.
      '--var', `LUMENIZE_ORIGIN:${LOCAL_ORIGIN}`,
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      '--var', 'DEBUG:auth,nebula-auth,nebula',
      '--log-level', 'info',
    ],
  });
  const vite = await bootStudioVite(wranglerUrl);
  teardown = async () => {
    await vite.close();
    await cleanup();
  };

  try {
    await signInAtPageStar(wranglerUrl, vite, testToken);
  } catch (err) {
    await teardown();
    throw err;
  }

  project.provide('pageBaseUrl', vite.scopeUrl(PAGE_STAR));
  project.provide('platformOrigin', vite.viteBaseUrl);
  project.provide('emailTestToken', testToken);

  return async () => {
    await teardown?.();
    teardown = null;
  };
}

/** Steps 3–5: the owner's climb, then the Star admin's claim followed and accepted in Chromium. */
async function signInAtPageStar(
  wranglerUrl: string, vite: Awaited<ReturnType<typeof bootStudioVite>>, testToken: string,
): Promise<void> {
  const [universe, galaxy] = PAGE_STAR.split('.');
  const email = uniqueTestEmail();

  // 3. The owner's climb, consumed in Node: this browser never holds the owner's cookie, so the
  //    page's refresh picks the Star admin's membership rather than a broader one above it.
  await provisionAndLogin({
    baseUrl: hostOrigin({ kind: 'platform' }, LOCAL_ORIGIN, wranglerUrl),
    scope: `${universe}.${galaxy}`,
    email: `owner-${email}`,
    testToken,
    fetchImpl: fetch,
  });

  // 4. The Star's own admin, through vite's port, followed and accepted in Chromium.
  const waiter = waitForEmail({ testToken, to: email, timeout: 60_000 });
  let link: string;
  try {
    await requestStarClaim({ baseUrl: vite.viteBaseUrl, universeGalaxyStarId: PAGE_STAR, email });
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }
  const browser = await launchChromium();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    // Visible first, as the `/live` scenarios wait: a cold vite's first load can still be settling.
    await page.getByTestId('consent-checkbox').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('consent-nickname').fill('Chromium');
    const consumed = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/magic-link' && r.request().method() === 'POST');
    await page.getByTestId('consent-accept').click();
    const answer = await consumed;
    if (!answer.ok()) throw new Error(`the link page's Accept answered ${answer.status()}: ${await answer.text()}`);
    const cookie = `__Host-refresh-token.${PAGE_STAR}`;
    if (!(await context.cookies(vite.viteBaseUrl)).some((c) => c.name === cookie)) {
      throw new Error(`the link page's Accept set no ${cookie} cookie on the platform host`);
    }
    // 5. Hand this browser's cookies to every test's context.
    mkdirSync(dirname(resolvePath(process.cwd(), STORAGE_STATE)), { recursive: true });
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    pageBaseUrl: string;
    platformOrigin: string;
    emailTestToken: string;
  }
}

/**
 * Live self-verification harness — browser driver (Phase 2, exploratory).
 *
 * Lifts the ui-smoke lane's raw-Playwright + vite pieces (`test/ui-smoke/*`) into a reusable,
 * scenario-agnostic form and adds the INSPECT primitives the API driver can't give — the "UX via
 * the browser" half: screenshot, a11y snapshot, console errors, failed network. So a UI/behavior
 * change can be eyeballed against a *running* Studio, not just asserted at the data plane.
 *
 * Runs in plain Node (tsx). Needs the same non-`--local` `wrangler dev` boot as the API driver
 * (`bootDevStack`) PLUS a vite dev server rendering the real Studio SPA.
 *
 * @see tasks/archive/claude-live-verification.md — Phase 2
 */
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { hostOrigin } from '@lumenize/mesh/client';
import { claimedUniverses } from '../../test/lib/email-login';
import { NEW_HOST_TIMEOUT_MS } from './wait-for-host';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with `npm run dev`.
import { LOCAL_ORIGIN } from '../../scripts/local-config.mjs';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with deploy-test.sh.
import { TEST_ORIGIN } from '../../scripts/test-deploy-config.mjs';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
const NEBULA_DIR = dirname(HARNESS_DIR); // apps/nebula
const STUDIO_UI_DIR = resolve(NEBULA_DIR, '../nebula-studio-ui');
/** Where capture artifacts land (gitignored). */
export const ARTIFACTS_DIR = resolve(HARNESS_DIR, '.artifacts');

/**
 * Chromium executable for the raw-Playwright driver. `undefined` → Playwright's default launch
 * (the pinned build, present after `playwright install`). Falls back to a pre-installed Chromium
 * under `PLAYWRIGHT_BROWSERS_PATH` when the pinned build is absent (the hosted image ships one that
 * may not match). Lifted verbatim from `test/ui-smoke/smoke.test.ts`.
 */
function resolveChromiumExecutable(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const candidate = resolve(root, dir, sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Launch a headless chromium (default headless; `HARNESS_HEADED=1` to watch). */
export function launchChromium(): Promise<Browser> {
  return chromium.launch({
    executablePath: resolveChromiumExecutable(),
    headless: process.env.HARNESS_HEADED !== '1',
    // Every host of a local stack is a `*.lumenize.localhost` name on loopback. Chromium resolves
    // `*.localhost` there itself; the rule makes that explicit, so no resolver is ever asked.
    args: ['--host-resolver-rules=MAP *.lumenize.localhost 127.0.0.1, MAP lumenize.localhost 127.0.0.1'],
  });
}

/**
 * Boot a vite dev server rendering the real Studio SPA and the auth app, proxying the Worker's
 * paths (and every request on a Star's host) to the booted worker. `NEBULA_WORKER_URL` is read by
 * the Studio's `vite.config.ts` at config load, so it MUST be set before `createViteServer`. Lifted
 * from `test/ui-smoke/global-setup.ts`.
 *
 * `workerBaseUrl` is any URL on the worker's port. The answer's `viteBaseUrl` is the PLATFORM host
 * on vite's port — where login, Home and a link's page live — and `scopeUrl` spells a scope's host
 * on the same port.
 */
export async function bootStudioVite(workerBaseUrl: string): Promise<{
  viteBaseUrl: string; scopeUrl: (scope: string) => string; close: () => Promise<void>;
}> {
  // A deployed target serves Studio and the auth screens itself, on its own hosts, so there is
  // nothing to boot: the hosts it answers are the deployment's.
  const target = process.env.HARNESS_TARGET_URL;
  if (target) {
    return {
      viteBaseUrl: hostOrigin({ kind: 'platform' }, TEST_ORIGIN, target),
      scopeUrl: (scope) => hostOrigin({ kind: 'scope', scope }, TEST_ORIGIN, target),
      close: async () => {},
    };
  }
  // wrangler's `assets` block hard-errors without a dir; an empty one satisfies it (we serve via vite).
  mkdirSync(resolve(STUDIO_UI_DIR, 'dist'), { recursive: true });
  // The proxy target is the worker's port on loopback; the browser's own `Host` rides through.
  // ⚠️ 127.0.0.1, never `localhost`, here and for vite's own socket below: on Linux Node resolves
  // `localhost` to `::1` first, so a server bound to it listens on IPv6 alone, while
  // `launchChromium` maps every `*.lumenize.localhost` host to 127.0.0.1. Measured in
  // `node:24-slim` on 2026-10-03, where it refused every ui-smoke page; macOS lists 127.0.0.1 first
  // and cannot show it.
  const worker = new URL(workerBaseUrl);
  process.env.NEBULA_WORKER_URL = `${worker.protocol}//127.0.0.1:${worker.port}`;
  process.env.LUMENIZE_ORIGIN = LOCAL_ORIGIN;
  const vite: ViteDevServer = await createViteServer({
    root: STUDIO_UI_DIR,
    // The config imports the shared host parse from a TypeScript workspace package, which the
    // default bundling loader hands to Node unresolved; the runner loader transforms it.
    configLoader: 'runner',
    configFile: resolve(STUDIO_UI_DIR, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 5174, strictPort: false },
    logLevel: 'warn',
  });
  await vite.listen();
  const raw = (vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5174/').replace(/\/$/, '');
  return {
    viteBaseUrl: hostOrigin({ kind: 'platform' }, LOCAL_ORIGIN, raw),
    scopeUrl: (scope) => hostOrigin({ kind: 'scope', scope }, LOCAL_ORIGIN, raw),
    close: () => vite.close(),
  };
}

/** A page with live console/network capture attached. */
export interface InstrumentedPage {
  page: Page;
  /** Console `error` messages + uncaught page errors, in arrival order. */
  consoleErrors: string[];
  /** Requests that failed outright or returned a 4xx/5xx. `errorText` carries Chromium's reason
   *  for the outright failures — without it a `failed` entry is undiagnosable, and several are
   *  benign (`net::ERR_ABORTED` is what a keep-alive socket teardown looks like). */
  failedRequests: Array<{ url: string; status: number | 'failed'; method: string; errorText?: string }>;
}

/**
 * Attach console/network capture to a fresh page. MUST be called before navigation — listeners only
 * see events after they're registered. Returns the page + the (mutating) capture arrays.
 */
export async function instrumentedPage(browser: Browser): Promise<InstrumentedPage> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: InstrumentedPage['failedRequests'] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  // `/cdn-cgi/` is Cloudflare's own path on a proxied zone, such as the Web Analytics beacon it
  // injects into pages on `lumenize-test.dev`; what happens to those requests says nothing about ours.
  const ours = (url: string) => !new URL(url).pathname.startsWith('/cdn-cgi/');
  page.on('requestfailed', (req) => {
    if (!ours(req.url())) return;
    failedRequests.push({
      url: req.url(), status: 'failed', method: req.method(),
      errorText: req.failure()?.errorText ?? '(no reason reported)',
    });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && ours(res.url())) {
      failedRequests.push({ url: res.url(), status: res.status(), method: res.request().method() });
    }
  });

  return { page, consoleErrors, failedRequests };
}

/** What {@link captureArtifacts} produced — paths + the inspection summary. */
export interface CaptureResult {
  label: string;
  dir: string;
  screenshotPath: string;
  a11yPath: string;
  consoleErrors: string[];
  failedRequests: InstrumentedPage['failedRequests'];
}

/**
 * Capture the current UI state for inspection: a full-page screenshot, the accessibility-tree
 * snapshot (JSON), and the console/network captures accumulated so far. Writes them under
 * `.artifacts/<label>/` and returns the paths + summary. This is Phase 2's deliverable — it
 * succeeds regardless of what the page renders (the harness bar, not a feature bar).
 */
export async function captureArtifacts(inst: InstrumentedPage, label: string): Promise<CaptureResult> {
  const dir = resolve(ARTIFACTS_DIR, label);
  mkdirSync(dir, { recursive: true });
  const screenshotPath = resolve(dir, 'screenshot.png');
  const a11yPath = resolve(dir, 'a11y.yaml');

  await inst.page.screenshot({ path: screenshotPath, fullPage: true });
  // `page.accessibility.snapshot()` was removed in Playwright 1.49+; the ARIA snapshot
  // (`Locator.ariaSnapshot()`) is the current a11y-tree capture — a YAML-ish role/name tree.
  const a11y = await inst.page.locator('body').ariaSnapshot();
  writeFileSync(a11yPath, a11y);
  writeFileSync(resolve(dir, 'console-errors.json'), JSON.stringify(inst.consoleErrors, null, 2));
  writeFileSync(resolve(dir, 'failed-requests.json'), JSON.stringify(inst.failedRequests, null, 2));

  return {
    label,
    dir,
    screenshotPath,
    a11yPath,
    consoleErrors: inst.consoleErrors,
    failedRequests: inst.failedRequests,
  };
}

/**
 * Sign a NEW account up through the rendered auth screens, exactly as a person does: the login
 * form's create-account affordance naming the account and its first app, the letter that really
 * arrives, the link followed AS SENT, consent with a nickname on the link's own page. Ends in the
 * first app's Studio, where the claim's link returns. Performs only steps production performs — a
 * helper here MUST NOT bridge a difference between this stack and production (`live.md`).
 */
export async function signUpInBrowser(
  inst: InstrumentedPage,
  viteBaseUrl: string,
  opts: { universe: string; appSlug: string; email: string; nickname: string; testToken: string },
): Promise<void> {
  const { page } = inst;
  await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Create a new account/ }).click();
  await page.getByPlaceholder('you@example.com').fill(opts.email);
  await page.getByPlaceholder('acme').fill(opts.universe);
  await page.getByPlaceholder('crm').fill(opts.appSlug);
  // Armed BEFORE the click, filtered by the unique recipient only (`live.md`).
  const waiter = waitForEmail({ testToken: opts.testToken, to: opts.email, timeout: 120_000 });
  let link: string;
  try {
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
    claimedUniverses.push({ universe: opts.universe, email: opts.email }); // the harness deletes it
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }
  if (!link.startsWith(viteBaseUrl)) throw new Error(`emailed link names ${new URL(link).origin}, page is ${viteBaseUrl}`);
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('consent-checkbox').check();
  await page.getByTestId('consent-nickname').fill(opts.nickname);
  await page.getByTestId('consent-accept').click();
  // A deployed app's host answers once its certificate is issued, which the page waits out with a
  // count-up. A local host answers at once.
  const deployed = process.env.HARNESS_TARGET_URL !== undefined;
  const app = new URL(hostOrigin({ kind: 'scope', scope: `${opts.universe}.${opts.appSlug}` }, deployed ? TEST_ORIGIN : LOCAL_ORIGIN, viteBaseUrl)).hostname;
  await page.waitForURL((u) => u.hostname === app, { timeout: NEW_HOST_TIMEOUT_MS });
}

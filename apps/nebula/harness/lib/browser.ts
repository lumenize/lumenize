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
 * @see tasks/claude-live-verification.md — Phase 2
 */
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

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
  });
}

/**
 * Boot a vite dev server rendering the real Studio SPA, proxying `/auth /gateway /dev-container`
 * to the booted worker. `NEBULA_WORKER_URL` is read by the Studio's `vite.config.ts` at config
 * load, so it MUST be set before `createViteServer`. Lifted from `test/ui-smoke/global-setup.ts`.
 */
export async function bootStudioVite(workerBaseUrl: string): Promise<{ viteBaseUrl: string; close: () => Promise<void> }> {
  // wrangler's `assets` block hard-errors without a dir; an empty one satisfies it (we serve via vite).
  mkdirSync(resolve(STUDIO_UI_DIR, 'dist'), { recursive: true });
  process.env.NEBULA_WORKER_URL = workerBaseUrl;
  const vite: ViteDevServer = await createViteServer({
    root: STUDIO_UI_DIR,
    configFile: resolve(STUDIO_UI_DIR, 'vite.config.ts'),
    server: { port: 5174, strictPort: false },
    logLevel: 'warn',
  });
  await vite.listen();
  const viteBaseUrl = (vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5174/').replace(/\/$/, '');
  return { viteBaseUrl, close: () => vite.close() };
}

/** A page with live console/network capture attached. */
export interface InstrumentedPage {
  page: Page;
  /** Console `error` messages + uncaught page errors, in arrival order. */
  consoleErrors: string[];
  /** Requests that failed outright or returned a 4xx/5xx. */
  failedRequests: Array<{ url: string; status: number | 'failed'; method: string }>;
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
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), status: 'failed', method: req.method() });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
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

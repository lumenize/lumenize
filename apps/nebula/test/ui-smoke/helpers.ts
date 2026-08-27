/**
 * Shared drivers for the ui-smoke lane (raw Playwright against the model-A dev stack).
 *
 * Extracted so a second scenario file doesn't duplicate the Chromium-resolution logic or the
 * real-email login loop. Both are load-bearing and subtle enough that two copies would drift.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';

/**
 * Chromium executable for the raw-Playwright driver. Returns `undefined` (→ Playwright's default
 * launch) when the version Playwright pins is installed — GHA/local, where `playwright install`
 * provides it. When that pinned build is ABSENT but a pre-installed Chromium exists under
 * `PLAYWRIGHT_BROWSERS_PATH` (the Claude Code web image ships a build that may not match the pinned
 * version), fall back to launching it by path — the image's documented contract is "use
 * executablePath, never `playwright install`". Skips the `chromium_headless_shell-` dirs (reduced
 * binary) in favor of the full browser under a `chromium-` dir.
 */
export function resolveChromiumExecutable(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined; // pinned build present
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined; // let launch() produce its own error
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const candidate = resolvePath(root, dir, sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Drive the REAL email magic-link login through the rendered Studio form (never test-mode, per
 * ADR-009), leaving the context authenticated at `scope`.
 *
 * The magic link is navigated THROUGH the vite origin so the `Secure; SameSite=Strict;
 * Path=/auth/{scope}` refresh cookie lands natively in the BrowserContext.
 */
export async function loginToStudio(opts: {
  browser: Browser;
  viteBaseUrl: string;
  testToken: string;
  scope: string;
  email: string;
}): Promise<{ ctx: BrowserContext; page: Page }> {
  const { browser, viteBaseUrl, testToken, scope, email } = opts;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${viteBaseUrl}/studio/${scope}`, { waitUntil: 'domcontentloaded' });

  // Arm the email waiter BEFORE driving the form (listen first, then send).
  const waiter = waitForEmail({ testToken, instance: scope });
  let link: string;
  try {
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByRole('button', { name: /Send magic link/ }).click();
    await page.getByText(/Magic link sent to/).waitFor({ state: 'visible', timeout: 30_000 });
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }

  // `context.request` shares the context's cookie jar, so the refresh cookie is captured
  // without loading a page.
  const u = new URL(link);
  await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);

  // Reload → onMounted auto-connect uses the cookie.
  await page.goto(`${viteBaseUrl}/studio/${scope}`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });

  return { ctx, page };
}

/** Open the account menu → "Manage my scopes" and wait for the hierarchy manager to render. */
export async function openScopeManager(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Account/ }).click();
  await page.getByRole('button', { name: 'Manage my scopes' }).click();
  await page.getByRole('heading', { name: 'Manage my scopes' }).waitFor({ state: 'visible' });
}

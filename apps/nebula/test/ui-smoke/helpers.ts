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

  // The front door is the auth SPA, and it is SCOPE-LESS: nothing about the address is known before
  // the click, so the form names no scope and the email is tagged `_scopeless`.
  await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });

  // Arm the email waiter BEFORE driving the form (listen first, then send).
  const waiter = waitForEmail({ testToken, instance: '_scopeless' });
  let link: string;
  try {
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByRole('button', { name: /Email me a link/ }).click();
    await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }

  // `context.request` shares the context's cookie jar, so every refresh cookie the click sets is
  // captured without loading a page — one per membership, under mint-all.
  const u = new URL(link);
  await ctx.request.get(`${viteBaseUrl}${u.pathname}${u.search}`);

  // ⚠️ **Enter through HOME, which is what makes a below-the-membership scope reachable at all.**
  // The cookie sits at `/auth/{universe}` and never travels to `/auth/{universe}.{galaxy}/…` (the
  // first uncovered character is `.`, not `/`, so RFC 6265 path-matching refuses it). Studio learns
  // which cookie to spend from the hand-off hint Home writes before navigating — which is precisely
  // the capability this lane used to be blocked on.
  const universe = scope.split('.')[0];
  // ⚠️ **Home renders a tree here rather than fast-forwarding**, because this lane's admin is the
  // BOOTSTRAP address and therefore holds the platform membership as well — `fastForwardTarget`
  // skips Home only for a LONE accepted membership. An ordinary one-membership identity lands on
  // its Universe page and enters the galaxy by SLUG from there instead.
  await page.goto(`${viteBaseUrl}/auth/${universe}/home`, { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('button', { name: new RegExp(scope.replace(/\./g, '\\.')) });
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();

  await page.waitForURL(new RegExp(`//[^/]+/${scope.replace(/\./g, "\\.")}(?:[/?#]|$)`), { timeout: 30_000 });
  await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });

  // ⚠️ **No blocking profile modal to clear any more** — the nickname is taken once at the consent
  // modal, so Studio opens ready to use. The hazard this used to guard against is worth remembering
  // if a gate is ever reintroduced here: a modal does not make what it covers *invisible*, it makes
  // it unclickable, and Playwright then reports "waiting for element to be visible, enabled and
  // stable" against a control that is plainly there — which reads as a broken menu, not an overlay.

  return { ctx, page };
}

/** Open the account menu → "Manage my account" and wait for the hierarchy manager to render. */
export async function openScopeManager(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Manage my account' });
  // ⚠️ Idempotent: these tests share one page, so the panel may already be open from an earlier one.
  // Clicking the avatar again would then wait on a control the open panel is covering — a 30s
  // "visible, enabled and stable" timeout that reads as a broken menu rather than as state carried in.
  if (await heading.isVisible().catch(() => false)) return;
  // The avatar button is titled "Account"; scope by title so it cannot also match the menu's
  // "Manage my account" item or the login screen's "Create account".
  await page.locator('button[title="Account"]').click();
  await page.getByRole('button', { name: 'Manage my account' }).click();
  await heading.waitFor({ state: 'visible' });
}

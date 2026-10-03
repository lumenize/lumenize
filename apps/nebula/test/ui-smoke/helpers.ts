/**
 * Shared drivers for the ui-smoke lane (raw Playwright against the model-A dev stack).
 *
 * Extracted so a second scenario file doesn't duplicate the real-email login loop, which is
 * load-bearing and subtle enough that two copies would drift. A browser comes from the `/live`
 * harness's `launchChromium`, which also maps every `*.lumenize.localhost` host to loopback.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { scopeOriginFrom } from '../lib/email-login';

export { launchChromium } from '../../harness/lib/browser';

/**
 * Drive the REAL email magic-link login through the rendered auth app (never test-mode, per
 * ADR-009) and walk into Studio for `scope`, a galaxy whose universe `email` already administers.
 *
 * Each step is the one a person takes. The login form is on the platform host; the emailed link
 * opens its page there, as sent, and Continue sets the refresh cookie on the platform host. An
 * address whose one account holds one app skips Home for that app's Studio, on the galaxy's own
 * host, so `scope` MUST be its account's only app.
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

  await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
  // Armed before the form sends; the recipient is unique to the caller, so it alone discriminates.
  const waiter = waitForEmail({ testToken, to: email });
  let link: string;
  try {
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByRole('button', { name: /Email me a link/ }).click();
    await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }

  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('link-continue').click();
  await page.waitForURL((u) => u.origin === scopeOriginFrom(viteBaseUrl, scope), { timeout: 30_000 });
  await page.getByPlaceholder('Describe a change…').waitFor({ state: 'visible', timeout: 30_000 });

  return { ctx, page };
}

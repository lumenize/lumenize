/**
 * Test helpers for @lumenize/auth
 *
 * These utilities simulate browser auth flows for integration testing.
 */

import type { Browser } from '@lumenize/utils';

/**
 * Simulate magic link login flow using Browser
 *
 * Steps:
 * 1. Request magic link (test mode returns URL in response)
 * 2. "Click" the magic link - Browser follows redirect and captures cookies
 * 3. Exchange refresh token cookie for access token
 *
 * Requires:
 * - LumenizeAuth DO configured with `AUTH_TEST_MODE=true`
 * - Worker with `createAuthRoutes()` handling `/auth/*` routes
 *
 * @param browser - Browser instance from @lumenize/utils or @lumenize/testing
 * @param email - Email address for the magic link
 * @param baseUrl - Base URL for auth endpoints (default: 'https://localhost')
 * @returns The userId from the JWT access token
 *
 * @example
 * ```typescript
 * const browser = new Browser();
 * const userId = await testLoginWithMagicLink(browser, 'alice@example.com');
 * // Browser now has refresh-token cookie stored
 * // Can inject (or monkey batch globalThis versions) with browser.fetch and 
 * // browser.WebSocket to LumenizeClient, Agent, or other places where you want
 * // to test with simulated cookie behavior 
 * ```
 */
export async function testLoginWithMagicLink(
  browser: Browser,
  email: string,
  baseUrl = 'https://localhost'
): Promise<string> {
  // Step 1: Request magic link
  const magicLinkResponse = await browser.fetch(`${baseUrl}/auth/email-magic-link?_test=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const responseBody = await magicLinkResponse.json() as { magic_link?: string };
  if (!responseBody.magic_link) {
    throw new Error(
      `testLoginWithMagicLink: Failed to get magic link. ` +
      `Status: ${magicLinkResponse.status}, Response: ${JSON.stringify(responseBody)}`
    );
  }

  // Step 2: "Click" the magic link - Browser follows redirect and captures cookies
  await browser.fetch(responseBody.magic_link);

  // Step 3: Exchange refresh token cookie for access token
  const refreshResponse = await browser.fetch(`${baseUrl}/auth/refresh-token`, {
    method: 'POST'
  });
  const refreshBody = await refreshResponse.json() as { access_token?: string };
  if (!refreshBody.access_token) {
    throw new Error(
      `testLoginWithMagicLink: Failed to get access token. ` +
      `Status: ${refreshResponse.status}, Response: ${JSON.stringify(refreshBody)}, ` +
      `Cookies: ${JSON.stringify(browser.getAllCookiesAsObject())}`
    );
  }

  // Extract userId from JWT payload (base64 decode middle part)
  const payload = JSON.parse(atob(refreshBody.access_token.split('.')[1]));
  return payload.sub;
}

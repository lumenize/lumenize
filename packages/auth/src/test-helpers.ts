/**
 * Test helpers for @lumenize/auth
 *
 * These utilities simulate browser auth flows for integration testing.
 */

import type { Browser } from '@lumenize/utils';

/**
 * Options for testLoginWithMagicLink
 */
export interface TestLoginOptions {
  /** Base URL for auth endpoints (default: 'https://localhost') */
  baseUrl?: string;
  /** Auth route prefix (default: '/auth') */
  prefix?: string;
  /** Subject data to set after login (requires LUMENIZE_AUTH_TEST_MODE) */
  subjectData?: {
    /** Grant admin approval (default: false — subject has emailVerified but not adminApproved) */
    adminApproved?: boolean;
    /** Grant admin role (implicitly sets adminApproved) */
    isAdmin?: boolean;
  };
  /**
   * Pre-existing access token of an actor requesting delegation.
   * When provided, after the normal login flow the helper calls
   * POST {prefix}/delegated-token with this token as Bearer auth
   * and `{ actFor: sub }` where sub is the logged-in principal.
   * The returned accessToken will have `act.sub` = the actor's sub.
   * Use `parseJwtUnsafe(accessToken)` to inspect delegation claims.
   */
  actorAccessToken?: string;
}

/**
 * Result of testLoginWithMagicLink
 */
export interface TestLoginResult {
  /** The signed JWT access token (decode with `parseJwtUnsafe` if you need claims) */
  accessToken: string;
  /** Subject ID (UUID) extracted from the JWT */
  sub: string;
}

/**
 * Simulate magic link login flow using Browser
 *
 * Steps:
 * 1. Request magic link (test mode returns URL in response)
 * 2. "Click" the magic link - Browser follows redirect and captures cookies
 * 3. If subjectData provided: set flags via test-only endpoint
 * 4. Exchange refresh token cookie for access token (re-queries subject from DB)
 *
 * Requires:
 * - LumenizeAuth DO configured with `LUMENIZE_AUTH_TEST_MODE=true`
 * - Worker with `createAuthRoutes()` handling `{prefix}/*` routes
 *
 * @param browser - Browser instance from @lumenize/utils or @lumenize/testing
 * @param email - Email address for the magic link
 * @param options - Optional configuration (baseUrl, prefix, subjectData)
 * @returns `{ accessToken, sub }` — use `parseJwtUnsafe(accessToken)` if you need claims
 *
 * @example
 * ```typescript
 * const browser = new Browser();
 * const { accessToken, sub } = await testLoginWithMagicLink(browser, 'alice@example.com', {
 *   subjectData: { adminApproved: true }
 * });
 * ```
 *
 * @see https://lumenize.com/docs/auth/testing
 */
export async function testLoginWithMagicLink(
  browser: Browser,
  email: string,
  options: TestLoginOptions = {}
): Promise<TestLoginResult> {
  const { baseUrl = 'https://localhost', prefix = '/auth', subjectData } = options;

  // Step 1: Request magic link
  const magicLinkResponse = await browser.fetch(`${baseUrl}${prefix}/email-magic-link?_test=true`, {
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

  // Step 3: If subjectData provided, set flags via test-only endpoint
  if (subjectData) {
    const setDataResponse = await browser.fetch(`${baseUrl}${prefix}/test/set-subject-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...subjectData })
    });
    if (!setDataResponse.ok) {
      const errorBody = await setDataResponse.text();
      throw new Error(
        `testLoginWithMagicLink: Failed to set subject data. ` +
        `Status: ${setDataResponse.status}, Response: ${errorBody}`
      );
    }
  }

  // Step 4: Exchange refresh token cookie for access token
  // #handleRefreshToken re-queries the subject from DB, so the JWT
  // will reflect any flags set in step 3
  const refreshResponse = await browser.fetch(`${baseUrl}${prefix}/refresh-token`, {
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

  // Extract sub from JWT payload (base64url decode middle part)
  const accessToken = refreshBody.access_token;
  const payloadB64 = accessToken.split('.')[1];
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
  const { sub } = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));

  // Step 5 (optional): Request delegated token if actorAccessToken provided
  if (options.actorAccessToken) {
    const delegateResponse = await browser.fetch(`${baseUrl}${prefix}/delegated-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.actorAccessToken}`,
      },
      body: JSON.stringify({ actFor: sub })
    });
    const delegateBody = await delegateResponse.json() as { access_token?: string };
    if (!delegateBody.access_token) {
      throw new Error(
        `testLoginWithMagicLink: Failed to get delegated token. ` +
        `Status: ${delegateResponse.status}, Response: ${JSON.stringify(delegateBody)}`
      );
    }
    return { accessToken: delegateBody.access_token, sub };
  }

  return { accessToken, sub };
}

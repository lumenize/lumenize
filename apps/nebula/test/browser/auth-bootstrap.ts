/**
 * Auth bootstrap for the Nebula browser harness — drives a real magic-link
 * email round-trip end-to-end:
 *
 *   1. Test → wrangler-dev:  POST /auth/<scope>/email-magic-link
 *   2. wrangler-dev → Cloudflare Email Sending → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test (waitForEmail)
 *   5. Test → wrangler-dev: GET <magic-link URL> (cookie captured)
 *   6. NebulaClient internally → POST /auth/<scope>/refresh-token (cookie sent,
 *      JWT returned)
 *
 * No test-mode bypass — exercises the same code path a real user would
 * exercise. The audit-test-mode.sh script ensures no future change leaks
 * NEBULA_AUTH_TEST_MODE into wrangler configs / npm scripts / CI.
 */

import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import type { Browser } from '@lumenize/testing';

interface BootstrapAdminOptions {
  /** Browser instance to use for HTTP calls (cookies persist across calls). */
  browser: Browser;
  /** wrangler-dev base URL (provided by globalSetup, e.g. 'https://localhost:51234'). */
  baseUrl: string;
  /** Scope (universeGalaxyStarId) to authenticate at — e.g. 'acme.app.tenant-a'. */
  scope: string;
  /** Email to register / log in. Should be `test@lumenize.io` so the deployed email-test Worker receives it. */
  email: string;
  /** TEST_TOKEN for authenticating with the deployed email-test DO. */
  testToken: string;
}

/**
 * End-to-end magic-link bootstrap. After this resolves, the Browser's cookie
 * jar holds the refresh cookie scoped to `/auth/${scope}/`, and the caller
 * can construct a `NebulaClient({ baseUrl, fetch: browser.fetch, ... })`
 * which will mint access JWTs via the real refresh-token flow.
 *
 * ⚠️ **STALE PREMISE — this no longer bootstraps anything on its own (2026-07-21).** It used to rely
 * on "the first email registered at a NebulaAuth instance becomes that instance's founder/admin",
 * but that founder-minting-on-login path was DELIBERATELY REMOVED: it was the stranger-claims-a-child
 * escalation, and identity mint is now authority-point-only (Universe/Star claim + invite issuance) —
 * `nebula-auth-registry.ts` says outright "NEVER call from a login path". So at a scope with no
 * pre-existing identity, the magic link is minted and emailed fine and then REJECTED on consumption:
 * `getAndVerifyIdentity` returns null → `302 /app?error=invalid_token`, no cookie.
 *
 * The replacement (open Star self-signup with a real founder) is designed and pinned but NOT BUILT —
 * `tasks/nebula-star-founder-provisioning.md`. Until it lands, a local real login only works where an
 * identity already exists. This is the same "expectedly red mid-turnover" state the baseline test-app
 * header notes. (8th site of the stale-signup-design family swept in `0c2989d`.)
 */
export async function bootstrapAdmin(options: BootstrapAdminOptions): Promise<void> {
  const { browser, baseUrl, scope, email, testToken } = options;

  // 1. Set up email listener BEFORE triggering the send.
  //    `instance: scope` makes the email-test DO route only this test's
  //    magic-link email to this listener (via the `X-Lumenize-Auth-Instance`
  //    header that `NebulaEmailSender.magicLinkHeaders` stamps on every
  //    magic-link email). Concurrent tests with different scopes don't collide.
  const waiter = waitForEmail({ testToken, instance: scope });

  try {
    // 2. Request magic link
    const magicLinkResponse = await browser.fetch(
      `${baseUrl}/auth/${scope}/email-magic-link`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      },
    );
    if (!magicLinkResponse.ok) {
      throw new Error(`email-magic-link request failed: ${magicLinkResponse.status} ${await magicLinkResponse.text()}`);
    }

    // 3. Wait for the email to arrive at the deployed email-test Worker
    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // 4. Extract magic link URL from the email HTML
    const magicLinkUrl = extractMagicLink(receivedEmail);

    // 5. Click the magic link — NebulaAuth sets the refresh cookie and 302s
    //    to NEBULA_AUTH_REDIRECT (e.g. '/app'). We stop at the 302 because
    //    `/app` is a frontend route that doesn't exist on wrangler-dev (the
    //    real frontend would handle it). Browser captures Set-Cookie from
    //    the 302 response itself, so the cookie jar is populated either way.
    const clickResponse = await browser.fetch(magicLinkUrl, { redirect: 'manual' });
    if (clickResponse.status !== 302) {
      throw new Error(`Magic-link click expected 302, got ${clickResponse.status} for ${magicLinkUrl}`);
    }
  } finally {
    waiter.cleanup();
  }
}

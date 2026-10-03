/**
 * Auth bootstrap for the mesh browser e2e project — drives a real magic-link
 * email round-trip end-to-end:
 *
 *   1. globalSetup → wrangler-dev:  POST /auth/email-magic-link
 *   2. wrangler-dev → Resend → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to globalSetup
 *   5. globalSetup → wrangler-dev: GET <magic-link URL> (cookie captured by the jar)
 *   6. globalSetup → wrangler-dev: POST /auth/refresh-token (cookie sent, JWT
 *      returned and provided to every test as `adminAccessToken`)
 *
 * ⚠️ **This runs ONCE, in Node, for the whole project — not per test file.** Every browser test
 * here needs the SAME identity, because the worker pins `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` and only
 * the first subject registered with that address is auto-approved. Two test files each doing their
 * own round trip is therefore not two logins but two races for one mailbox: both waiters take
 * whichever email lands first, both pass the recipient check (same address), and the second click
 * finds a link the first already consumed — a 401 `No refresh token provided` that reads as flake.
 * That is a shared-fixture bug, not a timing one, so the fix is one login rather than a retry or a
 * serialized project. A test gets the token with `inject('adminAccessToken')`.
 *
 * ⚠️ **The emailed link is followed AS SENT.** An earlier version rewrote its host onto the vite
 * proxy origin so a browser-side jar would hold the cookie; that is the compensating-helper shape
 * `.claude/rules/live.md` forbids, and it hid whatever the real link pointed at. In Node the jar is
 * ours, so the link needs no rewriting — and if the host it carries ever stops matching the stack
 * that sent it, this throws instead of papering over it.
 *
 * The browser never needs the cookie: `LumenizeClient` skips its refresh round-trip entirely when
 * an `accessToken` is supplied, refreshing only when the token is missing or near expiry, and an
 * access token minted at setup is good for far longer than the suite runs.
 */

import { Browser } from '@lumenize/testing';
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';

interface BootstrapOptions {
  /** wrangler-dev's OWN base URL — not the vite proxy path. This runs in Node, so there is no proxy. */
  wranglerUrl: string;
  email: string;
  testToken: string;
}

/**
 * Run the full magic-link flow, then exchange the resulting cookie for a JWT via
 * `/auth/refresh-token`. Returns the access token for use as `LumenizeClientConfig.accessToken`.
 */
export async function bootstrapAndGetAccessToken(options: BootstrapOptions): Promise<string> {
  const { wranglerUrl, email, testToken } = options;
  const browser = new Browser(fetch);

  // 1. Set up the email listener BEFORE triggering the send — the DO pushes only to already-open
  //    sockets, so a listener attached afterwards misses the mail entirely.
  //
  //    `to` guards against mail from ANOTHER workspace, which uses this same pinned address. It
  //    cannot guard against a second waiter HERE, because that one would match too — which is why
  //    this function runs once for the project rather than once per file.
  const waiter = waitForEmail({ testToken, to: email });

  try {
    // 2. Request the magic link
    const magicLinkResponse = await browser.fetch(`${wranglerUrl}/auth/email-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!magicLinkResponse.ok) {
      throw new Error(`email-magic-link request failed: ${magicLinkResponse.status} ${await magicLinkResponse.text()}`);
    }

    // 3. Wait for the email
    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // 4. Click the link AS SENT — the 302 sets the refresh cookie on our jar.
    const magicLinkUrl = extractMagicLink(receivedEmail);
    const linkHost = new URL(magicLinkUrl).host;
    const stackHost = new URL(wranglerUrl).host;
    if (linkHost !== stackHost) {
      throw new Error(
        `Magic-link host '${linkHost}' is not the stack that sent it ('${stackHost}'). Fix what the ` +
        `worker embeds rather than rewriting the link here — a rewritten link stops testing the one ` +
        `thing this round trip exists to test (see .claude/rules/live.md).`,
      );
    }
    const clickResponse = await browser.fetch(magicLinkUrl, { redirect: 'manual' });
    if (clickResponse.status !== 302) {
      throw new Error(`Magic-link click expected 302, got ${clickResponse.status}`);
    }

    // 5. Mint the access token via the refresh-token endpoint
    const refreshResponse = await browser.fetch(`${wranglerUrl}/auth/refresh-token`, { method: 'POST' });
    if (!refreshResponse.ok) {
      throw new Error(`refresh-token request failed: ${refreshResponse.status} ${await refreshResponse.text()}`);
    }
    const body = await refreshResponse.json() as { access_token: string };
    if (!body.access_token) {
      throw new Error(`refresh-token response missing access_token: ${JSON.stringify(body)}`);
    }
    return body.access_token;
  } finally {
    waiter.cleanup();
  }
}

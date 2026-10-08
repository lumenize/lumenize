/**
 * Auth bootstrap for the mesh browser e2e project — claims a fresh universe through a real
 * magic-link email round trip (ADR-009 rung 1), end to end:
 *
 *   1. globalSetup → wrangler-dev:  POST /auth/claim-universe on the platform host
 *   2. wrangler-dev → Resend → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to globalSetup
 *   5. globalSetup → wrangler-dev: the link page's consume, `POST /auth/magic-link`, which accepts
 *      the claim and sets the universe's refresh cookie on our jar
 *   6. globalSetup → wrangler-dev: POST /auth/refresh-token from a page on the universe's host
 *      (its `Origin`), returning the access token every test is given as `adminAccessToken`
 *
 * ⚠️ **This runs ONCE, in Node, for the whole project — not per test file.** One login is all the
 * lane needs, and an address fresh per run keeps any other lane's mail from answering its waiter.
 *
 * ⚠️ **The emailed link is followed AS SENT.** Its token is posted to the link's own origin and
 * path, as the link page's button does; if the host it carries ever stops matching the stack that
 * sent it, this throws instead of papering over it.
 *
 * The browser never needs the cookie: `LumenizeClient` skips its refresh round-trip entirely when
 * an `accessToken` is supplied, refreshing only when the token is missing or near expiry, and an
 * access token minted at setup is good for far longer than the suite runs.
 */

import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';

interface BootstrapOptions {
  /** wrangler-dev's port. This runs in Node against the hosts the Worker spells, so there is no proxy. */
  port: string;
  /** The universe to claim; its host is the page every test's Client connects from. */
  scope: string;
  testToken: string;
}

const REFRESH_COOKIE_PREFIX = '__Host-refresh-token.';

/**
 * Claim `scope` as a fresh address, follow the emailed link, and exchange the resulting cookie for
 * an access token on the universe's own page. Returns the token for `LumenizeClientConfig.accessToken`.
 */
export async function claimAndGetAccessToken(options: BootstrapOptions): Promise<string> {
  const { port, scope, testToken } = options;
  const platform = `http://platform.lumenize.localhost:${port}`;
  const page = `http://${scope}.lumenize.localhost:${port}`;
  const email = uniqueTestEmail('mesh-browser');

  // 1. Set up the email listener BEFORE triggering the send — the DO pushes only to already-open
  //    sockets, so a listener attached afterwards misses the mail entirely.
  const waiter = waitForEmail({ testToken, to: email });

  try {
    // 2. Claim the universe, with its first app; the claim mails its consent link
    const claim = await fetch(`${platform}/auth/claim-universe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: scope, appSlug: 'first', email }),
    });
    if (!claim.ok) throw new Error(`claim-universe failed: ${claim.status} ${await claim.text()}`);

    // 3. Wait for the email
    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // 4. Press the link page's button — its consume accepts the claim and sets the cookie.
    const link = new URL(extractMagicLink(receivedEmail));
    if (link.origin !== platform) {
      throw new Error(
        `Magic-link origin '${link.origin}' is not the stack that sent it ('${platform}'). Fix what the ` +
        `worker embeds rather than rewriting the link here (see .claude/rules/live.md).`,
      );
    }
    const consume = await fetch(`${link.origin}${link.pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: link.searchParams.get('token') }),
    });
    if (consume.status !== 200) throw new Error(`Magic-link consume expected 200, got ${consume.status}`);
    const cookie = consume.headers.getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith(`${REFRESH_COOKIE_PREFIX}${scope}=`));
    if (!cookie) throw new Error(`the consume set no refresh cookie for "${scope}"`);

    // 5. Mint the access token from a page on the universe's host
    const refreshResponse = await fetch(`${platform}/auth/refresh-token`, {
      method: 'POST',
      headers: { Origin: page, Cookie: cookie },
    });
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

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
 *
 * The `waitForEmail` and `extractMagicLink` helpers below are copies of
 * `packages/auth/test/e2e-email/email-test-helpers.ts`. They could be
 * promoted to a shared package once a third consumer needs them — see
 * tasks/backlog.md (Testing & Quality section).
 */

import type { Browser } from '@lumenize/testing';

const EMAIL_TEST_HTTP_URL = 'https://email-test.transformation.workers.dev';
const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

/**
 * Minimal shape of a stored email returned by the email-test Worker.
 * Matches `@lumenize/email-test/types`'s `StoredEmail` — duplicated locally
 * to avoid pulling that package in just for one type.
 */
interface StoredEmail {
  subject?: string;
  html?: string;
  to?: Array<{ address: string }>;
  from?: { address: string };
}

interface WaitForEmailOptions {
  /** TEST_TOKEN for authenticating with the deployed email-test DO */
  testToken: string;
  /**
   * Scope this listener to emails carrying `X-Lumenize-Auth-Instance: <instance>`.
   * Required for concurrent test runs — without it, multiple tests share one
   * email channel and race each other for the next-arriving email.
   *
   * Maps 1:1 to NebulaAuth's `instanceName` URL segment (a 1-3 dot-separated
   * slug like `acme-abc.app.tenant-a`). `NebulaEmailSender.magicLinkHeaders`
   * stamps the header on every magic-link email.
   *
   * Omit to subscribe to ALL emails (legacy single-tenant behavior).
   */
  instance?: string;
  /** Timeout in ms before giving up. Default: 20000 (20s) */
  timeout?: number;
}

/**
 * Connect to the deployed email-test Worker via WebSocket, clear existing
 * emails, and wait for a new email to arrive. Returns the parsed email.
 *
 * Call this BEFORE triggering the action that sends the email.
 */
export function waitForEmail(options: WaitForEmailOptions): {
  emailPromise: Promise<StoredEmail>;
  cleanup: () => void;
} {
  const { testToken, instance, timeout = 20_000 } = options;
  const instanceParam = instance !== undefined ? `&instance=${encodeURIComponent(instance)}` : '';

  let ws: WebSocket;
  let cleanedUp = false;

  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      try { ws?.close(); } catch { /* ignore */ }
    }
  };

  const emailPromise = (async () => {
    // Clear existing emails for this instance only (other concurrent tests'
    // emails stay intact).
    await fetch(`${EMAIL_TEST_HTTP_URL}/clear?token=${testToken}${instanceParam}`, { method: 'POST' });

    // Connect WebSocket — instance filter persists via serializeAttachment
    // on the DO side, so concurrent subscribers see only their own emails.
    ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws?token=${testToken}${instanceParam}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection to email-test Worker failed')));
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
    });

    const email = await new Promise<StoredEmail>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No email received within ${timeout}ms`));
      }, timeout);

      ws.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket closed before email received'));
      });
    });

    return email;
  })();

  return { emailPromise, cleanup };
}

/**
 * Extract the magic-link URL from a parsed email's HTML content.
 */
export function extractMagicLink(email: StoredEmail): string {
  const html = email.html;
  if (!html) {
    throw new Error('Email has no HTML content');
  }

  const hrefMatch = html.match(/href="([^"]*magic-link[^"]*one_time_token[^"]*)"/);
  if (!hrefMatch) {
    throw new Error(`No magic link found in email HTML. Subject: "${email.subject}"`);
  }

  return hrefMatch[1];
}

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
 * The first email registered at a NebulaAuth instance becomes that instance's
 * founder/admin (per #loginSubject). Combined with
 * `NEBULA_AUTH_BOOTSTRAP_EMAIL=test@lumenize.io` (set by globalSetup), the
 * resulting subject has admin permissions — sufficient for ontology
 * registration + transactions in the round-trip test.
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

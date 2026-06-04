/**
 * Auth bootstrap for the mesh browser e2e test — drives a real magic-link
 * email round-trip end-to-end:
 *
 *   1. Test → wrangler-dev:  POST /auth/email-magic-link
 *   2. wrangler-dev → Cloudflare Email Sending → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test
 *   5. Test → wrangler-dev: GET <magic-link URL> (cookie captured by browser)
 *   6. Test → wrangler-dev: POST /auth/refresh-token (cookie sent, JWT
 *      returned for use as `accessToken` on LumenizeClient)
 *
 * Runs in a real chromium browser (via @vitest/browser-playwright), so
 * browser-native fetch + cookie jar + WebSocket are used directly. Unlike
 * apps/nebula's helper (which uses @lumenize/testing's Browser class to
 * simulate cookies in Node), nothing here is shimmed.
 *
 * Adapted from `apps/nebula/test/browser/auth-bootstrap.ts`; mesh's
 * `@lumenize/auth` integration is single-tenant so there's no scope/instance
 * parameter, and the `X-Lumenize-Auth-Instance` email header (item #4b)
 * isn't load-bearing here because the mesh e2e test is the only test that
 * runs against this wrangler-dev worker.
 */

const EMAIL_TEST_HTTP_URL = 'https://email-test.transformation.workers.dev';
const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

interface StoredEmail {
  subject?: string;
  html?: string;
  to?: Array<{ address: string }>;
  from?: { address: string };
}

interface WaitForEmailOptions {
  testToken: string;
  timeout?: number;
}

export function waitForEmail(options: WaitForEmailOptions): {
  emailPromise: Promise<StoredEmail>;
  cleanup: () => void;
} {
  const { testToken, timeout = 20_000 } = options;

  let ws: WebSocket;
  let cleanedUp = false;

  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      try { ws?.close(); } catch { /* ignore */ }
    }
  };

  const emailPromise = (async () => {
    await fetch(`${EMAIL_TEST_HTTP_URL}/clear?token=${testToken}`, { method: 'POST' });

    ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws?token=${testToken}`);
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

interface BootstrapOptions {
  baseUrl: string;
  email: string;
  testToken: string;
}

/**
 * Run the full magic-link flow, then exchange the resulting cookie for a
 * JWT via `/auth/refresh-token`. Returns the access token for use as
 * `LumenizeClientConfig.accessToken`.
 *
 * The browser-side cookie jar handles `Set-Cookie` automatically; we don't
 * have to thread cookies manually.
 */
export async function bootstrapAndGetAccessToken(options: BootstrapOptions): Promise<string> {
  const { baseUrl, email, testToken } = options;

  // 1. Set up email listener BEFORE triggering the send
  const waiter = waitForEmail({ testToken });

  try {
    // 2. Request magic link
    const magicLinkResponse = await fetch(`${baseUrl}/auth/email-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include',
    });
    if (!magicLinkResponse.ok) {
      throw new Error(`email-magic-link request failed: ${magicLinkResponse.status} ${await magicLinkResponse.text()}`);
    }

    // 3. Wait for the email
    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // 4. Extract + click magic link — 302 sets the refresh cookie.
    //    LumenizeAuth embeds its own host (wrangler-dev) in the magic-link
    //    URL. Rewrite to the same-origin proxy path so the cookie set on
    //    the 302 response is associated with the test page's origin (and
    //    thus sent on the follow-up `/auth/refresh-token` POST).
    const magicLinkUrlRaw = extractMagicLink(receivedEmail);
    const magicLinkUrl = magicLinkUrlRaw.replace(/^https?:\/\/[^/]+/, baseUrl);
    const clickResponse = await fetch(magicLinkUrl, { redirect: 'manual', credentials: 'include' });
    if (clickResponse.status !== 302 && clickResponse.status !== 0) {
      // status 0 = "opaqueredirect" mode (chromium returns 0 for manual-redirect
      // responses); cookies are still saved either way.
      throw new Error(`Magic-link click expected 302 (or 0 opaqueredirect), got ${clickResponse.status}`);
    }

    // 5. Mint access token via refresh-token endpoint
    const refreshResponse = await fetch(`${baseUrl}/auth/refresh-token`, {
      method: 'POST',
      credentials: 'include',
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

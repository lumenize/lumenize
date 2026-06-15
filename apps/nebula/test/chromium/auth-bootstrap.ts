/**
 * Auth bootstrap for the real-chromium harness — drives a real magic-link
 * email round-trip end-to-end, browser-native (no `@lumenize/testing` Browser
 * shim; chromium's own fetch + cookie jar + WebSocket are used directly):
 *
 *   1. Test → /worker/auth/<scope>/email-magic-link  (same-origin via proxy)
 *   2. wrangler-dev → Cloudflare Email Sending → SMTP
 *   3. Cloudflare Email Routing → deployed `email-test` Worker
 *   4. email-test Worker → WebSocket push back to test (waitForEmail)
 *   5. Test → GET <magic-link URL, host-rewritten to the proxy> → 302 sets the
 *      `Secure; SameSite=Strict` refresh cookie on the TEST PAGE's origin
 *
 * After this resolves, chromium holds the refresh cookie at `/worker/auth/<scope>/`,
 * so a subsequent `createNebulaClient({ baseUrl, authScope: scope, ... })`
 * mints its access JWT via the real `/auth/<scope>/refresh-token` flow on connect
 * (no pre-passed accessToken needed — exercises the real refresh path).
 *
 * Adapted from `apps/nebula/test/browser/auth-bootstrap.ts` (Node-side) +
 * `packages/mesh/test/browser/auth-bootstrap.ts` (browser-native). The magic-link
 * host rewrite (step 5) is the chromium-specific bit: LumenizeAuth embeds
 * wrangler-dev's own host in the link, but the cookie must be set on the test
 * page's origin, so we rewrite to the same-origin proxy path before clicking.
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
  /** Filter to emails carrying `X-Lumenize-Auth-Instance: <instance>` (the scope). */
  instance?: string;
  timeout?: number;
}

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
    await fetch(`${EMAIL_TEST_HTTP_URL}/clear?token=${testToken}${instanceParam}`, { method: 'POST' });

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

export function extractMagicLink(email: StoredEmail): string {
  const html = email.html;
  if (!html) throw new Error('Email has no HTML content');
  const hrefMatch = html.match(/href="([^"]*magic-link[^"]*one_time_token[^"]*)"/);
  if (!hrefMatch) throw new Error(`No magic link found in email HTML. Subject: "${email.subject}"`);
  return hrefMatch[1];
}

interface BootstrapAdminOptions {
  /** Same-origin proxy prefix resolved against the test page origin, e.g. `${location.origin}/worker`. */
  baseUrl: string;
  /** Scope (universeGalaxyStarId) to authenticate at — e.g. 'acme-abc.app.tenant-a'. */
  scope: string;
  /** Email to register / log in. Must be `test@lumenize.io` so the deployed email-test Worker receives it. */
  email: string;
  /** TEST_TOKEN for authenticating with the deployed email-test DO. */
  testToken: string;
}

/**
 * Run the magic-link flow so chromium's cookie jar holds the refresh cookie
 * scoped to `/worker/auth/${scope}/`. The first email registered at a NebulaAuth
 * instance becomes its founder/admin; combined with
 * `NEBULA_AUTH_BOOTSTRAP_EMAIL=test@lumenize.io` (set by global-setup) the
 * subject is admin — enough for ontology registration + transactions.
 */
export async function bootstrapAdmin(options: BootstrapAdminOptions): Promise<void> {
  const { baseUrl, scope, email, testToken } = options;

  // Set up the email listener BEFORE triggering the send. `instance: scope`
  // routes only this test's magic-link email here (X-Lumenize-Auth-Instance
  // header), so concurrent runs with different scopes don't collide.
  const waiter = waitForEmail({ testToken, instance: scope });

  try {
    const magicLinkResponse = await fetch(`${baseUrl}/auth/${scope}/email-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include',
    });
    if (!magicLinkResponse.ok) {
      throw new Error(`email-magic-link request failed: ${magicLinkResponse.status} ${await magicLinkResponse.text()}`);
    }

    const receivedEmail = await waiter.emailPromise;
    if (receivedEmail.to?.[0]?.address !== email) {
      throw new Error(`Email recipient mismatch: expected '${email}', got '${receivedEmail.to?.[0]?.address}'`);
    }

    // Rewrite the embedded wrangler-dev host to the same-origin proxy so the
    // 302's Set-Cookie binds to the test page origin (and thus rides the
    // follow-up refresh-token POST). `redirect: 'manual'` — chromium returns an
    // opaqueredirect (status 0) for cross-fetch manual redirects; cookies are
    // saved either way.
    const magicLinkUrl = extractMagicLink(receivedEmail).replace(/^https?:\/\/[^/]+/, baseUrl);
    const clickResponse = await fetch(magicLinkUrl, { redirect: 'manual', credentials: 'include' });
    if (clickResponse.status !== 302 && clickResponse.status !== 0) {
      throw new Error(`Magic-link click expected 302 (or 0 opaqueredirect), got ${clickResponse.status}`);
    }
  } finally {
    waiter.cleanup();
  }
}

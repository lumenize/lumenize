/**
 * Client helpers for the deployed `email-test` Worker — the receive half of a
 * real magic-link round trip.
 *
 * ⚠️ Deliberately NOT re-exported from `src/index.ts`. That entry exports
 * `EmailTestDO`, which imports `cloudflare:workers`; pulling this module in
 * through it would drag that import into Node/Playwright and browser-bundled
 * consumers. Import from `@lumenize/email-test/client`.
 *
 * The full loop these participate in:
 *   1. test → app:              POST /auth/<scope>/email-magic-link
 *   2. app → Cloudflare or Resend → SMTP
 *   3. Cloudflare Email Routing (catch-all `*@lumenize.io`) → this Worker
 *   4. this Worker → WebSocket push back to the test   ← `waitForEmail`
 *   5. test → app:              GET <magic-link URL>   ← `extractMagicLink`
 *
 * No test-mode bypass anywhere in it — this is the path a real user walks, and
 * it costs ~1.4 s standalone / ~0.9 s marginal (see
 * `tasks/email-latency-cf-vs-resend.md`), which is why it can be the default
 * tier rather than a reserved-for-headline-flows luxury.
 */
import type { StoredEmail } from './types';

const EMAIL_TEST_HTTP_URL = 'https://email-test.transformation.workers.dev';
const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

/** Domain whose Email Routing catch-all delivers to this Worker. */
export const EMAIL_TEST_DOMAIN = 'lumenize.io';

export interface WaitForEmailOptions {
  /** TEST_TOKEN for authenticating with the deployed EmailTestDO. */
  testToken: string;
  /**
   * Scope this listener to emails carrying `X-Lumenize-Auth-Instance: <instance>`,
   * so concurrent tests don't race each other for the next-arriving email.
   * Maps 1:1 to NebulaAuth's `instanceName` URL segment (a 1-3 dot-separated slug
   * like `acme-abc.app.tenant-a`); `NebulaEmailSender.magicLinkHeaders` stamps it.
   *
   * Omit to subscribe to ALL emails. Prefer `uniqueTestEmail()` for isolation
   * where no instance is in play — it needs no cooperation from the sender.
   */
  instance?: string;
  /**
   * Give-up timeout in ms. Default 60 s — far above the measured ~1.4 s so a slow
   * CI runner never flakes; a received email resolves immediately, so the ceiling
   * costs the warm path nothing.
   */
  timeout?: number;
}

/**
 * Wall-clock marks (ms since epoch) filled in as the receive side progresses.
 * `wsOpenAt` is a floor on any latency measured across the whole loop: the DO
 * pushes only to *connected* sockets and never replays stored mail, so an email
 * beating the socket open would never be observed at all.
 */
export interface EmailWaitMarks {
  wsOpenAt?: number;
  receivedAt?: number;
}

/**
 * A fresh address that the `*@lumenize.io` catch-all routes to this Worker.
 *
 * Use one per test to make real-login tests independently parallelizable: the
 * shared-mailbox race is what forced suites to serialize (`sequence.groupOrder`),
 * and a unique recipient removes the contention at the source rather than
 * scheduling around it.
 */
export function uniqueTestEmail(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID()}@${EMAIL_TEST_DOMAIN}`;
}

/**
 * Connect to the deployed EmailTestDO over WebSocket, clear existing mail, and
 * wait for the next email to arrive.
 *
 * Call this BEFORE triggering the send — the DO pushes only to already-connected
 * sockets, so a listener attached afterwards misses the email entirely.
 */
export function waitForEmail(options: WaitForEmailOptions): {
  /** Resolves with the next matching email; rejects on timeout or socket close. */
  emailPromise: Promise<StoredEmail>;
  /** Close the WebSocket. Safe to call more than once. */
  cleanup: () => void;
  /** Receive-side timing, for `reportEmailLatency`. */
  marks: EmailWaitMarks;
} {
  const { testToken, instance, timeout = 60_000 } = options;
  const instanceParam = instance !== undefined ? `&instance=${encodeURIComponent(instance)}` : '';

  const marks: EmailWaitMarks = {};
  let ws: WebSocket;
  let cleanedUp = false;

  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      try { ws?.close(); } catch { /* ignore */ }
    }
  };

  const emailPromise = (async () => {
    // Clear only this instance's bucket — concurrent tests' mail stays intact.
    await fetch(`${EMAIL_TEST_HTTP_URL}/clear?token=${testToken}${instanceParam}`, { method: 'POST' });

    // The instance filter persists via serializeAttachment on the DO side, so
    // concurrent subscribers each see only their own emails.
    ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws?token=${testToken}${instanceParam}`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => { marks.wsOpenAt = Date.now(); resolve(); });
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
        marks.receivedAt = Date.now();
        resolve(JSON.parse(event.data as string));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket closed before email received'));
      });
    });

    return email;
  })();

  return { emailPromise, cleanup, marks };
}

/** Extract the magic-link URL from a parsed email's HTML. */
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

/**
 * Log the magic-link round trip — send request issued → email in hand — in a
 * uniform, greppable form: `[email-latency] provider=… label=… loop=…ms`.
 *
 * Measuring on every run is why the cost never has to be re-derived by a
 * throwaway harness — and why a stale quote can't outlive the thing it measures
 * (an uninstrumented "~8s" did exactly that; see ADR-009's amendment).
 * ⚠️ vitest's default reporter swallows passing-test stdout — use
 * `--reporter=verbose` to see these lines.
 *
 * `Date.now()` is trustworthy across these awaits (real network I/O advances it
 * — see the `cf-clock-traps` correction), but both marks are read in one
 * isolate, so treat the value as elapsed time, not absolute wall-clock.
 */
export function reportEmailLatency(
  provider: string,
  label: string,
  startedAt: number,
  marks: EmailWaitMarks,
): number {
  // No `?? Date.now()` fallback: this is only called after the email promise
  // resolved, so an unset mark means the wiring broke — and a fallback would
  // print a number within milliseconds of the true one, hiding that silently.
  if (marks.receivedAt === undefined) {
    throw new Error('reportEmailLatency: marks.receivedAt unset — waitForEmail instrumentation is broken');
  }
  const loop = marks.receivedAt - startedAt;
  const wsOpen = marks.wsOpenAt !== undefined ? marks.wsOpenAt - startedAt : undefined;
  console.log(
    `[email-latency] provider=${provider} label=${label} loop=${loop}ms` +
    (wsOpen !== undefined ? ` wsOpen=${wsOpen}ms` : ''),
  );
  return loop;
}

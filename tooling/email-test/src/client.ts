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
 *   3. Cloudflare Email Routing (catch-all `*@lumenize-test.dev`) → this Worker
 *   4. this Worker → WebSocket push back to the test   ← `waitForEmail`
 *      …and beside it, Resend's webhook → this Worker → the same socket, so a waiter hears what
 *      Resend reported about its send: a bounce ends the wait at once, and a timeout names the hop.
 *   5. test → app:              GET <magic-link URL>   ← `extractMagicLink`
 *
 * No test-mode bypass anywhere in it — this is the path a real user walks, and
 * it costs ~1.4 s standalone / ~0.9 s marginal (see
 * `tasks/email-latency-cf-vs-resend.md`), which is why it can be the default
 * tier rather than a reserved-for-headline-flows luxury.
 */
import type { StoredEmail, DeliveryEvent, DeliveryEventMessage, ReplayedMessage, ReplayRequest } from './types';

const EMAIL_TEST_HTTP_URL = 'https://email-test.transformation.workers.dev';
const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

/** Domain whose Email Routing catch-all delivers to this Worker. */
export const EMAIL_TEST_DOMAIN = 'lumenize-test.dev';

export interface WaitForEmailOptions {
  /** TEST_TOKEN for authenticating with the deployed EmailTestDO. */
  testToken: string;
  /**
   * Scope this listener to emails carrying `X-Lumenize-Auth-Instance: <instance>`,
   * so concurrent tests don't race each other for the next-arriving email.
   * Maps 1:1 to NebulaAuth's `instanceName` (a 1-3 dot-separated slug like
   * `acme-abc.app.tenant-a`).
   *
   * **Every Nebula auth mail carries this header** — `EmailMessage.instanceName` is required on
   * every variant and `AuthEmailSender.headers` stamps it directly, so a new message type is
   * filterable here with no change to the sender and none can ship untagged. (Before 2026-07-31
   * the tag was re-parsed out of the message's URL, so mail linking to a non-instance route —
   * `/app`, say — landed untagged in the catch-all bucket.)
   *
   * Omit to subscribe to ALL emails. ⚠️ **`uniqueTestEmail()` + `to` is still the better isolation
   * default**, and the reason has changed: not because mail might be untagged, but because two
   * listeners on the SAME instance race for the next-arriving mail. Supplying `to` also skips the
   * startup `clear` this helper otherwise issues — which NO waiter needs for its own sake, because
   * the socket only ever carries mail that arrived after this waiter began (see `emailPromise` below). So a
   * recipient filter requires no cooperation from the sender and cannot collide.
   */
  instance?: string;
  /**
   * Resolve only for an email addressed to this recipient, ignoring any other
   * that arrives on the socket. Pair with `uniqueTestEmail()` to make a test
   * independent of every other test sending mail at the same time.
   *
   * Filtered client-side on purpose: the EmailTestDO is *deployed* shared
   * infrastructure, so keeping isolation here means a new test lane needs no
   * redeploy — and no cooperation from the sender, unlike `instance` (which
   * only works if the sender stamps the header).
   *
   * With `to` set, the waiter also hears Resend's delivery events for that recipient: a bounce, a
   * failure or a suppression rejects at once with Resend's reason, and a timeout says what Resend last
   * reported ({@link describeDelivery}). Without it, events are not subscribed to.
   */
  to?: string;
  /**
   * Give-up timeout in ms. Default 60 s — far above the measured ~1.4 s so a slow
   * CI runner never flakes; a received email resolves immediately, so the ceiling
   * costs the warm path nothing.
   */
  timeout?: number;
}

/**
 * Wall-clock marks (ms since epoch) filled in as the receive side progresses.
 * `wsOpenAt` is when the first socket opened. Mail that beats it reaches the waiter by replay.
 */
export interface EmailWaitMarks {
  wsOpenAt?: number;
  receivedAt?: number;
}

/**
 * A fresh address that the `*@lumenize-test.dev` catch-all routes to this Worker.
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
 * How a waiter reaches the email-test Worker. The default goes over the network to the deployed
 * one; the package's own tests pass one that reaches the Worker under test.
 */
export interface EmailTestTransport {
  /** An OPEN socket on `/ws` with `query` appended, or a rejection when it does not open. */
  open(query: string): Promise<WebSocket>;
  /** Empties the stored list `/emails` reads. */
  clear(query: string): Promise<void>;
}

const networkTransport: EmailTestTransport = {
  open: (query) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws${query}`);
    const giveUp = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
    ws.addEventListener('open', () => { clearTimeout(giveUp); resolve(ws); });
    ws.addEventListener('error', () => {
      clearTimeout(giveUp);
      reject(new Error('WebSocket connection to email-test Worker failed'));
    });
  }),
  clear: async (query) => { await fetch(`${EMAIL_TEST_HTTP_URL}/clear${query}`, { method: 'POST' }); },
};

/** The wait before each reconnect, by how many have failed in a row. */
const RECONNECT_DELAYS_MS = [100, 250, 500, 1000, 2000];

/** How long a reconnected socket waits for the Worker's replay before saying it cannot replay. */
const REPLAY_ANSWER_MS = 5000;

/**
 * Connect to the deployed EmailTestDO over WebSocket, clear existing mail, and
 * wait for the next email to arrive.
 *
 * Call this BEFORE triggering the send — the DO pushes only to already-connected
 * sockets, so a listener attached afterwards misses the email entirely.
 *
 * **Every socket, once open, asks the Worker to replay what arrived since this call began** (as an
 * elapsed time, so the two clocks need not agree). This call returns before its socket is open and
 * the caller sends at once, so a fast mail can be stored before the socket exists: on 2026-11-24 an
 * invite was stored 640 ms after its send and its waiter never heard it. The replay covers that
 * stretch, and nothing older.
 *
 * **A socket that fails to open or drops is opened again, until the wait's `timeout`,** and the
 * same replay covers mail that landed while none was open.
 *
 * ⚠️ **You MUST call `cleanup()`, and a `finally` is the only safe place** — an assertion between
 * here and there will otherwise skip it. The reason is not tidiness: the open WebSocket keeps Node's
 * event loop alive, so a leaked waiter makes the process **print its verdict and then hang**. That
 * failure is nastier than it sounds because it accuses the wrong thing — a scenario that passed in
 * 4 s looks like a 7-minute hung boot, and the natural conclusion is "the live tier is slow/flaky"
 * rather than "my caller leaked a socket". Bit 2026-08-04, and it is exactly the impression
 * `live.md` exists to correct.
 */
export function waitForEmail(options: WaitForEmailOptions, transport: EmailTestTransport = networkTransport): {
  /** Resolves with the next matching email; rejects on timeout, a terminal Resend event, or `cleanup()`. */
  emailPromise: Promise<StoredEmail>;
  /** Close the WebSocket — REQUIRED, in a `finally`. Safe to call more than once. See the note above:
   *  a leaked waiter hangs the process after its verdict prints. */
  cleanup: () => void;
  /** Receive-side timing, for `reportEmailLatency`. */
  marks: EmailWaitMarks;
  /** What Resend has reported so far about the send to `to`, oldest first. Empty without `to`. */
  deliveryEvents: DeliveryEvent[];
} {
  const { testToken, instance, to, timeout = 60_000 } = options;
  const instanceParam = instance !== undefined ? `&instance=${encodeURIComponent(instance)}` : '';
  const query = `?token=${testToken}${instanceParam}`;
  const matchesRecipient = (email: StoredEmail) =>
    to === undefined || email.to?.some((addr) => addr.address?.toLowerCase() === to.toLowerCase()) === true;

  const marks: EmailWaitMarks = {};
  const deliveryEvents: DeliveryEvent[] = [];
  const startedAt = Date.now();
  let ws: WebSocket | undefined;
  let settled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (run: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => { timers.delete(timer); run(); }, ms);
    timers.add(timer);
    return timer;
  };
  let settle: (outcome: { email: StoredEmail } | { error: Error }) => void = () => {};

  const cleanup = () => settle({ error: new Error('The wait was cleaned up before an email arrived') });

  const emailPromise = new Promise<StoredEmail>((resolve, reject) => {
    // What the socket went through, for the timeout's message: a wait that never held a socket
    // open says so, where it would otherwise blame the mail.
    let drops = 0;
    let lastTrouble: string | undefined;
    let failuresInARow = 0;

    settle = (outcome) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { ws?.close(); } catch { /* ignore */ }
      if ('email' in outcome) resolve(outcome.email); else reject(outcome.error);
    };

    later(() => settle({
      error: new Error(`No email received within ${timeout}ms; ${describeDelivery(deliveryEvents)}`
        + (lastTrouble !== undefined ? `; the socket to the email-test Worker was reopened ${drops} time(s), last after: ${lastTrouble}` : '')),
    }), timeout);

    const reconnect = (trouble: string): void => {
      if (settled) return;
      drops++;
      lastTrouble = trouble;
      later(() => { void connect(); }, RECONNECT_DELAYS_MS[Math.min(failuresInARow, RECONNECT_DELAYS_MS.length - 1)]);
      failuresInARow++;
    };

    const connect = async (): Promise<void> => {
      if (settled) return;
      let socket: WebSocket;
      try {
        socket = await transport.open(query + (to !== undefined ? '&events=1' : ''));
      } catch (e) {
        reconnect(e instanceof Error ? e.message : String(e));
        return;
      }
      if (settled) { try { socket.close(); } catch { /* ignore */ } return; }
      ws = socket;
      marks.wsOpenAt ??= Date.now();
      failuresInARow = 0;
      // Asked once the socket is open, so the elapsed time covers the connect itself, which is the
      // stretch a fast mail lands in.
      socket.send(JSON.stringify({ kind: 'replay', ms: Date.now() - startedAt } satisfies ReplayRequest));
      // A deployed Worker older than the replay ignores the request and sends nothing, which would
      // read as "no mail arrived before this socket opened". Its answer is what tells them apart.
      const noReplay = later(() => settle({
        error: new Error('The email-test Worker did not answer a replay request: deploy tooling/email-test'),
      }), REPLAY_ANSWER_MS);

      socket.addEventListener('message', (event) => {
        if (settled) return;
        const parsed = JSON.parse(event.data as string) as StoredEmail | DeliveryEventMessage | ReplayedMessage;
        if ('kind' in parsed && parsed.kind === 'replayed') {
          clearTimeout(noReplay);
          timers.delete(noReplay);
          return;
        }
        if (isDeliveryEventMessage(parsed)) {
          const delivery = parsed.event;
          if (to === undefined || delivery.recipient !== to.toLowerCase()) return;
          // A replay sends again what an earlier socket already heard.
          if (deliveryEvents.some((e) => e.type === delivery.type && e.emailId === delivery.emailId && e.occurredAt === delivery.occurredAt)) return;
          deliveryEvents.push(delivery);
          if (TERMINAL_DELIVERY_EVENTS.includes(delivery.type)) {
            settle({
              error: new Error(`Resend reported ${delivery.type} for ${delivery.recipient} at ${delivery.occurredAt}`
                + (delivery.reason ? `: ${delivery.reason}` : '')),
            });
          }
          return;
        }
        // Another test's email on the shared socket — keep waiting, don't
        // resolve with it and don't consume our timer.
        if (!matchesRecipient(parsed)) return;
        marks.receivedAt = Date.now();
        settle({ email: parsed });
      });

      socket.addEventListener('close', () => {
        clearTimeout(noReplay);
        timers.delete(noReplay);
        if (ws === socket) reconnect('the socket closed');
      });
    };

    void (async () => {
      // ⚠️ The clear does NOT protect this waiter, and reading it that way is how a caller talks
      // itself out of `to`. The DO pushes an email to open sockets ONLY as it arrives, and replays
      // to this waiter only what arrived since this call began. So a previous run's
      // mail can never resolve us however full the bucket is. What the clear actually does is
      // reset the STORED list the `/emails` HTTP endpoint reads — and it wipes a bucket shared
      // with every concurrent test, which is why supplying `to` skips it.
      //
      // ⇒ `to` is safe on ANY address, historied ones included. It does not make two waiters on the
      // SAME address independent, though — both match — so that needs a unique recipient, or one
      // waiter (verified 2026-09-25; the older wording here claimed the opposite and was believed).
      if (to === undefined) {
        try { await transport.clear(query); } catch { /* the wait does not depend on it */ }
      }
      // The instance filter persists via serializeAttachment on the DO side, so
      // concurrent subscribers each see only their own emails.
      await connect();
    })();
  });

  // An abandoned wait must not crash the process. If the caller fails for an
  // unrelated reason and calls cleanup() in a `finally`, this promise rejects
  // with nobody awaiting it — an unhandled rejection, which is fatal in Node and
  // masks the REAL error. Marking it handled here changes nothing for an actual
  // awaiter: the returned reference still rejects.
  emailPromise.catch(() => { /* see above — real awaiters still see the rejection */ });

  return { emailPromise, cleanup, marks, deliveryEvents };
}

function isDeliveryEventMessage(message: StoredEmail | DeliveryEventMessage | ReplayedMessage): message is DeliveryEventMessage {
  return 'kind' in message && message.kind === 'delivery-event';
}

/** The events after which no mail is coming: Resend gave up on the send. */
export const TERMINAL_DELIVERY_EVENTS: readonly string[] = ['email.bounced', 'email.failed', 'email.suppressed'];

/**
 * Which hop a missing email was lost at, from what Resend reported about it, for a waiter's timeout.
 * Nothing at all means the send never reached Resend, or the webhook is not registered; `delivered`
 * means Resend handed it off, so it was lost after that, in Cloudflare's routing or the email-test Worker.
 */
export function describeDelivery(events: readonly DeliveryEvent[]): string {
  if (events.length === 0) {
    return 'Resend reported nothing for this recipient: the send never reached Resend, or its webhook is not registered';
  }
  const last = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1)!;
  const reason = last.reason ? `: ${last.reason}` : '';
  switch (last.type) {
    case 'email.delivered':
      return `Resend delivered it at ${last.occurredAt}, so it was lost after delivery, in Cloudflare's routing or the email-test Worker`;
    case 'email.delivery_delayed':
      return `Resend reported delivery delayed at ${last.occurredAt}${reason}`;
    case 'email.sent':
      return `Resend accepted it at ${last.occurredAt} and reported nothing further`;
    default:
      return `Resend's last report was ${last.type} at ${last.occurredAt}${reason}`;
  }
}

/** Extract the magic-link URL from a parsed email's HTML. */
export function extractMagicLink(email: StoredEmail): string {
  const html = email.html;
  if (!html) {
    throw new Error('Email has no HTML content');
  }

  // `@lumenize/auth`'s links carry `one_time_token`; Nebula's carry `token`, every one of them —
  // invites included — opening the platform host's link page.
  const hrefMatch = html.match(/href="([^"]*magic-link[^"]*(?:one_time_token|[?&]token)=[^"]*)"/);
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

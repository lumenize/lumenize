/**
 * A waiter whose socket fails or drops opens another, and the Worker replays to it what arrived
 * since the wait began. Run against the real Durable Object: the bug this guards is mail landing
 * while no socket is open, which only the object's own stored list and push can show.
 */
import { describe, it, expect } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { createMimeMessage } from '../src/simple-mime-message';
import { waitForEmail, type EmailTestTransport } from '../src/client';
import type { EmailTestDO } from '../src/email-test-do';

const inbox = () => env.EMAIL_TEST_DO.getByName('email-inbox') as DurableObjectStub<EmailTestDO>;
const address = () => `rc-${crypto.randomUUID()}@lumenize-test.dev`;

async function deliver(to: string, subject: string): Promise<void> {
  const raw = createMimeMessage()
    .setSender({ addr: 'auth@lumenize.io' })
    .setRecipient(to)
    .setSubject(subject)
    .addMessage({ contentType: 'text/plain', data: 'hello' })
    .asRaw();
  await inbox().receiveEmail(new TextEncoder().encode(raw).buffer as ArrayBuffer);
}

/** Close every socket the inbox holds, as a deploy of the Worker or a network drop does. */
async function dropSockets(): Promise<void> {
  await runInDurableObject(inbox(), (_do, state) => {
    for (const ws of state.getWebSockets()) ws.close(1011, 'dropped by the test');
  });
}

/** Lets time pass on the Worker's clock, which moves only across I/O and timers. */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A transport onto the Worker under test. `before` runs ahead of each open with its number, from
 * 1, and may hold it back or fail it.
 */
function transportTo(before: (attempt: number, socket?: undefined) => Promise<void> | void = () => {}, deaf = false) {
  const opens: string[] = [];
  const sockets: WebSocket[] = [];
  const transport: EmailTestTransport = {
    open: async (query) => {
      opens.push(query);
      await before(opens.length);
      const res = await SELF.fetch(`https://email-test/ws${query}`, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket!;
      ws.accept();
      // A Worker deployed before the replay ignores what a socket sends, which `deaf` stands in for.
      if (deaf) ws.send = () => {};
      sockets.push(ws);
      return ws;
    },
    clear: async () => {},
  };
  return { transport, opens, sockets };
}

describe('a mail waiter whose socket drops', () => {
  it('opens another and is sent the mail that arrived while it had none', async () => {
    const to = address();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { transport, opens } = transportTo(async (attempt) => { if (attempt === 2) await held; });
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 4000 }, transport);
    try {
      await vi.waitFor(() => expect(waiter.marks.wsOpenAt).toBeDefined());
      await dropSockets();
      await vi.waitFor(() => expect(opens).toHaveLength(2));
      await deliver(to, 'arrived in the gap');
      release();
      expect((await waiter.emailPromise).subject).toBe('arrived in the gap');
    } finally {
      waiter.cleanup();
    }
  });

  it('hears mail stored before its first socket opened', async () => {
    const to = address();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { transport, opens } = transportTo(async () => { await held; });
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 4000 }, transport);
    try {
      await vi.waitFor(() => expect(opens).toHaveLength(1));
      await deliver(to, 'beat the socket');
      release();
      expect((await waiter.emailPromise).subject).toBe('beat the socket');
      expect(opens).toHaveLength(1);
    } finally {
      waiter.cleanup();
    }
  });

  it('goes on collecting what Resend reports after the mail has arrived, until it is cleaned up', async () => {
    const to = address();
    const { transport, sockets } = transportTo();
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 4000 }, transport);
    try {
      await vi.waitFor(() => expect(waiter.marks.wsOpenAt).toBeDefined());
      await deliver(to, 'the mail');
      await waiter.emailPromise;
      expect(sockets[0].readyState).toBe(WebSocket.OPEN);
      await inbox().receiveDeliveryEvent(`msg_${crypto.randomUUID()}`, {
        type: 'email.delivered', created_at: new Date().toISOString(),
        data: { email_id: 'send-1', to: [to], subject: 'the mail' },
      });
      await vi.waitFor(() => expect(waiter.deliveryEvents.map((e) => e.emailId)).toEqual(['send-1']));
    } finally {
      waiter.cleanup();
    }
    // The socket a resolved wait kept is the one a leaked waiter would hang the process on.
    expect(sockets[0].readyState).not.toBe(WebSocket.OPEN);
  });

  it('retries a first socket that fails to open, and still hears mail sent before one did', async () => {
    const to = address();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { transport, opens } = transportTo(async (attempt) => {
      if (attempt === 1) throw new Error('WebSocket connection timeout');
      await held;
    });
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 4000 }, transport);
    try {
      await vi.waitFor(() => expect(opens).toHaveLength(2));
      await deliver(to, 'sent before any socket opened');
      release();
      expect((await waiter.emailPromise).subject).toBe('sent before any socket opened');
    } finally {
      waiter.cleanup();
    }
  });

  it('is not sent mail that arrived before the wait began', async () => {
    const to = address();
    await deliver(to, 'an earlier login');
    await pause(50);
    const { transport, opens } = transportTo();
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 4000 }, transport);
    try {
      await vi.waitFor(() => expect(waiter.marks.wsOpenAt).toBeDefined());
      await dropSockets();
      await vi.waitFor(() => expect(opens).toHaveLength(2));
      // Long enough for a replay of the earlier mail to have resolved the wait, were one sent.
      await pause(200);
      await deliver(to, 'this login');
      expect((await waiter.emailPromise).subject).toBe('this login');
    } finally {
      waiter.cleanup();
    }
  });

  it('says so when the Worker does not answer a replay request', { timeout: 10_000 }, async () => {
    const to = address();
    const { transport, opens } = transportTo(undefined, true);
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to, timeout: 9000 }, transport);
    try {
      await expect(waiter.emailPromise).rejects.toThrow('did not answer a replay request');
      expect(opens).toHaveLength(1);
    } finally {
      waiter.cleanup();
    }
  });

  it('stops opening sockets once it is cleaned up', async () => {
    const { transport, opens } = transportTo(() => { throw new Error('refused'); });
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to: address(), timeout: 4000 }, transport);
    await vi.waitFor(() => expect(opens.length).toBeGreaterThanOrEqual(2));
    waiter.cleanup();
    await expect(waiter.emailPromise).rejects.toThrow('cleaned up');
    const after = opens.length;
    await pause(600);
    expect(opens).toHaveLength(after);
  });

  it('leaves no timer pending once it is cleaned up', async () => {
    // A pending timer keeps a Node process alive after its verdict prints, which is the hang
    // `cleanup()` exists to prevent. Faked timers make the count readable; nothing here does I/O.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { transport, opens } = transportTo(() => { throw new Error('refused'); });
      const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to: address(), timeout: 4000 }, transport);
      for (let i = 0; i < 10 && opens.length === 0; i++) await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(2); // the wait's own timeout, and the reconnect's delay
      waiter.cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the socket in its timeout when none ever opened', async () => {
    const { transport } = transportTo(() => { throw new Error('WebSocket connection timeout'); });
    const waiter = waitForEmail({ testToken: env.TEST_TOKEN, to: address(), timeout: 700 }, transport);
    try {
      await expect(waiter.emailPromise).rejects.toThrow(
        /No email received within 700ms; .*reopened \d+ time\(s\), last after: WebSocket connection timeout/,
      );
    } finally {
      waiter.cleanup();
    }
  });
});

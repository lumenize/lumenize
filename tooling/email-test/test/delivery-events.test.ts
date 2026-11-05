/**
 * Resend's delivery events: the webhook route, what the Durable Object keeps and pushes, the move of
 * mail stored the old way, and the words a waiter's timeout uses.
 */
import { describe, it, expect } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { createMimeMessage } from '../src/simple-mime-message';
import { describeDelivery } from '../src/client';
import type { EmailTestDO, DeliveryEvent, ResendWebhookPayload, StoredEmail } from '../src/email-test-do';

/** Signed the way Svix documents, written out here rather than by the code under test. */
async function signedDelivery(payload: ResendWebhookPayload, id = `msg_${crypto.randomUUID()}`, secret = (env as Env & { RESEND_WEBHOOK_SECRET: string }).RESEND_WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = atob(secret.slice('whsec_'.length));
  const key = await crypto.subtle.importKey(
    'raw', Uint8Array.from(raw, (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const signature = btoa(String.fromCharCode(...mac));
  return new Request('https://email-test/resend-webhook', {
    method: 'POST', body,
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}`, 'content-type': 'application/json' },
  });
}

const event = (type: string, to: string[], extra: Partial<ResendWebhookPayload['data']> = {}): ResendWebhookPayload => ({
  type, created_at: new Date().toISOString(),
  data: { email_id: crypto.randomUUID(), to, subject: 'Your login link', ...extra },
});

/** An open socket on the Worker's own inbox, and the messages it receives. */
async function socket(query: string) {
  const res = await SELF.fetch(`https://email-test/ws?token=${env.TEST_TOKEN}${query}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket!;
  ws.accept();
  const received: unknown[] = [];
  ws.addEventListener('message', (e) => received.push(JSON.parse(e.data as string)));
  return { ws, received };
}

describe('the Resend webhook route', () => {
  it('stores and pushes a signed delivery, and refuses one whose signature does not match', async () => {
    const to = `wh-${crypto.randomUUID()}@lumenize-test.dev`;
    const res = await SELF.fetch(await signedDelivery(event('email.delivered', [to])));
    expect(res.status).toBe(200);
    const listed = await (await SELF.fetch(`https://email-test/events?token=${env.TEST_TOKEN}&to=${encodeURIComponent(to)}`)).json() as DeliveryEvent[];
    expect(listed.map((e) => e.type)).toEqual(['email.delivered']);

    const forged = await signedDelivery(event('email.delivered', [to]), undefined, 'whsec_' + btoa('someone else'));
    expect((await SELF.fetch(forged)).status).toBe(401);
  });

  it('keeps /events behind the test token', async () => {
    expect((await SELF.fetch('https://email-test/events?token=wrong&to=x@lumenize-test.dev')).status).toBe(401);
  });
});

describe('EmailTestDO delivery events', () => {
  it('keeps events only for recipients whose mail this Worker receives', async () => {
    const stub = env.EMAIL_TEST_DO.getByName('events-domains-1');
    const test = `d-${crypto.randomUUID()}@lumenize-test.dev`;
    const person = `someone-${crypto.randomUUID()}@example.com`;
    const fresh = await stub.receiveDeliveryEvent('msg_1', event('email.delivered', [test, person]));
    expect(fresh.map((e) => e.recipient)).toEqual([test]);
    expect(await stub.getDeliveryEvents(person)).toEqual([]);
  });

  it('stores a retried delivery once, and records a bounce with its reason', async () => {
    const stub = env.EMAIL_TEST_DO.getByName('events-dedupe-1');
    const to = `b-${crypto.randomUUID()}@lumenize-test.dev`;
    const bounced = event('email.bounced', [to], { bounce: { message: 'Mailbox does not exist', type: 'Permanent' } });
    expect(await stub.receiveDeliveryEvent('msg_retried', bounced)).toHaveLength(1);
    expect(await stub.receiveDeliveryEvent('msg_retried', bounced)).toHaveLength(0);
    const [stored] = await stub.getDeliveryEvents(to);
    expect(stored).toMatchObject({ type: 'email.bounced', recipient: to, reason: 'Mailbox does not exist' });
    expect(await stub.getDeliveryEvents(to)).toHaveLength(1);
  });

  it('pushes an event only to a socket that asked for events, so an older client sees mail alone', async () => {
    const to = `p-${crypto.randomUUID()}@lumenize-test.dev`;
    const asked = await socket('&events=1');
    const older = await socket('');
    await SELF.fetch(await signedDelivery(event('email.delivered', [to])));
    // Then mail, so the older socket's FIRST message says whether the event reached it before.
    const mime = createMimeMessage().setSender({ addr: 'auth@lumenize.io' }).setRecipient(to).setSubject('after the event')
      .addMessage({ contentType: 'text/plain', data: 'x' });
    await env.EMAIL_TEST_DO.getByName('email-inbox').receiveEmail(new TextEncoder().encode(mime.asRaw()).buffer);
    await vi.waitFor(() => expect(older.received.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(asked.received.length).toBe(2));
    expect((older.received[0] as StoredEmail).subject).toBe('after the event');
    expect(asked.received[0]).toMatchObject({ kind: 'delivery-event', event: { type: 'email.delivered', recipient: to } });
    asked.ws.close();
    older.ws.close();
  });
});

describe('mail stored the old way', () => {
  it('moves each instance\'s KV array into rows, in order, drops what is past retention, and deletes the arrays', async () => {
    const stub = env.EMAIL_TEST_DO.getByName('migrate-1');
    const mail = (subject: string, receivedAt: string): StoredEmail => ({
      from: { address: 'auth@lumenize.io', name: '' }, to: [{ address: 'm@lumenize-test.dev', name: '' }], subject,
      html: undefined, text: 'x', messageId: subject, date: receivedAt, receivedAt, instance: '',
    } as StoredEmail);
    const now = new Date().toISOString();
    await runInDurableObject(stub, (instance: EmailTestDO, state) => {
      state.storage.kv.put('emails:acme', [mail('acme 1', now), mail('acme 2', now)]);
      state.storage.kv.put('emails:<none>', [mail('ancient', '2020-01-01T00:00:00.000Z'), mail('untagged', now)]);
    });
    expect(await stub.migrateLegacyBuckets()).toBe(3);
    expect((await stub.getEmails('acme')).map((e) => e.subject)).toEqual(['acme 1', 'acme 2']);
    expect((await stub.getEmails('')).map((e) => e.subject)).toEqual(['untagged']);
    expect(await stub.migrateLegacyBuckets()).toBe(0);
  });

  it('keeps an instance\'s mail apart from another\'s', async () => {
    const stub = env.EMAIL_TEST_DO.getByName('instances-1');
    for (const [instance, subject] of [['acme', 'for acme'], ['zeta', 'for zeta']]) {
      const mime = createMimeMessage().setSender({ addr: 'auth@lumenize.io' }).setRecipient('i@lumenize-test.dev')
        .setSubject(subject).addMessage({ contentType: 'text/plain', data: 'x' });
      const raw = mime.asRaw().replace('Subject:', `X-Lumenize-Auth-Instance: ${instance}\r\nSubject:`);
      await stub.receiveEmail(new TextEncoder().encode(raw).buffer);
    }
    expect((await stub.getEmails('acme')).map((e) => e.subject)).toEqual(['for acme']);
    await stub.clearEmails('acme');
    expect((await stub.getEmails()).map((e) => e.subject)).toEqual(['for zeta']);
  });
});

describe('describeDelivery', () => {
  const at = (type: string, occurredAt: string, reason?: string): DeliveryEvent =>
    ({ type, recipient: 'r@lumenize-test.dev', emailId: 'e', occurredAt, receivedAt: occurredAt, ...(reason ? { reason } : {}) });

  it('names each hop from the last thing Resend reported', () => {
    expect(describeDelivery([])).toMatch(/never reached Resend, or its webhook is not registered/);
    expect(describeDelivery([at('email.sent', '2026-10-08T10:00:00.000Z')])).toMatch(/accepted it .* reported nothing further/);
    expect(describeDelivery([at('email.delivered', '2026-10-08T10:00:02.000Z'), at('email.sent', '2026-10-08T10:00:00.000Z')]))
      .toMatch(/lost after delivery, in Cloudflare's routing or the email-test Worker/);
    expect(describeDelivery([at('email.delivery_delayed', '2026-10-08T10:00:05.000Z', 'Mailbox full')]))
      .toMatch(/delayed at .*: Mailbox full/);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { CloudflareEmailTransport, ResendEmailTransport, type ResolvedEmail } from '../src';

const resolved: ResolvedEmail = {
  to: 'to@example.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  from: 'from@example.com',
  replyTo: 'noreply@example.com',
  appName: 'TestApp',
  headers: { 'X-Custom': 'v1' },
};

describe('CloudflareEmailTransport.sendEmail — field remap', () => {
  it('builds the Cloudflare message shape via an injected fake EMAIL binding', async () => {
    let captured: any;
    const env = { EMAIL: { send: async (m: any) => { captured = m; } } };
    await new CloudflareEmailTransport(env).sendEmail(resolved);
    // Discriminators (mutating the remap flips these): `from` is an OBJECT
    // {email,name} and the reply key is camelCase `replyTo`.
    expect(captured.from).toEqual({ email: 'from@example.com', name: 'TestApp' });
    expect(captured.replyTo).toBe('noreply@example.com');
    expect(captured.reply_to).toBeUndefined();
    expect(captured.headers).toEqual({ 'X-Custom': 'v1' });
    // pass-throughs (prove nothing on their own, included for completeness)
    expect(captured.to).toBe('to@example.com');
    expect(captured.subject).toBe('Hello');
    expect(captured.html).toBe('<p>hi</p>');
  });

  it('throws when the EMAIL binding is absent', async () => {
    await expect(new CloudflareEmailTransport({}).sendEmail(resolved)).rejects.toThrow(/EMAIL binding/);
  });
});

describe('ResendEmailTransport.sendEmail — field remap', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('builds the Resend JSON body via a mocked fetch', async () => {
    let body: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await new ResendEmailTransport({ RESEND_API_KEY: 'rk' }).sendEmail(resolved);
    // Discriminators: `from` is a STRING "appName <from>" and the reply key is
    // snake_case `reply_to`.
    expect(typeof body.from).toBe('string');
    expect(body.from).toBe('TestApp <from@example.com>');
    expect(body.reply_to).toBe('noreply@example.com');
    expect(body.replyTo).toBeUndefined();
    expect(body.headers).toEqual({ 'X-Custom': 'v1' });
    expect(body.to).toBe('to@example.com');
  });

  it('throws when RESEND_API_KEY is absent', async () => {
    await expect(new ResendEmailTransport({}).sendEmail(resolved)).rejects.toThrow(/RESEND_API_KEY/);
  });

  it('throws on a non-ok Resend response', async () => {
    globalThis.fetch = (async () => new Response('rejected', { status: 422 })) as typeof fetch;
    await expect(new ResendEmailTransport({ RESEND_API_KEY: 'rk' }).sendEmail(resolved)).rejects.toThrow(/Resend API error: 422/);
  });
});

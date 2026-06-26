import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import {
  createEmailTransport,
  CloudflareEmailTransport,
  ResendEmailTransport,
} from '../src';

// Discriminator present ONLY on the fall-through warn message.
const FALLBACK_DISCRIMINATOR = 'defaulting to Resend';

const fakeBinding = { send: async () => {} };

describe('createEmailTransport — provider selection precedence (mutation-checked per branch)', () => {
  let entries: DebugLogOutput[];
  beforeEach(() => {
    entries = [];
    setDebugSink((e) => entries.push(e));
  });
  afterEach(() => clearDebugSink());

  const fallbackWarns = () =>
    entries.filter(
      (e) =>
        e.namespace === 'email.createEmailTransport' &&
        e.level === 'warn' &&
        e.message.includes(FALLBACK_DISCRIMINATOR),
    );

  // Each branch of the precedence, with its expected transport AND warn count.
  // The warn assertion is two-directional (testing.md): the fall-through branch
  // emits EXACTLY ONE (red if the warn is removed); every other branch emits
  // ZERO (red if the warn fires on the wrong path). So the discriminator is
  // genuinely capable of failing, not a vacuous positive.
  it.each([
    { name: 'explicit provider:cloudflare', env: { EMAIL: fakeBinding }, opts: { provider: 'cloudflare' as const }, ctor: CloudflareEmailTransport, warns: 0 },
    { name: 'explicit provider:resend', env: { RESEND_API_KEY: 'rk' }, opts: { provider: 'resend' as const }, ctor: ResendEmailTransport, warns: 0 },
    { name: 'EMAIL_PROVIDER beats EMAIL-binding presence', env: { EMAIL: fakeBinding, RESEND_API_KEY: 'rk', EMAIL_PROVIDER: 'resend' }, opts: {}, ctor: ResendEmailTransport, warns: 0 },
    { name: 'auto-detect: EMAIL present -> Cloudflare', env: { EMAIL: fakeBinding }, opts: {}, ctor: CloudflareEmailTransport, warns: 0 },
    { name: 'auto-detect: EMAIL absent -> Resend + warn', env: { RESEND_API_KEY: 'rk' }, opts: {}, ctor: ResendEmailTransport, warns: 1 },
  ])('$name', ({ env, opts, ctor, warns }) => {
    const transport = createEmailTransport(env, opts);
    expect(transport).toBeInstanceOf(ctor);
    expect(fallbackWarns().length).toBe(warns);
  });

  it("throws when 'cloudflare' is explicit but the EMAIL binding is absent", () => {
    expect(() => createEmailTransport({ RESEND_API_KEY: 'rk' }, { provider: 'cloudflare' })).toThrow(/EMAIL binding/);
  });

  it("throws when 'resend' is explicit but RESEND_API_KEY is absent", () => {
    expect(() => createEmailTransport({ EMAIL: fakeBinding }, { provider: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it("throws when EMAIL_PROVIDER names an unknown provider", () => {
    expect(() => createEmailTransport({ EMAIL_PROVIDER: 'sendgrid' })).toThrow(/unknown EMAIL_PROVIDER/);
  });
});

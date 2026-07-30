/**
 * NebulaEmailSender — the `X-Lumenize-Auth-Instance` routing tag it stamps on the two mails Nebula
 * sends (magic-link and invite). Real delivery is covered by the e2e-email suites and the `/live`
 * harness; what's left here is a pure URL→header parse, so it needs no running system. A
 * `WorkerEntrypoint` subclass constructs fine under pool-workers, so a plain `new` + a stub `ctx`
 * exercises the pure methods.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { NebulaEmailSender } from '../src/nebula-email-sender';

function sender(): NebulaEmailSender {
  // The header hooks + the from/appName getters don't touch `ctx`, so a minimal stub suffices.
  return new NebulaEmailSender({} as any, env as any);
}

describe('NebulaEmailSender.magicLinkHeaders', () => {
  it('tags the originating instance from a well-formed magic-link URL', () => {
    const headers = sender().magicLinkHeaders({
      magicLinkUrl: 'http://localhost/auth/acme.app.tenant-a/magic-link?one_time_token=abc',
    });
    expect(headers).toEqual({ 'X-Lumenize-Auth-Instance': 'acme.app.tenant-a' });
  });

  it('falls back to {} when the URL does not match the Nebula magic-link shape', () => {
    expect(sender().magicLinkHeaders({ magicLinkUrl: 'http://localhost/somewhere/else' })).toEqual({});
  });

  it('resolves a non-empty from-address (env AUTH_EMAIL_FROM or the verified default) + Nebula appName', () => {
    expect(sender().from.length).toBeGreaterThan(0);
    expect(sender().appName).toBe('Nebula');
  });
});

describe('NebulaEmailSender.inviteNewHeaders', () => {
  // Without this the invite lands in the email-test catch-all bucket and every
  // `waitForEmail({ instance })` on an invite dies on its 60s timeout. It cost a debugging cycle
  // once (2026-07-30, building the impersonation-lifecycle harness scenario) precisely because a
  // missing header is silent — nothing points back at the sender.
  it('tags the originating instance from a well-formed accept-invite URL', () => {
    const headers = sender().inviteNewHeaders({
      inviteUrl: 'http://localhost/auth/acme.app.tenant-a/accept-invite?invite_token=abc',
    });
    expect(headers).toEqual({ 'X-Lumenize-Auth-Instance': 'acme.app.tenant-a' });
  });

  it('falls back to {} when the URL does not match the Nebula accept-invite shape', () => {
    expect(sender().inviteNewHeaders({ inviteUrl: 'http://localhost/somewhere/else' })).toEqual({});
  });
});

describe('instance parsing — the false-match guards', () => {
  // The route set is the discriminator. A two-segment path under `/auth` that ISN'T an
  // instance-bearing route must not have its first segment read as an instance — otherwise
  // e.g. `/auth/<scope>/invite` (the admin endpoint) would tag mail with `<scope>` by accident
  // on any future hook that forwards the wrong URL.
  it('rejects a path under /auth whose route carries no instance', () => {
    expect(sender().magicLinkHeaders({ magicLinkUrl: 'http://localhost/auth/acme.app/invite' })).toEqual({});
  });

  it('rejects a route nested deeper than /auth/{instance}/{route}', () => {
    expect(sender().inviteNewHeaders({
      inviteUrl: 'http://localhost/auth/acme.app/accept-invite/extra?invite_token=abc',
    })).toEqual({});
  });

  it('rejects an instance-looking segment outside the /auth prefix', () => {
    expect(sender().magicLinkHeaders({
      magicLinkUrl: 'http://localhost/elsewhere/auth/acme.app/magic-link?one_time_token=abc',
    })).toEqual({});
  });

  it('returns {} rather than throwing on an unparseable URL', () => {
    expect(sender().magicLinkHeaders({ magicLinkUrl: 'not-a-url' })).toEqual({});
  });
});

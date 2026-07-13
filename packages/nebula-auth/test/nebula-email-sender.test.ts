/**
 * NebulaEmailSender — the `X-Lumenize-Auth-Instance` routing tag it stamps on magic-link emails
 * (unit-level; real delivery is covered by the e2e-email suites). A `WorkerEntrypoint` subclass
 * constructs fine under pool-workers, so a plain `new` + a stub `ctx` exercises the pure methods.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { NebulaEmailSender } from '../src/nebula-email-sender';

function sender(): NebulaEmailSender {
  // magicLinkHeaders + the from/appName getters don't touch `ctx`, so a minimal stub suffices.
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

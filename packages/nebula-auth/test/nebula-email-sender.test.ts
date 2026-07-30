/**
 * NebulaEmailSender — the `X-Lumenize-Auth-Instance` routing tag it stamps on outbound mail.
 *
 * Driven through the real `send()` rather than by calling the hook directly, because the bug this
 * covers lived in the WIRING, not the parse: the base used to resolve headers inside its per-type
 * `switch`, so a type whose hook nobody overrode shipped untagged. Asserting on what `send()` hands
 * the transport is what makes "every variant is tagged from its URL" checkable at all.
 *
 * Real delivery is covered by the e2e-email suites and the `/live` harness; what's left here is a
 * pure message→headers derivation, so it needs no running system. A `WorkerEntrypoint` subclass
 * constructs fine under pool-workers, so a plain `new` + a stub `ctx` suffices.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { EmailMessage } from '@lumenize/auth';
import { NebulaEmailSender } from '../src/nebula-email-sender';

/** Captures what `send()` resolved instead of handing it to a transport. */
class CapturingSender extends NebulaEmailSender {
  sent: any[] = [];
  override async sendEmail(email: any): Promise<void> {
    this.sent.push(email);
  }
}

/** The headers `send()` actually attaches for `message` — the full production resolve path. */
async function headersFor(message: EmailMessage): Promise<Record<string, string>> {
  const sender = new CapturingSender({} as any, env as any);
  await sender.send(message);
  expect(sender.sent).toHaveLength(1);
  return sender.sent[0].headers;
}

const TAG = { 'X-Lumenize-Auth-Instance': 'acme.app.tenant-a' };

describe('the instance tag is derived from the URL, for every message variant', () => {
  it('tags a magic-link', async () => {
    expect(await headersFor({
      type: 'magic-link',
      to: 'a@lumenize.io',
      magicLinkUrl: 'http://localhost/auth/acme.app.tenant-a/magic-link?one_time_token=abc',
    })).toEqual(TAG);
  });

  // The shipped bug: this variant went out untagged, so `waitForEmail({ instance })` on an invite
  // silently never matched and died on its 60s timeout (cost a debugging cycle, 2026-07-30).
  it('tags an invite-new', async () => {
    expect(await headersFor({
      type: 'invite-new',
      to: 'a@lumenize.io',
      inviteUrl: 'http://localhost/auth/acme.app.tenant-a/accept-invite?invite_token=abc',
    })).toEqual(TAG);
  });

  // ⚠️ THE TOTALITY CLAIM, and the reason there is no per-type decision to get wrong. Nothing in
  // the sender mentions `invite-existing` or the field name `redirectUrl` — the tag falls out of
  // the URL alone. If this ever reds, the enumeration has crept back in.
  it('tags a variant the sender never mentions, when its URL carries an instance', async () => {
    expect(await headersFor({
      type: 'invite-existing',
      to: 'a@lumenize.io',
      redirectUrl: 'http://localhost/auth/acme.app.tenant-a/magic-link?one_time_token=abc',
    })).toEqual(TAG);
  });

  // The other side of the same rule: no instance in the URL, so nothing to tag. These three are
  // what Nebula would emit today if it sent them at all — it doesn't (only `@lumenize/auth`'s own
  // DO does), which is exactly why NOT deciding per type is what keeps that fact from mattering.
  it.each([
    ['invite-existing', { type: 'invite-existing', to: 'a@lumenize.io', redirectUrl: 'http://localhost/app' }],
    ['approval-confirmation', { type: 'approval-confirmation', to: 'a@lumenize.io', redirectUrl: 'http://localhost/app' }],
    ['admin-notification', {
      type: 'admin-notification', to: 'a@lumenize.io', subjectEmail: 'b@lumenize.io',
      approveUrl: 'http://localhost/auth/approve/sub-123',
    }],
  ] as const)('leaves %s untagged when its URL carries no instance', async (_label, message) => {
    expect(await headersFor(message as EmailMessage)).toEqual({});
  });
});

describe('false-match guards', () => {
  const magicLink = (url: string): EmailMessage =>
    ({ type: 'magic-link', to: 'a@lumenize.io', magicLinkUrl: url });

  // The route set is the discriminator. A two-segment path under `/auth` that ISN'T an
  // instance-bearing route must not have its first segment read as an instance — otherwise
  // `/auth/{scope}/invite` (the admin endpoint) would tag mail with `{scope}` by accident.
  it('rejects a path under /auth whose route carries no instance', async () => {
    expect(await headersFor(magicLink('http://localhost/auth/acme.app/invite'))).toEqual({});
  });

  it('rejects a route nested deeper than /auth/{instance}/{route}', async () => {
    expect(await headersFor(magicLink('http://localhost/auth/acme.app/magic-link/extra?t=abc'))).toEqual({});
  });

  it('rejects an instance-looking segment outside the /auth prefix', async () => {
    expect(await headersFor(magicLink('http://localhost/elsewhere/auth/acme.app/magic-link?t=abc'))).toEqual({});
  });

  // Scanning every string field means the parse is handed `type`, `to`, `subjectEmail` and any
  // future non-URL field. It must return {} rather than throw on all of them.
  it('returns {} rather than throwing on a field that is not a URL', async () => {
    expect(await headersFor(magicLink('not-a-url'))).toEqual({});
  });
});

describe('NebulaEmailSender identity', () => {
  it('resolves a non-empty from-address (env AUTH_EMAIL_FROM or the verified default) + Nebula appName', () => {
    const sender = new NebulaEmailSender({} as any, env as any);
    expect(sender.from.length).toBeGreaterThan(0);
    expect(sender.appName).toBe('Nebula');
  });
});

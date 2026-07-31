/**
 * NebulaEmailSender — the `X-Lumenize-Auth-Instance` routing tag it stamps on outbound mail.
 *
 * Driven through the real `send()` rather than by calling the hook directly, because the bug this
 * covers lived in the WIRING, not the derivation: headers used to be resolved inside a per-type
 * `switch`, so a type whose hook nobody overrode shipped untagged. Asserting on what `send()` hands
 * the transport is what makes "every variant is tagged" checkable at all.
 *
 * ⚠️ **Rewritten 2026-07-31 — the sender is now TOLD the instance, not asked to infer one.** It
 * previously re-parsed the instance out of whichever URL the message carried; `EmailMessage`
 * now requires `instanceName` and `headers()` stamps it directly. The old file's "false-match
 * guards" (a path under `/auth` with a non-instance-bearing route, a too-deep path, a non-URL
 * string) are **deleted, not ported**: there is no parse left to fool, so they would have been
 * green prose describing a mechanism that no longer exists.
 *
 * Tier: this is a pure message→headers derivation with no env, network or server, so it needs no
 * running system. That the tag's VALUE actually survives to a delivered email is asserted over the
 * real path in `harness/scenarios/impersonation-lifecycle.ts`.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { EmailMessage } from '../src/types';
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

const SCOPE = 'acme.app.tenant-a';
const TAG = { 'X-Lumenize-Auth-Instance': SCOPE };

describe('the instance tag is stamped from the field, for every message variant', () => {
  // ⚠️ ALL FIVE variants, including the three Nebula does not emit today. That totality is the
  // point: `instanceName` is required, so no variant can be missed and no per-type decision
  // exists to get wrong. If a new variant is ever added without a tag, it will not compile.
  it.each([
    ['magic-link', { type: 'magic-link', to: 'a@lumenize.io', instanceName: SCOPE,
      magicLinkUrl: `http://localhost/auth/${SCOPE}/magic-link?one_time_token=abc` }],
    ['invite-new', { type: 'invite-new', to: 'a@lumenize.io', instanceName: SCOPE,
      inviteUrl: `http://localhost/auth/${SCOPE}/accept-invite?invite_token=abc` }],
    // ⚠️ THE CASE THE CHANGE EXISTS FOR. Its URL (`/app`) carries no instance segment, so under
    // URL derivation this shipped UNTAGGED even though its instance was known — and
    // `invite-existing` is exactly that shape and a variant wanted soon. The failure was silent:
    // an untagged mail lands in the email-test catch-all bucket, so `waitForEmail({ instance })`
    // never matches and the caller dies on a 60s timeout with nothing pointing at the sender.
    ['invite-existing', { type: 'invite-existing', to: 'a@lumenize.io', instanceName: SCOPE,
      redirectUrl: 'http://localhost/app' }],
    ['approval-confirmation', { type: 'approval-confirmation', to: 'a@lumenize.io', instanceName: SCOPE,
      redirectUrl: 'http://localhost/app' }],
    ['admin-notification', { type: 'admin-notification', to: 'a@lumenize.io', instanceName: SCOPE,
      subjectEmail: 'b@lumenize.io', approveUrl: 'http://localhost/auth/approve/sub-123' }],
  ] as const)('tags %s', async (_label, message) => {
    expect(await headersFor(message as EmailMessage)).toEqual(TAG);
  });
});

describe('the correctness gap this closed', () => {
  // (The "URL carries no instance segment" case is the `invite-existing` row in the table above —
  // asserting it twice would add prose, not coverage.)

  // A newly-possible failure class, and therefore worth pinning: URL derivation could not disagree
  // with the URL, but a caller-supplied field can. The field wins — the URL is not consulted.
  it('follows the FIELD, not the URL, when the two disagree', async () => {
    expect(await headersFor({
      type: 'magic-link',
      to: 'a@lumenize.io',
      instanceName: SCOPE,
      magicLinkUrl: 'http://localhost/auth/some.other.scope/magic-link?one_time_token=abc',
    })).toEqual(TAG);
  });
});

describe('NebulaEmailSender identity', () => {
  it('resolves a non-empty from-address (env AUTH_EMAIL_FROM or the verified default) + Nebula appName', () => {
    const sender = new NebulaEmailSender({} as any, env as any);
    expect(sender.from.length).toBeGreaterThan(0);
    expect(sender.appName).toBe('Nebula');
  });
});

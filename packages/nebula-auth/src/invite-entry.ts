/**
 * Invite ENTRY duties — everything that happens after `issueInvites` mints and before a caller sees
 * a summary. `issueInvites` is mint-only (a send awaited inside the singleton would hold its input
 * gates through external I/O, and `ctx.waitUntil` means nothing in a DO — durable-objects.md), so
 * the ENTRY that fronts it owns two jobs, and every entry shares these implementations:
 *
 *  - {@link summarizeInvites} — project the mint result to the caller-facing summary. The mint
 *    carries `inviteUrl` for the sender; the summary NEVER does — test mode's `links` is the only
 *    carrier of the URL past the entry.
 *  - {@link sendInviteEmails} — the ONE send helper. Dispatched post-return (`ctx.waitUntil` on a
 *    mesh entry; the interim HTTP route fires it un-awaited), so batch-vs-sequential and provider
 *    latency are invisible to every caller.
 *
 * **Template selection discriminates on ACCEPTANCE, not row-existence**: an accepted member gets
 * `invite-existing` (a redirect — they can already log in), while a pending, never-accepted invitee
 * gets `invite-new` again carrying the FRESH link the re-invite minted — the letter must deliver
 * it, or the invitee is stranded with a link-less letter and the recovery story is false.
 */
import { debug } from '@lumenize/debug';
import { landingBase } from './landing';
import type { EmailMessage, InviteMintResult, InviteSummary, InviteeMintResult } from './types';

/**
 * Project the mint result to the caller-facing {@link InviteSummary}. In test mode the raw invite
 * URLs ride `links` (keyed by normalized email), as today; in production nothing carries them.
 */
export function summarizeInvites(mint: InviteMintResult, testMode: boolean): InviteSummary {
  const summary: InviteSummary = {
    results: mint.results.map(({ email, sub, outcome }) => ({ email, sub, outcome })),
    errors: mint.errors,
  };
  if (testMode) {
    const links: Record<string, string> = {};
    for (const r of mint.results) links[r.email] = r.inviteUrl;
    summary.links = links;
  }
  return summary;
}

/**
 * Dispatch the invite mail for a mint result — the ONE send helper (every invite entry routes
 * here; the Registry DO never sends).
 *
 * **Never rejects.** Each invitee's send failure is caught and logged with identifiers only —
 * never the URL (critical.md) — so the returned promise is safe under `ctx.waitUntil` and can
 * never surface as an unhandled rejection. A send failure is post-return by design: `invited` is a
 * MINT outcome, and true delivery failure was always out-of-band.
 */
export async function sendInviteEmails(
  env: unknown,
  opts: { instanceName: string; origin: string; invitees: InviteeMintResult[] },
): Promise<void> {
  const sender = (env as { AUTH_EMAIL_SENDER?: { send(m: EmailMessage): Promise<void> } })
    .AUTH_EMAIL_SENDER;
  const log = debug('nebula-auth.invite.send');
  if (!sender) {
    log.debug('Invite email not sent (AUTH_EMAIL_SENDER not configured)', {
      instanceName: opts.instanceName, invitees: opts.invitees.length,
    });
    return;
  }
  await Promise.all(opts.invitees.map(async (invitee) => {
    try {
      await sender.send(buildInviteMessage(env as Env, opts.instanceName, opts.origin, invitee));
    } catch (error) {
      // Identifiers only — the email and scope, never the invite URL (critical.md).
      log.error('Invite email send failed', {
        email: invitee.email,
        instanceName: opts.instanceName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}

/** Template selection — by acceptance, never by row-existence (see the module header). */
function buildInviteMessage(
  env: Env, instanceName: string, origin: string, invitee: InviteeMintResult,
): EmailMessage {
  if (invitee.accepted) {
    // They can already log in — send them to the scope's landing page, same shape as the login
    // redirect (`consumeAndLogin`'s Location), made absolute for an email body.
    const redirectUrl = `${origin}${landingBase(env, instanceName)}/${encodeURIComponent(instanceName)}`;
    return { type: 'invite-existing', to: invitee.email, instanceName, redirectUrl };
  }
  return { type: 'invite-new', to: invitee.email, instanceName, inviteUrl: invitee.inviteUrl };
}

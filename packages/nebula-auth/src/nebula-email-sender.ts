/**
 * Nebula's email sender — templates, subjects, transport and routing headers in one class.
 *
 * ⚠️ **COPIED from `packages/auth/src/auth-email-sender-base.ts` on 2026-07-31, and this is a
 * DELIBERATE DIVERGENCE that must NOT be re-synced.** `@lumenize/nebula-auth` no longer depends on
 * `@lumenize/auth` at all (`tasks/archive/nebula-auth-decouple-from-auth.md`); the two are free to drift,
 * and Nebula-specific templates are the immediate reason — today this sends the generic MIT
 * templates with a name substituted in. A future session diffing this against the original and
 * "unifying" them would look diligent while silently restoring the coupling this file exists to
 * delete. Don't.
 *
 * **Collapsed on arrival**, not mirrored: upstream this was an abstract `AuthEmailSenderBase` plus
 * a thin `NebulaEmailSender` subclass. After the copy there is exactly ONE consumer, so the
 * base/subclass split had nothing left to abstract — and the originals stay live in
 * `packages/auth`, `mesh/test/**` and five website docs, where an identically-named copy would be
 * ambiguous at every call site.
 *
 * `ResolvedEmail` is imported from `@lumenize/email`, never copied: that package owns the type and
 * this sender feeds it straight to `EmailTransport.sendEmail`, so it is the one member of the copy
 * set that must stay in lockstep and therefore carries no free-to-diverge licence.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createEmailTransport, type ResolvedEmail } from '@lumenize/email';
import type { EmailMessage } from './types';

// ============================================
// Typed message variants for method signatures
// ============================================

type MagicLinkMessage = Extract<EmailMessage, { type: 'magic-link' }>;
type AdminNotificationMessage = Extract<EmailMessage, { type: 'admin-notification' }>;
type ApprovalConfirmationMessage = Extract<EmailMessage, { type: 'approval-confirmation' }>;
type InviteExistingMessage = Extract<EmailMessage, { type: 'invite-existing' }>;
type InviteNewMessage = Extract<EmailMessage, { type: 'invite-new' }>;

/**
 * Routing tag downstream Email Routing consumers bucket by — `tooling/email-test`'s
 * `EmailTestDO` files each received email under this header's value, which is what
 * `waitForEmail({ instance })` subscribes to.
 */
const INSTANCE_HEADER = 'X-Lumenize-Auth-Instance';

// ============================================
// Default templates (exported for composability)
// ============================================

export function nebulaMagicLinkHtml(message: MagicLinkMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>Sign in to ${appName}</h2>
<p>Click the link below to sign in. This link expires in 30 minutes.</p>
<p><a href="${message.magicLinkUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>
<p style="color:#666;font-size:14px">If you didn't request this link, you can safely ignore this email.</p>
</div>`;
}

export function nebulaAdminNotificationHtml(message: AdminNotificationMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>${appName} — New Signup</h2>
<p><strong>${message.subjectEmail}</strong> has signed up and is waiting for approval.</p>
<p><a href="${message.approveUrl}" style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px">Approve</a></p>
</div>`;
}

export function nebulaApprovalConfirmationHtml(message: ApprovalConfirmationMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>Welcome to ${appName}</h2>
<p>Your account has been approved. You can now sign in.</p>
<p><a href="${message.redirectUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Go to ${appName}</a></p>
</div>`;
}

export function nebulaInviteExistingHtml(message: InviteExistingMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>You've been invited to ${appName}</h2>
<p>You've been added to ${appName}. Come check it out!</p>
<p><a href="${message.redirectUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Go to ${appName}</a></p>
</div>`;
}

export function nebulaInviteNewHtml(message: InviteNewMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>You've been invited to ${appName}</h2>
<p>Click below to activate your account. This link expires in 7 days.</p>
<p><a href="${message.inviteUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Accept Invite</a></p>
</div>`;
}

/**
 * Nebula's auth email sender.
 *
 * Extends `WorkerEntrypoint` directly (not `LumenizeWorker`) so this package has no dependency on
 * `@lumenize/mesh`'s server surface. The registry DO reaches it via plain Workers RPC through the
 * `AUTH_EMAIL_SENDER` service binding.
 *
 * All five templates, subjects and `EmailMessage` variants were copied **verbatim** even though
 * Nebula emits only `magic-link` and `invite-new` today: at least one of the other three is wanted
 * soon, so this is not a YAGNI question.
 */
export class NebulaEmailSender extends WorkerEntrypoint {
  from: string;
  appName = 'Nebula';

  /** Reply-to address. Defaults to `no-reply@{domain from 'from'}`. */
  replyTo?: string;

  /**
   * The from-address is env-configurable via `AUTH_EMAIL_FROM`. Default is the
   * verified `noreply@lumenize.io` — a pre-alpha stopgap (`lumenize.io` is verified
   * on BOTH Cloudflare Email Sending and Resend, so mail actually sends; an
   * unverified from-domain is silently dropped by CF / rejected by Resend). The
   * brand-aligned target is `noreply@nebula.lumenize.com` (matches the app origin +
   * JWT issuer); it's now Resend-verified — the switch + its DMARC record are tracked
   * in `tasks/backlog.md` (§ Nebula email sender domain). A test harness / `wrangler
   * dev` lane overrides this to `test@lumenize.io` so the deployed email-test Worker
   * catches the round-trip. (`env` is `any` because it reads one optional var and must
   * not couple to any one consumer's generated `Env`.)
   */
  constructor(ctx: ExecutionContext, env: any) {
    super(ctx, env);
    this.from = env?.AUTH_EMAIL_FROM || 'noreply@lumenize.io';
  }

  /**
   * Dispatch an email message. Called by the registry DO via RPC.
   *
   * Resolves the template and subject, assembles a `ResolvedEmail`, and delegates to `sendEmail()`.
   */
  async send(message: EmailMessage): Promise<void> {
    const resolvedReplyTo = this.replyTo ?? `no-reply@${this.from.split('@')[1]}`;

    let subject: string;
    let html: string;

    switch (message.type) {
      case 'magic-link':
        subject = this.magicLinkSubject(message);
        html = this.magicLinkHtml(message);
        break;
      case 'admin-notification':
        subject = this.adminNotificationSubject(message);
        html = this.adminNotificationHtml(message);
        break;
      case 'approval-confirmation':
        subject = this.approvalConfirmationSubject(message);
        html = this.approvalConfirmationHtml(message);
        break;
      case 'invite-existing':
        subject = this.inviteExistingSubject(message);
        html = this.inviteExistingHtml(message);
        break;
      case 'invite-new':
        subject = this.inviteNewSubject(message);
        html = this.inviteNewHtml(message);
        break;
    }

    const resolved: ResolvedEmail = {
      to: message.to,
      subject,
      html,
      from: this.from,
      replyTo: resolvedReplyTo,
      appName: this.appName,
      // Outside the switch ON PURPOSE — see `headers()`. Every message type gets the same hook,
      // so a new type cannot silently ship untagged.
      headers: this.headers(message),
    };

    await this.sendEmail(resolved);
  }

  /**
   * Deliver the resolved email. The provider is selected from the environment by
   * `@lumenize/email`'s `createEmailTransport` (the `EMAIL` binding → Cloudflare;
   * `EMAIL_PROVIDER=resend` or no `EMAIL` binding → Resend).
   */
  async sendEmail(email: ResolvedEmail): Promise<void> {
    await createEmailTransport(this.env as object).sendEmail(email);
  }

  // ============================================
  // Templates
  // ============================================

  magicLinkHtml(message: MagicLinkMessage): string {
    return nebulaMagicLinkHtml(message, this.appName);
  }

  adminNotificationHtml(message: AdminNotificationMessage): string {
    return nebulaAdminNotificationHtml(message, this.appName);
  }

  approvalConfirmationHtml(message: ApprovalConfirmationMessage): string {
    return nebulaApprovalConfirmationHtml(message, this.appName);
  }

  inviteExistingHtml(message: InviteExistingMessage): string {
    return nebulaInviteExistingHtml(message, this.appName);
  }

  inviteNewHtml(message: InviteNewMessage): string {
    return nebulaInviteNewHtml(message, this.appName);
  }

  // ============================================
  // Subjects
  // ============================================

  magicLinkSubject(_message: MagicLinkMessage): string {
    return 'Your login link';
  }

  adminNotificationSubject(message: AdminNotificationMessage): string {
    return `New signup: ${message.subjectEmail}`;
  }

  approvalConfirmationSubject(_message: ApprovalConfirmationMessage): string {
    return 'Your account has been approved';
  }

  inviteExistingSubject(_message: InviteExistingMessage): string {
    return "You've been invited";
  }

  inviteNewSubject(_message: InviteNewMessage): string {
    return "You've been invited";
  }

  // ============================================
  // Routing headers
  // ============================================

  /**
   * Tag every outbound mail with the instance it is about, making the originating instance
   * addressable by downstream Email Routing consumers (test rigs, log filters) without parsing
   * the body.
   *
   * ⚠️ **The sender is TOLD the instance; it does not infer one.** `instanceName` is required on
   * every `EmailMessage` variant, so this is total by construction — no type is consulted, no
   * variant can be missed, and a new variant is covered without touching this file.
   *
   * This replaced re-parsing the instance back out of whichever URL the message carried. That
   * shape could only tag mail whose URL had an instance segment, so a message that IS about an
   * instance but links to `/app` shipped **untagged though its instance was known** —
   * `invite-existing` is exactly that case and is one of the variants wanted soon. The failure was
   * silent: an untagged mail lands in the email-test catch-all bucket, so `waitForEmail({ instance })`
   * never matches and the caller dies on its timeout with nothing pointing at the sender.
   */
  headers(message: EmailMessage): Record<string, string> {
    return { [INSTANCE_HEADER]: message.instanceName };
  }
}

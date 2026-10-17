import { WorkerEntrypoint } from 'cloudflare:workers';
import { createEmailTransport } from '@lumenize/email';
import type { EmailMessage, ResolvedEmail } from './types';

// ============================================
// Extract typed message variants for method signatures
// ============================================

type MagicLinkMessage = Extract<EmailMessage, { type: 'magic-link' }>;
type AdminNotificationMessage = Extract<EmailMessage, { type: 'admin-notification' }>;
type ApprovalConfirmationMessage = Extract<EmailMessage, { type: 'approval-confirmation' }>;
type InviteExistingMessage = Extract<EmailMessage, { type: 'invite-existing' }>;
type InviteNewMessage = Extract<EmailMessage, { type: 'invite-new' }>;

// ============================================
// Default template functions (exported for composability)
// ============================================

export function defaultMagicLinkHtml(message: MagicLinkMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>Sign in to ${appName}</h2>
<p>Click the link below to sign in. This link expires in 30 minutes.</p>
<p><a href="${message.magicLinkUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Sign in</a></p>
<p style="color:#666;font-size:14px">If you didn't request this link, you can safely ignore this email.</p>
</div>`;
}

export function defaultAdminNotificationHtml(message: AdminNotificationMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>${appName} — New Signup</h2>
<p><strong>${message.subjectEmail}</strong> has signed up and is waiting for approval.</p>
<p><a href="${message.approveUrl}" style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px">Approve</a></p>
</div>`;
}

export function defaultApprovalConfirmationHtml(message: ApprovalConfirmationMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>Welcome to ${appName}</h2>
<p>Your account has been approved. You can now sign in.</p>
<p><a href="${message.redirectUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Go to ${appName}</a></p>
</div>`;
}

export function defaultInviteExistingHtml(message: InviteExistingMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>You've been invited to ${appName}</h2>
<p>You've been added to ${appName}. Come check it out!</p>
<p><a href="${message.redirectUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Go to ${appName}</a></p>
</div>`;
}

export function defaultInviteNewHtml(message: InviteNewMessage, appName: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2>You've been invited to ${appName}</h2>
<p>Click below to activate your account. This link expires in 7 days.</p>
<p><a href="${message.inviteUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Accept Invite</a></p>
</div>`;
}

/**
 * Abstract base class for auth email senders.
 *
 * Extends `WorkerEntrypoint` directly (not `LumenizeWorker`) so `@lumenize/auth`
 * has no dependency on `@lumenize/mesh`. The Auth DO communicates with this entrypoint
 * via plain Workers RPC through the `AUTH_EMAIL_SENDER` service binding.
 *
 * Extend it and set `from`; the provider is chosen by the environment via
 * `@lumenize/email`'s `createEmailTransport` (the `EMAIL` binding → Cloudflare;
 * `EMAIL_PROVIDER=resend` or no `EMAIL` binding → Resend). Optionally override
 * `replyTo`, `appName`, any of the 5 template methods, any of the 5 subject
 * methods, or the single `headers` hook (one for all types — see its JSDoc).
 * Override `sendEmail` only to force a specific transport.
 *
 * @see https://lumenize.com/docs/auth/getting-started#email-provider — setup walkthrough
 * @see https://lumenize.com/docs/auth/configuration#email-provider — reference (class hierarchy, overridable methods)
 */
export abstract class AuthEmailSenderBase extends WorkerEntrypoint {
  /** Bare sender email address (e.g., `'auth@myapp.com'`). Required. */
  abstract from: string;

  /** Reply-to address. Defaults to `no-reply@{domain from 'from'}`. */
  replyTo?: string;

  /** App name used in default templates and provider display names. Defaults to `'Lumenize'`. */
  appName = 'Lumenize';

  /**
   * Dispatch an email message. Called by the LumenizeAuth DO via RPC.
   *
   * Resolves the template and subject via the overridable methods,
   * assembles a `ResolvedEmail`, and delegates to `sendEmail()`.
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
   * Deliver the resolved email. Composes a transport from `@lumenize/email` and
   * selects the provider from the environment (`EMAIL` binding → Cloudflare,
   * `EMAIL_PROVIDER` to force a provider, else Resend). Override only to force a
   * specific provider; most subclasses just set `from` and let the env decide.
   */
  async sendEmail(email: ResolvedEmail): Promise<void> {
    await createEmailTransport(this.env as object).sendEmail(email);
  }

  // ============================================
  // Overridable template methods (return HTML)
  // ============================================

  magicLinkHtml(message: MagicLinkMessage): string {
    return defaultMagicLinkHtml(message, this.appName);
  }

  adminNotificationHtml(message: AdminNotificationMessage): string {
    return defaultAdminNotificationHtml(message, this.appName);
  }

  approvalConfirmationHtml(message: ApprovalConfirmationMessage): string {
    return defaultApprovalConfirmationHtml(message, this.appName);
  }

  inviteExistingHtml(message: InviteExistingMessage): string {
    return defaultInviteExistingHtml(message, this.appName);
  }

  inviteNewHtml(message: InviteNewMessage): string {
    return defaultInviteNewHtml(message, this.appName);
  }

  // ============================================
  // Overridable subject methods (return string)
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
  // Overridable header hook (returns Record<string, string>)
  // ============================================

  /**
   * Provider-emitted email headers, for **every** message type (Cloudflare's
   * `binding.send({...})` accepts a `headers` field). Defaults to `{}` — no headers.
   *
   * Override to thread routing/correlation IDs, multi-tenant scope markers, A/B variant
   * labels, etc. Derive them from `message` rather than switching on `message.type`, so a
   * type you don't enumerate is still covered.
   *
   * ⚠️ **Deliberately ONE hook, not one per message type** — unlike the subject and template
   * hooks, which stay per-type because their *content* genuinely differs. Everything headers
   * carry is cross-cutting, so a per-type hook is an enumeration a subclass silently falls out
   * of, and the failure mode is invisible: the mail still sends, just untagged, and whatever
   * downstream consumer filters on the header waits until it times out. That shipped once —
   * `NebulaEmailSender` tagged magic-link and, months later, not invite.
   */
  headers(_message: EmailMessage): Record<string, string> {
    return {};
  }
}

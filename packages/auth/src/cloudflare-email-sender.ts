import { createEmailTransport } from '@lumenize/email';
import type { ResolvedEmail } from '@lumenize/email';
import { AuthEmailSenderBase } from './auth-email-sender-base';

/**
 * @deprecated **Transition shim** — being removed in the breaking migration to
 * the provider-by-env model. Extend {@link AuthEmailSenderBase} instead and let
 * the environment pick the provider (the `EMAIL` binding selects Cloudflare;
 * `EMAIL_PROVIDER=resend` or an absent `EMAIL` binding selects Resend).
 *
 * Kept temporarily so existing `extends CloudflareEmailSender` consumers compile;
 * forces the Cloudflare provider.
 */
export class CloudflareEmailSender extends AuthEmailSenderBase {
  from!: string;

  async sendEmail(email: ResolvedEmail): Promise<void> {
    await createEmailTransport(this.env as object, { provider: 'cloudflare' }).sendEmail(email);
  }
}

import { createEmailTransport } from '@lumenize/email';
import type { ResolvedEmail } from '@lumenize/email';
import { AuthEmailSenderBase } from './auth-email-sender-base';

/**
 * @deprecated **Transition shim** — being removed in the breaking migration to
 * the provider-by-env model. Extend {@link AuthEmailSenderBase} instead and set
 * `EMAIL_PROVIDER=resend` (or omit the `EMAIL` binding) to select Resend.
 *
 * Kept temporarily so existing `extends ResendEmailSender` consumers compile;
 * forces the Resend provider.
 */
export class ResendEmailSender extends AuthEmailSenderBase {
  from!: string;

  async sendEmail(email: ResolvedEmail): Promise<void> {
    await createEmailTransport(this.env as object, { provider: 'resend' }).sendEmail(email);
  }
}

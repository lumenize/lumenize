import { AuthEmailSenderBase } from './auth-email-sender-base';
import type { ResolvedEmail } from './types';

/**
 * Email sender that delivers via [Resend](https://resend.com) (`https://api.resend.com/emails`).
 *
 * Requires `RESEND_API_KEY` in the Worker's environment. Constructs the Resend
 * `from` field as `"${appName} <${from}>"` (e.g., `"My App <auth@myapp.com>"`).
 *
 * Extend this class, set `from`, and export from your Worker entry point.
 * For bring-your-own-provider, extend {@link AuthEmailSenderBase} instead.
 *
 * @see https://lumenize.com/docs/auth/getting-started#email-provider — setup walkthrough
 * @see https://lumenize.com/docs/auth/configuration#email-provider — reference (class hierarchy, overridable methods)
 */
export class ResendEmailSender extends AuthEmailSenderBase {
  // Subclass must set `from` — inherited abstract requirement
  from!: string;

  async sendEmail(email: ResolvedEmail): Promise<void> {
    const apiKey = (this.env as any).RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not set in environment');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `${email.appName} <${email.from}>`,
        to: email.to,
        subject: email.subject,
        html: email.html,
        reply_to: email.replyTo,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorText}`);
    }
  }
}

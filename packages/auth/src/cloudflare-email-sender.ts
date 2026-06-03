import { AuthEmailSenderBase } from './auth-email-sender-base';
import type { ResolvedEmail } from './types';

/**
 * Email sender that delivers via [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/).
 *
 * Uses the `EMAIL` Worker binding (`send_email` in wrangler.jsonc) — no API key needed.
 * Constructs the sender's display name as `"${appName} <${from}>"`.
 *
 * Requires the Workers Paid plan and a domain onboarded for Cloudflare Email Sending.
 *
 * Extend this class, set `from`, and export from your Worker entry point.
 * For bring-your-own-provider, extend {@link AuthEmailSenderBase} instead.
 *
 * @see https://lumenize.com/docs/auth/getting-started#email-provider — setup walkthrough
 * @see https://lumenize.com/docs/auth/configuration#email-provider — reference (class hierarchy, overridable methods)
 */
export class CloudflareEmailSender extends AuthEmailSenderBase {
  from!: string;

  async sendEmail(email: ResolvedEmail): Promise<void> {
    const binding = (this.env as any).EMAIL;
    if (!binding) {
      throw new Error('EMAIL binding is not configured in wrangler.jsonc (send_email)');
    }

    await binding.send({
      from: { email: email.from, name: email.appName },
      to: email.to,
      subject: email.subject,
      html: email.html,
      replyTo: email.replyTo,
      headers: email.headers,
    });
  }
}

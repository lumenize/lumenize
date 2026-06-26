import type { EmailTransport, ResolvedEmail } from './types';

/**
 * Delivers via [Resend](https://resend.com) (`https://api.resend.com/emails`).
 * Requires `RESEND_API_KEY` in `env`. The Resend `from` is `"${appName} <${from}>"`.
 *
 * `env` is typed `object` (shared library); `RESEND_API_KEY` is read via a
 * narrowed cast.
 *
 * @throws if `RESEND_API_KEY` is unset, or if the Resend API returns a non-2xx.
 */
export class ResendEmailTransport implements EmailTransport {
  readonly #env: { RESEND_API_KEY?: string };

  constructor(env: object) {
    this.#env = env as { RESEND_API_KEY?: string };
  }

  async sendEmail(email: ResolvedEmail): Promise<void> {
    const apiKey = this.#env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not set in environment');
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: `${email.appName} <${email.from}>`,
        to: email.to,
        subject: email.subject,
        html: email.html,
        reply_to: email.replyTo,
        // Resend accepts arbitrary custom headers via the `headers` field.
        headers: email.headers,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorText}`);
    }
  }
}

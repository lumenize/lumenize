import type { EmailTransport, ResolvedEmail } from './types';

/** Minimal shape of the Cloudflare `send_email` (`EMAIL`) Worker binding. */
interface CloudflareEmailBinding {
  send(message: {
    from: { email: string; name: string };
    to: string;
    subject: string;
    html: string;
    replyTo: string;
    headers: Record<string, string>;
  }): Promise<unknown>;
}

/**
 * Delivers via [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/)
 * through the `EMAIL` Worker binding (`send_email` in `wrangler.jsonc`) — no API key.
 *
 * `env` is typed `object` (this library is consumed by packages with different
 * generated `Env`s); the `EMAIL` binding is read via a narrowed cast.
 *
 * @throws if the `EMAIL` binding is not configured.
 */
export class CloudflareEmailTransport implements EmailTransport {
  readonly #env: { EMAIL?: CloudflareEmailBinding };

  constructor(env: object) {
    this.#env = env as { EMAIL?: CloudflareEmailBinding };
  }

  async sendEmail(email: ResolvedEmail): Promise<void> {
    const binding = this.#env.EMAIL;
    if (!binding) {
      throw new Error('EMAIL binding is not configured (send_email in wrangler.jsonc)');
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

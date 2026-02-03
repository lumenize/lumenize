import type { EmailService, EmailMessage } from './types';

/**
 * No-op email service that logs instead of sending
 * Use this for local development or when email is not configured
 */
export class ConsoleEmailService implements EmailService {
  async send(message: EmailMessage): Promise<void> {
    switch (message.type) {
      case 'magic-link':
        console.log(`[ConsoleEmailService] Magic link for ${message.to}: ${message.magicLinkUrl}`);
        break;
      case 'admin-notification':
        console.log(`[ConsoleEmailService] Admin notification to ${message.to}: new signup from ${message.subjectEmail}, approve at ${message.approveUrl}`);
        break;
      case 'approval-confirmation':
        console.log(`[ConsoleEmailService] Approval confirmation to ${message.to}: continue at ${message.redirectUrl}`);
        break;
    }
  }
}

/**
 * Email service that sends via HTTP POST to an external service
 * Configure with your email provider's webhook/API endpoint
 *
 * @example
 * // Using with Resend
 * const emailService = new HttpEmailService({
 *   endpoint: 'https://api.resend.com/emails',
 *   headers: { 'Authorization': 'Bearer YOUR_API_KEY' },
 *   buildBody: (message) => ({
 *     from: 'auth@yourapp.com',
 *     to: message.to,
 *     subject: message.subject,
 *     html: message.type === 'magic-link'
 *       ? `<a href="${message.magicLinkUrl}">Click to login</a>`
 *       : `<p>Your account has been approved.</p>`
 *   })
 * });
 */
export interface HttpEmailServiceOptions {
  /** The HTTP endpoint to POST to */
  endpoint: string;
  /** Headers to include in the request (e.g., Authorization) */
  headers?: Record<string, string>;
  /** Function to build the request body from the email message */
  buildBody: (message: EmailMessage) => any;
}

export class HttpEmailService implements EmailService {
  #options: HttpEmailServiceOptions;

  constructor(options: HttpEmailServiceOptions) {
    this.#options = options;
  }

  async send(message: EmailMessage): Promise<void> {
    const body = this.#options.buildBody(message);

    const response = await fetch(this.#options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.#options.headers
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Email service error: ${response.status} - ${errorText}`);
    }
  }
}

/**
 * Email service that collects emails in memory (for testing)
 * Access sent emails via the `sentEmails` array
 */
export class MockEmailService implements EmailService {
  sentEmails: Array<EmailMessage & { timestamp: number }> = [];

  async send(message: EmailMessage): Promise<void> {
    this.sentEmails.push({
      ...message,
      timestamp: Date.now()
    });
  }

  /**
   * Clear all sent emails (for test cleanup)
   */
  clear(): void {
    this.sentEmails = [];
  }

  /**
   * Get the most recent email sent to a specific address
   */
  getLatestFor(email: string): (EmailMessage & { timestamp: number }) | undefined {
    return [...this.sentEmails]
      .reverse()
      .find(e => e.to === email);
  }
}

/**
 * Default email service factory
 * Returns ConsoleEmailService by default (no-op for development)
 */
export function createDefaultEmailService(): EmailService {
  return new ConsoleEmailService();
}

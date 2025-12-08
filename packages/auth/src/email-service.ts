import type { EmailService } from './types.js';

/**
 * No-op email service that logs instead of sending
 * Use this for local development or when email is not configured
 */
export class ConsoleEmailService implements EmailService {
  async send(to: string, magicLinkUrl: string): Promise<void> {
    console.log(`[ConsoleEmailService] Would send magic link to: ${to}`);
    console.log(`[ConsoleEmailService] Magic link URL: ${magicLinkUrl}`);
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
 *   headers: {
 *     'Authorization': 'Bearer YOUR_API_KEY',
 *     'Content-Type': 'application/json'
 *   },
 *   buildBody: (to, magicLinkUrl) => ({
 *     from: 'auth@yourapp.com',
 *     to: to,
 *     subject: 'Your login link',
 *     html: `<a href="${magicLinkUrl}">Click to login</a>`
 *   })
 * });
 */
export interface HttpEmailServiceOptions {
  /** The HTTP endpoint to POST to */
  endpoint: string;
  /** Headers to include in the request (e.g., Authorization) */
  headers?: Record<string, string>;
  /** Function to build the request body from email and magic link URL */
  buildBody: (to: string, magicLinkUrl: string) => any;
}

export class HttpEmailService implements EmailService {
  #options: HttpEmailServiceOptions;

  constructor(options: HttpEmailServiceOptions) {
    this.#options = options;
  }

  async send(to: string, magicLinkUrl: string): Promise<void> {
    const body = this.#options.buildBody(to, magicLinkUrl);
    
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
  sentEmails: Array<{ to: string; magicLinkUrl: string; timestamp: number }> = [];

  async send(to: string, magicLinkUrl: string): Promise<void> {
    this.sentEmails.push({
      to,
      magicLinkUrl,
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
  getLatestFor(email: string): { to: string; magicLinkUrl: string; timestamp: number } | undefined {
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


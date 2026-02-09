import type { StoredEmail } from '@lumenize/email-test';

const EMAIL_TEST_HTTP_URL = 'https://email-test.transformation.workers.dev';
const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

interface WaitForEmailOptions {
  /** TEST_TOKEN for authenticating with the deployed EmailTestDO */
  testToken: string;
  /** Timeout in ms before giving up. Default: 20000 (20s) */
  timeout?: number;
}

/**
 * Connect to the deployed EmailTestDO via WebSocket, clear existing emails,
 * and wait for a new email to arrive. Returns the parsed email.
 *
 * Call this BEFORE triggering the action that sends the email.
 * The returned promise resolves when an email arrives or rejects on timeout.
 */
export function waitForEmail(options: WaitForEmailOptions): {
  /** Promise that resolves with the next email received */
  emailPromise: Promise<StoredEmail>;
  /** Call this to clean up the WebSocket when done */
  cleanup: () => void;
} {
  const { testToken, timeout = 20000 } = options;

  let ws: WebSocket;
  let cleanedUp = false;

  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      try { ws?.close(); } catch { /* ignore */ }
    }
  };

  const emailPromise = (async () => {
    // Clear existing emails first
    await fetch(`${EMAIL_TEST_HTTP_URL}/clear?token=${testToken}`, { method: 'POST' });

    // Connect WebSocket
    ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws?token=${testToken}`);

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket connection to EmailTestDO failed')));
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
    });

    // Wait for email push
    const email = await new Promise<StoredEmail>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No email received within ${timeout}ms`));
      }, timeout);

      ws.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket closed before email received'));
      });
    });

    return email;
  })();

  return { emailPromise, cleanup };
}

/**
 * Extract the magic link URL from a parsed email's HTML content.
 * Looks for an <a> tag whose href contains 'magic-link' and 'one_time_token'.
 */
export function extractMagicLink(email: StoredEmail): string {
  const html = email.html;
  if (!html) {
    throw new Error('Email has no HTML content');
  }

  // Match href containing magic-link and one_time_token
  const hrefMatch = html.match(/href="([^"]*magic-link[^"]*one_time_token[^"]*)"/);
  if (!hrefMatch) {
    throw new Error(`No magic link found in email HTML. Subject: "${email.subject}"`);
  }

  return hrefMatch[1];
}

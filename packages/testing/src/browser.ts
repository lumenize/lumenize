import { Browser as UtilsBrowser } from '@lumenize/utils';

// Import SELF from cloudflare:test
const cloudflareTest = require('cloudflare:test') as {
  SELF: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
};
const { SELF } = cloudflareTest;

/**
 * Testing-specific Browser class with convenience methods
 * 
 * This extends the base Browser from @lumenize/utils and automatically
 * uses SELF.fetch from cloudflare:test, so you don't need to pass fetch around.
 * 
 * @example
 * ```typescript
 * import { Browser } from '@lumenize/testing';
 * 
 * const browser = new Browser();
 * 
 * // Cookie-aware fetch - no need to pass fetch!
 * await browser.fetch('https://example.com/login?user=test');
 * 
 * // Cookie-aware WebSocket
 * const ws = new browser.WebSocket('wss://example.com/ws');
 * 
 * // Create a page with Origin header for CORS testing
 * const page = browser.page('https://example.com');
 * await page.fetch('https://api.example.com/data');
 * const ws2 = new page.WebSocket('wss://api.example.com/ws');
 * ```
 */
export class Browser extends UtilsBrowser {
  private readonly baseFetch: typeof fetch;

  constructor() {
    super();
    this.baseFetch = SELF.fetch.bind(SELF);
  }

  /**
   * Cookie-aware fetch function
   * 
   * Automatically includes cookies from this browser instance.
   * Does NOT add Origin header - use page() for that.
   */
  get fetch(): typeof fetch {
    return this.getFetch(this.baseFetch);
  }

  /**
   * Cookie-aware WebSocket constructor
   * 
   * Automatically includes cookies from this browser instance.
   * Does NOT add Origin header - use page() for that.
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * const ws = new browser.WebSocket('wss://example.com/ws');
   * ws.onopen = () => console.log('Connected!');
   * ```
   */
  get WebSocket(): new (url: string | URL, protocols?: string | string[]) => WebSocket {
    return this.getWebSocket(this.baseFetch);
  }

  /**
   * Create a page context with Origin header for CORS testing
   * 
   * Returns an object with fetch and WebSocket that both:
   * - Include cookies from this browser
   * - Include the specified Origin header
   * - Include any custom headers
   * 
   * @param origin - The origin to use (e.g., 'https://example.com')
   * @param options - Optional headers and WebSocket configuration
   * @returns Object with fetch function and WebSocket constructor
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * 
   * // Simple usage
   * const page = browser.page('https://example.com');
   * await page.fetch('https://api.example.com/data');
   * 
   * // With custom headers
   * const page2 = browser.page('https://example.com', {
   *   headers: { 'X-Custom': 'value' },
   *   maxQueueBytes: 1024 * 1024
   * });
   * const ws = new page2.WebSocket('wss://api.example.com/ws');
   * 
   * // Can chain directly
   * await browser.page('https://evil.com').fetch('https://example.com/api');
   * ```
   */
  page(origin: string, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): {
    fetch: typeof fetch;
    WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  } {
    return this.createPage(this.baseFetch, {
      origin,
      ...options
    });
  }
}

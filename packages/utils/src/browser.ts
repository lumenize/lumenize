import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';
import { getWebSocketShim } from './websocket-shim';

// Declaration for require (used to conditionally load cloudflare:test)
declare const require: (module: string) => any;

/**
 * Cookie-aware HTTP client for browser-based APIs
 * 
 * Automatically manages cookies across requests, making it easy to interact with APIs
 * that rely on cookies for authentication, session management, and other flows. This is
 * common in data extraction scenarios and testing.
 * 
 * The Browser automatically detects the appropriate fetch function to use:
 * 1. Uses provided fetch if passed to constructor
 * 2. Uses SELF.fetch from cloudflare:test if in Cloudflare Workers vitest environment
 * 3. Uses globalThis.fetch if available
 * 4. Throws error if no fetch is available
 * 
 * @example
 * ```typescript
 * // Simple usage - auto-detects fetch
 * const browser = new Browser();
 * 
 * // Login sets session cookie
 * await browser.fetch('https://api.example.com/auth/login', {
 *   method: 'POST',
 *   body: JSON.stringify({ username: 'user', password: 'pass' })
 * });
 * 
 * // Cookie automatically included in subsequent requests
 * const data = await browser.fetch('https://api.example.com/data/export');
 * 
 * // WebSocket with cookies
 * const ws = new browser.WebSocket('wss://api.example.com/stream');
 * 
 * // CORS testing with origin context
 * const page = browser.context('https://app.example.com');
 * await page.fetch('https://api.example.com/data');
 * ```
 */
export class Browser {
  #cookies = new Map<string, Cookie>();
  #inferredHostname?: string;
  #baseFetch: typeof fetch;

  /**
   * Create a new Browser instance
   * 
   * @param fetchFn - Optional fetch function to use. If not provided, will auto-detect:
   *   1. SELF.fetch from cloudflare:test (if in Cloudflare Workers vitest environment)
   *   2. globalThis.fetch (if available)
   *   3. Throws error if none available
   * 
   * @example
   * ```typescript
   * // Auto-detect fetch
   * const browser = new Browser();
   * 
   * // Use custom fetch
   * const browser2 = new Browser(myCustomFetch);
   * ```
   */
  constructor(fetchFn?: typeof fetch) {
    if (fetchFn) {
      this.#baseFetch = fetchFn;
    } else {
      // Try to get SELF.fetch from cloudflare:test
      let selfFetch: typeof fetch | undefined;
      try {
        const cloudflareTest = require('cloudflare:test') as {
          SELF: { fetch: typeof fetch };
        };
        selfFetch = cloudflareTest.SELF.fetch.bind(cloudflareTest.SELF);
      } catch {
        // Not in Cloudflare Workers vitest environment
      }

      if (selfFetch) {
        this.#baseFetch = selfFetch;
      } else if (typeof globalThis?.fetch === 'function') {
        this.#baseFetch = globalThis.fetch;
      } else {
        throw new Error(
          'No fetch function available. Either:\n' +
          '1. Pass fetch to Browser constructor: new Browser(fetch)\n' +
          '2. Run in Cloudflare Workers vitest environment (provides SELF.fetch)\n' +
          '3. Ensure globalThis.fetch is available'
        );
      }
    }
  }

  /**
   * Cookie-aware fetch function
   * 
   * Automatically includes cookies from this browser instance in requests
   * and stores cookies from responses.
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * 
   * // First request sets session cookie
   * await browser.fetch('https://api.example.com/login?token=xyz');
   * 
   * // Subsequent requests include the cookie
   * const response = await browser.fetch('https://api.example.com/data');
   * ```
   */
  get fetch(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      
      // Add cookies to request
      const cookieHeader = this.getCookiesForRequest(request.url);
      if (cookieHeader) {
        request.headers.set('Cookie', cookieHeader);
      }
      
      // Make request
      const response = await this.#baseFetch(request);
      
      // Store cookies from response
      this.#storeCookiesFromResponse(response, request.url);
      
      return response;
    };
  }

  /**
   * Cookie-aware WebSocket constructor
   * 
   * Automatically includes cookies from this browser instance in the WebSocket
   * upgrade request.
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * const ws = new browser.WebSocket('wss://api.example.com/stream');
   * ws.onopen = () => console.log('Connected!');
   * ```
   */
  get WebSocket(): new (url: string | URL, protocols?: string | string[]) => WebSocket {
    return getWebSocketShim(this.fetch);
  }

  /**
   * Create a context with Origin header for CORS testing
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
   * const page = browser.context('https://example.com');
   * await page.fetch('https://api.example.com/data');
   * 
   * // With custom headers
   * const page2 = browser.context('https://example.com', {
   *   headers: { 'X-Custom': 'value' },
   *   maxQueueBytes: 1024 * 1024
   * });
   * const ws = new page2.WebSocket('wss://api.example.com/ws');
   * 
   * // Can chain directly
   * await browser.context('https://evil.com').fetch('https://example.com/api');
   * ```
   */
  context(origin: string, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): {
    fetch: typeof fetch;
    WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  } {
    // Wrap fetch to add Origin header
    const contextFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      
      // Add Origin header if not already present
      if (!request.headers.has('Origin')) {
        request.headers.set('Origin', origin);
      }
      
      return this.fetch(request);
    };
    
    // Create WebSocket with Origin header
    const headers = {
      Origin: origin,
      ...options?.headers
    };
    
    const ContextWebSocket = getWebSocketShim(this.fetch, {
      headers,
      maxQueueBytes: options?.maxQueueBytes
    });
    
    return {
      fetch: contextFetch as typeof fetch,
      WebSocket: ContextWebSocket
    };
  }

  /**
   * Store cookies from a response
   */
  #storeCookiesFromResponse(response: Response, requestUrl: string): void {
    const setCookieHeaders = this.#getSetCookieHeaders(response);
    if (setCookieHeaders.length === 0) return;

    const url = new URL(requestUrl);
    
    // Hostname behavior: first fetch sets it if not manually set, but last manual setting wins
    if (!this.#inferredHostname) {
      this.#inferredHostname = url.hostname;
    }
    
    const cookies = parseSetCookies(setCookieHeaders);

    for (const cookie of cookies) {
      // Set default domain and path if not specified
      if (!cookie.domain) {
        cookie.domain = url.hostname;
      }
      if (!cookie.path) {
        cookie.path = '/';
      }

      // Store cookie with a unique key (name + domain + path)
      const key = this.#getCookieKey(cookie.name, cookie.domain, cookie.path);
      this.#cookies.set(key, cookie);
    }
  }

  /**
   * Get cookies that should be included in a request
   * 
   * Automatically cleans up expired cookies.
   * 
   * @param requestUrl - The URL being requested
   * @returns Cookie header value or null if no cookies match
   */
  getCookiesForRequest(requestUrl: string): string | null {
    const url = new URL(requestUrl);
    const matchingCookies: Cookie[] = [];
    const now = new Date();
    const keysToRemove: string[] = [];

    for (const [key, cookie] of this.#cookies.entries()) {
      // Remove expired cookies
      if (cookie.expires && cookie.expires < now) {
        keysToRemove.push(key);
        continue;
      }
      
      if (cookieMatches(cookie, url.hostname, url.pathname)) {
        matchingCookies.push(cookie);
      }
    }

    // Clean up expired cookies
    keysToRemove.forEach(key => this.#cookies.delete(key));

    if (matchingCookies.length === 0) return null;

    return serializeCookies(matchingCookies);
  }

  /**
   * Set a cookie manually
   * 
   * @param name - Cookie name
   * @param value - Cookie value
   * @param options - Optional cookie attributes (domain, path, expires, etc.)
   * 
   * @example
   * ```typescript
   * browser.setCookie('auth_token', 'abc123', {
   *   domain: 'api.example.com',
   *   path: '/',
   *   expires: new Date(Date.now() + 3600000) // 1 hour
   * });
   * ```
   */
  setCookie(name: string, value: string, options: Omit<Cookie, 'name' | 'value'> = {}): void {
    let domain = options.domain;
    
    // Domain behavior: use provided domain, inferred from first fetch, or error
    if (!domain) {
      if (!this.#inferredHostname) {
        throw new Error(
          `Cannot set cookie '${name}' without domain. Either:\n` +
          `1. Specify domain: browser.setCookie('${name}', '${value}', { domain: 'example.com' })\n` +
          `2. Make a fetch request first to automatically infer domain from the URL`
        );
      }
      domain = this.#inferredHostname;
    }
    
    const cookie: Cookie = {
      name,
      value,
      domain,
      path: options.path || '/',
      ...options
    };

    const key = this.#getCookieKey(cookie.name, cookie.domain!, cookie.path!);
    this.#cookies.set(key, cookie);
  }

  /**
   * Get a specific cookie by name
   * 
   * @param name - Cookie name
   * @param domain - Optional domain filter
   * @returns Cookie value or undefined if not found
   */
  getCookie(name: string, domain?: string): string | undefined {
    const now = new Date();
    
    for (const cookie of this.#cookies.values()) {
      if (cookie.name === name && (!domain || cookie.domain === domain)) {
        if (!cookie.expires || cookie.expires > now) {
          return cookie.value;
        }
      }
    }
    return undefined;
  }

  /**
   * Get all cookies as an array of cookie objects
   * 
   * @returns Array of cookie objects with name, value, and metadata
   */
  getAllCookies(): Array<{ name: string; value: string; domain?: string; path?: string; expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: string }> {
    const result: Array<{ name: string; value: string; domain?: string; path?: string; expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: string }> = [];
    const now = new Date();
    
    for (const cookie of this.#cookies.values()) {
      if (!cookie.expires || cookie.expires > now) {
        result.push({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite
        });
      }
    }
    
    return result;
  }

  /**
   * Get all cookies as a simple name-value object  
   * 
   * @returns Object with cookie names as keys and values as values
   */
  getAllCookiesAsObject(): Record<string, string> {
    const result: Record<string, string> = {};
    const now = new Date();
    
    for (const cookie of this.#cookies.values()) {
      if (!cookie.expires || cookie.expires > now) {
        result[cookie.name] = cookie.value;
      }
    }
    
    return result;
  }

  /**
   * Remove a cookie
   * 
   * @param name - Cookie name
   * @param domain - Optional domain filter
   * @param path - Optional path filter
   */
  removeCookie(name: string, domain?: string, path?: string): void {
    const keysToRemove: string[] = [];
    
    for (const [key, cookie] of this.#cookies.entries()) {
      if (cookie.name === name && 
          (!domain || cookie.domain === domain) &&
          (!path || cookie.path === path)) {
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => this.#cookies.delete(key));
  }

  #getCookieKey(name: string, domain: string, path: string): string {
    return `${name}|${domain}|${path}`;
  }

  #getSetCookieHeaders(response: Response): string[] {
    // Headers.getSetCookie() is the modern way, but may not be available
    if (typeof response.headers.getSetCookie === 'function') {
      return response.headers.getSetCookie();
    }

    // Fallback: Get all Set-Cookie headers manually
    const setCookieHeaders: string[] = [];
    
    // Note: This is a simplified approach. In reality, multiple Set-Cookie headers
    // might not be properly handled by response.headers.get(). The getSetCookie()
    // method exists specifically to handle this case.
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) {
      setCookieHeaders.push(setCookie);
    }

    return setCookieHeaders;
  }
}

/**
 * @deprecated Use `Browser` instead. CookieJar has been renamed to Browser to better reflect its purpose.
 */
export const CookieJar = Browser;

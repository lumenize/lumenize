import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';
import { getWebSocketShim } from './websocket-shim';

/**
 * Browser simulator for testing Workers and Durable Objects
 * 
 * Simulates browser behavior including:
 * - Cookie management across requests (automatic domain/path matching)
 * - Page contexts with Origin headers for CORS testing
 * - Shared cookies between fetch and WebSocket connections
 * 
 * ## Usage
 * 
 * ```typescript
 * import { Browser } from '@lumenize/utils';
 * 
 * const browser = new Browser();
 * 
 * // Create a page with an origin (simulates requests from a loaded page)
 * const { fetch, WebSocket } = browser.createPage(SELF.fetch.bind(SELF), { 
 *   origin: 'https://example.com' 
 * });
 * 
 * // Requests include Origin header and cookies automatically
 * await fetch('https://api.example.com/data');
 * const ws = new WebSocket('wss://api.example.com/ws');
 * 
 * // Manual cookie management
 * browser.setCookie('session', 'abc123', { domain: 'example.com' });
 * console.log(browser.getCookie('session')); // 'abc123'
 * ```
 */
export class Browser {
  private cookies = new Map<string, Cookie>();
  private inferredHostname?: string;
  private cookieJarEnabled = true;

  /**
   * Create a cookie-aware fetch function that automatically manages cookies
   * 
   * @param baseFetch - The base fetch function to wrap (e.g., SELF.fetch.bind(SELF))
   * @returns A fetch function that automatically handles cookies
   * 
   * @example
   * ```typescript
   * const cookieJar = new CookieJar();
   * const cookieAwareFetch = cookieJar.getFetch(SELF.fetch.bind(SELF));
   * 
   * // Login sets session cookie
   * await cookieAwareFetch('https://example.com/login?user=me');
   * 
   * // Cookie automatically included in next request
   * await cookieAwareFetch('https://example.com/protected');
   * ```
   */
  getFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!this.cookieJarEnabled) {
        return baseFetch(input, init);
      }

      const request = new Request(input, init);
      
      // Add cookies to request
      const cookieHeader = this.getCookiesForRequest(request.url);
      if (cookieHeader) {
        request.headers.set('Cookie', cookieHeader);
      }
      
      // Make request
      const response = await baseFetch(request);
      
      // Store cookies from response
      this.storeCookiesFromResponse(response, request.url);
      
      return response;
    };
  }

  /**
   * Create a cookie-aware WebSocket constructor that automatically includes cookies
   * 
   * @param baseFetch - The base fetch function to wrap (e.g., SELF.fetch.bind(SELF))
   * @param options - Optional WebSocket factory configuration (headers, maxQueueBytes)
   * @returns A WebSocket constructor that automatically handles cookies
   * 
   * @example
   * ```typescript
   * import { getWebSocketShim } from '@lumenize/utils';
   * 
   * const cookieJar = new CookieJar();
   * cookieJar.setDefaultHostname('example.com'); // Will be used as Origin if not explicitly set
   * 
   * const CookieWebSocket = cookieJar.getWebSocket(SELF.fetch.bind(SELF), {
   *   headers: { 'X-Custom-Header': 'value' }, // Origin auto-added from hostname
   *   maxQueueBytes: 1024 * 1024 // 1MB
   * });
   * 
   * // WebSocket upgrade request includes cookies, Origin, AND custom headers automatically
   * const ws = new CookieWebSocket('wss://example.com/ws');
   * ```
   */
  getWebSocket(baseFetch: typeof fetch, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): new (url: string | URL, protocols?: string | string[]) => WebSocket {
    const cookieAwareFetch = this.getFetch(baseFetch);
    
    // If we have a hostname (inferred or manual) and no explicit Origin header, add it
    const headers = { ...options?.headers };
    if (this.inferredHostname && !headers['Origin'] && !headers['origin']) {
      headers['Origin'] = `https://${this.inferredHostname}`;
    }
    
    return getWebSocketShim(cookieAwareFetch, {
      ...options,
      headers
    });
  }

  /**
   * Create a page context with an origin for CORS testing
   * 
   * Returns fetch and WebSocket that simulate requests from a page loaded from the given origin.
   * Both automatically include the Origin header and cookies.
   * 
   * @param baseFetch - The base fetch function to wrap (e.g., SELF.fetch.bind(SELF))
   * @param options - Page configuration
   * @param options.origin - The origin of the page (e.g., 'https://example.com')
   * @param options.headers - Additional headers to include in WebSocket upgrades
   * @param options.maxQueueBytes - Queue limit for WebSocket CONNECTING state
   * @returns Object with fetch and WebSocket constructors
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * 
   * // Create a page from example.com
   * const { fetch, WebSocket } = browser.createPage(SELF.fetch.bind(SELF), { 
   *   origin: 'https://example.com' 
   * });
   * 
   * // Requests include Origin: https://example.com
   * await fetch('https://api.example.com/data');
   * const ws = new WebSocket('wss://api.example.com/ws');
   * 
   * // Test cross-origin rejection
   * const attacker = new Browser();
   * const { fetch: attackFetch } = attacker.createPage(SELF.fetch.bind(SELF), {
   *   origin: 'https://evil.com'
   * });
   * const res = await attackFetch('https://api.example.com/data'); // May be rejected
   * ```
   */
  createPage(
    baseFetch: typeof fetch,
    options: {
      origin: string;
      headers?: Record<string, string>;
      maxQueueBytes?: number;
    }
  ): { fetch: typeof fetch; WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket } {
    // Create cookie-aware fetch
    const cookieAwareFetch = this.getFetch(baseFetch);
    
    // Wrap fetch to add Origin header
    const pageFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      
      // Add Origin header if not already present
      if (!request.headers.has('Origin')) {
        request.headers.set('Origin', options.origin);
      }
      
      return cookieAwareFetch(request);
    };
    
    // Create WebSocket with Origin header
    const headers = {
      Origin: options.origin,
      ...options.headers
    };
    
    const PageWebSocket = getWebSocketShim(cookieAwareFetch, {
      headers,
      maxQueueBytes: options.maxQueueBytes
    });
    
    return {
      fetch: pageFetch as typeof fetch,
      WebSocket: PageWebSocket
    };
  }

  /**
   * Store cookies from a response
   * 
   * @param response - The Response object containing Set-Cookie headers
   * @param requestUrl - The URL that generated this response (for domain/path defaults)
   */
  storeCookiesFromResponse(response: Response, requestUrl: string): void {
    if (!this.cookieJarEnabled) return;
    
    const setCookieHeaders = this.getSetCookieHeaders(response);
    if (setCookieHeaders.length === 0) return;

    const url = new URL(requestUrl);
    
    // Hostname behavior: first fetch sets it if not manually set, but last manual setting wins
    if (!this.inferredHostname) {
      this.inferredHostname = url.hostname;
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
      const key = this.getCookieKey(cookie.name, cookie.domain, cookie.path);
      this.cookies.set(key, cookie);
    }
  }

  /**
   * Get cookies that should be included in a request
   * 
   * @param requestUrl - The URL being requested
   * @returns Cookie header value or null if no cookies match
   */
  getCookiesForRequest(requestUrl: string): string | null {
    if (!this.cookieJarEnabled) return null;
    
    const url = new URL(requestUrl);
    const matchingCookies: Cookie[] = [];

    for (const cookie of this.cookies.values()) {
      if (cookieMatches(cookie, url.hostname, url.pathname)) {
        matchingCookies.push(cookie);
      }
    }

    if (matchingCookies.length === 0) return null;

    return serializeCookies(matchingCookies);
  }

  /**
   * Manually set a cookie
   * 
   * @param name - Cookie name
   * @param value - Cookie value
   * @param options - Optional cookie attributes
   * 
   * @example
   * ```typescript
   * cookieJar.setCookie('session', 'abc123', {
   *   domain: 'example.com',
   *   path: '/',
   *   expires: new Date(Date.now() + 86400000) // 24 hours
   * });
   * ```
   */
  setCookie(name: string, value: string, options: Omit<Cookie, 'name' | 'value'> = {}): void {
    let domain = options.domain;
    
    // Hostname behavior: use provided domain, manually set hostname (last wins), or error
    if (!domain) {
      if (!this.inferredHostname) {
        throw new Error(
          `Cannot set cookie '${name}' without domain. Either:\n` +
          `1. Specify domain: cookieJar.setCookie('${name}', '${value}', { domain: 'example.com' })\n` +
          `2. Make a fetch request first to establish default hostname\n` +
          `3. Set default hostname: cookieJar.setDefaultHostname('example.com')`
        );
      }
      domain = this.inferredHostname;
    }
    
    const cookie: Cookie = {
      name,
      value,
      domain,
      path: options.path || '/',
      ...options
    };

    const key = this.getCookieKey(cookie.name, cookie.domain!, cookie.path!);
    this.cookies.set(key, cookie);
  }

  /**
   * Get a specific cookie by name
   * 
   * @param name - Cookie name
   * @param domain - Optional domain filter
   * @returns Cookie value or undefined if not found
   */
  getCookie(name: string, domain?: string): string | undefined {
    for (const cookie of this.cookies.values()) {
      if (cookie.name === name && (!domain || cookie.domain === domain)) {
        if (!cookie.expires || cookie.expires > new Date()) {
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
    
    for (const cookie of this.cookies.values()) {
      if (!cookie.expires || cookie.expires > new Date()) {
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
    
    for (const cookie of this.cookies.values()) {
      if (!cookie.expires || cookie.expires > new Date()) {
        result[cookie.name] = cookie.value;
      }
    }
    
    return result;
  }

  /**
   * Set the default hostname for manually set cookies
   * Useful for complex multi-domain scenarios or setting hostname before any fetches
   * 
   * @param hostname - Default hostname for cookies
   */
  setDefaultHostname(hostname: string): void {
    this.inferredHostname = hostname;
  }

  /**
   * Enable or disable cookie jar functionality
   * 
   * @param enabled - Whether to enable cookie jar
   */
  setEnabled(enabled: boolean): void {
    this.cookieJarEnabled = enabled;
  }

  /**
   * Check if cookie jar is enabled
   */
  isEnabled(): boolean {
    return this.cookieJarEnabled;
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
    
    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.name === name && 
          (!domain || cookie.domain === domain) &&
          (!path || cookie.path === path)) {
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => this.cookies.delete(key));
  }

  /**
   * Clear all cookies
   */
  clear(): void {
    this.cookies.clear();
  }

  /**
   * Remove expired cookies
   */
  cleanupExpiredCookies(): void {
    const now = new Date();
    const keysToRemove: string[] = [];

    for (const [key, cookie] of this.cookies.entries()) {
      if (cookie.expires && cookie.expires < now) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => this.cookies.delete(key));
  }

  private getCookieKey(name: string, domain: string, path: string): string {
    return `${name}|${domain}|${path}`;
  }

  private getSetCookieHeaders(response: Response): string[] {
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

import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';
import { getWebSocketShim } from './websocket-shim';

/**
 * Cookie-aware HTTP client for browser-based APIs
 * 
 * Originally designed for testing, this class is wrapped in Cloudflare's testing context 
 * and exposed in `@lumenize/testing`. The primary reason it's available in `@lumenize/utils` 
 * is for writing utilities that interact with APIs designed for browser use—especially those 
 * that rely on cookies for authentication, session management, and other flows. This is 
 * common in data extraction scenarios.
 * 
 * @example
 * ```typescript
 * // Data extraction from cookie-based API
 * const browser = new Browser();
 * const cookieFetch = browser.getFetch(fetch);
 * 
 * // Login sets session cookie
 * await cookieFetch('https://api.example.com/auth/login', {
 *   method: 'POST',
 *   body: JSON.stringify({ username: 'user', password: 'pass' })
 * });
 * 
 * // Cookie automatically included in subsequent requests
 * const data = await cookieFetch('https://api.example.com/data/export');
 * ```
 */
export class Browser {
  private cookies = new Map<string, Cookie>();
  private inferredHostname?: string;
  private cookieJarEnabled = true;

  /**
   * Create a cookie-aware fetch function
   * 
   * @param baseFetch - The base fetch function to wrap
   * @returns A fetch function that automatically handles cookies
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * const apiFetch = browser.getFetch(fetch);
   * 
   * // First request sets session cookie
   * await apiFetch('https://api.example.com/login?token=xyz');
   * 
   * // Subsequent requests include the cookie
   * const response = await apiFetch('https://api.example.com/data');
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
   * Get a WebSocket constructor that includes cookies
   * 
   * @param baseFetch - The base fetch function to wrap
   * @param options - Optional WebSocket configuration
   * @returns A WebSocket constructor that automatically handles cookies
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * const CookieWS = browser.getWebSocket(fetch);
   * 
   * // WebSocket upgrade includes cookies from previous requests
   * const ws = new CookieWS('wss://api.example.com/stream');
   * ```
   */
  getWebSocket(baseFetch: typeof fetch, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): new (url: string | URL, protocols?: string | string[]) => WebSocket {
    const cookieAwareFetch = this.getFetch(baseFetch);
    
    return getWebSocketShim(cookieAwareFetch, options);
  }  /**
   * Create a page context with Origin header (primarily for testing)
   * 
   * Returns fetch and WebSocket that include the specified Origin header. Useful for
   * testing CORS behavior or simulating cross-origin requests.
   * 
   * @param baseFetch - The base fetch function to wrap
   * @param options - Page configuration including origin
   * @returns Object with fetch and WebSocket constructors
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * const { fetch } = browser.createPage(fetch, { 
   *   origin: 'https://app.example.com' 
   * });
   * 
   * // Request includes Origin header for CORS validation
   * await fetch('https://api.example.com/data');
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
      if (!this.inferredHostname) {
        throw new Error(
          `Cannot set cookie '${name}' without domain. Either:\n` +
          `1. Specify domain: browser.setCookie('${name}', '${value}', { domain: 'example.com' })\n` +
          `2. Make a fetch request first to automatically infer domain from the URL`
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

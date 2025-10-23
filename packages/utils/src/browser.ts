import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';
import { getWebSocketShim } from './websocket-shim';
import type { Metrics } from './metrics';

/**
 * Configuration options for Browser
 */
export interface BrowserOptions {
  /** Optional metrics collector to track httpRequests. */
  metrics?: Metrics;
}

/**
 * Information about a CORS preflight request
 * 
 * @private
 */
type PreflightInfo = {
  url: string;
  method: string;
  headers: string[];
  success: boolean;
};

/**
 * Cookie and Origin-aware client for HTTP and WebSockets
 * 
 * For detailed examples of `Browser` in testing examples, see 
 * [`@lumenize/testing` Usage](/docs/testing/usage) and 
 * [`@lumenize/testing` Agents](/docs/testing/agents).
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
  #metrics?: Metrics;

  /**
   * Create a new Browser instance
   * 
   * @param fetchFn - Optional fetch function to use. If not provided, will use globalThis.fetch.
   *   In Cloudflare Workers vitest environment, use the Browser from @lumenize/testing which
   *   automatically provides SELF.fetch.
   * @param options - Optional configuration including metrics tracking.
   * 
   * @example
   * ```typescript
   * // In Cloudflare Workers test environment - use Browser from @lumenize/testing
   * import { Browser } from '@lumenize/testing';
   * const browser = new Browser(); // Auto-detects SELF.fetch
   * 
   * // Outside Workers environments - pass fetch explicitly or use globalThis.fetch
   * import { Browser } from '@lumenize/utils';
   * const browser = new Browser(fetch);
   * 
   * // With metrics tracking
   * const metrics: Metrics = {};
   * const browser = new Browser(fetch, { metrics });
   * await browser.fetch('https://example.com');
   * console.log(metrics.httpRequests); // 1
   * ```
   */
  constructor(fetchFn?: typeof fetch, options?: BrowserOptions) {
    if (fetchFn) {
      this.#baseFetch = fetchFn;
    } else if (typeof globalThis?.fetch === 'function') {
      this.#baseFetch = globalThis.fetch;
    } else {
      throw new Error(
        'No fetch function available. Either:\n' +
        '1. Pass fetch to Browser constructor: new Browser(fetch)\n' +
        '2. Use Browser from @lumenize/testing in Cloudflare Workers vitest environment\n' +
        '3. Ensure globalThis.fetch is available'
      );
    }
    this.#metrics = options?.metrics;
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
      // Track HTTP request
      if (this.#metrics) {
        this.#metrics.httpRequests = (this.#metrics.httpRequests ?? 0) + 1;
      }
      
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
   * Create a context with Origin header for browser-like CORS behavior
   * 
   * Returns an object with fetch and WebSocket that both:
   * - Include cookies from this browser
   * - Include the specified Origin header
   * - Include any custom headers
   * 
   * The fetch function returned by context() validates CORS headers and will throw
   * a TypeError (like a real browser) if the server doesn't properly allow the origin.
   * 
   * @param origin - The origin to use (e.g., 'https://example.com')
   * @param options - Optional headers and WebSocket configuration
   * @returns Object with fetch function and WebSocket constructor
   * 
   * @example
   * ```typescript
   * const browser = new Browser();
   * 
   * // Simple usage - validates CORS on cross-origin requests
   * const page = browser.context('https://example.com');
   * await page.fetch('https://api.example.com/data'); // Validates CORS
   * 
   * // Same-origin request - no CORS validation needed
   * await page.fetch('https://example.com/data'); // No validation
   * 
   * // With custom headers
   * const page2 = browser.context('https://example.com', {
   *   headers: { 'X-Custom': 'value' },
   *   maxQueueBytes: 1024 * 1024
   * });
   * const ws = new page2.WebSocket('wss://api.example.com/ws');
   * 
   * // CORS error example - will throw TypeError
   * try {
   *   await browser.context('https://app.com').fetch('https://api.com/data');
   *   // Throws if api.com doesn't send proper CORS headers
   * } catch (err) {
   *   console.error('CORS error:', err); // TypeError: Failed to fetch
   * }
   * ```
   */
  context(origin: string, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): {
    fetch: typeof fetch;
    WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket;
    lastPreflight: PreflightInfo | null;
  } {
    // Track the last preflight request (non-standard extension for testing/debugging)
    const preflightTracker = { lastPreflight: null as PreflightInfo | null };
    
    // Wrap fetch to add Origin header, send preflight if needed, and validate CORS
    const contextFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const requestUrl = new URL(request.url);
      
      // Add Origin header if not already present
      if (!request.headers.has('Origin')) {
        request.headers.set('Origin', origin);
      }
      
      // Get the actual origin that will be sent (might be explicitly overridden)
      const actualOrigin = request.headers.get('Origin') || origin;
      
      // Check if this is a cross-origin request
      const isCrossOrigin = requestUrl.origin !== actualOrigin;
      
      // Send preflight OPTIONS if this is a cross-origin non-simple request
      if (isCrossOrigin && this.#requiresPreflight(request)) {
        try {
          preflightTracker.lastPreflight = await this.#sendPreflight(requestUrl, request, actualOrigin);
        } catch (error) {
          // Capture failed preflight info
          preflightTracker.lastPreflight = this.#getPreflightInfo(requestUrl, request, false);
          throw error;
        }
      } else {
        preflightTracker.lastPreflight = null;
      }
      
      // Make the actual request
      const response = await this.fetch(request);
      
      // Validate CORS for cross-origin requests
      if (isCrossOrigin) {
        this.#validateCorsResponse(response, actualOrigin, request.credentials === 'include');
      }
      
      return response;
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
      WebSocket: ContextWebSocket,
      get lastPreflight() { return preflightTracker.lastPreflight; }
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

  /**
   * Check if a request requires a CORS preflight OPTIONS request.
   * 
   * Per the CORS spec, preflight is required for:
   * - Non-simple methods (anything other than GET, HEAD, POST)
   * - POST with non-simple Content-Type (anything other than application/x-www-form-urlencoded, 
   *   multipart/form-data, or text/plain)
   * - Any request with custom headers (beyond simple headers like Accept, Accept-Language, Content-Language)
   * 
   * See: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests
   */
  #requiresPreflight(request: Request): boolean {
    const method = request.method.toUpperCase();
    
    // Non-simple methods always require preflight
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return true;
    }
    
    // Check for non-simple headers
    const simpleHeaders = new Set([
      'accept',
      'accept-language',
      'content-language',
      'content-type'
    ]);
    
    let hasCustomHeader = false;
    request.headers.forEach((_, headerName) => {
      const lowerName = headerName.toLowerCase();
      // Origin is added by us, not a custom header
      if (lowerName === 'origin') return;
      
      if (!simpleHeaders.has(lowerName)) {
        hasCustomHeader = true; // Custom header requires preflight
      }
    });
    
    if (hasCustomHeader) {
      return true;
    }
    
    // For POST, check Content-Type
    if (method === 'POST') {
      const contentType = request.headers.get('Content-Type');
      if (contentType) {
        const mimeType = contentType.split(';')[0].trim().toLowerCase();
        const simpleContentTypes = [
          'application/x-www-form-urlencoded',
          'multipart/form-data',
          'text/plain'
        ];
        if (!simpleContentTypes.includes(mimeType)) {
          return true; // Non-simple content type requires preflight
        }
      }
    }
    
    return false;
  }

  /**
   * Extract preflight information from a request (helper for tracking)
   */
  #getPreflightInfo(requestUrl: URL, request: Request, success: boolean): PreflightInfo {
    const simpleHeaders = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
    const customHeaders: string[] = [];
    
    request.headers.forEach((_, headerName) => {
      const lowerName = headerName.toLowerCase();
      if (lowerName !== 'origin' && !simpleHeaders.has(lowerName)) {
        customHeaders.push(lowerName);
      }
    });
    
    return {
      url: requestUrl.toString(),
      method: request.method,
      headers: customHeaders,
      success
    };
  }

  /**
   * Send a CORS preflight OPTIONS request and validate the response.
   * 
   * This is called automatically by context().fetch when a non-simple cross-origin
   * request is detected. It mimics real browser behavior.
   * 
   * @returns Information about the preflight request that was sent
   */
  async #sendPreflight(requestUrl: URL, request: Request, origin: string): Promise<PreflightInfo> {
    // Build the preflight OPTIONS request
    const preflightHeaders = new Headers({
      'Origin': origin,
      'Access-Control-Request-Method': request.method
    });
    
    // Collect non-simple headers for Access-Control-Request-Headers
    const simpleHeaders = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
    const customHeaders: string[] = [];
    
    request.headers.forEach((_, headerName) => {
      const lowerName = headerName.toLowerCase();
      if (lowerName !== 'origin' && !simpleHeaders.has(lowerName)) {
        customHeaders.push(lowerName);
      }
    });
    
    if (customHeaders.length > 0) {
      preflightHeaders.set('Access-Control-Request-Headers', customHeaders.join(', '));
    }
    
    // Send the OPTIONS request
    const preflightRequest = new Request(requestUrl.toString(), {
      method: 'OPTIONS',
      headers: preflightHeaders
    });
    
    const preflightResponse = await this.fetch(preflightRequest);
    
    // Validate preflight response
    this.#validateCorsResponse(preflightResponse, origin, request.credentials === 'include');
    
    // Note: We could also validate Access-Control-Allow-Methods and 
    // Access-Control-Allow-Headers here, but for simplicity we're just
    // checking that we got a successful CORS response. Real browsers
    // do more extensive validation.
    
    // Return preflight info for debugging/testing (success=true if we got here)
    return {
      url: requestUrl.toString(),
      method: request.method,
      headers: customHeaders,
      success: true
    };
  }

  /**
   * Validate CORS response headers
   * 
   * Throws a TypeError (like a real browser) if CORS headers are missing or incorrect.
   * This is called automatically by context().fetch for cross-origin requests.
   */
  #validateCorsResponse(response: Response, requestOrigin: string, includesCredentials: boolean): void {
    const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
    
    // Check if origin is allowed
    if (!allowOrigin) {
      throw new TypeError(
        `Failed to fetch: CORS error - No 'Access-Control-Allow-Origin' header present. ` +
        `The server must include this header to allow cross-origin requests from '${requestOrigin}'.`
      );
    }
    
    // Wildcard (*) not allowed when credentials are included
    if (allowOrigin === '*') {
      if (includesCredentials) {
        throw new TypeError(
          `Failed to fetch: CORS error - Cannot use wildcard '*' in 'Access-Control-Allow-Origin' ` +
          `when credentials are included. The server must explicitly allow origin '${requestOrigin}'.`
        );
      }
      // Wildcard is OK without credentials
      return;
    }
    
    // Check if the specific origin is allowed
    if (allowOrigin !== requestOrigin) {
      throw new TypeError(
        `Failed to fetch: CORS error - 'Access-Control-Allow-Origin' header is '${allowOrigin}' ` +
        `but the request origin is '${requestOrigin}'. These must match.`
      );
    }
    
    // Check credentials header when credentials are included
    if (includesCredentials) {
      const allowCredentials = response.headers.get('Access-Control-Allow-Credentials');
      if (allowCredentials !== 'true') {
        throw new TypeError(
          `Failed to fetch: CORS error - Credentials are included but ` +
          `'Access-Control-Allow-Credentials' header is not 'true'.`
        );
      }
    }
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

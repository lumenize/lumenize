import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';
import { getWebSocketShim } from './websocket-shim';
import type { Metrics } from './metrics';
import { StorageMock } from './storage-mock';
import { createBroadcastChannelConstructor, type BroadcastChannelRegistry } from './broadcast-channel-mock';

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
 * A browsing context (conceptually a browser tab) with its own sessionStorage
 * and access to shared BroadcastChannel for cross-context communication.
 *
 * Created via `browser.context(origin)`. Each context is independent —
 * sessionStorage is per-context, while BroadcastChannel and cookies are
 * shared across all contexts from the same origin/browser.
 *
 * Backward compatible with the previous plain-object return type:
 * `const { fetch, WebSocket } = browser.context(origin)` still works.
 */
export class Context {
  /** Cookie-aware, CORS-validating fetch scoped to this context's origin */
  readonly fetch: typeof fetch;
  /** Cookie-aware WebSocket constructor scoped to this context's origin */
  readonly WebSocket: typeof WebSocket;
  /** Per-context Storage (independent per context, like real sessionStorage) */
  readonly sessionStorage: Storage;
  /** BroadcastChannel constructor scoped to this context's origin */
  readonly BroadcastChannel: typeof BroadcastChannel;

  /** @internal */ readonly origin: string;
  /** @internal */ #preflightTracker: { lastPreflight: PreflightInfo | null };
  /** @internal */ #openChannels = new Set<{ close(): void }>();
  /** @internal */ #closed = false;

  /** @internal */
  constructor(
    origin: string,
    contextFetch: typeof fetch,
    ContextWebSocket: typeof WebSocket,
    sessionStorage: StorageMock,
    channelRegistry: BroadcastChannelRegistry,
    preflightTracker: { lastPreflight: PreflightInfo | null },
  ) {
    this.origin = origin;
    this.fetch = contextFetch;
    this.WebSocket = ContextWebSocket;
    this.sessionStorage = sessionStorage;
    this.#preflightTracker = preflightTracker;

    // Create a BroadcastChannel constructor that tracks open channels for cleanup
    const ctx = this;
    const BaseBroadcastChannel = createBroadcastChannelConstructor(channelRegistry);
    this.BroadcastChannel = class TrackedBroadcastChannel extends BaseBroadcastChannel {
      constructor(name: string) {
        super(name);
        ctx.#openChannels.add(this);
      }
      close() {
        super.close();
        ctx.#openChannels.delete(this);
      }
    } as unknown as typeof BroadcastChannel;
  }

  /** Information about the last CORS preflight request (for testing/debugging) */
  get lastPreflight(): PreflightInfo | null {
    return this.#preflightTracker.lastPreflight;
  }

  /**
   * Close all open BroadcastChannels without clearing sessionStorage.
   * Models a page reload where JS state is destroyed but storage persists.
   */
  closeChannels(): void {
    for (const channel of this.#openChannels) {
      channel.close();
    }
    this.#openChannels.clear();
  }

  /**
   * Close this context. Clears sessionStorage and closes all open BroadcastChannels.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.sessionStorage.clear();
    this.closeChannels();
  }
}

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
 * 2. Uses `SELF.fetch` from `cloudflare:test` if in Cloudflare Workers vitest environment
 * 3. Uses `globalThis.fetch` if available (Node.js, browsers, bun)
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
  #channelRegistries = new Map<string, BroadcastChannelRegistry>();

  /**
   * Create a new Browser instance
   *
   * @param fetchFn - Optional fetch function to use. If not provided, auto-detects:
   *   first tries `SELF.fetch` from `cloudflare:test` (Workers vitest environment),
   *   then falls back to `globalThis.fetch`.
   * @param options - Optional configuration including metrics tracking.
   *
   * @example
   * ```typescript
   * // In Cloudflare Workers test environment — auto-detects SELF.fetch
   * import { Browser } from '@lumenize/testing';
   * const browser = new Browser();
   *
   * // Outside Workers environments — pass fetch explicitly or rely on globalThis.fetch
   * import { Browser } from '@lumenize/testing';
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
    } else {
      // Try SELF.fetch from Cloudflare Workers test environment
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SELF } = require('cloudflare:test');
        this.#baseFetch = SELF.fetch.bind(SELF);
      } catch {
        // Not in Workers test environment — fall back to globalThis.fetch
        if (typeof globalThis?.fetch === 'function') {
          this.#baseFetch = globalThis.fetch;
        } else {
          throw new Error(
            'No fetch function available. Either:\n' +
            '1. Pass fetch to Browser constructor: new Browser(fetch)\n' +
            '2. Ensure you are in a Cloudflare Workers vitest environment\n' +
            '3. Ensure globalThis.fetch is available'
          );
        }
      }
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
        this.#metrics.roundTrips = (this.#metrics.roundTrips ?? 0) + 1; // One HTTP request/response = 1 round trip
      }

      const request = new Request(input, init);
      const userRedirectMode = init?.redirect ?? 'follow';

      // Track request payload size
      if (this.#metrics && request.body) {
        try {
          const clone = request.clone();
          const arrayBuffer = await clone.arrayBuffer();
          this.#metrics.payloadBytesSent = (this.#metrics.payloadBytesSent ?? 0) + arrayBuffer.byteLength;
        } catch {
          // If body can't be read, skip tracking
        }
      }

      // Add cookies to request
      const cookieHeader = this.getCookiesForRequest(request.url);
      if (cookieHeader) {
        request.headers.set('Cookie', cookieHeader);
      }

      // Handle redirects manually to capture Set-Cookie headers from intermediate responses
      // The native fetch with redirect:'follow' loses intermediate response headers
      let currentUrl = request.url;
      let currentMethod = request.method;
      let currentHeaders = new Headers(request.headers);
      let currentBody: BodyInit | null = request.body;
      let response: Response;
      let redirectCount = 0;
      const maxRedirects = 20; // Same as browser default

      while (true) {
        // Build a Request object for the fetch (mock fetches may inspect headers on the Request)
        const body = redirectCount === 0 ? currentBody : undefined;
        const fetchRequest = new Request(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body,
          redirect: 'manual',
          // duplex is required when sending a streaming body
          ...(body ? { duplex: 'half' as const } : {}),
        });

        response = await this.#baseFetch(fetchRequest);

        // Store cookies from this response (including intermediate redirects)
        this.#storeCookiesFromResponse(response, currentUrl);

        // Check if this is a redirect we should follow
        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('Location');

        if (!isRedirect || !location || userRedirectMode === 'manual') {
          // Not a redirect, or user wants manual handling - return as-is
          break;
        }

        if (userRedirectMode === 'error') {
          throw new TypeError('Failed to fetch: redirect encountered with redirect mode "error"');
        }

        // Follow the redirect
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new TypeError('Failed to fetch: too many redirects');
        }

        // Resolve relative URLs
        currentUrl = new URL(location, currentUrl).toString();

        // For 303 or POST->GET redirects, switch to GET
        const shouldSwitchToGet = response.status === 303 ||
          (response.status !== 307 && response.status !== 308 && currentMethod === 'POST');

        if (shouldSwitchToGet) {
          currentMethod = 'GET';
        }

        // Add cookies for the new URL
        const redirectCookies = this.getCookiesForRequest(currentUrl);
        if (redirectCookies) {
          currentHeaders.set('Cookie', redirectCookies);
        }

        // Track additional round trips for redirects
        if (this.#metrics) {
          this.#metrics.roundTrips = (this.#metrics.roundTrips ?? 0) + 1;
        }
      }

      // Track response payload size
      if (this.#metrics) {
        try {
          const clone = response.clone();
          const arrayBuffer = await clone.arrayBuffer();
          this.#metrics.payloadBytesReceived = (this.#metrics.payloadBytesReceived ?? 0) + arrayBuffer.byteLength;
        } catch {
          // If body can't be read, skip tracking
        }
      }

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
  get WebSocket(): typeof WebSocket {
    return getWebSocketShim(this.fetch);
  }

  /**
   * Create a browsing context (conceptually a browser tab)
   *
   * Each context has:
   * - Cookie-aware, CORS-validating `fetch` scoped to the origin
   * - Cookie-aware `WebSocket` constructor
   * - Per-context `sessionStorage` (independent per context)
   * - `BroadcastChannel` constructor for cross-context messaging (shared per origin)
   *
   * @param origin - The origin to use (e.g., 'https://example.com')
   * @param options - Optional headers and WebSocket configuration
   * @returns A Context instance (backward-compatible: destructuring still works)
   *
   * @example
   * ```typescript
   * const browser = new Browser();
   *
   * // Full context with storage and messaging
   * const tab = browser.context('https://example.com');
   * tab.sessionStorage.setItem('key', 'value');
   * const ch = new tab.BroadcastChannel('sync');
   *
   * // Backward-compatible destructuring
   * const { fetch, WebSocket } = browser.context('https://example.com');
   * ```
   */
  context(origin: string, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): Context {
    return this.#createContext(origin, new StorageMock(), options);
  }

  /**
   * Create a duplicate of an existing context, simulating browser tab duplication.
   *
   * The new context gets a **clone** of the original's sessionStorage (same data,
   * independent mutations) and shares the same BroadcastChannel namespace and cookies.
   * This is exactly how real browsers behave when a tab is duplicated.
   *
   * @param ctx - The context to duplicate
   * @param options - Optional headers and WebSocket configuration overrides
   * @returns A new Context with cloned sessionStorage
   *
   * @example
   * ```typescript
   * const tab1 = browser.context('https://example.com');
   * tab1.sessionStorage.setItem('lmz_tab', 'abc123');
   *
   * const tab2 = browser.duplicateContext(tab1);
   * tab2.sessionStorage.getItem('lmz_tab'); // 'abc123' (cloned)
   *
   * // BroadcastChannel works across original and duplicate
   * const ch1 = new tab1.BroadcastChannel('probe');
   * const ch2 = new tab2.BroadcastChannel('probe');
   * // ch1 and ch2 can communicate
   * ```
   */
  duplicateContext(ctx: Context, options?: { headers?: Record<string, string>; maxQueueBytes?: number }): Context {
    const clonedStorage = (ctx.sessionStorage as StorageMock).clone();
    return this.#createContext(ctx.origin, clonedStorage, options);
  }

  #createContext(
    origin: string,
    sessionStorage: StorageMock,
    options?: { headers?: Record<string, string>; maxQueueBytes?: number },
  ): Context {
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

    // Get or create BroadcastChannel registry for this origin
    let channelRegistry = this.#channelRegistries.get(origin);
    if (!channelRegistry) {
      channelRegistry = new Map();
      this.#channelRegistries.set(origin, channelRegistry);
    }

    return new Context(
      origin,
      contextFetch as typeof fetch,
      ContextWebSocket,
      sessionStorage,
      channelRegistry,
      preflightTracker,
    );
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
      
      const isSecure = url.protocol === 'https:';
      if (cookieMatches(cookie, url.hostname, url.pathname, isSecure)) {
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

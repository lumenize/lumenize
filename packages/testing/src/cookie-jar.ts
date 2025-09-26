import { Cookie, parseSetCookies, serializeCookies, cookieMatches } from './cookie-utils';

/**
 * Cookie jar for managing cookies across HTTP requests
 * 
 * Automatically stores cookies from Set-Cookie headers and includes
 * appropriate cookies in subsequent requests based on domain/path matching.
 */
export class CookieJar {
  private cookies = new Map<string, Cookie>();
  private inferredHostname?: string;
  private cookieJarEnabled = true;

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
   */
  setCookie(name: string, value: string, options: Omit<Cookie, 'name' | 'value'> = {}): void {
    let domain = options.domain;
    
    // Hostname behavior: use provided domain, manually set hostname (last wins), or error
    if (!domain) {
      if (!this.inferredHostname) {
        throw new Error(
          `Cannot set cookie '${name}' without domain. Either:\n` +
          `1. Specify domain: helpers.cookies.set('${name}', '${value}', { domain: 'example.com' })\n` +
          `2. Make a fetch request first to establish default hostname\n` +
          `3. Set default hostname: helpers.options.hostname = 'example.com'`
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
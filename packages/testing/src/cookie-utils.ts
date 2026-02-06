/**
 * Cookie parsing and serialization utilities
 * 
 * Simplified implementation for testing framework cookie jar functionality.
 * Handles the essential cookie operations needed for automated testing.
 * 
 * @internal
 */

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Parse a Set-Cookie header value into a Cookie object
 * 
 * @internal
 * @param setCookieHeader - The Set-Cookie header value
 * @returns Parsed cookie object or null if invalid
 */
export function parseSetCookie(setCookieHeader: string): Cookie | null {
  if (!setCookieHeader) return null;

  const parts = setCookieHeader.split(';');
  const firstPart = parts[0]?.trim();
  if (!firstPart) return null;

  const equalIndex = firstPart.indexOf('=');
  if (equalIndex === -1) return null;

  const name = firstPart.substring(0, equalIndex).trim();
  const value = firstPart.substring(equalIndex + 1).trim();

  const cookie: Cookie = { name, value };

  // Parse attributes
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]?.trim();
    if (!part) continue;

    const lowerPart = part.toLowerCase();
    
    if (lowerPart.startsWith('domain=')) {
      cookie.domain = part.substring(7);
    } else if (lowerPart.startsWith('path=')) {
      cookie.path = part.substring(5);
    } else if (lowerPart.startsWith('expires=')) {
      const dateStr = part.substring(8);
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        cookie.expires = date;
      }
    } else if (lowerPart.startsWith('max-age=')) {
      const maxAge = parseInt(part.substring(8), 10);
      if (!isNaN(maxAge)) {
        cookie.maxAge = maxAge;
        // Convert max-age to expires for easier handling
        cookie.expires = new Date(Date.now() + maxAge * 1000);
      }
    } else if (lowerPart === 'httponly') {
      cookie.httpOnly = true;
    } else if (lowerPart === 'secure') {
      cookie.secure = true;
    } else if (lowerPart.startsWith('samesite=')) {
      const sameSite = part.substring(9) as Cookie['sameSite'];
      if (sameSite && ['Strict', 'Lax', 'None'].includes(sameSite)) {
        cookie.sameSite = sameSite;
      }
    }
  }

  return cookie;
}

/**
 * Parse multiple Set-Cookie headers
 * 
 * @internal
 * @param setCookieHeaders - Array of Set-Cookie header values
 * @returns Array of parsed cookies
 */
export function parseSetCookies(setCookieHeaders: string[]): Cookie[] {
  return setCookieHeaders
    .map(header => parseSetCookie(header))
    .filter((cookie): cookie is Cookie => cookie !== null);
}

/**
 * Serialize cookies into a Cookie header value
 * 
 * @internal
 * @param cookies - Array of cookies to serialize
 * @returns Cookie header value (e.g., "name=value; name2=value2")
 */
export function serializeCookies(cookies: Cookie[]): string {
  return cookies
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Check if a cookie matches the given request URL
 *
 * Validates:
 * - **Domain**: Cookie domain must match or be a parent of the request domain
 * - **Path**: Cookie path must be a prefix of the request path
 * - **Expiration**: Cookie must not be expired
 * - **Secure**: Secure cookies only sent over HTTPS (localhost exempt per spec)
 *
 * **SameSite limitation**: This implementation does not enforce SameSite restrictions.
 * Real browsers block cross-site cookies based on SameSite=Strict/Lax/None, but this
 * test utility sends all matching cookies regardless of SameSite. This is acceptable
 * for most testing scenarios where you control both client and server.
 *
 * @internal
 * @param cookie - The cookie to check
 * @param domain - The request domain (hostname)
 * @param path - The request path
 * @param isSecure - Whether the request uses HTTPS (default: true)
 * @returns True if the cookie should be included in the request
 */
export function cookieMatches(cookie: Cookie, domain: string, path: string, isSecure = true): boolean {
  // Check Secure attribute - secure cookies only sent over HTTPS
  // Exception: localhost is exempt per browser spec (allows testing without HTTPS)
  if (cookie.secure) {
    const isLocalhost = domain === 'localhost' || domain === '127.0.0.1' || domain === '::1';
    if (!isSecure && !isLocalhost) {
      return false;
    }
  }

  // Check domain
  if (cookie.domain) {
    const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    if (!domain.endsWith(cookieDomain)) {
      return false;
    }
  }

  // Check path
  if (cookie.path && !path.startsWith(cookie.path)) {
    return false;
  }

  // Check expiration
  if (cookie.expires && cookie.expires < new Date()) {
    return false;
  }

  return true;
}

/**
 * Cookie parsing and serialization utilities
 * 
 * Simplified implementation for testing framework cookie jar functionality.
 * Handles the essential cookie operations needed for automated testing.
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
 * @param cookies - Array of cookies to serialize
 * @returns Cookie header value (e.g., "name=value; name2=value2")
 */
export function serializeCookies(cookies: Cookie[]): string {
  return cookies
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Check if a cookie matches the given domain and path
 * 
 * @param cookie - The cookie to check
 * @param domain - The request domain
 * @param path - The request path
 * @returns True if the cookie should be included in the request
 */
export function cookieMatches(cookie: Cookie, domain: string, path: string): boolean {
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
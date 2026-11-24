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
  /** Set without a `Domain` attribute, so it goes back only to the exact host that set it. */
  hostOnly?: boolean;
}

/**
 * Whether a host is a secure context over plain `http`, as a browser judges it: `localhost`, the
 * loopback addresses, and every `*.localhost` name.
 *
 * @internal
 */
export function isSecureContextHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || host.endsWith('.localhost');
}

/**
 * Domain-match per RFC 6265 §5.1.3: the host equals the domain, or ends with it on a dot boundary,
 * so `crm.example.com` does not match `xcrm.example.com`.
 *
 * @internal
 */
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Admit a cookie a response set on `url`, as a browser would, or refuse it with `null`.
 *
 * A cookie without `Domain` becomes host-only on the setting host. A `Domain` that does not
 * domain-match the host is refused. A `Secure` cookie needs a secure context to be set. A
 * `__Secure-` name requires `Secure`; a `__Host-` name requires `Secure`, no `Domain`, and
 * `Path=/`. A missing `Path` defaults to `/`.
 *
 * @internal
 */
export function admitSetCookie(cookie: Cookie, url: URL): Cookie | null {
  const host = url.hostname;
  const secureContext = url.protocol === 'https:' || isSecureContextHost(host);
  if (cookie.secure && !secureContext) return null;
  if (cookie.name.startsWith('__Secure-') && !cookie.secure) return null;
  if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.domain !== undefined || cookie.path !== '/')) {
    return null;
  }
  if (cookie.domain !== undefined) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    if (!domainMatches(host, domain)) return null;
    return { ...cookie, domain, path: cookie.path ?? '/' };
  }
  return { ...cookie, domain: host, hostOnly: true, path: cookie.path ?? '/' };
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
      // RFC 6265 §5.2.3: an empty value is ignored, so the cookie stays host-only, and a domain is
      // compared case-insensitively, so it is kept lowercased.
      const domain = part.substring(7).trim().toLowerCase();
      if (domain) cookie.domain = domain;
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
 * - **Domain**: a host-only cookie matches its own host exactly; a domain cookie matches its
 *   domain and every host beneath it, on a dot boundary
 * - **Path**: Cookie path must be a prefix of the request path
 * - **Expiration**: Cookie must not be expired
 * - **Secure**: Secure cookies only sent in a secure context — HTTPS, or a localhost host
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
  // Secure cookies go only to a secure context: HTTPS, or a localhost host over http.
  if (cookie.secure && !isSecure && !isSecureContextHost(domain)) {
    return false;
  }

  // Check domain
  if (cookie.domain) {
    const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    if (cookie.hostOnly ? domain !== cookieDomain : !domainMatches(domain, cookieDomain)) {
      return false;
    }
  }

  // Check path per RFC 6265 §5.1.4:
  // Cookie path matches if (1) exact match, (2) cookie path ends with '/' and is a
  // prefix, or (3) cookie path is a prefix and the next char in the request path is '/'.
  // Simple startsWith is insufficient — '/auth/acme' must NOT match '/auth/acme.crm.tenant'.
  if (cookie.path) {
    if (path !== cookie.path) {
      if (!path.startsWith(cookie.path)) {
        return false;
      }
      if (!cookie.path.endsWith('/') && path[cookie.path.length] !== '/') {
        return false;
      }
    }
  }

  // Check expiration
  if (cookie.expires && cookie.expires < new Date()) {
    return false;
  }

  return true;
}

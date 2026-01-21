import { describe, it, expect } from 'vitest';
import { parseSetCookie, parseSetCookies, serializeCookies, cookieMatches, type Cookie } from '../../src/cookie-utils';

describe('parseSetCookie', () => {
  it('should parse simple cookie', () => {
    const cookie = parseSetCookie('sessionid=abc123');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123'
    });
  });

  it('should parse cookie with domain', () => {
    const cookie = parseSetCookie('sessionid=abc123; Domain=example.com');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      domain: 'example.com'
    });
  });

  it('should parse cookie with path', () => {
    const cookie = parseSetCookie('sessionid=abc123; Path=/api');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      path: '/api'
    });
  });

  it('should parse cookie with expires', () => {
    const cookie = parseSetCookie('sessionid=abc123; Expires=Wed, 21 Oct 2025 07:28:00 GMT');
    expect(cookie?.name).toBe('sessionid');
    expect(cookie?.value).toBe('abc123');
    expect(cookie?.expires).toBeInstanceOf(Date);
    expect(cookie?.expires?.toISOString()).toBe('2025-10-21T07:28:00.000Z');
  });

  it('should parse cookie with max-age', () => {
    const cookie = parseSetCookie('sessionid=abc123; Max-Age=3600');
    expect(cookie?.name).toBe('sessionid');
    expect(cookie?.value).toBe('abc123');
    expect(cookie?.maxAge).toBe(3600);
    expect(cookie?.expires).toBeInstanceOf(Date);
  });

  it('should parse cookie with HttpOnly', () => {
    const cookie = parseSetCookie('sessionid=abc123; HttpOnly');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      httpOnly: true
    });
  });

  it('should parse cookie with Secure', () => {
    const cookie = parseSetCookie('sessionid=abc123; Secure');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      secure: true
    });
  });

  it('should parse cookie with SameSite', () => {
    const cookie = parseSetCookie('sessionid=abc123; SameSite=Strict');
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      sameSite: 'Strict'
    });
  });

  it('should parse cookie with multiple attributes', () => {
    const cookie = parseSetCookie(
      'sessionid=abc123; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax'
    );
    expect(cookie).toEqual({
      name: 'sessionid',
      value: 'abc123',
      domain: 'example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    });
  });

  it('should return null for empty string', () => {
    expect(parseSetCookie('')).toBeNull();
  });

  it('should return null for invalid cookie (no equals sign)', () => {
    expect(parseSetCookie('invalid')).toBeNull();
  });
});

describe('parseSetCookies', () => {
  it('should parse multiple Set-Cookie headers', () => {
    const cookies = parseSetCookies([
      'sessionid=abc123; Domain=example.com',
      'userid=user456; Path=/api'
    ]);

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({
      name: 'sessionid',
      value: 'abc123',
      domain: 'example.com'
    });
    expect(cookies[1]).toEqual({
      name: 'userid',
      value: 'user456',
      path: '/api'
    });
  });

  it('should filter out invalid cookies', () => {
    const cookies = parseSetCookies([
      'sessionid=abc123',
      'invalid',
      'userid=user456'
    ]);

    expect(cookies).toHaveLength(2);
    expect(cookies[0]?.name).toBe('sessionid');
    expect(cookies[1]?.name).toBe('userid');
  });

  it('should return empty array for empty input', () => {
    expect(parseSetCookies([])).toEqual([]);
  });
});

describe('serializeCookies', () => {
  it('should serialize single cookie', () => {
    const cookies: Cookie[] = [
      { name: 'sessionid', value: 'abc123' }
    ];
    expect(serializeCookies(cookies)).toBe('sessionid=abc123');
  });

  it('should serialize multiple cookies', () => {
    const cookies: Cookie[] = [
      { name: 'sessionid', value: 'abc123' },
      { name: 'userid', value: 'user456' }
    ];
    expect(serializeCookies(cookies)).toBe('sessionid=abc123; userid=user456');
  });

  it('should only include name and value (not metadata)', () => {
    const cookies: Cookie[] = [
      {
        name: 'sessionid',
        value: 'abc123',
        domain: 'example.com',
        path: '/',
        httpOnly: true,
        secure: true
      }
    ];
    expect(serializeCookies(cookies)).toBe('sessionid=abc123');
  });

  it('should return empty string for empty array', () => {
    expect(serializeCookies([])).toBe('');
  });
});

describe('cookieMatches', () => {
  describe('domain matching', () => {
    it('should match exact domain', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com'
      };
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
    });

    it('should match subdomain when domain starts with dot', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: '.example.com'
      };
      expect(cookieMatches(cookie, 'sub.example.com', '/')).toBe(true);
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
    });

    it('should not match different domain', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com'
      };
      expect(cookieMatches(cookie, 'other.com', '/')).toBe(false);
    });

    it('should match when no domain specified', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value'
      };
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
      expect(cookieMatches(cookie, 'other.com', '/')).toBe(true);
    });
  });

  describe('path matching', () => {
    it('should match exact path', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        path: '/api'
      };
      expect(cookieMatches(cookie, 'example.com', '/api')).toBe(true);
    });

    it('should match subpath', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        path: '/api'
      };
      expect(cookieMatches(cookie, 'example.com', '/api/users')).toBe(true);
    });

    it('should not match different path', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        path: '/api'
      };
      expect(cookieMatches(cookie, 'example.com', '/admin')).toBe(false);
    });

    it('should match when no path specified', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value'
      };
      expect(cookieMatches(cookie, 'example.com', '/any/path')).toBe(true);
    });
  });

  describe('expiration', () => {
    it('should match non-expired cookie', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        expires: new Date(Date.now() + 86400000) // 24 hours from now
      };
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
    });

    it('should not match expired cookie', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        expires: new Date(Date.now() - 86400000) // 24 hours ago
      };
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(false);
    });

    it('should match when no expiration specified', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value'
      };
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
    });
  });

  describe('secure attribute', () => {
    it('should send secure cookie over HTTPS (isSecure=true)', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        secure: true
      };
      expect(cookieMatches(cookie, 'example.com', '/', true)).toBe(true);
    });

    it('should not send secure cookie over HTTP (isSecure=false)', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        secure: true
      };
      expect(cookieMatches(cookie, 'example.com', '/', false)).toBe(false);
    });

    it('should send non-secure cookie over both HTTP and HTTPS', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        secure: false
      };
      expect(cookieMatches(cookie, 'example.com', '/', true)).toBe(true);
      expect(cookieMatches(cookie, 'example.com', '/', false)).toBe(true);
    });

    it('should default isSecure to true when not provided', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        secure: true
      };
      // Default isSecure=true, so secure cookie should match
      expect(cookieMatches(cookie, 'example.com', '/')).toBe(true);
    });

    describe('localhost exemption', () => {
      it('should send secure cookie to localhost over HTTP', () => {
        const cookie: Cookie = {
          name: 'test',
          value: 'value',
          secure: true
        };
        expect(cookieMatches(cookie, 'localhost', '/', false)).toBe(true);
      });

      it('should send secure cookie to 127.0.0.1 over HTTP', () => {
        const cookie: Cookie = {
          name: 'test',
          value: 'value',
          secure: true
        };
        expect(cookieMatches(cookie, '127.0.0.1', '/', false)).toBe(true);
      });

      it('should send secure cookie to ::1 over HTTP', () => {
        const cookie: Cookie = {
          name: 'test',
          value: 'value',
          secure: true
        };
        expect(cookieMatches(cookie, '::1', '/', false)).toBe(true);
      });

      it('should still block secure cookies to non-localhost over HTTP', () => {
        const cookie: Cookie = {
          name: 'test',
          value: 'value',
          secure: true
        };
        expect(cookieMatches(cookie, 'localhost.example.com', '/', false)).toBe(false);
      });
    });
  });

  describe('combined matching', () => {
    it('should match when all criteria match', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com',
        path: '/api',
        expires: new Date(Date.now() + 86400000)
      };
      expect(cookieMatches(cookie, 'example.com', '/api/users')).toBe(true);
    });

    it('should not match when domain fails', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com',
        path: '/api',
        expires: new Date(Date.now() + 86400000)
      };
      expect(cookieMatches(cookie, 'other.com', '/api/users')).toBe(false);
    });

    it('should not match when path fails', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com',
        path: '/api',
        expires: new Date(Date.now() + 86400000)
      };
      expect(cookieMatches(cookie, 'example.com', '/admin')).toBe(false);
    });

    it('should not match when expired', () => {
      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: 'example.com',
        path: '/api',
        expires: new Date(Date.now() - 86400000)
      };
      expect(cookieMatches(cookie, 'example.com', '/api/users')).toBe(false);
    });
  });
});

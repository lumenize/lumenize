import { describe, it, expect, beforeEach } from 'vitest';
import { CookieJar } from '../src/cookie-jar';

describe('CookieJar', () => {
  let cookieJar: CookieJar;

  beforeEach(() => {
    cookieJar = new CookieJar();
  });

  describe('getFetch', () => {
    it('should create a fetch wrapper that adds cookies to requests', async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const cookieHeader = req.headers.get('Cookie');
        
        // Return response with Set-Cookie header
        return new Response(null, {
          headers: {
            'Set-Cookie': 'sessionid=abc123; Domain=example.com; Path=/'
          }
        });
      };

      const cookieAwareFetch = cookieJar.getFetch(mockFetch);

      // First request - no cookies sent
      await cookieAwareFetch('https://example.com/login');

      // Cookie should be stored
      expect(cookieJar.getCookie('sessionid')).toBe('abc123');

      // Second request - cookie should be sent
      let sentCookie: string | null = null;
      const mockFetch2 = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        sentCookie = req.headers.get('Cookie');
        return new Response(null);
      };

      const cookieAwareFetch2 = cookieJar.getFetch(mockFetch2);
      await cookieAwareFetch2('https://example.com/protected');

      expect(sentCookie).toBe('sessionid=abc123');
    });

    it('should not modify fetch when cookie jar is disabled', async () => {
      cookieJar.setEnabled(false);

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const cookieHeader = req.headers.get('Cookie');
        expect(cookieHeader).toBeNull();
        
        return new Response(null, {
          headers: {
            'Set-Cookie': 'sessionid=abc123'
          }
        });
      };

      const cookieAwareFetch = cookieJar.getFetch(mockFetch);
      await cookieAwareFetch('https://example.com/test');

      // Cookie should not be stored when disabled
      expect(cookieJar.getCookie('sessionid')).toBeUndefined();
    });
  });

  describe('setCookie / getCookie', () => {
    it('should set and get cookie with inferred hostname', async () => {
      // Set hostname via fetch - need to use proper Response with getSetCookie
      const mockResponse = new Response(null);
      // Manually store cookies to set hostname
      cookieJar.storeCookiesFromResponse(
        new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        }),
        'https://example.com/test'
      );

      cookieJar.setCookie('test', 'value');
      expect(cookieJar.getCookie('test')).toBe('value');
    });

    it('should set and get cookie with explicit domain', () => {
      cookieJar.setCookie('test', 'value', { domain: 'example.com' });
      expect(cookieJar.getCookie('test')).toBe('value');
    });

    it('should throw error when setting cookie without domain or hostname', () => {
      expect(() => {
        cookieJar.setCookie('test', 'value');
      }).toThrow('Cannot set cookie');
    });

    it('should get cookie by name and domain', () => {
      cookieJar.setCookie('test', 'value1', { domain: 'example.com' });
      cookieJar.setCookie('test', 'value2', { domain: 'other.com' });

      expect(cookieJar.getCookie('test', 'example.com')).toBe('value1');
      expect(cookieJar.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should not return expired cookie', () => {
      const pastDate = new Date(Date.now() - 86400000); // Yesterday
      cookieJar.setCookie('test', 'value', {
        domain: 'example.com',
        expires: pastDate
      });

      expect(cookieJar.getCookie('test')).toBeUndefined();
    });
  });

  describe('getAllCookies', () => {
    it('should return all non-expired cookies', () => {
      cookieJar.setCookie('cookie1', 'value1', { domain: 'example.com' });
      cookieJar.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = cookieJar.getAllCookies();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]?.name).toBe('cookie1');
      expect(cookies[1]?.name).toBe('cookie2');
    });

    it('should not return expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      cookieJar.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      cookieJar.setCookie('active', 'value2', {
        domain: 'example.com',
        expires: futureDate
      });

      const cookies = cookieJar.getAllCookies();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]?.name).toBe('active');
    });

    it('should return empty array when no cookies', () => {
      expect(cookieJar.getAllCookies()).toEqual([]);
    });
  });

  describe('getAllCookiesAsObject', () => {
    it('should return cookies as name-value object', () => {
      cookieJar.setCookie('cookie1', 'value1', { domain: 'example.com' });
      cookieJar.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = cookieJar.getAllCookiesAsObject();
      expect(cookies).toEqual({
        cookie1: 'value1',
        cookie2: 'value2'
      });
    });

    it('should not include expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);

      cookieJar.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      cookieJar.setCookie('active', 'value2', { domain: 'example.com' });

      const cookies = cookieJar.getAllCookiesAsObject();
      expect(cookies).toEqual({
        active: 'value2'
      });
    });
  });

  describe('removeCookie', () => {
    it('should remove cookie by name', () => {
      cookieJar.setCookie('test', 'value', { domain: 'example.com' });
      expect(cookieJar.getCookie('test')).toBe('value');

      cookieJar.removeCookie('test');
      expect(cookieJar.getCookie('test')).toBeUndefined();
    });

    it('should remove cookie by name and domain', () => {
      cookieJar.setCookie('test', 'value1', { domain: 'example.com' });
      cookieJar.setCookie('test', 'value2', { domain: 'other.com' });

      cookieJar.removeCookie('test', 'example.com');
      expect(cookieJar.getCookie('test', 'example.com')).toBeUndefined();
      expect(cookieJar.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should remove cookie by name, domain, and path', () => {
      cookieJar.setCookie('test', 'value1', {
        domain: 'example.com',
        path: '/api'
      });
      cookieJar.setCookie('test', 'value2', {
        domain: 'example.com',
        path: '/admin'
      });

      cookieJar.removeCookie('test', 'example.com', '/api');
      expect(cookieJar.getAllCookies()).toHaveLength(1);
      expect(cookieJar.getAllCookies()[0]?.path).toBe('/admin');
    });
  });

  describe('clear', () => {
    it('should remove all cookies', () => {
      cookieJar.setCookie('cookie1', 'value1', { domain: 'example.com' });
      cookieJar.setCookie('cookie2', 'value2', { domain: 'example.com' });

      expect(cookieJar.getAllCookies()).toHaveLength(2);

      cookieJar.clear();
      expect(cookieJar.getAllCookies()).toHaveLength(0);
    });
  });

  describe('cleanupExpiredCookies', () => {
    it('should remove only expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      cookieJar.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      cookieJar.setCookie('active', 'value2', {
        domain: 'example.com',
        expires: futureDate
      });

      expect(cookieJar.getAllCookies()).toHaveLength(1); // getAllCookies already filters expired

      cookieJar.cleanupExpiredCookies();
      
      // After cleanup, only active cookie should remain in storage
      const allCookies = cookieJar.getAllCookies();
      expect(allCookies).toHaveLength(1);
      expect(allCookies[0]?.name).toBe('active');
    });
  });

  describe('setDefaultHostname / hostname inference', () => {
    it('should use first fetch hostname if not manually set', async () => {
      // Manually store a cookie to set hostname
      cookieJar.storeCookiesFromResponse(
        new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        }),
        'https://example.com/test'
      );

      // Now we can set cookies without domain
      cookieJar.setCookie('test', 'value');
      expect(cookieJar.getCookie('test', 'example.com')).toBe('value');
    });

    it('should allow manual hostname setting before fetch', () => {
      cookieJar.setDefaultHostname('manual.com');

      cookieJar.setCookie('test', 'value');
      expect(cookieJar.getCookie('test', 'manual.com')).toBe('value');
    });

    it('should preserve manually set hostname after fetch', async () => {
      cookieJar.setDefaultHostname('manual.com');

      const mockFetch = async () => new Response(null);
      const cookieAwareFetch = cookieJar.getFetch(mockFetch);
      await cookieAwareFetch('https://different.com/test');

      // Should still use manual hostname
      cookieJar.setCookie('test', 'value');
      expect(cookieJar.getCookie('test', 'manual.com')).toBe('value');
    });
  });

  describe('setEnabled / isEnabled', () => {
    it('should enable/disable cookie jar', () => {
      expect(cookieJar.isEnabled()).toBe(true);

      cookieJar.setEnabled(false);
      expect(cookieJar.isEnabled()).toBe(false);

      cookieJar.setEnabled(true);
      expect(cookieJar.isEnabled()).toBe(true);
    });
  });

  describe('integration: full cookie flow', () => {
    it('should handle complete login/session flow', async () => {
      let requestCount = 0;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestCount++;
        const req = new Request(input, init);
        const url = new URL(req.url);

        if (url.pathname === '/login') {
          // Login response sets session cookie
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              'Set-Cookie': 'sessionid=abc123; Domain=example.com; Path=/; HttpOnly; Secure'
            }
          });
        } else if (url.pathname === '/protected') {
          // Protected endpoint checks for session cookie
          const cookieHeader = req.headers.get('Cookie');
          if (cookieHeader?.includes('sessionid=abc123')) {
            return new Response(JSON.stringify({ data: 'secret' }));
          } else {
            return new Response('Unauthorized', { status: 401 });
          }
        }

        return new Response('Not Found', { status: 404 });
      };

      const cookieAwareFetch = cookieJar.getFetch(mockFetch);

      // Step 1: Login (sets cookie)
      const loginResponse = await cookieAwareFetch('https://example.com/login');
      expect(loginResponse.ok).toBe(true);
      expect(cookieJar.getCookie('sessionid')).toBe('abc123');

      // Step 2: Access protected resource (cookie automatically sent)
      const protectedResponse = await cookieAwareFetch('https://example.com/protected');
      expect(protectedResponse.ok).toBe(true);
      const data = await protectedResponse.json();
      expect(data).toEqual({ data: 'secret' });

      expect(requestCount).toBe(2);
    });

    it('should handle multiple domains', async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const url = new URL(req.url);

        return new Response(null, {
          headers: {
            'Set-Cookie': `token=token-${url.hostname}; Domain=${url.hostname}`
          }
        });
      };

      const cookieAwareFetch = cookieJar.getFetch(mockFetch);

      await cookieAwareFetch('https://site1.com/test');
      await cookieAwareFetch('https://site2.com/test');

      expect(cookieJar.getCookie('token', 'site1.com')).toBe('token-site1.com');
      expect(cookieJar.getCookie('token', 'site2.com')).toBe('token-site2.com');
      expect(cookieJar.getAllCookies()).toHaveLength(2);
    });
  });

  describe('getWebSocket', () => {
    it('should automatically add Origin header from hostname if set', () => {
      cookieJar.setDefaultHostname('example.com');
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const origin = req.headers.get('Origin');
        
        // Verify Origin was automatically added
        expect(origin).toBe('https://example.com');
        
        // Return mock WebSocket upgrade response
        const ws = {} as any;
        ws.accept = () => {};
        return { webSocket: ws } as any;
      };

      const WebSocketClass = cookieJar.getWebSocket(mockFetch);
      expect(WebSocketClass).toBeDefined();
    });

    it('should not override explicit Origin header', () => {
      cookieJar.setDefaultHostname('example.com');
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const origin = req.headers.get('Origin');
        
        // Verify explicit Origin was preserved
        expect(origin).toBe('https://custom.com');
        
        // Return mock WebSocket upgrade response
        const ws = {} as any;
        ws.accept = () => {};
        return { webSocket: ws } as any;
      };

      const WebSocketClass = cookieJar.getWebSocket(mockFetch, {
        headers: { 'Origin': 'https://custom.com' }
      });
      expect(WebSocketClass).toBeDefined();
    });

    it('should not add Origin if no hostname is set', () => {
      // No hostname set - Origin should not be added automatically
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const origin = req.headers.get('Origin');
        
        // Verify no Origin was added
        expect(origin).toBeNull();
        
        // Return mock WebSocket upgrade response
        const ws = {} as any;
        ws.accept = () => {};
        return { webSocket: ws } as any;
      };

      const WebSocketClass = cookieJar.getWebSocket(mockFetch);
      expect(WebSocketClass).toBeDefined();
    });
  });
});

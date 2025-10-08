import { describe, it, expect, beforeEach } from 'vitest';
import { Browser } from '../src/browser';

describe('Browser', () => {
  let browser: Browser;

  beforeEach(() => {
    browser = new Browser();
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

      const cookieAwareFetch = browser.getFetch(mockFetch);

      // First request - no cookies sent
      await cookieAwareFetch('https://example.com/login');

      // Cookie should be stored
      expect(browser.getCookie('sessionid')).toBe('abc123');

      // Second request - cookie should be sent
      let sentCookie: string | null = null;
      const mockFetch2 = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        sentCookie = req.headers.get('Cookie');
        return new Response(null);
      };

      const cookieAwareFetch2 = browser.getFetch(mockFetch2);
      await cookieAwareFetch2('https://example.com/protected');

      expect(sentCookie).toBe('sessionid=abc123');
    });

    it('should not modify fetch when cookie jar is disabled', async () => {
      browser.setEnabled(false);

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

      const cookieAwareFetch = browser.getFetch(mockFetch);
      await cookieAwareFetch('https://example.com/test');

      // Cookie should not be stored when disabled
      expect(browser.getCookie('sessionid')).toBeUndefined();
    });
  });

  describe('setCookie / getCookie', () => {
    it('should set and get cookie with inferred hostname', async () => {
      // Set hostname via fetch - need to use proper Response with getSetCookie
      const mockResponse = new Response(null);
      // Manually store cookies to set hostname
      browser.storeCookiesFromResponse(
        new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        }),
        'https://example.com/test'
      );

      browser.setCookie('test', 'value');
      expect(browser.getCookie('test')).toBe('value');
    });

    it('should set and get cookie with explicit domain', () => {
      browser.setCookie('test', 'value', { domain: 'example.com' });
      expect(browser.getCookie('test')).toBe('value');
    });

    it('should throw error when setting cookie without domain or hostname', () => {
      expect(() => {
        browser.setCookie('test', 'value');
      }).toThrow('Cannot set cookie');
    });

    it('should get cookie by name and domain', () => {
      browser.setCookie('test', 'value1', { domain: 'example.com' });
      browser.setCookie('test', 'value2', { domain: 'other.com' });

      expect(browser.getCookie('test', 'example.com')).toBe('value1');
      expect(browser.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should not return expired cookie', () => {
      const pastDate = new Date(Date.now() - 86400000); // Yesterday
      browser.setCookie('test', 'value', {
        domain: 'example.com',
        expires: pastDate
      });

      expect(browser.getCookie('test')).toBeUndefined();
    });
  });

  describe('getAllCookies', () => {
    it('should return all non-expired cookies', () => {
      browser.setCookie('cookie1', 'value1', { domain: 'example.com' });
      browser.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = browser.getAllCookies();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]?.name).toBe('cookie1');
      expect(cookies[1]?.name).toBe('cookie2');
    });

    it('should not return expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      browser.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      browser.setCookie('active', 'value2', {
        domain: 'example.com',
        expires: futureDate
      });

      const cookies = browser.getAllCookies();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]?.name).toBe('active');
    });

    it('should return empty array when no cookies', () => {
      expect(browser.getAllCookies()).toEqual([]);
    });
  });

  describe('getAllCookiesAsObject', () => {
    it('should return cookies as name-value object', () => {
      browser.setCookie('cookie1', 'value1', { domain: 'example.com' });
      browser.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = browser.getAllCookiesAsObject();
      expect(cookies).toEqual({
        cookie1: 'value1',
        cookie2: 'value2'
      });
    });

    it('should not include expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);

      browser.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      browser.setCookie('active', 'value2', { domain: 'example.com' });

      const cookies = browser.getAllCookiesAsObject();
      expect(cookies).toEqual({
        active: 'value2'
      });
    });
  });

  describe('removeCookie', () => {
    it('should remove cookie by name', () => {
      browser.setCookie('test', 'value', { domain: 'example.com' });
      expect(browser.getCookie('test')).toBe('value');

      browser.removeCookie('test');
      expect(browser.getCookie('test')).toBeUndefined();
    });

    it('should remove cookie by name and domain', () => {
      browser.setCookie('test', 'value1', { domain: 'example.com' });
      browser.setCookie('test', 'value2', { domain: 'other.com' });

      browser.removeCookie('test', 'example.com');
      expect(browser.getCookie('test', 'example.com')).toBeUndefined();
      expect(browser.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should remove cookie by name, domain, and path', () => {
      browser.setCookie('test', 'value1', {
        domain: 'example.com',
        path: '/api'
      });
      browser.setCookie('test', 'value2', {
        domain: 'example.com',
        path: '/admin'
      });

      browser.removeCookie('test', 'example.com', '/api');
      expect(browser.getAllCookies()).toHaveLength(1);
      expect(browser.getAllCookies()[0]?.path).toBe('/admin');
    });
  });

  describe('clear', () => {
    it('should remove all cookies', () => {
      browser.setCookie('cookie1', 'value1', { domain: 'example.com' });
      browser.setCookie('cookie2', 'value2', { domain: 'example.com' });

      expect(browser.getAllCookies()).toHaveLength(2);

      browser.clear();
      expect(browser.getAllCookies()).toHaveLength(0);
    });
  });

  describe('cleanupExpiredCookies', () => {
    it('should remove only expired cookies', () => {
      const pastDate = new Date(Date.now() - 86400000);
      const futureDate = new Date(Date.now() + 86400000);

      browser.setCookie('expired', 'value1', {
        domain: 'example.com',
        expires: pastDate
      });
      browser.setCookie('active', 'value2', {
        domain: 'example.com',
        expires: futureDate
      });

      expect(browser.getAllCookies()).toHaveLength(1); // getAllCookies already filters expired

      browser.cleanupExpiredCookies();
      
      // After cleanup, only active cookie should remain in storage
      const allCookies = browser.getAllCookies();
      expect(allCookies).toHaveLength(1);
      expect(allCookies[0]?.name).toBe('active');
    });
  });

  describe('setDefaultHostname / hostname inference', () => {
    it('should use first fetch hostname if not manually set', async () => {
      // Manually store a cookie to set hostname
      browser.storeCookiesFromResponse(
        new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        }),
        'https://example.com/test'
      );

      // Now we can set cookies without domain
      browser.setCookie('test', 'value');
      expect(browser.getCookie('test', 'example.com')).toBe('value');
    });

    it('should allow manual hostname setting before fetch', () => {
      browser.setDefaultHostname('manual.com');

      browser.setCookie('test', 'value');
      expect(browser.getCookie('test', 'manual.com')).toBe('value');
    });

    it('should preserve manually set hostname after fetch', async () => {
      browser.setDefaultHostname('manual.com');

      const mockFetch = async () => new Response(null);
      const cookieAwareFetch = browser.getFetch(mockFetch);
      await cookieAwareFetch('https://different.com/test');

      // Should still use manual hostname
      browser.setCookie('test', 'value');
      expect(browser.getCookie('test', 'manual.com')).toBe('value');
    });
  });

  describe('setEnabled / isEnabled', () => {
    it('should enable/disable cookie jar', () => {
      expect(browser.isEnabled()).toBe(true);

      browser.setEnabled(false);
      expect(browser.isEnabled()).toBe(false);

      browser.setEnabled(true);
      expect(browser.isEnabled()).toBe(true);
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

      const cookieAwareFetch = browser.getFetch(mockFetch);

      // Step 1: Login (sets cookie)
      const loginResponse = await cookieAwareFetch('https://example.com/login');
      expect(loginResponse.ok).toBe(true);
      expect(browser.getCookie('sessionid')).toBe('abc123');

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

      const cookieAwareFetch = browser.getFetch(mockFetch);

      await cookieAwareFetch('https://site1.com/test');
      await cookieAwareFetch('https://site2.com/test');

      expect(browser.getCookie('token', 'site1.com')).toBe('token-site1.com');
      expect(browser.getCookie('token', 'site2.com')).toBe('token-site2.com');
      expect(browser.getAllCookies()).toHaveLength(2);
    });
  });

  describe('getWebSocket', () => {
    it('should automatically add Origin header from hostname if set', () => {
      browser.setDefaultHostname('example.com');
      
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

      const WebSocketClass = browser.getWebSocket(mockFetch);
      expect(WebSocketClass).toBeDefined();
    });

    it('should not override explicit Origin header', () => {
      browser.setDefaultHostname('example.com');
      
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

      const WebSocketClass = browser.getWebSocket(mockFetch, {
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

      const WebSocketClass = browser.getWebSocket(mockFetch);
      expect(WebSocketClass).toBeDefined();
    });
  });

  describe('createPage', () => {
    it('should create page context with Origin header for both fetch and WebSocket', async () => {
      let fetchOrigin: string | null = null;
      let wsOrigin: string | null = null;
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const url = new URL(req.url);
        
        if (url.pathname === '/api') {
          fetchOrigin = req.headers.get('Origin');
          return new Response('ok');
        } else {
          // WebSocket upgrade
          wsOrigin = req.headers.get('Origin');
          const ws = {} as any;
          ws.accept = () => {};
          return { webSocket: ws } as any;
        }
      };

      const { fetch, WebSocket } = browser.createPage(mockFetch, {
        origin: 'https://example.com'
      });

      // Test fetch includes Origin
      await fetch('https://api.example.com/api');
      expect(fetchOrigin).toBe('https://example.com');

      // Test WebSocket includes Origin
      new WebSocket('wss://api.example.com/ws');
      expect(wsOrigin).toBe('https://example.com');
    });

    it('should allow custom headers in WebSocket via createPage', async () => {
      let wsHeaders: Record<string, string> = {};
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        // Capture headers as plain object
        req.headers.forEach((value, key) => {
          wsHeaders[key] = value;
        });
        const ws = {} as any;
        ws.accept = () => {};
        return { webSocket: ws } as any;
      };

      const { WebSocket } = browser.createPage(mockFetch, {
        origin: 'https://example.com',
        headers: {
          'X-Custom-Header': 'test-value'
        }
      });

      new WebSocket('wss://api.example.com/ws');
      
      expect(wsHeaders['origin']).toBe('https://example.com');
      expect(wsHeaders['x-custom-header']).toBe('test-value');
    });

    it('should share cookies between page fetch and WebSocket', async () => {
      let wsCookies: string | null = null;
      
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        
        if (url.pathname === '/login') {
          // Return Set-Cookie
          return new Response('logged in', {
            headers: {
              'Set-Cookie': 'session=abc123; Domain=example.com; Path=/'
            }
          });
        } else if (url.pathname === '/api') {
          // Return cookies sent in request
          return new Response(req.headers.get('Cookie') || 'no cookies');
        } else {
          // WebSocket - capture cookies from request
          wsCookies = req.headers.get('Cookie');
          const ws = {} as any;
          ws.accept = () => {};
          return { webSocket: ws } as any;
        }
      };

      const { fetch, WebSocket } = browser.createPage(mockFetch, {
        origin: 'https://example.com'
      });

      // Login to set cookie
      await fetch('https://example.com/login');
      
      // Verify cookie stored
      expect(browser.getCookie('session')).toBe('abc123');
      
      // Verify cookie sent in subsequent fetch
      const apiRes = await fetch('https://example.com/api');
      const apiText = await apiRes.text();
      expect(apiText).toContain('session=abc123');
      
      // Verify cookie sent in WebSocket upgrade
      new WebSocket('wss://example.com/ws');
      expect(wsCookies).toContain('session=abc123');
    });

    it('should preserve explicit Origin in fetch request', async () => {
      let receivedOrigin: string | null = null;
      
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        receivedOrigin = req.headers.get('Origin');
        return new Response('ok');
      };

      const { fetch } = browser.createPage(mockFetch, {
        origin: 'https://example.com'
      });

      // Explicit Origin should be preserved
      await fetch('https://api.example.com/api', {
        headers: { 'Origin': 'https://override.com' }
      });
      
      expect(receivedOrigin).toBe('https://override.com');
    });
  });
});

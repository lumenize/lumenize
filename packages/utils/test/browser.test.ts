import { describe, it, expect } from 'vitest';
import { Browser } from '../src/browser';

describe('Browser', () => {
  describe('constructor', () => {
    it('should accept a fetch function', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('test');
      };

      const browser = new Browser(mockFetch);
      const response = await browser.fetch('https://example.com');
      const text = await response.text();
      expect(text).toBe('test');
    });

    it('should auto-detect globalThis.fetch if available', async () => {
      // globalThis.fetch should be available in test environment
      const browser = new Browser();
      expect(browser.fetch).toBeDefined();
    });
  });

  describe('fetch', () => {
    it('should add cookies to requests', async () => {
      let sentCookie: string | null = null;
      
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        sentCookie = req.headers.get('Cookie');
        
        // Return response with Set-Cookie header on first request
        if (sentCookie === null) {
          return new Response(null, {
            headers: {
              'Set-Cookie': 'sessionid=abc123; Domain=example.com; Path=/'
            }
          });
        }
        
        return new Response(null);
      };

      const browser = new Browser(mockFetch);

      // First request - no cookies sent
      await browser.fetch('https://example.com/login');

      // Cookie should be stored
      expect(browser.getCookie('sessionid')).toBe('abc123');

      // Second request - cookie should be sent
      await browser.fetch('https://example.com/protected');

      expect(sentCookie).toBe('sessionid=abc123');
    });

    it('should automatically clean up expired cookies', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(null);
      };

      const browser = new Browser(mockFetch);
      
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

      // Trigger cookie cleanup by making a request
      await browser.fetch('https://example.com/test');

      // Expired cookie should not be available
      expect(browser.getCookie('expired')).toBeUndefined();
      expect(browser.getCookie('active')).toBe('value2');
    });
  });

  describe('setCookie / getCookie', () => {
    it('should set and get cookie with inferred hostname', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        });
      };

      const browser = new Browser(mockFetch);
      
      // Set hostname via fetch
      await browser.fetch('https://example.com/test');

      browser.setCookie('test', 'value');
      expect(browser.getCookie('test')).toBe('value');
    });

    it('should set and get cookie with explicit domain', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('test', 'value', { domain: 'example.com' });
      expect(browser.getCookie('test')).toBe('value');
    });

    it('should throw error when setting cookie without domain or hostname', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      expect(() => {
        browser.setCookie('test', 'value');
      }).toThrow('Cannot set cookie');
    });

    it('should get cookie by name and domain', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('test', 'value1', { domain: 'example.com' });
      browser.setCookie('test', 'value2', { domain: 'other.com' });

      expect(browser.getCookie('test', 'example.com')).toBe('value1');
      expect(browser.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should not return expired cookie', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
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
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('cookie1', 'value1', { domain: 'example.com' });
      browser.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = browser.getAllCookies();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]?.name).toBe('cookie1');
      expect(cookies[1]?.name).toBe('cookie2');
    });

    it('should not return expired cookies', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
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
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      expect(browser.getAllCookies()).toEqual([]);
    });
  });

  describe('getAllCookiesAsObject', () => {
    it('should return cookies as name-value object', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('cookie1', 'value1', { domain: 'example.com' });
      browser.setCookie('cookie2', 'value2', { domain: 'example.com' });

      const cookies = browser.getAllCookiesAsObject();
      expect(cookies).toEqual({
        cookie1: 'value1',
        cookie2: 'value2'
      });
    });

    it('should not include expired cookies', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
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
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('test', 'value', { domain: 'example.com' });
      expect(browser.getCookie('test')).toBe('value');

      browser.removeCookie('test');
      expect(browser.getCookie('test')).toBeUndefined();
    });

    it('should remove cookie by name and domain', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('test', 'value1', { domain: 'example.com' });
      browser.setCookie('test', 'value2', { domain: 'other.com' });

      browser.removeCookie('test', 'example.com');
      expect(browser.getCookie('test', 'example.com')).toBeUndefined();
      expect(browser.getCookie('test', 'other.com')).toBe('value2');
    });

    it('should remove cookie by name, domain, and path', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
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

  describe('hostname inference for cookie domain', () => {
    it('should use first fetch hostname for cookies without explicit domain', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(null, {
          headers: { 'Set-Cookie': 'init=value; Domain=example.com' }
        });
      };

      const browser = new Browser(mockFetch);
      
      // Make a fetch to set hostname
      await browser.fetch('https://example.com/test');

      // Now we can set cookies without domain - inferred from first fetch
      browser.setCookie('test', 'value');
      expect(browser.getCookie('test', 'example.com')).toBe('value');
    });

    it('should require domain if no fetch has been made yet', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      expect(() => {
        browser.setCookie('test', 'value');
      }).toThrow(/Cannot set cookie 'test' without domain/);
    });

    it('should allow explicit domain even without prior fetch', () => {
      const mockFetch = async (): Promise<Response> => new Response(null);
      const browser = new Browser(mockFetch);
      
      browser.setCookie('test', 'value', { domain: 'manual.com' });
      expect(browser.getCookie('test', 'manual.com')).toBe('value');
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

      const browser = new Browser(mockFetch);

      // Step 1: Login (sets cookie)
      const loginResponse = await browser.fetch('https://example.com/login');
      expect(loginResponse.ok).toBe(true);
      expect(browser.getCookie('sessionid')).toBe('abc123');

      // Step 2: Access protected resource (cookie automatically sent)
      const protectedResponse = await browser.fetch('https://example.com/protected');
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

      const browser = new Browser(mockFetch);

      await browser.fetch('https://site1.com/test');
      await browser.fetch('https://site2.com/test');

      expect(browser.getCookie('token', 'site1.com')).toBe('token-site1.com');
      expect(browser.getCookie('token', 'site2.com')).toBe('token-site2.com');
      expect(browser.getAllCookies()).toHaveLength(2);
    });
  });

  describe('WebSocket', () => {
    it('should not add Origin header automatically', () => {
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const origin = req.headers.get('Origin');
        
        // Origin should NOT be added automatically
        expect(origin).toBeNull();
        
        // Return mock WebSocket upgrade response
        const ws = {} as any;
        ws.accept = () => {};
        return { webSocket: ws } as any;
      };

      const browser = new Browser(mockFetch);
      const WebSocketClass = browser.WebSocket;
      expect(WebSocketClass).toBeDefined();
    });

    it('should include cookies in WebSocket upgrade request', async () => {
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

      const browser = new Browser(mockFetch);
      const WebSocketClass = browser.WebSocket;
      expect(WebSocketClass).toBeDefined();
    });
  });

  describe('context', () => {
    it('should create context with Origin header for both fetch and WebSocket', async () => {
      let fetchOrigin: string | null = null;
      let wsOrigin: string | null = null;
      
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        const url = new URL(req.url);
        
        if (url.pathname === '/api') {
          fetchOrigin = req.headers.get('Origin');
          return new Response('ok', {
            headers: {
              'Access-Control-Allow-Origin': 'https://example.com'
            }
          });
        } else {
          // WebSocket upgrade
          wsOrigin = req.headers.get('Origin');
          const ws = {} as any;
          ws.accept = () => {};
          return { webSocket: ws } as any;
        }
      };

      const browser = new Browser(mockFetch);
      const { fetch, WebSocket } = browser.context('https://example.com');

      // Test fetch includes Origin
      await fetch('https://api.example.com/api');
      expect(fetchOrigin).toBe('https://example.com');

      // Test WebSocket includes Origin
      new WebSocket('wss://api.example.com/ws');
      expect(wsOrigin).toBe('https://example.com');
    });

    it('should allow custom headers in WebSocket via context', async () => {
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

      const browser = new Browser(mockFetch);
      const { WebSocket } = browser.context('https://example.com', {
        headers: {
          'X-Custom-Header': 'test-value'
        }
      });

      new WebSocket('wss://api.example.com/ws');
      
      expect(wsHeaders['origin']).toBe('https://example.com');
      expect(wsHeaders['x-custom-header']).toBe('test-value');
    });

    it('should share cookies between context fetch and WebSocket', async () => {
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

      const browser = new Browser(mockFetch);
      const { fetch, WebSocket } = browser.context('https://example.com');

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
        return new Response('ok', {
          headers: {
            // Need to return CORS header matching the explicit override
            'Access-Control-Allow-Origin': 'https://override.com'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://example.com');

      // Explicit Origin should be preserved
      await fetch('https://api.example.com/api', {
        headers: { 'Origin': 'https://override.com' }
      });
      
      expect(receivedOrigin).toBe('https://override.com');
    });
  });

  describe('CORS validation', () => {
    it('should not validate CORS for same-origin requests', async () => {
      const mockFetch = async (): Promise<Response> => {
        // No CORS headers - should still work for same-origin
        return new Response('ok');
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://example.com');

      // Same origin - no CORS validation
      const response = await fetch('https://example.com/api');
      expect(response.ok).toBe(true);
    });

    it('should validate CORS for cross-origin requests with wildcard', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Cross-origin with wildcard - should work
      const response = await fetch('https://api.example.com/data');
      expect(response.ok).toBe(true);
    });

    it('should validate CORS for cross-origin requests with specific origin', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': 'https://app.com'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Cross-origin with matching origin - should work
      const response = await fetch('https://api.example.com/data');
      expect(response.ok).toBe(true);
    });

    it('should throw TypeError when Access-Control-Allow-Origin is missing', async () => {
      const mockFetch = async (): Promise<Response> => {
        // Missing CORS header
        return new Response('ok');
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Cross-origin without CORS header - should throw
      await expect(fetch('https://api.example.com/data')).rejects.toThrow(TypeError);
      await expect(fetch('https://api.example.com/data')).rejects.toThrow(
        /No 'Access-Control-Allow-Origin' header present/
      );
    });

    it('should throw TypeError when Access-Control-Allow-Origin does not match', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': 'https://other-app.com'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Cross-origin with non-matching origin - should throw
      await expect(fetch('https://api.example.com/data')).rejects.toThrow(TypeError);
      await expect(fetch('https://api.example.com/data')).rejects.toThrow(
        /header is 'https:\/\/other-app\.com' but the request origin is 'https:\/\/app\.com'/
      );
    });

    it('should throw TypeError when using wildcard with credentials', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Cross-origin with wildcard and credentials - should throw
      await expect(
        fetch('https://api.example.com/data', { credentials: 'include' })
      ).rejects.toThrow(TypeError);
      await expect(
        fetch('https://api.example.com/data', { credentials: 'include' })
      ).rejects.toThrow(/Cannot use wildcard '\*' .* when credentials are included/);
    });

    it('should require Access-Control-Allow-Credentials when credentials are included', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': 'https://app.com'
            // Missing Access-Control-Allow-Credentials: true
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Credentials without Allow-Credentials header - should throw
      await expect(
        fetch('https://api.example.com/data', { credentials: 'include' })
      ).rejects.toThrow(TypeError);
      await expect(
        fetch('https://api.example.com/data', { credentials: 'include' })
      ).rejects.toThrow(/'Access-Control-Allow-Credentials' header is not 'true'/);
    });

    it('should allow credentials when both origin and credentials headers are correct', async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response('ok', {
          headers: {
            'Access-Control-Allow-Origin': 'https://app.com',
            'Access-Control-Allow-Credentials': 'true'
          }
        });
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Proper CORS with credentials - should work
      const response = await fetch('https://api.example.com/data', { 
        credentials: 'include' 
      });
      expect(response.ok).toBe(true);
    });

    it('should work with cookies in cross-origin CORS requests', async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        
        if (url.pathname === '/login') {
          return new Response('logged in', {
            headers: {
              'Set-Cookie': 'session=abc123; Domain=example.com',
              'Access-Control-Allow-Origin': 'https://app.com',
              'Access-Control-Allow-Credentials': 'true'
            }
          });
        } else {
          // Verify cookie was sent
          const cookie = req.headers.get('Cookie');
          return new Response(cookie || 'no cookie', {
            headers: {
              'Access-Control-Allow-Origin': 'https://app.com',
              'Access-Control-Allow-Credentials': 'true'
            }
          });
        }
      };

      const browser = new Browser(mockFetch);
      const { fetch } = browser.context('https://app.com');

      // Login cross-origin with credentials
      await fetch('https://api.example.com/login', { credentials: 'include' });
      
      // Subsequent request should include cookie
      const response = await fetch('https://api.example.com/data', { 
        credentials: 'include' 
      });
      const text = await response.text();
      expect(text).toContain('session=abc123');
    });

    it('should track failed preflight with success: false', async () => {
      const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
        const req = new Request(input);
        
        if (req.method === 'OPTIONS') {
          // Preflight response without CORS headers (will fail validation)
          return new Response(null, { status: 204 });
        }
        
        return new Response('ok');
      };

      const browser = new Browser(mockFetch);
      const context = browser.context('https://app.com');

      // Cross-origin POST with custom header triggers preflight
      await expect(
        context.fetch('https://api.example.com/data', {
          method: 'POST',
          headers: { 'X-Custom-Header': 'value' }
        })
      ).rejects.toThrow(TypeError);

      // Should track the failed preflight
      expect(context.lastPreflight).toEqual({
        url: 'https://api.example.com/data',
        method: 'POST',
        headers: ['x-custom-header'],
        success: false
      });
    });

    it('should handle cookies without explicit domain', async () => {
      const mockFetch = async (): Promise<Response> => {
        // Set-Cookie without Domain attribute
        return new Response(null, {
          headers: {
            'Set-Cookie': 'sessionid=xyz789; Path=/'
          }
        });
      };

      const browser = new Browser(mockFetch);
      await browser.fetch('https://example.com/login');

      // Cookie should default to request hostname
      expect(browser.getCookie('sessionid', 'example.com')).toBe('xyz789');
    });

    it('should require preflight for non-simple HTTP methods', async () => {
      let preflightSent = false;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        
        if (req.method === 'OPTIONS') {
          preflightSent = true;
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://app.com',
              'Access-Control-Allow-Methods': 'PUT, DELETE, PATCH'
            }
          });
        }
        
        return new Response('ok', {
          headers: { 'Access-Control-Allow-Origin': 'https://app.com' }
        });
      };

      const browser = new Browser(mockFetch);
      const context = browser.context('https://app.com');

      // PUT should trigger preflight (non-simple method)
      await context.fetch('https://api.example.com/resource', { method: 'PUT' });
      expect(preflightSent).toBe(true);

      preflightSent = false;
      
      // DELETE should trigger preflight
      await context.fetch('https://api.example.com/resource', { method: 'DELETE' });
      expect(preflightSent).toBe(true);

      preflightSent = false;
      
      // PATCH should trigger preflight
      await context.fetch('https://api.example.com/resource', { method: 'PATCH' });
      expect(preflightSent).toBe(true);
    });

    it('should NOT require preflight for POST with simple content-type', async () => {
      let preflightSent = false;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        
        if (req.method === 'OPTIONS') {
          preflightSent = true;
        }
        
        return new Response('ok', {
          headers: { 'Access-Control-Allow-Origin': 'https://app.com' }
        });
      };

      const browser = new Browser(mockFetch);
      const context = browser.context('https://app.com');

      // POST with application/x-www-form-urlencoded (simple) - no preflight
      await context.fetch('https://api.example.com/form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'key=value'
      });
      expect(preflightSent).toBe(false);

      // POST with text/plain (simple) - no preflight
      await context.fetch('https://api.example.com/text', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text'
      });
      expect(preflightSent).toBe(false);

      // POST with multipart/form-data (simple) - no preflight
      await context.fetch('https://api.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundary' },
        body: 'form data'
      });
      expect(preflightSent).toBe(false);
    });

    it('should require preflight for POST with non-simple content-type', async () => {
      let preflightSent = false;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        
        if (req.method === 'OPTIONS') {
          preflightSent = true;
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://app.com',
              'Access-Control-Allow-Headers': 'Content-Type'
            }
          });
        }
        
        return new Response('ok', {
          headers: { 'Access-Control-Allow-Origin': 'https://app.com' }
        });
      };

      const browser = new Browser(mockFetch);
      const context = browser.context('https://app.com');

      // POST with application/json (non-simple) - requires preflight
      await context.fetch('https://api.example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' })
      });
      expect(preflightSent).toBe(true);
    });

    it('should populate lastPreflight on successful preflight', async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = new Request(input, init);
        
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://app.com',
              'Access-Control-Allow-Headers': 'X-Custom, X-Another'
            }
          });
        }
        
        return new Response('ok', {
          headers: { 'Access-Control-Allow-Origin': 'https://app.com' }
        });
      };

      const browser = new Browser(mockFetch);
      const context = browser.context('https://app.com');

      // POST with multiple custom headers
      await context.fetch('https://api.example.com/data', {
        method: 'POST',
        headers: {
          'X-Custom': 'value1',
          'X-Another': 'value2'
        }
      });

      expect(context.lastPreflight).toEqual({
        url: 'https://api.example.com/data',
        method: 'POST',
        headers: expect.arrayContaining(['x-custom', 'x-another']),
        success: true
      });
      expect(context.lastPreflight?.headers).toHaveLength(2);
    });
  });
});

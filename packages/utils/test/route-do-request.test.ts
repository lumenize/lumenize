import { describe, it, expect, vi } from 'vitest';
import { routeDORequest, type RouteOptions } from '../src/route-do-request';

describe('routeDORequest', () => {
  // Mock Durable Object Stub
  const createMockStub = (nameOrId: any) => ({
    nameOrId,
    fetch: vi.fn().mockResolvedValue(new Response(`Response from ${nameOrId}`, { status: 200 }))
  });

  // Mock Durable Object Namespace
  const createMockNamespace = () => ({
    getByName: vi.fn((name: string) => createMockStub(name)),
    idFromName: vi.fn(),
    idFromString: vi.fn((id: string) => id),
    get: vi.fn((id: any) => createMockStub(id)),
  });

  // Helper to create test requests
  const createRequest = (url: string, options: RequestInit = {}) => 
    new Request(url, { method: 'GET', ...options });

  // Helper to create WebSocket upgrade request
  const createWebSocketRequest = (url: string) => 
    new Request(url, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'upgrade'
      }
    });

  describe('basic routing functionality', () => {
    it('should route request to correct DO when path matches', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/test-instance/some/path');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('test-instance');
    });

    it('should return undefined when no matching DO binding found', async () => {
      const env = { OTHER_DO: createMockNamespace() };
      const request = createRequest('http://localhost/unknown-binding/instance/path');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeUndefined();
    });

    it('should return undefined for invalid paths', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeUndefined();
    });

    it('should handle case-insensitive DO binding names', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });
  });

  describe('prefix handling', () => {
    it('should handle requests with matching prefix', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/v1/my-do/instance/path');
      const options: RouteOptions = { prefix: '/api/v1' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should return undefined when prefix does not match', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/different/my-do/instance/path');
      const options: RouteOptions = { prefix: '/api/v1' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeUndefined();
    });

    it('should normalize prefix without leading slash', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/v1/my-do/instance/path');
      const options: RouteOptions = { prefix: 'api/v1' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should normalize prefix with trailing slash', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/v1/my-do/instance/path');
      const options: RouteOptions = { prefix: '/api/v1/' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should handle root path after prefix removal', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/my-do/instance');
      const options: RouteOptions = { prefix: '/api' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should work with uniqueIds', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/my-do/8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99');
      const options: RouteOptions = { prefix: '/api' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(await response?.text()).toBe('Response from 8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99');
      
      expect(env.MY_DO.get).toHaveBeenCalled();
    });
  });

  describe('WebSocket upgrade detection and hooks', () => {
    it('should detect WebSocket upgrade requests and call only onBeforeConnect hook', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createWebSocketRequest('http://localhost/my-do/instance/ws');
      const onBeforeConnect = vi.fn();
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeConnect, onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeRequest).not.toHaveBeenCalled();
      expect(onBeforeConnect).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
    });

    it('should call onBeforeRequest for non-WebSocket requests', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeRequest).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
    });

    it('should not call onBeforeConnect for non-WebSocket requests', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const onBeforeConnect = vi.fn();
      const options: RouteOptions = { onBeforeConnect };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).not.toHaveBeenCalled();
    });
  });

  describe('hook response handling', () => {
    it('should return response from onBeforeRequest if provided (called first)', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const hookResponse = new Response('Blocked by hook', { status: 403 });
      const onBeforeRequest = vi.fn().mockReturnValue(hookResponse);
      const options: RouteOptions = { onBeforeRequest };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBe(hookResponse);
    });

    it('should return response from onBeforeConnect if provided for WebSocket requests', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createWebSocketRequest('http://localhost/my-do/instance/ws');
      const hookResponse = new Response('Blocked by hook', { status: 403 });
      const onBeforeConnect = vi.fn().mockReturnValue(hookResponse);
      const onBeforeRequest = vi.fn(); // This runs first but doesn't block
      const options: RouteOptions = { onBeforeConnect, onBeforeRequest };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBe(hookResponse);
    });

    it('should continue to DO when hooks return undefined', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const onBeforeRequest = vi.fn().mockReturnValue(undefined);
      const options: RouteOptions = { onBeforeRequest };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should continue to DO when hooks return void', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const onBeforeRequest = vi.fn(); // returns void
      const options: RouteOptions = { onBeforeRequest };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should transform request when onBeforeRequest returns modified Request', async () => {
      const env = { MY_DO: createMockNamespace() };
      const originalRequest = createRequest('http://localhost/my-do/instance/path');
      const modifiedRequest = new Request('http://localhost/my-do/instance/modified-path', {
        method: 'POST',
        headers: { 'X-Modified': 'true' }
      });
      const onBeforeRequest = vi.fn().mockReturnValue(modifiedRequest);
      const options: RouteOptions = { onBeforeRequest };
      
      const response = await routeDORequest(originalRequest, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(onBeforeRequest).toHaveBeenCalledWith(originalRequest, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
      
      // Verify the modified request was used AND Lumenize headers were added
      const stub = env.MY_DO.getByName.mock.results[0].value;
      const forwardedRequest = stub.fetch.mock.calls[0][0];
      
      // Check that modifications from hook are preserved
      expect(forwardedRequest.headers.get('X-Modified')).toBe('true');
      expect(forwardedRequest.method).toBe('POST');
      expect(forwardedRequest.url).toBe('http://localhost/my-do/instance/modified-path');
      
      // Check that Lumenize headers were added
      expect(forwardedRequest.headers.get('x-lumenize-do-instance-name-or-id')).toBe('instance');
      expect(forwardedRequest.headers.get('x-lumenize-do-binding-name')).toBe('MY_DO');
    });

    it('should transform request when onBeforeConnect returns modified Request for WebSocket', async () => {
      const env = { MY_DO: createMockNamespace() };
      const originalRequest = createWebSocketRequest('http://localhost/my-do/instance/ws');
      const modifiedRequest = new Request('http://localhost/my-do/instance/modified-ws', {
        method: 'GET',
        headers: { 
          'Upgrade': 'websocket',
          'X-Modified': 'true' 
        }
      });
      const onBeforeConnect = vi.fn().mockReturnValue(modifiedRequest);
      const options: RouteOptions = { onBeforeConnect };
      
      const response = await routeDORequest(originalRequest, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(onBeforeConnect).toHaveBeenCalledWith(originalRequest, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
      
      // Verify the modified request was used AND Lumenize headers were added
      const stub = env.MY_DO.getByName.mock.results[0].value;
      const forwardedRequest = stub.fetch.mock.calls[0][0];
      
      // Check that modifications from hook are preserved
      expect(forwardedRequest.headers.get('X-Modified')).toBe('true');
      expect(forwardedRequest.headers.get('Upgrade')).toBe('websocket');
      expect(forwardedRequest.url).toBe('http://localhost/my-do/instance/modified-ws');
      
      // Check that Lumenize headers were added
      expect(forwardedRequest.headers.get('x-lumenize-do-instance-name-or-id')).toBe('instance');
      expect(forwardedRequest.headers.get('x-lumenize-do-binding-name')).toBe('MY_DO');
    });
  });

  describe('WebSocket upgrade detection logic', () => {
    it('should detect WebSocket with case-insensitive headers', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = new Request('http://localhost/my-do/instance/ws', {
        method: 'GET',
        headers: {
          'Upgrade': 'WebSocket',
          'Connection': 'Upgrade'
        }
      });
      const onBeforeConnect = vi.fn();
      const options: RouteOptions = { onBeforeConnect };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).toHaveBeenCalled();
    });

    it('should detect WebSocket when Connection header has multiple values', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = new Request('http://localhost/my-do/instance/ws', {
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'keep-alive, upgrade'
        }
      });
      const onBeforeConnect = vi.fn();
      const options: RouteOptions = { onBeforeConnect };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).toHaveBeenCalled();
    });

    it('should detect WebSocket for non-GET methods when Upgrade header is websocket', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = new Request('http://localhost/my-do/instance/ws', {
        method: 'POST',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'upgrade'
        }
      });
      const onBeforeConnect = vi.fn();
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeConnect, onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
      expect(onBeforeRequest).not.toHaveBeenCalled();
    });

    it('should not detect WebSocket without proper Upgrade header', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = new Request('http://localhost/my-do/instance/ws', {
        method: 'GET',
        headers: {
          'Upgrade': 'http2',
          'Connection': 'upgrade'
        }
      });
      const onBeforeConnect = vi.fn();
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeConnect, onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).not.toHaveBeenCalled();
      expect(onBeforeRequest).toHaveBeenCalled();
    });

    it('should detect WebSocket with Upgrade header regardless of Connection value', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = new Request('http://localhost/my-do/instance/ws', {
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'keep-alive'
        }
      });
      const onBeforeConnect = vi.fn();
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeConnect, onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeConnect).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
      expect(onBeforeRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return undefined when DOBindingNotFoundError is thrown', async () => {
      const env = {}; // Empty env to trigger DOBindingNotFoundError
      const request = createRequest('http://localhost/my-do/instance/path');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeUndefined();
    });

    it('should throw MissingInstanceNameError when binding found but instance name missing', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do'); // No instance name
      
      await expect(routeDORequest(request, env)).rejects.toThrow('doBindingName found but doInstanceNameOrId missing');
      await expect(routeDORequest(request, env)).rejects.toMatchObject({
        name: 'MissingInstanceNameError',
        code: 'MISSING_INSTANCE_NAME',
        httpErrorCode: 400
      });
    });

    it('should throw MissingInstanceNameError with prefix when binding found but instance missing', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/my-do'); // Has prefix and binding but no instance
      const options: RouteOptions = { prefix: '/api' };
      
      await expect(routeDORequest(request, env, options)).rejects.toThrow('doBindingName found but doInstanceNameOrId missing');
      await expect(routeDORequest(request, env, options)).rejects.toMatchObject({
        name: 'MissingInstanceNameError',
        code: 'MISSING_INSTANCE_NAME',
        httpErrorCode: 400
      });
    });
  });

  describe('complex scenarios', () => {
    it('should handle prefix + WebSocket + hooks together', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createWebSocketRequest('http://localhost/api/v1/my-do/instance/ws');
      const hookResponse = new Response('Custom auth response', { status: 200 });
      const onBeforeConnect = vi.fn().mockReturnValue(hookResponse);
      const options: RouteOptions = { 
        prefix: '/api/v1',
        onBeforeConnect 
      };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBe(hookResponse);
      expect(onBeforeConnect).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
    });

    it('should handle prefix + regular request + hooks together', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/v1/my-do/instance/path', { method: 'POST' });
      const onBeforeRequest = vi.fn(); // returns void, should continue
      const options: RouteOptions = { 
        prefix: '/api/v1',
        onBeforeRequest 
      };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(onBeforeRequest).toHaveBeenCalledWith(request, expect.objectContaining({
        doInstanceNameOrId: 'instance',
        doNamespace: expect.any(Object)
      }));
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should add Lumenize routing headers when forwarding to DO', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path', {
        method: 'POST',
        body: 'test body',
        headers: { 'Content-Type': 'text/plain' }
      });
      
      await routeDORequest(request, env);
      
      const stub = env.MY_DO.getByName.mock.results[0].value;
      const forwardedRequest = stub.fetch.mock.calls[0][0];
      
      // Check that Lumenize headers were added
      expect(forwardedRequest.headers.get('x-lumenize-do-instance-name-or-id')).toBe('instance');
      expect(forwardedRequest.headers.get('x-lumenize-do-binding-name')).toBe('MY_DO');
      
      // Check that original headers are preserved
      expect(forwardedRequest.headers.get('Content-Type')).toBe('text/plain');
      expect(forwardedRequest.method).toBe('POST');
      expect(forwardedRequest.url).toBe(request.url);
    });
  });

  describe('edge cases', () => {
    it('should handle empty options object', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      
      const response = await routeDORequest(request, env, {});
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should handle missing options parameter', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      
      const response = await routeDORequest(request, env);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should handle empty prefix string', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const options: RouteOptions = { prefix: '' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeInstanceOf(Response);
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should handle prefix that equals the entire path', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/api/v1');
      const options: RouteOptions = { prefix: '/api/v1' };
      
      const response = await routeDORequest(request, env, options);
      
      expect(response).toBeUndefined(); // Should not match any DO pattern
    });
  });

  describe('CORS support', () => {
    describe('disabled by default', () => {
      it('should not add CORS headers when cors option is not provided', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env);
        
        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
        expect(response?.headers.has('Vary')).toBe(false);
      });

      it('should not add CORS headers when cors is false', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: false });
        
        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });

      it('should not add CORS headers when no Origin header present', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance');
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });
    });

    describe('permissive mode (cors: true)', () => {
      it('should reflect any origin when cors is true', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
        expect(response?.headers.get('Vary')).toBe('Origin');
      });

      it('should reflect different origins', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://different.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://different.com');
        expect(response?.headers.get('Vary')).toBe('Origin');
      });

      it('should not set Access-Control-Allow-Credentials', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response?.headers.has('Access-Control-Allow-Credentials')).toBe(false);
      });
    });

    describe('whitelist mode (cors: { origin: [...] })', () => {
      it('should allow whitelisted origins', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://app.example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://app.example.com', 'https://admin.example.com'] }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
        expect(response?.headers.get('Vary')).toBe('Origin');
      });

      it('should allow second whitelisted origin', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://admin.example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://app.example.com', 'https://admin.example.com'] }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example.com');
      });

      it('should not add CORS headers for non-whitelisted origins', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://evil.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://app.example.com', 'https://admin.example.com'] }
        });
        
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
        expect(response?.headers.has('Vary')).toBe(false);
      });

      it('should handle empty whitelist', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: [] }
        });
        
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });
    });

    describe('function validator mode (cors: { origin: fn })', () => {
      it('should call validation function with origin and request', async () => {
        const env = { MY_DO: createMockNamespace() };
        const validator = vi.fn((origin: string, request: Request) => origin.endsWith('.example.com'));
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://app.example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: validator }
        });
        
        expect(validator).toHaveBeenCalledWith('https://app.example.com', request);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      });

      it('should allow origin when validator returns true', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://app.example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: (origin) => origin.endsWith('.example.com') }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      });

      it('should reject origin when validator returns false', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://evil.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: (origin) => origin.endsWith('.example.com') }
        });
        
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });

      it('should support complex validation logic with request inspection', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'GET',
          headers: { 
            'Origin': 'https://localhost:3000',
            'X-API-Key': 'secret-key'
          }
        });
        
        const validator = (origin: string, req: Request) => {
          // Check origin pattern
          const validOrigin = origin.endsWith('.example.com') || 
                             origin === 'https://localhost:3000' ||
                             origin.includes('staging');
          
          // Also check API key in request
          const apiKey = req.headers.get('X-API-Key');
          const validKey = apiKey === 'secret-key';
          
          return validOrigin && validKey;
        };
        
        const response = await routeDORequest(request, env, {
          cors: { origin: validator }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost:3000');
      });

      it('should reject when request inspection fails validation', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'DELETE',
          headers: { 'Origin': 'https://app.example.com' }
        });
        
        const validator = (origin: string, req: Request) => {
          // Reject DELETE requests even if origin is allowed
          if (req.method === 'DELETE') return false;
          return origin.endsWith('.example.com');
        };
        
        const response = await routeDORequest(request, env, {
          cors: { origin: validator }
        });
        
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });

      it('should allow validator to inspect user agent', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 
            'Origin': 'https://app.example.com',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        
        const validator = (origin: string, req: Request) => {
          const userAgent = req.headers.get('User-Agent');
          // Block bots
          if (userAgent?.toLowerCase().includes('bot')) return false;
          return origin.endsWith('.example.com');
        };
        
        const response = await routeDORequest(request, env, {
          cors: { origin: validator }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      });
    });

    describe('preflight (OPTIONS) requests', () => {
      it('should handle OPTIONS request with allowed origin', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'OPTIONS',
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response).toBeInstanceOf(Response);
        expect(response?.status).toBe(204);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
        expect(response?.headers.get('Vary')).toBe('Origin');
      });

      it('should not forward OPTIONS request to DO when origin is allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'OPTIONS',
          headers: { 'Origin': 'https://example.com' }
        });
        
        await routeDORequest(request, env, { cors: true });
        
        expect(env.MY_DO.getByName).not.toHaveBeenCalled();
      });

      it('should forward OPTIONS request to DO when no Origin header', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'OPTIONS'
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
        expect(response?.status).toBe(200); // From mock DO response
      });

      it('should reject OPTIONS when origin is not allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'OPTIONS',
          headers: { 'Origin': 'https://evil.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] }
        });
        
        // Per CORS spec: return 204 without CORS headers (browser will reject)
        expect(response?.status).toBe(204);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBeNull();
        
        // Verify DO was never called
        const mockDO = env.MY_DO.getByName('instance');
        expect(mockDO.fetch).not.toHaveBeenCalled();
      });

      it('should handle OPTIONS with whitelisted origin', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          method: 'OPTIONS',
          headers: { 'Origin': 'https://app.example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://app.example.com'] }
        });
        
        expect(response?.status).toBe(204);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
      });
    });

    describe('CORS with hooks', () => {
      it('should add CORS headers to hook-returned responses', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        const hookResponse = new Response('Blocked', { status: 403 });
        const onBeforeRequest = vi.fn().mockReturnValue(hookResponse);
        
        const response = await routeDORequest(request, env, {
          cors: true,
          onBeforeRequest
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
        expect(response?.headers.get('Vary')).toBe('Origin');
        expect(await response?.text()).toBe('Blocked');
      });

      it('should add CORS headers to WebSocket hook responses', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createWebSocketRequest('http://localhost/my-do/instance');
        request.headers.set('Origin', 'https://example.com');
        
        const hookResponse = new Response('Unauthorized', { status: 401 });
        const onBeforeConnect = vi.fn().mockReturnValue(hookResponse);
        
        const response = await routeDORequest(request, env, {
          cors: true,
          onBeforeConnect
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      });

      it('should not add CORS headers to hook responses when origin not allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://evil.com' }
        });
        const hookResponse = new Response('Blocked', { status: 403 });
        const onBeforeRequest = vi.fn().mockReturnValue(hookResponse);
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] },
          onBeforeRequest
        });
        
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });
    });

    describe('CORS with prefix and WebSocket', () => {
      it('should handle CORS with prefix', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/api/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          prefix: '/api',
          cors: true
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      });

      it('should handle WebSocket with CORS', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createWebSocketRequest('http://localhost/my-do/instance');
        request.headers.set('Origin', 'https://example.com');
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      });

      it('should reject WebSocket upgrade when origin not allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createWebSocketRequest('http://localhost/my-do/instance');
        request.headers.set('Origin', 'https://evil.com');
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] }
        });
        
        // Server must reject WebSocket upgrades for disallowed origins
        // (browsers don't enforce Access-Control-Allow-Origin for WebSocket)
        expect(response?.status).toBe(403);
        expect(await response?.text()).toBe('Forbidden: Origin not allowed');
        
        // Verify DO was never called (rejection happens before forwarding)
        const mockDO = env.MY_DO.getByName('instance');
        expect(mockDO.fetch).not.toHaveBeenCalled();
      });

      it('should allow WebSocket upgrade when origin is allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createWebSocketRequest('http://localhost/my-do/instance');
        request.headers.set('Origin', 'https://example.com');
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] }
        });
        
        // Allowed origin should forward to DO (not rejected)
        expect(response?.status).not.toBe(403);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
        
        // Verify DO was called
        expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
      });

      it('should allow WebSocket upgrade when CORS is disabled', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createWebSocketRequest('http://localhost/my-do/instance');
        request.headers.set('Origin', 'https://any-origin.com');
        
        const response = await routeDORequest(request, env, {
          cors: false
        });
        
        // CORS disabled means no origin validation (forwarded to DO)
        expect(response?.status).not.toBe(403);
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });

      it('should reject HTTP request when origin not allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = new Request('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://evil.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] }
        });
        
        // Non-standard: Server rejects HTTP for disallowed origins (like WebSocket)
        // This provides better security than standard browser-only CORS enforcement
        expect(response?.status).toBe(403);
        expect(await response?.text()).toBe('Forbidden: Origin not allowed');
        
        // Verify DO was never called (rejection happens before forwarding)
        const mockDO = env.MY_DO.getByName('instance');
        expect(mockDO.fetch).not.toHaveBeenCalled();
      });

      it('should allow HTTP request when origin is allowed', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = new Request('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com'] }
        });
        
        // Allowed origin should forward to DO (not rejected)
        expect(response?.status).not.toBe(403);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
        
        // Verify DO was called
        expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
      });

      it('should allow HTTP request when CORS is disabled', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = new Request('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://any-origin.com' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: false
        });
        
        // CORS disabled means no origin validation (forwarded to DO)
        expect(response?.status).not.toBe(403);
        expect(response?.headers.has('Access-Control-Allow-Origin')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should preserve existing response headers', async () => {
        // Create mock namespace with custom response headers
        const mockNamespace = {
          getByName: vi.fn((name: string) => ({
            nameOrId: name,
            fetch: vi.fn().mockResolvedValue(
              new Response('OK', { 
                headers: { 
                  'Content-Type': 'application/json',
                  'X-Custom': 'value'
                } 
              })
            )
          })),
          idFromName: vi.fn(),
          idFromString: vi.fn((id: string) => id),
          get: vi.fn((id: any) => ({
            nameOrId: id,
            fetch: vi.fn().mockResolvedValue(
              new Response('OK', { 
                headers: { 
                  'Content-Type': 'application/json',
                  'X-Custom': 'value'
                } 
              })
            )
          })),
        };
        
        const env = { MY_DO: mockNamespace };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com' }
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        expect(response?.headers.get('Content-Type')).toBe('application/json');
        expect(response?.headers.get('X-Custom')).toBe('value');
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      });

      it('should handle case-sensitive Origin header', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = new Request('http://localhost/my-do/instance', {
          headers: { 'origin': 'https://example.com' }  // lowercase
        });
        
        const response = await routeDORequest(request, env, { cors: true });
        
        // Headers.get() is case-insensitive
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      });

      it('should handle origins with ports', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'https://example.com:8080' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['https://example.com:8080'] }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com:8080');
      });

      it('should handle null origin (privacy-sensitive context)', async () => {
        const env = { MY_DO: createMockNamespace() };
        const request = createRequest('http://localhost/my-do/instance', {
          headers: { 'Origin': 'null' }
        });
        
        const response = await routeDORequest(request, env, {
          cors: { origin: ['null'] }
        });
        
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('null');
      });
    });
  });
});
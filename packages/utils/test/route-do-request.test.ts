import { describe, it, expect, vi } from 'vitest';
import { routeDORequest, type RouteOptions } from '../src/route-do-request.js';

describe('routeDORequest', () => {
  // Mock Durable Object Stub
  const createMockStub = (name: string) => ({
    name,
    fetch: vi.fn().mockResolvedValue(new Response(`Response from ${name}`, { status: 200 }))
  });

  // Mock Durable Object Namespace
  const createMockNamespace = () => ({
    getByName: vi.fn((name: string) => createMockStub(name)),
    idFromName: vi.fn(),
    getById: vi.fn()
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
      expect(onBeforeConnect).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
    });

    it('should call onBeforeRequest for non-WebSocket requests', () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path');
      const onBeforeRequest = vi.fn();
      const options: RouteOptions = { onBeforeRequest };
      
      routeDORequest(request, env, options);
      
      expect(onBeforeRequest).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
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
      expect(env.MY_DO.getByName).not.toHaveBeenCalled();
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
      expect(env.MY_DO.getByName).not.toHaveBeenCalled();
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
      
      expect(onBeforeConnect).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
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
      
      expect(onBeforeConnect).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
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
      expect(onBeforeConnect).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
      expect(env.MY_DO.getByName).not.toHaveBeenCalled();
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
      expect(onBeforeRequest).toHaveBeenCalledWith(request, { party: 'my-do', name: 'instance' });
      expect(env.MY_DO.getByName).toHaveBeenCalledWith('instance');
    });

    it('should preserve original request when forwarding to DO', async () => {
      const env = { MY_DO: createMockNamespace() };
      const request = createRequest('http://localhost/my-do/instance/path', {
        method: 'POST',
        body: 'test body',
        headers: { 'Content-Type': 'text/plain' }
      });
      
      await routeDORequest(request, env);
      
      const stub = env.MY_DO.getByName.mock.results[0].value;
      expect(stub.fetch).toHaveBeenCalledWith(request);
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
});
import { describe, it, expect } from 'vitest';
// @ts-expect-error TypeScript does not like this magic import from vitest-pool-workers
import { env, SELF } from 'cloudflare:test';

describe('routeDORequest integration tests', () => {
  describe('basic routing', () => {
    it('should route request to correct DO', async () => {
      const response = await SELF.fetch('http://localhost/my-do/test-instance');
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.doType).toBe('MyDO');
      expect(data.lumenizeHeaders.instanceName).toBe('test-instance');
      expect(data.lumenizeHeaders.bindingName).toBe('MY_DO');
    });

    it('should handle 64-character hex IDs', async () => {
      // Generate a valid ID for this namespace
      const id = env.MY_DO.newUniqueId();
      const hexId = id.toString();
      
      const response = await SELF.fetch(`http://localhost/my-do/${hexId}`);
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.doType).toBe('MyDO');
      expect(data.instanceId).toBe(hexId);
    });

    it('should handle kebab-case to SCREAMING_SNAKE_CASE conversion', async () => {
      const response = await SELF.fetch('http://localhost/user-session/john');
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.doType).toBe('UserSession');
      expect(data.bindingName).toBe('USER_SESSION');
    });

    it('should return 404 for unknown bindings', async () => {
      const response = await SELF.fetch('http://localhost/unknown-binding/instance');
      expect(response.status).toBe(404);
    });

    it('should return error when instance name is missing', async () => {
      const response = await SELF.fetch('http://localhost/my-do');
      expect(response.status).toBe(400);
      
      const data = await response.json();
      expect(data.name).toBe('MissingInstanceNameError');
      expect(data.code).toBe('MISSING_INSTANCE_NAME');
    });
  });

  describe('prefix support', () => {
    it('should route with /do prefix', async () => {
      const response = await SELF.fetch('http://localhost/do/my-do/prefixed-instance');
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.doType).toBe('MyDO');
      expect(data.lumenizeHeaders.instanceName).toBe('prefixed-instance');
    });

    it('should not route when prefix does not match', async () => {
      const response = await SELF.fetch('http://localhost/wrong-prefix/my-do/instance');
      expect(response.status).toBe(404);
    });
  });

  describe('agent compatibility mode', () => {
    it('should add x-partykit-* headers when using routeAgentRequest', async () => {
      const response = await SELF.fetch('http://localhost/agents/my-do/agent-instance');
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data.doType).toBe('MyDO');
      
      // Agent compatibility headers
      expect(data.agentHeaders.room).toBe('agent-instance');
      expect(data.agentHeaders.namespace).toBe('my-do'); // URL path segment
      
      // Should NOT have Lumenize headers
      expect(data.lumenizeHeaders.instanceName).toBeNull();
      expect(data.lumenizeHeaders.bindingName).toBeNull();
    });
  });

  describe('request forwarding', () => {
    it('should preserve request method and path', async () => {
      const response = await SELF.fetch('http://localhost/test-do/instance1/some/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });
      
      expect(response.status).toBe(200);
      const data = await response.json();
      
      expect(data.method).toBe('POST');
      // The full URL path is preserved, including routing segments
      expect(data.url).toBe('/test-do/instance1/some/path');
      expect(data.headers['content-type']).toBe('application/json');
      expect(data.headers['x-lumenize-do-instance-name-or-id']).toBe('instance1');
      expect(data.headers['x-lumenize-do-binding-name']).toBe('TEST_DO');
    });

    it('should handle GET requests with query parameters', async () => {
      const response = await SELF.fetch('http://localhost/test-do/instance1/path?foo=bar&baz=qux');
      
      expect(response.status).toBe(200);
      const data = await response.json();
      
      // The full URL path is preserved, including routing segments and query
      expect(data.url).toContain('/test-do/instance1/path');
      expect(data.url).toContain('foo=bar');
      expect(data.url).toContain('baz=qux');
    });
  });

  describe('documentation examples', () => {
    it('should demonstrate error handling with httpErrorCode', async () => {
      // The test worker already implements this pattern in its catch block:
      // try {
      //   const response = await routeDORequest(request, env);
      //   if (response) return response;
      // } catch (error: any) {
      //   // Handle MissingInstanceNameError, MultipleBindingsFoundError, etc.
      //   const status = error.httpErrorCode || 500;
      //   return new Response(error.message, { status });
      // }
      
      // Request without instance name triggers MissingInstanceNameError
      const response = await SELF.fetch('http://localhost/my-do');
      expect(response.status).toBe(400); // httpErrorCode from the error
      
      const data = await response.json();
      expect(data.httpErrorCode).toBe(400);
      expect(data.code).toBe('MISSING_INSTANCE_NAME');
    });
  });
});

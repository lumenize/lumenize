/**
 * Tests for NadisPlugin base class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { NadisPlugin, LumenizeBase } from '../src/index';

// Test plugin: Class-based stateful service
class TestService extends NadisPlugin {
  #counter = 0;

  increment() {
    this.#counter++;
    return this.#counter;
  }

  getCount() {
    return this.#counter;
  }

  // Test that we have access to protected properties
  getCtx() {
    return this.ctx;
  }

  getSvc() {
    return this.svc;
  }

  getDoInstance() {
    return this.doInstance;
  }
}

// Test plugin: Function-based stateless service
function testHelper(doInstance: any) {
  return (input: string) => {
    return `${input.toUpperCase()}-${doInstance.ctx.id.toString().slice(0, 8)}`;
  };
}

// Register test plugins
declare global {
  interface LumenizeServices {
    testService: TestService;
    testHelper: ReturnType<typeof testHelper>;
  }
}

describe('NadisPlugin', () => {
  beforeEach(() => {
    // Clear registry before each test
    delete (globalThis as any).__lumenizeServiceRegistry?.testService;
    delete (globalThis as any).__lumenizeServiceRegistry?.testHelper;
  });

  describe('static register()', () => {
    it('should initialize global registry if needed', () => {
      // Clear registry
      delete (globalThis as any).__lumenizeServiceRegistry;

      NadisPlugin.register('testService', (doInstance) => new TestService(doInstance));

      expect((globalThis as any).__lumenizeServiceRegistry).toBeDefined();
      expect((globalThis as any).__lumenizeServiceRegistry.testService).toBeDefined();
    });

    it('should register class-based plugin', () => {
      NadisPlugin.register('testService', (doInstance) => new TestService(doInstance));

      expect((globalThis as any).__lumenizeServiceRegistry.testService).toBeInstanceOf(Function);
    });

    it('should register function-based plugin', () => {
      NadisPlugin.register('testHelper', (doInstance) => testHelper(doInstance));

      expect((globalThis as any).__lumenizeServiceRegistry.testHelper).toBeInstanceOf(Function);
    });

    it('should allow multiple registrations', () => {
      NadisPlugin.register('testService', (doInstance) => new TestService(doInstance));
      NadisPlugin.register('testHelper', (doInstance) => testHelper(doInstance));

      expect((globalThis as any).__lumenizeServiceRegistry.testService).toBeDefined();
      expect((globalThis as any).__lumenizeServiceRegistry.testHelper).toBeDefined();
    });
  });

  describe('class-based plugin integration', () => {
    it('should provide access to doInstance, ctx, and svc', async () => {
      // Register the plugin
      NadisPlugin.register('testService', (doInstance) => new TestService(doInstance));

      // Get test DO stub
      const stub = env.NADIS_PLUGIN_TEST_DO.getByName('check-access-test');

      // Access service
      const response = await stub.fetch('http://test/check-access');
      const data = await response.json() as { hasCtx: boolean; hasSvc: boolean; hasDoInstance: boolean };

      expect(data.hasCtx).toBe(true);
      expect(data.hasSvc).toBe(true);
      expect(data.hasDoInstance).toBe(true);
    });

    it('should maintain state across calls', async () => {
      // Register the plugin
      NadisPlugin.register('testService', (doInstance) => new TestService(doInstance));

      // Get test DO stub
      const stub = env.NADIS_PLUGIN_TEST_DO.getByName('maintain-state-test');

      // Increment counter multiple times
      const response1 = await stub.fetch('http://test/increment');
      const data1 = await response1.json() as { count: number };
      expect(data1.count).toBe(1);

      const response2 = await stub.fetch('http://test/increment');
      const data2 = await response2.json() as { count: number };
      expect(data2.count).toBe(2);

      const response3 = await stub.fetch('http://test/increment');
      const data3 = await response3.json() as { count: number };
      expect(data3.count).toBe(3);
    });
  });

  describe('function-based plugin integration', () => {
    it('should work with function-based plugins', async () => {
      // Register the plugin
      NadisPlugin.register('testHelper', (doInstance) => testHelper(doInstance));

      // Get test DO stub
      const stub = env.NADIS_PLUGIN_TEST_DO.getByName('function-plugin-test');

      // Use helper
      const response = await stub.fetch('http://test/use-helper');
      const data = await response.json() as { result: string };

      expect(data.result).toMatch(/^HELLO-[a-f0-9]{8}$/);
    });
  });

  describe('eager dependency validation', () => {
    it('should fail immediately if dependency missing', async () => {
      // Plugin that requires sql (which we won't register)
      class ServiceWithDeps extends NadisPlugin {
        #sql: any;

        constructor(doInstance: any) {
          super(doInstance);
          // This should throw if sql not available
          this.#sql = this.svc.sql;
        }
      }

      // Register without registering sql
      NadisPlugin.register('serviceWithDeps', (doInstance) => new ServiceWithDeps(doInstance));

      // Get test DO stub
      const stub = env.NADIS_PLUGIN_TEST_DO.getByName('eager-validation-test');

      // Try to access the service - should fail at construction
      const response = await stub.fetch('http://test/use-service-with-deps');
      
      // Should get error response
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toContain("Service 'sql' not found");
    });
  });
});


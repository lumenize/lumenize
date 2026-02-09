/**
 * Inheritance Testing for RPC
 * 
 * Tests that RPC works correctly with class inheritance:
 * - Inherited methods work
 * - Overridden methods behave correctly
 * - New methods only in subclass work
 * - __asObject() includes all methods from both base and subclass
 * - Tested with both WebSocket and HTTP transports
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createHttpTransport, createWebSocketTransport, type RpcAccessible } from '../src/index';
import { getWebSocketShim } from '@lumenize/testing';
import { SubclassDO } from './test-worker-and-dos';

type SubclassDOType = RpcAccessible<InstanceType<typeof SubclassDO>>;

/**
 * Test inheritance with both transports
 */
const TRANSPORTS = [
  { name: 'WebSocket', factory: createWebSocketTransport },
  { name: 'HTTP', factory: createHttpTransport },
] as const;

TRANSPORTS.forEach(({ name, factory }) => {
  describe(`Inheritance (${name} transport)`, () => {
    it('should call inherited methods from base class', async () => {
      const instanceId = `subclass-inherited-${name}-${Date.now()}`;
      
      const transport = factory === createWebSocketTransport
        ? factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
          })
        : factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            fetch: SELF.fetch.bind(SELF),
          });

      const client = createRpcClient<SubclassDOType>({ transport });

      try {
        // Test inherited method: getArray
        const array = await (client as any).getArray();
        expect(array).toEqual([1, 2, 3, 4, 5]);

        // Test inherited method: getClassInstance
        const instance = await (client as any).getClassInstance();
        expect(instance).toBeDefined();
        const name = await instance.getName();
        expect(name).toBe('TestModel');

        // Test inherited method: echo
        const echoedValue = await (client as any).echo({ test: 'value' });
        expect(echoedValue).toEqual({ test: 'value' });
      } finally {
        client[Symbol.dispose]();
      }
    });

    it('should call overridden methods with subclass behavior', async () => {
      const instanceId = `subclass-override-${name}-${Date.now()}`;
      
      const transport = factory === createWebSocketTransport
        ? factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
          })
        : factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            fetch: SELF.fetch.bind(SELF),
          });

      const client = createRpcClient<SubclassDOType>({ transport });

      try {
        // Test overridden increment: should add 1000 bonus
        const count1 = await (client as any).increment();
        expect(count1).toBe(1001); // First increment: 1 + 1000

        const count2 = await (client as any).increment();
        expect(count2).toBe(2002); // Second: 1001 + 1 + 1000

        // Test overridden add: should add 100 bonus
        const sum = await (client as any).add(10, 20);
        expect(sum).toBe(130); // 10 + 20 + 100 bonus
      } finally {
        client[Symbol.dispose]();
      }
    });

    it('should call new methods only in subclass', async () => {
      const instanceId = `subclass-new-methods-${name}-${Date.now()}`;
      
      const transport = factory === createWebSocketTransport
        ? factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
          })
        : factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            fetch: SELF.fetch.bind(SELF),
          });

      const client = createRpcClient<SubclassDOType>({ transport });

      try {
        // Test new method: multiply
        const product = await (client as any).multiply(6, 7);
        expect(product).toBe(42);

        // Test new method that uses inherited functionality: doubleIncrement
        const count = await (client as any).doubleIncrement();
        // First increment: 1 + 1000 = 1001
        // Second increment: 1001 + 1 + 1000 = 2002
        expect(count).toBe(2002);

        // Test getter property
        const name = await (client as any).subclassName;
        expect(name).toBe('SubclassDO');

        // Test method that returns subclass property
        const prop = await (client as any).getSubclassProperty();
        expect(prop).toBe('I am a subclass');
      } finally {
        client[Symbol.dispose]();
      }
    });

    it('should include all methods in __asObject() inspection', async () => {
      const instanceId = `subclass-asObject-${name}-${Date.now()}`;
      
      const transport = factory === createWebSocketTransport
        ? factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
          })
        : factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            fetch: SELF.fetch.bind(SELF),
          });

      const client = createRpcClient<SubclassDOType>({ transport });

      try {
        const obj = await (client as any).__asObject();
        const methods = Object.keys(obj).filter(key => typeof obj[key] === 'string');

        // Should include base class methods
        expect(methods).toContain('increment');
        expect(methods).toContain('add');
        expect(methods).toContain('getArray');
        expect(methods).toContain('echo');
        expect(methods).toContain('getClassInstance');

        // Should include subclass methods
        expect(methods).toContain('multiply');
        expect(methods).toContain('doubleIncrement');
        expect(methods).toContain('getSubclassProperty');

        // Should include subclass getter
        expect(methods).toContain('subclassName');
      } finally {
        client[Symbol.dispose]();
      }
    });

    it('should handle complex inheritance scenarios', async () => {
      const instanceId = `subclass-complex-${name}-${Date.now()}`;
      
      const transport = factory === createWebSocketTransport
        ? factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
          })
        : factory('subclass-do', instanceId, {
            baseUrl: 'https://fake-host.com',
            prefix: '__rpc',
            fetch: SELF.fetch.bind(SELF),
          });

      const client = createRpcClient<SubclassDOType>({ transport });

      try {
        // Mix inherited and new methods
        const array = await (client as any).getArray();
        expect(array.length).toBe(5);

        const product = await (client as any).multiply(array.length, 2);
        expect(product).toBe(10);

        // Use overridden method
        const sum = await (client as any).add(product, 5);
        expect(sum).toBe(115); // 10 + 5 + 100 bonus

        // Verify counter is separate from calculations
        const count = await (client as any).increment();
        expect(count).toBe(1001); // First increment with bonus
      } finally {
        client[Symbol.dispose]();
      }
    });
  });
});

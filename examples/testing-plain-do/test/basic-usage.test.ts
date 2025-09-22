import { describe, it, expect, vi, WebSocketEvents } from 'vitest';
import { testDOProject, createWSUpgradeRequest } from '@lumenize/testing';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers get started quickly.
 * 
 * Focus: Core library features and what you can do with instances.
 * Note: More comprehensive testing patterns are in comprehensive.test.ts
 */
describe('Basic Usage', () => {

  it('demonstrates fetch operation verified via instance access', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/fetch-then-assert/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('1');
      
      // Verify that count is correct in storage via instance access
      const instance = instances('MY_DO', 'fetch-then-assert');
      const storedCount = await instance.ctx.storage.get('count');
      expect(storedCount).toBe(1);
      
      const constructorName = await instance.constructor.name;
      expect(constructorName).toBe('MyDO');
      
      // Verify we can access environment through the instance
      const env = await instance.env;
      expect(env).toBeDefined();
      expect(typeof env).toBe('object');
    });
  });

  it('demonstrates pre-populating via instance and then doing a fetch operation', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Verify that count is correct in storage via instance access
      const instance = instances('MY_DO', 'put-then-fetch');
      await instance.ctx.storage.put('count', 10);

      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/put-then-fetch/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('11');
    });
  });

  it('cookie jar automatically manages cookies', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Set default hostname (could also be inferred from first fetch)
      helpers.options.hostname = 'example.com';
      
      // Login sets a cookie automatically
      await SELF.fetch('https://example.com/login?user=test');

      // Assert the token cookie was stored
      expect(helpers.cookies.get('token')).toBe('abc123');

      // Manually set an extra cookie
      // Note: domain is redundant here since hostname was set above,
      // but shown to demonstrate the explicit option for complex scenarios
      helpers.cookies.set('extra', 'manual-value', { domain: 'example.com' });

      // Protected route gets both cookies automatically
      const res = await SELF.fetch('https://example.com/protected-cookie-echo');
      const text = await res.text();
      expect(text).toContain('token=abc123');
      expect(text).toContain('extra=manual-value');
    });
  });

  it('demonstrates all available helpers.options (living documentation)', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Purpose: Set default hostname (used for cookies when domain not explicitly provided)
      // Default: undefined
      // Behavior: First fetch sets it if not manually set, but last manual setting wins
      helpers.options.hostname = 'example.com';
      
      // Purpose: Enable/disable automatic cookie management
      // Default: true (enabled)
      // When disabled: No cookies stored from Set-Cookie headers or sent with requests
      helpers.options.cookieJar = false; // Disable automatic cookie handling
    });
  });

  it('uses raw client ws from `[client, server] = new WebSocketPair()`', async () => {
    let onmessageCalled = false;
    await testDOProject(async (SELF, instances, helpers) => {  
      const request = createWSUpgradeRequest('https://example.com/my-do/get-ws', {
        protocols: ['protocol1', 'protocol2'],
        origin: 'https://custom-origin.com',
        headers: { 'Custom-Header': 'custom-value' }
      });
      const res = await SELF.fetch(request);
      const ws = res.webSocket as any;
      if (ws && res.status === 101) {
        ws.accept(); // This works because we're running inside of workerd
      }
      console.log('%o', ws);
      ws.onmessage = (event: any) => {
         expect(event.data).toBe('pong');
         onmessageCalled = true;
       };
       ws.send('ping');
       await vi.waitFor(() => expect(onmessageCalled).toBe(true))
    });
  });

  it.only('demonstrates helpers.WebSocket basic functionality', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // helpers.WebSocket should be our simple mock
      expect(helpers.WebSocket).toBeDefined();
      expect(typeof helpers.WebSocket).toBe('function');
      
      // Create a WebSocket instance
      const ws = new helpers.WebSocket('wss://example.com/my-do/get-ws');
      
      // Should have basic WebSocket properties that we actually implement
      expect(ws.url).toBe('wss://example.com/my-do/get-ws');
      
      // Should have basic methods that we actually implement
      expect(typeof ws.send).toBe('function');
      expect(typeof ws.close).toBe('function');
      
      // Should have WebSocket constants
      expect(helpers.WebSocket.CONNECTING).toBe(0);
      expect(helpers.WebSocket.OPEN).toBe(1);
      expect(helpers.WebSocket.CLOSED).toBe(3);
      
      // Test the functionality we actually implement
      ws.send('test message');
      ws.close();
    });
  });

});

describe('Limitations and quirks', () =>{

  it('requires await for all instance proxy access, even non-async functions and static properties', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'quirks');
      
      // 1. True async function - naturally requires await
      await instance.ctx.storage.put('async-key', 'async-value');
      const asyncResult = await instance.ctx.storage.get('async-key');
      expect(asyncResult).toBe('async-value');
      
      // 2. Non-async function - still requires await due to proxy architecture
      // instance.ctx.storage.kv.put() is synchronous but we must await it through the proxy
      await instance.ctx.storage.kv.put('kv-key', 'kv-value');
      const kvResult = await instance.ctx.storage.kv.get('kv-key');
      expect(kvResult).toBe('kv-value');
      
      // 3. Static property - even properties require await through the proxy
      // storage.sql.databaseSize is just a number property, but proxy requires await
      const dbSize = await instance.ctx.storage.sql.databaseSize;
      expect(typeof dbSize).toBe('number');
      expect(dbSize).toBeGreaterThanOrEqual(0);
      
      // This is the proxy quirk: everything looks like a function until awaited
      expect(typeof instance.ctx.storage.sql.databaseSize).toBe('function');
    });
  });

});

import { describe, it, expect, vi, WebSocketEvents } from 'vitest';
import { testDOProject, createWSUpgradeRequest } from '@lumenize/testing';

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library.
 * It's designed as living documentation to help developers get started quickly.
 */

// testDOProject now allows you to:
//   - Not a drop-in replacement but similar to cloudflare:test's runInDurableObject  
//   - Use `new WebSocket()` and "wss://..." urls just like you would in a browser
//   - Inspect the messages that were sent in and out (TODO: implement)
//   - Assert on close codes and reasons (TODO: implement)
//   - Discover any public member of your DO class (ctx, env, custom methods, etc.)
//   - Assert on any state change in instance variables or storage
//   - Manipulate storage prior to running a test
//   - Test using multiple WebSocket connections to the same DO instance (TODO: implement)
//   - Supply Origin and other Headers for WebSocket upgrades (TODO: confirm we have a test for this)
//   - Automatic cookie jar functionality to test complex auth and other cookie flows
describe('testDOProject core capabilities', () => {

  // testDOProject allows you to:
  //   - Pre-populate storage via direct instance access before operations
  //   - Use fetch operations to manipulate storage
  //   - Verify results via instance storage assertions
  it('demonstrates pre-populating via instance and then doing a fetch operation', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Verify that count is correct in storage via instance access
      const instance = instances('MY_DO', 'put-fetch-get');
      await instance.ctx.storage.put('count', 10);
  
      // Call increment
      const response = await SELF.fetch('https://example.com/my-do/put-fetch-get/increment');
      
      // Verify that we get back the incremented count
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toBe('11');

      // Verify that count is correct in storage via instance access
      const storedCount = await instance.ctx.storage.get('count');
      expect(storedCount).toBe(11);
    });
  });

  // testDOProject allows you to:
  //   - Access all public members on the DO instance (env, ctx, custom methods)
  //   - Inspect complete API surface including nested objects via property access preprocessing
  it('demonstrates complete DO instance property inspection and function discovery', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instanceAsProperty = await instances('MY_DO', 'property-inspection-test');
      
      expect(instanceAsProperty).toMatchObject({
        // DO methods are discoverable
        increment: "increment [Function]",
        
        // DurableObjectState context with complete API
        ctx: {
          storage: {
            get: "get [Function]",
            put: "put [Function]",
            // ... other storage methods available
          },
          getWebSockets: "getWebSockets [Function]",
          acceptWebSocket: "acceptWebSocket [Function]",
          setWebSocketAutoResponse: "setWebSocketAutoResponse [Function]",
          // ... other ctx methods available
        },
        
        // Environment object with DO bindings
        env: {
          MY_DO: {
            getByName: "getByName [Function]",
            newUniqueId: "newUniqueId [Function]",
            // ... other binding methods available
          },
          // ... other environment bindings available
        }
      });
    });
  });

  // testDOProject allows you to:
  //   - Use automatic cookie jar to test auth and other cookie based flows
  it('demonstrates cookie jar automatically manages cookies', async () => {
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

  // testDOProject allows you to:
  //   - Configure various helper options for different testing scenarios
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

  // testDOProject allows you to:
  //   - Use any client library that directly calls `new WebSocket()` via helpers.WebSocket
  //   - Browser-compatible WebSocket API that routes through DO testing infrastructure
  it.only('demonstrates testing DO WebSocket implementation using browser WebSocket API', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      let onMessageCalled = false;
      
      const ws = new helpers.WebSocket('wss://example.com/my-do/test-ws');

      ws.send('ping');
      
      ws.onmessage = async (event: any) => {
        // WebSocketRequestResponsePair("ping", "pong"),
        expect(event.data).toBe('pong');
        onMessageCalled = true;
      };

      ws.onerror = (event: any) => {
        console.log('%o', event);
        // TODO: Make it throw an error and add assertion
      };

      // TODO: Are there any other WebSocket methods/properties we should show

      await vi.waitFor(() => expect(onMessageCalled).toBe(true));

      const webSocketsOnServer = await instances('MY_DO', 'test-ws').ctx.getWebSockets('test-ws');
      expect(webSocketsOnServer.length).toBe(1);

      const instance = await instances('MY_DO', 'test-ws');
      const webSocketsOnServer2 = await instance.ctx.getWebSockets('test-ws');
      expect(webSocketsOnServer2.length).toBe(1);

      ws.close();
    });
  });

  // testDOProject allows you to:
  //   - Call DO methods directly via instance proxy (RPC-style)
  //   - Support all structured clone types except functions (like Cloudflare native RPC)
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, attachments, etc.
  //   - Use connection tagging with WebSocket names from URL paths
  it.todo('demonstrates direct DO method calls (RPC) and ctx inspection with WebSocket attachments');

  // testDOProject allows you to:
  //   - Test using multiple WebSocket connections to the same DO instance
  //   - Track operations and verify execution order
  it.todo('demonstrates multiple WebSocket connections and operation tracking');

  // testDOProject allows you to:
  //   - Supply custom headers via WebSocket factory options
  //   - Configure WebSocket shim behavior per test
  it.todo('demonstrates custom headers via WebSocket factory options');

});

describe('Limitations and quirks', () =>{

  // testDOProject has this limitation:
  //   - All instance proxy access requires await, even for non-async functions and static properties
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

  // testDOProject does NOT have these limitations (unlike old runInDurableObject):
  //   - Input gates work naturally (no artificial serialization)
  //   - No need for mock.sync() - operations complete when they should
  //   - Native Durable Object behavior preserved
  it.todo('demonstrates natural input gate behavior vs old runInDurableObject artificial serialization');

});

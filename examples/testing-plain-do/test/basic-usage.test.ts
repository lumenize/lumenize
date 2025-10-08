/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library
 * for testing Durable Objects with minimal boilerplate.
 * It's designed as living documentation to help developers get started quickly.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestingClient, type RpcAccessible, CookieJar, SELF, getWebSocketShim } from '@lumenize/testing';
import { MyDO } from '../src';

type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;

// createTestingClient now allows you to:
//   - Superset of capabilities provided by cloudflare:test's runInDurableObject, and SELF
//   - Discover any public member of your DO class (ctx, env, custom methods, etc.)
//   - Assert on any state change in instance variables or storage
//   - Manipulate storage prior to running a test
//   - Supply Origin and other Headers for WebSocket upgrades
//   - Use CookieJar for complex auth and other cookie flows
//   - Inspect the messages that were sent in and out (TODO: implement when we have AgentClient example)
describe('@lumenize/testing core capabilities', () => {

  // createTestingClient allows you to:
  //   - Pre-populate storage via direct instance access before operations
  //   - Use fetch operations to manipulate storage
  //   - Verify results via instance storage assertions
  it('demonstrates pre-populating data, calling to change it, then checking data again', async () => {
    // Create RPC client with minimal config - just binding name and instance ID!
    await using client = createTestingClient<MyDOType>('MY_DO', 'put-fetch-get');

    // Pre-populate storage via RPC
    await client.ctx.storage.put('count', 10);

    // Make a regular fetch call to increment
    const response = await SELF.fetch('https://example.com/my-do/put-fetch-get/increment');
    
    // Verify that we get back the incremented count
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe('11');

    // Verify that count is correct in storage via RPC
    const storedCount = await client.ctx.storage.get('count');
    expect(storedCount).toBe(11);
  });

  // createTestingClient allows you to:
  //   - Discover all public members on the DO instance (env, ctx, custom methods)
  //   - Make assertions on non-function properties
  it('demonstrates DO inspection and function discovery using __asObject()', async () => {
    await using client = createTestingClient<MyDOType>('MY_DO', 'property-inspection-test');

    const instanceAsObject = await client.__asObject?.();
    console.log('%o', instanceAsObject);
    console.log(JSON.stringify(instanceAsObject, null, 2));
    
    expect(instanceAsObject).toMatchObject({
      // DO methods are discoverable
      increment: "increment [Function]",
      
      // DurableObjectState context with complete API
      ctx: {
        storage: {
          get: "get [Function]",
          put: "put [Function]",
          // ... other storage methods available
          sql: {
            databaseSize: expect.any(Number), // Assert on non-function properties
            // ... other ctx.sql methods
          },
        },
        getWebSockets: "getWebSockets [Function]",
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

  // createTestingClient with CookieJar allows you to:
  //   - Use CookieJar to test auth and other cookie based flows
  it('demonstrates cookie jar automatically manages cookies', async () => {
    // Create cookie jar
    const cookieJar = new CookieJar();
    cookieJar.setDefaultHostname('example.com');
    
    // Pass cookie jar to createTestingClient - it will automatically wrap fetch
    const cookieAwareFetch = cookieJar.getFetch(SELF.fetch.bind(SELF));

    // Login sets a cookie automatically
    await cookieAwareFetch('https://example.com/login?user=test');

    // Assert the token cookie was stored
    expect(cookieJar.getCookie('token')).toBe('abc123');

    // Manually set an extra cookie
    cookieJar.setCookie('extra', 'manual-value', { domain: 'example.com' });

    // Protected route gets both cookies automatically
    const res = await cookieAwareFetch('https://example.com/protected-cookie-echo');
    const text = await res.text();
    expect(text).toContain('token=abc123');
    expect(text).toContain('extra=manual-value');
  });

  // createTestingClient allows you to:
  //   - Configure various options for different testing scenarios
  it('demonstrates all available TestingClientOptions (living documentation)', async () => {
    const cookieJar = new CookieJar();
    cookieJar.setDefaultHostname('example.com');
    
    // All options in one place - createTestingClient handles the rest!
    await using client = createTestingClient<MyDOType>(
      // Required: DO binding name from wrangler.jsonc
      'MY_DO',
      
      // Required: Instance name or ID
      'config-demo',
      
      // Optional configuration object
      {
        // Optional: Transport type ('http' or 'websocket')
        // Default: 'http' (simpler for tests)
        transport: 'websocket',
        
        // Optional: Cookie jar for automatic cookie management
        // When provided, all requests will include cookies
        cookieJar,
        
        // Optional: Request timeout in milliseconds
        // Default: 30000
        timeout: 30000,
        
        // Optional: Custom headers for all requests
        // Default: {}
        headers: {},
        
        // Note: When using websocket transport, createTestingClient automatically
        // sets up the WebSocket shim - no need to manually configure it!
      }
    );

    // Client is ready to use
    const count = await client.increment();
    expect(typeof count).toBe('number');
  });

  // createTestingClient with getWebSocketShim allows you to:
  //   - Use familiar WebSocket API via getWebSocketShim
  //   - Browser-compatible WebSocket that routes through DO testing infrastructure
  it('demonstrates testing DO WebSocket implementation using browser WebSocket API', async () => {
    // Get WebSocket shim for testing WebSocket connections directly
    const WebSocketShim = getWebSocketShim(SELF.fetch.bind(SELF));
    
    let onMessageCalled = false;
    
    const ws = new WebSocketShim('wss://example.com/my-do/test-ws') as any;

    ws.send('ping');
    
    ws.onmessage = async (event: any) => {
      // tests WebSocketRequestResponsePair("ping", "pong")
      expect(event.data).toBe('pong');
      onMessageCalled = true;
    };

    // TODO: Are there any other WebSocket methods/properties we should show

    await vi.waitFor(() => expect(onMessageCalled).toBe(true));

    // Create RPC client to inspect server-side WebSocket state
    await using client = createTestingClient<MyDOType>('MY_DO', 'test-ws');

    const webSocketsOnServer = await client.ctx.getWebSockets('test-ws');
    expect(webSocketsOnServer.length).toBe(1);
    
    const serverWS = webSocketsOnServer[0];
    
    const { deserializeAttachment } = serverWS;
    console.log('%o', deserializeAttachment);
    
    const attachment = await deserializeAttachment();
    console.log('%o', attachment);

    ws.close();
  });

  // createTestingClient allows you to:
  //   - Call DO methods directly via RPC client (RPC-style)
  //   - Support all structured clone types except functions (like Cloudflare native RPC)
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, attachments, etc.
  //   - Use connection tagging with WebSocket names from URL paths
  it.todo('demonstrates direct DO method calls (RPC) and ctx inspection with WebSocket attachments');

  // createTestingClient allows you to:
  //   - Test using multiple WebSocket connections to the same DO instance
  //   - Track operations and verify execution order
  it.todo('demonstrates multiple WebSocket connections and operation tracking');

  // createTestingClient allows you to:
  //   - Supply custom headers via getWebSocketShim factory options
  //   - Configure WebSocket shim behavior per test
  it.todo('demonstrates custom headers via WebSocket factory options');

});

describe('Limitations and quirks', () => {

  // createTestingClient has these quirks:
  //   - Function calls require await, property access is synchronous, static values via __asObject()
  it('requires await for even non-async function calls', async () => {
    await using client = createTestingClient<MyDOType>('MY_DO', 'quirks');

    console.log('%o', client);
    
    // 1. Function calls require await even if what they are calling is not async inside the DO

    // using `async ctx.storage.put(...)`
    // requires await in both RPC client and the DO
    await client.ctx.storage.put('key', 'value');

    // using non-async `ctx.storage.kv.get(...)`
    // would not require await in DO but does in RPC client
    const asyncResult = await client.ctx.storage.kv.get('key');
    expect(asyncResult).toBe('value');
    
    // 2. Property access can be chained and destructured (returns a new Proxy)
    const storage = client.ctx.storage;
    const { sql } = storage;
    
    // 3. Static properties can be accessed directly and require await
    expect(typeof (await sql.databaseSize)).toBe('number');
    
    // 4. __asObject() is only callable from the root client, not nested proxies
    // But it returns the complete nested structure as plain data
    const fullObject = await client.__asObject?.();
    
    // Access nested static properties from the returned plain object
    expect(typeof fullObject?.ctx?.storage?.sql?.databaseSize).toBe('number');
    expect(fullObject?.ctx?.storage?.sql?.databaseSize).toBe(await sql.databaseSize);
    
    // This demonstrates: root __asObject() gives you the full tree,
    // but you can't call __asObject() on nested proxies like sql
    // (Attempting to access it returns undefined since it's not defined on nested proxies)
  });

  // createTestingClient does NOT have these limitations (unlike old runInDurableObject):
  //   - Input gates work naturally (no artificial serialization)
  //   - No need for mock.sync() - operations complete when they should
  //   - Native Durable Object behavior preserved
  it.todo('demonstrates natural input gate behavior vs old runInDurableObject artificial serialization');

});

/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file demonstrates the essential usage patterns of the @lumenize/testing library
 * for testing Durable Objects with minimal boilerplate.
 * 
 * @lumenize/testing provides:
 *   - createTestingClient: Minimal RPC client for DO testing (just binding name + instance name/Id!)
 *   - fetch: Simple fetch for making requests to your worker
 *   - WebSocket: Browser-compatible WebSocket for DO connections
 *   - Browser: Simulates browser behavior for testing
 *     - browser.fetch --> cookie-aware fetch (no Origin header)
 *     - browser.WebSocket --> cookie-aware WebSocket constructor (no Origin header)
 *     - browser.page(origin) --> returns { fetch, WebSocket } with Origin header
 *       - Both automatically include cookies from the Browser instance
 *       - Simulates requests from a page loaded from the given origin
 *       - Perfect for testing CORS and Origin validation logic
 * 
 * Key features:
 *   - Discover any public member of your DO class (ctx, env, custom methods, etc.)
 *   - Manipulate storage and other state prior to running a test
 *   - Assert on any state change in instance variables or storage
 *   - Test Origin validation for both HTTP and WebSocket requests
 *   - Simulate browser behavior with automatic cookie management
 *   - TODO: Inspect the messages that were sent in and out (TODO: implement when we have AgentClient example)
 *   - TODO: Need to write test that exercises WebSocket protocol selection already implemented in index.ts
 *   - TODO: Either remove the following in index.ts or test it, super.fetch(), webSocketOpen(), webSocketMessage(), and webSocketClose()
 *   - No need to worry about internals of cloudflare:test
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestingClient, Browser, fetch, WebSocket, type RpcAccessible } from '@lumenize/testing';
import { MyDO } from '../src';

type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;

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
    const response = await fetch('https://example.com/my-do/put-fetch-get/increment');
    
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

  // createTestingClient with WebSocket allows you to:
  //   - Use familiar WebSocket API
  //   - Browser-compatible WebSocket that routes through DO testing infrastructure
  it('demonstrates testing DO WebSocket implementation using browser WebSocket API', async () => {
    // Use WebSocket directly - no need to call getWebSocketShim!
    // Note: Cast to `any` needed because Cloudflare's WebSocket type doesn't include event handlers
    // but our shim implements the full browser WebSocket API
    const ws = new WebSocket('wss://example.com/my-do/test-ws') as any;

    let onMessageCalled = false;

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
  it.todo('demonstrates multiple WebSocket connections');

  // Browser shares cookies between fetch and WebSocket:
  //   - Login via fetch, then WebSocket uses the same session
  //   - Both use the same Browser instance
  it('demonstrates cookie sharing between fetch and WebSocket from same browser', async () => {
    // Create ONE browser instance
    const browser = new Browser();
    
    // 1. Login via fetch - sets session cookie (no need to pass fetch!)
    await browser.fetch('https://example.com/login?user=test');
    
    // 2. Verify cookie was stored in the browser
    expect(browser.getCookie('token')).toBe('abc123');
    
    // 3. Manually add additional cookies - domain is inferred from first fetch
    browser.setCookie('extra', 'manual-value');
    
    // 4. Make another fetch request - gets BOTH cookies automatically
    const res = await browser.fetch('https://example.com/protected-cookie-echo');
    const text = await res.text();
    expect(text).toContain('token=abc123');      // From login
    expect(text).toContain('extra=manual-value'); // Manually added
    
    // 5. WebSocket connection also gets BOTH cookies automatically!
    // Note: Cast to `any` needed because Cloudflare's WebSocket type doesn't include event handlers
    const ws = new browser.WebSocket('wss://example.com/my-do/shared-cookies') as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // 6. Verify WebSocket connection was established with cookies
    await using client = createTestingClient<MyDOType>('MY_DO', 'shared-cookies');
    const wsList = await client.ctx.getWebSockets('shared-cookies');
    expect(wsList.length).toBe(1);
    
    ws.close();
  });

  // Browser.page() allows you to:
  //   - Test CORS/Origin validation in your Workers/DOs
  //   - Simulate requests from a specific origin
  //   - Add custom headers and configure WebSocket options
  it('demonstrates testing Origin validation using browser.page()', async () => {
    const browser = new Browser();
    
    // Create a page with Origin header + custom headers
    const page = browser.page('https://example.com', {
      headers: { 'X-Custom-Header': 'test-value' },
      maxQueueBytes: 1024 * 1024 // 1MB WebSocket queue limit while CONNECTING
    });
    
    // HTTP request includes Origin header - allowed
    const response = await page.fetch('https://example.com/cors-secure/my-do/cors-test/increment');
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    
    // WebSocket upgrade includes Origin header - allowed
    const ws = new page.WebSocket('wss://example.com/cors-secure/my-do/ws-test') as any;
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    expect(ws.response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    ws.close();
    
    // Blocked origin - server rejects with 403 (server-side validation)
    const blocked = await browser.page('https://evil.com').fetch('https://example.com/cors-secure/my-do/blocked/increment');
    expect(blocked.status).toBe(403);
    
    // Verify DO was never called (count still 1, not 2)
    await using client = createTestingClient<MyDOType>('MY_DO', 'blocked');
    expect(await client.increment()).toBe(1);
  });

});

describe('Quirks', () => {

  // createTestingClient has these quirks:
  //   - Even non-async function calls require `await`
  //   - Property access is synchronous on __asObject(), but...
  //   - Even static property access requires `await` outside of __asObject()
  it('requires await for even non-async function calls', async () => {
    await using client = createTestingClient<MyDOType>('MY_DO', 'quirks');

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
    
    // 5. No `await` needed to access nested static properties from __asObject()
    expect(typeof fullObject?.ctx?.storage?.sql?.databaseSize).toBe('number');
    expect(fullObject?.ctx?.storage?.sql?.databaseSize).toBe(await sql.databaseSize);
  });

});

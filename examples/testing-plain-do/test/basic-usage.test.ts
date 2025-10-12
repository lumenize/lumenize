/**
 * Basic Usage Examples for @lumenize/testing
 * 
 * This file shows the essential usage patterns of the @lumenize/testing library
 * for testing Durable Objects with minimal boilerplate.
 * 
 * @lumenize/testing provides:
 *   - createTestingClient: Alter and inspect DO state (ctx..., custom methods/properties, etc.)
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
 *   - TODO: Either remove the following in index.ts or test it, super.fetch(), webSocketOpen(), webSocketMessage(), and webSocketClose()
 *   - No need to worry about internals of cloudflare:test
 */

import { it, expect, vi } from 'vitest';
import { createTestingClient, Browser, fetch, WebSocket, type RpcAccessible } from '@lumenize/testing';
import { MyDO } from '../src';

type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;

// createTestingClient allows you to:
//   - Pre-populate storage via direct instance access before operations
//   - Use fetch operations to manipulate storage
//   - Call public methods directly via RPC
//   - Verify results via instance storage assertions
it('shows pre-populating DO state, interacting with it, then checking state after', async () => {
  // Create RPC client with binding name and instance name
  await using client = createTestingClient<MyDOType>('MY_DO', 'put-do-get');

  // Pre-populate storage via RPC asycn KV API
  await client.ctx.storage.put('count', 10);

  // Make a regular fetch call to increment
  expect(await (await fetch('https://ex.com/my-do/put-do-get/increment')).text()).toBe('11');

  // Call increment via RPC and get count as a number
  expect(await client.increment()).toBe(12);

  // Verify that storage is correct via RPC non-async KV API but still requires `await`
  expect(await client.ctx.storage.kv.get('count')).toBe(12);
});

// createTestingClient with WebSocket allows you to:
//   - Use familiar WebSocket API
//   - Browser-compatible WebSocket that routes through DO testing infrastructure
//   - Test WebSocket sub-protocol selection
//   - Interact with server-side WebSockets (getWebSockets("tag"), etc.)
//   - Assert on WebSocket attachments
it('shows testing WebSocket functionality', async () => {
  // Use WebSocket directly - no need to call getWebSocketShim!
  // Note: Cast to `any` needed because Cloudflare's WebSocket type doesn't include event handlers
  // but our shim implements the full browser WebSocket API

  // Create RPC client to inspect server-side WebSocket state
  await using client = createTestingClient<MyDOType>('MY_DO', 'test-ws');
  
  // Create a WebSocket and wait for it to open
  const ws = new WebSocket('wss://example.com/my-do/test-ws', ['wrong.protocol', 'correct.subprotocol']) as any;
  let wsOpened = false
  ws.onopen = () => wsOpened = true;
  await vi.waitFor(() => expect(wsOpened).toBe(true));

  // Verify the selected protocol matches what server chose
  expect(ws.protocol).toBe('correct.subprotocol');

  // TODO: Simulate normal WebSocket operations by inspecting storage for tracked operations See: #trackOperation() in index.ts

  // Access getWebSockets using tag that matches DO instance name
  const webSocketsOnServer = await client.ctx.getWebSockets('test-ws');
  expect(webSocketsOnServer.length).toBe(1);

  // Assert on ws attachment
  const { deserializeAttachment } = webSocketsOnServer[0];
  const attachment = await deserializeAttachment();
  expect(attachment).toMatchObject({
    name: 'test-ws',  // From URL path: /my-do/test-ws
    headers: expect.objectContaining({
      'upgrade': 'websocket',
      'sec-websocket-protocol': 'wrong.protocol, correct.subprotocol'
    })
  });

  // Tests ctx.setWebSocketAutoResponse by creating a new ws connection to the same DO
  const ws2 = new WebSocket('wss://example.com/my-do/test-ws') as any;
  let autoResponseReceived = false;
  ws2.send('auto-response-ping');
  ws2.onmessage = async (event: any) => {
    expect(event.data).toBe('auto-response-pong');
    autoResponseReceived = true;
  };
  await vi.waitFor(() => expect(autoResponseReceived).toBe(true));

  ws.close();
});

// createTestingClient allows you to:
//   - Support all structured clone types except functions (like Cloudflare native RPC)
it('shows RPC working with StructuredClone types', async () => {
  await using client = createTestingClient<MyDOType>('MY_DO', 'structured-clone');

  // Map (and every other structured clone types) works with storage
  const testMap = new Map<string, any>([['key1', 'value1'], ['key2', 42]]);
  client.ctx.storage.kv.put('testMap', testMap);
  const retrievedMap = await client.ctx.storage.kv.get<Map<string, any>>('testMap');
  expect(retrievedMap).toEqual(testMap);
  
  // Map (and every other structured clone types) also works with custom method echo()
  const echoedMap = await client.echo(testMap);
  expect(echoedMap).toEqual(testMap);

  // We're just going to use echo() to show other types work

  // Set
  const testSet = new Set<any>([1, 2, 3, 'four']);
  expect(await client.echo(testSet)).toEqual(testSet);

  // Date
  const testDate = new Date('2025-10-12T12:00:00Z');
  expect(await client.echo(testDate)).toEqual(testDate);

  // Circular reference
  const circular: any = { name: 'circular' };
  circular.self = circular;
  expect(await client.echo(circular)).toEqual(circular); // Circular ref preserved at correct level
});

// createTestingClient allows you to:
//   - Test using multiple WebSocket connections to the same DO instance
//   - Use connection tagging with Do instance name from URL, then call ctx.getWebSockets('my-tag')
it('shows multiple WebSocket connections', async () => {
  // Create two WebSocket connections to the same DO instance
  const ws1 = new WebSocket('wss://example.com/my-do/multi-ws') as any;
  const ws2 = new WebSocket('wss://example.com/my-do/multi-ws') as any;
  
  let ws1Opened = false;
  let ws2Opened = false;
  
  ws1.onopen = () => { ws1Opened = true; };
  ws2.onopen = () => { ws2Opened = true; };
  
  await vi.waitFor(() => expect(ws1Opened).toBe(true));
  await vi.waitFor(() => expect(ws2Opened).toBe(true));
  
  // Verify both connections are active on the server
  await using client = createTestingClient<MyDOType>('MY_DO', 'multi-ws');
  const webSockets = await client.ctx.getWebSockets('multi-ws');
  expect(webSockets.length).toBe(2);
  
  ws1.close();
  ws2.close();
});

// Browser shares cookies between fetch and WebSocket:
//   - Login via fetch, then WebSocket uses the same session
//   - Both use the same Browser instance
it('shows cookie sharing between fetch and WebSocket from same browser', async () => {
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
it('shows testing Origin validation using browser.page()', async () => {
  const browser = new Browser();
  
  // Create a page with Origin header + custom headers
  // Note: headers/maxQueueBytes configured at page level to maintain standard WebSocket API
  const page = browser.page('https://my-origin.com', {
    headers: { 'X-Custom-Header': 'test-value' },
    maxQueueBytes: 1024 * 1024 // 1MB WebSocket queue limit while CONNECTING
  });
  
  // WebSocket upgrade includes Origin header
  const ws = new page.WebSocket('wss://my-origin.com/cors-secure/my-do/ws-test') as any;
  let wsOpened = false;
  ws.onopen = () => { wsOpened = true; };
  await vi.waitFor(() => expect(wsOpened).toBe(true));
  // Note: browser standard WebSocket doesn't have a response property, but ours does for testing
  expect(ws.response.headers.get('Access-Control-Allow-Origin')).toBe('https://my-origin.com');
  ws.close();
  
  // HTTP request also includes Origin header - allowed
  const response = await page.fetch('https://my-origin.com/cors-secure/my-do/cors-test/increment');
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://my-origin.com');
  
  // Set up: Pre-populate count to verify DO is never called
  await using client = createTestingClient<MyDOType>('MY_DO', 'blocked');
  await client.ctx.storage.put('count', 42);

  // Blocked origin - server rejects with 403 without CORS headers
  // In a real browser, this would throw a network error (CORS failure)
  // But in testing, we can still inspect the response    
  const blocked = await browser.page('https://evil.com').fetch('https://my-origin.com/cors-secure/my-do/blocked/increment');
  expect(blocked.status).toBe(403);
  expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull(); // No CORS headers
  
  // Verify DO was never called - count is still 42 (not 43)
  const count = await client.ctx.storage.get('count');
  expect(count).toBe(42);
});

// createTestingClient allows you to:
//   - Discover all public members on the DO instance (env, ctx, custom methods)
it('shows DO inspection and function discovery using __asObject()', async () => {
  await using client = createTestingClient<MyDOType>('MY_DO', 'property-inspection-test');

  const instanceAsObject = await client.__asObject?.();
  
  expect(instanceAsObject).toMatchObject({
    // DO methods are discoverable
    increment: "increment [Function]",
    
    // DurableObjectState context with complete API
    ctx: {
      storage: {
        get: "get [Function]",
        // ... other storage methods available
        sql: {
          databaseSize: expect.any(Number), // Assert on non-function properties
          // ... other ctx.sql methods
        },
        kv: {
          get: "get [Function]",
          // ... other storage methods available
        },
      },
      getWebSockets: "getWebSockets [Function]",
      // ... other ctx methods available
    },
    
    // Environment object with DO bindings
    env: {
      MY_DO: {
        getByName: "getByName [Function]",
        // ... other binding methods available
      },
      // ... other environment bindings available
    }
  });
});


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


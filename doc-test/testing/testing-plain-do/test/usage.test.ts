/*
# Usage
*/

/*
`@lumenize/testing` is a superset of functionality of cloudflare:test with a 
more *de*light*ful* DX. While `cloudflare:test`'s `runInDurableObject` only 
allows you to work with `ctx`/`state`, `@lumenize/testing` also allows you to 
do that plus:
  - Inspect or manipulate instance variables (custom, this.env, etc.), not just 
    ctx
  - Call instance methods directly from your test
  - Greatly enhances your ability to test DOs via WebSockets
  - Simulate browser behavior with cookie management and realistic CORS
    simulation
  - Honors input/output gates (`runInDurableObject` does not) to test for race
    conditions
  - Does all of the above with a fraction of the boilerplate

`@lumenize/testing` provides:
  - `createTestingClient`: An RPC client that allows you to alter and inspect 
    DO state (`ctx`..., custom methods/properties, etc.)
  - `Browser`: Simulates browser behavior for testing
    - `browser.fetch` --> cookie-aware fetch (no Origin header)
    - `browser.WebSocket` --> cookie-aware WebSocket constructor (no Origin
      header)
    - `browser.context(origin)` --> returns `{ fetch, WebSocket }`
      - `fetch` and `WebSocket` automatically include cookies
      - Simulates requests from a context loaded from the given origin
      - Perfect for testing CORS and Origin validation logic
*/

/*
## Basic Usage

Now, let's show basic usage following the basic pattern for all tests:
1. **Setup test**. initialize testing client, test variables, etc.
2. **Setup state**. storage, instance variables, etc.
3. **Interact as a user/caller would**. call `fetch`, custom methods, etc.
4. **Assert on output**. check responses
5. **Assert state**. check that storage and instance variables are as expected
*/
import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient, Browser } from '@lumenize/testing';
import { MyDO } from '../src';

type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;

it('shows basic 5-step test', async () => {
  // 1. Create RPC testing client and Browser instance
  await using client = createTestingClient<MyDOType>('MY_DO', '5-step');
  const browser = new Browser();

  // 2. Pre-populate storage via RPC to call asycn KV API
  await client.ctx.storage.put('count', 10);

  // 3. Make a fetch and RPC call to increment
  const resp = await browser.fetch('https://test.com/my-do/5-step/increment');
  const rpcResult = await client.increment();

  // 4. Confirm that results are as expected
  expect(await resp.text()).toBe('11');
  expect(rpcResult).toBe(12);  // Notice this is a number not a string

  // 5. Verify that storage is correct via RPC
  expect(await client.ctx.storage.kv.get('count')).toBe(12);
});

/*
Next, we'll walk through a series of more advanced scenarios, but first let's 
show you how to configure your system to use `@lumenize/testing`.

## Installation

First let's install some tools

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/testing
```

## src/index.ts

Let's say you have this Worker and Durable Object:

@import {typescript} "../src/index.ts" [src/index.ts]

## test/test-harness.ts

Create a test folder and drop this simple test harness into it:

@import {typescript} "./test-harness.ts" [test/test-harness.ts]

## test/wrangler.jsonc

Take your existing wrangler.jsonc and make a copy of it in the test folder.
Then change the `main` setting to the `./test-harness.ts`. So:

@import {json} "./wrangler.jsonc" [test/wrangler.jsonc]

## vitest.config.js

Then add to your `vite` config, if applicable, or create a `vitest` config that 
looks something like this:

@import {javascript} "../vitest.config.js" [vitest.config.js]

## Your tests

Then write your tests using vitest as you would normally. The rest of this 
document are examples of tests you might write for the Worker and DO above.

*/

/*
## WebSocket

One of the biggest shortcomings of `cloudflare:test` and perhaps the primary
motivator for using `@lumenize/testing` is support for testing your DO's
WebSocket implementation. With `@lumenize/testing`:
  - Use browser-compatible WebSocket API
  - Routes WebSocket upgrade through Worker so that gets tested (unlike
    `runInDurableObject`)
  - Test WebSocket sub-protocol selection
  - Interact with server-side WebSockets (getWebSockets("tag"), etc.)
  - Assert on WebSocket attachments
  - Test your `WebSocketRequestResponsePair` (impossible with 
    `runInDurableObject`)
*/
it('shows testing WebSocket functionality', async () => {
  // Create RPC client to inspect server-side WebSocket state
  await using client = createTestingClient<MyDOType>('MY_DO', 'test-ws');

  // Create WebSocket client
  const WebSocket = new Browser().WebSocket;
  
  // Create a WebSocket and wait for it to open
  const ws = new WebSocket('wss://test.com/my-do/test-ws', ['a', 'b']) as any;
  let wsOpened = false
  ws.onopen = () => wsOpened = true;
  await vi.waitFor(() => expect(wsOpened).toBe(true));

  // Verify the selected protocol matches what server chose
  expect(ws.protocol).toBe('b');

  // Send 'increment' message and verify response
  let incrementResponse: string | null = null;
  ws.onmessage = (event: any) => {
    incrementResponse = event.data;
  };
  ws.send('increment');
  await vi.waitFor(() => expect(incrementResponse).toBe('1'));
  
  // Trigger server-initiated close and verify close event
  let closeEventFired = false;
  let closeCode: number | null = null;
  ws.onclose = (event: any) => {
    closeEventFired = true;
    closeCode = event.code;
  };
  ws.send('test-server-close');
  await vi.waitFor(() => expect(closeEventFired).toBe(true));
  expect(closeCode).toBe(4001);

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
      'sec-websocket-protocol': 'a, b'
    })
  });

  // Tests ctx.setWebSocketAutoResponse w/ new connection to the same DO
  const ws2 = new WebSocket('wss://test.com/my-do/test-ws') as any;
  let autoResponseReceived = false;
  ws2.send('ar-ping');
  ws2.onmessage = async (event: any) => {
    expect(event.data).toBe('ar-pong');
    autoResponseReceived = true;
  };
  await vi.waitFor(() => expect(autoResponseReceived).toBe(true));

  ws.close();
});

/*
## StructuredClone Types

All structured clone types are supported (like Cloudflare native RPC).
*/
it('shows RPC working with StructuredClone types', async () => {
  await using client = createTestingClient<MyDOType>('MY_DO', 'sc');

  // Map (and all StructuredClone types) works with storage
  const testMap = new Map<string, any>([['key1', 'value1'], ['key2', 42]]);
  client.ctx.storage.kv.put('testMap', testMap);
  const retrievedMap = await client.ctx.storage.kv.get('testMap');
  expect(retrievedMap).toEqual(testMap);
  
  // Map (and all StructuredClone types) also works with custom method echo()
  const echoedMap = await client.echo(testMap);
  expect(echoedMap).toEqual(testMap);

  // Set
  const testSet = new Set<any>([1, 2, 3, 'four']);
  expect(await client.echo(testSet)).toEqual(testSet);

  // Date
  const testDate = new Date('2025-10-12T12:00:00Z');
  expect(await client.echo(testDate)).toEqual(testDate);

  // Circular reference
  const circular: any = { name: 'circular' };
  circular.self = circular;
  expect(await client.echo(circular)).toEqual(circular);
});

/*
## Cookies

`Browser` allows cookies to be shared between `fetch` and `WebSocket` just
like in a real browser. Use `setCookie()` and `getCookie()` for testing
and debugging.
*/
it('shows cookie sharing between fetch and WebSocket', async () => {
  // Create client and browser instances
  await using client = createTestingClient<MyDOType>('MY_DO', 'cookies');
  const browser = new Browser();
  
  // Login via fetch - sets session cookie (no need to pass fetch!)
  await browser.fetch('https://test.com/login?user=test');
  
  // Verify cookie was stored in the browser
  expect(browser.getCookie('token')).toBe('abc123');
  
  // Manually add additional cookies - domain is inferred from first fetch
  browser.setCookie('extra', 'manual-value');
  
  // Make another fetch request - gets BOTH cookies automatically
  const res = await browser.fetch('https://test.com/protected-cookie-echo');
  const text = await res.text();
  expect(text).toContain('token=abc123');       // From login
  expect(text).toContain('extra=manual-value'); // Manually added
  
  // WebSocket connection also gets BOTH cookies automatically!
  const ws = new browser.WebSocket('wss://test.com/my-do/cookies') as any;
  
  let wsOpened = false;
  ws.onopen = () => { wsOpened = true; };
  
  await vi.waitFor(() => expect(wsOpened).toBe(true));
  
  // Verify server received the cookies in the WebSocket upgrade request
  const wsList = await client.ctx.getWebSockets('cookies');
  const attachment = await wsList[0].deserializeAttachment();
  expect(attachment.headers.cookie).toContain('token=abc123');
  expect(attachment.headers.cookie).toContain('extra=manual-value');
  
  ws.close();
});

/*
## Simulate browser context Origin behavior

`Browser.context()` allows you to test CORS/Origin validation logic in your 
Worker or Durable Object. The `context().fetch` method automatically validates 
CORS headers for cross-origin requests and throws a `TypeError` (just like a 
real browser) when the server doesn't return proper CORS headers or when the 
origin doesn't match.

This test also shows off the non-standard extension to the WebSocket API that 
allows you to inspect the underlying HTTP Request and Response objects, which 
is useful for debugging and asserting.
*/
it('shows testing Origin validation using browser.context()', async () => {
  const browser = new Browser();
  
  // Create a context with Origin header
  const context = browser.context('https://safe.com');
  
  // WebSocket upgrade includes Origin header
  const ws = new context.WebSocket('wss://safe.com/cors/my-do/ws-test') as any;
  let wsOpened = false;
  ws.onopen = () => { wsOpened = true; };
  await vi.waitFor(() => expect(wsOpened).toBe(true));
  // Note: browser standard WebSocket doesn't have request/response properties, 
  // but they're useful for debugging and asserting.
  expect(ws.request.headers.get('Origin')).toBe('https://safe.com');
  const acaoHeader = ws.response.headers.get('Access-Control-Allow-Origin');
  expect(acaoHeader).toBe('https://safe.com');
  ws.close();
  
  // HTTP request also includes Origin header - allowed
  let res = await context.fetch('https://safe.com/cors/my-do/test/increment');
  const acaoHeaderFromFetch = res.headers.get('Access-Control-Allow-Origin');
  expect(acaoHeaderFromFetch).toBe('https://safe.com');
  
  // Now let's test a blocked Origin evil.com

  // Set up: Pre-populate count to verify DO is never called
  await using client = createTestingClient<MyDOType>('MY_DO', 'blocked');
  await client.ctx.storage.put('count', 42);

  // Blocked origin - server rejects with 403 without CORS headers
  // Browser.context().fetch validates CORS headers and throws TypeError
  // when CORS validation fails, just like a real browser would
  const pg = browser.context('https://evil.com');
  
  // Expect TypeError due to CORS error
  await expect(async () => {
    await pg.fetch('https://safe.com/cors/my-do/blocked/increment');
  }).rejects.toThrow(TypeError);
  await expect(async () => {
    await pg.fetch('https://safe.com/cors/my-do/blocked/increment');
  }).rejects.toThrow('CORS error');
  
  // Verify DO was never called - count is still 42 (not 43)
  const count = await client.ctx.storage.get('count');
  expect(count).toBe(42);
});

/*
## Test CORS preflight OPTIONS requests

Real browsers automatically send preflight OPTIONS requests for "non-simple" 
cross-origin requests (e.g., requests with custom headers, non-simple content 
types like application/json, or non-simple methods like PUT/DELETE/PATCH).

`Browser.context(origin).fetch` also sends preflight OPTIONS requests under 
the same conditions that real browsers do! This section demonstrates that 
behavior using requests with a custom header.

The context object includes a non-standard `lastPreflight` property that lets 
you inspect the preflight that was sent for testing or debugging.
*/
it('shows testing CORS preflight OPTIONS requests', async () => {
  const browser = new Browser();
  const appContext = browser.context('https://app.example.com');

  // Common requestOptions will trigger preflight if cross-origin
  const requestOptions = { headers: { 'X-Custom-Header': 'test-value' }};
  
  // Same-origin - no preflight needed even with custom header
  await appContext.fetch(
    'https://app.example.com/my-do/preflight/increment', 
    requestOptions
  );
  expect(appContext.lastPreflight).toBeNull(); // No preflight for same-origin
  
  // Cross-origin with custom header - triggers automatic preflight!
  const postResponse = await appContext.fetch(
    'https://safe.com/cors/my-do/preflight/increment',
    requestOptions
  );
  expect(appContext.lastPreflight?.success).toBe(true);  // preflight succeeded
  expect(postResponse.ok).toBe(true);  // request worked
  expect(postResponse.headers.get('Access-Control-Allow-Origin'))
    .toBe('https://app.example.com');  // CORS header reflects the origin
  
  // Cross-origin from disallowed evil.com - preflight fails!
  const evilContext = browser.context('https://evil.com');
  await expect(async () => {
    await evilContext.fetch(
      'https://safe.com/cors/my-do/preflight/increment',
      requestOptions
    );
  }).rejects.toThrow('CORS error');
  expect(evilContext.lastPreflight?.success).toBe(false);  // preflight failed
});

/*
## Discover all public members of DO

`createTestingClient.__asObject()` allows you to discover all public members on 
the DO instance (env, ctx, custom methods)
*/
it('shows DO inspection and function discovery using __asObject()', async () => {
  await using client = createTestingClient<MyDOType>('MY_DO', 'asObject');

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

/*
## Quirks

`createTestingClient` has these quirks:
  - Even non-async function calls require `await`
  - Property access is synchronous on `__asObject()`, but...
  - Even static property access requires `await` outside of `__asObject()`
*/
it('requires await for even non-async function calls', async () => {
  await using client = createTestingClient<MyDOType>('MY_DO', 'quirks');

  // All calls require await even if the function is not async

  // Using `async ctx.storage.put(...)` requires await in both RPC and the DO
  await client.ctx.storage.put('key', 'value');

  // Using non-async `ctx.storage.kv.get(...)`
  // does not require await in DO but does in RPC
  const asyncResult = await client.ctx.storage.kv.get('key');
  expect(asyncResult).toBe('value');
  
  // Property access can be chained and destructured (returns a new Proxy)
  const storage = client.ctx.storage;
  const { sql } = storage;
  
  // Static properties can be accessed directly and require await
  expect(typeof (await sql.databaseSize)).toBe('number');
  
  // __asObject() is only callable from the root client, not nested proxies
  // and it returns the complete nested structure as plain data
  const fullObject = await client.__asObject?.();
  
  // No `await` needed to access nested static properties from __asObject()
  expect(typeof fullObject.ctx.storage.sql.databaseSize).toBe('number');
  expect(fullObject.ctx.storage.sql.databaseSize).toBe(await sql.databaseSize);
});

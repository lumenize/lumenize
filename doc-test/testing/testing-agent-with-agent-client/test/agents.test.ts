// DOC-TEST FILE: This file generates documentation via @lumenize/doc-testing
// - Block comments (/* */) become Markdown in the docs
// - Code between block comments becomes code blocks in the docs
// - Single-line comments (//) before the first block comment (like this one)
//   do not show up in the generated doc
// - Single-line comments (//) after that are included in the generated doc
// - Use @import directives to include external files
// - Tests must pass - they validate the documentation
// - Keep code blocks within 80 columns to prevent horizontal scrolling
// - Keep it brief - this is documentation, not exhaustive testing
//   - Use one expect() to illustrate behavior
//   - Only add more expects if the boundaries/edge cases are the point
// - See: /tooling/doc-testing/README.md

/*
# Agents

This document demonstrates testing your use of Cloudflare's `Agent` class and 
`AgentClient` (both from the `agents` package) using `@lumenize/testing`. 
We show two scenarios:

1. **Multi-user chat** - Testing state synchronization across multiple 
   WebSocket connections
2. **Advanced authentication** - Using Cloudflare KV for session storage, token 
   smuggling via WebSocket protocols, and RPC access to verify authentication 
   state

For basic usage of `@lumenize/testing`, see the 
[usage documentation](/docs/testing/usage).

## Why testing an `Agent` is hard

To test your `Agent` implementation, you have a few options.

You could stand up two separate processes: one to host your Worker and `Agent` 
DO, and another to run `AgentClient` and have them talk over localhost to each 
other, but that's unnecessary friction, especially in CI; it doesn't give you 
unified test coverage metrics, and is less conducive to fast iteration by both 
people and AI coding agents. It also doesn't allow you to manipulate or inspect 
your Agent's state from your test except through your Agent's public API. In 
other words, no `runInDurableObject` capabilities, which brings us to...

You can avoid the multi-process approach by using `cloudflare:test`'s 
`runInDurableObject` to exercise your Agent DO, but you are calling handlers 
directly, which bypasses the Worker routing, input/output gates, your DO's own 
fetch, etc. This lower fidelity can allow subtle bugs to escape to production 
[like happened with `agents`](https://github.com/cloudflare/agents/issues/321).

On the other hand, `cloudflare:test` also provides `SELF.fetch()`. It runs 
through your Worker, DO fetch, respects input/output gates, etc. Yes, it's 
HTTP-only, but there is a little trick you can use to do some 
web socket testing. You can send in an HTTP Request with the correct 
upgrade headers, and extract the raw ws object out of the Response. Then use
`ws.send()` to send messages to your Agent's onMessage handler. Some of the 
`agents` package tests now do exactly this. However, this raw ws object is not 
a full WebSocket instance, and even if it were, classes like `AgentClient` 
expect to instantiate the WebSocket themselves. Without `AgentClient`, you are
stuck recreating, simulating, or mocking built-in functionality like state
synchronization.

## How `@lumenize/testing` makes this better

`@lumenize/testing` uses the same raw ws trick as the newer `agents` tests, 
except it wraps it in a browser-compatible WebSocket API class. `AgentClient` 
allows you to dependency inject your own WebSocket class, as we show below. Now 
we are getting somewhere.

Add `@lumenize/testing`'s `createTestingClient`'s RPC capability, and you 
now have the same ability as `runInDurableObject` to prepopulate and inspect 
your Agent's state at any point during the test... all through one clean API.

## Benefits

This gives you a number of advantages:
- Test Agents with AgentClient or any other client-side library
- Use the browser WebSocket API
- No need to stand up a separate "server" to run tests against
  - CI friendly
  - Super fast, local dev/AI coding cycles
  - Unified test coverage
  - Unified stack trace when you encounter an error
- As all things Lumenize, de✨light✨ful DX
  - A fraction of the boilerplate
  - Well tested
  - Well documented
  - Examples guaranteed in sync with code via doc-testing
  - Conveniences like cookie sharing between HTTP and WebSocket handshake like
    a real browser, realistic CORS behavior, etc.
  - Assert on under-the-covers behavior like the request/response from/to
    `AgentClient` during the WebSocket upgrade handshake, HttpOnly cookies,
    etc.
*/

/*
## Imports
*/
import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient, Browser } from '@lumenize/testing';
import { AgentClient } from 'agents/client';
import { ChatAgent, AuthAgent } from '../src';

/*
## Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeTestingPackage from '../../../../packages/testing/package.json';
it('detects package version', () => {
  expect(lumenizeTestingPackage.version).toBe('0.15.0');
});

/* 
## Multi-user chat example

This example demonstrates:
- Creating multiple users with separate `Browser` instances—provides cookie 
  isolation, which is not crucial in this case but is good practice and *is* 
  critical for the test that follows
- Using `AgentClient` with injected `WebSocket` to connect to the same DO 
  instance
- Testing state synchronization across WebSocket connections
- Accessing DO instance variables via RPC (`lastMessage`)
- Verifying DO storage persistence (`totalMessageCount`)
*/
type ChatAgentType = RpcAccessible<InstanceType<typeof ChatAgent>>;
type AuthAgentType = RpcAccessible<InstanceType<typeof AuthAgent>>;

it('shows testing two users in a chat', async () => {
  // Create RPC client with binding name and instance name
  using client = createTestingClient<ChatAgentType>('chat-agent', 'chat');

  // Check initial value of instance variable lastMessage
  expect(await client.lastMessage).toBeNull();

  // Track latest state for both clients
  let aliceState: any = null;
  let bobState: any = null;

  // Create Alice's browser and agent client
  const aliceWebSocket = new Browser().WebSocket;
  const aliceClient = new AgentClient({
    host: 'example.com',
    agent: 'chat-agent',
    name: 'chat',
    WebSocket: aliceWebSocket,  // AgentClient let's us inject aliceWebSocket!
    onStateUpdate: (state) => {
      aliceState = state;
    },
  });
  
  aliceClient.onopen = () => {
    aliceClient.send(JSON.stringify({ type: 'join', username: 'Alice' }));
  };

  // Create Bob's browser and agent client
  const bobBrowser = new Browser();
  const bobClient = new AgentClient({
    host: 'example.com',
    agent: 'chat-agent',
    name: 'chat',
    WebSocket: bobBrowser.WebSocket,
    onStateUpdate: (state) => {
      bobState = state;
    },
  });
  
  bobClient.onopen = () => {
    bobClient.send(JSON.stringify({ type: 'join', username: 'Bob' }));
  };

  // Wait to see that they've both joined
  await vi.waitFor(() => {
    expect(bobState.participants).toContain('Bob');
    expect(bobState.participants).toContain('Alice');
    expect(aliceState.participants).toContain('Bob');
    expect(aliceState.participants).toContain('Alice');
  });
  
  // Alice sends a chat message
  aliceClient.send(
    JSON.stringify({ type: 'chat', username: 'Alice', text: 'Hello Bob!' })
  );
  
  // Wait for message to appear in state
  await vi.waitFor(() => {
    expect(aliceState.messages.length).toBeGreaterThan(0);
  });
  
  // Verify both users see the message
  expect(aliceState.messages[0].sender).toBe('Alice');
  expect(aliceState.messages[0].text).toBe('Hello Bob!');
  
  // Verify Bob also received the message
  expect(bobState.messages[0].text).toBe('Hello Bob!');

  // Verify that lastMessage instance variable is as expected
  expect(await client.lastMessage).toBeInstanceOf(Date);
  
  // Verify that storage persists total message count
  const totalCount = await client.ctx.storage.kv.get('totalMessageCount');
  expect(totalCount).toBe(1);
});

/*
Follow the instructions below to setup testing for your own agents.

## Installation

First let's install some tools.

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/testing
npm install --save-dev @lumenize/utils
```

## Setup files

### src/index.ts

The Worker below is used by the test above as well as the one down below.

It exports a fetch handler that provides a `/login` endpoint for 
authentication. This endpoint generates a session ID and token, stores the 
mapping in Cloudflare KV, sets an HttpOnly cookie, and returns the token to the 
client in the response body.

Two Agent classes are defined:
- `ChatAgent`: Used by the test above—handles chat messages with join/chat 
  events, tracks `lastMessage` instance variable, and persists 
  `totalMessageCount` in storage
- `AuthAgent`: Used by the test below—validates authentication tokens from 
  WebSocket protocol headers against KV session storage, closing connections 
  with code 1008 if invalid

@import {typescript} "../src/index.ts" [src/index.ts]
*/

/*
Here are the remainder of the setup files for this example.

### test/test-harness.ts

The test harness uses `instrumentDOProject` with explicit `doClassNames`
configuration to export both Agent classes for testing.

@import {typescript} "./test-harness.ts" [test/test-harness.ts]

### test/wrangler.jsonc

Test configuration includes:
- `SESSION_STORE` KV namespace binding for session storage
- `CHAT_AGENT` and `AUTH_AGENT` Durable Object bindings
- Migrations to enable both Agent classes in the test environment

@import {json} "./wrangler.jsonc" [test/wrangler.jsonc]

### vitest.config.js

Standard vitest configuration for Cloudflare Workers testing with:
- `isolatedStorage: false` required for WebSocket support
- `globals: true` for global test functions
- Coverage configured with Istanbul provider

@import {javascript} "../vitest.config.js" [vitest.config.js]
*/

/*
## Advanced authentication example

This example demonstrates a complete authentication flow using:

1. **Session management**: Worker `/login` endpoint generates sessionId + 
   token, stores in KV
2. **Token smuggling**: Client passes token via WebSocket `protocols` array as 
   `auth.${token}`
3. **Cookie-based session**: HttpOnly cookie contains sessionId for validation
4. **DO validation**: `AuthAgent.onConnect` extracts token and sessionId, 
   validates via KV
5. **RPC verification**: Test uses RPC client to directly inspect KV storage 
   state
6. **Error handling**: Wrong token closes connection with code 1008
7. **Success flow**: Valid token sends `auth_success` message with sessionId

Key testing patterns:
- Use `Browser` for realistic cookie/fetch behavior
- Access `client.env.SESSION_STORE` via RPC to verify server-side state
- Test both failure (wrong token) and success (correct token) paths
- Use `vi.waitFor()` for async WebSocket events
*/
it('demonstrates advanced authentication with KV session storage', async () => {
  // Create RPC client for AuthAgent to access its internals
  using client = createTestingClient<AuthAgentType>('auth-agent', 'auth');

  // Create a browser for making the login request
  const browser = new Browser();

  // Login to get token and sessionId cookie
  const loginResponse = await browser.fetch(
    'http://example.com/login?password=secret'
  );
  expect(loginResponse.status).toBe(200);
  
  const loginData = await loginResponse.json() as { token: string };
  const { token } = loginData;
  expect(token).toBeDefined();
  
  // Verify cookie was set
  // Note: In a real browser, HttpOnly cookies cannot be read by JavaScript.
  // Browser.getCookie() is a testing convenience that lets us inspect cookies
  // that would otherwise be inaccessible to client code.
  const sessionId = browser.getCookie('sessionId', 'example.com');
  expect(sessionId).toBeDefined();

  // Verify the session was actually stored in KV (via RPC client)
  const storedToken = await client.env.SESSION_STORE.get(sessionId!);
  expect(storedToken).toBe(token);

  // Attempt connection with WRONG token (should fail)
  const wrongToken = 'wrong-token-' + crypto.randomUUID();
  let closeCode = 0;
  let closeReason = '';

  const wrongTokenClient = new AgentClient({
    host: 'example.com',
    agent: 'auth-agent',
    name: 'auth',
    WebSocket: browser.WebSocket,
    protocols: ['real.protocol', `auth.${wrongToken}`],  // smuggle in token
  });

  wrongTokenClient.addEventListener('close', (event) => {
    closeCode = event.code;
    closeReason = event.reason;
  });

  // Wait for connection to be rejected
  await vi.waitFor(() => {
    expect(closeCode).toBe(1008);
    expect(closeReason).toBe('Invalid authentication token');
  });

  // Connect with CORRECT token (should succeed)
  let authMessage: any = null;
  const correctClient = new AgentClient({
    host: 'example.com',
    agent: 'auth-agent',
    name: 'auth',
    WebSocket: browser.WebSocket,
    protocols: ['real.protocol', `auth.${token}`],  // smuggle in token
  });

  correctClient.addEventListener('message', (event) => {
    authMessage = JSON.parse(event.data as string);
  });

  // Wait for successful auth message and verify it
  await vi.waitFor(() => {
    expect(authMessage?.type).toBe('auth_success');
    expect(authMessage?.sessionId).toBe(sessionId);
    expect(authMessage?.message).toBe('Authentication successful');
  });
});

/*
## Try it out

To run it as a vitest:
```bash
vitest --run
```

You can even see how much of the code is covered by these tests. With the correct vitest config, this will even include your client code:
```bash
vitest --run --coverage
```
*/

/*
# Testing Cloudflare Agents with AgentClient
*/

/*
This document demonstrates testing your use of Cloudflare's Agent class and 
AgentClient (both from the `agents` package) using `@lumenize/testing`. 
We show two scenarios:

1. **Multi-user chat** - Testing state synchronization across multiple 
   WebSocket connections
2. **Advanced authentication** - Using Cloudflare KV for session storage, token 
   smuggling via WebSocket protocols, and RPC access to verify authentication 
   state

For basic usage of `@lumenize/testing`, see the 
[usage documentation](../testing-plain-do/test/usage.test.ts).

## Why Testing Agents With AgentClient Is Hard

You could stand up two separate processes: one to host your Worker and Agent DO,
and another to run `AgentClient` and have them talk over localhost to each 
other, but that's a pain to do, especially in CI; it doesn't give you unified
test coverage metrics, and is less conducive to fast iteration.

You can avoid the multi-process approach by using `cloudflare:test`'s 
`runInDurableObject` to exercise your Agent DO, but you are calling handlers 
directly, which bypasses the Worker routing, input/output gates, your DO's own 
fetch, etc., which can allow subtle bugs to escape to production [like the
Agent team has had](https://github.com/cloudflare/agents/issues/321).

On the other hand, you can go through your Worker, fetch, input/output gates, 
etc. using `cloudflare:test`'s `SELF.fetch()` by sending in an HTTP Request 
with the correct WebSocket upgrade headers, extracting the returned raw ws 
object, and interacting with that. Some of the `agents` package tests now do 
exactly this. However, this raw ws object is not a full WebSocket instance, 
and even if it were, tools like `AgentClient` expect to instantiate the 
WebSocket themselves.

`@lumenize/testing` uses the same raw ws trick as the newer Agents tests, 
except it wraps it in a browser-compatible WebSocket API class. `AgentClient` 
allows you to dependency inject your own WebSocket class, as we show below. Now 
we are getting somewhere.

Combine that with `@lumenize/testing`'s `createTestingClient`, and you have a
powerful ability to test your Agent implementation with the actual tools you
will use in your browser, combined with the capability of `runInDurableObject`
to prepopulate or inspect your Agent's state at any point during the test.

## So What?

This gives you a few advantages:
- No need to stand up a separate "server" to run tests against
  - CI friendly
  - Super fast, local dev cycles
- Unified test coverage
- Unified stack trace when you encounter an error
- As all things Lumenize, *de*light*ful* DX
*/

/* 
## Multi-User Chat Example

This test demonstrates:
- Creating multiple users with separate `Browser` instances—provides cookie 
  isolation, which is not crucial in this case but is good practice and is 
  crucial for the test that follows
- Using `AgentClient` with injected `WebSocket` to connect to the same DO 
  instance
- Testing state synchronization across WebSocket connections
- Accessing DO instance variables via RPC (`lastMessage`)
- Verifying DO storage persistence (`totalMessageCount`)
*/
import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient, Browser } from '@lumenize/testing';
import { AgentClient } from 'agents/client';
import { ChatAgent, AuthAgent } from '../src';

type ChatAgentType = RpcAccessible<InstanceType<typeof ChatAgent>>;
type AuthAgentType = RpcAccessible<InstanceType<typeof AuthAgent>>;

it('shows testing two users in a chat', async () => {
  // Create RPC client with binding name and instance name
  await using client = createTestingClient<ChatAgentType>('chat-agent', 'chat');

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

  // Wait for both to see that they've both joined
  await vi.waitFor(() => {
    expect(bobState.participants).toContain('Bob');
    expect(aliceState.participants).toContain('Alice');
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
## Setup Files

### src/index.ts

The Worker below is used by the test above as well as the one down below.

It exports a fetch handler that provides a `/login` endpoint for 
authentication. It generates a session ID and token, stores the mapping in 
Cloudflare KV, sets an HttpOnly cookie, and returns the token to the client.

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
## Advanced Authentication Test

This test demonstrates a complete authentication flow using:

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
  await using client = createTestingClient<AuthAgentType>('auth-agent', 'auth');

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

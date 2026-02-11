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
# Chat Application Example

This comprehensive example demonstrates all key features of Lumenize RPC through
a working chat application:

- **Two-DO Architecture**: User DO acts as gateway to Room DO via Workers RPC
- **Downstream Messaging**: Server-to-client push notifications
- **Authentication**: Token-based auth with Workers KV, session expiration
- **Permission-Based Access**: Room manages per-user permissions
- **Type Support**: Maps, Dates, and complex objects preserved across the wire
- **Application-Layer Catchup**: Clients request missed messages after reconnect
- **Private Member Hiding**: Demonstrates RPC boundaries and security
*/

/*
## Imports
*/
import { it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/testing';
import type { User } from '../src/index';

/*
## Version
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
it('detects package version', () => {
  expect(lumenizeRpcPackage.version).toBe('0.17.0');
});

/*
## Architecture Overview

Our chat application uses a three-layer architecture:

1. **Worker (Edge)** - Handles login and authentication
2. **User DO (Gateway)** - Per-user instance, acts as facade to Room
3. **Room DO (Shared State)** - Manages participants and messages

```
Client --Lumenize RPC--> User DO --Workers RPC--> Room DO
Client <--Downstream-- User DO <--Workers RPC-- Room DO
```

Let's see how it works!
*/

/*
## Helper Functions

First, we'll create some helper functions for our tests:
*/

// Login to get a token and userId
async function login(userId: string): Promise<{ token: string; userId: string }> {
  const response = await SELF.fetch(
    `http://test.example.com/login?userId=${userId}`
  );
  const data: any = await response.json();
  return { token: data.token, userId: data.userId };
}

// Create an RPC client for a user
function createChatClient(token: string, userId: string) {
  const downstreamMessages: any[] = [];
  let onCloseCallback: ((code: number, reason: string) => void) | null = null;

  const client = createRpcClient<typeof User>({
    transport: createWebSocketTransport('USER', userId, {  // Use userId for DO routing
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: userId,  // Send userId as clientId (for WebSocket tagging)
      additionalProtocols: [`token.${token}`],  // Send token for authentication
      onDownstream: (message) => {
        downstreamMessages.push(message);
      },
      onClose: (code, reason) => {
        if (onCloseCallback) onCloseCallback(code, reason);
      },
    }),
  });

  return {
    client,
    userId,
    downstreamMessages,
    setOnClose: (cb: (code: number, reason: string) => void) => {
      onCloseCallback = cb;
    },
  };
}

/*
## Part 1: Authentication

Let's start by demonstrating the authentication flow. Users must log in to
get a token before they can connect to their User DO.
*/

it('demonstrates authentication flow', async () => {
  // Login as Alice
  const { token, userId } = await login('alice');
  
  // Token is a random UUID, userId is 'alice'
  expect(userId).toBe('alice');
  expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // The token is stored in Workers KV with userId as key
  const storedToken = await env.TOKENS.get(userId);
  expect(storedToken).toBeTruthy();
  expect(storedToken).toBe(token);
});

/*
## Part 2: User Settings with Map Type

User settings are stored as a Map, demonstrating full-fidelity type support
across the wire.
*/

it('demonstrates user settings with Map type support', async () => {
  const { token, userId } = await login('alice');
  const aliceClientData = createChatClient(token, userId);
  using alice = aliceClientData.client;

  // Set user settings as a Map
  await alice.updateSettings(
    new Map<string, any>([
      ['theme', 'dark'],
      ['notifications', true],
      ['language', 'en'],
    ])
  );

  // Retrieve settings - comes back as a Map!
  const settings = await alice.getSettings();
  expect(settings instanceof Map).toBe(true);
  expect(settings.get('theme')).toBe('dark');
  expect(settings.get('notifications')).toBe(true);
});

/*
## Part 3: Direct Storage Access (OCAN)

One of Lumenize RPC's unique features is direct access to the DO's `ctx.storage`
through Operation Chaining and Nesting (OCAN). You can access storage without
writing custom DO methods!
*/

it('demonstrates direct storage access', async () => {
  const { token, userId } = await login('alice');
  const aliceClientData = createChatClient(token, userId);
  using alice = aliceClientData.client;

  // Access User DO storage directly
  alice.ctx.storage.kv.put(
    'preferences',
    new Map([['lang', 'en']])
  );
  const prefs = await alice.ctx.storage.kv.get('preferences');

  expect(prefs instanceof Map).toBe(true);
  expect((prefs as Map<string, string>).get('lang')).toBe('en');
});

/*
## Part 4: Two-DO Architecture (User → Room)

Now let's see the User DO acting as a gateway to the Room DO via Workers RPC.
*/

it('demonstrates User → Room DO interaction', async () => {
  const { token, userId } = await login('alice');
  const aliceClientData = createChatClient(token, userId);
  using alice = aliceClientData.client;

  // Join the room - User DO calls Room DO via Workers RPC
  const roomInfo = await alice.joinRoom(userId);
  
  expect(roomInfo.messageCount).toBeGreaterThanOrEqual(0); // Messages from previous tests may exist
  expect(roomInfo.participants).toContain('alice'); // userId, not username
});

/*
## Part 5: Downstream Messaging

When Bob posts a message, both Alice and Bob receive it via downstream
messaging. The flow is: Room → User DOs → Clients.
*/

it('demonstrates downstream messaging', async () => {
  const aliceLogin = await login('alice');
  const bobLogin = await login('bob');

  const aliceClientData = createChatClient(aliceLogin.token, aliceLogin.userId);
  using alice = aliceClientData.client;
  const aliceMessages = aliceClientData.downstreamMessages;

  const bobClientData = createChatClient(bobLogin.token, bobLogin.userId);
  using bob = bobClientData.client;
  const bobMessages = bobClientData.downstreamMessages;

  // Setup
  await alice.joinRoom(aliceLogin.userId);
  await bob.joinRoom(bobLogin.userId);

  // Wait for join operations and Workers RPC connections to fully establish
  await vi.waitFor(async () => {
    const roomInfo = await alice.getMessages();
    return roomInfo.length >= 0; // Just wait for connections
  });

  // Clear any join notifications
  aliceMessages.length = 0;
  bobMessages.length = 0;

  // Alice posts a message
  await alice.postMessage('Hello world!');

  // Wait for downstream messages to arrive (Workers RPC + downstream propagation)
  // This involves: postMessage → Room DO → broadcastToAll → User DOs → sendDownstream → WebSocket clients
  await vi.waitFor(() => {
    return aliceMessages.length > 0 && bobMessages.length > 0;
  });

  // Both Alice and Bob receive the message
  expect(aliceMessages.length).toBeGreaterThan(0);
  expect(bobMessages.length).toBeGreaterThan(0);

  const aliceMsg = aliceMessages.find((m) => m.type === 'message');
  const bobMsg = bobMessages.find((m) => m.type === 'message');

  expect(aliceMsg.message.text).toBe('Hello world!');
  expect(bobMsg.message.text).toBe('Hello world!');
  expect(aliceMsg.message.userId).toBe('alice');
});

/*
## Part 6: Permission-Based Access Control

The Room DO stores per-user permissions and checks them on every operation.
We can demonstrate this by trying to post without joining the room first (no
permissions).
*/

it('demonstrates permission checks', async () => {
  const aliceLogin = await login('alice');
  const charlieLogin = await login('charlie');

  const aliceClientData = createChatClient(aliceLogin.token, aliceLogin.userId);
  using alice = aliceClientData.client;

  // Alice joins (gets 'post' permission)
  await alice.joinRoom(aliceLogin.userId);

  // Wait for Workers RPC to establish connections
  await vi.waitFor(async () => {
    const messages = await alice.getMessages();
    return messages.length >= 0; // Just wait for connections
  });

  // Alice can post
  await alice.postMessage('Alice can post!');

  // Charlie doesn't join the room, so has no permissions
  const charlieClientData = createChatClient(charlieLogin.token, charlieLogin.userId);
  using charlie = charlieClientData.client;

  // Charlie tries to post without joining - should fail
  await expect(charlie.postMessage('Charlie tries to post')).rejects.toThrow(
    'Must join room first'
  );
});

/*
## Part 7: Application-Layer Catchup

When clients disconnect and reconnect, they use application-layer catchup
by requesting messages from a specific ID.
*/

it('demonstrates catchup pattern after disconnect', async () => {
  const aliceLogin = await login('alice');
  const bobLogin = await login('bob');

  let startingMessageCount = 0;

  // Alice and Bob join
  const aliceClientData = createChatClient(aliceLogin.token, aliceLogin.userId);
  using alice = aliceClientData.client;
  {
    const bobClientData = createChatClient(bobLogin.token, bobLogin.userId);
    using bob = bobClientData.client;

    await alice.joinRoom(aliceLogin.userId);
    await bob.joinRoom(bobLogin.userId);

    // Wait for connections to establish
    await vi.waitFor(async () => {
      const messages = await bob.getMessages();
      return messages.length >= 0;
    });

    // Alice posts some messages
    await alice.postMessage('Message 1');
    await alice.postMessage('Message 2');

    // Bob sees the messages (might be more from previous tests)
    const bobMessages = await bob.getMessages();
    startingMessageCount = bobMessages.length;
    expect(startingMessageCount).toBeGreaterThanOrEqual(2);

    // Bob disconnects (using block ends, client is disposed)
  }

  // Alice posts more messages while Bob is offline
  await alice.postMessage('Message 3 - Bob missed this');
  await alice.postMessage('Message 4 - Bob missed this too');

  // Bob reconnects and catches up from last seen message
  const bob2ClientData = createChatClient(bobLogin.token, bobLogin.userId);
  using bob2 = bob2ClientData.client;
  const missedMessages = await bob2.getMessages(startingMessageCount);

  // Bob gets only the messages he missed
  expect(missedMessages.length).toBe(2);
  expect(missedMessages[0].text).toBe('Message 3 - Bob missed this');
  expect(missedMessages[1].text).toBe('Message 4 - Bob missed this too');
});

/*
## Part 8: Authentication Expiration

When a token expires, the User DO closes the WebSocket with a custom close
code (4401) to indicate the specific reason.
*/

it('demonstrates authentication expiration handling', async () => {
  const { token, userId } = await login('alice');

  let closedWithCode: number | null = null;
  let closedWithReason: string | null = null;

  const aliceClientData = createChatClient(token, userId);
  using alice = aliceClientData.client;

  // Setup onClose handler
  aliceClientData.setOnClose((code, reason) => {
    closedWithCode = code;
    closedWithReason = reason;
  });

  await alice.updateSettings(new Map([['name', 'Alice']]));
  await alice.joinRoom(userId);

  // Simulate token expiration (test helper method)
  await alice.simulateTokenExpiration();

  // Next RPC operation triggers the close
  try {
    await alice.postMessage('This should fail');
  } catch (e) {
    // Expected to fail
  }

  // Wait for close to propagate
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify custom close code
  expect(closedWithCode).toBe(4401);
  expect(closedWithReason).toBe('Token expired');
});

/*
## Part 9: RPC Boundaries and Security

Private members (starting with `#`) are not accessible via RPC. This includes
the User DO's `#env`, which prevents clients from accessing Workers KV or
hopping to other DOs without permission checks.
*/

it('demonstrates RPC boundaries', async () => {
  const { token, userId } = await login('alice');
  const aliceClientData = createChatClient(token, userId);
  using alice = aliceClientData.client;

  await alice.updateSettings(new Map([['name', 'Alice']]));

  // ✅ Public members work
  const settings = await alice.getSettings();
  expect(settings.get('name')).toBe('Alice');

  // ✅ ctx is public (though instance variable access requires `await`)
  const storageTest = await alice.ctx.storage.kv.get('test');
  expect(storageTest).toBeUndefined();

  // ❌ Private #env is not accessible via RPC
  // Trying to access private members results in undefined
  // @ts-expect-error - Intentionally testing runtime behavior
  const privateEnv = await alice['#env'];
  expect(privateEnv).toBeUndefined();
  
  // This prevents clients from manipulating tokens or hopping DOs
});

/*
## Summary

This chat application demonstrates the full power of Lumenize RPC:

- **Simple**: No protocol design, just call methods
- **Type-Safe**: TypeScript types work across the network
- **Full-Fidelity**: Maps, Dates, Errors all preserved
- **Secure**: Private members enforce boundaries
- **Flexible**: Mix RPC, downstream messaging, and Workers RPC
- **Performant**: OCAN enables single round-trip complex operations

For more information, see the [Lumenize RPC documentation](https://lumenize.com/docs/rpc).
*/

/*
## Installation

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/rpc
npm install --save-dev @lumenize/routing
```

## Source Code

The complete source code for this example is available at:

@import {typescript} "../src/index.ts" [src/index.ts]

## Wrangler Configuration

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

## Vitest Configuration

@import {javascript} "../vitest.config.js" [vitest.config.js]
*/


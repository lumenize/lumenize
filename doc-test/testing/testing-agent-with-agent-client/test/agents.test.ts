/**
 * Testing Agents with AgentClient Using @lumenize/testing
 * 
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

it('demonstrates advanced authentication with KV session storage', async () => {
  // Create RPC client for AuthAgent to access its internals
  await using client = createTestingClient<AuthAgentType>('auth-agent', 'auth');

  // Create a browser for making the login request
  const browser = new Browser();

  // Step 1: Login to get token and sessionId cookie
  const loginResponse = await browser.fetch('http://example.com/login?password=secret');
  expect(loginResponse.status).toBe(200);
  
  const loginData = await loginResponse.json() as { token: string };
  const { token } = loginData;
  expect(token).toBeDefined();
  
  // Verify cookie was set
  const sessionId = browser.getCookie('sessionId', 'example.com');
  expect(sessionId).toBeDefined();

  // Step 2: Attempt connection with WRONG token (should fail)
  const wrongToken = 'wrong-token-' + crypto.randomUUID();
  let closeCalled = false;
  let closeCode = 0;
  let closeReason = '';

  const wrongTokenClient = new AgentClient({
    host: 'example.com',
    agent: 'auth-agent',
    name: 'auth',
    WebSocket: browser.WebSocket,
    protocols: ['chosen.protocol', `auth.${wrongToken}`],
  });

  wrongTokenClient.addEventListener('close', (event) => {
    closeCalled = true;
    closeCode = event.code;
    closeReason = event.reason;
  });

  // Wait for connection to be rejected
  await vi.waitFor(() => {
    expect(closeCalled).toBe(true);
    expect(closeCode).toBe(1008);
    expect(closeReason).toBe('Invalid authentication token');
  });

  // Step 3: Connect with CORRECT token (should succeed)
  let authMessage: any = null;
  const correctClient = new AgentClient({
    host: 'example.com',
    agent: 'auth-agent',
    name: 'auth',
    WebSocket: browser.WebSocket,
    protocols: ['chosen.protocol', `auth.${token}`],
  });

  correctClient.addEventListener('message', (event) => {
    authMessage = JSON.parse(event.data as string);
  });

  // Wait for successful auth message
  await vi.waitFor(() => {
    expect(authMessage).not.toBeNull();
  });

  // Verify the auth success message
  expect(authMessage.type).toBe('auth_success');
  expect(authMessage.sessionId).toBe(sessionId);
  expect(authMessage.message).toBe('Authentication successful');

  // Cleanup
  correctClient.close();
});

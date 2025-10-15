/**
 * Testing Agents with AgentClient Using @lumenize/testing
 * 
 */

import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient, Browser } from '@lumenize/testing';
import { AgentClient } from 'agents/client';
import { ChatAgent } from '../src';

type ChatAgentType = RpcAccessible<InstanceType<typeof ChatAgent>>;

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

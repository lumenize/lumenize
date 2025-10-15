/**
 * Testing Agents with AgentClient Using @lumenize/testing
 * 
 */

import { it, expect, vi } from 'vitest';
import type { RpcAccessible } from '@lumenize/testing';
import { createTestingClient, Browser } from '@lumenize/testing';
import { AgentClient } from 'agents/client';
import { MyAgent } from '../src';

type MyAgentType = RpcAccessible<InstanceType<typeof MyAgent>>;

it('shows hello world', async () => {
  // Create RPC client with binding name and instance name
  await using client = createTestingClient<MyAgentType>('my-agent', 'hello');
  const WebSocket = new Browser().WebSocket;
  const agentClient = new AgentClient({
    host: 'example.com',
    agent: 'my-agent',
    name: 'hello',
    WebSocket,  // inject our WebSocket into AgentClient
  });

  agentClient.onopen = () => {
    console.log("Connected to agent");
    // Send an initial message
    agentClient.send(JSON.stringify({ type: "join", user: "user123" }));
  };

  console.log(await client.echo('something'));



});

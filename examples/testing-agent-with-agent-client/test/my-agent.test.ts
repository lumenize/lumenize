import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
import { env } from 'cloudflare:test';
import { simulateWSUpgrade, runWithSimulatedWSUpgrade, runInDurableObject } from '@lumenize/testing';
import { AgentClient } from "agents/client";
import { MyAgent } from '../src';

describe('MyAgent', () => {

  it('should allow use of AgentClient', async () => {
    const id = env.MY_AGENT.newUniqueId();
    const stub = env.MY_AGENT.get(id);
    await runInDurableObject(stub, async (instance, ctx, mock) => {

      let opened = false

      const client = new AgentClient({
        agent: "my-agent", // Name of your Agent class in kebab-case
        name: "random-instance-name", // Specific instance name
        host: 'https://example.com', // Using same host
      });

      client.onopen = () => {
        console.log("Connected to agent");
        // Send an initial message
        client.send(JSON.stringify({ type: "join", user: "user123" }));
        opened = true;
      };
      
      client.onmessage = (event) => {
        // Handle incoming messages
        const data = JSON.parse(event.data);
        console.log("Received:", data);
      
        if (data.type === "state_update") {
          console.log({ state: data.state });
        }
      };
      
      client.onclose = () => console.log("Disconnected from agent");
      
      // Send messages to the Agent
      // function sendMessage(text) {
      //   client.send(JSON.stringify({
      //     type: "message",
      //     text,
      //     timestamp: Date.now()
      //   }));
      // }

      await vi.waitFor(() => {
         expect(opened).toBe(true);
       }, {
         timeout: 1000,
         interval: 10
       });

    });
  });

})

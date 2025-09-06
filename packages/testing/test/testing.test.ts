import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
  runInDurableObject,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { simulateWSUpgrade, runWithSimulatedWSUpgrade, runWithWebSocketMock } from '../src/websocket-utils.js';
import { MyDO } from './test-harness';

describe('Various DO unit and integration testing techniques', () => {

  // Test using SELF
  it('should ping/pong using SELF', async () => {
    const response = await SELF.fetch('https://example.com/ping');
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe('pong');
  });

  // Test using runInDurableObject from cloudflare:test but not using WebSockets
  it('should work in runInDurableObject because it does not use WebSockets', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    const response = await runInDurableObject(stub, async (instance: MyDO, ctx: DurableObjectState) => {
      const request = new Request("https://example.com/increment");
      const response = await instance.fetch(request);
      expect(await ctx.storage.get<number>("count")).toBe(1);
      return response;
    });
    expect(await response.text()).toBe("1");
  });

  // The next set of tests will simulate a WebSocket upgrade over HTTP.
  // The advantage of this approach is that it's lightwieght and doesn't require a mock. 
  // You get the actual ws that the Worker would see as well as the ctx: ExecutionContext
  // so you can inspect storage. This is the general approach that the Cloudflare agents team 
  // uses... at least in the tests of theirs that I've looked at.
  // 
  // However, there are significant limitations of this approach:
  //   - You cannot use wss:// protocol because fetch won't allow it. So, your Worker must route 
  //     regular HTTP GET calls to the Durable Object on a particular route. The example test-harness 
  //     looks for a /wss route.
  //   - You cannot use a client like AgentClient that calls the browser's WebSocket API 
  //   - It only minimally mimics the browser's WebSocket behavior. It doesn't support
  //     cookies, origin, etc.
  // TODO: Next step is to upgrade my websocket-utils function to accept a config object that allows
  //       the caller to specify all of the above things.
  //   - You cannot inspect connection tags or attachments in your tests.
  //   - You can inspect the messages that you receive back but not the ones that were sent in.
  //     That's fine when your test controls all message sending, but you could be using a library
  //     that sends its own messages (e.g. an MCP library might automatically `initialize`).

  // Test using @lumenize/testing's low-level simulateWSUpgrade for more control
  it('should exercise setWebSocketAutoResponse with simulateWSUpgrade', async () => {
    await new Promise<void>(async (resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('timed out')) }, 5000);
      const { ws, ctx } = await simulateWSUpgrade('https://example.com/wss');
      ws.onmessage = (event) => {
        expect(event.data).toBe('pong');
        clearTimeout(timeout);
        resolve();
      };
      ws.send('ping');
    });
  });

  // Test using @lumenize/testing's higher-level runWithSimulatedWSUpgrade API
  it('should show ctx.storage changes when using runWithSimulatedWSUpgrade', async () => {
    await runWithSimulatedWSUpgrade('https://example.com/wss', async (ws, ctx) => {
      ws.onmessage = async (event) => {
        expect(event.data).toBe('1');
        expect(await ctx.storage.get("count")).toBe(1);
      };
      ws.send('increment');
    });
  });

  // This next set of tests uses a mock WebSocket which removes all of the limitations
  // mentioned above when manually simulating a WebSocket upgrade call over HTTP

  // Overcomes limitations. runWithWebSocketMock allows you to:
  //   - Use wss:// protocol as a gate for routing in your Worker
  it('should support wss:// protocol URLs with runWithWebSocketMock', async () => {
    await runWithWebSocketMock((mock, ctx) => {
      const ws = new WebSocket('wss://example.com');  
      ws.onopen = () => { ws.send('ping') };   
      ws.onmessage = (event) => { expect(event.data).toBe('pong') };
    }, 1000);
  });

  // Overcomes limitations. runWithWebSocketMock now allows you to:
  //   - Use any client library that directly calls WebSocket like AgentClient
  //   - Inspect the messages that were sent in and out
  it('should demonstrate mock.sync() properly waits for cascading async operations', async () => {
    // Function that simulates a library using WebSocket API
    const connectPingAndClose = () => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('ping');
      };
      ws.onmessage = (event) => {
        ws.close();
      };
    };

    await runWithWebSocketMock(async (mock, ctx) => {
      connectPingAndClose();  // Simulates using a library using WebSocket API
      
      // Without mock.sync(), these are not correct because operations haven't completed
      expect(mock.messagesSent).toEqual([]);
      expect(mock.messagesReceived).toEqual([]);
      
      // sync() now properly waits for all cascading operations
      await mock.sync();
      
      // Now all operations have completed
      expect(mock.messagesSent).toEqual(['ping']);
      expect(mock.messagesReceived).toEqual(['pong']);
    }, 500);
  });

  it('should support addEventListener for libraries that use EventTarget API', async () => {
    await runWithWebSocketMock(async (mock, ctx) => {
      const ws = new WebSocket('wss://example.com');
      let messageReceived = false;
      let openReceived = false;
      
      // Use addEventListener instead of onmessage - this should work
      ws.addEventListener('message', (event: any) => {
        messageReceived = true;
        expect(event.data).toBe('pong');
        ws.close();
      });
      
      ws.addEventListener('open', () => {
        openReceived = true;
        ws.send('ping');
      });
      
      await mock.sync();
      
      // These should all be true if EventTarget is working
      expect(openReceived).toBe(true);
      expect(messageReceived).toBe(true);
      expect(mock.messagesSent).toEqual(['ping']);
      expect(mock.messagesReceived).toEqual(['pong']);
    }, 500);
  });
  
  // ✅ Overcomes limitation: "Doesn't support cookies, origin, etc."
  // Should test most/all of these:
  // ['user-agent', 'test-agent/1.0'],
  // ['origin', 'https://test.example.com'],
  // ['cookie', 'sessionId=test-session-123; other=value'],
  // ['host', 'test.lumenize.com'],
  // ['upgrade', 'websocket'],
  // ['connection', 'upgrade']


  // ✅ Overcomes limitation: "Cannot inspect connection tags or attachments"


});
  
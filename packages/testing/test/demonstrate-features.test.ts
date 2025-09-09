import { describe, test, it, expect, vi } from 'vitest';
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
  // The advantage of this approach is that it's lightweight and doesn't require a mock.
  // You get the actual WebSocket that the Worker would see as well as proper input gates behavior.
  // This is the general approach that the Cloudflare agents team uses.
  // 
  // However, there are significant limitations of this approach:
  //   - When you write your Worker, you cannot use url.protocol to make the routing determination
  //     because fetch won't allow it. So, your Worker must route regular HTTP GET calls to the 
  //     Durable Object some other way. The example test-harness use a function from @lumenize/utils,
  //     `isWebSocketUpgrade()` that inspects headers
  //   - You cannot inspect the DO storage
  //   - You cannot use a client like AgentClient that calls the browser's WebSocket API 
  //   - It only minimally mimics the browser's WebSocket behavior. It doesn't support
  //     cookies, origin, etc.
  //   - You cannot inspect connection tags or attachments in your tests.
  //   - You can inspect the messages that you receive back but not the ones that were sent in.
  //     That's fine when your test controls all message sending, but you could be using a library
  //     that sends its own messages (e.g. an MCP library might automatically `initialize`).
  //   - It's less like a drop-in replacement for runInDurableObject

  // Test using @lumenize/testing's low-level simulateWSUpgrade for more control
  it('should exercise setWebSocketAutoResponse with simulateWSUpgrade', async () => {
    await new Promise<void>(async (resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('timed out')) }, 5000);
      const ws = await simulateWSUpgrade('https://example.com/wss');
      ws.onmessage = (event) => {
        expect(event.data).toBe('pong');
        clearTimeout(timeout);
        resolve();
      };
      ws.send('ping');
    });
  });

  // NOTE: runWithSimulatedWSUpgrade does NOT provide storage access
  // The approach respects input gates but can't inspect Durable Object state
  // For storage inspection, use runWithWebSocketMock instead

  // Test input gates behavior with runWithSimulatedWSUpgrade vs runWithWebSocketMock
  it('should test input gates behavior with runWithSimulatedWSUpgrade', async () => {
    await runWithSimulatedWSUpgrade('https://example.com/wss', async (ws) => {
      const responses: string[] = [];
      
      ws.onmessage = (event) => {
        responses.push(event.data);
      };
      
      ws.send('increment');
      ws.send('increment');
      
      await vi.waitFor(() => {
        expect(responses.length).toBe(2);
      }, {
        timeout: 1000,
        interval: 10
      });
      
      expect(responses).toEqual(['1', '2']); // If input gates don't work, we might get ['1', '1']
    });
  });

  // This next set of tests uses a mock WebSocket which removes all of the limitations
  // mentioned above when manually simulating a WebSocket upgrade call over HTTP
  // However, it adds its own limitations:
  //   - Since the mock is calling the instance's methods directly (e.g. webSocketMessage),
  //     it bypasses normal DO input gates. So, it's possible for two rapidly sent messages
  //     to interleave execution.

  // Overcomes limitations. runWithWebSocketMock allows you to:
  //   - Use wss:// protocol as a gate for routing in your Worker
  it('should support wss:// protocol URLs with runWithWebSocketMock', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    await runWithWebSocketMock(stub, (mock, instance, ctx) => {
      const ws = new WebSocket('wss://example.com');  
      ws.onopen = () => { ws.send('increment') };   
      ws.onmessage = (event) => { 
        expect(event.data).toBe('1');
      };
    }, 1000);
  });

  // Overcomes limitations. runWithWebSocketMock now allows you to:
  //   - Use any client library that directly calls WebSocket like AgentClient
  //   - Inspect the messages that were sent in and out
  it('should demonstrate mock.sync() properly waits for cascading async operations', async () => {
    // Function that simulates a library using WebSocket API
    const connectIncrementAndClose = () => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('increment');
      };
      ws.onmessage = (event) => {
        ws.close();
      };
    };

    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
      connectIncrementAndClose();  // Simulates using a library using WebSocket API
      
      // Without mock.sync(), these are not correct because operations haven't completed
      expect(mock.messagesSent).toEqual([]);
      expect(mock.messagesReceived).toEqual([]);
      
      // sync() waits for all cascading operations
      await mock.sync();
      
      // Now all operations have completed
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    }, 500);
  });

  // Test that runWithWebSocketMock also provides access to ctx.storage
  it('should show ctx (DurableObjectState) changes when using runWithWebSocketMock', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    let onmessageCalled = false;
    await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
      let messageReceived = false;
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('increment');
      };
      ws.onmessage = async (event) => {
        expect(event.data).toBe('1');
        messageReceived = true;
        expect(await ctx.storage.get("count")).toBe(1);
        const webSockets = ctx.getWebSockets();
        expect(webSockets.length).toBe(1);
        const attachment = webSockets[0].deserializeAttachment();
        expect(attachment.count).toBe(1)
        onmessageCalled = true;
      };
      await mock.sync();
      
      // This assertion will actually run and can fail the test
      expect(messageReceived).toBe(true);
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    });
    expect(onmessageCalled).toBe(true);
  });

  // Shows limitations of runWithWebSocketMock:
  //   - Input gates don't work
  it('should show that input gates do NOT work with runWithWebSocketMock', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
      const responses: string[] = [];
      const ws = new WebSocket('wss://example.com');
      
      ws.onopen = () => {
        // Send two increment messages rapidly
        ws.send('increment');
        ws.send('increment');
      };
      
      ws.onmessage = (event) => {
        responses.push(event.data);
      };
      
      await mock.sync();
      
      expect(responses.length).toBe(2);
      expect(responses).toEqual(['1', '1']); // Race condition: both see initial state
    });
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

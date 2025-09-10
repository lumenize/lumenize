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

describe('Various ways to test with WebSockets', () => {
  // The next set of tests will simulate a WebSocket upgrade over HTTP.
  // You get the actual WebSocket that the Worker would see as well as proper input gates behavior.
  // This is the general approach that the Cloudflare agents team uses.
  //
  // It has a few advantages over the mocking approach we show later derived from the
  // fact that it's going through the actual Worker fetch upgrade process:
  //   - You can test that your setWebSocketAutoResponse pair works
  //   - Input gates work
  // 
  // However, there are significant limitations of this approach:
  //   - You cannot inspect the DO storage
  //   - You cannot use a client like AgentClient that calls the browser's WebSocket API 
  //   - You cannot inspect connection tags or attachments in your tests
  //   - It's less like a drop-in replacement for runInDurableObject
  //   - When you write your Worker, you cannot use url.protocol to make the routing determination
  //     because fetch won't allow it. So, your Worker must route regular HTTP GET calls to the 
  //     Durable Object some other way.
  // TODO:
  //   - It only minimally mimics the browser's WebSocket behavior. It doesn't support
  //     cookies, origin, etc.
  //   - You can inspect the server-side close code in addition to the client-side one
  //   - You cannot test multiple simultaneous WS connections to the same instance

  // Test using @lumenize/testing's low-level simulateWSUpgrade
  it('should exercise setWebSocketAutoResponse with simulateWSUpgrade', async () => {
    await new Promise<void>(async (resolve, reject) => {
      const ws = await simulateWSUpgrade('https://example.com/wss');
      ws.onmessage = (event) => {
        expect(event.data).toBe('pong');
        resolve();
      };
      ws.send('ping');
    });
  });

  // Shows that input gates work with runWithSimulatedWSUpgrade
  // Uses slightly higher-level runWithSimulatedWSUpgrade with timeout and cleanup
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
    }, 100);  // timeout
  });

  // This next set of tests uses a mock WebSocket which removes the limitations
  // mentioned above when simulating a WebSocket upgrade call over HTTP
  // 
  // However, it has its own limitations that the simulated WS upgrade approach does not:
  //   - Bypasses normal DO input gates. So, it's possible for two rapidly sent messages
  //     to interleave execution
  //   - Can NOT test setWebSocketAutoResponse pair is working for

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

  // Overcomes limitations. runWithWebSocketMock allows you to:
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, etc.
  it('should show ctx (DurableObjectState) changes when using runWithWebSocketMock', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    let onmessageCalled = false;
    await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
      let messageReceived = false;
      const ws = new WebSocket('wss://example.com/my-do/my-name');
      ws.onopen = () => {
        ws.send('increment');
      };
      ws.onmessage = async (event) => {
        expect(event.data).toBe('1');
        expect(await ctx.storage.get("count")).toBe(1);  // storage is inspectable
        const webSockets = ctx.getWebSockets('my-name');  // connection tags work
        expect(webSockets.length).toBe(1);
        const attachment = webSockets[0].deserializeAttachment();
        expect(attachment.name).toBe('my-name')  // attachments are inspectable
        onmessageCalled = true;
        messageReceived = true;
      };

      await mock.sync();
      
      expect(messageReceived).toBe(true);
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    });
    expect(onmessageCalled).toBe(true);
  });

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

  // Shows limitations of runWithWebSocketMock:
  //   - Input gates do NOT work
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

});

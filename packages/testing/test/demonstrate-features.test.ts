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
  // It has a few advantages over the mocking approach we show later that derive from the
  // fact that it's going through the actual Worker fetch upgrade process:
  //   - You can test that your setWebSocketAutoResponse pair works
  //   - You can test the WebSocket sub-protcol selection code in your Worker
  //   - You can test origin rejection that's in your Worker
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
  //   - You cannot inspect the server-side close code in addition to the client-side one
  
  // TODO:
  //   - It only minimally mimics the browser's WebSocket behavior. It doesn't support
  //     cookies, etc.
  //   - You cannot test multiple simultaneous WS connections to the same instance

    // Test using @lumenize/testing's low-level simulateWSUpgrade
  it('should exercise setWebSocketAutoResponse with simulateWSUpgrade', async () => {
    const { ws, response } = await simulateWSUpgrade('https://example.com/wss', { 
      origin: 'https://example.com' 
    });
    
    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        expect(event.data).toBe('pong');
        ws.close();
        resolve();
      };
      ws.send('ping');
    });
  });

  // Uses slightly higher-level API of runWithSimulatedWSUpgrade
  it('should have correct sub-protocol & setWebSocketAutoResponse w/ runWithSimulatedWSUpgrade', async () => {
    let onmessageCalled = false;
    await runWithSimulatedWSUpgrade(
      'https://example.com/wss',
      { 
        protocols: ["not.correct.subprotocol.1", "correct.subprotocol", "not.correct.subprotocol.2"],
        origin: 'https://example.com'
      },
      async (ws) => {
        // Verify the correct protocol was selected
        expect(ws.protocol).toBe('correct.subprotocol');
        
        // Can still do normal WebSocket operations
        ws.onmessage = (event) => {
          expect(event.data).toBe('pong');
          onmessageCalled = true;
        };
        ws.send('ping');
      }
    );
    expect(onmessageCalled).toBe(true);
  });

  // Shows that input gates work with runWithSimulatedWSUpgrade
  // Uses slightly higher-level runWithSimulatedWSUpgrade with timeout and cleanup
  it('should test input gates behavior with runWithSimulatedWSUpgrade', async () => {
    await runWithSimulatedWSUpgrade(
      'https://example.com/wss', 
      { origin: 'https://example.com' },
      async (ws) => {
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
      }, 
      100  // timeout
    );
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
  it('should allow use of libraries that use browser WebSocket API', async () => {    
    // Function that simulates a library using WebSocket API
    const connectIncrementAndClose = () => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('increment');
      };
      ws.onmessage = (event) => {
        ws.close(1000, 'Normal completion');
      };
    };

    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    await runWithWebSocketMock(stub, async (mock, instance, ctx) => {  // pass in your own stub
      connectIncrementAndClose();  // Simulates using a library using WebSocket API
      
      // Without mock.sync(), these are not correct because operations haven't completed
      expect(mock.messagesSent).toEqual([]);
      expect(mock.messagesReceived).toEqual([]);
      
      // sync() waits for all cascading operations
      await mock.sync();
      
      // Now all operations have completed
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
      
      // Verify close code tracking
      expect(mock.clientCloses).toHaveLength(1);
      expect(mock.clientCloses[0].code).toBe(1000);
      expect(mock.clientCloses[0].reason).toBe('Normal completion');
    }, 500);
  });

  // Overcomes limitations. runWithWebSocketMock allows you to:
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, etc.
  it('should show ctx (DurableObjectState) changes when using runWithWebSocketMock', async () => {
    let onmessageCalled = false;
    await runWithWebSocketMock(async (mock, instance: MyDO, ctx) => {  // newUniqueId stub created by default
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
    await runWithWebSocketMock((mock, instance, ctx) => {
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
    await runWithWebSocketMock(async (mock, instance, ctx) => {
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

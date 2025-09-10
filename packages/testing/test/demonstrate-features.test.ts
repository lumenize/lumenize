import { describe, test, it, expect, vi } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { simulateWSUpgrade, runWithSimulatedWSUpgrade, runInDurableObject } from '../src/websocket-utils.js';
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
  //   - It's not a drop-in replacement for runInDurableObject
  //   - When you write your Worker, you cannot use url.protocol to make the routing determination
  //     because fetch won't allow it. So, your Worker must route regular HTTP GET calls to the 
  //     Durable Object some other way.
  //   - You cannot inspect the server-side close code in addition to the client-side one
  
  // TODO:
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

  // Overcomes limitations. runInDurableObject now allows you to:
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
    await runInDurableObject(stub, async (instance, ctx, mock) => {  // pass in your own stub
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

  // Overcomes limitations. runInDurableObject allows you to:
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, etc.
  it('should show ctx (DurableObjectState) changes when using runInDurableObject', async () => {
    let onmessageCalled = false;
    await runInDurableObject(async (instance: MyDO, ctx, mock) => {  // newUniqueId stub created by default
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

  // Overcomes limitations. runInDurableObject allows you to:
  //   - Use wss:// protocol as a gate for routing in your Worker
  it('should support wss:// protocol URLs with runInDurableObject', async () => {
    await runInDurableObject((instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');  
      ws.onopen = () => { ws.send('increment') };   
      ws.onmessage = (event) => { 
        expect(event.data).toBe('1');
      };
    }, 1000);
  });

  // Headers upported by both runInDurableObject and runWithSimulatedWSUpgrade
  it('should support custom headers with runInDurableObject', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => { ws.send('increment') };   
      ws.onmessage = (event) => { 
        expect(event.data).toBe('1');
      };
      await mock.sync();
    }, {
      origin: 'https://app.example.com',  // shorthand for Origin and Sec-WebSocket-Protocol headers
      headers: {                          // any other headers you want to add
        'User-Agent': 'MyApp/1.0'
      }
    });
  });

  // Shows that input gates are only partially simulated
  it('should show that input gates are only partially simulated', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      // Create WebSocket connection
      const ws = new WebSocket('wss://example.com');
      
      ws.onopen = () => {
        // Make four un-awaited calls that should be queued
        // Two fetch calls - these will be automatically queued through our wrapped instance
        instance.fetch(new Request('https://test.com?op=1'));
        instance.fetch(new Request('https://test.com?op=2'));
        
        // Two WebSocket sends (using 'track-' prefix so they get tracked)
        ws.send('track-msg1');
        ws.send('track-msg2');
      };
      
      await mock.sync();
      
      // Verify all operations were tracked in storage and in proper serialized order
      const operationsFromQueue = await ctx.storage.get('operationsFromQueue') as string[] | undefined;
      expect(operationsFromQueue).toEqual([
        'fetch-unknown',    // WebSocket upgrade fetch call
        'fetch-1',          // First manual fetch call
        'fetch-2',          // Second manual fetch call  
        'message-track-msg1', // First WebSocket message
        'message-track-msg2'  // Second WebSocket message
      ]);
    });
  });

  // ✅ Overcomes limitation: "You cannot test multiple simultaneous WS connections to the same instance" 
  it('should support multiple WebSocket connections to same DO instance with shared storage', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws1Responses: string[] = [];
      const ws2Responses: string[] = [];
      
      // Create first WebSocket connection and wait for it to complete
      const ws1 = new WebSocket('wss://example.com');
      ws1.onopen = () => {
        ws1.send('increment'); // Should set count to 1
      };
      ws1.onmessage = (event) => {
        ws1Responses.push(event.data);
      };
      
      // Wait for first WebSocket to complete before starting second one
      await mock.sync();
      expect(ws1Responses).toEqual(['1']); // First connection sets count to 1
      expect(await ctx.storage.get('count')).toBe(1); // Storage shows count = 1
      
      // Now create second WebSocket connection 
      const ws2 = new WebSocket('wss://example.com');
      ws2.onopen = () => {
        ws2.send('increment'); // Should set count to 2 (shared storage)
      };
      ws2.onmessage = (event) => {
        ws2Responses.push(event.data);
      };
      
      await mock.sync();
      
      // Now both connections should see the incremental count
      expect(ws1Responses).toEqual(['1']); // First connection got count = 1
      expect(ws2Responses).toEqual(['2']); // Second connection got count = 2
      
      // Storage should reflect both changes
      expect(await ctx.storage.get('count')).toBe(2);
      
      // Mock should track all messages sent and received
      expect(mock.messagesSent).toEqual(['increment', 'increment']);
      expect(mock.messagesReceived).toEqual(['1', '2']);
    });
  });

});

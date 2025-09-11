import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
import { env } from 'cloudflare:test';
import { simulateWSUpgrade, runWithSimulatedWSUpgrade, runInDurableObject } from '../src/websocket-utils.js';
import { MyDO } from './test-harness';

// @lumenize/testing's runInDurableObject is a drop-in replacement for
// cloudflare:test's runInDurableObject... but with additional capabilities
// mostly centered around testing WebSocket functionality.
describe('runInDurableObject drop-in replacement plus additional capabilities', () => {

  // TODO: export a second DO, MyAgent, and show a test using AgentClient. Worker routing will be tricky. Maybe use my @lumenize/utils router?

  // runInDurableObject now allows you to:
  //   - Use any client library that directly calls `new WebSocket()` like AgentClient
  //   - Inspect the messages that were sent in and out
  //   - Inspect close codes and reasons
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
      
      // mock.sync() waits for messages, fetch calls, storage ops, etc. to complete
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

  // runInDurableObject allows you to:
  //   - Use it as a drop in replacement for cloudflare:test's runInDurableObject
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, etc.
  it('should show ctx (DurableObjectState) changes when using runInDurableObject', async () => {
    let onmessageCalled = false;
    await runInDurableObject(async (instance: MyDO, ctx, mock) => {  // newUniqueId stub created by default
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
      };
  
      await mock.sync();  // waits until all messages, fetch calls, storage ops, etc. to complete
      
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    });
    expect(onmessageCalled).toBe(true);
  });



  // runInDurableObject allows you to:
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

  // runInDurableObject allows you to:
  //   - Test using multiple WebSocket connections to the same DO instance
  it('should support multiple WebSocket connections to same DO instance', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws1 = new WebSocket('wss://example.com');
      ws1.onopen = () => {
        ws1.send('track-ws1');
      };
      const ws2 = new WebSocket('wss://example.com');
      ws2.onopen = () => {
        ws2.send('track-ws2');
      };
      
      await mock.sync();
      
      const operationsFromQueue = await ctx.storage.get('operationsFromQueue') as string[] | undefined;
      expect(operationsFromQueue).toEqual([
        'fetch-unknown',     // First WebSocket upgrade
        'fetch-unknown',     // Second WebSocket upgrade
        'message-track-ws1', // First WebSocket message 
        'message-track-ws2'  // Second WebSocket message
      ]);
    });
  });

  // runInDurableObject allows you to:
  //   - Supply Origin and other Headers that will be attached to the initial WebSocket upgrade
  // Note: This capability is also supported with simulated WS upgrade approaches
  it('should support origin and custom headers', async () => {
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

  // runInDurableObject allows you to:
  //   - Write tests that use multiple WebSocket connections to the same DO instance
  it('should support multiple WebSocket connections to same DO instance', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws1 = new WebSocket('wss://example.com');
      ws1.onopen = () => {
        ws1.send('track-ws1');
      };
      const ws2 = new WebSocket('wss://example.com');
      ws2.onopen = () => {
        ws2.send('track-ws2');
      };
      
      await mock.sync();
      
      const operationsFromQueue = await ctx.storage.get('operationsFromQueue') as string[] | undefined;
      expect(operationsFromQueue).toEqual([
        'fetch-unknown',     // First WebSocket upgrade
        'fetch-unknown',     // Second WebSocket upgrade
        'message-track-ws1', // First WebSocket message 
        'message-track-ws2'  // Second WebSocket message
      ]);
    });
  });
});

// cloudfare:test's runInDurableObject has no input gate simulation.
// @lumenize/testing's does, but it has some limitations
describe('runInDurableObject limitations', () => {
  it('should show that input gates are only partially simulated', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      // Create WebSocket connection
      const ws = new WebSocket('wss://example.com');
      
      ws.onopen = () => {
        // Test the boundaries: setTimeout delays could potentially allow operation interleaving
        // In a real DO, setTimeout can yield control and allow other pending operations to execute
        
        // Operation 1: Fetch with setTimeout delay (should potentially allow interleaving)
        instance.fetch(new Request('https://test.com?op=delayed&delay=10'));
        
        // Operation 2: Fetch without delay (might execute before delayed one finishes in real DO)
        instance.fetch(new Request('https://test.com?op=immediate'));
        
        // Operation 3: WebSocket message (also queued)
        ws.send('track-after-delay');
      };
      
      await mock.sync();
      
      // Check the actual execution order to see simulation boundaries
      const operationsFromQueue = await ctx.storage.get('operationsFromQueue') as string[] | undefined;
      
      // In our current simulation, operations should still be serialized despite setTimeout:
      // - Our queue processes operations sequentially
      // - setTimeout within a queued operation doesn't yield to other queue items
      expect(operationsFromQueue).toEqual([
        'fetch-unknown',           // WebSocket upgrade fetch call
        'fetch-delayed',           // First operation (with setTimeout delay) completes first
        'fetch-immediate',         // Second operation waits for first to complete
        'message-track-after-delay' // WebSocket message waits for fetch operations
      ]);
      
      // This demonstrates the limitation: in a real DO with setTimeout, 
      // 'fetch-immediate' might execute before 'fetch-delayed' finishes,
      // but our simulation maintains strict serial order
    });
  });
});


// The next set of tests will simulate a WebSocket upgrade over HTTP.
// You get the actual WebSocket that the Worker would see as well as proper input gates behavior.
// This is the general approach that the Cloudflare agents team uses.

// The differences between the two approaches derive from the fact that the simulate
// WS upgrade approaches go through the Worker's fetch handler. The runInDurableObject
// approach that we showed above calls the DO's methods directly.
//
// runInDurableObject cannot do any of the below, so use a simulated WS upgrade when yout want to test your:
//   - setWebSocketAutoResponse pair
//   - WebSocket sub-protcol selection code in your Worker
//   - Origin rejection that's in your Worker
//   - Native input gate behavior

describe('simulateWSUpgrade and runWithSimulatedWSUpgrade', () => {

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

  // Shows that native input gates work with runWithSimulatedWSUpgrade
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

});

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
  //   - Use it as a drop in replacement for cloudflare:test's runInDurableObject
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
    }, { timeout: 500 });
  });

  // runInDurableObject allows you to:
  //   - Inspect ctx (DurableObjectState): storage, getWebSockets, etc.
  it('should show ctx (DurableObjectState) changes when using runInDurableObject', async () => {
    let onmessageCalled = false;  // Use flags to be sure asserts inside handlers are evaluated
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
    let onmessageCalled = false;
    await runInDurableObject((instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');  
      ws.onopen = () => { ws.send('increment') };   
      ws.onmessage = (event) => { 
        expect(event.data).toBe('1');
        onmessageCalled = true;
      };
    }, { timeout: 1000 });
    expect(onmessageCalled).toBe(true);
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
  // Note: This capability is also supported with simulated WS upgrade approaches shown below
  it('should support custom headers with runInDurableObject', async () => {
    let headerInfoReceived = false;
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('headers'); // Request header information
      };
      ws.onmessage = (event) => { 
        const headers = JSON.parse(event.data);
        expect(headers['user-agent']).toBe('MyApp/1.0');
        expect(headers['origin']).toBe('https://app.example.com');
        headerInfoReceived = true;
      };
      await mock.sync();
    }, {
      origin: 'https://app.example.com',  // shorthand for Origin header
      headers: {                          // any other headers you want to add
        'User-Agent': 'MyApp/1.0'
      }
    });
    expect(headerInfoReceived).toBe(true);
  });

});

// cloudfare:test's runInDurableObject has no input gate simulation.
// @lumenize/testing's does, but it has some limitations
describe('runInDurableObject limitations', () => {
  it('should show that input gates are only partially simulated', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');
      
      ws.onopen = () => {
        // Operation 1: Fetch with setTimeout delay (should finish last, but won't)
        instance.fetch(new Request('https://test.com?op=delayed&delay=10'));
        
        // Operation 2: Fetch without delay (might execute before delayed one finishes in real DO)
        instance.fetch(new Request('https://test.com?op=immediate'));
        
        // Operation 3: WebSocket message (also queued)
        ws.send('track-after-delay');
      };
      
      await mock.sync();
      
      // With our simulated input gates, operations are strictly sequential despite setTimeout
      const operationsFromQueue = await ctx.storage.get('operationsFromQueue') as string[] | undefined;
      expect(operationsFromQueue).toEqual([
        'fetch-unknown',           // WebSocket upgrade fetch call
        'fetch-delayed',           // First operation (with setTimeout delay) completes first
        'fetch-immediate',         // Second operation waits for first to complete
        'message-track-after-delay' // WebSocket message waits for fetch operations
      ]);
    });
  });
});

// You want to use @lumenize/testing's runInDurableObject for most testing but it has
// some limitations that derive from the fact that it bypasses the Worker that normally
// proxies WebSocket connections. Rather, runInDurableObject calls the DO's methods
// directly. So, it cannot conrim the correctness of any of the following:
//   - setWebSocketAutoResponse pair
//   - WebSocket sub-protcol selection code in your Worker
//   - Origin rejection that's in your Worker
//   - Native input gate behavior
// 
// So, @lumenize/testing also provides two helpers (one higher-level than the other)
// to check all of the above. It manually creates a WebSocket upgrade request
// which returns the actual server-side ws object. This is the general approach 
// that the Cloudflare agents team uses in the tests that I've examined.

describe('simulateWSUpgrade and runWithSimulatedWSUpgrade', () => {

  // Test using @lumenize/testing's runWithSimulatedWSUpgrade with no options (uses default origin from URL)
  it('should work with runWithSimulatedWSUpgrade using default origin from URL', async () => {
    let onmessageCalled = false;
    await runWithSimulatedWSUpgrade(
      'https://example.com/wss',  // Origin is derived from url as 'https://example.com' which is convenient for testing but a security no-no in prod
      async (ws) => {
        ws.onmessage = (event) => {
          expect(event.data).toBe('pong');
          onmessageCalled = true;
        };
        ws.send('ping');
      }
    );
    expect(onmessageCalled).toBe(true);
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

  // Shows that origin validation works with runWithSimulatedWSUpgrade
  // This goes through the Worker, so origin validation is enforced
  it('should reject bad origin with runWithSimulatedWSUpgrade', async () => {
    await expect(
      runWithSimulatedWSUpgrade(
        'https://example.com/wss',
        { origin: 'https://evil.com' },  // Bad origin - not in ALLOWED_ORIGINS
        async (ws) => {
          // This should never execute because the origin will be rejected
          expect(true).toBe(false);
        }
      )
    ).rejects.toThrow('WebSocket upgrade failed with status 403: Origin header required and must be in allow list');
  });

});

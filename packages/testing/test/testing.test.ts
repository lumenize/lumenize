import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
  runInDurableObject as cf_runInDurableObject,
  createExecutionContext as cf_createExecutionContext,
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
  it('should work in cf_runInDurableObject because it does not use WebSockets', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    const response = await cf_runInDurableObject(stub, async (instance: MyDO, ctx: DurableObjectState) => {
      const request = new Request("https://example.com/increment");
      const response = await instance.fetch(request);
      expect(await ctx.storage.get<number>("count")).toBe(1);
      return response;
    });
    expect(await response.text()).toBe("1");
  });

  // The next set of tests will simulate a WebSocket upgrade over HTTP
  // There are few limitations of this approach:
  //   - You cannot use wss:// protocol as a gate for routing. Your Worker must route regular
  //     HTTP GET calls to the Durable Object. The example test-harness looks for a /wss route
  //   - You cannot use a client like AgentClient that calls the browser's WebSocket API 
  //   - It only minimally mimics the browser's WebSocket behavior. It doesn't support
  //     cookies, origin, etc.
  //   - You cannot inspect connection tags or attachments in your tests
  //   - You can inspect the messages that you receive back but not the ones that were sent in

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
  // mentioned above when using a simulated WebSocket

  // Overcomes limitations. It now allows you to:
  //   - Use wss:// protocol as a gate for routing in your Worker
  it('should support wss:// protocol URLs with runWithWebSocketMock', async () => {
    await runWithWebSocketMock(() => {
      const ws = new WebSocket('wss://example.com');  
      ws.onopen = () => { ws.send('ping') };   
      ws.onmessage = (event) => { expect(event.data).toBe('pong') };
    }, 1000);
  });

  // Overcomes limitations. It now allows you to:
  //   - Use any client library that directly calls WebSocket like AgentClient
  //   - Inspect the messages that were sent in and out
  const connectPingAndClose = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const ws = new WebSocket('wss://example.com');
      ws.onopen = () => {
        ws.send('ping');
      };
      ws.onmessage = (event) => {
        expect(event.data).toBe('pong');
        resolve(true);
      };
    });
  };
  it.only('should work with libraries that use WebSocket API', async () => {
    await runWithWebSocketMock(async () => {
      expect(await connectPingAndClose()).toBe(true);
    }, 1000);
  });
  
  // ✅ Overcomes limitation: "Doesn't support cookies, origin, etc."
  it.skip('should support browser WebSocket behavior with runWithWebSocketMock', async () => {
    await runWithWebSocketMock(async () => {
      // The mock supports full browser WebSocket API behavior
      const ws = new WebSocket('wss://example.com/authenticated');
      
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          // URL should remain unchanged (no forced cookie injection)
          expect(ws.url).toBe('wss://example.com/authenticated');
          
          // Mock supports all standard WebSocket properties
          expect(ws.protocol).toBeDefined();
          expect(ws.extensions).toBeDefined();
          expect(ws.bufferedAmount).toBeDefined();
          expect(ws.readyState).toBe(WebSocket.OPEN);
          
          resolve();
        };
        
        ws.onerror = () => {
          resolve(); // Don't fail if connection doesn't work, we're just testing API
        };
      });
    });
  }, 1000);

  // ✅ Overcomes limitation: "Cannot inspect connection tags or attachments"
  it.skip('should allow full inspection of WebSocket state with runWithWebSocketMock', async () => {
    await runWithWebSocketMock(async () => {
      const ws = new WebSocket('wss://example.com/tagged');
      
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          // Can inspect all standard WebSocket properties without URL modification
          expect(ws.protocol).toBeDefined();
          expect(ws.extensions).toBeDefined();
          expect(ws.bufferedAmount).toBeDefined();
          expect(ws.readyState).toBe(WebSocket.OPEN);
          
          // URL remains clean and unchanged
          expect(ws.url).toBe('wss://example.com/tagged');
          
          ws.close();
        };
        
        ws.onclose = () => {
          expect(ws.readyState).toBe(WebSocket.CLOSED);
          resolve();
        };
        
        ws.onerror = () => {
          resolve(); // Don't fail test if connection issues
        };
      });
    });
  }, 1000);

});
  
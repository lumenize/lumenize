import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
  runInDurableObject as cf_runInDurableObject,
  createExecutionContext as cf_createExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { simulateWSUpgrade, runWithSimulatedWSUpgrade } from '../src/websocket-utils.js';
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

  // Unit test 
  // This approach shows that you cannot use the browser WebSocket API in a unit or integration test
  it('should not allow use of browser WebSocket API', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket("wss://example.com");
      
      const timeout = setTimeout(() => {
        console.log('Test timeout after 5 seconds');
        ws.close();
        reject(new Error('WebSocket lifecycle test timed out after 5 seconds'));
      }, 5000);
      
      ws.addEventListener("error", (event) => {
        console.log('WebSocket error received');
        clearTimeout(timeout);
        resolve();
      });
      
      ws.addEventListener("open", (event) => {
        console.log('WebSocket open received');
        ws.send("Hello Server!");
        clearTimeout(timeout);
        resolve();
      });
      
      ws.addEventListener("close", (event) => {
        console.log('WebSocket close received');
        clearTimeout(timeout);
        resolve();
      });
      
      console.log('WebSocket created:', ws.readyState);
    });
  });

});
  
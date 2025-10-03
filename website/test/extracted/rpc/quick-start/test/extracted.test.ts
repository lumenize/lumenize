import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, RpcAccessible, getWebSocketShim } from '@lumenize/rpc';

import { Counter } from '../src/index';
type Counter = RpcAccessible<InstanceType<typeof Counter>>;

describe('Counter RPC over HTTP', () => {
  it('should increment the counter', async () => {
    // Create RPC client pointing to our test environment
    const client = createRpcClient<Counter>({
      transport: 'http',  // default: 'websocket'
      baseUrl: 'http://test',
      doBindingName: 'COUNTER',  // or 'counter' for nice urls
      doInstanceNameOrId: 'test-counter-over-http',
      prefix: '__rpc',  // default: '__rpc'
      fetch: SELF.fetch.bind(SELF),  // default: globalThis.fetch()
    });
    
    // Test increment
    const result1 = await client.increment();
    expect(result1).toBe(1);
    
    // Test again
    const result2 = await client.increment();
    expect(result2).toBe(2);
    
    // Verify value in storage
    const value = await client.ctx.storage.kv.get('count');  // await always required
    expect(value).toBe(2);
  });
});

describe('WebSocket RPC Transport', () => {
  it('should show all members of Counter class', async () => {
    await using client = createRpcClient<Counter>({
      doBindingName: 'counter',  // auto case-converts
      WebSocketClass: getWebSocketShim(SELF),
      doInstanceNameOrId: 'test-counter-over-websocket',
    });

    // Get object representation for inspection
    const clientAsObject = await (client as any).__asObject();

    expect(clientAsObject).toMatchObject({
      // DO methods are discoverable
      increment: "increment [Function]",
      
      // DurableObjectState context with complete API
      ctx: {
        storage: {
          get: "get [Function]",
          put: "put [Function]",
          // ... other storage methods available
          sql: {
            databaseSize: expect.any(Number), // Assert on non-function properties
            // ... other ctx.sql methods
          },
        },
        getWebSockets: "getWebSockets [Function]",
        setWebSocketAutoResponse: "setWebSocketAutoResponse [Function]",
        // ... other ctx methods available
      },
      
      // Environment object with DO bindings
      env: {
        COUNTER: {
          getByName: "getByName [Function]",
          newUniqueId: "newUniqueId [Function]",
          // ... other binding methods available
        },
        // ... other environment bindings available
      }
    });
  });
});

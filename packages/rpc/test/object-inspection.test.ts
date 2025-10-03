import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim, type RpcClientConfig, type RpcAccessible } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = RpcAccessible<InstanceType<typeof ExampleDO>>;

// Helper type to add __asObject to any proxy
type WithInspection<T> = T & { __asObject?(): Promise<any> };

// Base configuration for WebSocket tests
const baseConfig: Omit<RpcClientConfig, 'doInstanceNameOrId'> = {
  transport: 'websocket',
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  WebSocketClass: getWebSocketShim(SELF),
};

describe('Object Inspection (__asObject)', () => {

  it('should expose DO structure with __asObject() similar to @lumenize/testing', async () => {
    const client: any = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'inspection-test',
    });

    try {

    // Get the object representation
    const clientAsObject = await client.__asObject!();
    
    // Verify structure matches the pattern from @lumenize/testing
    expect(clientAsObject).toMatchObject({
      // DO methods are discoverable
      increment: "increment [Function]",
      add: "add [Function]",
      throwError: "throwError [Function]",
      getDate: "getDate [Function]",
      getMap: "getMap [Function]",
      getSet: "getSet [Function]",
      getArrayBuffer: "getArrayBuffer [Function]",
      getTypedArray: "getTypedArray [Function]",
      getObject: "getObject [Function]",
      getArrayWithFunctions: "getArrayWithFunctions [Function]",
      slowIncrement: "slowIncrement [Function]",
      
      // DurableObjectState context with complete API
      ctx: {
        storage: {
          get: "get [Function]",
          put: "put [Function]",
          delete: "delete [Function]",
          list: "list [Function]",
          deleteAll: "deleteAll [Function]",
          transaction: "transaction [Function]",
          getAlarm: "getAlarm [Function]",
          setAlarm: "setAlarm [Function]",
          deleteAlarm: "deleteAlarm [Function]",
          sync: "sync [Function]",
          transactionSync: "transactionSync [Function]",
          getCurrentBookmark: "getCurrentBookmark [Function]",
          getBookmarkForTime: "getBookmarkForTime [Function]",
          onNextSessionRestoreBookmark: "onNextSessionRestoreBookmark [Function]",
          
          // Nested kv object with its methods inline
          kv: {
            get: "get [Function]",
            put: "put [Function]",
            list: "list [Function]",
            delete: "delete [Function]"
          },
          
          // Nested sql object with methods and properties
          sql: {
            exec: "exec [Function]",
            databaseSize: expect.any(Number),
          },
        },
        getWebSockets: "getWebSockets [Function]",
        getTags: "getTags [Function]",
        setWebSocketAutoResponse: "setWebSocketAutoResponse [Function]",
        getWebSocketAutoResponse: "getWebSocketAutoResponse [Function]",
        getWebSocketAutoResponseTimestamp: "getWebSocketAutoResponseTimestamp [Function]",
        acceptWebSocket: "acceptWebSocket [Function]",
        // ... other ctx methods available
      },
      
      // Environment object (may not be populated in all tests, but structure should be accessible)
      env: expect.any(Object),
    });
  } finally {
    await client[Symbol.asyncDispose]();
  }
  });

  it('should work with HTTP transport as well', async () => {
    const client: any = createRpcClient<ExampleDO>({
      transport: 'http',
      doBindingName: 'example-do',
      doInstanceNameOrId: 'http-inspection-test',
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      fetch: SELF.fetch.bind(SELF),
    });

    try {
    const clientAsObject = await client.__asObject!();
    
    expect(clientAsObject).toMatchObject({
      increment: "increment [Function]",
      ctx: {
        storage: {
          get: "get [Function]",
          put: "put [Function]",
        }
      }
    });
  } finally {
    await client[Symbol.asyncDispose]();
  }
  });

});

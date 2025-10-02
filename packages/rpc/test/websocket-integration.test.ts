import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim, type RpcClientConfig, type RpcAccessible } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = RpcAccessible<InstanceType<typeof ExampleDO>>;

// Base configuration for WebSocket tests
const baseConfig: Omit<RpcClientConfig, 'doInstanceNameOrId'> = {
  transport: 'websocket' as const,
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  WebSocketClass: getWebSocketShim(SELF) as any,
};

describe('WebSocket RPC Integration', () => {

  it('should execute simple RPC call via WebSocket transport with lazy connection', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-simple-test',
    });

    // Execute method calls - connection happens lazily on first call
    const result = await client.increment();
    expect(result).toBe(1);

    const result2 = await client.increment();
    expect(result2).toBe(2);

    // Verify DO storage has the expected value
    const storedCount = await client.ctx.storage.kv.get('count');
    expect(storedCount).toBe(2);
  });

  it('should handle errors thrown by remote methods over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-error-test',
    });

    // Call a method that throws an error
    await expect(client.throwError('WebSocket test error')).rejects.toThrow('WebSocket test error');
  });

  it('should handle concurrent RPC calls over the same WebSocket connection', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-concurrent-test',
    });

    // Make multiple concurrent calls
    const [result1, result2, result3] = await Promise.all([
      client.add(10, 20),
      client.add(5, 15),
      client.add(100, 200),
    ]);

    expect(result1).toBe(30);
    expect(result2).toBe(20);
    expect(result3).toBe(300);
  });

  it('should handle complex data types (Map, Set, Date, ArrayBuffer) over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-complex-types-test',
    });

    // Test Date
    const date = await client.getDate();
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString()).toBe('2025-01-01T00:00:00.000Z');

    // Test Map
    const map = await client.getMap();
    expect(map).toBeInstanceOf(Map);
    expect(map.get('key')).toBe('value');

    // Test Set
    const set = await client.getSet();
    expect(set).toBeInstanceOf(Set);
    expect(set.has(1)).toBe(true);
    expect(set.has(2)).toBe(true);
    expect(set.has(3)).toBe(true);
    expect(set.size).toBe(3);

    // Test ArrayBuffer
    const arrayBuffer = await client.getArrayBuffer();
    expect(arrayBuffer).toBeInstanceOf(ArrayBuffer);
    expect(arrayBuffer.byteLength).toBe(8);

    // Test TypedArray
    const typedArray = await client.getTypedArray();
    expect(typedArray).toBeInstanceOf(Uint8Array);
    expect(Array.from(typedArray)).toEqual([1, 2, 3, 4]);
  });

  it('should handle remote function calls over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-remote-function-test',
    });

    // Get object with nested function
    const obj = await client.getObject();
    expect(obj.value).toBe(42);
    expect(obj.nested.value).toBe(42);
    
    // Call the remote function on nested object
    const nestedValue = await obj.nested.getValue();
    expect(nestedValue).toBe(42);

    // Get array with functions
    const arr = await client.getArrayWithFunctions();
    expect(arr[0]).toBe(1);
    expect(arr[1]).toBe(2);
    
    // Call remote function from array
    const fnResult = await arr[2]();
    expect(fnResult).toBe('hello');
    
    // Call remote method on object in array
    const objValue = await arr[3].getValue();
    expect(objValue).toBe(42);
    
    expect(arr[4]).toBe(5);
  });

  it('should handle deeply nested property access with intermediate proxies over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-deep-proxy-test',
    });

    // Store intermediate proxy - should return a new Proxy that can be used for further access
    const storage = client.ctx.storage;
    
    // Access deeply nested property through the intermediate proxy
    const databaseSize = await storage.sql.databaseSize;
    expect(typeof databaseSize).toBe('number');
    expect(databaseSize).toBeGreaterThanOrEqual(0);
  });

  it('should handle method calls through stored intermediate proxies over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-stored-proxy-method-test',
    });

    // Set up data first
    await client.increment();
    await client.increment();
    
    // Store intermediate proxy
    const storage = client.ctx.storage;
    
    // Call method through the stored proxy
    const value = await storage.kv.get('count');
    expect(value).toBe(2);
  });

  it('should handle storing multiple levels of intermediate proxies over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-multi-level-proxy-test',
    });

    // Store intermediate proxies at different levels
    const storage = client.ctx.storage;
    const sql = storage.sql;
    
    // Access property through the deepest stored proxy
    const size = await sql.databaseSize;
    expect(typeof size).toBe('number');
    expect(size).toBeGreaterThanOrEqual(0);
  });

  it('should handle reusing stored proxies for multiple operations over WebSocket', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-reuse-proxy-test',
    });

    // Set up data
    await client.increment();
    await client.increment();
    
    // Store intermediate proxy
    const storage = client.ctx.storage;
    
    // Reuse the stored proxy for multiple operations
    const size1 = await storage.sql.databaseSize;
    expect(typeof size1).toBe('number');
    
    const size2 = await storage.sql.databaseSize;  // Second call to same path
    expect(size2).toBe(size1);  // Should return same value
    
    const value = await storage.kv.get('count');  // Different path from same proxy
    expect(value).toBe(2);
  });

  it('should reject pending operations when explicitly disconnected', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-explicit-disconnect-test',
    });

    // Start a slow operation that will still be in-flight when we disconnect
    const promise = client.slowIncrement(500); // 500ms delay
    
    // Give it a moment to ensure the request is sent
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Explicitly disconnect while operation is pending
    await client[Symbol.asyncDispose]();
    
    // Operation should be rejected with disconnect error
    await expect(promise).rejects.toThrow('WebSocket disconnected');
  });

});

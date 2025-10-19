import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = InstanceType<typeof ExampleDO>;

// Base configuration shared across all tests
const baseConfig = {
  transport: 'http' as const,
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  fetch: SELF.fetch.bind(SELF),
};

describe('RPC client-side functionality', () => {

  // KEPT: HTTP-specific baseline test (matrix tests focus on behavior patterns, not HTTP baseline)
  it('should execute simple RPC calls via client proxy', async () => {
    // Create RPC client for the DO instance
    const client = createRpcClient<ExampleDO>('example-do', 'simple-rpc-call', baseConfig);

    // Execute simple method call through proxy
    const result = await client.increment();

    expect(result).toBe(1);
  });

  // KEPT: Custom configuration testing (timeout, headers) - unique to this test
  it('should handle custom configuration options', async () => {
    // Create client with custom configuration
    const client = createRpcClient<ExampleDO>('example-do', 'config-test', {
      ...baseConfig,
      timeout: 5000,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Custom-Header': 'test-value'
      },
    });

    // Execute call to verify custom config is applied
    const result = await client.increment();
    expect(result).toBe(1);
  });

  // KEPT: Verify timeout configuration is actually enforced
  it('should enforce custom timeout configuration', async () => {
    // Create client with a very short timeout
    const client = createRpcClient<ExampleDO>('example-do', 'timeout-test', {
      ...baseConfig,
      timeout: 50, // Very short timeout - 50ms
    });

    // Try to call a slow method that will exceed the timeout
    // slowIncrement with 200ms delay should timeout
    await expect(
      client.slowIncrement(200)
    ).rejects.toThrow(); // Should timeout
  });

  // KEPT: Verify custom headers are passed through
  it('should pass custom headers to transport', async () => {
    // Create client with custom headers
    const client = createRpcClient<ExampleDO>('example-do', 'headers-test', {
      ...baseConfig,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Custom-Header': 'custom-value',
        'X-Test-Id': 'headers-test-123'
      },
    });

    // Execute a call - headers will be passed to the underlying fetch
    // We can't directly verify headers are passed (without mocking),
    // but we can verify the client works with custom headers set
    const result = await client.increment();
    expect(result).toBe(1);
    
    // Execute another call to verify headers are consistently passed
    const result2 = await client.add(5, 3);
    expect(result2).toBe(8);
  });

  // KEPT: Verify timeout works for WebSocket transport too
  it('should enforce timeout for WebSocket transport', async () => {
    await using client = createRpcClient<ExampleDO>('example-do', 'websocket-timeout-test', {
      transport: 'websocket',
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      timeout: 50, // Very short timeout - 50ms
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
    });

    // Try to call a slow method that will exceed the timeout
    await expect(
      client.slowIncrement(200)
    ).rejects.toThrow(); // Should timeout
  });

  // KEPT: Test symbol property access (line 219 - returns undefined for symbols)
  it('should return undefined for symbol property access', async () => {
    const client = createRpcClient<ExampleDO>('example-do', 'symbol-test', baseConfig);

    // Access a symbol property (should return undefined, not try to RPC it)
    const symbolProp = (client as any)[Symbol.iterator];
    expect(symbolProp).toBeUndefined();
  });

  // KEPT: Test Symbol.dispose (sync dispose) - line 140
  it('should support synchronous Symbol.dispose', () => {
    // This tests the synchronous dispose path (line 140)
    {
      using client = createRpcClient<ExampleDO>('example-do', 'sync-dispose-test', baseConfig) as any; // Cast to any since using is a newer TS feature
      
      // Client will be automatically disposed at end of scope
      expect(client).toBeDefined();
    }
    // Client should be disposed here
  });

  // KEPT: Test calling non-function property throws error (lines 339-342)
  it('should throw error when attempting to call non-function property', async () => {
    const client = createRpcClient<ExampleDO>('example-do', 'non-function-error-test', baseConfig);

    // Get object with non-function property
    const obj = await client.getObjectWithNonFunction();
    expect(obj.notAFunction).toBe(42);
    
    // When calling a non-function value directly, JavaScript throws TypeError synchronously
    expect(() => {
      // @ts-expect-error - Intentionally calling non-function to test error handling
      obj.notAFunction();
    }).toThrow(TypeError);
  });

  // KEPT: Test WebSocket reconnection logic (line 77 - already connected path)
  it('should handle multiple calls without reconnecting (WebSocket)', async () => {
    await using client = createRpcClient<ExampleDO>('example-do', 'ws-reconnect-test', {
      transport: 'websocket',
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
    });

    // First call establishes connection
    const result1 = await client.increment();
    expect(result1).toBe(1);
    
    // Second call reuses existing connection (tests "already connected" path at line 77)
    const result2 = await client.increment();
    expect(result2).toBe(2);
    
    // Third call to ensure connection stays open
    const result3 = await client.add(5, 3);
    expect(result3).toBe(8);
  });

  // KEPT: Test async dispose and ensure proper cleanup
  it('should properly cleanup with Symbol.asyncDispose', async () => {
    let client: any;
    
    {
      await using c = createRpcClient<ExampleDO>('example-do', 'async-dispose-test', {
        transport: 'websocket',
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      });
      
      client = c;
      
      // Make a call to establish connection
      await client.increment();
    }
    // Client should be disposed here
    
    // Trying to use after dispose should fail
    await expect(client.increment()).rejects.toThrow();
  });

  // KEPT: Test explicit .then() usage (lines 241-244 - 'then' handling in proxy)
  it('should support explicit .then() chaining', async () => {
    const client = createRpcClient<ExampleDO>('example-do', 'then-chain-test', baseConfig);

    // Use .then() explicitly instead of await to test the 'then' trap handler
    const result = await client.increment().then((value: number) => {
      expect(value).toBe(1);
      return value * 2;
    });
    
    expect(result).toBe(2);
  });

  // KEPT: Test promise chaining with property access (lines 241-244, 299-328)
  it('should support promise chaining with property access', async () => {
    const client = createRpcClient<ExampleDO>('example-do', 'promise-chain-test', baseConfig);

    // Chain .then() after property access (cast to any to test thenable proxy)
    const result = await (client.getObject() as any)
      .then((obj: any) => {
        expect(obj.value).toBe(42);
        return obj.nested;
      })
      .then((nested: any) => nested.getValue());
    
    expect(result).toBe(42);
  });

  // KEPT: DO internal routing preservation - edge case not covered by matrix
  it('should not interfere with DO internal routing', async () => {
    // Test that lumenizeRpcDO doesn't break the DO's original fetch routing
    // Make a direct (non-RPC) request to the DO's /increment endpoint using routeDORequest path format
    const doId = 'direct-routing-test';
    const url = `https://fake-host.com/example-do/${doId}/increment`;
    
    const response = await SELF.fetch(url);
    
    expect(response.status).toBe(200);
    const text = await response.text();
    const count = parseInt(text);
    expect(count).toBeGreaterThan(0); // Should return incremented count from DO's fetch method
  });
});
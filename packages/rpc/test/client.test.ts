import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, type RpcClientConfig } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = InstanceType<typeof ExampleDO>;

// Base configuration shared across all tests
const baseConfig: Omit<RpcClientConfig, 'doInstanceName'> = {
  transport: 'http', // Use HTTP transport for now (WebSocket not yet implemented)
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  fetch: SELF.fetch.bind(SELF),
};

describe('RPC client-side functionality', () => {

  it('should execute simple RPC calls via client proxy', async () => {
    // Create RPC client for the DO instance
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'simple-rpc-call',
    });

    // Connect to the DO

    // Execute simple method call through proxy
    const result = await client.increment();

    expect(result).toBe(1);

    // Disconnect
  });

  it('should execute RPC calls with arguments', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'rpc-call-with-args',
    });

    // Execute method with arguments
    const result = await client.add(5, 3);

    expect(result).toBe(8);
  });

  it('should handle nested property access and method calls', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'nested-access-test',
    });

    // Access nested object and call method - should work with promise chaining
    const result = await client.getObject().nested.getValue();

    expect(result).toBe(42);
  });

  it('should handle errors thrown by remote methods', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'error-test',
    });

    // Expect error to be thrown and properly reconstructed
    await expect(client.throwError('Test error message')).rejects.toThrow('Test error message');
  });

  it('should handle complex return values with arrays', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'array-test',
    });

    // Get array return value
    const result = await client.getArray();

    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle custom configuration options', async () => {
    // Create client with custom configuration
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'config-test',
      timeout: 5000,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Custom-Header': 'test-value'
      },
    });

    // Execute simple call to verify config is applied
    const result = await client.increment();

    expect(result).toBe(1);
  });

  it('should work with test environment SELF.fetch', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'self-fetch-test',
    });

    // This should work in both browser and cloudflare:test environments
    const result = await client.increment();

    expect(result).toBe(1);
  });

  it('should handle deeply nested property access', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'deep-nest-test',
    });

    // Test deep chaining: a.b.c.d()
    const result = await client.getDeeplyNested().level1.level2.level3.getValue();

    expect(result).toBe('deeply nested value');
  });

  it('should throw error when trying to call a non-function property', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'non-function-test',
    });

    // Get the object with a non-function property and try to call it
    // This should throw an error
    await expect(
      // @ts-expect-error - Testing runtime error when calling a non-function value
      client.getObjectWithNonFunction().notAFunction()
    ).rejects.toThrow('Attempted to call a non-function value');
  });

  it('should not interfere with DO internal routing', async () => {
    // Test that lumenizeRpcDo doesn't break the DO's original fetch routing
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
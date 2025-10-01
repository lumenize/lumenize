import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { RpcClientFactory as RpcClientFactory } from '../src/client';
import type { RpcClientFactoryConfig } from '../src/types';

import { ExampleDO } from './example-do';
type ExampleDO = InstanceType<typeof ExampleDO>;

// Shared configuration for tests that don't need custom config
const rpcClientConfig: RpcClientFactoryConfig = {
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  fetch: SELF.fetch.bind(SELF),
}
const rpcClientFactory = new RpcClientFactory(rpcClientConfig);

describe('RPC client-side functionality', () => {

  it('should execute simple RPC calls via client proxy', async () => {
    // Create proxy for the DO instance
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'simple-rpc-call');

    // Execute simple method call through proxy
    const result = await rpcProxy.increment();

    expect(result).toBe(1);
  });

  it('should execute RPC calls with arguments', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'rpc-call-with-args');

    // Execute method with arguments
    const result = await rpcProxy.add(5, 3);

    expect(result).toBe(8);
  });

  it('should handle nested property access and method calls', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'nested-access-test');

    // Access nested object and call method - should work with promise chaining
    const result = await rpcProxy.getObject().nested.getValue();

    expect(result).toBe(42);
  });

  it('should handle errors thrown by remote methods', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'error-test');

    // Expect error to be thrown and properly reconstructed
    await expect(rpcProxy.throwError('Test error message')).rejects.toThrow('Test error message');
  });

  it('should handle complex return values with arrays', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'array-test');

    // Get array return value
    const result = await rpcProxy.getArray();

    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle custom configuration options', async () => {
    // Create client with custom configuration
    const rpcClientConfig: RpcClientFactoryConfig = {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      timeout: 5000,
      headers: {
        'Authorization': 'Bearer test-token',
        'X-Custom-Header': 'test-value'
      },
      fetch: SELF.fetch.bind(SELF),
    }
    const rpcClientFactory = new RpcClientFactory(rpcClientConfig);

    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'config-test');

    // Execute simple call to verify config is applied
    const result = await rpcProxy.increment();

    expect(result).toBe(1);
  });

  it('should work with test environment SELF.fetch', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'self-fetch-test');

    // This should work in both browser and cloudflare:test environments
    const result = await rpcProxy.increment();

    expect(result).toBe(1);
  });

  it('should handle deeply nested property access', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'deep-nest-test');

    // Test deep chaining: a.b.c.d()
    const result = await rpcProxy.getDeeplyNested().level1.level2.level3.getValue();

    expect(result).toBe('deeply nested value');
  });

  it('should throw error when trying to call a non-function property', async () => {
    const rpcProxy = rpcClientFactory.createRpcProxy<ExampleDO>('example-do', 'non-function-test');

    // Get the object with a non-function property and try to call it
    // This should throw an error
    await expect(
      // @ts-expect-error - Testing runtime error when calling a non-function value
      rpcProxy.getObjectWithNonFunction().notAFunction()
    ).rejects.toThrow('Attempted to call a non-function value');
  });

  it('should not interfere with DO internal routing', async () => {
    // Test that lumenizeRpcDo doesn't break the DO's original fetch routing
    // Make a direct (non-RPC) request to the DO's /increment endpoint
    const doId = 'direct-routing-test';
    const url = `https://fake-host.com/do/${doId}/increment`;
    
    const response = await SELF.fetch(url);
    
    expect(response.status).toBe(200);
    const text = await response.text();
    const count = parseInt(text);
    expect(count).toBeGreaterThan(0); // Should return incremented count from DO's fetch method
  });
});
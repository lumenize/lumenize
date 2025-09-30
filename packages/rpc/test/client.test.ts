import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { runInDurableObject, env, SELF } from 'cloudflare:test';
import { RPCClient } from '../src/client';
import type { RPCClientConfig } from '../src/types';

describe('RPCClient client-side functionality', () => {

  it.only('should execute simple RPC calls via client proxy', async () => {
    // Get the Durable Object stub from the environment
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    // Create RPC client configured to use SELF.fetch with proper binding
    const rpcClientConfig: RPCClientConfig = {
      baseUrl: 'https://fake-host.com',
      prefix: `/__rpc/EXAMPLE_DO/${id.toString()}`,
      fetch: SELF.fetch.bind(SELF),
    }
    const client = new RPCClient(rpcClientConfig);

    // Create proxy for the DO instance
    const proxy = client.createProxy(env.EXAMPLE_DO, id);

    // Execute simple method call through proxy
    const result = await proxy.increment();

    expect(result).toBe(1);
  });

  it('should execute RPC calls with arguments', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // Execute method with arguments
      const result = await proxy.add(5, 3);

      expect(result).toBe(8);
    });
  });

  it('should handle nested property access and method calls', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // Access nested object and call method
      const result = await proxy.getObject().nested.getValue();

      expect(result).toBe(42);
    });
  });

  it('should handle errors thrown by remote methods', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // Expect error to be thrown and properly reconstructed
      await expect(proxy.throwError('Test error message')).rejects.toThrow('Test error message');
    });
  });

  it('should handle complex return values with arrays', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // Get array return value
      const result = await proxy.getArray();

      expect(result).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('should handle custom configuration options', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      // Create client with custom configuration
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        timeout: 5000,
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Custom-Header': 'test-value'
        },
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // Execute simple call to verify config is applied
      const result = await proxy.increment();

      expect(result).toBe(1);
    });
  });

  it('should work with test environment SELF.fetch', async () => {
    const id = env.EXAMPLE_DO.newUniqueId();
    const stub = env.EXAMPLE_DO.get(id);

    await runInDurableObject(stub, async (instance: any, ctx: any, mock: any) => {
      // Create client specifically for cloudflare:test environment
      const client = new RPCClient({
        baseUrl: 'http://localhost:8787',
        fetch: (globalThis as any).SELF?.fetch || globalThis.fetch
      });

      const proxy = client.createProxy(env.EXAMPLE_DO, id);

      // This should work in both browser and cloudflare:test environments
      const result = await proxy.increment();

      expect(result).toBe(1);
    });
  });
});
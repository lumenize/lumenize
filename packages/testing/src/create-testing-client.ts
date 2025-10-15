import type { RpcClientConfig, RpcAccessible, RpcClientProxy } from '@lumenize/rpc';
import { createRpcClient } from '@lumenize/rpc';

/**
 * Creates a testing-optimized RPC client for Cloudflare Durable Objects.
 * 
 * This is a convenience wrapper around `createRpcClient` that automatically:
 * - Imports SELF from cloudflare:test
 * - Uses HTTP transport (simple and fast for testing)
 * - Provides RPC access to DO instance internals
 * 
 * @remarks
 * Internally calls {@link createRpcClient} with testing-specific defaults.
 * For production use or when you need full configuration control (custom transports,
 * WebSocket connections, custom headers, etc.), use {@link createRpcClient} directly.
 * 
 * Both functions return the same underlying RpcClient instance and support 'await using'
 * for automatic cleanup. The only difference is the level of configuration abstraction.
 * 
 * For test timeouts, use your test framework's timeout features (e.g., Vitest's `test.timeout`).
 * 
 * @example
 * ```typescript
 * // Testing - simple, opinionated (this function)
 * await using client = createTestingClient<MyDOType>('MY_DO', 'instance-name');
 * await client.ctx.storage.put('key', 'value');
 * 
 * // Production - full control (use createRpcClient)
 * await using client = createRpcClient<MyDOType>({
 *   doBindingName: 'MY_DO',
 *   doInstanceNameOrId: 'instance-name',
 *   transport: 'websocket',
 *   baseUrl: 'https://api.example.com'
 * });
 * ```
 * 
 * @typeParam T - The type of the Durable Object. Use {@link RpcAccessible} to expose protected properties like `ctx` and `env`.
 * @param doBindingName - The DO binding name from wrangler.jsonc (e.g., 'MY_DO')
 * @param doInstanceNameOrId - The DO instance name or ID
 * @returns A proxy client that supports both RPC calls and lifecycle management
 */
export function createTestingClient<T>(
  doBindingName: string,
  doInstanceNameOrId: string,
): T & RpcClientProxy {
  // Dynamic import to access cloudflare:test in test environment
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SELF } = require('cloudflare:test') as { SELF: { fetch: typeof fetch } };
  
  // Use HTTP transport - simpler and faster for testing
  const baseFetch: typeof fetch = SELF.fetch.bind(SELF);
  
  // Build config
  const config: RpcClientConfig = {
    doBindingName,
    doInstanceNameOrId,
    fetch: baseFetch,
    transport: 'http',
  };
  
  return createRpcClient<T>(config);
}

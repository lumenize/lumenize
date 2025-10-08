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
 * For cookie-aware testing, use CookieJar with the exported `fetch` and `WebSocket`:
 * ```typescript
 * const jar = new CookieJar();
 * const cookieFetch = jar.getFetch(fetch);
 * const CookieWS = jar.getWebSocket(fetch);
 * ```
 * 
 * For test timeouts, use your test framework's timeout features (e.g., Vitest's `test.timeout`).
 * 
 * @example
 * ```typescript
 * // Simple usage - just binding name and instance ID!
 * await using client = createTestingClient<MyDOType>('MY_DO', 'instance-name');
 * await client.ctx.storage.put('key', 'value');
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

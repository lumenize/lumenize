import type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';
import { createRpcClient } from '@lumenize/rpc';

/**
 * Creates a testing-optimized RPC client for Cloudflare Durable Objects.
 * 
 * **Environment Requirement**: This function can only be used within Cloudflare Workers
 * test environment (vitest with @cloudflare/vitest-pool-workers). It imports from
 * `cloudflare:test` which is only available in that environment.
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
 * Both functions return the same underlying RpcClient instance and support 'using'
 * for automatic cleanup. The only difference is the level of configuration abstraction.
 * 
 * For test timeouts, use your test framework's timeout features (e.g., Vitest's `test.timeout`).
 * 
 * @example
 * ```typescript
 * using client = createTestingClient<typeof MyDO>('MY_DO', 'instance-name');
 * await client.ctx.storage.put('key', 'value');
 * 
 * // For TypeScript, it also supports interfaces or pre-wrapping using `RpcAccessible`
 * type MyDOType = RpcAccessible<InstanceType<typeof MyDO>>;
 * using client = createTestingClient<MyDOType>('MY_DO', 'instance-name');
 * 
 * // Production - full control (use createRpcClient)
 * using client = createRpcClient<typeof MyDO>('MY_DO', 'instance-name', {
 *   transport: 'websocket',
 *   baseUrl: 'https://api.example.com'
 * });
 * ```
 * 
 * @typeParam T - The DO class constructor (e.g., `typeof MyDO`) or pre-wrapped with `RpcAccessible`.
 * @param doBindingName - The DO binding name from wrangler.jsonc (e.g., 'MY_DO')
 * @param doInstanceNameOrId - The DO instance name or ID
 * @returns A proxy client that supports both RPC calls and lifecycle management
 * 
 * @throws {Error} Will fail to import if used outside vitest-pool-workers environment
 */
export function createTestingClient<T>(
  doBindingName: string,
  doInstanceNameOrId: string,
): (T extends abstract new (...args: any[]) => infer I ? RpcAccessible<I> : T) & RpcClientProxy {
  // Lazy import SELF to avoid top-level cloudflare:test dependency that breaks module loading
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SELF } = require('cloudflare:test');
  
  // Use HTTP transport - simpler and faster for testing
  const baseFetch: typeof fetch = SELF.fetch.bind(SELF);
  
  // Call createRpcClient with same type parameter
  return createRpcClient<T>(doBindingName, doInstanceNameOrId, {
    fetch: baseFetch,
    transport: 'http',
  });
}

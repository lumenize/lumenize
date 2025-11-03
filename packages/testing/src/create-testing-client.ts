import type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/utils';

/**
 * Creates a testing-optimized RPC client for Cloudflare Durable Objects.
 * 
 * **Environment Requirement**: This function can only be used within Cloudflare Workers
 * test environment (vitest with @cloudflare/vitest-pool-workers). It imports from
 * `cloudflare:test` which is only available in that environment.
 * 
 * This is a convenience wrapper around `createRpcClient` that automatically:
 * - Imports SELF from cloudflare:test
 * - Uses WebSocket transport (persistent connection, supports downstream messaging)
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
 * // With downstream messaging
 * using client = createTestingClient<typeof MyDO>('MY_DO', 'instance-name', {
 *   onDownstream: (payload) => console.log('Received:', payload),
 *   onClose: (code, reason) => console.log('Connection closed')
 * });
 * ```
 * 
 * @typeParam T - The DO class constructor (e.g., `typeof MyDO`) or pre-wrapped with `RpcAccessible`.
 * @param doBindingName - The DO binding name from wrangler.jsonc (e.g., 'MY_DO')
 * @param doInstanceNameOrId - The DO instance name or ID
 * @param config - Optional configuration for downstream messaging and connection handling
 * @returns A proxy client that supports both RPC calls and lifecycle management
 * 
 * @throws {Error} Will fail to import if used outside vitest-pool-workers environment
 */
export function createTestingClient<T>(
  doBindingName: string,
  doInstanceNameOrId: string,
  config?: {
    /**
     * Handler for downstream messages from the DO
     * Requires clientId to be set when used
     */
    onDownstream?: (payload: any) => void | Promise<void>;
    
    /**
     * Handler for WebSocket connection close events
     */
    onClose?: (code: number, reason: string) => void | Promise<void>;
    
    /**
     * Optional client ID for downstream messaging
     * If not provided but onDownstream is set, a random ID will be generated
     */
    clientId?: string;
  }
): (T extends abstract new (...args: any[]) => infer I ? RpcAccessible<I> : T) & RpcClientProxy {
  // Lazy import SELF to avoid top-level cloudflare:test dependency that breaks module loading
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SELF } = require('cloudflare:test');
  
  // Generate clientId if onDownstream is provided but clientId is not
  const clientId = config?.onDownstream && !config?.clientId
    ? `test-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    : config?.clientId;
  
  // Use WebSocket transport - supports downstream messaging
  const baseFetch: typeof fetch = SELF.fetch.bind(SELF);
  
  // Call createRpcClient with WebSocket transport factory
  return createRpcClient<T>({
    transport: createWebSocketTransport(doBindingName, doInstanceNameOrId, {
      WebSocketClass: getWebSocketShim(baseFetch),
      baseUrl: 'https://fake-host.com',  // Required but not used in test environment
      prefix: '__rpc',
      onDownstream: config?.onDownstream,
      onClose: config?.onClose,
    }),
    clientId,
    onDownstream: config?.onDownstream,
    onClose: config?.onClose,
  });
}

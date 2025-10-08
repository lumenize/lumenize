import type { RpcClientConfig, RpcAccessible, RpcClientProxy } from '@lumenize/rpc';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';
import { CookieJar } from '@lumenize/utils';

/**
 * Options for createTestingClient
 */
export interface TestingClientOptions {
  /**
   * Transport type to use for RPC communication.
   * @default 'http'
   */
  transport?: 'http' | 'websocket';
  
  /**
   * Optional cookie jar for automatic cookie management in tests.
   * If provided, all requests will automatically send/receive cookies.
   */
  cookieJar?: CookieJar;
  
  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;
  
  /**
   * Custom headers to include with all requests.
   * @default {}
   */
  headers?: Record<string, string>;
}

/**
 * Creates a testing-optimized RPC client for Cloudflare Durable Objects.
 * 
 * This is a convenience wrapper around `createRpcClient` that automatically:
 * - Imports SELF from cloudflare:test
 * - Configures appropriate transport (defaults to HTTP for simplicity)
 * - Sets up WebSocket shim when using WebSocket transport
 * - Optionally integrates CookieJar for cookie-aware testing
 * 
 * @example
 * ```typescript
 * // Simple usage
 * await using client = createTestingClient<MyDOType>('MY_DO', 'instance-name');
 * await client.ctx.storage.put('key', 'value');
 * 
 * // With WebSocket transport
 * await using client = createTestingClient<MyDOType>('MY_DO', 'instance-name', {
 *   transport: 'websocket'
 * });
 * 
 * // With cookie jar
 * const cookieJar = new CookieJar();
 * await using client = createTestingClient<MyDOType>('MY_DO', 'instance-name', {
 *   cookieJar
 * });
 * ```
 * 
 * @typeParam T - The type of the Durable Object. Use {@link RpcAccessible} to expose protected properties like `ctx` and `env`.
 * @param doBindingName - The DO binding name from wrangler.jsonc (e.g., 'MY_DO')
 * @param doInstanceNameOrId - The DO instance name or ID
 * @param options - Optional configuration
 * @returns A proxy client that supports both RPC calls and lifecycle management
 */
export function createTestingClient<T>(
  doBindingName: string,
  doInstanceNameOrId: string,
  options?: TestingClientOptions
): T & RpcClientProxy {
  // Dynamic import to access cloudflare:test in test environment
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SELF } = require('cloudflare:test') as { SELF: { fetch: typeof fetch } };
  
  const transport = options?.transport ?? 'http';
  const cookieJar = options?.cookieJar;
  
  // Get base fetch (either from cookieJar or SELF)
  const baseFetch: typeof fetch = SELF.fetch.bind(SELF);
  const fetchFn: typeof fetch = cookieJar ? cookieJar.getFetch(baseFetch) : baseFetch;
  
  // Build config
  const config: RpcClientConfig = {
    doBindingName,
    doInstanceNameOrId,
    fetch: fetchFn,
    transport,
    // Only include optional fields if they have values (don't pass undefined)
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.headers && { headers: options.headers }),
  };
  
  // Add WebSocketClass if using websocket transport
  if (transport === 'websocket') {
    config.WebSocketClass = getWebSocketShim(baseFetch);
  }
  
  return createRpcClient<T>(config);
}

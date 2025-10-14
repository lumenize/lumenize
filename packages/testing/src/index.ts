// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';

// DO project instrumentation
export { instrumentDOProject } from './instrument-do-project';
export type { InstrumentDOProjectConfig, InstrumentedDOProject } from './instrument-do-project';

// Re-export Browser from @lumenize/utils
export { Browser } from '@lumenize/utils';

// Internal: Import cloudflare:test for re-export
const cloudflareTest = require('cloudflare:test') as {
  SELF: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  env: any;
};

/**
 * Re-exported RPC types from @lumenize/rpc
 * 
 * These types are re-exported for convenience:
 * 
 * - [`RpcAccessible`](https://lumenize.dev/docs/rpc/api/type-aliases/RpcAccessible) - Marks a class as accessible via RPC
 * - [`RpcClientProxy`](https://lumenize.dev/docs/rpc/api/interfaces/RpcClientProxy) - Type for the RPC client proxy
 */
export type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';

/**
 * Cloudflare Workers test environment (for advanced use cases)
 * 
 * Provides direct access to the test environment. Most users won't need this - 
 * use {@link Browser} instead, which wrap these automatically.
 * 
 * @example
 * ```typescript
 * import { SELF, env } from '@lumenize/testing';
 * 
 * // Advanced: Direct access to test environment
 * const response = await SELF.fetch('http://localhost/api');
 * const binding = env.MY_BINDING;
 * ```
 */
export const { SELF, env } = cloudflareTest;

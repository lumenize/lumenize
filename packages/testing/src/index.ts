// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';

// DO project instrumentation
export { instrumentDOProject } from './instrument-do-project';
export type { InstrumentDOProjectConfig, InstrumentedDOProject } from './instrument-do-project';

// Export testing-specific Browser with convenience methods
export { Browser } from './browser';

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
 * use {@link Browser}, {@link fetch}, and {@link WebSocket} instead, which wrap
 * these automatically.
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

/**
 * Pre-bound fetch for testing (for advanced use cases)
 * 
 * A fetch function bound to SELF.fetch. Most users should use {@link Browser.fetch} instead,
 * which includes automatic cookie management.
 * 
 * @example
 * ```typescript
 * import { fetch } from '@lumenize/testing';
 * 
 * // Simple fetch without cookies
 * const response = await fetch('http://localhost/api');
 * ```
 */
export const fetch: typeof globalThis.fetch = SELF.fetch.bind(SELF) as typeof globalThis.fetch;

// Internal: Import WebSocket shim utility
import { getWebSocketShim } from '@lumenize/utils';

/**
 * WebSocket constructor for testing (for advanced use cases)
 * 
 * A WebSocket constructor that works in the test environment. Most users should use 
 * {@link Browser.WebSocket} instead, which includes automatic cookie management.
 * 
 * @example
 * ```typescript
 * import { WebSocket } from '@lumenize/testing';
 * 
 * // Simple WebSocket without cookies
 * const ws = new WebSocket('ws://localhost/socket');
 * ```
 */
export const WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket = getWebSocketShim(fetch);

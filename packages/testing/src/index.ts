// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';
export type { TestingClientOptions } from './create-testing-client';

// DO project instrumentation
export { instrumentDOProject } from './instrument-do-project';
export type { InstrumentDOProjectConfig, InstrumentedDOProject } from './instrument-do-project';

// Re-export useful types from @lumenize/rpc
export type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';

// Re-export utilities from @lumenize/utils for convenience
export { CookieJar, getWebSocketShim } from '@lumenize/utils';

// Re-export SELF and env from cloudflare:test for single source of truth
const cloudflareTest = require('cloudflare:test') as {
  SELF: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  env: any;
};

export const { SELF, env } = cloudflareTest;

// Export simple fetch for testing (bound to SELF.fetch)
export const fetch: typeof globalThis.fetch = SELF.fetch.bind(SELF) as typeof globalThis.fetch;

// Export WebSocket shim for testing (uses the simple fetch)
// Note: Typed as constructor since the shim implements browser WebSocket API
import { getWebSocketShim } from '@lumenize/utils';
export const WebSocket: new (url: string | URL, protocols?: string | string[]) => WebSocket = getWebSocketShim(fetch);

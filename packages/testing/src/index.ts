// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';
export type { TestingClientOptions } from './create-testing-client';

// Re-export useful types from @lumenize/rpc
export type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';

// Re-export utilities from @lumenize/utils for convenience
export { CookieJar, getWebSocketShim } from '@lumenize/utils';

// Re-export SELF and env from cloudflare:test for single source of truth
export const { SELF, env } = require('cloudflare:test') as {
  SELF: { fetch: typeof fetch };
  env: any;
};

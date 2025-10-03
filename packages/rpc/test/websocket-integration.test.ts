import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim, type RpcClientConfig, type RpcAccessible } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = RpcAccessible<InstanceType<typeof ExampleDO>>;

// Base configuration for WebSocket tests
const baseConfig: Omit<RpcClientConfig, 'doInstanceNameOrId'> = {
  transport: 'websocket',
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  WebSocketClass: getWebSocketShim(SELF),
};

/**
 * WebSocket Edge Case Tests
 * 
 * KEPT: These test edge cases specific to WebSocket transport that aren't covered by matrix tests.
 * Most WebSocket behavior is tested in matrix.test.ts across all configurations.
 */
describe('WebSocket RPC Integration', () => {

  // KEPT: Explicit disconnect error handling - edge case not covered by matrix
  it('should reject pending operations when explicitly disconnected', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-explicit-disconnect-test',
    });

    // Start a slow operation that will still be in-flight when we disconnect
    const promise = client.slowIncrement(500); // 500ms delay
    
    // Give it a moment to ensure the request is sent
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Explicitly disconnect while operation is pending
    await client[Symbol.asyncDispose]();
    
    // Operation should be rejected with disconnect error
    await expect(promise).rejects.toThrow('WebSocket disconnected');
  });

});

import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim, type RpcClientConfig, type RpcAccessible } from '../src/index';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = RpcAccessible<InstanceType<typeof ExampleDO>>;

// Base configuration for WebSocket tests
const baseConfig = {
  transport: 'websocket' as const,
  doBindingName: 'example-do',
  baseUrl: 'https://fake-host.com',
  prefix: '__rpc',
  WebSocketClass: getWebSocketShim(SELF) as any,
};

describe('WebSocket RPC Integration', () => {

  it('should execute simple RPC call via WebSocket transport with lazy connection', async () => {
    await using client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceName: 'websocket-simple-test',
    });

    // Execute method calls - connection happens lazily on first call
    const result = await client.increment();
    expect(result).toBe(1);

    const result2 = await client.increment();
    expect(result2).toBe(2);

    // Verify DO storage has the expected value
    const storedCount = await client.ctx.storage.kv.get('count');
    expect(storedCount).toBe(2);
  });

});

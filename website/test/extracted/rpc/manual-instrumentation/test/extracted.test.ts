import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { SELF } from 'cloudflare:test';
import { createRpcClient, RpcAccessible, getWebSocketShim } from '@lumenize/rpc';
import { MyDO } from '../src/index';

type MyDO = RpcAccessible<InstanceType<typeof MyDO>>;

describe('Manual Instrumentation', () => {
  it('should support custom HTTP routes alongside RPC', async () => {
    const instanceId = 'manual-http-test';

    // Test custom /health endpoint (direct to DO, not via /__rpc prefix)
    const healthRes = await SELF.fetch(`https://test/my-do/${instanceId}/health`);
    expect(await healthRes.text()).toBe('OK');

    // Test RPC (uses /__rpc prefix automatically)
    const client = createRpcClient<MyDO>({
      transport: 'http',
      doBindingName: 'MY_DO',
      doInstanceNameOrId: instanceId,
      fetch: SELF.fetch.bind(SELF),
    });

    const count1 = await client.increment();
    expect(count1).toBe(1);

    // Test custom /status endpoint (direct to DO)
    const statusRes = await SELF.fetch(`https://test/my-do/${instanceId}/status`);
    const status = await statusRes.json();
    expect(status).toEqual({ counter: 1 });

    // RPC still works
    const count2 = await client.increment();
    expect(count2).toBe(2);

    // Reset via RPC
    await client.reset();

    // Verify via custom endpoint
    const statusRes2 = await SELF.fetch(`https://test/my-do/${instanceId}/status`);
    const status2 = await statusRes2.json();
    expect(status2).toEqual({ counter: 0 });
  });

  it('should support custom WebSocket messages alongside RPC', async () => {
    const instanceId = 'manual-ws-test';
    const WebSocketClass = getWebSocketShim(SELF);

    // Create custom WebSocket connection (direct to DO, not via /__rpc)
    const customWs = new WebSocketClass(`wss://test/my-do/${instanceId}/custom-ws`);

    await vi.waitFor(() => {
      expect(customWs.readyState).toBe(WebSocket.OPEN);
    });

    // Test custom protocol (PING/PONG)
    let receivedPong = false;
    customWs.addEventListener('message', (event: MessageEvent) => {
      if (event.data === 'PONG') receivedPong = true;
    });

    customWs.send('PING');
    await vi.waitFor(() => expect(receivedPong).toBe(true));

    // Create RPC client (uses RPC WebSocket endpoint, not custom)
    await using client = createRpcClient<MyDO>({
      doBindingName: 'MY_DO',
      doInstanceNameOrId: instanceId,
      WebSocketClass,
    });

    // RPC works independently
    const count1 = await client.increment();
    expect(count1).toBe(1);

    const count2 = await client.increment();
    expect(count2).toBe(2);

    // Custom WebSocket still works
    receivedPong = false;
    customWs.send('PING');
    await vi.waitFor(() => expect(receivedPong).toBe(true));

    // Cleanup custom WebSocket
    customWs.close();
  });
});
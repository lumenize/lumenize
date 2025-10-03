import { describe, it, expect, vi } from 'vitest';
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

  // Test already-connected path (line 85) - reconnection prevention
  it('should not reconnect when already connected', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-already-connected-test',
    });

    try {
      // First call establishes connection
      const result1 = await client.increment();
      expect(result1).toBeGreaterThan(0);
      
      // Second call should reuse same connection (tests line 85)
      const result2 = await client.increment();
      expect(result2).toBe(result1 + 1);
      
      // Third call to be sure
      const result3 = await client.add(5, 3);
      expect(result3).toBe(8);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  // Test concurrent connection attempts (line 90) - connection promise reuse
  it('should handle concurrent operations before first connection', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-concurrent-connect-test',
    });

    try {
      // Fire multiple operations simultaneously before any connection exists
      // This tests that connection promise is shared (line 90)
      const promises = Promise.all([
        client.increment(),
        client.increment(),
        client.add(5, 3),
      ]);
      
      const [result1, result2, result3] = await promises;
      
      // All should succeed (order may vary due to concurrency)
      expect(result1).toBeGreaterThan(0);
      expect(result2).toBeGreaterThan(0);
      expect(result3).toBe(8);
      // Verify we got different counter values
      expect(new Set([result1, result2]).size).toBe(2);
    } finally {
      await client[Symbol.asyncDispose]();
    }
  });

  // Test auto-reconnect after disconnect (line 271)
  it('should auto-reconnect after explicit disconnect', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-auto-reconnect-test',
    });

    try {
      // First call connects and increments
      const count1 = await client.increment();
      expect(count1).toBeGreaterThan(0);
      
      // Explicitly disconnect
      await client[Symbol.asyncDispose]();
      
      // Next call should auto-reconnect (tests line 271)
      const count2 = await client.increment();
      expect(count2).toBeGreaterThan(count1);
    } finally {
      // Clean up in case last call succeeded
      try {
        await client[Symbol.asyncDispose]();
      } catch {
        // May already be disposed
      }
    }
  });

  // Test close handler with pending operations (lines 176-189)
  it('should reject all pending operations when WebSocket closes', async () => {
    const client = createRpcClient<ExampleDO>({
      ...baseConfig,
      doInstanceNameOrId: 'websocket-close-pending-test',
    });

    try {
      // Start a slow operation that will be pending when we close
      const promise1 = client.slowIncrement(1000); // 1 second delay
      const promise2 = client.slowIncrement(1000); // Another slow one
      
      // Give a moment for requests to be sent
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Close the connection while operations are pending
      await client[Symbol.asyncDispose]();
      
      // Both operations should be rejected
      await expect(promise1).rejects.toThrow('WebSocket');
      await expect(promise2).rejects.toThrow('WebSocket');
    } finally {
      // Already disposed
    }
  });

  // Test user's custom WebSocket coexistence with RPC client
  it('should allow user custom WebSocket to coexist with RPC client WebSocket', async () => {
    const instanceId = 'websocket-custom-coexist-test';
    const WebSocketClass = getWebSocketShim(SELF);
    
    // User creates their own WebSocket connection (e.g., for streaming, notifications, etc.)
    const customWsUrl = `wss://fake-host.com/__rpc/manual-routing-do/${instanceId}`;
    const customWs = new WebSocketClass(customWsUrl);
    
    // Wait for custom WebSocket to connect
    let wsConnected = false;
    customWs.addEventListener('open', () => { wsConnected = true; });
    customWs.addEventListener('error', (err) => { throw err; });
    
    await vi.waitFor(() => {
      expect(wsConnected).toBe(true);
    });

    try {  // OK because there is no catch block, only here so finally can cleanup
      // User sends/receives custom messages on their WebSocket
      let receivedPong = '';
      customWs.addEventListener('message', (event: MessageEvent) => {
        if (event.data === 'PONG') {
          receivedPong = event.data;
        }
      });
      
      customWs.send('PING');
      await vi.waitFor(() => {
        expect(receivedPong).toBe('PONG');
      });

      // Meanwhile, user also creates RPC client (which creates its own WebSocket)
      const client = createRpcClient<ExampleDO>({
        doBindingName: 'manual-routing-do',
        doInstanceNameOrId: instanceId,
        transport: 'websocket',
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass,
      });

      // RPC client should work fine (separate WebSocket connection)
      const count1 = await client.increment();
      expect(count1).toBeGreaterThan(0);

      const count2 = await client.increment();
      expect(count2).toBe(count1 + 1);

      // Custom WebSocket should still work (send another PING)
      receivedPong = ''; // Reset
      customWs.send('PING');
      await vi.waitFor(() => {
        expect(receivedPong).toBe('PONG');
      });

      // Both connections coexist - clean up
      await client[Symbol.asyncDispose]();
    } finally {
      customWs.close();
    }
  });

});

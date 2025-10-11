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
  WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
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
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    
    // User creates their own WebSocket connection on a separate endpoint
    // This simulates a custom WebSocket for streaming, notifications, etc.
    const customWsUrl = `wss://fake-host.com/manual-routing-do/${instanceId}/custom-ws`;
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

      // Meanwhile, user also creates RPC client (which creates its own WebSocket on RPC endpoint)
      const client = createRpcClient<ExampleDO>({
        doBindingName: 'manual-routing-do',
        doInstanceNameOrId: instanceId,
        transport: 'websocket',
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass,
      });

      // RPC client should work fine (separate WebSocket connection on /__rpc endpoint)
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

      // Both connections coexist independently - clean up
      await client[Symbol.asyncDispose]();
    } finally {
      customWs.close();
    }
  });

});

/**
 * WebSocket Shim Integration Tests
 * 
 * These tests validate the WebSocket shim's behavior using real WebSocket connections
 * to Durable Objects, replacing mock-based unit tests that could give false positives.
 */
describe('WebSocket Shim Integration', () => {
  
  it('should negotiate protocol from response header', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    
    // Create WebSocket with multiple protocols - server selects 'correct.subprotocol'
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/protocol-test/ws', 
      ['wrong.protocol', 'correct.subprotocol', 'another.protocol']) as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // Verify protocol is set from response header
    expect(ws.protocol).toBe('correct.subprotocol');
    // Note, ws.response is non-standard. It might be useful in a testing environment though
    expect(ws.response.headers.get('Sec-WebSocket-Protocol')).toBe('correct.subprotocol');
    
    ws.close();
  });
  
  it('should queue messages during CONNECTING and flush on open', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/queue-test/ws') as any;
    
    // Send messages immediately (while CONNECTING)
    expect(ws.readyState).toBe(0); // CONNECTING
    ws.send('message1');
    ws.send('message2');
    ws.send('message3');
    
    // bufferedAmount should reflect queued bytes
    expect(ws.bufferedAmount).toBeGreaterThan(0);
    
    // Test both onmessage property AND addEventListener work simultaneously
    let receivedMessages: string[] = [];
    ws.onmessage = (event: MessageEvent) => {
      receivedMessages.push(event.data);
    };
    
    let receivedViaListener: string[] = [];
    ws.addEventListener('message', (event: MessageEvent) => {
      receivedViaListener.push(event.data);
    });
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    let openedViaListener = false;
    ws.addEventListener('open', () => { openedViaListener = true; });
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    expect(openedViaListener).toBe(true);
    
    // Wait for echo responses (server echoes messages back)
    await vi.waitFor(() => expect(receivedMessages.length).toBe(3));
    
    // Verify messages were flushed in order via onmessage
    expect(receivedMessages).toEqual(['message1', 'message2', 'message3']);
    
    // Verify addEventListener also received the same messages
    expect(receivedViaListener).toEqual(['message1', 'message2', 'message3']);
    
    // bufferedAmount should be 0 after flushing
    expect(ws.bufferedAmount).toBe(0);
    
    ws.close();
  });
  
  it('should enforce maxQueueBytes limit during CONNECTING', () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF), {
      maxQueueBytes: 20 // Very small limit
    });
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/max-queue-test/ws');
    
    // Should be in CONNECTING state
    expect(ws.readyState).toBe(0);
    
    // Send a message that fits
    ws.send('small'); // ~5 bytes
    
    // Try to send a message that exceeds limit
    const largeMessage = 'x'.repeat(100); // 100 bytes
    expect(() => ws.send(largeMessage)).toThrow('CONNECTING queue exceeded maxQueueBytes');
    
    // Clean up
    ws.close();
  });
  
  it('should handle binary messages (ArrayBuffer)', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/binary-test/ws') as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // Send binary data
    const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
    ws.send(binaryData);
    
    let receivedBinary: any = null;
    ws.onmessage = (event: MessageEvent) => {
      receivedBinary = event.data;
    };
    
    // Wait for echo response
    await vi.waitFor(() => expect(receivedBinary).not.toBeNull());
    
    // Verify binary data round-tripped correctly
    // WebSocket binary data comes back as ArrayBuffer, not Uint8Array
    expect(receivedBinary).toBeInstanceOf(ArrayBuffer);
    const receivedArray = new Uint8Array(receivedBinary);
    expect(Array.from(receivedArray)).toEqual([1, 2, 3, 4, 5]);
    
    ws.close();
  });
  
  it('should throw when sending after close', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/send-after-close/ws') as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // Close the connection
    ws.close();
    expect(ws.readyState).toBe(2); // CLOSING
    
    // Should throw when trying to send after close
    expect(() => ws.send('too late')).toThrow('cannot send() after close() has begun');
  });
  
  it('should handle close before connection completes', () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/close-early/ws') as any;
    
    let closeCalled = false;
    ws.onclose = (event: CloseEvent) => {
      closeCalled = true;
      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
    };
    
    let closeViaListener = false;
    ws.addEventListener('close', (event: CloseEvent) => {
      closeViaListener = true;
      expect(event.wasClean).toBe(true);
      expect(event.code).toBe(1000);
      expect(event.reason).toBe('Normal Closure');
    });
    
    // Close immediately while still CONNECTING
    expect(ws.readyState).toBe(0); // CONNECTING
    ws.close();
    
    // Should transition to CLOSED
    expect(ws.readyState).toBe(3); // CLOSED
    expect(closeCalled).toBe(true);
    expect(closeViaListener).toBe(true);
  });
  
  it('should accept URL object (browser compatibility)', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const url = new URL('wss://fake-host.com/manual-routing-do/url-object-test/ws?token=abc123');
    const ws = new WebSocketClass(url) as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // Verify URL was preserved with query params
    expect(ws.url).toBe('wss://fake-host.com/manual-routing-do/url-object-test/ws?token=abc123');
    
    ws.close();
  });

  it('should handle Cloudflare auto-response pairs', async () => {
    const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));
    const ws = new WebSocketClass('wss://fake-host.com/manual-routing-do/auto-response-test/ws') as any;
    
    let wsOpened = false;
    ws.onopen = () => { wsOpened = true; };
    
    await vi.waitFor(() => expect(wsOpened).toBe(true));
    
    // Send the exact message that triggers auto-response
    // ManualRoutingDO sets: new WebSocketRequestResponsePair("auto-response ping", "auto-response pong")
    ws.send('auto-response ping');
    
    let receivedAutoResponse: string | null = null;
    ws.onmessage = (event: MessageEvent) => {
      receivedAutoResponse = event.data;
    };
    
    // Wait for auto-response
    await vi.waitFor(() => expect(receivedAutoResponse).not.toBeNull());
    
    // Verify we got the auto-response (not echoed through webSocketMessage handler)
    expect(receivedAutoResponse).toBe('auto-response pong');
    
    // Send a different message to verify normal echo still works
    ws.send('regular message');
    
    let receivedEcho: string | null = null;
    ws.onmessage = (event: MessageEvent) => {
      receivedEcho = event.data;
    };
    
    await vi.waitFor(() => expect(receivedEcho).not.toBeNull());
    expect(receivedEcho).toBe('regular message');
    
    ws.close();
  });

});

import { describe, it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, type RpcAccessible } from '../src/index';
import { getWebSocketShim } from '@lumenize/testing';

import { ExampleDO } from './test-worker-and-dos';
type ExampleDO = RpcAccessible<InstanceType<typeof ExampleDO>>;

/**
 * WebSocket Edge Case Tests
 * 
 * KEPT: These test edge cases specific to WebSocket transport that aren't covered by matrix tests.
 * Most WebSocket behavior is tested in matrix.test.ts across all configurations.
 */
describe('WebSocket RPC Integration', () => {

  // KEPT: Explicit disconnect error handling - edge case not covered by matrix
  it('should reject pending operations when explicitly disconnected', async () => {
    const client = createRpcClient<ExampleDO>({
      transport: createWebSocketTransport('example-do', 'websocket-explicit-disconnect-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    // Establish connection with a quick call
    await client.increment();

    // Start a slow operation that will be in-flight when we disconnect
    const promise = client.slowIncrement(2000); // 2 second delay
    
    // Give time for the request to be sent over the wire
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Disconnect while operation is pending (it won't complete for another 1.9s)
    client[Symbol.dispose]();
    
    // Operation should be rejected with disconnect error
    await expect(promise).rejects.toThrow('WebSocket');
  }, { timeout: 5000 }); // Increase timeout since we have a 2s delay

  // Test already-connected path (line 85) - reconnection prevention
  it('should not reconnect when already connected', async () => {
    const client = createRpcClient<ExampleDO>({
      transport: createWebSocketTransport('example-do', 'websocket-already-connected-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
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
      client[Symbol.dispose]();
    }
  });

  // Test concurrent connection attempts (line 90) - connection promise reuse
  it('should handle concurrent operations before first connection', async () => {
    const client = createRpcClient<ExampleDO>({
      transport: createWebSocketTransport('example-do', 'websocket-concurrent-connect-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
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
      
      // Now fire another operation after connection is established
      // This should hit the "already connected" early return (line 124)
      const result4 = await client.increment();
      expect(result4).toBeGreaterThan(0);
    } finally {
      client[Symbol.dispose]();
    }
  });

  // Test auto-reconnect after disconnect (line 271)
  it('should auto-reconnect after explicit disconnect', async () => {
    const client = createRpcClient<ExampleDO>({
      transport: createWebSocketTransport('example-do', 'websocket-auto-reconnect-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    try {
      // First call connects and increments
      const count1 = await client.increment();
      expect(count1).toBeGreaterThan(0);
      
      // Explicitly disconnect
      client[Symbol.dispose]();
      
      // Next call should auto-reconnect (tests line 271)
      const count2 = await client.increment();
      expect(count2).toBeGreaterThan(count1);
    } finally {
      // Clean up in case last call succeeded
      try {
        client[Symbol.dispose]();
      } catch {
        // May already be disposed
      }
    }
  });

  // Test close handler with pending operations (lines 176-189)
  it('should reject all pending operations when WebSocket closes', async () => {
    const client = createRpcClient<ExampleDO>({
      transport: createWebSocketTransport('example-do', 'websocket-close-pending-test', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      })
    });

    try {
      // Establish connection with a quick call
      await client.increment();

      // Start slow operations that will be pending when we close
      const promise1 = client.slowIncrement(2000); // 2 second delay
      const promise2 = client.slowIncrement(2000); // Another slow one
      
      // Give time for requests to be sent over the wire
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Close while operations are pending (they won't complete for another 1.9s)
      client[Symbol.dispose]();
      
      // Both operations should be rejected
      await expect(promise1).rejects.toThrow('WebSocket');
      await expect(promise2).rejects.toThrow('WebSocket');
    } finally {
      // Already disposed
    }
  }, { timeout: 5000 }); // Increase timeout since we have 2s delays

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
        transport: createWebSocketTransport('manual-routing-do', instanceId, {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          WebSocketClass,
        })
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
      client[Symbol.dispose]();
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

  // KEPT: Stress test to verify no resource accumulation over many lifecycles
  it('should handle many sequential client lifecycles without leaking resources', async () => {
    // Create and dispose 100 clients sequentially
    // If cleanup is broken (event handlers not removed, connections not closed, etc.),
    // this will eventually fail or cause observable issues
    const MAX = 100
    let i;
    for (i = 0; i < MAX; i++) {
      const client = createRpcClient<ExampleDO>({
        transport: createWebSocketTransport('example-do', `stress-test-${i}`, {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        })
      });
      
      // Make a call to establish connection and wait for result
      const result = await client.increment();
      
      // Verify the operation completed successfully
      // Each client starts with fresh state (count = 0), so first increment returns 1
      expect(result).toBe(1);
      
      // Explicitly cleanup
      client[Symbol.dispose]();
    }
    expect(i).toBe(MAX)
    
    // Success if we complete all cycles without errors
    // This gives us some evidence that:
    // - WebSocket connections are properly closed
    // - Event listeners are removed
    // - Pending operations Map is cleared
    // - No resource accumulation
  }, { timeout: 50000 });

});

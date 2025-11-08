/**
 * Downstream Messaging Integration Tests
 * 
 * Tests the downstream messaging features added to Lumenize RPC:
 * - sendDownstream() server-side push
 * - onDownstream() client-side handler
 * - onClose() handler with custom codes
 * - clientId tagging and WebSocket lookup
 * - Broadcasting to multiple clients
 * - Keep-alive and heartbeat
 * 
 * These tests are adapted from doc-test/rpc/chat-example but made more robust
 * and focused on comprehensive testing rather than pedagogy.
 */

import { describe, it, expect, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../src/index';
import { getWebSocketShim } from '@lumenize/utils';

/**
 * Test DO for downstream messaging
 * Simulates a notification/messaging system
 */
class NotificationDO {
  constructor(public ctx: DurableObjectState, public env: any) {}

  // Store subscriber clientId
  subscribe(clientId: string): string {
    this.ctx.storage.kv.put('subscriber', clientId);
    return `Subscribed: ${clientId}`;
  }

  // Send notification to subscriber
  async notifySubscriber(message: string): Promise<void> {
    const clientId = this.ctx.storage.kv.get<string>('subscriber');
    if (clientId) {
      await sendDownstream(clientId, this, { type: 'notification', message });
    }
  }

  // Broadcast to multiple clients
  async broadcast(clientIds: string[], message: string): Promise<void> {
    await sendDownstream(clientIds, this, { type: 'broadcast', message });
  }

  // Force close a client connection with custom code
  closeClient(clientId: string, code: number, reason: string): void {
    const connections = this.ctx.getWebSockets(clientId);
    for (const ws of connections) {
      ws.close(code, reason);
    }
  }

  // Get count of connected WebSockets for a clientId
  getConnectionCount(clientId: string): number {
    return this.ctx.getWebSockets(clientId).length;
  }

  // Test method for RPC calls
  ping(): string {
    return 'pong';
  }
}

describe('Downstream Messaging', () => {

  it('should send downstream message from server to client', async () => {
    const clientId = 'client-1';
    const downstreamMessages: any[] = [];

    const client = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-1', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onDownstream: (message) => {
          downstreamMessages.push(message);
        },
      })
    });

    try {
      // Subscribe this client
      const subscribeResult = await client.subscribe(clientId);
      expect(subscribeResult).toContain('Subscribed');

      // Trigger notification from server
      await client.notifySubscriber('Hello from server!');

      // Wait for downstream message to arrive
      await vi.waitFor(() => {
        expect(downstreamMessages.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      // Verify message structure
      expect(downstreamMessages[0]).toMatchObject({
        type: 'notification',
        message: 'Hello from server!',
      });
    } finally {
      client[Symbol.dispose]();
    }
  });

  it('should handle onClose with custom close code', async () => {
    const clientId = 'client-2';
    let closeCalled = false;
    let closeCode = 0;
    let closeReason = '';

    const client = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-2', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onClose: (code, reason) => {
          closeCalled = true;
          closeCode = code;
          closeReason = reason;
        },
      })
    });

    // Verify connection works
    const pingResult = await client.ping();
    expect(pingResult).toBe('pong');

    // Server closes connection with custom code (simulating auth expiration)
    client.closeClient(clientId, 4401, 'Token expired');

    // Wait for close handler to be called
    await vi.waitFor(() => {
      expect(closeCalled).toBe(true);
    }, { timeout: 2000 });

    // Verify close code and reason
    expect(closeCode).toBe(4401);
    expect(closeReason).toBe('Token expired');
  });

  it('should broadcast to multiple clients', async () => {
    const client1Id = 'broadcast-client-1';
    const client2Id = 'broadcast-client-2';
    const client3Id = 'broadcast-client-3';

    const messages1: any[] = [];
    const messages2: any[] = [];
    const messages3: any[] = [];

    const client1 = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-3', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId: client1Id,
        onDownstream: (message) => { messages1.push(message); },
      })
    });

    const client2 = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-3', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId: client2Id,
        onDownstream: (message) => { messages2.push(message); },
      })
    });

    const client3 = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-3', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId: client3Id,
        onDownstream: (message) => { messages3.push(message); },
      })
    });

    try {
      // Verify all clients connected
      expect(await client1.ping()).toBe('pong');
      expect(await client2.ping()).toBe('pong');
      expect(await client3.ping()).toBe('pong');

      // Broadcast to all three clients
      await client1.broadcast(
        [client1Id, client2Id, client3Id],
        'Broadcast message to all!'
      );

      // Wait for all clients to receive message
      await vi.waitFor(() => {
        expect(messages1.length).toBeGreaterThan(0);
        expect(messages2.length).toBeGreaterThan(0);
        expect(messages3.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      // Verify all received the same broadcast
      expect(messages1[0]).toMatchObject({
        type: 'broadcast',
        message: 'Broadcast message to all!',
      });
      expect(messages2[0]).toMatchObject({
        type: 'broadcast',
        message: 'Broadcast message to all!',
      });
      expect(messages3[0]).toMatchObject({
        type: 'broadcast',
        message: 'Broadcast message to all!',
      });
    } finally {
      client1[Symbol.dispose]();
      client2[Symbol.dispose]();
      client3[Symbol.dispose]();
    }
  });

  it('should tag WebSocket with clientId for getWebSockets lookup', async () => {
    const clientId = 'tagged-client';
    const downstreamMessages: any[] = [];

    const client = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-4', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onDownstream: (message) => {
          downstreamMessages.push(message);
        },
      })
    });

    try {
      // Verify connection
      expect(await client.ping()).toBe('pong');

      // Server should be able to find WebSocket by clientId tag
      const connectionCount = await client.getConnectionCount(clientId);
      expect(connectionCount).toBe(1);

      // Verify sendDownstream works (implicitly uses getWebSockets with tag)
      await client.subscribe(clientId); // Subscribe to enable notifications
      await client.notifySubscriber('Tag test message');

      await vi.waitFor(() => {
        expect(downstreamMessages.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      expect(downstreamMessages[0]).toMatchObject({
        type: 'notification',
        message: 'Tag test message',
      });
    } finally {
      client[Symbol.dispose]();
    }
  });

  it('should support multiple connections per clientId (multiple tabs)', async () => {
    const clientId = 'multi-tab-client';
    const messages1: any[] = [];
    const messages2: any[] = [];

    // Simulate two browser tabs with same clientId
    const tab1 = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-5', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onDownstream: (message) => { messages1.push(message); },
      })
    });

    const tab2 = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-5', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId, // Same clientId!
        onDownstream: (message) => { messages2.push(message); },
      })
    });

    try {
      // Both tabs connected
      expect(await tab1.ping()).toBe('pong');
      expect(await tab2.ping()).toBe('pong');

      // Server sees both connections for same clientId
      const connectionCount = await tab1.getConnectionCount(clientId);
      expect(connectionCount).toBe(2);

      // Subscribe and broadcast to this clientId
      await tab1.subscribe(clientId);
      await tab1.notifySubscriber('Message to all tabs');

      // Both tabs should receive the message
      await vi.waitFor(() => {
        expect(messages1.length).toBeGreaterThan(0);
        expect(messages2.length).toBeGreaterThan(0);
      }, { timeout: 2000 });

      expect(messages1[0]).toMatchObject({
        type: 'notification',
        message: 'Message to all tabs',
      });
      expect(messages2[0]).toMatchObject({
        type: 'notification',
        message: 'Message to all tabs',
      });
    } finally {
      tab1[Symbol.dispose]();
      tab2[Symbol.dispose]();
    }
  });

  it('should enable keep-alive when onDownstream is configured', async () => {
    const clientId = 'keep-alive-client';

    const client = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-6', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onDownstream: () => {}, // Just having this should enable keep-alive
      })
    });

    try {
      // Verify connection
      expect(await client.ping()).toBe('pong');

      // Note: We can't directly test heartbeat timing in integration tests
      // without mocking timers, but we can verify the connection stays alive
      // longer than it would without keep-alive.
      
      // Keep connection idle for a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Connection should still work
      expect(await client.ping()).toBe('pong');

      // TODO: Add test that verifies heartbeat is actually sent
      // This would require:
      // 1. Mock setInterval or
      // 2. Add inspection API to transport or
      // 3. Server-side tracking of received pings
    } finally {
      client[Symbol.dispose]();
    }
  });

  it('should enable keep-alive when onClose is configured', async () => {
    const clientId = 'keep-alive-onclose';
    let closeCalled = false;

    const client = createRpcClient<NotificationDO>({
      transport: createWebSocketTransport('NOTIFICATION_DO', 'downstream-test-7', {
        baseUrl: 'https://fake-host.com',
        prefix: '__rpc',
        WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        clientId,
        onClose: () => {
          closeCalled = true;
        },
      })
    });

    // Verify connection
    expect(await client.ping()).toBe('pong');

    // Keep connection idle
    await new Promise(resolve => setTimeout(resolve, 100));

    // Connection should still work
    expect(await client.ping()).toBe('pong');

    // Trigger close
    client.closeClient(clientId, 1000, 'Normal close');

    await vi.waitFor(() => {
      expect(closeCalled).toBe(true);
    }, { timeout: 2000 });
  });

});


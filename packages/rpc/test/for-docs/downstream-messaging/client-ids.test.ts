import { it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../../../src';
import { getWebSocketShim } from '@lumenize/utils';
import type { BroadcastDO as BroadcastDOType } from '../../test-worker-and-dos';

class BroadcastDO {
  constructor(public ctx: DurableObjectState, public env: any) {}

  async broadcastToAll(message: any) {
    // Without clientId - can't target specific clients
    const connections = this.ctx.getWebSockets();
    const clientIds = [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
    await sendDownstream(clientIds, this, message); // Broadcasts to ALL
  }

  async sendToSpecificClient(clientId: string, message: any) {
    // With clientId - can target individuals
    await sendDownstream(clientId, this, message);
  }
}

it('demonstrates client ID targeting', async () => {
  const client1Messages: any[] = [];
  const client2Messages: any[] = [];

  using client1 = createRpcClient<typeof BroadcastDOType>({
    transport: createWebSocketTransport('BROADCAST_DO', 'room-1', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'user-123',
      onDownstream: (msg) => { client1Messages.push(msg); }
    })
  });

  using client2 = createRpcClient<typeof BroadcastDOType>({
    transport: createWebSocketTransport('BROADCAST_DO', 'room-1', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'user-456',
      onDownstream: (msg) => { client2Messages.push(msg); }
    })
  });

  // Ensure both clients are connected
  const count1 = await client1.getConnectionCount('user-123');
  const count2 = await client2.getConnectionCount('user-456');
  expect(count1).toBeGreaterThan(0);
  expect(count2).toBeGreaterThan(0);

  // Broadcast to all
  await client1.broadcastToAll({ type: 'broadcast', content: 'Hello everyone' });

  // Wait for both clients to receive
  await vi.waitFor(() => {
    expect(client1Messages.length).toBe(1);
    expect(client2Messages.length).toBe(1);
  }, { timeout: 5000 });

  // Send to specific client
  await client1.sendToSpecificClient('user-123', { type: 'private', content: 'Just for you' });

  // Wait for targeted message
  await vi.waitFor(() => {
    expect(client1Messages.length).toBe(2);
  }, { timeout: 5000 });

  // Client 2 should not have received the targeted message
  expect(client2Messages.length).toBe(1);
  expect(client1Messages[1]).toMatchObject({ type: 'private', content: 'Just for you' });
}, { timeout: 15000 });


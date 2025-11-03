import { it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../../../src';
import { getWebSocketShim } from '@lumenize/utils';
import type { NotificationHub as NotificationHubType } from '../../test-worker-and-dos';

// Durable Object - Notification Hub
class NotificationHub {
  constructor(public ctx: DurableObjectState, public env: any) {}

  async onUserAction(userId: string, action: string) {
    // Notify all connected clients when something happens
    const connections = this.ctx.getWebSockets();
    const clientIds = [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
    
    await sendDownstream(clientIds, this, {
      userId,
      action,
      timestamp: Date.now()
    });
  }
}

it('demonstrates real-time notifications', async () => {
  const notifications: any[] = [];

  // Client - Subscribe to notifications
  using client = createRpcClient<NotificationHubType>({
    transport: createWebSocketTransport('NOTIFICATIONS', 'global', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'subscriber-1',
      onDownstream: (notification) => {
        notifications.push(notification);
      }
    })
  });

  // Trigger a user action
  await client.onUserAction('alice', 'posted_comment');

  // Wait for notification
  await vi.waitFor(() => {
    expect(notifications.length).toBe(1);
  }, { timeout: 2000 });

  expect(notifications[0]).toMatchObject({
    userId: 'alice',
    action: 'posted_comment'
  });
  expect(notifications[0].timestamp).toBeTypeOf('number');
});


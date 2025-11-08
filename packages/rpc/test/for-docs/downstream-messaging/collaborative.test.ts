import { it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../../../src';
import { getWebSocketShim } from '@lumenize/utils';
import type { DocumentDO as DocumentDOType } from '../../test-worker-and-dos';

// Durable Object - Collaborative Document
class DocumentDO {
  constructor(public ctx: DurableObjectState, public env: any) {}

  getConnectedClients(): string[] {
    const connections = this.ctx.getWebSockets();
    return [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
  }

  async updateContent(clientId: string, changes: any) {
    // Apply changes locally
    await this.applyChanges(changes);
    
    // Broadcast to all OTHER clients (exclude sender)
    const otherClients = this.getConnectedClients().filter(id => id !== clientId);
    for (const otherId of otherClients) {
      await sendDownstream(otherId, this, { changes });
    }
  }

  private async applyChanges(changes: any) {
    // Simulate applying changes to document
    this.ctx.storage.kv.put('lastChange', changes);
  }
}

it('demonstrates multiplayer collaborative features', async () => {
  const client1Updates: any[] = [];
  const client2Updates: any[] = [];

  // Client 1
  using client1 = createRpcClient<typeof DocumentDOType>({
    transport: createWebSocketTransport('DOCUMENT_DO', 'doc-123', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'user-1',
      onDownstream: (update) => {
        client1Updates.push(update);
      }
    })
  });

  // Client 2
  using client2 = createRpcClient<typeof DocumentDOType>({
    transport: createWebSocketTransport('DOCUMENT_DO', 'doc-123', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'user-2',
      onDownstream: (update) => {
        client2Updates.push(update);
      }
    })
  });

  // Ensure both clients are connected
  const count1 = await client1.getConnectionCount('user-1');
  const count2 = await client2.getConnectionCount('user-2');
  expect(count1).toBeGreaterThan(0);
  expect(count2).toBeGreaterThan(0);

  // Client 1 makes a change
  await client1.updateContent('user-1', { text: 'Hello', position: 0 });

  // Client 2 should receive the update, but Client 1 should not
  await vi.waitFor(() => {
    expect(client2Updates.length).toBe(1);
  }, { timeout: 5000 });

  expect(client2Updates[0]).toMatchObject({
    changes: { text: 'Hello', position: 0 }
  });
  expect(client1Updates.length).toBe(0); // Sender doesn't receive their own update
}, { timeout: 10000 });


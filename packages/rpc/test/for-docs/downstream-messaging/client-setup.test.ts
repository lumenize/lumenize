import { it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport } from '../../../src';
import { getWebSocketShim } from '@lumenize/utils';
import { MyDO } from './MyDO';

it('demonstrates client setup with onDownstream and onClose', async () => {
  const messages: any[] = [];
  const closes: Array<{ code: number; reason: string }> = [];

  using client = createRpcClient<typeof MyDO>({
    transport: createWebSocketTransport('MY_DO', 'instance-1', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'user-123', // Optional: identify this client
      onDownstream: (message) => {
        messages.push(message);
        // Handle real-time updates from the DO
      },
      onClose: (code, reason) => {
        closes.push({ code, reason });
        // Handle disconnection
      },
    }),
  });

  // Trigger a downstream message
  await client.sendUpdate('Hello from server!');

  // Wait for downstream message
  await vi.waitFor(() => {
    expect(messages.length).toBeGreaterThan(0);
  }, { timeout: 2000 });

  expect(messages[0]).toMatchObject({
    message: 'Hello from server!'
  });
});


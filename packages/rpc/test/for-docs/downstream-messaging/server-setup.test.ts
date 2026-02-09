import { it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../../../src';
import { getWebSocketShim } from '@lumenize/testing';
import type { MyDO as MyDOType } from '../../test-worker-and-dos';

// Documentation: This is the server-side DO class structure
export class MyDO {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async processLongTask() {
    // Send progress updates to all connected clients
    const connections = this.ctx.getWebSockets();
    const clientIds = [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
    if (clientIds.length > 0) {
      await sendDownstream(clientIds, this, { type: 'progress', percent: 25 });
    }
    
    // ... do some work ...
    
    if (clientIds.length > 0) {
      await sendDownstream(clientIds, this, { type: 'progress', percent: 50 });
    }
    
    // ... more work ...
    
    if (clientIds.length > 0) {
      await sendDownstream(clientIds, this, { type: 'progress', percent: 100 });
    }
    
    return { status: 'complete' };
  }

  async notifyClient(clientId: string, message: any) {
    // Send to a specific client
    await sendDownstream(clientId, this, message);
  }
}

it('demonstrates server DO setup with sendDownstream', async () => {
  const messages: any[] = [];

  using client = createRpcClient<typeof MyDOType>({
    transport: createWebSocketTransport('MY_DO', 'server-setup-test', {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'client-1',
      onDownstream: (message) => {
        messages.push(message);
      },
    }),
  });

  // Trigger the long task
  const result = await client.processLongTask();
  expect(result.status).toBe('complete');

  // Should have received 3 progress updates
  await vi.waitFor(() => {
    expect(messages.length).toBe(3);
  }, { timeout: 2000 });
  
  expect(messages[0]).toMatchObject({ type: 'progress', percent: 25 });
  expect(messages[1]).toMatchObject({ type: 'progress', percent: 50 });
  expect(messages[2]).toMatchObject({ type: 'progress', percent: 100 });
});


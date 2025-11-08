import { it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, sendDownstream } from '../../../src';
import { getWebSocketShim } from '@lumenize/utils';
import type { VideoDO as VideoDOType } from '../../test-worker-and-dos';

// Durable Object
class VideoDO {
  constructor(public ctx: DurableObjectState, public env: any) {}

  async processVideo(videoId: string) {
    const connections = this.ctx.getWebSockets();
    const clientIds = [...new Set(connections.flatMap(ws => this.ctx.getTags(ws)))];
    
    await sendDownstream(clientIds, this, { stage: 'uploading', progress: 0 });
    
    await this.uploadToStorage(videoId);
    await sendDownstream(clientIds, this, { stage: 'encoding', progress: 30 });
    
    await this.encodeVideo(videoId);
    await sendDownstream(clientIds, this, { stage: 'thumbnails', progress: 70 });
    
    await this.generateThumbnails(videoId);
    await sendDownstream(clientIds, this, { stage: 'complete', progress: 100 });
    
    return { success: true };
  }

  private async uploadToStorage(videoId: string) {
    // Simulate upload
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  private async encodeVideo(videoId: string) {
    // Simulate encoding
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  private async generateThumbnails(videoId: string) {
    // Simulate thumbnail generation
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it('demonstrates progress updates during video processing', async () => {
  const videoId = 'test-video-123';
  const updates: any[] = [];

  // Client
  using client = createRpcClient<typeof VideoDOType>({
    transport: createWebSocketTransport('VIDEO_DO', videoId, {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
      clientId: 'viewer-1',
      onDownstream: (update) => {
        updates.push(update);
      }
    })
  });

  await client.processVideo(videoId);

  // Verify all progress updates were received
  await vi.waitFor(() => {
    expect(updates.length).toBe(4);
  }, { timeout: 2000 });

  expect(updates[0]).toMatchObject({ stage: 'uploading', progress: 0 });
  expect(updates[1]).toMatchObject({ stage: 'encoding', progress: 30 });
  expect(updates[2]).toMatchObject({ stage: 'thumbnails', progress: 70 });
  expect(updates[3]).toMatchObject({ stage: 'complete', progress: 100 });
});


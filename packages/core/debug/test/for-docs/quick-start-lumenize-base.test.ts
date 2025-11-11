/**
 * Documentation example: Quick Start - In Durable Objects (LumenizeBase)
 * Tests the example from website/docs/core/debug.mdx
 */

import '@lumenize/core';  // Registers in this.svc
import { LumenizeBase } from '@lumenize/lumenize-base';
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

export class ChatRoom extends LumenizeBase<Env> {
  fetch(request: Request) {
    return this.onRequest(request);
  }
  
  onRequest(request: Request) {
    const log = this.svc.debug('ChatRoom.onRequest');
    
    log.debug('Processing request', { 
      method: request.method,
      url: request.url,
    });
    
    // Handle the request
    const messages = this.ctx.storage.kv.get('messages') || [];
    const response = new Response(JSON.stringify(messages));
    
    log.info('Request completed', { 
      messageCount: messages.length
    });
    
    return response;
  }
}

describe('Quick Start - LumenizeBase', () => {
  it('demonstrates debug logging in LumenizeBase', async () => {
    const id = env.CHAT_ROOM.idFromName('test-room');
    const stub = env.CHAT_ROOM.get(id);
    
    // Call the onRequest method
    const response = await stub.fetch('http://example.com/test');
    
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });
});


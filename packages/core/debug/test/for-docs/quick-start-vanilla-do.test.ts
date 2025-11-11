/**
 * Documentation example: Quick Start - In Vanilla Durable Objects
 * Tests the example from website/docs/core/debug.mdx
 */

import { debug } from '@lumenize/core';
import { DurableObject } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

export class MyDO extends DurableObject {
  #log = debug(this)('MyDO');
  
  async fetch(request: Request) {
    this.#log.debug('Processing request', { url: request.url });
    return new Response('OK');
  }
}

describe('Quick Start - Vanilla DO', () => {
  it('demonstrates debug logging in vanilla DOs', async () => {
    const id = env.MY_DO.idFromName('test-instance');
    const stub = env.MY_DO.get(id);
    
    const response = await stub.fetch('http://example.com/test');
    
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toBe('OK');
  });
});


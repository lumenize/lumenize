/**
 * Documentation example: Quick Start - In Workers (outside DOs)
 * Tests the example from website/docs/core/debug.mdx
 */

import { debug } from '@lumenize/core';
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

export default {
  async fetch(request: Request, env: Env) {
    const log = debug({ env })('Worker.router');
    
    log.debug('Routing request', { 
      pathname: new URL(request.url).pathname 
    });
    
    // Route to DO...
    return new Response('Routed successfully');
  }
};

describe('Quick Start - Worker', () => {
  it('demonstrates debug logging in Workers', async () => {
    const worker = (await import('./quick-start-worker.test')).default;
    
    const request = new Request('http://example.com/test');
    const response = await worker.fetch(request, env);
    
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toBe('Routed successfully');
  });
});


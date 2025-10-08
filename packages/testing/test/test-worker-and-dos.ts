import { lumenizeRpcDo } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';

/**
 * Simple test Durable Object for validating createTestingClient
 */
export class TestDO {
  ctx: DurableObjectState;
  env: Env;
  
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /**
   * Increment a counter in storage
   */
  async increment(): Promise<number> {
    const count = (await this.ctx.storage.get<number>('count')) ?? 0;
    const newCount = count + 1;
    await this.ctx.storage.put('count', newCount);
    return newCount;
  }

  /**
   * Get current count
   */
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  /**
   * Reset count to zero
   */
  async reset(): Promise<void> {
    await this.ctx.storage.put('count', 0);
  }

  /**
   * Fetch handler for HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.endsWith('/increment')) {
      const count = await this.increment();
      return new Response(count.toString());
    }
    
    if (url.pathname.endsWith('/count')) {
      const count = await this.getCount();
      return new Response(count.toString());
    }
    
    return new Response('Not found', { status: 404 });
  }
}

// Wrap with lumenizeRpcDo for RPC support
export const TestDOWithRpc = lumenizeRpcDo(TestDO);

/**
 * Test worker - routes RPC requests to DOs
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routeDORequest(request, env, { prefix: '__rpc' });
    return response ?? new Response('Not found', { status: 404 });
  }
};

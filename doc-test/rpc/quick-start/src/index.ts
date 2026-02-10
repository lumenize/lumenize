import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/routing';
import { DurableObject } from 'cloudflare:workers';

class _Counter extends DurableObject {
  instanceVariable = 'my instance variable';

  increment(by: number = 1) {
    let count: number = this.ctx.storage.kv.get('count') ?? 0;
    count += by;
    this.ctx.storage.kv.put('count', count);
    return count;
  }

  echo(value: any) {
    return value;
  }
}

// Wrap with RPC support
export const Counter = lumenizeRpcDO(_Counter);

// Export a default worker to route RPC requests
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route RPC requests to the Durable Object. Works for https:// or wss://
    // See: https://lumenize.com/docs/utils/route-do-request
    const response = await routeDORequest(request, env, { prefix: '__rpc' });
    if (response) return response;
    
    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};

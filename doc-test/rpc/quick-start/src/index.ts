import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';

class _Counter extends DurableObject {
  increment() {
    let count: number = this.ctx.storage.kv.get('count') ?? 0;
    count++;
    this.ctx.storage.kv.put('count', count);
    return count;
  }
}

// Wrap with RPC support
export const Counter = lumenizeRpcDO(_Counter);

// Export a default worker to route RPC requests
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route RPC requests to the Durable Object. Works for https:// or wss://
    // See: https://lumenize.com/docs/utils/route-do-request
    const rpcResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (rpcResponse) return rpcResponse;
    
    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};

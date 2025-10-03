import { lumenizeRpcDo } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';

class _Counter extends DurableObject {
  increment() {
    const count = this.ctx.storage.kv.get('count') + 1 || 1;
    this.ctx.storage.kv.put('count', count);
    return count;
  }
}

// Wrap with RPC support
export const Counter = lumenizeRpcDo(_Counter);

// Export a default worker to route RPC requests
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route RPC requests to the Durable Object. Works for https:// or wss://
    // See: https://lumenize.com/docs/utilities/route-do-request
    const rpcResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (rpcResponse) return rpcResponse;
    
    // Fallback for non-RPC requests
    return new Response('Not Found', { status: 404 });
  },
};
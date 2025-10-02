import { lumenizeRpcDo } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';

class Counter extends DurableObject {
  count = 0;
  
  increment() {
    this.count++;
    return this.count;
  }
  
  getValue() {
    return this.count;
  }
}

// Wrap with RPC support
export const CounterDO = lumenizeRpcDo(Counter);

// Export a default worker to route RPC requests
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    // Route RPC requests to the Durable Object
    const rpcResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (rpcResponse) return rpcResponse;
    
    // Fallback for non-RPC requests
    return new Response('Counter DO Worker');
  },
};
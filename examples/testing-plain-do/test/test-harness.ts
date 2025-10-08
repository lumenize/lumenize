import { MyDO as Original_MyDO, default as original_worker } from '../src';
import { lumenizeRpcDo } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';

// Wrap the DO with lumenizeRpcDo to enable RPC functionality
const MyDO = lumenizeRpcDo(Original_MyDO);

// Create a worker that routes RPC requests and falls back to original worker
const worker = {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    // Try to route RPC requests first
    const rpcResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (rpcResponse) return rpcResponse;

    // Fall back to original worker handler
    return original_worker.fetch(request as any, env, ctx);
  }
};

export { MyDO };
export default worker;

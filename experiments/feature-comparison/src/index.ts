import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { newWorkersRpcResponse } from 'capnweb';

// ============================================================================
// Lumenize RPC
// ============================================================================

class _LumenizeDO extends DurableObject {
  increment(): number {
    let count = (this.ctx.storage.kv.get<number>("count")) ?? 0;
    this.ctx.storage.kv.put("count", ++count);
    return count;
  }
}

export const LumenizeDO = lumenizeRpcDO(_LumenizeDO);

// ============================================================================
// Cap'n Web - More boilerplate
// ============================================================================

// Per Cap'n Web docs: "Classes which are intended to be passed by reference 
// and called over RPC must extend RpcTarget"
export class CapnWebRpcTarget extends RpcTarget {
  // RpcTarget requires us to manually capture ctx/env in constructor
  constructor(
    public ctx: DurableObjectState,
    public env: any
  ) {
    super();
  }
  
  increment(): number {
    let count = (this.ctx.storage.kv.get<number>("count")) ?? 0;
    this.ctx.storage.kv.put("count", ++count);
    return count;
  }
  
  fetch(request: Request): Response | Promise<Response> {
    return newWorkersRpcResponse(request, this);
  }
}

// ============================================================================
// Worker - Route requests to appropriate DO
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const lumenizeResponse = await routeDORequest(request, env, { prefix: '__rpc' });
    if (lumenizeResponse) return lumenizeResponse;
    
    const capnwebResponse = await routeDORequest(request, env, { prefix: 'capnweb' });
    if (capnwebResponse) return capnwebResponse;

    // Fallback for non-RPC requests
    return new Response('Not found', { status: 404 });
  },
};

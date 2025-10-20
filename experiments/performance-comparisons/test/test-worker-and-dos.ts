import { DurableObject } from 'cloudflare:workers';
import { lumenizeRpcDO, handleRpcRequest } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';
import { CounterImpl, type Counter } from '../src/index.js';
// import '@transformation-dev/debug'; // TEMPORARILY DISABLED to see performance timings

// Lumenize RPC implementation - uses lumenizeRpcDO wrapper
class _CounterLumenize extends DurableObject implements Counter {
  #impl: CounterImpl;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#impl = new CounterImpl(ctx.storage);
  }

  increment(amount: number): number {
    return this.#impl.increment(amount);
  }

  getValue(): number {
    return this.#impl.getValue();
  }

  reset(): void {
    this.#impl.reset();
  }
}

export const CounterLumenize = lumenizeRpcDO(_CounterLumenize);

// Cap'n Web implementation - extends RpcTarget
export class CounterCapnWeb extends RpcTarget implements Counter {
  #impl: CounterImpl;

  constructor(private ctx: DurableObjectState, private env: Env) {
    super();
    this.#impl = new CounterImpl(ctx.storage);
  }

  increment(amount: number): number {
    return this.#impl.increment(amount);
  }

  getValue(): number {
    return this.#impl.getValue();
  }

  reset(): void {
    this.#impl.reset();
  }

  fetch(request: Request): Response | Promise<Response> {
    return newWorkersRpcResponse(request, this);
  }
}

interface Env {
  COUNTER_LUMENIZE: DurableObjectNamespace;
  COUNTER_CAPNWEB: DurableObjectNamespace;
}

// ============================================================================
// MANUAL ROUTING CONFIGURATION
// Match the configuration in performance.test.ts
// ============================================================================

const ROUTING_CONFIG = {
  // 🔴 ENABLE ONE AT A TIME (match TEST_CONFIG in performance.test.ts):
  LUMENIZE_WITH_ROUTE_DO_REQUEST: false,   // Config 1: Use routeDORequest helper
  LUMENIZE_WITH_MANUAL_ROUTING: false,     // Config 2: Use manual regex routing
  CAPNWEB_WITH_MANUAL_ROUTING: true,       // Config 3: Use Cap'n Web manual routing
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Configuration 1: Lumenize with routeDORequest helper
    if (ROUTING_CONFIG.LUMENIZE_WITH_ROUTE_DO_REQUEST) {
      const lumenizeResponse = await routeDORequest(request, env, { prefix: '/__rpc' });
      if (lumenizeResponse) return lumenizeResponse;
    }
    
    // Configuration 2: Lumenize with manual routing (same URL pattern as Config 1)
    if (ROUTING_CONFIG.LUMENIZE_WITH_MANUAL_ROUTING) {
      // Manual regex: /__rpc/COUNTER_LUMENIZE/{id}/call
      const lumenizeManualMatch = url.pathname.match(/^\/__rpc\/COUNTER_LUMENIZE\/([^\/]+)\/call$/);
      if (lumenizeManualMatch) {
        const [, instanceId] = lumenizeManualMatch;
        const stub = env.COUNTER_LUMENIZE.getByName(instanceId);
        return stub.fetch(request);
      }
    }
    
    // Configuration 3: Cap'n Web with simple manual routing
    if (ROUTING_CONFIG.CAPNWEB_WITH_MANUAL_ROUTING) {
      // Pattern: /COUNTER_CAPNWEB/{id}
      const capnMatch = url.pathname.match(/^\/COUNTER_CAPNWEB\/([^\/]+)$/);
      if (capnMatch) {
        const [, instanceId] = capnMatch;
        const stub = env.COUNTER_CAPNWEB.getByName(instanceId);
        return stub.fetch(request);
      }
    }
    
    return new Response('Performance comparison test worker\nNo routing configuration enabled!');
  },
};

import { DurableObject } from 'cloudflare:workers';
import { lumenizeRpcDO, handleRpcRequest } from '@lumenize/rpc';
import { CounterImpl, type Counter } from '../src/index.js';

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

// TODO: Cap'n Web implementation - requires installing @cloudflare/jsrpc package
// export class CounterCapnWeb extends RpcTarget implements Counter {
//   #impl: CounterImpl;
//   #ctx: DurableObjectState;
//
//   constructor(ctx: DurableObjectState, env: Env) {
//     super();
//     this.#ctx = ctx;
//     this.#impl = new CounterImpl(ctx.storage);
//   }
//
//   async increment(amount: number): Promise<number> {
//     return this.#impl.increment(amount);
//   }
//
//   async getValue(): Promise<number> {
//     return this.#impl.getValue();
//   }
//
//   async reset(): Promise<void> {
//     return this.#impl.reset();
//   }
//
//   fetch(request: Request): Response | Promise<Response> {
//     return newWorkersRpcResponse(request, this);
//   }
// }

// Stub for now until we install capnweb
export class CounterCapnWeb extends DurableObject implements Counter {
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

  fetch(request: Request): Response {
    return new Response('Cap\'n Web not yet implemented');
  }
}

interface Env {
  COUNTER_LUMENIZE: DurableObjectNamespace;
  COUNTER_CAPNWEB: DurableObjectNamespace;
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    
    // Route RPC requests to the appropriate DO
    // Expected pattern: /__rpc/{BINDING_NAME}/{INSTANCE_ID}/call
    const rpcMatch = url.pathname.match(/^\/__rpc\/([^\/]+)\/([^\/]+)\/call$/);
    if (rpcMatch) {
      const [, bindingName, instanceId] = rpcMatch;
      
      if (bindingName === 'COUNTER_LUMENIZE') {
        const stub = env.COUNTER_LUMENIZE.getByName(instanceId);
        return stub.fetch(request);
      }
      
      if (bindingName === 'COUNTER_CAPNWEB') {
        const stub = env.COUNTER_CAPNWEB.getByName(instanceId);
        return stub.fetch(request);
      }
    }
    
    return new Response('Performance comparison test worker');
  },
};

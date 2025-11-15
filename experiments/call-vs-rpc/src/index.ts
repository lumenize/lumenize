/**
 * Call vs RPC Experiment
 * 
 * Compares:
 * - V1: Pure Workers RPC (baseline)
 * - V2: @lumenize/call V4 (production API)
 */

import { LumenizeExperimentDO, type VariationDefinition } from '@lumenize/for-experiments';
import '@lumenize/call';  // Auto-registers call service
import type { RemoteDO } from './remote-do.js';

/**
 * OriginDO - Makes calls using different patterns
 */
export class OriginDO extends LumenizeExperimentDO<Env> {
  // Initialize DO with binding name on first WebSocket connection
  async #ensureInit(): Promise<void> {
    const storedBinding = this.ctx.storage.kv.get('__lmz_do_binding_name');
    if (storedBinding === undefined) {
      await this.__lmzInit({ doBindingName: 'ORIGIN_DO' });
    }
  }

  // Override WebSocket handler to ensure init before batch execution
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      await this.#ensureInit();
    }
    return super.fetch(request);
  }

  protected getVariations(): Map<string, VariationDefinition> {
    return new Map([
      ['v1-rpc', {
        name: 'Workers RPC',
        description: 'Baseline: Standard Cloudflare Workers RPC',
        handler: this.#runV1Rpc.bind(this)
      }],
      ['v2-call', {
        name: '@lumenize/call V4',
        description: 'Production @lumenize/call with blockConcurrencyWhile',
        handler: this.#runV2Call.bind(this) as any  // Sync API returns void
      }],
    ]);
  }

  /**
   * V1: Pure Workers RPC (baseline)
   */
  async #runV1Rpc(index: number): Promise<void> {
    const id = this.env.REMOTE_DO.idFromName('remote');
    const stub = this.env.REMOTE_DO.get(id);
    
    const result = await stub.echo(`v1-${index}`);
    
    const expected = `echo: v1-${index}`;
    if (result !== expected) {
      throw new Error(`Expected "${expected}", got "${result}"`);
    }
    
    // Write completion marker
    this.ctx.storage.kv.put(`__lmz_exp_completed_v1-rpc_${index}`, true);
  }

  /**
   * V2: @lumenize/call V4 (synchronous API with continuations)
   */
  #runV2Call(index: number): void {
    // Define remote operation
    const remoteOp = this.ctn<RemoteDO>().echo(`v2-${index}`);
    
    // Define handler continuation (must be public for continuation system)
    const handlerCtn = this.ctn().handleV2Result(remoteOp, index);
    
    // Call returns immediately! Handler executes when result arrives
    this.svc.call('REMOTE_DO', 'remote', remoteOp, handlerCtn);
  }

  /**
   * Handler for V2 results (called by @lumenize/call)
   * Must be public so continuation system can access it
   */
  handleV2Result(result: any, index: number): void {
    const expected = `echo: v2-${index}`;
    
    if (result instanceof Error) {
      throw result;
    }
    
    if (result !== expected) {
      throw new Error(`Expected "${expected}", got "${result}"`);
    }
    
    // Write completion marker
    this.ctx.storage.kv.put(`__lmz_exp_completed_v2-call_${index}`, true);
  }
}

// Export RemoteDO
export { RemoteDO } from './remote-do.js';

// Default export for worker - use static method approach
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/version') {
      return new Response(JSON.stringify({
        version: 1,
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/patterns') {
      const id = env.ORIGIN_DO.idFromName('origin');
      const stub = env.ORIGIN_DO.get(id) as any;
      
      // Call listVariations via RPC
      const patterns = await stub.__listVariations();

      return new Response(JSON.stringify({
        patterns
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/rpc/checkCompletion' && request.method === 'POST') {
      const body = await request.json() as { mode: string; index: number };
      const id = env.ORIGIN_DO.idFromName('origin');
      const stub = env.ORIGIN_DO.get(id) as any;
      
      const isComplete = await stub.__checkCompletion(body.mode, body.index);

      return new Response(JSON.stringify(isComplete), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.ORIGIN_DO.idFromName('origin');
      const stub = env.ORIGIN_DO.get(id);
      return stub.fetch(request);
    }

    return new Response('Call vs RPC Experiment - Use /patterns to discover tests', { status: 200 });
  }
};


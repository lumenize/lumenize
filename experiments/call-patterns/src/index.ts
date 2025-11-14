/**
 * Call Patterns Comparison
 * 
 * Single Worker/Controller that tests all patterns:
 * - V1: Pure Workers RPC
 * - V2: Operation chains (coming soon)
 * - V3: Fire-and-forget (coming soon)
 */

import { 
  ExperimentController,
  type VariationDefinition 
} from '@lumenize/for-experiments';
import { newContinuation, getOperationChain, executeOperationChain, replaceNestedOperationMarkers } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { RemoteDO } from './remote-do.js';

/**
 * Pattern Controller - Routes to all pattern implementations
 */
export class PatternController extends ExperimentController<Env> {
  /**
   * Register pattern variations for testing
   */
  protected getVariations(): Map<string, VariationDefinition> {
    return new Map([
      ['v1', {
        name: 'Pure Workers RPC',
        description: 'Baseline. Just `await`ed Workers RPC',
        handler: this.#runV1.bind(this)
      }],
      ['v2', {
        name: 'Continuation outbound',
        description: 'Continuation outbound. `await`ed Workers RPC',
        handler: this.#runV2.bind(this)
      }],
      ['v3', {
        name: 'Continuation both ways',
        description: 'Continuation both ways. `await`ed Workers RPC',
        handler: this.#runV3.bind(this)
      }],
      ['v4', {
        name: 'Like v3 but with blockConcurrencyWhile',
        description: 'Operation chains with result processed through continuation handler',
        handler: this.#runV4.bind(this) as any  // Sync by design (returns void, not Promise)
      }],
    ]);
  }

  async #runV1(index: number): Promise<void> {
    const id = this.env.REMOTE_DO.idFromName('remote');
    const stub = this.env.REMOTE_DO.get(id);
    const result = await stub.echo(`v1-${index}`);
    
    const expected = `echo: v1-${index}`;
    if (result !== expected) {
      throw new Error(`Expected "${expected}", got "${result}"`);
    }
    
    // Write completion marker
    this.ctx.storage.kv.put(`__lmz_exp_completed_v1_${index}`, true);
  }

  async #runV2(index: number): Promise<void> {
    const id = this.env.REMOTE_DO.idFromName('remote');
    const stub = this.env.REMOTE_DO.get(id) as any;
    
    // Build operation chain using newContinuation
    const remoteOp = newContinuation<RemoteDO>().echo(`v2-${index}`);
    const operationChain = getOperationChain(remoteOp);
    if (!operationChain) {
      throw new Error('Failed to get operation chain');
    }
    
    // Preprocess the operation chain for transmission
    const preprocessed = await preprocess(operationChain);
    
    // Send preprocessed chain via RPC and await result
    const result = await stub.__executeOperation(preprocessed);
    
    const expected = `echo: v2-${index}`;
    if (result !== expected) {
      throw new Error(`Expected "${expected}", got "${result}"`);
    }
    
    // Write completion marker
    this.ctx.storage.kv.put(`__lmz_exp_completed_v2_${index}`, true);
  }

  async #runV3(index: number): Promise<void> {
    const id = this.env.REMOTE_DO.idFromName('remote');
    const stub = this.env.REMOTE_DO.get(id) as any;
    
    // Build remote operation chain
    const remoteOp = newContinuation<RemoteDO>().echo(`v3-${index}`);
    const remoteChain = getOperationChain(remoteOp);
    if (!remoteChain) {
      throw new Error('Failed to get remote operation chain');
    }
    
    // Preprocess and send
    const preprocessed = await preprocess(remoteChain);
    const result = await stub.__executeOperation(preprocessed);
    
    // Build continuation handler chain to process the result
    const handlerCtn = newContinuation<PatternController>().handleResult(result, 'v3', index);
    const handlerChain = getOperationChain(handlerCtn);
    if (!handlerChain) {
      throw new Error('Failed to get handler chain');
    }
    
    // Execute handler continuation locally
    await executeOperationChain(handlerChain, this);
  }

  #runV4(index: number): void {
    const id = this.env.REMOTE_DO.idFromName('remote');
    const stub = this.env.REMOTE_DO.get(id) as any;
    
    // Build remote operation continuation (not executed yet)
    const remoteOp = newContinuation<RemoteDO>().echo(`v4-${index}`);
    const remoteChain = getOperationChain(remoteOp);
    if (!remoteChain) {
      throw new Error('Failed to get remote operation chain');
    }
    
    // Build handler continuation with remoteOp as placeholder
    // When remoteOp is passed as an argument, it becomes a NestedOperationMarker
    const handlerCtn = newContinuation<PatternController>().handleResult(remoteOp, 'v4', index);
    const handlerChain = getOperationChain(handlerCtn);
    if (!handlerChain) {
      throw new Error('Failed to get handler chain');
    }
    
    // Fire-and-forget with blockConcurrencyWhile (don't await)
    this.ctx.blockConcurrencyWhile(async () => {
      // Execute remote operation to get actual result
      const preprocessed = await preprocess(remoteChain);
      const result = await stub.__executeOperation(preprocessed);
      
      // Replace placeholder in handler chain with actual result
      const finalChain = replaceNestedOperationMarkers(handlerChain, result);
      
      // Execute handler continuation with real result
      await executeOperationChain(finalChain, this);
    });
  }

  /**
   * Continuation handler for V3/V4 - validates result (public for continuation access)
   * 
   * @param result - Can be a NestedOperationMarker placeholder (at definition time) 
   *                 or the actual string result (at execution time)
   * @param mode - Test mode (e.g., "v3", "v4")
   * @param index - Operation index
   */
  handleResult(result: any, mode: string, index: number): void {
    const expected = `echo: ${mode}-${index}`;
    if (result !== expected) {
      throw new Error(`Expected "${expected}", got "${result}"`);
    }
    
    // Follow experiment framework convention: write completion marker
    this.ctx.storage.kv.put(`__lmz_exp_completed_${mode}_${index}`, true);
  }
}

// Import shared RemoteDO
export { RemoteDO } from './remote-do.js';

/**
 * Worker - uses standard experiment fetch handler
 */
export default ExperimentController.createFetchHandler('CONTROLLER');

/**
 * Execute operation handler - processes incoming operation chains
 * 
 * This handler receives preprocessed operation chains from remote DOs,
 * postprocesses them, and executes them on the local DO instance.
 * 
 * Required for call() to work - remote DOs call this method to execute operations.
 */

import type { OperationChain } from '@lumenize/lumenize-base';
import { postprocess } from '@lumenize/structured-clone';

/**
 * Install the execute operation handler into LumenizeBase
 * 
 * This adds __executeOperation method to LumenizeBase.prototype.
 * Called automatically when @lumenize/call is imported.
 * 
 * @internal
 */
export function installExecuteOperationHandler() {
  const LumenizeBaseProto = (globalThis as any).__LumenizeBasePrototype;
  
  if (!LumenizeBaseProto) {
    console.error('[CALL] Cannot install __executeOperation: LumenizeBase.prototype not found!');
    return;
  }
  
  LumenizeBaseProto.__executeOperation = executeOperation;
}

/**
 * Execute an operation chain on this DO instance
 * 
 * Called by remote DOs via RPC to execute a preprocessed operation chain.
 * Postprocesses the chain and delegates to LumenizeBase's __executeChain.
 * 
 * @param doInstance - The DO instance (bound as 'this')
 * @param preprocessedChain - Preprocessed operation chain from remote DO
 * @returns The result of executing the operation chain
 * 
 * @internal
 */
async function executeOperation(
  this: any,  // 'this' is the DO instance
  preprocessedChain: any
): Promise<any> {
  // Postprocess the incoming chain (reverse of preprocess)
  const operationChain: OperationChain = await postprocess(preprocessedChain);
  
  // Delegate to LumenizeBase's __executeChain
  return await this.__executeChain(operationChain);
}


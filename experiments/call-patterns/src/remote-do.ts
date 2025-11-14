/**
 * Remote DO - Target of all call patterns
 * 
 * Shared by all pattern tests
 */

import { DurableObject } from 'cloudflare:workers';
import { executeOperationChain, type OperationChain } from '@lumenize/core';
import { postprocess } from '@lumenize/structured-clone';

export class RemoteDO extends DurableObject<Env> {
  echo(value: string): string {
    // Do a tiny bit of work to ensure we're actually executing
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += i;
    }
    return `echo: ${value}`;
  }

  /**
   * Execute operation chain (for V2, V3, V4)
   * Receives preprocessed operation chain, executes it, returns result
   */
  async __executeOperation(preprocessedChain: any): Promise<any> {
    // Postprocess the incoming chain (reverse of preprocess)
    const operationChain: OperationChain = await postprocess(preprocessedChain);
    
    // Execute the operation chain on this DO instance
    const result = await executeOperationChain(operationChain, this);
    
    return result;
  }
}


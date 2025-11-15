/**
 * Call - Type-safe DO-to-DO communication (V4 Pattern)
 * 
 * Simple, reliable implementation based on blockConcurrencyWhile pattern
 * proven in experiments/call-patterns.
 * 
 * Features:
 * - Synchronous API (returns immediately)
 * - Error handling (Error objects substituted into continuation)
 * - Nested operation composition (proven working)
 * - No alarms, no work queues, no crash recovery complexity
 * 
 * @example
 * ```typescript
 * import '@lumenize/call';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async doSomething() {
 *     const remote = this.ctn<RemoteDO>().getUserData(userId);
 *     
 *     this.svc.call(
 *       'REMOTE_DO',
 *       'instance-id',
 *       remote,
 *       this.ctn().handleResult(remote)  // remote: UserData | Error
 *     );
 *     
 *     // Returns immediately! Handler called when result arrives
 *   }
 *   
 *   handleResult(result: UserData | Error) {
 *     if (result instanceof Error) {
 *       console.error('Failed:', result);
 *       return;
 *     }
 *     console.log('Success:', result);
 *   }
 * }
 * ```
 */

import { debug, type DebugLogger } from '@lumenize/core';
import { 
  getOperationChain, 
  executeOperationChain,
  replaceNestedOperationMarkers,
  type OperationChain
} from '@lumenize/lumenize-base';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { getDOStub } from '@lumenize/utils';
import type { CallOptions } from './types.js';

/**
 * Call - Type-safe DO-to-DO communication using blockConcurrencyWhile pattern
 * 
 * @param doInstance - The calling DO instance (provides ctx)
 * @param doBinding - Name of the remote DO binding in env (e.g., 'REMOTE_DO')
 * @param doInstanceNameOrId - Name or ID of the remote DO instance
 * @param remoteOperation - OCAN chain to execute on remote DO
 * @param continuation - OCAN chain for handling result (receives result | Error)
 * @param options - Optional configuration (timeout, etc.)
 */
export function call(
  doInstance: any,
  doBinding: string,
  doInstanceNameOrId: string,
  remoteOperation: any,
  continuation: any,
  options?: CallOptions
): void {
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.call');

  // Extract operation chains
  const remoteChain = getOperationChain(remoteOperation);
  const handlerChain = getOperationChain(continuation);

  if (!remoteChain) {
    throw new Error('Invalid remoteOperation: must be created with newContinuation() or this.ctn()');
  }
  if (!handlerChain) {
    throw new Error('Invalid continuation: must be created with newContinuation() or this.ctn()');
  }

  // Validate that the DO knows its own binding name (fail fast!)
  const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
  
  if (!originBinding) {
    throw new Error(
      `Cannot use call() from a DO that doesn't know its own binding name. ` +
      `Call __lmzInit({ doBindingName }) first.`
    );
  }

  log.debug('Initiating call', {
    doBinding,
    doInstanceNameOrId,
    timeout: options?.timeout ?? 30000
  });

  // Use blockConcurrencyWhile to perform async work without blocking caller
  // This is the V4 pattern proven in experiments/call-patterns
  ctx.blockConcurrencyWhile(async () => {
    try {
      // Get remote DO stub
      const remoteStub = getDOStub(env[doBinding], doInstanceNameOrId) as any;

      // Preprocess remote chain for transmission
      const preprocessed = await preprocess(remoteChain);
      
      // Execute on remote DO (__executeOperation handles postprocessing)
      const result = await remoteStub.__executeOperation(preprocessed);
      
      log.debug('Remote operation completed', { doBinding, doInstanceNameOrId });
      
      // Replace placeholder in handler chain with actual result
      const finalChain = replaceNestedOperationMarkers(handlerChain, result);
      
      // Execute handler continuation locally
      await executeOperationChain(finalChain, doInstance);
      
      log.debug('Handler continuation executed', { doBinding, doInstanceNameOrId });
      
    } catch (error) {
      log.error('Call failed', { 
        doBinding, 
        doInstanceNameOrId, 
        error: error instanceof Error ? error.message : String(error) 
      });
      
      // Replace placeholder in handler chain with Error
      const errorToInject = error instanceof Error ? error : new Error(String(error));
      const finalChain = replaceNestedOperationMarkers(handlerChain, errorToInject);
      
      // Execute handler continuation with error
      await executeOperationChain(finalChain, doInstance);
    }
  });
  
  // Returns immediately! blockConcurrencyWhile processes async work in background
  log.debug('Call initiated (returns immediately)', { doBinding, doInstanceNameOrId });
}

/**
 * Cancel a pending call
 * 
 * Note: With the V4 pattern, calls cannot be cancelled once initiated
 * since they execute immediately within blockConcurrencyWhile.
 * This function exists for API compatibility but is a no-op.
 * 
 * @param doInstance - The calling DO instance
 * @param operationId - ID of the operation to cancel
 * @returns false (always, since cancellation is not supported)
 */
export function cancelCall(doInstance: any, operationId: string): boolean {
  const log = debug(doInstance.ctx)('lmz.call.cancelCall');
  log.debug('Call cancellation not supported with V4 pattern', { operationId });
  return false;
}


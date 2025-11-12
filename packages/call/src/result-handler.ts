import { debug, executeOperationChain } from '@lumenize/core';
import { postprocess } from '@lumenize/structured-clone';
import type { CallResult, PendingCall } from './types.js';

/**
 * Result handler for 'call' work type
 * 
 * This is registered with LumenizeBase's result handler registry and
 * processes results from completed call operations.
 * 
 * @internal
 */
export async function callResultHandler(
  doInstance: any,
  workId: string,
  resultData: any
): Promise<void> {
  const ctx = doInstance.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.call.resultHandler');

  const operationId = workId;

  // Postprocess result
  const callResult = await postprocess(resultData) as CallResult;

  log.debug('Processing call result', {
    operationId,
    hasError: !!callResult.error,
    resultType: callResult.error ? 'error' : typeof callResult.result
  });

  // Retrieve pending call to get continuation chain
  const pendingKey = `__lmz_call_pending:${operationId}`;
  const pendingData = ctx.storage.kv.get(pendingKey);

  if (!pendingData) {
    log.warn('Pending operation not found (may have been cancelled or timed out)', { operationId });
    return;
  }

  const pending = pendingData as PendingCall;

  // Cancel timeout alarm if exists
  if (pending.timeoutAlarmId) {
    ctx.storage.kv.delete(pending.timeoutAlarmId);
  }

  // Postprocess continuation chain
  const continuationChain = await postprocess(pending.continuationChain);

  // Execute continuation with result or error
  try {
    const resultOrError = callResult.error || callResult.result;
    
    // Replace placeholder with actual result
    const finalChain = replacePlaceholder(continuationChain, resultOrError);
    
    await executeOperationChain(finalChain, doInstance);
    log.debug('Continuation executed', { operationId });
  } catch (error) {
    log.error('Continuation execution failed', {
      operationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }

  // Clean up pending call
  ctx.storage.kv.delete(pendingKey);
}

/**
 * Replace placeholder in continuation chain with actual result
 * @internal
 */
function replacePlaceholder(chain: any[], resultOrError: any): any[] {
  // The placeholder is the remote operation itself
  // We inject the result as the first argument of the last apply operation
  return chain.map((op, i) => {
    if (op.type === 'apply' && i === chain.length - 1) {
      // Replace first arg with result
      return {
        ...op,
        args: [resultOrError, ...op.args.slice(1)]
      };
    }
    return op;
  });
}


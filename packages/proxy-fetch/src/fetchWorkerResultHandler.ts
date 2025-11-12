/**
 * Result handler for proxyFetchWorker
 * 
 * This handler is registered with LumenizeBase's generic actor queue
 * and processes results from Worker fetch executions.
 */

import { debug, executeOperationChain } from '@lumenize/core';
import { postprocess } from '@lumenize/structured-clone';
import type { FetchResult } from './types.js';

/**
 * Process a fetch result from a Worker
 * 
 * This is called by LumenizeBase's __receiveResult method when a Worker
 * sends back a fetch result.
 * 
 * @internal
 */
export async function fetchWorkerResultHandler(
  doInstance: any,
  reqId: string,
  resultData: any
): Promise<void> {
  const ctx = doInstance.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.proxyFetch.worker.resultHandler');

  log.debug('Processing fetch result', { reqId });

  // Postprocess result
  const fetchResult = await postprocess(resultData) as FetchResult;

  // Get the continuation chain from pending request storage
  const pendingKey = `proxyFetch_pending:${reqId}`;
  const pendingData = ctx.storage.kv.get(pendingKey) as { reqId: string; continuationChain: any; timestamp: number } | undefined;
  
  if (!pendingData) {
    log.warn('No pending continuation found for result', { reqId });
    return;
  }

  const continuationChain = await postprocess(pendingData.continuationChain);

  log.debug('Executing continuation', {
    reqId,
    hasError: !!fetchResult.error,
    duration: fetchResult.duration
  });

  // Prepare result or error for continuation
  let resultOrError: Response | Error;
  
  if (fetchResult.error) {
    resultOrError = fetchResult.error;
  } else if (fetchResult.response) {
    resultOrError = await postprocess(fetchResult.response) as Response;
  } else {
    resultOrError = new Error('No response or error in fetch result');
  }

  // Store reqId temporarily so continuation can access it
  // This is a workaround until we have better context injection in OCAN
  ctx.storage.kv.put('__current_result_reqId', reqId);

  // Execute continuation with result
  try {
    const finalChain = replacePlaceholder(continuationChain, resultOrError);
    await executeOperationChain(finalChain, doInstance);
    
    log.debug('Continuation executed successfully', { reqId });
  } catch (error) {
    log.error('Continuation execution failed', {
      reqId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }

  // Clean up
  ctx.storage.kv.delete(pendingKey);
  ctx.storage.kv.delete('__current_result_reqId');
}

/**
 * Replace placeholder in continuation chain with actual result
 * @internal
 */
function replacePlaceholder(chain: any[], resultOrError: any): any[] {
  // The placeholder is typically the last apply operation's first argument
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


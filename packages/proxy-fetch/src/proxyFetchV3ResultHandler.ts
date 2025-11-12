/**
 * Result handler for proxyFetch V3
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
export async function proxyFetchV3ResultHandler(
  doInstance: any,
  reqId: string,
  resultData: any
): Promise<void> {
  const ctx = doInstance.ctx as DurableObjectState;
  const log = debug(ctx)('lmz.proxyFetch.v3.resultHandler');

  log.debug('Processing fetch result', { reqId });

  // Postprocess result
  const fetchResult = await postprocess(resultData) as FetchResult;

  // Get the continuation chain from pending request
  // (We don't store pending requests for V3, the continuation is in the result)
  // Actually, we need to think about this differently...
  
  // For V3, the Worker already has the continuation chain and will execute it
  // Wait, no - we want the continuation to run on the origin DO, not the Worker!
  
  // Let me reconsider the architecture:
  // The continuation chain is sent to the Worker in the message
  // The Worker sends back the result
  // We need to store the continuation chain on the origin DO so we can execute it here
  
  // Store pending continuation when we make the fetch
  const pendingKey = `proxyFetch_pending:${reqId}`;
  const pendingData = ctx.storage.kv.get(pendingKey);
  
  if (!pendingData) {
    log.warn('No pending continuation found for result', { reqId });
    return;
  }

  const pending = JSON.parse(pendingData as string);
  const continuationChain = await postprocess(pending.continuationChain);

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

  // Clean up pending continuation
  ctx.storage.kv.delete(pendingKey);
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


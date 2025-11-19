/**
 * Simplified Worker Fetch Executor - Clean v2 Implementation
 * 
 * Executes fetch and calls back to origin DO's handleFetchResult() method.
 * 
 * Flow:
 * 1. Worker receives message with preprocessed continuation
 * 2. Worker executes fetch (CPU billing)
 * 3. Worker creates continuation with $result placeholder
 * 4. Worker fills $result with actual result using replaceNestedOperationMarkers
 * 5. Worker calls origin DO via callRaw (automatic metadata propagation)
 * 6. Origin DO's handleFetchResult cancels alarm and executes user continuation
 */

import { debug } from '@lumenize/core';
import { postprocess, ResponseSync } from '@lumenize/structured-clone';
import { replaceNestedOperationMarkers, getOperationChain } from '@lumenize/lumenize-base';
import type { SimpleFetchMessage } from './proxyFetchSimple.js';
import type { LumenizeWorker } from '@lumenize/lumenize-base';

const DEFAULT_TIMEOUT = 30000;

/**
 * Execute a fetch request and deliver result to origin DO.
 * 
 * Called by `FetchExecutorEntrypoint` when invoked via RPC from origin DO.
 * 
 * @param message - Fetch request message with embedded continuation
 * @param env - Worker environment (must contain DO bindings for result delivery)
 * @param worker - LumenizeWorker instance (for callRaw access)
 * @internal
 */
export async function executeFetchSimple(
  message: SimpleFetchMessage,
  env: any,
  worker: LumenizeWorker
): Promise<void> {
  const log = debug({ env })('lmz.proxyFetchSimple.worker');
  
  log.debug('Executing fetch', { reqId: message.reqId, url: message.url });

  const startTime = Date.now();
  let result: ResponseSync | Error;

  // Execute fetch
  try {
    const request = postprocess(message.request) as Request;
    
    // Fetch with timeout
    const timeout = message.fetchTimeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(request, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      // Convert to ResponseSync (synchronous body access)
      result = await ResponseSync.fromResponse(response);
      
      log.debug('Fetch completed', {
        reqId: message.reqId,
        status: result.status,
        duration: Date.now() - startTime
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (e) {
    result = e instanceof Error ? e : new Error(String(e));
    log.error('Fetch failed', {
      reqId: message.reqId,
      error: result.message,
      duration: Date.now() - startTime
    });
  }

  // TEST HOOK: Check if we should simulate delivery failure
  if (message.options?.testMode?.simulateDeliveryFailure === true) {
    log.debug('TEST MODE: Skipping delivery', { reqId: message.reqId });
    return; // Skip delivery to trigger timeout path in tests
  }

  // Deliver result to origin DO
  log.debug('Delivering result to origin DO', {
    reqId: message.reqId,
    resultType: result instanceof Error ? 'Error' : 'ResponseSync',
    originBinding: message.originBinding,
    originId: message.originId
  });

  try {
    // Create continuation with $result placeholder
    // Pattern: __handleProxyFetchSimpleResult(reqId, $result, stringifiedUserContinuation)
    const handleResultContinuation = worker.ctn().__handleProxyFetchSimpleResult(
      message.reqId,
      worker.ctn().$result, // Placeholder
      message.stringifiedUserContinuation
    );

    // Fill $result placeholder with actual result
    const filledContinuation = await replaceNestedOperationMarkers(
      getOperationChain(handleResultContinuation),
      result
    );

    // Call origin DO via callRaw (automatic metadata propagation)
    await worker.lmz.callRaw(
      message.originBinding,
      message.originId,
      filledContinuation
    );

    log.debug('Result delivered successfully', { reqId: message.reqId });
  } catch (deliveryError) {
    log.error('Failed to deliver result', {
      reqId: message.reqId,
      error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
    });
    
    // If delivery fails, origin DO will get timeout via alarm
    // This is by design - alarm provides fallback timeout mechanism
  }
}


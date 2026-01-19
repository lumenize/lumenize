/**
 * FetchExecutorEntrypoint - WorkerEntrypoint for executing external fetches
 * 
 * This entrypoint is invoked by origin DOs via RPC to execute external
 * fetches using CPU billing instead of DO wall-clock billing.
 * 
 * Usage:
 * 1. Export this from your Worker
 * 2. Add a service binding in wrangler.jsonc:
 *    ```jsonc
 *    {
 *      "services": [
 *        {
 *          "binding": "FETCH_EXECUTOR",
 *          "service": "my-worker",
 *          "entrypoint": "FetchExecutorEntrypoint"
 *        }
 *      ]
 *    }
 *    ```
 * 3. Origin DOs will automatically use it via RPC
 */

import { debug } from '@lumenize/debug';
import { LumenizeWorker } from '@lumenize/mesh';
import { ResponseSync } from '@lumenize/structured-clone';
import { replaceNestedOperationMarkers, getOperationChain } from '@lumenize/mesh';
import type { FetchMessage } from './fetch';

const DEFAULT_TIMEOUT = 30000;

export class FetchExecutorEntrypoint extends LumenizeWorker {
  /**
   * Execute an external fetch request
   * 
   * Called by origin DO directly via RPC. Returns immediately, then executes
   * fetch in background. Calls back to origin DO's `svc.fetch.__handleProxyFetchResult()` via OCAN.
   * 
   * Flow:
   * 1. Quick RPC acknowledgment (microseconds)
   * 2. Origin DO continues (alarm is scheduled)
   * 3. Fetch executes in background (CPU billing)
   * 4. Result delivered to origin DO's internal handler method
   * 5. Origin DO cancels alarm atomically to get continuation
   * 
   * @param message - Fetch message with preprocessed continuation
   */
  async executeFetch(message: FetchMessage): Promise<void> {
    // Quick acknowledgment - return immediately
    this.ctx.waitUntil(
      this.#executeFetch(message)
    );
    
    // Return immediately - origin DO continues
  }

  /**
   * Internal implementation of fetch execution
   * Runs in background via ctx.waitUntil()
   */
  async #executeFetch(message: FetchMessage): Promise<void> {
    const log = debug(this)('lmz.proxyFetch.worker');
    
    const isString = typeof message.request === 'string';
    const url = isString 
      ? message.request 
      : (message.request as any)._request.url;
    
    log.debug('Executing fetch', { 
      reqId: message.reqId, 
      url,
      requestType: isString ? 'string' : 'RequestSync'
    });

    let result: ResponseSync | Error;

    // Execute fetch
    try {
      // callRaw already deserialized - convert RequestSync to native Request if needed
      const fetchInput = isString 
        ? message.request 
        : (message.request as any).toRequest();
      
      // Fetch with timeout
      const timeout = message.fetchTimeout ?? DEFAULT_TIMEOUT;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(fetchInput, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        // Convert to ResponseSync (synchronous body access)
        result = await ResponseSync.fromResponse(response);
        
        log.debug('Fetch completed', {
          reqId: message.reqId,
          status: result.status,
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
      // Create continuation with $result placeholder for remote DO's Fetch plugin
      // Pattern: svc.fetch.__handleProxyFetchResult(reqId, $result)
      // Note: stringifiedUserContinuation is NOT passed - it's extracted from the alarm
      const handleResultContinuation = (this.ctn() as any).svc.fetch.__handleProxyFetchResult(
        message.reqId,
        (this.ctn() as any).$result // Placeholder
      );

      // Fill $result placeholder with actual result
      const chain = getOperationChain(handleResultContinuation);
      if (!chain) {
        throw new Error('Invalid continuation created for result delivery');
      }
      
      const filledContinuation = await replaceNestedOperationMarkers(chain, result);

      // Call origin DO via callRaw (automatic metadata propagation)
      await this.lmz.callRaw(
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
      // This is by design - alarm provides backstop timeout mechanism
    }
  }
}


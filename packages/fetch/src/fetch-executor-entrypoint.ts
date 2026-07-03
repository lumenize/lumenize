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
import { LumenizeWorker, mesh } from '@lumenize/mesh';
import { ResponseSync } from '@lumenize/structured-clone';
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
  @mesh()
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
    const log = debug('lmz.proxyFetch.worker');
    
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
      // Request already deserialized by the mesh receive path - convert RequestSync to native Request if needed
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
      // Deliver the result to the origin DO's Fetch plugin as a fire-and-forget mesh call
      // (continuation-only model — no awaited callRaw). The executor already holds `result`,
      // so it rides as a direct continuation argument (no $result marker / pre-filled chain:
      // call() takes a this.ctn()-built continuation, not a raw OperationChain). The origin DO
      // correlates by reqId in __handleProxyFetchResult and cancels the alarm backstop.
      // Note: stringifiedUserContinuation is NOT passed - it's extracted from the alarm.
      this.lmz.call(
        message.originBinding,
        message.originId,
        (this.ctn() as any).svc.fetch.__handleProxyFetchResult(message.reqId, result)
      );

      log.debug('Result delivery dispatched', { reqId: message.reqId });
    } catch (deliveryError) {
      log.error('Failed to deliver result', {
        reqId: message.reqId,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
      });

      // If the delivery dispatch throws (e.g. an invalid origin binding), the origin DO
      // still gets its result via the alarm-backstop timeout. This is by design.
    }
  }
}


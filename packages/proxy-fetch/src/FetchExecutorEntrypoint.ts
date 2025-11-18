/**
 * FetchExecutorEntrypoint - WorkerEntrypoint for executing external fetches
 * 
 * This entrypoint is invoked by FetchOrchestrator via RPC to execute external
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
 * 3. FetchOrchestrator will automatically use it via RPC
 */

import { LumenizeWorker } from '@lumenize/lumenize-base';
import { executeFetch } from './workerFetchExecutor.js';
import { executeFetchSimple } from './workerFetchExecutorSimple.js';
import type { WorkerFetchMessage } from './types.js';
import type { SimpleFetchMessage } from './proxyFetchSimple.js';

export class FetchExecutorEntrypoint extends LumenizeWorker {
  /**
   * Execute an external fetch request
   * 
   * Called by FetchOrchestrator via RPC. Returns immediately (stopping DO billing),
   * then executes the fetch in background using CPU billing.
   * 
   * Flow:
   * 1. Quick RPC acknowledgment (microseconds)
   * 2. FetchOrchestrator stops billing
   * 3. Fetch executes in background (CPU billing)
   * 4. Result delivered to origin DO via this.lmz.callRaw()
   * 5. Delivery status reported to orchestrator (for monitoring/queue cleanup)
   * 
   * @param message - Fetch message containing request and callback info
   */
  async executeFetch(message: WorkerFetchMessage): Promise<void> {
    
    // Quick acknowledgment - return immediately to stop DO wall-clock billing
    this.ctx.waitUntil(
      executeFetch(message, this.env, this)
    );
    
    // Return immediately - FetchOrchestrator continues without blocking
  }

  /**
   * Execute an external fetch request (simplified version for proxyFetchSimple)
   * 
   * Called by origin DO directly via RPC. Returns immediately, then executes
   * fetch in background. Calls back to origin DO's `handleFetchResult()` method.
   * 
   * Flow:
   * 1. Quick RPC acknowledgment (microseconds)
   * 2. Origin DO continues (alarm is scheduled)
   * 3. Fetch executes in background (CPU billing)
   * 4. Result delivered to origin DO's `handleFetchResult(reqId, result, url, preprocessedContinuation)` method
   * 5. Origin DO cancels alarm atomically to get continuation
   * 
   * @param message - Fetch message with preprocessed continuation
   */
  async executeFetchSimple(message: SimpleFetchMessage): Promise<void> {
    // Quick acknowledgment - return immediately
    this.ctx.waitUntil(
      executeFetchSimple(message, this.env, this)
    );
    
    // Return immediately - origin DO continues
  }
}


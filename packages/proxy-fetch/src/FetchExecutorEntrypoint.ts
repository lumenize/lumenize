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

import { WorkerEntrypoint } from 'cloudflare:workers';
import { executeFetch } from './workerFetchExecutor.js';
import type { WorkerFetchMessage } from './types.js';

export class FetchExecutorEntrypoint extends WorkerEntrypoint {
  /**
   * Execute an external fetch request
   * 
   * Called by FetchOrchestrator via RPC. Executes the fetch using CPU billing
   * and sends the result directly back to the origin DO.
   * 
   * @param message - Fetch message containing request and callback info
   */
  async executeFetch(message: WorkerFetchMessage): Promise<void> {
    return await executeFetch(message, this.env);
  }
}


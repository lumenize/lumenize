/**
 * FetchOrchestrator - Manages fetch queue and dispatches via RPC
 * 
 * This DO acts as a coordinator:
 * 1. Receives fetch requests from origin DOs
 * 2. Queues them in storage
 * 3. Dispatches to Workers via RPC (service binding)
 * 4. Workers execute fetches and send results DIRECTLY back to origin DOs
 * 5. Receives completion notifications from Workers
 * 
 * Benefits:
 * - Type-safe (RPC methods are strongly typed)
 * - No auth required (service bindings are account-scoped)
 * - Low latency (direct RPC dispatch)
 * - Scalable (Workers do the fetches, not this DO)
 * - Cost-effective (Workers use CPU billing for fetch execution)
 */

import { LumenizeBase } from '@lumenize/lumenize-base';
import { debug } from '@lumenize/core';
import type { FetchOrchestratorMessage, WorkerFetchMessage } from './types.js';

export class FetchOrchestrator extends LumenizeBase {
  /**
   * Enqueue a fetch request
   * 
   * This is called via Workers RPC from origin DOs.
   * Stores the request in a queue and dispatches to a Worker.
   */
  async enqueueFetch(message: FetchOrchestratorMessage): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    log.debug('Enqueueing fetch request', {
      reqId: message.reqId,
      originBinding: message.originBinding,
      originId: message.originId
    });

    // Store in queue
    const queueKey = `__lmz_fetch_queue:${message.reqId}`;
    this.ctx.storage.kv.put(queueKey, message);

    // Dispatch to Worker immediately
    // The Worker will execute the fetch and send result directly to origin DO
    await this.#dispatchToWorker(message);
  }

  /**
   * Mark a fetch request as complete
   * 
   * Called by Workers after they've sent the result to the origin DO.
   * This allows us to clean up the queue.
   */
  async markComplete(reqId: string): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    log.debug('Marking fetch complete', { reqId });

    // Remove from queue
    const queueKey = `__lmz_fetch_queue:${reqId}`;
    this.ctx.storage.kv.delete(queueKey);
  }

  /**
   * Dispatch a fetch request to a Worker via RPC
   * 
   * Uses a service binding to invoke FetchExecutorEntrypoint in a Worker context,
   * which uses CPU billing instead of DO wall-clock billing.
   * 
   * @internal
   */
  async #dispatchToWorker(message: FetchOrchestratorMessage): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');

    // Prepare message for Worker
    const workerMessage: WorkerFetchMessage = {
      reqId: message.reqId,
      request: message.request,
      originBinding: message.originBinding,
      originId: message.originId,
      retryCount: 0,
      options: message.options,
      startTime: message.timestamp
    };

    try {
      // Get the fetch executor entrypoint (via service binding)
      const executorBinding = message.options?.executorBinding || 'FETCH_EXECUTOR';
      const executor = this.env[executorBinding];
      
      if (!executor) {
        throw new Error(
          `Fetch executor binding '${executorBinding}' not found. ` +
          `Add a service binding in wrangler.jsonc:\n` +
          `{\n` +
          `  "services": [{\n` +
          `    "binding": "${executorBinding}",\n` +
          `    "service": "your-worker",\n` +
          `    "entrypoint": "FetchExecutorEntrypoint"\n` +
          `  }]\n` +
          `}`
        );
      }

      log.debug('Dispatching to Worker via RPC', { reqId: message.reqId, executorBinding });

      // Call Worker via RPC (service binding)
      await executor.executeFetch(workerMessage);
      
      log.debug('Dispatched to Worker', { reqId: message.reqId });
    } catch (error) {
      log.error('Failed to dispatch to Worker', {
        reqId: message.reqId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // TODO: Implement retry logic or error handling
      // For now, just log the error
    }
  }

  /**
   * Get queue statistics (for monitoring/debugging)
   */
  async getQueueStats(): Promise<{ pendingCount: number; items: string[] }> {
    const items = [...this.ctx.storage.kv.list({ prefix: '__lmz_fetch_queue:' })];
    return {
      pendingCount: items.length,
      items: items.map(([key]) => key.substring('__lmz_fetch_queue:'.length))
    };
  }
}


/**
 * FetchOrchestrator - Manages fetch queue and dispatches via HTTP
 * 
 * This DO acts as a coordinator:
 * 1. Receives fetch requests from origin DOs
 * 2. Queues them in storage
 * 3. Dispatches to Workers via HTTP (authenticated)
 * 4. Workers execute fetches and send results DIRECTLY back to origin DOs
 * 5. Receives completion notifications from Workers
 * 
 * Benefits:
 * - Simple deployment (no service bindings required)
 * - Low latency (direct HTTP dispatch, no Cloudflare Queue wait)
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
    const queueKey = `fetch_queue:${message.reqId}`;
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
    const queueKey = `fetch_queue:${reqId}`;
    this.ctx.storage.kv.delete(queueKey);
  }

  /**
   * Dispatch a fetch request to a Worker via HTTP
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
      // Determine worker URL
      const workerUrl = message.options?.workerUrl || this.env.WORKER_URL;
      if (!workerUrl) {
        throw new Error('Worker URL not provided. Set options.workerUrl or env.WORKER_URL');
      }

      // Determine worker path
      const workerPath = message.options?.workerPath || '/proxy-fetch-execute';
      const url = `${workerUrl}${workerPath}`;

      // Get shared secret for authentication
      const secret = this.env.PROXY_FETCH_SECRET;
      if (!secret) {
        throw new Error('PROXY_FETCH_SECRET not configured. Set it using: wrangler secret put PROXY_FETCH_SECRET');
      }

      log.debug('Dispatching to Worker via HTTP', { reqId: message.reqId, url });

      // Call Worker via HTTP
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Fetch-Secret': secret
        },
        body: JSON.stringify(workerMessage)
      });

      if (!response.ok) {
        throw new Error(`Worker returned ${response.status}: ${await response.text()}`);
      }
      
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
    const items = [...this.ctx.storage.kv.list({ prefix: 'fetch_queue:' })];
    return {
      pendingCount: items.length,
      items: items.map(([key]) => key.substring('fetch_queue:'.length))
    };
  }
}


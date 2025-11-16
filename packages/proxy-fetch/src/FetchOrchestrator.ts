/**
 * FetchOrchestrator - Manages fetch queue and dispatches via RPC
 * 
 * This DO acts as a coordinator:
 * 1. Receives fetch requests from origin DOs
 * 2. Queues them in storage
 * 3. Dispatches to Workers via RPC (service binding) - QUICK RETURN
 * 4. Workers execute fetches in background (CPU billing, no wall-clock)
 * 5. Workers deliver results DIRECTLY to origin DOs via __receiveResult()
 * 6. Workers report delivery status back to orchestrator (for monitoring/queue cleanup)
 * 
 * Benefits:
 * - Type-safe (RPC methods are strongly typed)
 * - No auth required (service bindings are account-scoped)
 * - Minimal DO billing (dispatch returns immediately via ctx.waitUntil)
 * - Delivery tracking (logs failures for monitoring/alerting)
 * - Scalable (Workers do the fetches, not this DO)
 * - Cost-effective (Workers use CPU billing, not wall-clock billing)
 */

import { LumenizeBase } from '@lumenize/lumenize-base';
import { debug } from '@lumenize/core';
import { preprocess } from '@lumenize/structured-clone';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { FetchOrchestratorMessage, WorkerFetchMessage } from './types.js';

export class FetchOrchestrator extends LumenizeBase {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    // Schedule initial alarm check (defensive - ensures it always runs)
    this.#scheduleAlarm();
  }

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

    // Calculate timeout
    // fetchTimeout = time for external fetch (user's timeout option)
    // +10s = alarm polling period (5s) + buffer (5s)
    const fetchTimeout = message.options?.timeout ?? 30000;
    const ALARM_POLLING_PERIOD = 5000; // 5 seconds
    const BUFFER = 5000; // 5 seconds for network latency
    const orchestratorTimeout = fetchTimeout + ALARM_POLLING_PERIOD + BUFFER;
    
    // Store in queue with timeout
    const queueKey = `__lmz_fetch_queue:${message.reqId}`;
    const queuedMessage = {
      ...message,
      fetchTimeout, // For executor's AbortController
      timeoutAt: Date.now() + orchestratorTimeout // For orchestrator's alarm
    };
    this.ctx.storage.kv.put(queueKey, queuedMessage);

    // Dispatch to Worker immediately
    // The Worker will execute the fetch and send result directly to origin DO
    await this.#dispatchToWorker(queuedMessage);
  }

  /**
   * Report delivery status from Executor
   * 
   * Called by Workers after they've attempted to deliver the result to the origin DO.
   * Logs delivery failures for monitoring/alerting, then cleans up the queue.
   * 
   * @param reqId - Request ID
   * @param delivered - True if result was successfully delivered to origin DO, false if delivery failed
   */
  async reportDelivery(reqId: string, delivered: boolean): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    if (delivered) {
      log.debug('Fetch result delivered successfully', { reqId });
    } else {
      // Delivery failure is serious - Origin DO won't receive result!
      // This should be monitored/alerted on
      log.error('Failed to deliver fetch result to origin DO', { 
        reqId,
        note: 'Origin DO will not receive result. Check origin DO availability and network connectivity.'
      });
    }

    // Remove from queue (whether delivered or not - we tried)
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
  async #dispatchToWorker(message: any): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');

    // Prepare message for Worker
    const workerMessage: WorkerFetchMessage = {
      reqId: message.reqId,
      request: message.request,
      continuation: message.continuation, // Pass continuation through
      originBinding: message.originBinding,
      originId: message.originId,
      retryCount: 0,
      options: message.options,
      startTime: message.timestamp,
      fetchTimeout: message.fetchTimeout,
      timeoutAt: message.timeoutAt
    };

    log.debug('Preparing dispatch to worker', { 
      reqId: message.reqId,
      continuationType: typeof message.continuation,
      continuationKeys: message.continuation ? Object.keys(message.continuation).slice(0, 10) : 'null'
    });

    try {
      // Get the fetch executor entrypoint (via service binding)
      const executorBinding = message.options?.executorBinding || 'FETCH_EXECUTOR';
      
      log.debug('Looking for executor binding', { 
        executorBinding,
        availableBindings: Object.keys(this.env)
      });
      
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

      log.debug('Calling executor.executeFetch', { 
        reqId: message.reqId,
        continuationType: typeof workerMessage.continuation,
        continuationPreview: JSON.stringify(workerMessage.continuation, null, 2).substring(0, 500)
      });
      log.debug('Dispatching to Worker via RPC', { reqId: message.reqId, executorBinding });

      // Call Worker via RPC (service binding)
      await executor.executeFetch(workerMessage);
      
      log.debug('Dispatched successfully to Worker', { reqId: message.reqId });
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

  /**
   * Alarm handler - checks for timed-out fetches
   * 
   * Runs every 5 seconds (while queue is not empty).
   * Pattern: Reschedule at start (defensive), cancel at end if queue empty.
   */
  async alarm(): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator.alarm');
    
    // Reschedule EARLY (defensive - ensures alarm keeps running even if something throws)
    this.#scheduleAlarm();
    
    const now = Date.now();
    const items = [...this.ctx.storage.kv.list({ prefix: '__lmz_fetch_queue:' })];
    
    log.debug('Alarm checking queue', { 
      itemCount: items.length,
      now
    });
    
    // Check each queued fetch for timeout
    for (const [key, message] of items) {
      if (now > message.timeoutAt) {
        // Timeout exceeded!
        log.warn('Fetch timed out', {
          reqId: message.reqId,
          timeoutAt: message.timeoutAt,
          elapsed: now - message.timestamp
        });
        
        // Send timeout error to origin DO
        await this.#sendTimeoutToOrigin(message);
        
        // Remove from queue (we tried, origin will decide if/when to retry)
        this.ctx.storage.kv.delete(key);
      }
    }
    
    // Cancel alarm if queue is now empty
    if (items.length === 0) {
      log.debug('Queue empty, canceling alarm');
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Schedule the next alarm check (5 seconds from now)
   * @internal
   */
  #scheduleAlarm(): void {
    const nextCheck = Date.now() + 5000; // 5 seconds
    this.ctx.storage.setAlarm(nextCheck);
  }

  /**
   * Send timeout error to origin DO
   * @internal
   */
  async #sendTimeoutToOrigin(message: any): Promise<void> {
    const log = debug(this.ctx)('lmz.proxyFetch.orchestrator');
    
    try {
      // Create timeout error
      const timeoutError = new Error(
        'Fetch timeout - external fetch may have partially succeeded. ' +
        'Check if request was idempotent before retrying.'
      );
      
      // Prepare error result (similar to FetchResult but with timeout error)
      const errorResult = {
        reqId: message.reqId,
        response: undefined,
        error: timeoutError,
        retryCount: message.retryCount || 0,
        duration: Date.now() - message.timestamp
      };
      
      // Get origin DO and send timeout error
      const originId = this.env[message.originBinding].idFromString(message.originId);
      const originDO = this.env[message.originBinding].get(originId);
      
      const preprocessedResult = await preprocess(errorResult);
      await originDO.__receiveResult('proxyFetch', message.reqId, preprocessedResult);
      
      log.debug('Timeout error sent to origin DO', { reqId: message.reqId });
    } catch (sendError) {
      log.error('Failed to send timeout error to origin DO', {
        reqId: message.reqId,
        error: sendError instanceof Error ? sendError.message : String(sendError)
      });
    }
  }
}


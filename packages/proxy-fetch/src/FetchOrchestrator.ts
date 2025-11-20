/**
 * FetchOrchestrator - Manages fetch queue and dispatches via RPC
 * 
 * This DO acts as a coordinator:
 * 1. Receives fetch requests from origin DOs
 * 2. Queues them in storage
 * 3. Dispatches to Workers via RPC (service binding) - QUICK RETURN
 * 4. Workers execute fetches in background (CPU billing, no wall-clock)
 * 5. Workers deliver results DIRECTLY to origin DOs via __executeOperation()
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

import { LumenizeBase, replaceNestedOperationMarkers } from '@lumenize/lumenize-base';
import { debug } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
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
    const log = debug(this)('lmz.proxyFetch.orchestrator');
    
    log.debug('Enqueueing fetch request', {
      reqId: message.reqId,
      originBinding: message.originBinding,
      originId: message.originId
    });

    // Calculate timeout
    // fetchTimeout = time for external fetch (user's timeout option)
    // +10s = alarm polling period (5s) + buffer (5s)
    const fetchTimeout = message.options?.timeout ?? 30000;
    
    // Allow test mode to override orchestrator timeout for faster tests
    const orchestratorTimeout = message.options?.testMode?.orchestratorTimeoutOverride ?? 
      (fetchTimeout + 10000); // Default: fetchTimeout + 10s (5s polling + 5s buffer)
    
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
    const log = debug(this)('lmz.proxyFetch.orchestrator');
    
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
    const log = debug(this)('lmz.proxyFetch.orchestrator');

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
      
      log.debug('Dispatching to Worker via callRaw', { 
        reqId: message.reqId,
        executorBinding,
        continuationType: typeof workerMessage.continuation
      });

      // Create remote continuation for executeFetch call
      const remoteContinuation = this.ctn().executeFetch(workerMessage);

      // Use callRaw for Worker RPC (prevents connection accumulation)
      await this.lmz.callRaw(
        executorBinding,
        undefined, // Workers don't have instance IDs
        remoteContinuation
      );
      
      log.debug('Dispatched successfully to Worker via callRaw', { reqId: message.reqId });
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
   * Force alarm check (for testing only)
   * @internal
   */
  async forceAlarmCheck(): Promise<void> {
    await this.alarm();
  }

  /**
   * Alarm handler - checks for timed-out fetches
   * 
   * Runs every 5 seconds (while queue is not empty).
   * Pattern: Reschedule at start (defensive), cancel at end if queue empty.
   */
  async alarm(): Promise<void> {
    const log = debug(this)('lmz.proxyFetch.orchestrator.alarm');
    
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
   * Send timeout error to origin DO using callRaw
   * @internal
   */
  async #sendTimeoutToOrigin(message: any): Promise<void> {
    const log = debug(this)('lmz.proxyFetch.orchestrator');
    
    try {
      // Create delivery timeout error
      const timeoutError = new Error(
        'Fetch delivery timeout - result could not be delivered to origin DO within timeout period. ' +
        'External fetch may have completed successfully but result was not delivered.'
      );
      
      log.debug('Sending delivery timeout to origin DO', { 
        reqId: message.reqId,
        elapsed: Date.now() - message.timestamp
      });
      
      // Postprocess the continuation (deserialize it)
      const continuation = postprocess(message.continuation);
      
      // Inject RAW Error into continuation placeholder (not preprocessed!)
      const filledChain = await replaceNestedOperationMarkers(continuation, timeoutError);
      
      // Use callRaw to send to origin DO (automatic metadata propagation!)
      await this.lmz.callRaw(
        message.originBinding,
        message.originId,
        filledChain
      );
      
      log.debug('Delivery timeout sent to origin DO successfully', { reqId: message.reqId });
    } catch (sendError) {
      log.error('Failed to send delivery timeout to origin DO', {
        reqId: message.reqId,
        error: sendError instanceof Error ? sendError.message : String(sendError)
      });
    }
  }
}


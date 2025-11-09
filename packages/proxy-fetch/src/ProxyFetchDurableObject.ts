import { DurableObject } from 'cloudflare:workers';
import { ulidFactory, decodeTime } from 'ulid-workers';
import { debug } from '@lumenize/core';
import type { ProxyFetchQueueMessage } from './types';
import { MAX_REQUEST_AGE_MS, ALARM_INTERVAL_NORMAL_MS, QUEUE_PROCESS_BATCH_SIZE, isRetryable, getRetryDelay, DEFAULT_OPTIONS } from './utils';
import { encodeResponse, decodeRequest, decodeResponse } from '@lumenize/structured-clone';

// Create monotonic ULID factory at module level for DO persistence
const ulid = ulidFactory();

/**
 * ProxyFetchDO - Durable Object that queues and processes external fetch requests
 * 
 * This DO provides a centralized service for executing external fetch() calls on behalf
 * of other Durable Objects. By offloading fetch operations to this dedicated DO, other
 * DOs avoid wall-clock billing while fetch requests are in flight.
 * 
 * **Architecture:**
 * - Single named instance ('proxy-fetch-global') handles all proxy fetch operations
 * - ULID-based FIFO queue ensures requests are processed in order
 * - In-flight tracking prevents duplicate processing
 * - Automatic retry with exponential backoff for transient failures
 * - Callback delivery to origin DO when complete
 * - Fire-and-forget mode supported (no callback)
 * 
 * **Usage:**
 * ```typescript
 * // From within another DO:
 * const reqId = await proxyFetchDO(
 *   this,                    // DO instance
 *   'https://api.example.com/data',
 *   'MY_DO',                 // DO binding name
 *   'handleApiResponse',     // Handler method name
 *   { timeout: 10000 }
 * );
 * 
 * // Handler receives response:
 * async handleApiResponse(item: ProxyFetchHandlerItem) {
 *   if (item.error) {
 *     console.error('Fetch failed:', item.error);
 *   } else {
   *     const response = decodeResponse(item.response);
 *     const data = await response.json();
 *     // Process data...
 *   }
 * }
 * ```
 * 
 * @see {@link https://lumenize.com/docs/proxy-fetch/durable-object}
 */
export class ProxyFetchDO extends DurableObject {
  #log = debug(this)('lmz.proxy-fetch.do');
  
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    // On construction, recover any orphaned in-flight requests
    this.#recoverOrphanedRequests();
  }

    /**
   * Enqueue a request for async processing
   * 
   * Called by proxyFetchDO() client function to add a request to the queue.
   * Generates a monotonic ULID for FIFO ordering and immediately processes the queue.
   * 
   * @param request - Serialized request with metadata
   */
  async enqueue(request: ProxyFetchQueueMessage): Promise<void> {
    // Generate monotonic ULID for queue ordering (FIFO)
    const requestUlid = ulid();
    
    // Store in queued state
    this.ctx.storage.kv.put(`reqs-queued:${requestUlid}`, request);
    
    // Process queue immediately instead of waiting for alarm
    await this.#processQueue();
  }

  /**
   * Process the queue via alarm
   * 
   * Alarm is triggered automatically by Cloudflare when scheduled. Calls the
   * shared queue processing logic.
   */
  async alarm(): Promise<void> {
    await this.#processQueue();
  }

  /**
   * TEST ONLY: Manually trigger orphaned request recovery
   * 
   * This method exists solely for testing. In production, recovery happens
   * automatically in the constructor when a DO is evicted and reinstantiated.
   */
  async triggerRecovery(): Promise<void> {
    await this.#doRecovery();
  }

  /**
   * Process a batch of queued items
   * 
   * Moves items from queued to in-flight state and fires off fetch operations.
   * Schedules an alarm if more items remain in the queue.
   */
  async #processQueue(): Promise<void> {
    try {
      // Process batch of queued items (full throttle - no artificial limits)
      const queued = this.ctx.storage.kv.list({ 
        prefix: 'reqs-queued:', 
        limit: QUEUE_PROCESS_BATCH_SIZE 
      });
      
      let processedCount = 0;
      let hasMore = false;
      
      for (const [key, request] of queued) {
        const ulid = key.replace('reqs-queued:', '');
        
        if (!request) {
          // Request was deleted, skip
          continue;
        }
        
        const typedRequest = request as ProxyFetchQueueMessage;
        
        // Move queued → in-flight
        this.ctx.storage.kv.delete(key);
        this.ctx.storage.kv.put(`reqs-in-flight:${ulid}`, typedRequest);
        
        this.#log.debug('Starting fetch', {
          reqId: typedRequest.reqId,
          ulid,
          url: typedRequest.request?.url,
        });
        
        // Fire off the fetch - don't await, let it run in background
        this.ctx.waitUntil(this.#processFetch(ulid, typedRequest));
        processedCount++;
      }
      
      // Check if there are more items (queued will be an iterable, we need to check if we got QUEUE_PROCESS_BATCH_SIZE items)
      hasMore = processedCount >= QUEUE_PROCESS_BATCH_SIZE;
      
      this.#log.debug('Processed batch', {
        count: processedCount,
        hasMore,
      });
      
      // Schedule next alarm if more items likely remain
      if (hasMore) {
        await this.#scheduleAlarm();
      }
    } catch (error) {
      console.error('Queue processing error:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Back off and retry
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  /**
   * Process a single fetch request (runs in background via waitUntil)
   * 
   * Executes the fetch with timeout and error handling. On success or non-retryable
   * failure, delivers callback to origin DO. On retryable failure, re-queues with
   * incremented retry count.
   * 
   * @param requestUlid - ULID key for this request
   * @param request - Request metadata and options
   */
  async #processFetch(requestUlid: string, request: ProxyFetchQueueMessage): Promise<void> {
    const startTime = Date.now();
    let fetchError: Error | null = null;
    let response: Response | null = null;

    try {
      this.#log.debug('Fetching', {
        reqId: request.reqId,
        url: request.request?.url,
        method: request.request?.method,
        retryCount: request.retryCount || 0,
      });

      // Decode the request
      const fetchRequest = decodeRequest(request.request);

      // Set up timeout
      const controller = new AbortController();
      const options = request.options || {};
      const timeout = options.timeout || 30000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        // Execute the fetch
        response = await fetch(fetchRequest, { signal: controller.signal });
        clearTimeout(timeoutId);

        this.#log.info('Fetch complete', {
          reqId: request.reqId,
          status: response.status,
          statusText: response.statusText,
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Request timeout after ${timeout}ms`);
        }
        throw error;
      }
    } catch (error) {
      fetchError = error instanceof Error ? error : new Error(String(error));
      console.error('Fetch error:', {
        reqId: request.reqId,
        error: fetchError.message,
      });
    }

    // Determine if we should retry
    const options = { ...DEFAULT_OPTIONS, ...request.options };
    const retryCount = request.retryCount || 0;

    if (isRetryable(fetchError, response, options) && retryCount < options.maxRetries) {
      // Retry - re-queue the request with incremented retry count
      const delay = getRetryDelay(retryCount, options);
      
      this.#log.warn('Retryable failure, re-queuing for retry', {
        reqId: request.reqId,
        retryCount,
        maxRetries: options.maxRetries,
        delayMs: delay,
      });

      // Delete from in-flight
      this.ctx.storage.kv.delete(`reqs-in-flight:${requestUlid}`);

      // Re-queue immediately with incremented retry count
      // The alarm will process it - we could add delay logic to the alarm if needed
      const retryRequest = {
        ...request,
        retryCount: retryCount + 1,
      };
      
      // Generate new ULID for the retry
      const retryUlid = ulid();
      this.ctx.storage.kv.put(`reqs-queued:${retryUlid}`, retryRequest);
      
      this.#log.debug('Re-queued for retry', {
        reqId: request.reqId,
        newUlid: retryUlid,
        retryCount: retryCount + 1,
      });

      // Schedule alarm to process the retry
      // Note: For true exponential backoff delays, we could track retry time in storage
      // and skip items in alarm() that aren't ready yet. For now, immediate retry.
      await this.#scheduleAlarm();

      return;
    }

    // No retry - deliver callback
    await this.#deliverCallback(request, response, fetchError, startTime);

    // Clean up in-flight tracking
    this.ctx.storage.kv.delete(`reqs-in-flight:${requestUlid}`);
  }

  /**
   * Deliver response/error to origin DO via callback
   * 
   * Calls the specified handler method on the origin DO with serialized response
   * or error information. If no handler is specified (fire-and-forget), skips delivery.
   * Errors during callback delivery are logged but not retried to avoid loops.
   * 
   * @param request - Original request metadata
   * @param response - Fetch response (if successful)
   * @param error - Fetch error (if failed)
   * @param startTime - Request start timestamp for duration calculation
   */
  async #deliverCallback(
    request: ProxyFetchQueueMessage,
    response: Response | null,
    error: Error | null,
    startTime: number
  ): Promise<void> {
    // If no handler specified, this is fire-and-forget
    if (!request.handlerName) {
      this.#log.debug('No handler specified, fire-and-forget', {
        reqId: request.reqId,
      });
      return;
    }

    try {
      // Get the DO binding and instance
      const doBinding = (this.env as any)[request.doBindingName];
      if (!doBinding) {
        throw new Error(`DO binding not found: ${request.doBindingName}`);
      }

      const doStub = doBinding.idFromString(request.instanceId);
      const doInstance = doBinding.get(doStub);

      // Prepare handler item
      const handlerItem: any = {
        reqId: request.reqId,
        retryCount: request.retryCount || 0,
        duration: Date.now() - startTime,
      };

      if (response) {
        handlerItem.response = await encodeResponse(response);
      }

      if (error) {
        handlerItem.error = {
          message: error.message,
          name: error.name,
          stack: error.stack,
        };
      }

      // Call the handler
      this.#log.debug('Delivering callback', {
        reqId: request.reqId,
        doBinding: request.doBindingName,
        instanceId: request.instanceId,
        handler: request.handlerName,
        hasResponse: !!response,
        hasError: !!error,
      });

      await doInstance[request.handlerName](handlerItem);

      this.#log.info('Callback delivered successfully', {
        reqId: request.reqId,
      });
    } catch (callbackError) {
      // Callback delivery failed - log and discard
      // We don't retry callback delivery to avoid infinite loops
      console.error('Callback delivery failed:', {
        reqId: request.reqId,
        error: callbackError instanceof Error ? callbackError.message : String(callbackError),
        stack: callbackError instanceof Error ? callbackError.stack : undefined,
      });
    }
  }

  /**
   * Schedule alarm to process queue
   * 
   * Only schedules if no alarm is currently set (idempotent).
   */
  async #scheduleAlarm(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      // No alarm scheduled, schedule one
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_NORMAL_MS);
    }
    // If alarm already scheduled, let it run (setting new one would just override)
  }

  /**
   * Recover orphaned in-flight requests on DO restart
   * 
   * When a DO is evicted from memory and restarted, any in-flight requests are orphaned.
   * This method runs in the background during construction to re-queue them for retry
   * or discard if expired.
   */
  #recoverOrphanedRequests(): void {
    // Run recovery asynchronously - don't block constructor
    this.ctx.waitUntil(this.#doRecovery());
  }

  /**
   * Perform recovery of orphaned requests
   * 
   * Scans in-flight requests, re-queues those still within age limit, discards expired ones.
   */
  async #doRecovery(): Promise<void> {
    const now = Date.now();
    const inFlight = this.ctx.storage.kv.list({ prefix: 'reqs-in-flight:' });
    
    let recoveredCount = 0;
    let expiredCount = 0;
    
    for (const [key, request] of inFlight) {
      const ulid = key.replace('reqs-in-flight:', '');
      
      if (!request) {
        // Orphaned key, clean up
        this.ctx.storage.kv.delete(key);
        continue;
      }
      
      const typedRequest = request as ProxyFetchQueueMessage;
      
      // Check if request has expired
      const requestTime = decodeTime(ulid);
      const age = now - requestTime;
      
      if (age > MAX_REQUEST_AGE_MS) {
        // Request too old, discard
        this.#log.warn('Discarding expired request', {
          reqId: typedRequest.reqId,
          age,
          maxAge: MAX_REQUEST_AGE_MS,
        });
        this.ctx.storage.kv.delete(key);
        expiredCount++;
      } else {
        // Re-queue for retry
        this.#log.debug('Re-queuing orphaned request', {
          reqId: typedRequest.reqId,
          age,
        });
        
        // Move in-flight → queued
        this.ctx.storage.kv.delete(key);
        this.ctx.storage.kv.put(`reqs-queued:${ulid}`, typedRequest);
        recoveredCount++;
      }
    }
    
    if (recoveredCount > 0 || expiredCount > 0) {
      this.#log.info('Recovery complete', {
        recovered: recoveredCount,
        expired: expiredCount,
      });
      
      // Schedule alarm to process recovered items
      if (recoveredCount > 0) {
        await this.#scheduleAlarm();
      }
    }
  }
}

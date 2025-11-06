import { decodeRequest } from '@lumenize/structured-clone';
import { debug } from '@lumenize/core';
import type { ProxyFetchQueueMessage, ProxyFetchHandlerItem, ProxyFetchOptions } from './types';
import { DEFAULT_OPTIONS, isRetryable, getRetryDelay } from './utils';

/**
 * Queue consumer that fetches external APIs and routes responses back to DOs.
 * 
 * This function should be exported as the queue consumer in your Worker:
 * 
 * ```typescript
 * export default {
 *   async queue(batch: MessageBatch, env: Env) {
 *     await proxyFetchQueueConsumer(batch, env);
 *   }
 * }
 * ```
 * 
 * @param batch - Batch of queue messages
 * @param env - Environment with DO bindings for return routing and PROXY_FETCH_QUEUE
 */
export async function proxyFetchQueueConsumer(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  // Create debug logger from environment (NADIS pattern)
  const log = debug({ env })('proxy-fetch.queue');
  
  // Process each message in the batch
  for (const message of batch.messages) {
    const queueMessage = message.body as ProxyFetchQueueMessage;
    const { reqId, request: serializedRequest, doBindingName, instanceId, retryCount = 0, options: userOptions } = queueMessage;
    
    // Merge user options with defaults
    const options: Required<ProxyFetchOptions> = { ...DEFAULT_OPTIONS, ...userOptions };
    
    log.debug('Processing proxy fetch request', {
      reqId,
      doBindingName,
      retryCount,
      maxRetries: options.maxRetries
    });
    
    const startTime = Date.now();
    let fetchError: Error | null = null;
    let response: Response | null = null;
    
    try {
      // Decode the Request object
      const request = decodeRequest(serializedRequest);
      
      log.debug('Fetching external URL', {
        reqId,
        url: request.url,
        method: request.method
      });
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout);
      
      try {
        // Make the external fetch with timeout (this runs on Worker with CPU billing)
        response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        log.info('Fetch complete', {
          reqId,
          status: response.status,
          statusText: response.statusText
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          fetchError = new Error(`Request timeout after ${options.timeout}ms`);
        } else {
          fetchError = error instanceof Error ? error : new Error(String(error));
        }
      }
      
      // Check if we should retry
      if (isRetryable(fetchError, response, options) && retryCount < options.maxRetries) {
        const delay = getRetryDelay(retryCount, options);
        
        log.warn('Retryable failure, will retry', {
          reqId,
          retryCount,
          maxRetries: options.maxRetries,
          delayMs: delay,
          nextAttempt: retryCount + 1,
          reason: fetchError ? 'network_error' : response?.status
        });
        
        // Re-queue with incremented retry count
        const retryMessage: ProxyFetchQueueMessage = {
          ...queueMessage,
          retryCount: retryCount + 1,
        };
        
        // Get the queue from env and re-send with delay
        const queue = env.PROXY_FETCH_QUEUE as Queue;
        await queue.send(retryMessage, { delaySeconds: Math.floor(delay / 1000) });
        message.ack();
        continue;
      }
      
      // If we have an error and exhausted retries, route it
      if (fetchError) {
        throw fetchError;
      }
      
      // Success - Response objects can be passed directly over Workers RPC
      const duration = Date.now() - startTime;
      
      // Route back to the DO instance via Workers RPC (if handler provided)
      if (!queueMessage.handlerName) {
        // Fire-and-forget mode - no callback needed
        log.debug('Fire-and-forget mode - no handler callback', {
          reqId,
          duration
        });
        message.ack();
        continue;
      }
      
      const namespace = (env as any)[doBindingName] as DurableObjectNamespace;
      if (!namespace) {
        throw new Error(`DO binding ${doBindingName} not found in environment`);
      }
      
      const doId = namespace.idFromString(instanceId);
      const stub = namespace.get(doId) as any; // Use 'any' for RPC bracket notation
      
      log.debug('Routing response to DO', {
        reqId,
        instanceId,
        duration,
        handler: queueMessage.handlerName
      });
      
      // Call handler method directly via RPC bracket notation
      // Response objects serialize automatically over Workers RPC
      const handlerItem: ProxyFetchHandlerItem = {
        reqId,
        response: response!,
        retryCount,
        duration,
      };
      
      try {
        // Use bracket notation to call the handler method dynamically
        if (typeof stub[queueMessage.handlerName] !== 'function') {
          throw new Error(`Handler method '${queueMessage.handlerName}' not found on DO instance`);
        }
        await stub[queueMessage.handlerName](handlerItem);
        
        log.info('Successfully routed response', {
          reqId,
          retryCount,
          duration
        });
        message.ack();
      } catch (handlerError) {
        // If the DO handler itself fails, that's a user code error
        // Log it but ack the message - we successfully delivered it
        console.error('DO handler threw error (user code issue):', {
          reqId,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
          stack: handlerError instanceof Error ? handlerError.stack : undefined
        });
        message.ack();
      }
      
    } catch (error) {
      console.error('Error processing proxy fetch request:', {
        reqId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        retryCount
      });
      
      // If fetch or routing setup fails, route error back to DO
      try {
        // Skip error callback if fire-and-forget mode
        if (!queueMessage.handlerName) {
          log.debug('Fire-and-forget mode - not routing error to DO', {
            reqId
          });
          message.ack();
          continue;
        }
        
        const namespace = (env as any)[doBindingName] as DurableObjectNamespace;
        const doId = namespace.idFromString(instanceId);
        const stub = namespace.get(doId) as any; // Use 'any' for RPC bracket notation
        
        const duration = Date.now() - startTime;
        const handlerItem: ProxyFetchHandlerItem = {
          reqId,
          error: error instanceof Error ? error : new Error(String(error)),
          retryCount,
          duration,
        };
        
        // Use bracket notation to call the handler method dynamically
        await stub[queueMessage.handlerName](handlerItem);
        
        log.info('Successfully routed error to DO', {
          reqId,
          retryCount,
          duration
        });
        message.ack();
      } catch (routingError) {
        // If we can't route the error back, log it and retry the message
        console.error('Failed to route error back to DO:', {
          reqId,
          routingError: routingError instanceof Error ? routingError.message : String(routingError),
          originalError: error instanceof Error ? error.message : String(error)
        });
        message.retry();
      }
    }
  }
}

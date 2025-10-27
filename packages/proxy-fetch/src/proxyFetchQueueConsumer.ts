import { deserializeWebApiObject, serializeWebApiObject } from './web-api-serialization';
import type { ProxyFetchQueueMessage, ProxyFetchHandlerItem, ProxyFetchCapable, ProxyFetchOptions } from './types';

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS: Required<ProxyFetchOptions> = {
  timeout: 30000, // 30 seconds
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  maxRetryDelay: 10000, // 10 seconds
  retryOn5xx: true,
};

/**
 * Determine if an error or response is retryable
 */
function isRetryable(error: Error | null, response: Response | null, options: Required<ProxyFetchOptions>): boolean {
  // Network errors are always retryable
  if (error) {
    return true;
  }
  
  // 5xx errors are retryable if configured
  if (response && options.retryOn5xx && response.status >= 500 && response.status < 600) {
    return true;
  }
  
  return false;
}

/**
 * Calculate retry delay with exponential backoff
 */
function getRetryDelay(retryCount: number, options: Required<ProxyFetchOptions>): number {
  const delay = options.retryDelay * Math.pow(2, retryCount);
  return Math.min(delay, options.maxRetryDelay);
}

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
  env: { [doBindingName: string]: DurableObjectNamespace | Queue }
): Promise<void> {
  // Process each message in the batch
  for (const message of batch.messages) {
    const queueMessage = message.body as ProxyFetchQueueMessage;
    const { reqId, request: serializedRequest, doBindingName, instanceId, retryCount = 0, options: userOptions } = queueMessage;
    
    // Merge user options with defaults
    const options: Required<ProxyFetchOptions> = { ...DEFAULT_OPTIONS, ...userOptions };
    
    console.debug('%o', {
      type: 'debug',
      where: 'proxyFetchQueueConsumer',
      message: 'Processing proxy fetch request',
      reqId,
      doBindingName,
      retryCount,
      maxRetries: options.maxRetries
    });
    
    const startTime = Date.now();
    let fetchError: Error | null = null;
    let response: Response | null = null;
    
    try {
      // Deserialize the Request object
      const request = deserializeWebApiObject(serializedRequest);
      
      console.debug('%o', {
        type: 'debug',
        where: 'proxyFetchQueueConsumer',
        message: 'Fetching external URL',
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
        
        console.debug('%o', {
          type: 'debug',
          where: 'proxyFetchQueueConsumer',
          message: 'Fetch complete',
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
        
        console.debug('%o', {
          type: 'debug',
          where: 'proxyFetchQueueConsumer',
          message: 'Retryable failure, will retry',
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
      
      // Success - serialize and route response
      const serializedResponse = await serializeWebApiObject(response!);
      const duration = Date.now() - startTime;
      
      // Route back to the DO instance via Workers RPC
      const namespace = env[doBindingName] as DurableObjectNamespace;
      if (!namespace) {
        throw new Error(`DO binding ${doBindingName} not found in environment`);
      }
      
      const doId = namespace.idFromString(instanceId);
      const stub = namespace.get(doId) as unknown as ProxyFetchCapable;
      
      console.debug('%o', {
        type: 'debug',
        where: 'proxyFetchQueueConsumer',
        message: 'Routing response to DO',
        reqId,
        instanceId: instanceId.slice(0, 16) + '...',
        duration: duration
      });
      
      // Call proxyFetchHandler on the DO
      const handlerItem: ProxyFetchHandlerItem = {
        reqId,
        response: serializedResponse,
        retryCount,
        duration,
      };
      
      try {
        await stub.proxyFetchHandler(handlerItem);
        
        console.debug('%o', {
          type: 'debug',
          where: 'proxyFetchQueueConsumer',
          message: 'Successfully routed response',
          reqId,
          retryCount,
          duration
        });
        message.ack();
      } catch (handlerError) {
        // If the DO handler itself fails, that's a user code error
        // Log it but ack the message - we successfully delivered it
        console.error('%o', {
          type: 'error',
          where: 'proxyFetchQueueConsumer',
          message: 'DO handler threw error (user code issue)',
          reqId,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
          stack: handlerError instanceof Error ? handlerError.stack : undefined
        });
        message.ack();
      }
      
    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'proxyFetchQueueConsumer',
        message: 'Error processing proxy fetch request',
        reqId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        retryCount
      });
      
      // If fetch or routing setup fails, route error back to DO
      try {
        const namespace = env[doBindingName] as DurableObjectNamespace;
        const doId = namespace.idFromString(instanceId);
        const stub = namespace.get(doId) as unknown as ProxyFetchCapable;
        
        const duration = Date.now() - startTime;
        const handlerItem: ProxyFetchHandlerItem = {
          reqId,
          error: error instanceof Error ? error : new Error(String(error)),
          retryCount,
          duration,
        };
        
        await stub.proxyFetchHandler(handlerItem);
        
        console.debug('%o', {
          type: 'debug',
          where: 'proxyFetchQueueConsumer',
          message: 'Successfully routed error to DO',
          reqId,
          retryCount,
          duration
        });
        message.ack();
      } catch (routingError) {
        // If we can't route the error back, log it and retry the message
        console.error('%o', {
          type: 'error',
          where: 'proxyFetchQueueConsumer',
          message: 'Failed to route error back to DO',
          reqId,
          routingError: routingError instanceof Error ? routingError.message : String(routingError),
          originalError: error instanceof Error ? error.message : String(error)
        });
        message.retry();
      }
    }
  }
}

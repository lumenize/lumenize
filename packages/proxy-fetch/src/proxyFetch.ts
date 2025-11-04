import { encodeRequest } from '@lumenize/structured-clone';
import { getDOStub } from '@lumenize/utils';
import type { ProxyFetchQueueMessage, ProxyFetchOptions } from './types';

/**
 * Generate a unique request ID using crypto.randomUUID
 */
function generateReqId(): string {
  return crypto.randomUUID();
}

/**
 * Send a fetch request to be executed by a Worker via queue or ProxyFetchDO.
 * 
 * This function automatically detects which variant to use:
 * - If `PROXY_FETCH_DO` binding exists → uses DO variant (lower latency)
 * - If `PROXY_FETCH_QUEUE` binding exists → uses Queue variant (higher scalability)
 * 
 * The response is delivered later via a callback handler method on the DO,
 * or not at all if handler is omitted (fire-and-forget).
 * 
 * **Must be called from within a Durable Object** as it uses `ctx.id`.
 * 
 * @typeParam P - Type of the Durable Object instance (for handler method name type safety)
 * @param doInstance - The Durable Object instance (pass `this` from within DO methods)
 * @param req - Request object or URL string to fetch
 * @param doBindingName - Name of the DO binding for return routing
 * @param handler - Optional name of the handler method on the DO to call with the response. If omitted, fire-and-forget mode (no callback). TypeScript will autocomplete valid method names.
 * @param options - Optional configuration for timeout, retries, etc.
 * @returns Promise that resolves with the request ID when the request is enqueued
 * @throws Error if handler is provided but doesn't exist as a method on the DO instance
 * @throws Error if neither PROXY_FETCH_DO nor PROXY_FETCH_QUEUE binding is found
 */
export async function proxyFetch<P extends { [key: string]: any }>(
  doInstance: P,
  req: Request | string,
  doBindingName: string,
  handler?: keyof P & string,
  options?: ProxyFetchOptions,
  proxyInstanceNameOrId?: string
): Promise<string> {
  // Auto-detect which variant to use
  if (doInstance.env.PROXY_FETCH_DO) {
    // Use DO variant
    return proxyFetchDO(doInstance, req, doBindingName, handler, options, proxyInstanceNameOrId);
  } else if (doInstance.env.PROXY_FETCH_QUEUE) {
    // Use Queue variant
    return proxyFetchQueue(doInstance, req, doBindingName, handler, options);
  } else {
    throw new Error('Neither PROXY_FETCH_DO nor PROXY_FETCH_QUEUE binding found in env');
  }
}

/**
 * Send a fetch request to be executed by a ProxyFetchDO.
 * 
 * This is the DO variant that uses a dedicated Durable Object for fetch processing.
 * For most use cases, prefer using the auto-detecting `proxyFetch()` function instead.
 * 
 * @typeParam P - Type of the Durable Object instance (for handler method name type safety)
 * @param doInstance - The Durable Object instance (pass `this` from within DO methods)
 * @param req - Request object or URL string to fetch
 * @param doBindingName - Name of the DO binding for return routing
 * @param handler - Optional name of the handler method on the DO to call with the response. TypeScript will autocomplete valid method names.
 * @param options - Optional configuration for timeout, retries, etc.
 * @returns Promise that resolves with the request ID when the request is enqueued
 */
export async function proxyFetchDO<P extends { [key: string]: any }>(
  doInstance: P,
  req: Request | string,
  doBindingName: string,
  handler?: keyof P & string,
  options?: ProxyFetchOptions,
  proxyInstanceNameOrId: string = 'proxy-fetch-global'
): Promise<string> {
  // Validate handler exists if provided
  if (handler && typeof doInstance[handler] !== 'function') {
    throw new Error(`Handler method '${handler}' not found on DO instance`);
  }
  
  // Generate unique request ID
  const reqId = generateReqId();
  
  // Convert string URL to Request if needed
  const request = typeof req === 'string' ? new Request(req) : req;
  
  // Encode the Request object for transmission
  const serializedRequest = await encodeRequest(request);
  
  // Create message for ProxyFetchDO
  const queueMessage: ProxyFetchQueueMessage = {
    reqId,
    request: serializedRequest,
    doBindingName,
    instanceId: doInstance.ctx.id.toString(),
    handlerName: handler, // Optional - undefined for fire-and-forget
    retryCount: 0,
    timestamp: Date.now(),
    options,
  };
  
  // Get the ProxyFetchDO binding
  const proxyFetchDO = doInstance.env.PROXY_FETCH_DO;
  if (!proxyFetchDO) {
    throw new Error('PROXY_FETCH_DO binding not found in env');
  }
  
  // Get stub for the specified instance (supports both name and 64-char hex ID)
  // Defaults to 'proxy-fetch-global' for backward compatibility
  const stub = getDOStub(proxyFetchDO, proxyInstanceNameOrId);
  
  // Enqueue the request
  await stub.enqueue(queueMessage);
  
  return reqId;
}

/**
 * Send a fetch request to be executed by a Worker via queue.
 * 
 * This is the Queue variant that uses Cloudflare Queues for message passing.
 * For most use cases, prefer using the auto-detecting `proxyFetch()` function instead.
 * 
 * @typeParam P - Type of the Durable Object instance (for handler method name type safety)
 * @param doInstance - The Durable Object instance (pass `this` from within DO methods)
 * @param req - Request object or URL string to fetch
 * @param doBindingName - Name of the DO binding for return routing
 * @param handler - Optional name of the handler method on the DO to call with the response. TypeScript will autocomplete valid method names.
 * @param options - Optional configuration for timeout, retries, etc.
 * @returns Promise that resolves with the request ID when the request is queued
 */
export async function proxyFetchQueue<P extends { [key: string]: any }>(
  doInstance: P,
  req: Request | string,
  doBindingName: string,
  handler?: keyof P & string,
  options?: ProxyFetchOptions
): Promise<string> {
  // Validate handler exists if provided
  if (handler && typeof doInstance[handler] !== 'function') {
    throw new Error(`Handler method '${handler}' not found on DO instance`);
  }
  
  // Generate unique request ID
  const reqId = generateReqId();
  
  // Convert string URL to Request if needed
  const request = typeof req === 'string' ? new Request(req) : req;
  
  // Encode the Request object for queue transmission
  const serializedRequest = await encodeRequest(request);
  
  // Send message to queue with all data needed for processing and callback
  const queueMessage: ProxyFetchQueueMessage = {
    reqId,
    request: serializedRequest,
    doBindingName,
    instanceId: doInstance.ctx.id.toString(),
    handlerName: handler, // Optional - undefined for fire-and-forget
    retryCount: 0,
    timestamp: Date.now(),
    options,
  };
  
  await doInstance.env.PROXY_FETCH_QUEUE.send(queueMessage);
  return reqId;
}

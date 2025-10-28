import { serializeWebApiObject } from '@lumenize/utils';
import type { ProxyFetchQueueMessage, ProxyFetchOptions } from './types';

/**
 * Generate a unique request ID using crypto.randomUUID
 */
function generateReqId(): string {
  return crypto.randomUUID();
}

/**
 * Send a fetch request to be executed by a ProxyFetchDO.
 * 
 * This function allows Durable Objects to offload external fetch() calls to a
 * dedicated ProxyFetchDO, avoiding wall-clock billing. The response is delivered
 * later via a callback handler method on the DO, or not at all if handler is
 * omitted (fire-and-forget).
 * 
 * **Must be called from within a Durable Object** as it uses `ctx.id`.
 * 
 * @param doInstance - The Durable Object instance (pass `this` from within DO methods)
 * @param req - Request object or URL string to fetch
 * @param doBindingName - Name of the DO binding for return routing
 * @param handler - Optional name of the handler method on the DO to call with the response. If omitted, fire-and-forget mode (no callback).
 * @param options - Optional configuration for timeout, retries, etc.
 * @returns Promise that resolves with the request ID when the request is enqueued
 * @throws Error if handler is provided but doesn't exist as a method on the DO instance
 */
export async function proxyFetchDO(
  doInstance: any, // DurableObject instance with ctx and env properties
  req: Request | string,
  doBindingName: string,
  handler?: string,
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
  
  // Serialize the Request object for transmission
  const serializedRequest = await serializeWebApiObject(request);
  
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
  
  // Get the global ProxyFetchDO instance
  const proxyFetchDO = doInstance.env.PROXY_FETCH_DO;
  if (!proxyFetchDO) {
    throw new Error('PROXY_FETCH_DO binding not found in env');
  }
  
  // Use the named 'proxy-fetch-global' instance
  const id = proxyFetchDO.idFromName('proxy-fetch-global');
  const stub = proxyFetchDO.get(id);
  
  // Enqueue the request
  await stub.enqueue(queueMessage);
  
  return reqId;
}

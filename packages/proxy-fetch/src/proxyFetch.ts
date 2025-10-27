import { serializeWebApiObject } from './web-api-serialization';
import type { ProxyFetchMetadata, ProxyFetchQueueMessage } from './types';

/**
 * Generate a unique request ID using crypto.randomUUID
 */
function generateReqId(): string {
  return crypto.randomUUID();
}

/**
 * Send a fetch request to be executed by a Worker via queue.
 * 
 * This function allows Durable Objects to offload external fetch() calls to Workers,
 * avoiding wall-clock billing. The response is delivered asynchronously via a callback
 * handler method on the DO.
 * 
 * **Must be called from within a Durable Object** as it uses `ctx.storage` and `ctx.id`.
 * 
 * @param doInstance - The Durable Object instance (pass `this` from within DO methods)
 * @param req - Request object or URL string to fetch
 * @param handler - Name of the handler method on the DO to call with the response
 * @param doBindingName - Name of the DO binding for return routing
 * @returns Promise that resolves when the request is queued
 */
export async function proxyFetch(
  doInstance: any, // DurableObject instance with ctx and env properties
  req: Request | string,
  handler: string,
  doBindingName: string
): Promise<void> {
  // Generate unique request ID
  const reqId = generateReqId();
  
  // Convert string URL to Request if needed
  const request = typeof req === 'string' ? new Request(req) : req;
  
  // Serialize the Request object for queue transmission
  const serializedRequest = await serializeWebApiObject(request);
  
  // Store metadata in DO storage for later handler lookup
  const metadata: ProxyFetchMetadata = {
    handlerName: handler,
    doBindingName,
    instanceId: doInstance.ctx.id.toString(),
    timestamp: Date.now(),
  };
  doInstance.ctx.storage.kv.put(`proxy-fetch:${reqId}`, JSON.stringify(metadata));
  
  // Send message to queue
  const queueMessage: ProxyFetchQueueMessage = {
    reqId,
    request: serializedRequest,
    doBindingName,
    instanceId: doInstance.ctx.id.toString(),
  };
  
  await doInstance.env.PROXY_FETCH_QUEUE.send(queueMessage);
}

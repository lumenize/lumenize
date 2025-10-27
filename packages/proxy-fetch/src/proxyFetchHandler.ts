import type { ProxyFetchHandlerItem, ProxyFetchMetadata } from './types';
import { deserializeWebApiObject } from './web-api-serialization';

/**
 * Routes a proxy fetch response to the appropriate user handler method.
 * 
 * This function is called by the queue consumer via Workers RPC and should be
 * exposed as a method on your Durable Object:
 * 
 * ```typescript
 * async proxyFetchHandler(item: ProxyFetchHandlerItem) {
 *   return proxyFetchHandler(this, item);
 * }
 * ```
 * 
 * @param doInstance - The Durable Object instance (must have ctx property)
 * @param item - Response or error from the fetch operation
 */
export async function proxyFetchHandler(
  doInstance: any,
  item: ProxyFetchHandlerItem
): Promise<void> {
  const { reqId, response: serializedResponse, error } = item;
  
  // Retrieve metadata from storage
  const metadataJson = doInstance.ctx.storage.kv.get(`proxy-fetch:${reqId}`);
  if (!metadataJson) {
    throw new Error(`No metadata found for proxy-fetch request ${reqId}`);
  }
  
  const metadata: ProxyFetchMetadata = JSON.parse(metadataJson);
  const { handlerName } = metadata;
  
  // Clean up metadata from storage
  doInstance.ctx.storage.kv.delete(`proxy-fetch:${reqId}`);
  
  // Get the handler method
  const handler = doInstance[handlerName];
  if (typeof handler !== 'function') {
    throw new Error(`Handler method '${handlerName}' not found on DO instance`);
  }
  
  // Deserialize response if present
  const response = serializedResponse ? deserializeWebApiObject(serializedResponse) : undefined;
  
  // Call the user's handler method
  await handler.call(doInstance, { reqId, response, error });
}

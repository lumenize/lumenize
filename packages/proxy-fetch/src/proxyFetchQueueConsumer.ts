import { deserializeWebApiObject, serializeWebApiObject } from './web-api-serialization';
import type { ProxyFetchQueueMessage, ProxyFetchHandlerItem, ProxyFetchCapable } from './types';

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
 * @param env - Environment with DO bindings for return routing
 */
export async function proxyFetchQueueConsumer(
  batch: MessageBatch,
  env: { [doBindingName: string]: DurableObjectNamespace }
): Promise<void> {
  // Process each message in the batch
  for (const message of batch.messages) {
    const queueMessage = message.body as ProxyFetchQueueMessage;
    const { reqId, request: serializedRequest, doBindingName, instanceId } = queueMessage;
    
    console.log(`Processing reqId: ${reqId}, binding: ${doBindingName}`);
    
    try {
      // Deserialize the Request object
      const request = deserializeWebApiObject(serializedRequest);
      console.log(`Fetching: ${request.url}`);
      
      // Make the external fetch (this runs on Worker with CPU billing)
      const response = await fetch(request);
      console.log(`Fetch complete: ${response.status} ${response.statusText}`);
      
      // Serialize the Response for Workers RPC
      const serializedResponse = await serializeWebApiObject(response);
      
      // Route back to the DO instance via Workers RPC
      const namespace = env[doBindingName];
      if (!namespace) {
        throw new Error(`DO binding ${doBindingName} not found in environment`);
      }
      
      const doId = namespace.idFromString(instanceId);
      const stub = namespace.get(doId) as unknown as ProxyFetchCapable;
      
      console.log(`Routing response to DO instance ${instanceId.slice(0, 16)}...`);
      
      // Call proxyFetchHandler on the DO
      const handlerItem: ProxyFetchHandlerItem = {
        reqId,
        response: serializedResponse,
      };
      
      await stub.proxyFetchHandler(handlerItem);
      console.log(`Successfully routed response for reqId: ${reqId}`);
      
    } catch (error) {
      console.error(`Error processing reqId ${reqId}:`, error);
      
      // If fetch or routing fails, route error back to DO
      try {
        const namespace = env[doBindingName];
        const doId = namespace.idFromString(instanceId);
        const stub = namespace.get(doId) as unknown as ProxyFetchCapable;
        
        const handlerItem: ProxyFetchHandlerItem = {
          reqId,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        
        await stub.proxyFetchHandler(handlerItem);
        console.log(`Successfully routed error for reqId: ${reqId}`);
      } catch (routingError) {
        // If we can't route the error back, log it
        console.error('Failed to route error back to DO:', routingError);
        console.error('Original error:', error);
      }
    }
  }
}

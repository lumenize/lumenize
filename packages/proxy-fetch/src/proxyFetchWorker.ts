/**
 * ProxyFetchWorker - DO-Worker Hybrid
 * 
 * Best of both worlds:
 * - Low latency (~50-100ms, no Cloudflare Queue wait)
 * - High scalability (Workers do fetches, not blocked by single DO)
 * - Cost-effective (Workers use CPU billing, not wall-clock)
 * 
 * Architecture:
 * 1. Origin DO → FetchOrchestrator: Enqueue fetch with OCAN continuation
 * 2. FetchOrchestrator → Worker: Dispatch fetch
 * 3. Worker → External API: Execute fetch (CPU billing)
 * 4. Worker → Origin DO: Send result directly (no hop!)
 * 5. Worker → FetchOrchestrator: Mark complete
 */

import type { DurableObject } from 'cloudflare:workers';
import { getOperationChain, debug } from '@lumenize/core';
import { preprocess } from '@lumenize/structured-clone';
import type { FetchOrchestratorMessage, ProxyFetchWorkerOptions } from './types.js';

/**
 * Make an external fetch request using the DO-Worker hybrid approach
 * 
 * This function:
 * - Sends request to FetchOrchestrator DO
 * - Returns immediately (non-blocking)
 * - Worker executes fetch and calls your continuation with result
 * 
 * @param doInstance - The DO instance making the request
 * @param request - URL string or Request object
 * @param continuation - OCAN continuation that receives Response | Error
 * @param options - Optional configuration
 * @returns Request ID (for correlation)
 * 
 * @example
 * ```typescript
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * import { proxyFetchWorker } from '@lumenize/proxy-fetch';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async fetchUserData(userId: string) {
 *     const request = new Request(`https://api.example.com/users/${userId}`);
 *     
 *     await proxyFetchWorker(
 *       this,
 *       request,
 *       this.ctn().handleFetchResult(this.ctn().$result), // $result is placeholder
 *       { originBinding: 'MY_DO' }
 *     );
 *   }
 *   
 *   handleFetchResult(result: Response | Error) {
 *     if (result instanceof Error) {
 *       console.error('Fetch failed:', result);
 *       return;
 *     }
 *     // Process response
 *     const data = await result.json();
 *     this.ctx.storage.kv.put('user-data', data);
 *   }
 * }
 * ```
 */
export async function proxyFetchWorker(
  doInstance: DurableObject,
  request: string | Request,
  continuation: any, // OCAN continuation
  options?: ProxyFetchWorkerOptions
): Promise<string> {
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.proxyFetch.worker');

  // Validate continuation
  const continuationChain = getOperationChain(continuation);
  if (!continuationChain) {
    throw new Error('Invalid continuation: must be created with this.ctn()');
  }

  // Generate request ID
  const reqId = crypto.randomUUID();

  // Normalize request to Request object
  const requestObj = typeof request === 'string' ? new Request(request) : request;

  // Get origin binding (for callbacks)
  const originBinding = options?.originBinding || getOriginBinding(doInstance);

  log.debug('Initiating proxy fetch', {
    reqId,
    url: requestObj.url,
    originBinding
  });

  // Preprocess request and continuation for transmission
  const preprocessedRequest = await preprocess(requestObj);
  const preprocessedContinuation = await preprocess(continuationChain);

  // Store pending continuation in origin DO storage
  // This will be retrieved when the result comes back
  const pendingKey = `proxyFetch_pending:${reqId}`;
  ctx.storage.kv.put(pendingKey, JSON.stringify({
    reqId,
    continuationChain: preprocessedContinuation,
    timestamp: Date.now()
  }));

  // Prepare message for FetchOrchestrator
  // Note: We don't send the continuation to the orchestrator/worker
  // It stays stored locally and is executed when the result returns
  const message: FetchOrchestratorMessage = {
    reqId,
    request: preprocessedRequest,
    originBinding,
    originId: ctx.id.toString(),
    options,
    timestamp: Date.now()
  };

  // Send to FetchOrchestrator
  try {
    const orchestratorId = env.FETCH_ORCHESTRATOR.idFromName('singleton');
    const orchestrator = env.FETCH_ORCHESTRATOR.get(orchestratorId);
    
    await orchestrator.enqueueFetch(message);
    
    log.debug('Request enqueued', { reqId });
  } catch (error) {
    log.error('Failed to enqueue request', {
      reqId,
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Clean up pending on failure
    ctx.storage.kv.delete(pendingKey);
    throw new Error(`Failed to enqueue fetch request: ${error}`);
  }

  return reqId;
}

/**
 * Get the binding name for this DO in the environment
 * @internal
 */
function getOriginBinding(doInstance: any): string {
  // Try to get from constructor name as fallback
  const constructorName = doInstance.constructor.name;
  
  // For LumenizeBase DOs, try to infer from env
  const env = doInstance.env;
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value && typeof value === 'object' && 'idFromName' in value) {
        // This looks like a DO binding
        // Check if it matches our instance type
        if (value.constructor?.name === constructorName) {
          return key;
        }
      }
    }
  }
  
  // Fallback: Use constructor name
  // User may need to configure this explicitly in production
  return constructorName.replace(/DO$/, '_DO').toUpperCase();
}


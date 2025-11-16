/**
 * ProxyFetch - DO-Worker Hybrid (RPC-Based Architecture)
 * 
 * Best of both worlds:
 * - Type-safe RPC (service bindings, strongly typed)
 * - Low latency (~100-200ms, no Cloudflare Queue wait)
 * - High scalability (Workers do fetches via CPU-billed execution)
 * - Cost-effective (minimal DO billing, Workers use CPU billing)
 * - No auth required (service bindings are account-scoped)
 * 
 * Architecture (Optimized for CPU Billing):
 * 1. Origin DO → FetchOrchestrator: Enqueue fetch with OCAN continuation
 * 2. FetchOrchestrator → Worker (RPC): Quick dispatch, returns immediately
 * 3. Worker (ctx.waitUntil): Execute fetch in background (CPU billing only)
 * 4. Worker → External API: Fetch (could be seconds, CPU-billed)
 * 5. Worker → Origin DO: Send result directly (no hop!)
 * 6. Worker → FetchOrchestrator: Mark complete
 * 
 * Key Insight: FetchOrchestrator stops billing after quick RPC ack (~microseconds).
 * The actual fetch work happens in Worker context with CPU billing.
 * 
 * Setup:
 * - Export `FetchExecutorEntrypoint` from your worker
 * - Add service binding in wrangler.jsonc (see FetchExecutorEntrypoint docs)
 */

import type { DurableObject } from 'cloudflare:workers';
import { debug } from '@lumenize/core';
import { getOperationChain } from '@lumenize/lumenize-base';
import { preprocess } from '@lumenize/structured-clone';
import type { FetchOrchestratorMessage, ProxyFetchWorkerOptions } from './types.js';

/**
 * Make an external fetch request using the DO-Worker hybrid approach
 * 
 * This function:
 * - Sends request to FetchOrchestrator DO
 * - Returns immediately (non-blocking)
 * - Worker executes fetch via RPC and calls your continuation with result
 * 
 * **Setup Required**:
 * 1. Export `FetchExecutorEntrypoint` from your worker
 * 2. Add service binding in wrangler.jsonc (see FetchExecutorEntrypoint docs)
 * 
 * @param doInstance - The DO instance making the request
 * @param request - URL string or Request object
 * @param continuation - OCAN continuation that receives Response | Error
 * @param options - Optional configuration (executorBinding, originBinding, timeout, etc)
 * @returns Request ID (for correlation)
 * 
 * @example
 * ```typescript
 * // In your worker:
 * export { FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
 * 
 * // In wrangler.jsonc:
 * {
 *   "services": [{
 *     "binding": "FETCH_EXECUTOR",
 *     "service": "my-worker",
 *     "entrypoint": "FetchExecutorEntrypoint"
 *   }]
 * }
 * 
 * // In your DO:
 * class MyDO extends LumenizeBase<Env> {
 *   async fetchUserData(userId: string) {
 *     const request = new Request(`https://api.example.com/users/${userId}`);
 *     
 *     const reqId = proxyFetch(
 *       this,
 *       request,
 *       this.ctn().handleFetchResult(),
 *       {
 *         originBinding: 'MY_DO',
 *         workerUrl: 'https://my-worker.my-subdomain.workers.dev'
 *       }
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
export async function proxyFetch(
  doInstance: DurableObject,
  request: string | Request,
  continuation: any, // OCAN continuation
  options?: ProxyFetchWorkerOptions
): Promise<string> {
  const ctx = doInstance.ctx as DurableObjectState;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.proxyFetch');
  
  log.debug('proxyFetch called', { requestType: typeof request });

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

  // Prepare message for FetchOrchestrator
  // Continuation travels through the pipeline (no storage at origin)
  const message: FetchOrchestratorMessage = {
    reqId,
    request: preprocessedRequest,
    continuation: preprocessedContinuation,
    originBinding,
    originId: ctx.id.toString(),
    options,
    timestamp: Date.now()
  };

  // Send to FetchOrchestrator
  try {
    const orchestratorBinding = options?.orchestratorBinding || 'FETCH_ORCHESTRATOR';
    const orchestratorInstanceName = options?.orchestratorInstanceName || 'singleton';
    
    log.debug('Looking for orchestrator binding', { 
      orchestratorBinding, 
      orchestratorInstanceName,
      availableBindings: Object.keys(env)
    });
    
    const orchestratorNamespace = env[orchestratorBinding];
    if (!orchestratorNamespace) {
      throw new Error(`FetchOrchestrator binding '${orchestratorBinding}' not found in env`);
    }
    
    const orchestratorId = orchestratorNamespace.idFromName(orchestratorInstanceName);
    const orchestrator = orchestratorNamespace.get(orchestratorId);
    
    log.debug('Calling orchestrator.enqueueFetch', { reqId });
    await orchestrator.enqueueFetch(message);
    
    log.debug('Request enqueued', { reqId });
  } catch (error) {
    log.error('Failed to enqueue request', {
      reqId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
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


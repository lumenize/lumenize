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
 * 1. Call `__lmzInit({ doBindingName })` in your DO constructor
 * 2. Export `FetchExecutorEntrypoint` from your worker
 * 3. Add service binding in wrangler.jsonc (see FetchExecutorEntrypoint docs)
 * 
 * @param doInstance - The DO instance making the request
 * @param request - URL string or Request object
 * @param continuation - OCAN continuation that receives ResponseSync | Error
 * @param options - Optional configuration (executorBinding, timeout, etc)
 * @param reqId - Optional request ID (generated if not provided). Useful for testing and log correlation.
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
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.__lmzInit({ doBindingName: 'MY_DO' });
 *   }
 * 
 *   async fetchUserData(userId: string) {
 *     const request = new Request(`https://api.example.com/users/${userId}`);
 *     
 *     const reqId = await this.svc.proxyFetch(
 *       request,
 *       this.ctn().handleFetchResult()
 *     );
 *   }
 *   
 *   handleFetchResult(result: ResponseSync | Error) {
 *     if (result instanceof Error) {
 *       console.error('Fetch failed:', result);
 *       return;
 *     }
 *     // Process response
 *     const data = result.json(); // Synchronous!
 *     this.ctx.storage.kv.put('user-data', data);
 *   }
 * }
 * ```
 */
export async function proxyFetch(
  doInstance: DurableObject,
  request: string | Request,
  continuation: any, // OCAN continuation
  options?: ProxyFetchWorkerOptions,
  reqId?: string
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

  // Use provided reqId or generate one
  const finalReqId = reqId ?? crypto.randomUUID();

  // Normalize request to Request object
  const requestObj = typeof request === 'string' ? new Request(request) : request;

  // Get origin binding from storage (set via __lmzInit)
  const originBinding = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
  
  if (!originBinding) {
    throw new Error(
      `Cannot use proxyFetch() from a DO that doesn't know its own binding name. ` +
      `Call __lmzInit({ doBindingName }) in your DO constructor.`
    );
  }

  log.debug('Initiating proxy fetch', {
    reqId: finalReqId,
    url: requestObj.url,
    originBinding
  });

  // Preprocess request and continuation for transmission
  const preprocessedRequest = await preprocess(requestObj);
  const preprocessedContinuation = await preprocess(continuationChain);

  // Prepare message for FetchOrchestrator
  // Continuation travels through the pipeline (no storage at origin)
  const message: FetchOrchestratorMessage = {
    reqId: finalReqId,
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
    
    log.debug('Calling orchestrator.enqueueFetch', { reqId: finalReqId });
    await orchestrator.enqueueFetch(message);
    
    log.debug('Request enqueued', { reqId: finalReqId });
  } catch (error) {
    log.error('Failed to enqueue request', {
      reqId: finalReqId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    throw new Error(`Failed to enqueue fetch request: ${error}`);
  }

  return finalReqId;
}


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

import { debug } from '@lumenize/core';
import { getOperationChain, type LumenizeBase } from '@lumenize/lumenize-base';
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
 * 1. Your DO must extend `LumenizeBase`
 * 2. Call `this.lmz.init({ bindingName })` in your DO constructor
 * 3. Export `FetchExecutorEntrypoint` from your worker
 * 4. Add service binding in wrangler.jsonc (see FetchExecutorEntrypoint docs)
 * 
 * @param doInstance - The LumenizeBase DO instance making the request
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
 *     this.lmz.init({ bindingName: 'MY_DO' });
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
  doInstance: LumenizeBase,
  request: string | Request,
  continuation: any, // OCAN continuation
  options?: ProxyFetchWorkerOptions,
  reqId?: string
): Promise<string> {
  const ctx = doInstance.ctx;
  const env = doInstance.env;
  const log = debug(doInstance)('lmz.proxyFetch');
  
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

  // Get origin binding from DO instance  
  const originBinding = doInstance.lmz?.bindingName;
  
  if (!originBinding) {
    throw new Error(
      `Cannot use proxyFetch() from a DO that doesn't know its own binding name. ` +
      `Call this.lmz.init({ bindingName }) in your DO constructor or ensure ` +
      `routeDORequest() is used to set headers automatically.`
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

  // Send to FetchOrchestrator using this.lmz.callRaw()
  try {
    const orchestratorBinding = options?.orchestratorBinding || 'FETCH_ORCHESTRATOR';
    const orchestratorInstanceName = options?.orchestratorInstanceName || 'singleton';
    
    log.debug('Calling orchestrator via callRaw', { 
      orchestratorBinding, 
      orchestratorInstanceName,
      reqId: finalReqId
    });
    
    // Create continuation for the enqueueFetch call
    log.debug('Creating remote continuation for enqueueFetch', { reqId: finalReqId });
    const remoteContinuation = doInstance.ctn().enqueueFetch(message);
    
    log.debug('Calling orchestrator.enqueueFetch via callRaw', { 
      reqId: finalReqId,
      orchestratorBinding,
      orchestratorInstanceName
    });
    
    // Use callRaw for DO-to-DO RPC with automatic metadata propagation
    await doInstance.lmz.callRaw(
      orchestratorBinding,
      orchestratorInstanceName,
      remoteContinuation
    );
    
    log.debug('Request enqueued successfully via callRaw', { reqId: finalReqId });
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


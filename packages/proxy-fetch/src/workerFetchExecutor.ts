/**
 * Worker Fetch Executor - Executes fetches using CPU billing
 * 
 * This function runs via ctx.waitUntil() in FetchExecutorEntrypoint:
 * 1. FetchOrchestrator calls executeFetch() via RPC (quick ack, returns immediately)
 * 2. This function executes in background (CPU billing, not wall-clock)
 * 3. Executes the external fetch (could be seconds)
 * 4. Sends result DIRECTLY to origin DO (no hop through orchestrator!)
 * 5. Notifies orchestrator of completion
 * 
 * Benefits:
 * - FetchOrchestrator stops billing immediately (quick RPC round-trip)
 * - Fetch executes in Worker context (CPU billing only)
 * - No wall-clock billing during external fetch wait time
 * - Direct result delivery (lower latency)
 * - Scales automatically with Worker pool
 */

import { debug } from '@lumenize/core';
import { preprocess, postprocess, ResponseSync } from '@lumenize/structured-clone';
import { replaceNestedOperationMarkers } from '@lumenize/lumenize-base';
import type { WorkerFetchMessage } from './types.js';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Execute a fetch request
 * 
 * This is called by `FetchExecutorEntrypoint` when invoked via RPC from FetchOrchestrator.
 * 
 * @param message - The fetch request message
 * @param env - Worker environment (must contain DO bindings for result delivery)
 * @internal
 */
export async function executeFetch(
  message: WorkerFetchMessage,
  env: any
): Promise<void> {
  const log = debug({ id: { toString: () => 'worker' } })('lmz.proxyFetch.worker');
  
  log.debug('Executing fetch', {
    reqId: message.reqId,
    retryCount: message.retryCount
  });

  const startTime = Date.now();
  let result: ResponseSync | Error;

  try {
    // Deserialize Request object
    const request = await postprocess(message.request) as Request;
    
    // Execute fetch with timeout
    const timeout = message.options?.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(request, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      // Convert Response to ResponseSync (synchronous body access)
      result = await ResponseSync.fromResponse(response);
      
      log.debug('Fetch completed', {
        reqId: message.reqId,
        status: result.status,
        duration: Date.now() - startTime
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (e) {
    result = e instanceof Error ? e : new Error(String(e));
    log.error('Fetch failed', {
      reqId: message.reqId,
      error: result.message,
      duration: Date.now() - startTime
    });
  }

  // Send result to origin DO using operation chain pattern
  log.debug('Sending result to origin DO', { 
    reqId: message.reqId,
    resultType: result instanceof Error ? 'Error' : 'ResponseSync'
  });
  
  try {
    const originId = env[message.originBinding].idFromString(message.originId);
    const originDO = env[message.originBinding].get(originId);
    
    log.debug('Postprocessing continuation', {
      reqId: message.reqId,
      continuationType: typeof message.continuation
    });
    
    // Postprocess the continuation (deserialize it)
    const continuation = await postprocess(message.continuation);
    
    // Inject RAW result into continuation placeholder (not preprocessed!)
    const filledChain = await replaceNestedOperationMarkers(continuation, result);
    
    // Preprocess the filled chain for transmission via Workers RPC (one time only)
    const preprocessedChain = await preprocess(filledChain);
    
    log.debug('Calling __executeOperation on origin DO', { 
      reqId: message.reqId,
      chainPreview: JSON.stringify(preprocessedChain, null, 2).substring(0, 500)
    });
    
    // Send to origin DO (__executeOperation handles postprocessing)
    await originDO.__executeOperation(preprocessedChain);
    
    log.debug('Result sent to origin DO successfully', { reqId: message.reqId });
  } catch (callbackError) {
    log.error('Failed to send result to origin DO', {
      reqId: message.reqId,
      error: callbackError instanceof Error ? callbackError.message : String(callbackError)
    });
  }

  // Notify orchestrator that we're done (for queue cleanup)
  try {
    const orchestratorId = env.FETCH_ORCHESTRATOR.idFromName('singleton');
    const orchestrator = env.FETCH_ORCHESTRATOR.get(orchestratorId);
    await orchestrator.reportDelivery(message.reqId, true);
    
    log.debug('Notified orchestrator of completion', { reqId: message.reqId });
  } catch (notifyError) {
    log.error('Failed to notify orchestrator', {
      reqId: message.reqId,
      error: notifyError instanceof Error ? notifyError.message : String(notifyError)
    });
  }
}

/**
 * Worker RPC handler
 * 
 * Export this from your Worker to handle fetch execution requests.
 * 
 * @example
 * ```typescript
 * import { FetchWorker } from '@lumenize/proxy-fetch';
 * 
 * export default {
 *   async fetch(request, env) {
 *     // Your normal Worker code
 *     return new Response('OK');
 *   }
 * } satisfies ExportedHandler<Env> & FetchWorker;
 * ```
 */
export interface FetchWorker {
  executeFetch(message: WorkerFetchMessage): Promise<void>;
}

/**
 * Create a FetchWorker RPC handler
 * 
 * This creates the RPC methods that FetchOrchestrator will call.
 */
export function createFetchWorker(env: any): FetchWorker {
  return {
    async executeFetch(message: WorkerFetchMessage): Promise<void> {
      return await executeFetch(message, env);
    }
  };
}


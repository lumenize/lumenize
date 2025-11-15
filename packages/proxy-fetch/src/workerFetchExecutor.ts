/**
 * Worker Fetch Executor - Executes fetches using CPU billing
 * 
 * This function runs via RPC (FetchExecutorEntrypoint):
 * 1. Receives fetch request from FetchOrchestrator (RPC call)
 * 2. Executes the fetch (CPU billing, not wall-clock)
 * 3. Sends result DIRECTLY to origin DO (no hop through orchestrator!)
 * 4. Notifies orchestrator of completion
 * 
 * Benefits:
 * - Type-safe RPC (service bindings)
 * - No auth required (account-scoped)
 * - CPU billing for fetch wait time (not wall-clock)
 * - Direct result delivery (lower latency)
 * - Scales automatically with Worker pool
 */

import { debug } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { WorkerFetchMessage, FetchResult } from './types.js';

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
  let response: Response | undefined;
  let error: Error | undefined;

  try {
    // Deserialize Request object
    const request = await postprocess(message.request) as Request;
    
    // Execute fetch with timeout
    const timeout = message.options?.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      response = await fetch(request, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      log.debug('Fetch completed', {
        reqId: message.reqId,
        status: response.status,
        duration: Date.now() - startTime
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    log.error('Fetch failed', {
      reqId: message.reqId,
      error: error.message,
      duration: Date.now() - startTime
    });
  }

  // Prepare result
  const result: FetchResult = {
    reqId: message.reqId,
    response: response ? await preprocess(response) : undefined,
    error,
    retryCount: message.retryCount,
    duration: Date.now() - startTime
  };

  // Send result DIRECTLY to origin DO (no hop through orchestrator!)
  try {
    const originId = env[message.originBinding].idFromString(message.originId);
    const originDO = env[message.originBinding].get(originId);
    
    // Preprocess result for transmission
    const preprocessedResult = await preprocess(result);
    
    // Use the generic actor queue's __receiveResult method
    // The origin DO will retrieve the stored continuation and execute it
    await originDO.__receiveResult('proxyFetch', message.reqId, preprocessedResult);
    
    log.debug('Result sent to origin DO', { reqId: message.reqId });
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
    await orchestrator.markComplete(message.reqId);
    
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


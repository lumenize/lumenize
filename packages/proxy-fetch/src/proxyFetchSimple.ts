/**
 * ProxyFetchSimple - Clean v2 Implementation
 * 
 * Simplified DO-Worker architecture without FetchOrchestrator.
 * Built from scratch applying learnings from WIP debugging session.
 * 
 * Architecture:
 * 1. Origin DO schedules alarm with embedded continuation
 * 2. Origin DO calls Worker directly via this.lmz.callRaw()
 * 3. Worker executes fetch (CPU billing)
 * 4. Worker OR alarm calls single handler with result/error + embedded continuation
 * 5. Handler cancels alarm atomically - winner gets continuation and executes it
 * 
 * Key Patterns (from Phase 2b):
 * - Explicit ID: schedule(when, continuation, { id: reqId })
 * - Atomic Cancel: cancelSchedule(reqId) returns Schedule | undefined
 * - Continuation Embedding: preprocess user continuation, embed in both paths
 * - Single Handler: handleFetchResult() called by both worker and alarm
 * - Worker $result Filling: replaceNestedOperationMarkers before callRaw
 */

import { debug } from '@lumenize/core';
import { getOperationChain, type LumenizeBase } from '@lumenize/lumenize-base';
import { preprocess, stringify } from '@lumenize/structured-clone';
import type { ProxyFetchWorkerOptions } from './types.js';

/**
 * Message sent from origin DO to Worker Executor
 * @internal
 */
export interface SimpleFetchMessage {
  reqId: string;
  request: any; // Preprocessed Request object
  originBinding: string;
  originId: string;
  url: string;
  stringifiedUserContinuation: string;  // User's continuation as JSON string
  options?: ProxyFetchWorkerOptions;
  fetchTimeout: number;
}

/**
 * Make an external fetch request using simplified DO-Worker architecture.
 * 
 * No FetchOrchestrator - all coordination in origin DO via @lumenize/alarms.
 * 
 * **Setup Required**:
 * 1. Your DO must extend `LumenizeBase`
 * 2. Call `this.lmz.init({ bindingName })` in constructor
 * 3. Import `@lumenize/alarms` (registers NADIS plugin)
 * 4. Export `FetchExecutorEntrypoint` from your worker
 * 5. Add service binding in wrangler.jsonc
 * 6. Your DO must have `async alarm()` that calls `await this.svc.alarms.alarm()`
 * 
 * @param doInstance - The LumenizeBase DO instance making the request
 * @param request - URL string or Request object
 * @param continuation - User continuation that receives ResponseSync | Error
 * @param options - Optional configuration (timeout, executorBinding, testMode)
 * @param reqId - Optional request ID (generated if not provided)
 * @returns Request ID (for correlation/testing)
 * 
 * @example
 * ```typescript
 * import '@lumenize/core';
 * import '@lumenize/alarms';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * import { proxyFetchSimple } from '@lumenize/proxy-fetch';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.lmz.init({ bindingName: 'MY_DO' });
 *   }
 * 
 *   async alarm() {
 *     await this.svc.alarms.alarm();
 *   }
 * 
 *   async fetchUserData(userId: string) {
 *     // Just pass your continuation - no boilerplate needed!
 *     const reqId = await proxyFetchSimple(
 *       this,
 *       `https://api.example.com/users/${userId}`,
 *       this.ctn().handleResult(this.ctn().$result, userId)
 *     );
 *   }
 *   
 *   handleResult(result: ResponseSync | Error, userId: string) {
 *     if (result instanceof Error) {
 *       console.error('Fetch failed:', result);
 *     } else {
 *       const data = result.json(); // Synchronous!
 *       this.ctx.storage.kv.put(`user-data:${userId}`, data);
 *     }
 *   }
 * }
 * ```
 */
export async function proxyFetchSimple(
  doInstance: LumenizeBase,
  request: string | Request,
  continuation: any,
  options?: ProxyFetchWorkerOptions,
  reqId?: string
): Promise<string> {
  const ctx = doInstance.ctx;
  const env = doInstance.env;
  const log = debug(ctx)('lmz.proxyFetchSimple');

  // Validate continuation
  const continuationChain = getOperationChain(continuation);
  if (!continuationChain) {
    throw new Error('Invalid continuation: must be created with this.ctn()');
  }

  // Normalize request
  const requestObj = typeof request === 'string' ? new Request(request) : request;

  // Get origin identity
  const originBinding = doInstance.lmz?.bindingName;
  if (!originBinding) {
    throw new Error(
      'Cannot use proxyFetchSimple() from DO without bindingName. ' +
      'Call this.lmz.init({ bindingName }) in constructor.'
    );
  }

  // Calculate timing
  const timeout = options?.timeout ?? 30000;
  const alarmTimeout = options?.testMode?.orchestratorTimeoutOverride ?? timeout;
  const now = Date.now();
  const alarmFiresAt = new Date(now + alarmTimeout);

  // Generate reqId (or use provided for testing)
  const finalReqId = reqId ?? crypto.randomUUID();

  log.debug('Starting proxyFetchSimple', {
    url: requestObj.url,
    reqId: finalReqId,
    alarmTimeout,
    alarmFiresAt: alarmFiresAt.toISOString()
  });

  // Stringify user continuation for embedding as opaque data
  const stringifiedUserContinuation = await stringify(continuationChain);

  // Create timeout error for alarm path
  const timeoutError = new Error(
    `Fetch timeout - request exceeded timeout period. URL: ${requestObj.url}`
  );

  // Create alarm handler: internal method with embedded user continuation
  const alarmHandler = doInstance.ctn().__handleProxyFetchSimpleResult(
    finalReqId,
    timeoutError,  // Will be filled with actual error at alarm time
    stringifiedUserContinuation
  );

  // Schedule alarm with explicit ID
  doInstance.svc.alarms.schedule(alarmFiresAt, alarmHandler, { id: finalReqId });

  log.debug('Alarm scheduled', {
    reqId: finalReqId,
    alarmFiresAt: alarmFiresAt.toISOString()
  });

  // Preprocess request for transmission
  const preprocessedRequest = await preprocess(requestObj);

  // Prepare message for Worker
  const message: SimpleFetchMessage = {
    reqId: finalReqId,
    request: preprocessedRequest,
    originBinding,
    originId: ctx.id.toString(),
    url: requestObj.url,
    stringifiedUserContinuation,
    options,
    fetchTimeout: timeout
  };

  // Call Worker directly via this.lmz.callRaw()
  try {
    const executorBinding = options?.executorBinding || 'FETCH_EXECUTOR';
    const worker = (env as any)[executorBinding];
    
    if (!worker) {
      throw new Error(`Worker binding '${executorBinding}' not found in env`);
    }

    log.debug('Calling worker executor', {
      executorBinding,
      reqId: finalReqId
    });

    // Create continuation for executeFetchSimple call
    const remoteContinuation = doInstance.ctn().executeFetchSimple(message);

    // Use callRaw for automatic metadata propagation
    await doInstance.lmz.callRaw(
      executorBinding,
      undefined, // Workers don't have instance IDs
      remoteContinuation
    );

    log.debug('Worker called successfully', { reqId: finalReqId });
  } catch (error) {
    // If worker call fails, cancel alarm before throwing
    doInstance.svc.alarms.cancelSchedule(finalReqId);
    
    log.error('Failed to call worker executor', {
      reqId: finalReqId,
      error: error instanceof Error ? error.message : String(error)
    });
    
    throw new Error(`Failed to call worker executor: ${error}`);
  }

  return finalReqId;
}


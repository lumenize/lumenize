/**
 * ProxyFetch - DO-Worker architecture for external API calls
 * 
 * Two-hop architecture: Origin DO → Worker Executor → External API
 * All coordination in origin DO via @lumenize/alarms.
 * 
 * Architecture:
 * 1. Origin DO schedules alarm with embedded continuation
 * 2. Origin DO calls Worker directly via this.lmz.callRaw()
 * 3. Worker executes fetch (CPU billing)
 * 4. Worker OR alarm calls single handler with result/error + embedded continuation
 * 5. Handler cancels alarm atomically - winner gets continuation and executes it
 * 
 * Key Patterns:
 * - Explicit ID: schedule(when, continuation, { id: reqId })
 * - Atomic Cancel: cancelSchedule(reqId) returns Schedule | undefined
 * - Continuation Embedding: preprocess user continuation, embed in both paths
 * - Single Handler: __handleProxyFetchResult() called by both worker and alarm
 * - Worker $result Filling: replaceNestedOperationMarkers before callRaw
 */

import { debug } from '@lumenize/core';
import { getOperationChain, type LumenizeBase } from '@lumenize/lumenize-base';
import { stringify } from '@lumenize/structured-clone';
import type { ProxyFetchWorkerOptions } from './types';
import type { FetchExecutorEntrypoint } from './fetch-executor-entrypoint';

/**
 * Message sent from origin DO to Worker Executor
 * @internal
 */
export interface FetchMessage {
  reqId: string;
  request: string | Request; // URL string or Request object (callRaw handles serialization)
  originBinding: string;
  originId: string;
  options?: ProxyFetchWorkerOptions;
  fetchTimeout: number;
}

/**
 * Make an external fetch request using simplified DO-Worker architecture.
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
 * import { proxyFetch } from '@lumenize/proxy-fetch';
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
 *     const reqId = await proxyFetch(
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
export async function proxyFetch(
  doInstance: LumenizeBase,
  request: string | Request,
  continuation: any,
  options?: ProxyFetchWorkerOptions,
  reqId?: string
): Promise<string> {
  const ctx = (doInstance as any).ctx;
  const env = (doInstance as any).env;
  const log = debug(doInstance)('lmz.proxyFetch');

  // Validate continuation
  const continuationChain = getOperationChain(continuation);
  if (!continuationChain) {
    log.error('Invalid continuation passed to proxyFetch', {
      hasContinuation: !!continuation,
      continuationType: typeof continuation
    });
    throw new Error('Invalid continuation: must be created with this.ctn()');
  }

  // Get origin identity
  const originBinding = doInstance.lmz?.bindingName;
  if (!originBinding) {
    throw new Error(
      'Cannot use proxyFetch() from DO without bindingName. ' +
      'Call this.lmz.init({ bindingName }) in constructor.'
    );
  }

  // Extract URL for logging/error messages
  const url = typeof request === 'string' ? request : request.url;

  // Calculate timing
  const timeout = options?.timeout ?? 30000;
  const alarmTimeout = options?.testMode?.alarmTimeoutOverride ?? timeout;
  const now = Date.now();
  const alarmFiresAt = new Date(now + alarmTimeout);

  // Generate reqId (or use provided for testing)
  const finalReqId = reqId ?? crypto.randomUUID();

  log.debug('Starting proxyFetch', {
    url,
    reqId: finalReqId,
    alarmTimeout,
    alarmFiresAt: alarmFiresAt.toISOString(),
    originBinding
  });

  // Stringify user continuation for embedding as opaque data
  const stringifiedUserContinuation = await stringify(continuationChain);
  log.debug('Stringified user continuation for alarm handler', {
    reqId: finalReqId,
    continuationLength: stringifiedUserContinuation.length
  });

  // Create timeout error for alarm path
  const timeoutError = new Error(
    `Fetch timeout - request exceeded timeout period. URL: ${url}`
  );

  // Create alarm handler: internal method with embedded user continuation
  // Note: __handleProxyFetchResult is added to prototype when @lumenize/proxy-fetch is imported
  const alarmHandler = (doInstance.ctn() as any).__handleProxyFetchResult(
    finalReqId,
    timeoutError,  // Will be filled with actual error at alarm time
    stringifiedUserContinuation
  );

  // Schedule alarm with explicit ID
  log.debug('Scheduling alarm for timeout backstop', {
    reqId: finalReqId,
    alarmFiresAt: alarmFiresAt.toISOString(),
    alarmTimeout
  });
  
  doInstance.svc.alarms.schedule(alarmFiresAt, alarmHandler, { id: finalReqId });

  log.debug('Alarm scheduled successfully', {
    reqId: finalReqId
  });

  // Prepare message for Worker (callRaw handles serialization)
  // Note: stringifiedUserContinuation is NOT sent - it's embedded in the alarm
  // and extracted when the alarm is cancelled
  const message: SimpleFetchMessage = {
    reqId: finalReqId,
    request, // Raw string or Request - callRaw handles it
    originBinding,
    originId: ctx.id.toString(),
    options,
    fetchTimeout: timeout
  };

  // Call Worker directly via this.lmz.callRaw()
  try {
    const executorBinding = options?.executorBinding || 'FETCH_EXECUTOR';
    log.debug('Resolving worker binding', {
      reqId: finalReqId,
      executorBinding
    });
    
    const worker = (env as any)[executorBinding];
    
    if (!worker) {
      log.error('Worker binding not found in environment', {
        reqId: finalReqId,
        executorBinding,
        availableKeys: Object.keys(env).filter(k => !k.startsWith('__'))
      });
      throw new Error(`Worker binding '${executorBinding}' not found in env`);
    }

    log.debug('Worker binding resolved, calling via callRaw', {
      executorBinding,
      reqId: finalReqId,
      url
    });

    // Create continuation for executeFetchSimple call on remote worker
    const remoteContinuation = doInstance.ctn<FetchExecutorEntrypoint>().executeFetchSimple(message);

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


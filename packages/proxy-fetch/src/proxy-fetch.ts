/**
 * ProxyFetch - DO-Worker architecture for external API calls
 * 
 * Two-hop architecture: Origin DO → Worker Executor → External API
 * All coordination in origin DO via @lumenize/alarms.
 */

import { debug } from '@lumenize/core';
import { getOperationChain, type LumenizeBase } from '@lumenize/lumenize-base';
import { stringify, RequestSync } from '@lumenize/structured-clone';
import type { ProxyFetchWorkerOptions } from './types';
import type { FetchExecutorEntrypoint } from './fetch-executor-entrypoint';

/**
 * Message sent from origin DO to Worker Executor
 * @internal
 */
export interface FetchMessage {
  reqId: string;
  request: string | RequestSync; // URL string or RequestSync (callRaw handles serialization)
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
 * @param request - URL string or RequestSync object
 * @param continuation - User continuation that receives ResponseSync | Error
 * @param options - Optional configuration (timeout, executorBinding, testMode)
 * @param reqId - Optional request ID (generated if not provided)
 * @returns Request ID (for correlation/testing)
 */
export function proxyFetch(
  doInstance: LumenizeBase,
  request: string | RequestSync,
  continuation: any,
  options?: ProxyFetchWorkerOptions,
  reqId?: string
): string {
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
      "Assure DO's identity is initialized via automatic identity propogation by first being " +
      "called via routeDORequest or this.lmz.call(). Failing that, directly initialize " +
      "by calling this.lmz.init({ bindingName }) in constructor."
    );
  }

  // Extract URL for logging/error messages
  const url = typeof request === 'string' ? request : request.url || (request as RequestSync)._request.url;

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
  const stringifiedUserContinuation = stringify(continuationChain);
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
  const message: FetchMessage = {
    reqId: finalReqId,
    request, // Raw string or RequestSync - callRaw handles it
    originBinding,
    originId: ctx.id.toString(),
    options,
    fetchTimeout: timeout
  };

  // Call Worker directly via this.lmz.call() (fire-and-forget)
  // Worker will explicitly call back to __handleProxyFetchResult when done
  const executorBinding = options?.executorBinding || 'FETCH_EXECUTOR';
  
  log.debug('Calling worker via call()', {
    reqId: finalReqId,
    executorBinding,
    url
  });

  // call() returns immediately, uses blockConcurrencyWhile internally
  // No handler needed - worker explicitly calls back to __handleProxyFetchResult
  doInstance.lmz.call(
    executorBinding,
    undefined, // Workers don't have instance IDs
    doInstance.ctn<FetchExecutorEntrypoint>().executeFetch(message) as any
    // No handler - fire-and-forget (worker calls back explicitly)
  );

  log.debug('Worker call initiated (fire-and-forget)', { reqId: finalReqId });

  return finalReqId;
}


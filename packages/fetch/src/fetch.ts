/**
 * Fetch - NADIS plugin for external API calls from Durable Objects
 *
 * Provides two strategies:
 * - proxy(): DO-Worker architecture for cost-effective external API calls
 * - direct(): Direct fetch from DO (stub for future implementation)
 */

import { debug, type DebugLogger } from '@lumenize/debug';
import { NadisPlugin, getOperationChain, replaceNestedOperationMarkers, type LumenizeDO } from '@lumenize/mesh';
import { stringify, parse, RequestSync, type ResponseSync } from '@lumenize/structured-clone';
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
 * Fetch - NADIS plugin providing fetch strategies for Durable Objects
 *
 * @example
 * ```typescript
 * import '@lumenize/fetch';  // Registers fetch in this.svc
 * import { LumenizeDO } from '@lumenize/mesh';
 *
 * class MyDO extends LumenizeDO<Env> {
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.lmz.init({ bindingName: 'MY_DO' });
 *   }
 *
 *   fetchData(url: string) {
 *     // Proxied fetch (DO → Worker → External API)
 *     this.svc.fetch.proxy(
 *       url,
 *       this.ctn().handleResponse(this.ctn().$result)
 *     );
 *   }
 *
 *   handleResponse(result: ResponseSync | Error) {
 *     // Process result
 *   }
 * }
 * ```
 */
export class Fetch extends NadisPlugin {
  #log: DebugLogger;

  constructor(doInstance: any) {
    super(doInstance);
    
    // Eager dependency validation - fails immediately if alarms not available
    // (alarms is built-in to @lumenize/mesh, so this should always pass)
    if (!this.svc.alarms) {
      throw new Error('Fetch requires alarms service for timeout handling (should be built-in to @lumenize/mesh)');
    }
    
    this.#log = debug(doInstance as unknown as { env: { DEBUG?: string } })('lmz.fetch.Fetch');
  }

  /**
   * Make an external fetch request using DO-Worker architecture.
   *
   * **Setup Required**:
   * 1. Your DO must extend `LumenizeDO`
   * 2. Call `this.lmz.init({ bindingName })` in constructor
   * 3. Import `@lumenize/fetch` (registers NADIS plugin)
   * 4. Export `FetchExecutorEntrypoint` from your worker
   * 5. Add service binding in wrangler.jsonc
   *
   * @param request - URL string or RequestSync object
   * @param continuation - User continuation that receives ResponseSync | Error
   * @param options - Optional configuration (timeout, executorBinding, testMode)
   * @param reqId - Optional request ID (generated if not provided)
   * @returns Request ID (for correlation/testing)
   */
  proxy(
    request: string | RequestSync,
    continuation: any,
    options?: ProxyFetchWorkerOptions,
    reqId?: string
  ): string {
    // Validate continuation
    const continuationChain = getOperationChain(continuation);
    if (!continuationChain) {
      this.#log.error('Invalid continuation passed to proxy', {
        hasContinuation: !!continuation,
        continuationType: typeof continuation
      });
      throw new Error('Invalid continuation: must be created with this.ctn()');
    }

    // Get origin identity
    const originBinding = (this.doInstance as any).lmz?.bindingName;
    if (!originBinding) {
      throw new Error(
        'Cannot use proxy() from DO without bindingName. ' +
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

    this.#log.debug('Starting proxy fetch', {
      url,
      reqId: finalReqId,
      alarmTimeout,
      alarmFiresAt: alarmFiresAt.toISOString(),
      originBinding
    });

    // Stringify user continuation for embedding as opaque data
    const stringifiedUserContinuation = stringify(continuationChain);
    this.#log.debug('Stringified user continuation for alarm handler', {
      reqId: finalReqId,
      continuationLength: stringifiedUserContinuation.length
    });

    // Create timeout error for alarm path
    const timeoutError = new Error(
      `Fetch timeout - request exceeded timeout period. URL: ${url}`
    );

    // Create alarm handler: calls back to this DO's Fetch plugin
    // Alarm executes in the DO's context, so use this.doInstance.ctn()
    const alarmHandler = (this.doInstance.ctn() as any).svc.fetch.__handleProxyFetchResult(
      finalReqId,
      timeoutError,  // Will be filled with actual error at alarm time
      stringifiedUserContinuation
    );

    // Schedule alarm with explicit ID
    this.#log.debug('Scheduling alarm for timeout backstop', {
      reqId: finalReqId,
      alarmFiresAt: alarmFiresAt.toISOString(),
      alarmTimeout
    });
    
    this.svc.alarms.schedule(alarmFiresAt, alarmHandler, { id: finalReqId });

    this.#log.debug('Alarm scheduled successfully', {
      reqId: finalReqId
    });

    // Prepare message for Worker (callRaw handles serialization)
    const message: FetchMessage = {
      reqId: finalReqId,
      request,
      originBinding,
      originId: this.ctx.id.toString(),
      options,
      fetchTimeout: timeout
    };

    // Call Worker directly via lmz.call() (fire-and-forget)
    // Worker will explicitly call back to svc.fetch.__handleProxyFetchResult when done
    const executorBinding = options?.executorBinding || 'FETCH_EXECUTOR';
    
    this.#log.debug('Calling worker via call()', {
      reqId: finalReqId,
      executorBinding,
      url
    });

    // call() returns immediately, uses blockConcurrencyWhile internally
    // No handler needed - worker explicitly calls back to svc.fetch.__handleProxyFetchResult
    (this.doInstance as any).lmz.call(
      executorBinding,
      undefined, // Workers don't have instance IDs
      (this.doInstance as any).ctn<FetchExecutorEntrypoint>().executeFetch(message) as any
    );

    this.#log.debug('Worker call initiated (fire-and-forget)', { reqId: finalReqId });

    return finalReqId;
  }

  /**
   * Make a direct fetch request from the Durable Object.
   * 
   * **Status**: Stub for future implementation
   * 
   * This will provide a simpler API for direct fetches when you don't need
   * the DO-Worker architecture (e.g., for quick/simple external calls).
   * 
   * @param request - URL string or RequestSync object
   * @param continuation - User continuation that receives ResponseSync | Error
   * @param options - Optional configuration
   * @returns Request ID (for correlation/testing)
   */
  direct(
    request: string | RequestSync,
    continuation: any,
    options?: { timeout?: number }
  ): string {
    throw new Error('Fetch.direct() is not yet implemented. Use Fetch.proxy() for now.');
  }

  /**
   * Internal handler for proxy fetch results (both success and timeout paths).
   * This replaces the monkey-patched __handleProxyFetchResult on LumenizeDO prototype.
   * 
   * Called by:
   * - Worker executor on success (with response)
   * - Alarm handler on timeout (with error)
   * 
   * @internal
   */
  async __handleProxyFetchResult(
    reqId: string,
    result: any,
    stringifiedUserContinuation?: string
  ): Promise<void> {
    // Try to cancel alarm - returns schedule if successful (we won the race)
    const scheduleData = this.svc.alarms.cancelSchedule(reqId);
    
    if (!scheduleData) {
      // Alarm already fired or already cancelled - this is a noop
      return;
    }
    
    // If not provided (worker path), extract from the cancelled alarm's operation chain
    let continuation = stringifiedUserContinuation;
    if (!continuation) {
      const lastOp = scheduleData.operationChain[scheduleData.operationChain.length - 1];
      if (!lastOp || lastOp.type !== 'apply' || !Array.isArray(lastOp.args) || lastOp.args.length < 3) {
        throw new Error(`Invalid alarm continuation for reqId ${reqId}: expected apply operation with 3 arguments`);
      }
      continuation = lastOp.args[2];
      if (typeof continuation !== 'string') {
        throw new Error(`Invalid alarm continuation for reqId ${reqId}: expected string but got ${typeof continuation}`);
      }
    }
    
    // We won the race - parse user's continuation, fill $result, and execute
    // Skip @mesh decorator check since this is an internal framework continuation
    const userContinuation = parse(continuation);
    const filledChain = await replaceNestedOperationMarkers(userContinuation, result);
    await (this.doInstance as any).__executeChain(filledChain, { requireMeshDecorator: false });
  }
}

// TypeScript declaration merging - augments LumenizeServices interface
// Provides type safety for this.svc.fetch
declare global {
  interface LumenizeServices {
    fetch: Fetch;
  }
}

// Register fetch service using NadisPlugin helper
NadisPlugin.register('fetch', (doInstance) => new Fetch(doInstance));


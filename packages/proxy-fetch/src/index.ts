/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * Uses a DO-Worker hybrid architecture where a Durable Object manages the queue
 * and Workers perform CPU-billed fetch execution.
 * 
 * @module @lumenize/proxy-fetch
 */

// Main API
export { proxyFetch } from './proxyFetch';

// Infrastructure components
export { FetchOrchestrator } from './FetchOrchestrator';
export { FetchExecutorEntrypoint } from './FetchExecutorEntrypoint';
export { executeFetch, createFetchWorker, type FetchWorker } from './workerFetchExecutor';

// Types
export type { 
  ProxyFetchWorkerOptions,
  FetchOrchestratorMessage,
  WorkerFetchMessage,
  FetchResult
} from './types';

// Register as NADIS service
import { proxyFetch } from './proxyFetch';
import type { ProxyFetchWorkerOptions } from './types';
import type { LumenizeBase } from '@lumenize/lumenize-base';

if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}

// Capture proxyFetch function in closure
const proxyFetchFn = proxyFetch;
(globalThis as any).__lumenizeServiceRegistry.proxyFetch = (doInstance: LumenizeBase) => {
  return (
    request: Request | string,
    continuation: any,
    options?: ProxyFetchWorkerOptions,
    reqId?: string
  ) => {
    return proxyFetchFn(doInstance, request, continuation, options, reqId);
  };
};

// TypeScript declaration merging for NADIS
declare global {
  interface LumenizeServices {
    /**
     * Make an external fetch request with continuation-based callback
     * 
     * Returns immediately with request ID. Result arrives later via continuation.
     * 
     * **Setup Required**: Call `this.lmz.init({ bindingName })` in your DO constructor.
     * 
     * @param request - URL string or Request object
     * @param continuation - OCAN continuation that receives ResponseSync | Error
     * @param options - Optional configuration (timeout, executorBinding, etc)
     * @param reqId - Optional request ID (generated if not provided). Useful for testing and log correlation.
     * @returns Request ID (for logging/debugging)
     * 
     * @example
     * ```typescript
     * class MyDO extends LumenizeBase {
     *   constructor(ctx: DurableObjectState, env: Env) {
     *     super(ctx, env);
     *     this.lmz.init({ bindingName: 'MY_DO' });
     *   }
     * 
     *   fetchUserData(userId: string) {
     *     const reqId = this.svc.proxyFetch(
     *       `https://api.example.com/users/${userId}`,
     *       this.ctn().handleResult({ userId })
     *     );
     *     // Returns immediately, result arrives later
     *   }
     *   
     *   handleResult(context: { userId: string }, result: ResponseSync | Error) {
     *     if (result instanceof Error) {
     *       console.error('Fetch failed:', result);
     *     } else {
     *       const data = result.json(); // Synchronous!
     *       console.log('User data:', data);
     *     }
     *   }
     * }
     * ```
     */
    proxyFetch(
      request: Request | string,
      continuation: any,
      options?: ProxyFetchWorkerOptions,
      reqId?: string
    ): Promise<string>;
  }
}

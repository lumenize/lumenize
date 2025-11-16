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

// Register Worker result handler with LumenizeBase
import { fetchWorkerResultHandler } from './fetchWorkerResultHandler';

if (!(globalThis as any).__lumenizeResultHandlers) {
  (globalThis as any).__lumenizeResultHandlers = {};
}
(globalThis as any).__lumenizeResultHandlers.proxyFetch = fetchWorkerResultHandler;

// Register as NADIS service
import { proxyFetch } from './proxyFetch';
import type { ProxyFetchWorkerOptions } from './types';

if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}

// Capture proxyFetch function in closure
const proxyFetchFn = proxyFetch;
(globalThis as any).__lumenizeServiceRegistry.proxyFetch = (doInstance: any) => {
  return (
    request: Request | string,
    continuation: any,
    options?: ProxyFetchWorkerOptions
  ) => {
    return proxyFetchFn(doInstance, request, continuation, options);
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
     * @param request - URL string or Request object
     * @param continuation - OCAN continuation that receives ResponseSync | Error
     * @param options - Optional configuration (timeout, executorBinding, etc)
     * @returns Request ID (for logging/debugging)
     * 
     * @example
     * ```typescript
     * class MyDO extends LumenizeBase {
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
      options?: ProxyFetchWorkerOptions
    ): Promise<string>;
  }
}

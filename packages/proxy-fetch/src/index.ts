/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * Uses a DO-Worker hybrid architecture where a Durable Object manages the queue
 * and Workers perform CPU-billed fetch execution.
 * 
 * **Note**: Previous `proxyFetchQueue` and `proxyFetchDO` variants have been removed.
 * `proxyFetchWorker` is superior in every way: better latency, linear scalability,
 * CPU-based billing for fetch operations, and simpler deployment. The old variants
 * remain in git history if needed.
 * 
 * @module @lumenize/proxy-fetch
 */

// Worker variant: DO-Worker Hybrid
export { proxyFetchWorker } from './proxyFetchWorker';
export { FetchOrchestrator } from './FetchOrchestrator';
export { executeFetch, createFetchWorker, type FetchWorker } from './workerFetchExecutor';
export { handleProxyFetchExecution, ProxyFetchAuthError, type HandleProxyFetchOptions } from './handleProxyFetchExecution';

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

/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * @module @lumenize/proxy-fetch
 */

// Legacy variants (Queue and DO)
export { proxyFetch, proxyFetchQueue, proxyFetchDO } from './proxyFetch';
export { proxyFetchQueueConsumer } from './proxyFetchQueueConsumer';
export { ProxyFetchDO } from './ProxyFetchDurableObject';

// Worker variant: DO-Worker Hybrid
export { proxyFetchWorker } from './proxyFetchWorker';
export { FetchOrchestrator } from './FetchOrchestrator';
export { executeFetch, createFetchWorker, type FetchWorker } from './workerFetchExecutor';

// Types
export type { 
  ProxyFetchQueueMessage, 
  ProxyFetchHandlerItem, 
  ProxyFetchOptions,
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

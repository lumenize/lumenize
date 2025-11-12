/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * @module @lumenize/proxy-fetch
 */

// Legacy variants (Queue and DO)
export { proxyFetch, proxyFetchQueue, proxyFetchDO } from './proxyFetch';
export { proxyFetchQueueConsumer } from './proxyFetchQueueConsumer';
export { ProxyFetchDO } from './ProxyFetchDurableObject';

// V3: DO-Worker Hybrid
export { proxyFetchV3 } from './proxyFetchV3';
export { FetchOrchestrator } from './FetchOrchestrator';
export { executeFetch, createFetchWorker, type FetchWorker } from './workerFetchExecutor';

// Types
export type { 
  ProxyFetchQueueMessage, 
  ProxyFetchHandlerItem, 
  ProxyFetchOptions,
  ProxyFetchV3Options,
  FetchOrchestratorMessage,
  WorkerFetchMessage,
  FetchResult
} from './types';

// Register V3 result handler with LumenizeBase
import { proxyFetchV3ResultHandler } from './proxyFetchV3ResultHandler';

if (!(globalThis as any).__lumenizeResultHandlers) {
  (globalThis as any).__lumenizeResultHandlers = {};
}
(globalThis as any).__lumenizeResultHandlers.proxyFetch = proxyFetchV3ResultHandler;

/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * @module @lumenize/proxy-fetch
 */

export { proxyFetch, proxyFetchQueue, proxyFetchDO } from './proxyFetch';
export { proxyFetchQueueConsumer } from './proxyFetchQueueConsumer';
export { ProxyFetchDO } from './ProxyFetchDurableObject';

export type { ProxyFetchQueueMessage, ProxyFetchHandlerItem, ProxyFetchOptions } from './types';

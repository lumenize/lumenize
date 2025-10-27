/**
 * Proxy fetch for cost-effective external API calls from Durable Objects.
 * 
 * @module @lumenize/proxy-fetch
 */

export { proxyFetch } from './proxyFetch';
export { proxyFetchQueueConsumer } from './proxyFetchQueueConsumer';

export type { ProxyFetchQueueMessage, ProxyFetchHandlerItem, ProxyFetchOptions } from './types';

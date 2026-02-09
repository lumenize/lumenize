/**
 * Fetch utilities for Durable Objects.
 * 
 * Provides two strategies for external API calls:
 * - proxy(): DO-Worker architecture for cost-effective external API calls
 * - direct(): Direct fetch from DO (stub for future implementation)
 * 
 * @module @lumenize/fetch
 */

// Main NADIS plugin (side-effect import registers it)
export { Fetch, type FetchMessage } from './fetch';

// Infrastructure components
export { FetchExecutorEntrypoint } from './fetch-executor-entrypoint';

// Errors
export { FetchTimeoutError } from './errors';

// Types
export type { ProxyFetchWorkerOptions } from './types';

// Side-effect import to register the NADIS plugin
import './fetch';

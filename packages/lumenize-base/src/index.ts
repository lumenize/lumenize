/**
 * @lumenize/lumenize-base - Base class with NADIS auto-injection
 * 
 * Provides automatic dependency injection for Cloudflare Durable Objects.
 */

export { LumenizeBase } from './lumenize-base';

// Re-export the global LumenizeServices interface type
// (actual interface is built via declaration merging in each NADIS package)
export type { LumenizeServices } from './types';


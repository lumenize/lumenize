/**
 * @lumenize/lumenize-base - Base class with NADIS auto-injection
 * 
 * Provides automatic dependency injection for Cloudflare Durable Objects.
 * Includes OCAN (Operation Chaining And Nesting) for actor-model communication.
 */

export { LumenizeBase } from './lumenize-base';
export type { Continuation } from './lumenize-base';

// Re-export the global LumenizeServices interface type
// (actual interface is built via declaration merging in each NADIS package)
export type { LumenizeServices } from './types';

// Re-export OCAN (Operation Chaining And Nesting)
// Actor-model communication infrastructure
export * from './ocan/index';


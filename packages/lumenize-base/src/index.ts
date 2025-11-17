/**
 * @lumenize/lumenize-base - Base class with NADIS auto-injection
 * 
 * Provides automatic dependency injection for Cloudflare Durable Objects.
 * Includes OCAN (Operation Chaining And Nesting) for actor-model communication.
 */

export { LumenizeBase } from './lumenize-base';
export type { Continuation } from './lumenize-base';

export { LumenizeWorker } from './lumenize-worker';
// Continuation type is the same for both LumenizeBase and LumenizeWorker

// Re-export Lumenize infrastructure API
export type { LmzApi, CallEnvelope, CallOptions } from './lmz-api';

// Re-export the global LumenizeServices interface type
// (actual interface is built via declaration merging in each NADIS package)
export type { LumenizeServices } from './types';

// Re-export OCAN (Operation Chaining And Nesting)
// Actor-model communication infrastructure
export * from './ocan/index';


/**
 * @lumenize/mesh - Lumenize Mesh communication framework
 *
 * Provides base classes for mesh nodes (LumenizeDO, LumenizeWorker, LumenizeClient)
 * with automatic dependency injection, OCAN communication, and mesh RPC.
 */

// Primary exports
export { LumenizeDO, LumenizeBase } from './lumenize-do';  // LumenizeBase is deprecated alias
export type { Continuation } from './lumenize-do';

export { LumenizeWorker } from './lumenize-worker';
// Continuation type is the same for LumenizeDO and LumenizeWorker

export { NadisPlugin } from './nadis-plugin';

// Re-export Lumenize infrastructure API
export type { LmzApi, CallEnvelope, CallOptions } from './lmz-api';

// Re-export the global LumenizeServices interface type
// (actual interface is built via declaration merging in each NADIS package)
export type { LumenizeServices } from './types';

// Re-export OCAN (Operation Chaining And Nesting)
// Actor-model communication infrastructure
export * from './ocan/index';


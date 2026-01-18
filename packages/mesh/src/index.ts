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

// sql is built-in and automatically available on this.svc.sql for LumenizeDO subclasses
// Export only the type for use in other packages (e.g., @lumenize/alarms)
export type { sql } from './sql';

// Re-export Lumenize infrastructure API
export type { LmzApi, CallEnvelope } from './lmz-api';

// Re-export mesh node identity and call context types
export type {
  NodeType,
  NodeIdentity,
  OriginAuth,
  CallContext,
  CallOptions,
  LumenizeServices
} from './types';

// Re-export OCAN (Operation Chaining And Nesting)
// Actor-model communication infrastructure
export * from './ocan/index';

// @mesh decorator for marking methods as mesh-callable
export { mesh, meshFn, isMeshCallable, getMeshGuard, MESH_CALLABLE, MESH_GUARD } from './mesh-decorator';
export type { MeshGuard } from './mesh-decorator';

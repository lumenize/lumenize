/**
 * @lumenize/mesh - Lumenize Mesh communication framework
 *
 * Provides base classes for mesh nodes (LumenizeDO, LumenizeWorker, LumenizeClient)
 * with automatic dependency injection, OCAN communication, and mesh RPC.
 */

// Primary exports
export { LumenizeDO, LumenizeBase } from './lumenize-do';  // LumenizeBase is deprecated alias
export type { Continuation, AnyContinuation } from './lumenize-do';

export { LumenizeWorker } from './lumenize-worker';
// Continuation type is the same for LumenizeDO and LumenizeWorker

export { NadisPlugin } from './nadis-plugin';

// sql is built-in and automatically available on this.svc.sql for LumenizeDO subclasses
// Side-effect import ensures LumenizeServices declaration merging runs
import './sql';
export type { sql } from './sql';

// alarms is built-in and automatically available on this.svc.alarms for LumenizeDO subclasses
// Side-effect import ensures LumenizeServices declaration merging runs
import './alarms';
export type { Schedule, ScheduledAlarm, DelayedAlarm, CronAlarm } from './alarms';

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

// LumenizeClientGateway - WebSocket bridge for mesh clients
export { LumenizeClientGateway, ClientDisconnectedError, GatewayMessageType } from './lumenize-client-gateway';
export type {
  GatewayMessage,
  CallMessage,
  CallResponseMessage,
  IncomingCallMessage,
  IncomingCallResponseMessage,
  ConnectionStatusMessage,
} from './lumenize-client-gateway';

// LumenizeClient - Browser/Node.js client for mesh communication
export { LumenizeClient, LoginRequiredError } from './lumenize-client';
export type {
  LumenizeClientConfig,
  ConnectionState,
  LmzApiClient,
  Continuation as ClientContinuation,  // Alias to avoid conflict with DO's Continuation
} from './lumenize-client';

// Tab ID management for browser clients
export { getOrCreateTabId } from './tab-id';
export type { TabIdDeps } from './tab-id';

// Test helpers
export { createTestRefreshFunction } from './create-test-refresh-function';
export type { CreateTestRefreshFunctionOptions } from './create-test-refresh-function';

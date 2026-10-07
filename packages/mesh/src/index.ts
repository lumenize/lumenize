/**
 * @lumenize/mesh - Lumenize Mesh communication framework
 *
 * Provides base classes for mesh nodes (LumenizeDO, LumenizeWorker, LumenizeClient)
 * with automatic dependency injection, OCAN communication, and mesh RPC.
 */

// Primary exports
export { LumenizeDO } from './lumenize-do';
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

// broadcast is a member of every node's `lmz` (LmzApi, and LmzApiClient on the client), beside `call`
export type { BroadcastFn, BroadcastTarget, BroadcastOptions } from './broadcast';

// Re-export Lumenize infrastructure API
export type { LmzApi, CallEnvelope } from './lmz-api';
// ComposedMeshDO — the DO-flavored mesh-composition mixin (VALUE export; consumed cross-package,
// e.g. the Profile DO in @lumenize/nebula-auth does `extends ComposedMeshDO(DurableObject, 'Profile')`).
export { ComposedMeshDO } from './lmz-api';

// Re-export mesh node identity and call context types
export type {
  NodeType,
  NodeIdentity,
  OriginAuth,
  OriginCf,
  OriginRequest,
  CallContext,
  CallOptions,
  LumenizeServices
} from './types';

// Re-export OCAN (Operation Chaining And Nesting)
// Actor-model communication infrastructure
export * from './ocan/index';

// @mesh() decorator, which makes a method or getter mesh-callable
export { mesh, isMeshCallable, getMeshGuard, MESH_CALLABLE, MESH_GUARD } from './mesh-decorator';
// The callee half of the bridge our own code uses to reach a node (ADR-023); the caller half,
// `rawRpcStub`, is the light subpath `@lumenize/mesh/raw-rpc`.
export { rawRpc } from './raw-rpc-decorator';
export type { MeshGuard } from './mesh-decorator';

// LumenizeClientGateway - WebSocket bridge for mesh clients
export { LumenizeClientGateway, ClientDisconnectedError, GatewayMessageType } from './lumenize-client-gateway';
// A Client's server-side half, which a node composes to host Clients
export { ClientGateway } from './client-gateway';
export { WS_CLOSE_GONE } from './gateway-messages';
export type { ClientGatewayHost, ClientGatewayOptions } from './client-gateway';
export type {
  GatewayConnectionInfo,
  GatewayMessage,
  CallMessage,
  ResponseMessage,
  IncomingCallMessage,
  IncomingCallResponseMessage,
  ConnectionStatusMessage,
} from './lumenize-client-gateway';

// LumenizeClient - Browser/Node.js client for mesh communication
export { LumenizeClient, LoginRequiredError, HostDeletedError, TOKEN_REFRESH_AHEAD_SECONDS } from './lumenize-client';
export type {
  LumenizeClientConfig,
  ConnectionState,
  LmzApiClient,
  ClientCallOptions,
  ClientBroadcastOptions,
  Continuation as ClientContinuation,  // Alias to avoid conflict with DO's Continuation
} from './lumenize-client';

// Tab ID management for browser clients
export { getOrCreateTabId } from './tab-id';
export { isClientInstanceName, hostInstanceOf, addressOf, splitAddress } from './client-address';
export type { TabIdDeps } from './tab-id';

// Test helpers
export { createTestRefreshFunction } from './create-test-refresh-function';
export type { CreateTestRefreshFunctionOptions } from './create-test-refresh-function';

/**
 * @lumenize/mesh - Lumenize Mesh communication framework
 *
 * Provides base classes for mesh nodes (ScopedMeshDO, UnscopedMeshDO, MeshWorker, MeshClient)
 * with automatic dependency injection, OCAN communication, and mesh RPC.
 */

// Primary exports: the two Durable Object bases — a node named by a scope checks passage and hosts
// its pages' Clients; a node named by an id decides per method — and the Worker base.
export { ScopedMeshDO, requirePassage, requireDominionHere, requirePassageIntoSender, GATEWAY_PREFIX } from './scoped-mesh-do';
export { UnscopedMeshDO } from './unscoped-mesh-do';
export type { Continuation, AnyContinuation } from './mesh-do';

export { MeshWorker } from './mesh-worker';

export { NadisPlugin } from './nadis-plugin';

// sql is built-in and automatically available on this.svc.sql for every Mesh Durable Object
// Side-effect import ensures LumenizeServices declaration merging runs
import './sql';
export type { sql } from './sql';

// alarms is built-in and automatically available on this.svc.alarms for every Mesh Durable Object
// Side-effect import ensures LumenizeServices declaration merging runs
import './alarms';
export type { Schedule, ScheduledAlarm, DelayedAlarm, CronAlarm } from './alarms';

// broadcast is a member of every node's `lmz` (LmzApi, and LmzApiClient on the client), beside `call`
export type { BroadcastFn, BroadcastTarget, BroadcastOptions } from './broadcast';

// Re-export Lumenize infrastructure API
export type { LmzApi, CallEnvelope } from './lmz-api';

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

// A Client's server-side half, which a scoped node composes to host the Clients on its pages, and
// the frames it exchanges with them
export { ClientGateway } from './client-gateway';
export { ClientDisconnectedError, GatewayMessageType, WS_CLOSE_GONE } from './gateway-messages';
export type { ClientGatewayHost } from './client-gateway';
export type {
  GatewayConnectionInfo,
  GatewayMessage,
  CallMessage,
  ResponseMessage,
  IncomingCallMessage,
  IncomingCallResponseMessage,
  ConnectionStatusMessage,
} from './gateway-messages';

// MeshClient - Browser/Node.js client for mesh communication
export { MeshClient, LoginRequiredError, HostDeletedError, TOKEN_REFRESH_AHEAD_SECONDS } from './mesh-client';
export type {
  MeshClientConfig,
  ConnectionState,
  LmzApiClient,
  ClientCallOptions,
  ClientBroadcastOptions,
  ProfileChannelSnapshot,
  ProfileSubscription,
  Continuation as ClientContinuation,  // Alias to avoid conflict with DO's Continuation
} from './mesh-client';
// What `impersonate()` throws, for a caller that tells its refusals apart, and what it takes.
export { ImpersonationChainError, ImpersonationAlreadyOpenError, ImpersonationMintError } from './impersonation';
export type { ImpersonateOptions } from './impersonation';
// A subscribe's wait for its first push, shared by the Profile channel and a subclass's own planes.
export { awaitFirstPush, SUBSCRIBE_TIMEOUT_MS } from './first-push';
export type { PendingPush } from './first-push';

// Tab ID management for browser clients
export { getOrCreateTabId } from './tab-id';
export { isClientInstanceName, hostInstanceOf, addressOf, splitAddress } from './client-address';
export type { TabIdDeps } from './tab-id';

// The scope grammar, the passage and dominion verdicts, and the host grammar: what a node checks
// and a Client reads, from `auth/` but reaching neither the Registry nor `cloudflare:workers`.
export {
  parseId,
  isValidSlug,
  MAX_SLUG_LENGTH,
  isPlatformScope,
  getParentId,
  isAtOrAbove,
  isAtOrBelow,
  hasDominionOver,
  hasPassageInto,
  noPassageMessage,
} from './auth/parse-id';
export type { VerdictClaims } from './auth/parse-id';
export { parseHost, platformOrigin, deploymentOrigin, hostOrigin, checkedReturnTo } from './auth/hosts';
export type { HostTarget } from './auth/hosts';
export { projectActingToken, prependActor } from './auth/access-claims';
export type { ActingTokenRecord } from './auth/access-claims';
export {
  PLATFORM_SCOPE,
  RESERVED_STAR_SLUGS,
  NEBULA_SUB,
  ACCESS_TOKEN_TTL,
  RECOMMENDED_MIN_TTL_SECONDS,
  SIGNUP_TICKET_COOKIE,
  MINT_ALL_COOKIE_CAP,
  MAX_GALAXIES_PER_OWNER,
  GALAXY_CAP_MESSAGE,
  ImpersonationRefusedError,
  isImpersonationRefused,
} from './auth/types';
export type { Tier, ParsedId, AccessEntry, ActClaim, AuthClaims } from './auth/types';

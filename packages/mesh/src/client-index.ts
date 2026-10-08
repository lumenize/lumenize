/**
 * @lumenize/mesh/client — Node.js / browser-safe entry point
 *
 * This subpath export exposes only the parts of `@lumenize/mesh` that don't
 * require the Cloudflare Workers runtime. Use this from Node.js (test
 * harnesses, CLIs, server-side renders) and unbundled browsers.
 *
 * The main `@lumenize/mesh` entry point re-exports `ScopedMeshDO`,
 * `MeshWorker`, `ClientGateway`, and other server-only surface —
 * all of which transitively import `cloudflare:workers` and fail to load
 * outside Workers. This file intentionally leaves them out.
 *
 * @example
 * ```typescript
 * import { MeshClient, mesh } from '@lumenize/mesh/client';
 *
 * class MyClient extends MeshClient {
 *   @mesh()
 *   onNotification(msg: string) { ... }
 * }
 * ```
 */

// MeshClient and related error types
export { MeshClient, LoginRequiredError, HostDeletedError, TOKEN_REFRESH_AHEAD_SECONDS } from './mesh-client';
export type {
  MeshClientConfig,
  ConnectionState,
  LmzApiClient,
  ClientCallOptions,
  ClientBroadcastOptions,
  ProfileChannelSnapshot,
  ProfileSubscription,
  Continuation as ClientContinuation,
} from './mesh-client';
// What `impersonate()` throws, for a caller that tells its refusals apart, and what it takes.
export { ImpersonationChainError, ImpersonationAlreadyOpenError, ImpersonationMintError } from './impersonation';
export type { ImpersonateOptions } from './impersonation';
// A subscribe's wait for its first push, shared by the Profile channel and a subclass's own planes.
export { awaitFirstPush, SUBSCRIBE_TIMEOUT_MS } from './first-push';
export type { PendingPush } from './first-push';
// A Client's address and the `/` that tells it from a node's
export { isClientInstanceName, hostInstanceOf, addressOf, splitAddress } from './client-address';

// The parameter types of `lmz.broadcast`, which the client's `lmz` carries too
export type { BroadcastTarget, BroadcastOptions } from './broadcast';

// @mesh() decorator infrastructure (makes a method or getter mesh-callable)
export {
  mesh,
  isMeshCallable,
  getMeshGuard,
  MESH_CALLABLE,
  MESH_GUARD,
} from './mesh-decorator';
export type { MeshGuard } from './mesh-decorator';

// Gateway wire-protocol primitives — runtime values and types
export {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_TIMED_OUT,
  WS_CLOSE_GONE,
  WS_TOKEN_PREFIX,
  WS_PROTOCOL,
  extractWebSocketToken,
} from './gateway-messages';
export type {
  CallMessage,
  ResponseMessage,
  IncomingCallMessage,
  IncomingCallResponseMessage,
  ConnectionStatusMessage,
  GatewayMessage,
  GatewayConnectionInfo,
} from './gateway-messages';

// Tab ID management for browser clients (safe to use from Node — returns a
// random tab ID when sessionStorage/BroadcastChannel aren't injected)
export { getOrCreateTabId } from './tab-id';
export type { TabIdDeps } from './tab-id';

// Mesh node identity / call-context types (used by client code)
export type {
  NodeType,
  NodeIdentity,
  OriginAuth,
  OriginCf,
  OriginRequest,
  CallContext,
  CallOptions,
} from './types';

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

// What a served page knows about its deployment: the meta tag that names it, and the platform
// host a page refreshes against.
export { LUMENIZE_ORIGIN_META } from './page-meta';
export { deploymentOriginOfPage, platformOriginOf } from './page-origin';

/**
 * @lumenize/mesh/client — Node.js / browser-safe entry point
 *
 * This subpath export exposes only the parts of `@lumenize/mesh` that don't
 * require the Cloudflare Workers runtime. Use this from Node.js (test
 * harnesses, CLIs, server-side renders) and unbundled browsers.
 *
 * The main `@lumenize/mesh` entry point re-exports `LumenizeDO`,
 * `LumenizeWorker`, `LumenizeClientGateway`, and other server-only surface —
 * all of which transitively import `cloudflare:workers` and fail to load
 * outside Workers. This file intentionally leaves them out.
 *
 * @example
 * ```typescript
 * import { LumenizeClient, mesh } from '@lumenize/mesh/client';
 *
 * class MyClient extends LumenizeClient {
 *   @mesh()
 *   onNotification(msg: string) { ... }
 * }
 * ```
 */

// LumenizeClient and related error types
export { LumenizeClient, LoginRequiredError } from './lumenize-client';
export type {
  LumenizeClientConfig,
  ConnectionState,
  LmzApiClient,
  Continuation as ClientContinuation,
} from './lumenize-client';

// @mesh decorator infrastructure (marking methods as mesh-callable)
export {
  mesh,
  meshFn,
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
} from './gateway-messages';
export type {
  CallMessage,
  CallResponseMessage,
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
  CallContext,
  CallOptions,
} from './types';

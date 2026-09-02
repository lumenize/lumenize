import type { sql } from './sql';
import type { Alarms } from './alarms';
import type { BroadcastFn } from './broadcast';

// ============================================
// Mesh Node Identity & Call Context
// ============================================

/**
 * Type of mesh node
 *
 * - `LumenizeDO` — Stateful Durable Object
 * - `LumenizeWorker` — Stateless Worker Entrypoint
 * - `LumenizeClient` — Browser/Node.js client
 */
export type NodeType = 'LumenizeDO' | 'LumenizeWorker' | 'LumenizeClient';

/**
 * Identity of a mesh node
 *
 * Every participant in the mesh has a type, binding name, and optionally an instance name.
 * Workers don't have instance names (they're ephemeral/stateless).
 */
export interface NodeIdentity {
  type: 'LumenizeDO' | 'LumenizeWorker' | 'LumenizeClient';
  bindingName: string;
  instanceName?: string; // undefined for Workers
}

/** Verified authentication claims from the origin of a call chain */
export interface OriginAuth {
  sub: string;
  claims?: Record<string, unknown>; // Additional JWT claims (roles, permissions, etc.)
}

/**
 * Verbatim subset of Cloudflare's `request.cf` (`IncomingRequestCfProperties`).
 *
 * Split rule: everything under `cf` came from the runtime-added `cf` Request property; every flat
 * {@link OriginRequest} field came from a header or the request URL. `isEUCountry` keeps CF's
 * `"1"`-or-absent quirk and `latitude`/`longitude` stay strings — normalization lives in helpers,
 * never in the wire shape. Excluded on purpose (additive if a consumer appears): `postalCode`,
 * `asn`/`asOrganization`, `httpProtocol`/`tlsVersion`/`botManagement`.
 */
export type OriginCf = Pick<IncomingRequestCfProperties,
  | 'continent' | 'country' | 'isEUCountry'   // placement hint + EU-jurisdiction suggestion
  | 'latitude' | 'longitude'                  // hint-split inputs (strings, per CF)
  | 'region' | 'regionCode' | 'city'          // audit/analytics display ("login from Austin, TX")
  | 'colo'                                    // CF datacenter the connection hit — placement/latency debugging
  | 'timezone'                                // display/scheduling
>;

/**
 * HTTP-level facts from the request that originated this call chain.
 *
 * Captured by the Gateway at WebSocket upgrade — CONNECTION-scoped, so it is refreshed on each
 * reconnect and may be minutes or hours old mid-session. `undefined` when the origin isn't a
 * `LumenizeClient` (DO/Worker origins, `newChain: true`).
 *
 * Trust, per field — this is what decides what each may be used for:
 * - `cf` is set by the runtime at the edge and `ip` by the edge from the connection; external
 *   clients cannot forge either (an intermediate Worker could via `new Request(req, { cf })`;
 *   ours never do).
 * - `origin` is the scheme + host the upgrade ARRIVED on — `new URL(request.url).origin`, i.e.
 *   what routing delivered, never a client-supplied header. That is what makes it safe to build a
 *   user-facing absolute URL from: an emailed link must echo the host the person is actually on.
 * - `userAgent` / `acceptLanguage` are client-controlled — descriptive only, NEVER authorization
 *   inputs.
 */
export interface OriginRequest {
  /** Absent where the runtime doesn't populate it (previews). */
  cf?: OriginCf;
  /** `CF-Connecting-IP` — edge-set, unspoofable. */
  ip?: string;
  /** Scheme + host the upgrade arrived on — from the request URL, not from any client header. */
  origin?: string;
  /** `User-Agent` — client-controlled, descriptive only. */
  userAgent?: string;
  /** `Accept-Language` — client-controlled, descriptive only. */
  acceptLanguage?: string;
}

/** Context for a mesh call, propagated through the entire call chain */
export interface CallContext {
  // Immutable — full call path: [origin, hop1, hop2, ..., caller]
  callChain: NodeIdentity[];

  // Immutable — verified claims from origin's JWT (if authenticated)
  originAuth?: OriginAuth;

  // Immutable — HTTP facts of the originating upgrade, stamped by the Gateway (client-originated
  // chains only). Tamper-evident like originAuth: NOT in callChain[0] (which the client partly
  // authors) and NOT in state (which any hop may mutate).
  originRequest?: OriginRequest;

  // Mutable — can be modified by onBeforeCall or any handler along the way
  state: Record<string, unknown>;
}

/** Options for `this.lmz.call()` */
export interface CallOptions {
  newChain?: boolean; // Start fresh call chain (this node becomes origin)
  state?: Record<string, unknown>; // Initial or merged state for the call
  /**
   * Called synchronously with the generated `callId` immediately before the
   * call message is sent (or queued, when disconnected). Lets instrumentation
   * correlate this call's outbound message with later inbound frames (e.g.,
   * tracing markers, custom Gateway-emitted frames) without exposing the
   * client's internal pending-call map. Fires once per call.
   */
  onSent?: (callId: string) => void;
  /**
   * For 4-arg `lmz.call` (with handler continuation): if true, the handler
   * is invoked ONLY when the remote call rejects (Error path). On success,
   * the handler chain is never dispatched and the success result is dropped.
   *
   * Useful for fire-and-forget paths that want structured error handling
   * (retry, cleanup, escalation) without paying the per-call success-path
   * dispatch cost — e.g. `svc.broadcast`'s drop-on-failed-fanout, where
   * the originator only cares about `ClientDisconnectedError`.
   *
   * Defaults to false — both success and error are dispatched.
   */
  onErrorOnly?: boolean;
}

// ============================================
// NADIS Services
// ============================================

/**
 * Global LumenizeServices interface
 *
 * Provides type-safe access to built-in and NADIS plugin services via `this.svc.*`.
 *
 * **Built-in services** (always available):
 * - `sql` - SQL template literal tag for DO storage
 * - `alarms` - Alarm scheduling with OCAN continuations
 *
 * **NADIS plugins** augment this interface via declaration merging.
 *
 * @example
 * ```typescript
 * import { LumenizeDO } from '@lumenize/mesh';
 *
 * class MyDO extends LumenizeDO<Env> {
 *   example() {
 *     // Built-in - no import needed
 *     this.svc.sql`SELECT * FROM users`;
 *     this.svc.alarms.schedule(60, this.ctn().task());
 *   }
 * }
 * ```
 */
export interface LumenizeServices {
  /** Built-in SQL template literal tag for DO storage */
  sql: ReturnType<typeof sql>;
  /** Built-in alarm scheduling service for DO */
  alarms: Alarms;
  /** Built-in broadcast service — dispatch a continuation to many targets with tree-fanout offloading at scale */
  broadcast: BroadcastFn;
  // Additional services are added via declaration merging in their respective NADIS packages
}

// Also export as a global declaration for convenience
declare global {
  interface LumenizeServices {
    /** Built-in SQL template literal tag for DO storage */
    sql: ReturnType<typeof sql>;
    /** Built-in alarm scheduling service for DO */
    alarms: Alarms;
    /** Built-in broadcast service — dispatch a continuation to many targets with tree-fanout offloading at scale */
    broadcast: BroadcastFn;
    // Additional services are added via declaration merging in their respective NADIS packages
  }
}


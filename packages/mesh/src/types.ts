import type { sql } from './sql';

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
  /** Type of mesh node */
  type: NodeType;
  /** Binding name (e.g., 'DOCUMENT_DO', 'SPELLCHECK_WORKER', 'LUMENIZE_CLIENT_GATEWAY') */
  bindingName: string;
  /** Instance name (e.g., 'doc-123', 'alice.tab1'). Undefined for Workers. */
  instanceName?: string;
}

/**
 * Verified authentication claims from the origin of a call chain
 *
 * These claims are set by the LumenizeClientGateway when a client initiates a call,
 * based on the verified JWT from the WebSocket connection. They are immutable
 * throughout the call chain — intermediate nodes cannot modify them.
 */
export interface OriginAuth {
  /** User ID from JWT subject claim */
  userId: string;
  /** Additional claims from JWT (roles, permissions, etc.) */
  claims?: Record<string, unknown>;
}

/**
 * Context for a mesh call, propagated through the entire call chain
 *
 * Access via `this.lmz.callContext` inside mesh methods.
 *
 * @example
 * ```typescript
 * onBeforeCall() {
 *   // Who initiated this call chain?
 *   const origin = this.lmz.callContext.callChain[0];
 *
 *   // Who called me directly?
 *   const caller = this.lmz.callContext.callChain.at(-1);
 *
 *   // Full call path for tracing
 *   const path = this.lmz.callContext.callChain.map(n => n.bindingName).join(' → ');
 * }
 * ```
 */
export interface CallContext {
  /**
   * Full call chain from origin to the immediate caller
   *
   * Array of all nodes the call has passed through: `[origin, hop1, hop2, ..., caller]`
   * - `callChain[0]` — Origin (who started the chain)
   * - `callChain.at(-1)` — Immediate caller (who called this node)
   *
   * Always has at least one element (the origin). Never empty.
   *
   * Note: LumenizeClientGateway is NOT included in the chain — it's an
   * implementation detail. Calls appear to come from LumenizeClient directly.
   */
  callChain: NodeIdentity[];

  /**
   * Verified JWT claims from the origin (immutable)
   *
   * Only populated when the call chain originates from an authenticated LumenizeClient.
   * These are the claims from `callChain[0]` if it's a LumenizeClient with valid auth.
   * Nodes within Cloudflare (LumenizeDO, LumenizeWorker) don't have originAuth when
   * they initiate a new call chain.
   */
  originAuth?: OriginAuth;

  /**
   * Mutable state that propagates through the call chain
   *
   * Starts as `{}` (or from `CallOptions.state` if provided).
   * Typically populated in `onBeforeCall()` with computed data (sessions, permissions).
   * Modifications propagate forward and back through the chain.
   *
   * Useful for:
   * - Distributed tracing (trace IDs, spans)
   * - Caching computed permissions across hops
   * - Request-scoped metadata
   */
  state: Record<string, unknown>;
}

/**
 * Options for `this.lmz.call()` and `this.lmz.callRaw()`
 */
export interface CallOptions {
  /**
   * Start a fresh call chain with new `callContext`
   *
   * When `true`:
   * - `origin` becomes this node
   * - `originAuth` is cleared (this node is the new origin)
   * - `callChain` resets to `[]`
   * - `state` is set to `options.state` or `{}`
   *
   * When `false` (default):
   * - Inherits current `callContext`
   * - This node is appended to `callChain`
   * - `state` is merged with `options.state` if provided
   *
   * Use cases for `newChain: true`:
   * - Fan-out patterns where you don't want tracing to bleed across recipients
   * - Starting a new logical operation from within a handler
   */
  newChain?: boolean;

  /**
   * Initial or additional state for the call
   *
   * When `newChain: true`: Used as the initial `state` for the new chain.
   * When `newChain: false`: Merged with inherited `state` (this takes precedence on conflicts).
   */
  state?: Record<string, unknown>;
}

// ============================================
// NADIS Services
// ============================================

/**
 * Global LumenizeServices interface
 *
 * This interface is augmented via declaration merging by each NADIS package.
 * When you import a NADIS package (e.g., '@lumenize/alarms'), it adds its
 * service to this interface, enabling TypeScript autocomplete.
 *
 * The `sql` service is built-in and always available on `this.svc.sql`.
 *
 * @example
 * ```typescript
 * import '@lumenize/alarms';  // Adds 'alarms' to LumenizeServices
 *
 * // this.svc.sql is always available (built-in)
 * // this.svc.alarms is available after importing @lumenize/alarms
 * ```
 */
export interface LumenizeServices {
  /** Built-in SQL template literal tag for DO storage */
  sql: ReturnType<typeof sql>;
  // Additional services are added via declaration merging in their respective packages
  // Example: alarms: Alarms<any>;  // Added by @lumenize/alarms
}

// Also export as a global declaration for convenience
declare global {
  interface LumenizeServices {
    /** Built-in SQL template literal tag for DO storage */
    sql: ReturnType<typeof sql>;
    // Additional services are added via declaration merging
  }
}


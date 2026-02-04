import type { sql } from './sql';
import type { Alarms } from './alarms';

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

/** Context for a mesh call, propagated through the entire call chain */
export interface CallContext {
  // Immutable — full call path: [origin, hop1, hop2, ..., caller]
  callChain: NodeIdentity[];

  // Immutable — verified claims from origin's JWT (if authenticated)
  originAuth?: OriginAuth;

  // Mutable — can be modified by onBeforeCall or any handler along the way
  state: Record<string, unknown>;
}

/** Options for `this.lmz.call()` and `this.lmz.callRaw()` */
export interface CallOptions {
  newChain?: boolean; // Start fresh call chain (this node becomes origin)
  state?: Record<string, unknown>; // Initial or merged state for the call
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
  // Additional services are added via declaration merging in their respective NADIS packages
}

// Also export as a global declaration for convenience
declare global {
  interface LumenizeServices {
    /** Built-in SQL template literal tag for DO storage */
    sql: ReturnType<typeof sql>;
    /** Built-in alarm scheduling service for DO */
    alarms: Alarms;
    // Additional services are added via declaration merging in their respective NADIS packages
  }
}


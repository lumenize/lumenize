/**
 * Subscriptions — per-Star subscriber registry
 *
 * Owns the `Subscribers` SQL table and the subscribe-time semantics:
 * DAG read-permission check, resource-existence + type-mismatch checks,
 * and idempotent row insertion keyed by `(resourceId, clientId)`.
 *
 * Fanout (looking up subscribers for a mutated resource) is exposed via
 * `forResource(resourceId)`. The fanout call-site itself lands in Phase 5.3.2;
 * this class provides the lookup primitive.
 */

import type { CallContext } from '@lumenize/mesh';
import type { DagTree } from './dag-tree';
import type { Resources, Snapshot } from './resources';

export interface SubscriberRow {
  resourceId: string;
  clientId: string;
  sub: string;
  subscriberBinding: string;
  subscribedAt: string;
}

export class Subscriptions {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #dagTree: DagTree;
  #resources: Resources;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    dagTree: DagTree,
    resources: Resources,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#dagTree = dagTree;
    this.#resources = resources;
    this.#createSchema();
  }

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Subscribers (
        resourceId TEXT NOT NULL,
        clientId TEXT NOT NULL,
        sub TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        PRIMARY KEY (resourceId, clientId)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Drop all subscriber rows. Called by `Star.#installState` when a new
   * ontology version is installed — every existing row is by definition
   * registered by a stale-version client (the row carries no version itself,
   * but the deploy-driven cleanup model says: deploys are the cleanup event).
   *
   * `DROP TABLE + CREATE TABLE` is billed as a single write per CLAUDE.md's
   * storage cost model. `DELETE FROM Subscribers` would be billed per row,
   * which dominates at any non-trivial scale.
   *
   * The constructor's `CREATE TABLE IF NOT EXISTS` only runs at `onStart()`
   * — mid-operation drop+recreate has to happen inline here.
   */
  clear() {
    this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS Subscribers;`);
    this.#createSchema();
  }

  /**
   * Subscribe a client to a resource.
   *
   * Performs (in order):
   *   1. DAG read-permission check (via `Resources.read()`, which checks `meta.nodeId`)
   *   2. Resource-existence check (errors on `null` — subscribe-before-create is denied)
   *   3. Resource-type-mismatch check (errors if `snapshot.meta.typeName !== resourceType`)
   *   4. `INSERT OR REPLACE` keyed by `(resourceId, clientId)` — idempotent
   *
   * Returns the current snapshot for the caller to push as the initial value.
   * Throws on any failure — caller catches and delivers via `handleResourceUpdate`.
   */
  subscribe(
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ): Snapshot {
    // Permission check happens inside Resources.read(); throws on denial.
    // A `null` return means the resource doesn't exist (no row in Snapshots).
    const snapshot = this.#resources.read(resourceId);
    if (snapshot === null) {
      throw new Error(`Resource '${resourceId}' not found — cannot subscribe before create`);
    }
    if (snapshot.meta.typeName !== resourceType) {
      throw new Error(
        `Resource type mismatch: '${resourceId}' is type '${snapshot.meta.typeName}', requested '${resourceType}'`,
      );
    }

    const cc = this.#getCallContext();
    const sub = cc.originAuth?.sub;
    if (!sub) throw new Error('Authentication required');

    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscribers (resourceId, clientId, sub, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?, ?, ?)`,
      resourceId, clientId, sub, subscriberBinding, new Date().toISOString(),
    );

    return snapshot;
  }

  /**
   * Return all subscriber rows for a given resource. Used by Phase 5.3.2
   * fanout to dispatch updates after a mutation. PK-prefix scan — no
   * secondary index needed.
   */
  forResource(resourceId: string): SubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, clientId, sub, subscriberBinding, subscribedAt
       FROM Subscribers WHERE resourceId = ?`,
      resourceId,
    ).toArray();
    return rows as unknown as SubscriberRow[];
  }

  /**
   * Inspect the entire Subscribers table — test-only. Production code should
   * use `forResource(resourceId)`.
   */
  list(): SubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, clientId, sub, subscriberBinding, subscribedAt FROM Subscribers`,
    ).toArray();
    return rows as unknown as SubscriberRow[];
  }
}

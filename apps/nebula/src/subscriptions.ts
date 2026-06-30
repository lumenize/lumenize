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
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import type { SQLSchemaMigration } from '@lumenize/sql-migrations';
import type { DagTree } from './dag-tree';
import type { Resources, Snapshot } from './resources';

/** Distinct migration marker so this runner's progress never collides with another
 *  `SQLSchemaMigrations` composed into the SAME Star/DevStudio DO (the `markerKey`
 *  knob exists for exactly this per-component composition). */
const SUBSCRIBERS_MARKER_KEY = '__sql_migrations_Subscribers';

/**
 * Append-only migration list for the `Subscribers` table, run id-gated + atomically
 * by `@lumenize/sql-migrations` in the constructor (replaces the old
 * `CREATE IF NOT EXISTS` + hand-rolled try/catch ALTER). **APPEND-ONLY** — never
 * edit/reorder/reuse an applied id.
 *   id-1 — the FROZEN baseline (matches what already exists in prod, created by the
 *          pre-migration `CREATE IF NOT EXISTS`; so it no-ops on existing Stars and
 *          creates the table on a fresh one);
 *   id-2 — add `accessAdmin` (D16 — the `access.admin` claim for the per-push recheck).
 */
const SUBSCRIBERS_MIGRATIONS: SQLSchemaMigration[] = [
  {
    idMonotonicInc: 1,
    description: 'baseline: Subscribers table',
    sql: `CREATE TABLE IF NOT EXISTS Subscribers (
      resourceId TEXT NOT NULL,
      clientId TEXT NOT NULL,
      sub TEXT NOT NULL,
      subscriberBinding TEXT NOT NULL,
      subscribedAt TEXT NOT NULL,
      PRIMARY KEY (resourceId, clientId)
    ) WITHOUT ROWID`,
  },
  {
    idMonotonicInc: 2,
    description: 'add accessAdmin column (D16)',
    sql: `ALTER TABLE Subscribers ADD COLUMN accessAdmin INTEGER NOT NULL DEFAULT 0`,
  },
];

export interface SubscriberRow {
  resourceId: string;
  clientId: string;
  sub: string;
  /** The `claims.access.admin` flag at subscribe time (0/1) — the Galaxy/Universe
   *  scope-admin bypass replicated for the per-push recheck (D16). NOT a Star DAG
   *  `admin` grant (that resolves through `resolvePermission` normally). */
  accessAdmin: number;
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
    // Run the Subscribers schema migrations once, eagerly (the constructor runs in
    // onStart, before any request). id-gated + atomic; brings an existing prod Star's
    // pre-accessAdmin table up to date without a hand-rolled ALTER guard.
    new SQLSchemaMigrations({
      doStorage: this.#ctx.storage,
      markerKey: SUBSCRIBERS_MARKER_KEY,
      migrations: SUBSCRIBERS_MIGRATIONS,
    }).runAll();
  }

  /**
   * Drop all subscriber rows. Called by `Star.#installState` when a new
   * ontology version is installed — every existing row is by definition
   * registered by a stale-version client (the row carries no version itself,
   * but the deploy-driven cleanup model says: deploys are the cleanup event).
   *
   * `DROP TABLE + recreate` is billed as a single write per CLAUDE.md's storage
   * cost model. `DELETE FROM Subscribers` would be billed per row, which dominates
   * at any non-trivial scale.
   *
   * The migration runner only fires at `onStart()` (and the marker records the table
   * as already-migrated, so it won't re-create after a restart) — so the mid-operation
   * rebuild happens inline here by **replaying the migration DDL** (recreating the
   * empty table at its current schema). All `Subscribers` migrations are DDL; a future
   * data-backfill migration would be a harmless no-op on the freshly-emptied table.
   *
   * Returns the distinct `(subscriberBinding, clientId)` pairs that were
   * dropped. The caller (Star.#installState) uses this to push-on-clear:
   * one `OntologyStaleError` to each connected subscriber via fanout, so
   * passive clients get an immediate refresh signal instead of having to
   * wait for their next op or reconnect. Grouping by `(binding, clientId)`
   * — not by row — means a client subscribed to N resources receives
   * exactly one notification, not N.
   */
  clear(): Array<{ subscriberBinding: string; clientId: string }> {
    const dropped = this.#ctx.storage.sql.exec(
      `SELECT DISTINCT subscriberBinding, clientId FROM Subscribers`,
    ).toArray() as Array<{ subscriberBinding: string; clientId: string }>;
    this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS Subscribers;`);
    for (const m of SUBSCRIBERS_MIGRATIONS) {
      this.#ctx.storage.sql.exec(m.sql, ...(m.params ?? []));
    }
    return dropped;
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
    // Store the access.admin claim so the per-push recheck (D3) can replicate the
    // requirePermission bypass for a Galaxy/Universe scope-admin who holds no DAG
    // grant — we don't have the subscriber's live JWT at push time (D16).
    const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined;
    const accessAdmin = claims?.access?.admin ? 1 : 0;

    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscribers (resourceId, clientId, sub, accessAdmin, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      resourceId, clientId, sub, accessAdmin, subscriberBinding, new Date().toISOString(),
    );

    return snapshot;
  }

  /**
   * Drop a single subscriber row. Called by `Star.#onFanoutDelivered` when a
   * fanout `lmz.call` returns a `ClientDisconnectedError` — the Gateway has
   * confirmed the client is gone past its grace period, so the row's a leak.
   * This is the **reactive** half of the "user closed the tab" cleanup story
   * (Phase 5.3.5); push-on-clear (5.3.4b) catches the rest on next deploy.
   *
   * PK-targeted delete — single billed write, no index gymnastics needed.
   */
  removeSubscriber(resourceId: string, clientId: string): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM Subscribers WHERE resourceId = ? AND clientId = ?`,
      resourceId, clientId,
    );
  }

  /**
   * Return all subscriber rows for a given resource. Used by Phase 5.3.2
   * fanout to dispatch updates after a mutation. PK-prefix scan — no
   * secondary index needed.
   */
  forResource(resourceId: string): SubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT resourceId, clientId, sub, accessAdmin, subscriberBinding, subscribedAt
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
      `SELECT resourceId, clientId, sub, accessAdmin, subscriberBinding, subscribedAt FROM Subscribers`,
    ).toArray();
    return rows as unknown as SubscriberRow[];
  }
}

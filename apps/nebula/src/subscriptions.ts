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
import { hasDominionOver } from '@lumenize/nebula-auth';
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
 *   id-2 — add the confined dominion verdict for the per-push recheck.
 *
 * ⚠️ **id-2's column was RENAMED BY EDITING THIS ENTRY IN PLACE on 2026-08-11** (git carries the
 * old spelling), which the APPEND-ONLY rule above otherwise forbids. That was a
 * ONE-TIME, dated licence and it is spent: it was legitimate only because no deploy stood between
 * the edit and the pre-alpha wipe, and every local/test store is recreated from scratch — so no
 * storage could ever run pre-rename code against a post-rename schema. **APPEND-ONLY binds from
 * here on.** An `ALTER TABLE … RENAME COLUMN` entry would have been actively worse than the
 * in-place edit: `clear()` replays this list inline on every version-changing ontology install, so
 * a rename entry would create the table under the old name and rename it again, forever.
 * See `.claude/rules/durable-objects.md` § *Initialization* for the high-water-mark rule this
 * defers to in every other case.
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
    description: 'add dominionOverHostAtSubscribe column',
    sql: `ALTER TABLE Subscribers ADD COLUMN dominionOverHostAtSubscribe INTEGER NOT NULL DEFAULT 0`,
  },
];

export type SubscriberRow = {
  resourceId: string;
  clientId: string;
  sub: string;
  /** The **confined** scope-admin verdict at subscribe time (0/1) — `hasDominionOver(access,
   *  <host instance name>)`, NOT the raw `claims.access.scopeAdmin` bit. The Galaxy/Universe scope-admin
   *  bypass replicated for the per-push recheck; NOT a Star DAG `admin` grant (that resolves
   *  through `resolvePermission` normally).
   *
   *  Storing a verdict rather than the claim is what closes the push-path back door: the push path
   *  never re-reads the JWT, so confining only the live claim would leave this bypass unconfined.
   *  Sound per ADR-013 because the stored value is **monotonically narrowing** — a strict
   *  conjunct-subset of the old raw bit, and the host instance name is immutable for the DO's
   *  lifetime, so drift can only ever go 1→0 (under-privilege), never 0→1. */
  dominionOverHostAtSubscribe: number;
  subscriberBinding: string;
  subscribedAt: string;
}

export class Subscriptions {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #dagTree: DagTree;
  #resources: Resources;
  #getHostName: () => string | undefined;

  /** @param getHostName - Host DO instance name as a **thunk** (identity is not stamped at
   *   `onStart()` time, when this is constructed) — the scope the stored verdict is confined to. */
  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    dagTree: DagTree,
    resources: Resources,
    getHostName: () => string | undefined,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#dagTree = dagTree;
    this.#resources = resources;
    this.#getHostName = getHostName;
    // Run the Subscribers schema migrations once, eagerly (the constructor runs in
    // onStart, before any request). id-gated + atomic; brings an existing prod Star's
    // pre-dominionOverHostAtSubscribe table up to date without a hand-rolled ALTER guard.
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
    // Store the CONFINED scope-admin verdict so the per-push recheck can replicate the
    // requirePermission bypass for a Galaxy/Universe scope-admin who holds no DAG grant — we don't
    // have the subscriber's live JWT at push time.
    //
    // ⚠️ `hasDominionOver(...)`, NOT `claims?.access?.scopeAdmin`. This is confinement point 2: the
    // push path never re-reads the JWT, so confining only the live claim (requirePermission) would
    // leave this back door open — a descendant-scope admin would keep an unconfined bypass for the
    // life of the subscription. Confining at STORE time is the only option: at push time we hold
    // neither the live claim nor the pattern, only this bit.
    const hostName = this.#getHostName();
    const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined;
    const dominionOverHostAtSubscribe = hostName && hasDominionOver(claims?.access, hostName) ? 1 : 0;

    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscribers (resourceId, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      resourceId, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, new Date().toISOString(),
    );

    return snapshot;
  }

  /**
   * Drop a single subscriber row. Called by the host's broadcast-result handler
   * (`Star.onBroadcastResult` / `DevStudio.onBroadcastResult`) when a broadcast
   * `lmz.call` returns a `ClientDisconnectedError`. This is the **reactive** half
   * of the "user closed the tab" cleanup story (Phase 5.3.5); push-on-clear
   * (5.3.4b) catches the rest on next deploy.
   *
   * ⚠️ **`ClientDisconnectedError` does NOT mean "gone past the grace period"** —
   * the Gateway raises it for three conditions, and only two are a dead client:
   * no socket + no grace alarm, grace expired mid-wait, **and a live socket whose
   * token has expired** (`lumenize-client-gateway.ts` `__executeOperation`, which
   * closes 4401 and reports disconnected *before* any grace window exists). That
   * third client is about to reconnect with a fresh token, so the row it drops was
   * not a leak.
   *
   * The invariant that makes dropping correct anyway is **client-side**, not
   * Gateway-side: `NebulaClient` re-issues every subscription unconditionally on
   * the `reconnecting → connected` transition (`nebula-client.ts` `#resubscribeAll`),
   * so a prematurely-dropped row self-heals on the next connect. Do NOT "optimize"
   * that into a `subscriptionRequired`-gated resubscribe — the flag is computed from
   * the Gateway's grace alarm and cannot see this delete (backlog: *`subscriptionRequired`
   * is broken*).
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
    const rows = this.#ctx.storage.sql.exec<SubscriberRow>(
      `SELECT resourceId, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM Subscribers WHERE resourceId = ?`,
      resourceId,
    ).toArray();
    return rows;
  }

  /**
   * Inspect the entire Subscribers table — test-only. Production code should
   * use `forResource(resourceId)`.
   */
  list(): SubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec<SubscriberRow>(
      `SELECT resourceId, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt FROM Subscribers`,
    ).toArray();
    return rows;
  }
}

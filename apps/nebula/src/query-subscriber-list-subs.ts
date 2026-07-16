/**
 * QuerySubscriberListSubs — the WATCHER registry for the standalone subscriber-list subscription
 * (tasks/nebula-subscriber-lists.md).
 *
 * A watcher subscribes to a query's LIVE subscriber-list (its distinct-by-`sub` `{ sub, profileId }`
 * roster) WITHOUT being a data-subscriber of that query. This registry tracks who is *watching* the
 * roster — a SEPARATE table from {@link QuerySubs}'s `QuerySubscribers` (the data-subscribers the roster
 * is *projected from*), so a watcher registration never enters the data commit/rerun scan (echo-free by
 * table-separation). A near-clone of `TreeSubscriptions`: clientId-keyed, NO `sub`/permission column
 * (the roster is reachability-gated + uniform, ADR-008), but ALSO keyed by `queryHash`.
 *
 * Delivery: the roster is fanned to these watchers (`forQueryHash`) on any data-subscriber join/leave;
 * a failed push reaps the dead watcher's row via {@link removeWatcher} (a DEDICATED handler on the host,
 * NOT the data-table's `onQueryBroadcastResult`).
 */
export interface QuerySubscriberListWatcherRow {
  queryHash: string;
  clientId: string;
  subscriberBinding: string;
  subscribedAt: string;
}

export class QuerySubscriberListSubs {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.#createSchema();
  }

  #createSchema() {
    // Compound TEXT PK → `WITHOUT ROWID` (durable-objects.md write-cost: no hidden rowid + separate index).
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS QuerySubscriberListSubs (
        queryHash         TEXT NOT NULL,
        clientId          TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL,
        subscribedAt      TEXT NOT NULL,
        PRIMARY KEY (queryHash, clientId)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Register a watcher of `queryHash`'s roster. `clientId`/`subscriberBinding` come from the host wrapper
   * (`callChain`, never params — the caller can only register ITSELF). `INSERT OR REPLACE` keyed by
   * `(queryHash, clientId)` — idempotent, 1 billed write; a reconnect / 2nd tab reuses the row.
   */
  registerWatcher(queryHash: string, clientId: string, subscriberBinding: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO QuerySubscriberListSubs (queryHash, clientId, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?, ?)`,
      queryHash, clientId, subscriberBinding, new Date().toISOString(),
    );
  }

  /**
   * Drop one watcher row (explicit `unsubscribeQuerySubscribers` or the dead-watcher reap on a failed
   * roster push). PK-targeted delete — single billed write. Returns `rowsWritten` (0 on a no-op remove).
   */
  removeWatcher(queryHash: string, clientId: string): number {
    return this.#ctx.storage.sql.exec(
      `DELETE FROM QuerySubscriberListSubs WHERE queryHash = ? AND clientId = ?`,
      queryHash, clientId,
    ).rowsWritten;
  }

  /** Every watcher of one query's roster — the delivery audience for `#broadcastRoster`. */
  forQueryHash(queryHash: string): QuerySubscriberListWatcherRow[] {
    return this.#ctx.storage.sql.exec(
      `SELECT queryHash, clientId, subscriberBinding, subscribedAt
       FROM QuerySubscriberListSubs WHERE queryHash = ?`,
      queryHash,
    ).toArray() as unknown as QuerySubscriberListWatcherRow[];
  }

  /**
   * Drop all watcher rows (ontology-install cleanup — mirrors {@link QuerySubs.clear}). Returns the
   * distinct `(subscriberBinding, clientId)` pairs dropped so the host's `#installState` can UNION them
   * with the data-registry drops and push ONE `OntologyStaleError` per client. `DROP TABLE + recreate`
   * is one billed write (vs per-row `DELETE`).
   */
  clearWatchers(): Array<{ subscriberBinding: string; clientId: string }> {
    const dropped = this.#ctx.storage.sql.exec(
      `SELECT DISTINCT subscriberBinding, clientId FROM QuerySubscriberListSubs`,
    ).toArray() as Array<{ subscriberBinding: string; clientId: string }>;
    this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS QuerySubscriberListSubs;`);
    this.#createSchema();
    return dropped;
  }
}

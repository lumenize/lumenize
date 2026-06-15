/**
 * TreeSubscriptions — per-Star org/permission-tree subscriber registry.
 *
 * The org tree is a per-Star SINGLETON delivered on a dedicated channel (NOT a
 * resource — it never enters the `Subscribers`/`Snapshots` tables). So this
 * registry is keyed by `clientId` ALONE (one tree per Star, no resourceId
 * dimension), deliberately separate from {@link Subscriptions}.
 *
 * Auth is NOT enforced here: the tree is universally visible to any
 * authenticated in-scope client (the gates are `NebulaDO.onBeforeCall`'s aud-lock
 * + `DagTree.getState()`'s auth check — there is no node-level read check, unlike
 * resource subscribe). So this class only owns the table + register/remove/all.
 */

export interface TreeSubscriberRow {
  clientId: string;
  subscriberBinding: string;
  subscribedAt: string;
}

export class TreeSubscriptions {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.#createSchema();
  }

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS TreeSubscribers (
        clientId TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        PRIMARY KEY (clientId)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Register (or refresh) a tree subscriber. Idempotent per `clientId`
   * (`INSERT OR REPLACE` — one billed write). Unlike resource subscribe there's
   * no permission check: the caller's auth was already gated by `onBeforeCall` +
   * `DagTree.getState()` at the call site.
   */
  register(clientId: string, subscriberBinding: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO TreeSubscribers (clientId, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?)`,
      clientId, subscriberBinding, new Date().toISOString(),
    );
  }

  /**
   * Drop a tree subscriber. Called by the drop-on-failed-broadcast cleanup
   * (`Star.onTreeBroadcastResult`) on `ClientDisconnectedError`. PK-targeted
   * delete — single billed write.
   */
  removeSubscriber(clientId: string): void {
    this.#ctx.storage.sql.exec(`DELETE FROM TreeSubscribers WHERE clientId = ?`, clientId);
  }

  /** All tree subscribers — the broadcast target set (every connected client). */
  all(): TreeSubscriberRow[] {
    return this.#ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding, subscribedAt FROM TreeSubscribers`,
    ).toArray() as unknown as TreeSubscriberRow[];
  }
}

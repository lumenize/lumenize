/**
 * ReloadSubscriptions — per-Star dev-preview reload-channel subscriber registry.
 *
 * A **non-resource** per-Star channel modeled exactly on {@link TreeSubscriptions}:
 * keyed by `clientId` ALONE, with no resource / typeName / appVersion checks. The
 * preview client subscribes here (`Star.subscribeReload`); `DevStar.compileSFC`
 * fans out a reload signal (`Star.broadcastReload`) after persisting a new bundle.
 *
 * Why its own channel (not a resource subscribe): a compile writes a bundle to
 * Star storage, which triggers no resource broadcast, and `Subscriptions.subscribe`
 * hard-throws unless the target is a pre-existing, typeName-matched, read-permitted
 * resource — neither of which a "reload marker" is. Separate table from
 * `Subscribers` (resource) and `TreeSubscribers` (org tree).
 */

export interface ReloadSubscriberRow {
  clientId: string;
  subscriberBinding: string;
  subscribedAt: string;
}

export class ReloadSubscriptions {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.#createSchema();
  }

  #createSchema() {
    this.#ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ReloadSubscribers (
        clientId TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        PRIMARY KEY (clientId)
      ) WITHOUT ROWID;
    `);
  }

  /** Register (or refresh) a reload subscriber. Idempotent per `clientId`
   *  (`INSERT OR REPLACE` — one billed write). No permission check: the caller's
   *  auth was already gated by `onBeforeCall` at the call site. */
  register(clientId: string, subscriberBinding: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ReloadSubscribers (clientId, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?)`,
      clientId, subscriberBinding, new Date().toISOString(),
    );
  }

  /** Drop a reload subscriber (drop-on-failed-broadcast cleanup on
   *  `ClientDisconnectedError`). PK-targeted delete — single billed write. */
  removeSubscriber(clientId: string): void {
    this.#ctx.storage.sql.exec(`DELETE FROM ReloadSubscribers WHERE clientId = ?`, clientId);
  }

  /** All reload subscribers — the broadcast target set. */
  all(): ReloadSubscriberRow[] {
    return this.#ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding, subscribedAt FROM ReloadSubscribers`,
    ).toArray() as unknown as ReloadSubscriberRow[];
  }
}

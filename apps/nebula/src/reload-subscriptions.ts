/**
 * ReloadSubscriptions — a host's preview-reload-channel subscriber registry.
 *
 * A **non-resource** channel modeled exactly on {@link TreeSubscriptions}: keyed by
 * `clientId` ALONE, with no resource / typeName / ontologyVersion checks — nothing in
 * it is host-specific. Two hosts hold one: the **Galaxy**'s is live (Studio registers
 * over the chat pair; `Galaxy.broadcastReload` fires on build completion, and Studio
 * reloads the preview iframe it composes), and the **Star**'s is parked as publish's
 * future refresh signal (its former ontology-install trigger retired with the
 * collapse — the label is baked at build, so one turn fires one reload).
 *
 * Why its own channel (not a resource subscribe): a reload signal triggers no
 * resource broadcast, and `Subscriptions.subscribe` hard-throws unless the target is
 * a pre-existing, typeName-matched, read-permitted resource — which a "reload
 * marker" is not. Separate table from
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

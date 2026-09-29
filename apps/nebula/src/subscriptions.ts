/**
 * Subscriptions — every subscription a host's plane holds, in one table.
 *
 * Four kinds share one delivery address — `clientId` · `subscriberBinding` · `subscribedAt` — and
 * one key, `(kind, topic, clientId)`:
 *
 *   | kind       | who                                   | topic                  |
 *   |------------|---------------------------------------|------------------------|
 *   | `resource` | a subscriber to one Resource          | its `resourceId`       |
 *   | `query`    | a subscriber to a query's data        | the query's `queryHash` |
 *   | `roster`   | a WATCHER of a query's subscriber list | the query's `queryHash` |
 *   | `tree`     | a subscriber to the host's org tree   | `''` — one tree per host |
 *
 * A chat participant is a query subscriber AND a roster watcher of the same query, so two kinds
 * share a topic, which is why `kind` is part of the key.
 *
 * **The kinds differ in AUTHORIZATION.** A resource or query row gets a permission evaluation on
 * every update, so it carries the subscriber's `sub`, `profileId` and the stored dominion verdict;
 * only a query row carries the stored `query` every re-run reads. The evaluation keys on the row's
 * `kind`, never on whether a `sub` happens to be present, and the table's `CHECK` constraints make
 * a row that breaks its kind unwritable.
 *
 * **Roster and tree rows carry no identity because seeing them changes nothing a caller can do.**
 * The org tree and a query's roster are visible to anyone with passage into the host, on every
 * host — a tenant reaching its Galaxy included. Every action is checked where it is taken, so
 * seeing who is on the tree or watching a query buys a caller nothing to act on, and what they
 * name leads only to profiles ADR-012 already opens by id. What a stranger learns is who is on an
 * app's team and when they are present, which is low-sensitivity. That is ADR-008's visibility ≠
 * capability carried up the hierarchy (ADR-015's *Deliberately open*), and it is why neither kind
 * has a guard of its own: its subscribe needs authentication and passage, nothing else.
 */

import type { CallContext } from '@lumenize/mesh';
import { hasDominionOver } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import type { SQLSchemaMigration } from '@lumenize/sql-migrations';
import { stringify } from '@lumenize/structured-clone';
import { PermissionDeniedError } from './errors';
import { canonicalQueryHash } from './query-hash';
import type { QueryDescriptor } from './query-hash';
import type { Snapshots, Snapshot } from './snapshots';

export type SubscriptionKind = 'resource' | 'query' | 'roster' | 'tree';

/** A fresh marker: the merged table starts its own migration history at id 1, which is safe only
 *  because this key has never recorded a high-water mark (`durable-objects.md` § *Initialization*). */
const SUBSCRIPTIONS_MARKER_KEY = '__sql_migrations_Subscriptions';

/**
 * Append-only migration list for the `Subscriptions` table. **APPEND-ONLY** — never edit, reorder
 * or reuse an applied id. The column rules are `CHECK` constraints written here, at creation,
 * because SQLite has no `ALTER TABLE ADD CONSTRAINT`. Each rule is its own constraint so one can be
 * read, and removed, without the others; each is written NULL-safe, since a `CHECK` that evaluates
 * to NULL passes.
 */
const SUBSCRIPTIONS_MIGRATIONS: SQLSchemaMigration[] = [
  {
    idMonotonicInc: 1,
    description: 'baseline: Subscriptions, one row per (kind, topic, client)',
    sql: `CREATE TABLE IF NOT EXISTS Subscriptions (
      kind TEXT NOT NULL,
      topic TEXT NOT NULL,
      clientId TEXT NOT NULL,
      subscriberBinding TEXT NOT NULL,
      subscribedAt TEXT NOT NULL,
      sub TEXT,
      profileId TEXT,
      dominionOverHostAtSubscribe INTEGER,
      query TEXT,
      PRIMARY KEY (kind, topic, clientId),
      CHECK (kind IN ('resource', 'query', 'roster', 'tree')),
      CHECK ((kind IN ('resource', 'query')) = (sub IS NOT NULL)),
      CHECK ((kind IN ('resource', 'query')) = (profileId IS NOT NULL)),
      CHECK (CASE WHEN kind IN ('resource', 'query')
                  THEN dominionOverHostAtSubscribe IS NOT NULL AND dominionOverHostAtSubscribe IN (0, 1)
                  ELSE dominionOverHostAtSubscribe IS NULL END),
      CHECK ((kind = 'query') = (query IS NOT NULL)),
      CHECK (kind <> 'tree' OR topic = '')
    ) WITHOUT ROWID`,
  },
];

/** A subscriber to one Resource. */
export type SubscriberRow = {
  resourceId: string;
  clientId: string;
  sub: string;
  /** The subscriber's public `profileId` claim at subscribe time. */
  profileId: string;
  /**
   * The **confined** scope-admin verdict at subscribe time (0/1) — `hasDominionOver(access,
   * <host instance name>)`, NOT the raw `claims.access.scopeAdmin` bit. It replicates the
   * Galaxy/Universe scope-admin bypass for the per-update recheck, since the update path holds no
   * token; a Star DAG `admin` grant resolves through `resolvePermission` normally.
   *
   * Storing a verdict rather than the claim is what closes the push-path back door: the update
   * path never re-reads the JWT, so confining only the live claim would leave this bypass
   * unconfined. The stored value is **monotonically narrowing** — a strict conjunct-subset of the
   * raw bit, and the host instance name is immutable for the DO's lifetime, so drift can only go
   * 1→0 (under-privilege), never 0→1 (ADR-013). **It converges on a changed claim by
   * re-subscription**: `NebulaClient` re-issues every subscription on reconnect, which re-derives
   * the bit from the fresh token.
   */
  dominionOverHostAtSubscribe: number;
  subscriberBinding: string;
  subscribedAt: string;
};

/** A subscriber to a query's data. */
export type QuerySubscriberRow = {
  queryHash: string;
  /** The full query object, structured-clone-stringified — parsed by every re-run. */
  query: string;
  clientId: string;
  sub: string;
  /** The subscriber's public `profileId` claim — the roster's display handle. */
  profileId: string;
  /** The confined dominion verdict — see {@link SubscriberRow.dominionOverHostAtSubscribe}. */
  dominionOverHostAtSubscribe: number;
  subscriberBinding: string;
  subscribedAt: string;
};

/** A roster watcher or a tree subscriber: the delivery address alone. */
export type AddressRow = {
  clientId: string;
  subscriberBinding: string;
  subscribedAt: string;
};

/** The distinct delivery addresses a clear dropped — one notice per client, however many rows. */
export type DroppedAddress = { subscriberBinding: string; clientId: string };

/** A resource subscribe's answer: the snapshot a reader gets, or the node a denied subscriber is
 *  told it cannot read. */
export type ResourceSubscribeOutcome = { snapshot: Snapshot } | { deniedNodes: [string] };

export class Subscriptions {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  #snapshots: Snapshots;
  #getHostName: () => string | undefined;

  /** @param getHostName - The host's instance name as a **thunk** (identity is not stamped at
   *   `onStart()` time, when this is constructed) — the scope the stored verdict is confined to. */
  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    snapshots: Snapshots,
    getHostName: () => string | undefined,
  ) {
    this.#ctx = ctx;
    this.#getCallContext = getCallContext;
    this.#snapshots = snapshots;
    this.#getHostName = getHostName;
    new SQLSchemaMigrations({
      doStorage: this.#ctx.storage,
      markerKey: SUBSCRIPTIONS_MARKER_KEY,
      migrations: SUBSCRIPTIONS_MIGRATIONS,
    }).runAll();
  }

  /**
   * The subscriber identity a resource or query row stores: `sub`, `profileId` and the CONFINED
   * dominion verdict. ⚠️ `hasDominionOver(...)`, NOT `claims.access.scopeAdmin` — confinement
   * point 2. The update path never re-reads the JWT, so storing the bare claim would leave a
   * descendant-scope admin an unconfined bypass for the life of the subscription. Store time is
   * the only option: at update time we hold neither the live claim nor the caller's scope. An
   * absent host name grants no bypass (fail closed).
   */
  #identity(): { sub: string; profileId: string; dominion: 0 | 1 } {
    const cc = this.#getCallContext();
    const sub = cc.originAuth?.sub;
    if (!sub) throw new Error('Authentication required');
    const claims = cc.originAuth?.claims as unknown as NebulaJwtPayload;
    const hostName = this.#getHostName();
    return {
      sub,
      profileId: claims.profileId,
      dominion: hostName && hasDominionOver(claims.access, hostName) ? 1 : 0,
    };
  }

  // ─── resource ──────────────────────────────────────────────────────

  /**
   * Subscribe a client to a Resource, and say what it may see. Every permission outcome
   * registers the row; nothing else does.
   *
   * In order: the resource must exist (a subscribe before its create is refused); then the caller's
   * read permission decides; then the type the caller named must match. A reader gets the current
   * snapshot. A caller who cannot read gets `{ deniedNodes: [nodeId] }` and a row, so the next
   * update tells it again — and if it named the wrong type, it is refused with a message naming
   * only the type it asked for, since the resource's real type is not its to read. An
   * unauthenticated caller is refused. A refusal writes no row.
   */
  subscribeResource(
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ): ResourceSubscribeOutcome {
    let snapshot: Snapshot | null;
    try {
      snapshot = this.#snapshots.read(resourceId);
    } catch (e) {
      if (!(e instanceof PermissionDeniedError)) throw e;
      if (this.#snapshots.currentTypeName(resourceId) !== resourceType) {
        throw new Error(`Resource '${resourceId}' is not a '${resourceType}'`);
      }
      this.#insertResource(resourceId, clientId, subscriberBinding);
      return { deniedNodes: [e.nodeId] };
    }
    if (snapshot === null) {
      throw new Error(`Resource '${resourceId}' not found — cannot subscribe before create`);
    }
    if (snapshot.meta.typeName !== resourceType) {
      throw new Error(
        `Resource type mismatch: '${resourceId}' is type '${snapshot.meta.typeName}', requested '${resourceType}'`,
      );
    }
    this.#insertResource(resourceId, clientId, subscriberBinding);
    return { snapshot };
  }

  #insertResource(resourceId: string, clientId: string, subscriberBinding: string): void {
    const { sub, profileId, dominion } = this.#identity();
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscriptions
         (kind, topic, clientId, subscriberBinding, subscribedAt, sub, profileId, dominionOverHostAtSubscribe)
       VALUES ('resource', ?, ?, ?, ?, ?, ?, ?)`,
      resourceId, clientId, subscriberBinding, new Date().toISOString(), sub, profileId, dominion,
    );
  }

  /**
   * Drop one resource row. `ClientDisconnectedError` does NOT mean "gone past the grace period" —
   * the Gateway raises it for a live socket whose token expired too — but dropping is still right,
   * because `NebulaClient` re-issues every subscription on reconnect (`#resubscribeAll`), so a
   * prematurely dropped row heals on the next connect. PK-targeted: one billed write.
   */
  removeResource(resourceId: string, clientId: string): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM Subscriptions WHERE kind = 'resource' AND topic = ? AND clientId = ?`,
      resourceId, clientId,
    );
  }

  /** Every subscriber to one Resource — the update's audience. PK-prefix scan. */
  forResource(resourceId: string): SubscriberRow[] {
    return this.#ctx.storage.sql.exec<SubscriberRow>(
      `SELECT topic AS resourceId, clientId, sub, profileId, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM Subscriptions WHERE kind = 'resource' AND topic = ?`,
      resourceId,
    ).toArray();
  }

  // ─── query ─────────────────────────────────────────────────────────

  /**
   * Register a query subscriber. **Always registers** — authorization is at delivery, never here —
   * so an authenticated caller always gets a row. `INSERT OR REPLACE` keyed by
   * `(kind, queryHash, clientId)`: a re-subscribe reuses the row.
   *
   * `isNewSub` says whether this `sub` was ABSENT from the query's subscribers before — a
   * distinct-by-`sub` gain. The roster goes to watchers only on one: `subscribeQuery` is
   * idempotent, so the insert cannot tell a genuine join from a reconnect or a second tab.
   */
  registerQuery(
    query: QueryDescriptor,
    clientId: string,
    subscriberBinding: string,
  ): { queryHash: string; row: QuerySubscriberRow; isNewSub: boolean } {
    const { sub, profileId, dominion } = this.#identity();
    const queryHash = canonicalQueryHash(query);
    const queryBlob = stringify(query);
    const subscribedAt = new Date().toISOString();
    const isNewSub = !this.forQuery(queryHash).some((r) => r.sub === sub);
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscriptions
         (kind, topic, clientId, subscriberBinding, subscribedAt, sub, profileId, dominionOverHostAtSubscribe, query)
       VALUES ('query', ?, ?, ?, ?, ?, ?, ?, ?)`,
      queryHash, clientId, subscriberBinding, subscribedAt, sub, profileId, dominion, queryBlob,
    );
    return {
      queryHash,
      row: { queryHash, query: queryBlob, clientId, sub, profileId, dominionOverHostAtSubscribe: dominion, subscriberBinding, subscribedAt },
      isNewSub,
    };
  }

  /** Drop one query row. Returns `rowsWritten` (0 on a no-op) so the roster goes to watchers only
   *  on an actual removal — the mass-disconnect-storm guard. */
  removeQuery(queryHash: string, clientId: string): number {
    return this.#ctx.storage.sql.exec(
      `DELETE FROM Subscriptions WHERE kind = 'query' AND topic = ? AND clientId = ?`,
      queryHash, clientId,
    ).rowsWritten;
  }

  /** Every subscriber of one query. */
  forQuery(queryHash: string): QuerySubscriberRow[] {
    return this.#ctx.storage.sql.exec<QuerySubscriberRow>(
      `SELECT topic AS queryHash, query, clientId, sub, profileId, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM Subscriptions WHERE kind = 'query' AND topic = ?`,
      queryHash,
    ).toArray();
  }

  /** Every live query row — the commit re-run groups these by `queryHash`. */
  allQueries(): QuerySubscriberRow[] {
    return this.#ctx.storage.sql.exec<QuerySubscriberRow>(
      `SELECT topic AS queryHash, query, clientId, sub, profileId, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM Subscriptions WHERE kind = 'query'`,
    ).toArray();
  }

  // ─── roster ────────────────────────────────────────────────────────

  /** Register a watcher of a query's roster. Idempotent per `(queryHash, clientId)`. */
  registerRoster(queryHash: string, clientId: string, subscriberBinding: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscriptions (kind, topic, clientId, subscriberBinding, subscribedAt)
       VALUES ('roster', ?, ?, ?, ?)`,
      queryHash, clientId, subscriberBinding, new Date().toISOString(),
    );
  }

  /** Drop one watcher row — from the roster rows only, so a client that is also a data subscriber
   *  of the query keeps that row. Returns `rowsWritten`. */
  removeRoster(queryHash: string, clientId: string): number {
    return this.#ctx.storage.sql.exec(
      `DELETE FROM Subscriptions WHERE kind = 'roster' AND topic = ? AND clientId = ?`,
      queryHash, clientId,
    ).rowsWritten;
  }

  /** Every watcher of one query's roster — the roster update's audience. */
  watchersOf(queryHash: string): AddressRow[] {
    return this.#ctx.storage.sql.exec<AddressRow>(
      `SELECT clientId, subscriberBinding, subscribedAt FROM Subscriptions WHERE kind = 'roster' AND topic = ?`,
      queryHash,
    ).toArray();
  }

  // ─── tree ──────────────────────────────────────────────────────────

  /** Register a tree subscriber. Idempotent per `clientId` (the topic is always `''`). */
  registerTree(clientId: string, subscriberBinding: string): void {
    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscriptions (kind, topic, clientId, subscriberBinding, subscribedAt)
       VALUES ('tree', '', ?, ?, ?)`,
      clientId, subscriberBinding, new Date().toISOString(),
    );
  }

  /** Drop one tree subscriber. */
  removeTree(clientId: string): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM Subscriptions WHERE kind = 'tree' AND topic = '' AND clientId = ?`,
      clientId,
    );
  }

  /** Every tree subscriber — the tree update's audience. */
  treeSubscribers(): AddressRow[] {
    return this.#ctx.storage.sql.exec<AddressRow>(
      `SELECT clientId, subscriberBinding, subscribedAt FROM Subscriptions WHERE kind = 'tree'`,
    ).toArray();
  }

  // ─── clear by kind ─────────────────────────────────────────────────

  /**
   * Drop every row of the given kinds, and return the distinct addresses dropped — so the caller
   * sends each client one notice however many rows it held. An ordinary ontology install clears
   * `resource`, `query` and `roster` and leaves `tree` alone: the tree does not depend on the
   * ontology.
   *
   * A per-row `DELETE`, billed per row. Each old registry dropped its own table and replayed its
   * DDL, one billed write; one table cannot be dropped to clear some of its kinds without saving
   * and restoring the rest, and an install is rare, so the per-row cost is the cheaper mistake.
   */
  clear(kinds: SubscriptionKind[]): DroppedAddress[] {
    if (kinds.length === 0) return [];
    const marks = kinds.map(() => '?').join(', ');
    const dropped = this.#ctx.storage.sql.exec<DroppedAddress>(
      `SELECT DISTINCT subscriberBinding, clientId FROM Subscriptions WHERE kind IN (${marks})`,
      ...kinds,
    ).toArray();
    this.#ctx.storage.sql.exec(`DELETE FROM Subscriptions WHERE kind IN (${marks})`, ...kinds);
    return dropped;
  }
}

/**
 * QuerySubs — per-host query-subscription registry (Child 2).
 *
 * A near-clone of {@link Subscriptions} (D13): same constructor injection
 * `(ctx, getCallContext, dagTree, resources)`, same `clear()`/`all()` shapes, same
 * `INSERT OR REPLACE` / `WITHOUT ROWID` / deploy-driven `clear()` cleanup, same
 * dead-client reactive cleanup. Deliberate divergences:
 *   - the add/remove pair is fully-qualified `registerQuerySubscriber` /
 *     `removeQuerySubscriber` (the PUBLIC surface is `@mesh subscribeQuery`, so the
 *     internal ops read as internal — and disambiguate from `Subscriptions` at the
 *     shared `onBroadcastResult` cleanup site);
 *   - the content key is **`queryHash`** + a stored `query` blob, not a bare
 *     `resourceId` (the hash is query-shape-agnostic, so a future `queryType` needs
 *     no schema change);
 *   - `registerQuerySubscriber` **always succeeds** — no permission check at
 *     registration (authorize at delivery, D2/D4);
 *   - `sub` + `accessAdmin` are derived from `getCallContext().originAuth` INSIDE
 *     the registry (the `sub` and `claims.access.admin`), never params (D13/D16).
 */

import type { CallContext } from '@lumenize/mesh';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { stringify } from '@lumenize/structured-clone';
import { canonicalQueryHash } from './query-hash';
import type { QueryDescriptor } from './query-hash';
import type { DagTree } from './dag-tree';
import type { Resources } from './resources';

export interface QuerySubscriberRow {
  queryHash: string;
  /** The full query object, structured-clone-stringified — parsed in Flow 3 to
   *  read `typeName` (rerun selection) + `onPartial` (per-push shape). */
  query: string;
  clientId: string;
  sub: string;
  /** The `claims.access.admin` flag at subscribe time (0/1) — D16, same as Subscribers. */
  accessAdmin: number;
  subscriberBinding: string;
  subscribedAt: string;
}

export class QuerySubs {
  #ctx: DurableObjectState;
  #getCallContext: () => CallContext;
  // dagTree/resources are injected for parity with Subscriptions + so the registry
  // could later own selection logic; the membership eval/enumerate currently lives
  // in the capability, which holds its own refs.
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
      CREATE TABLE IF NOT EXISTS QuerySubscribers (
        queryHash         TEXT NOT NULL,
        query             TEXT NOT NULL,
        clientId          TEXT NOT NULL,
        sub               TEXT NOT NULL,
        accessAdmin       INTEGER NOT NULL DEFAULT 0,
        subscriberBinding TEXT NOT NULL,
        subscribedAt      TEXT NOT NULL,
        PRIMARY KEY (queryHash, clientId)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Drop all query-sub rows (ontology-install/deploy cleanup, mirrors
   * {@link Subscriptions.clear}). A query sub spans types, so an install almost
   * always invalidates it. Returns the distinct `(subscriberBinding, clientId)`
   * pairs dropped, so `Star.#installState` can union them with the single-resource
   * drops and push ONE `OntologyStaleError` per client (m1). `DROP TABLE +
   * recreate` is one billed write (vs per-row `DELETE`).
   */
  clear(): Array<{ subscriberBinding: string; clientId: string }> {
    const dropped = this.#ctx.storage.sql.exec(
      `SELECT DISTINCT subscriberBinding, clientId FROM QuerySubscribers`,
    ).toArray() as Array<{ subscriberBinding: string; clientId: string }>;
    this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS QuerySubscribers;`);
    this.#createSchema();
    return dropped;
  }

  /**
   * Register a query subscriber. **Always succeeds** — no permission check at
   * registration (authorization is at delivery, D2/D4). Computes the canonical
   * `queryHash`, derives `sub`/`accessAdmin` from `originAuth` (never params, D16),
   * stores the whole query object (for Flow-3 re-eval). `INSERT OR REPLACE` keyed
   * by `(queryHash, clientId)` — idempotent, 1 billed write; a re-subscribe (same
   * canonical query) reuses the row.
   *
   * Returns the `queryHash` + the stored row so the caller can run the
   * membership-delivery routine scoped to just this new subscriber (Flow 1).
   */
  registerQuerySubscriber(
    query: QueryDescriptor,
    clientId: string,
    subscriberBinding: string,
  ): { queryHash: string; row: QuerySubscriberRow } {
    const cc = this.#getCallContext();
    const sub = cc.originAuth?.sub;
    if (!sub) throw new Error('Authentication required');
    const claims = cc.originAuth?.claims as NebulaJwtPayload | undefined;
    const accessAdmin = claims?.access?.admin ? 1 : 0;

    const queryHash = canonicalQueryHash(query);
    const queryBlob = stringify(query);
    const subscribedAt = new Date().toISOString();

    this.#ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO QuerySubscribers
         (queryHash, query, clientId, sub, accessAdmin, subscriberBinding, subscribedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      queryHash, queryBlob, clientId, sub, accessAdmin, subscriberBinding, subscribedAt,
    );

    return {
      queryHash,
      row: { queryHash, query: queryBlob, clientId, sub, accessAdmin, subscriberBinding, subscribedAt },
    };
  }

  /**
   * Drop one query-sub row. `clientId` is supplied by the Handler-1 wrapper from
   * `callChain[0]` (NEVER a param), so a client can only drop its OWN row (m3).
   * PK-targeted delete — single billed write. Called by `unsubscribeQuery` and by
   * the reactive dead-client cleanup (`onBroadcastResult` → here).
   */
  removeQuerySubscriber(queryHash: string, clientId: string): void {
    this.#ctx.storage.sql.exec(
      `DELETE FROM QuerySubscribers WHERE queryHash = ? AND clientId = ?`,
      queryHash, clientId,
    );
  }

  /** All subscribers of one query (Flow-3 delivery: the rows sharing a `queryHash`). */
  forQueryHash(queryHash: string): QuerySubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT queryHash, query, clientId, sub, accessAdmin, subscriberBinding, subscribedAt
       FROM QuerySubscribers WHERE queryHash = ?`,
      queryHash,
    ).toArray();
    return rows as unknown as QuerySubscriberRow[];
  }

  /** Every live query-sub row — the Flow-3 rerun selection groups these by
   *  `queryHash` (parsing each `query` for its `typeName`). */
  all(): QuerySubscriberRow[] {
    const rows = this.#ctx.storage.sql.exec(
      `SELECT queryHash, query, clientId, sub, accessAdmin, subscriberBinding, subscribedAt
       FROM QuerySubscribers`,
    ).toArray();
    return rows as unknown as QuerySubscriberRow[];
  }
}

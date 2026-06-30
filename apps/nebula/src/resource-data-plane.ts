/**
 * ResourceDataPlane — the composable resource data-plane capability.
 *
 * Lifted out of `Star` (Child 1 of the multi-user chat thread) so it can be
 * composed by ANY Nebula node that needs to host Resources — `Star` today,
 * `DevStudio` next (chat `Session`/`Turn` Resources). ADR-007: composition,
 * never reimplemented.
 *
 * It owns the data-plane trio — `DagTree` + `Resources` + `Subscriptions` — and
 * **Handler 2** (the actual resource op + result-delivery + the mutation
 * broadcast). It deliberately does NOT own:
 *   - **Handler 1 / the ontology-version gate** — Galaxy's multi-version concern,
 *     stays per-host (Star gates; DevStudio's single fixed ontology is never
 *     stale). See `nebula-devstudio-data-plane.md` D8.
 *   - **mesh I/O construction** — the capability has no `this.lmz`/`this.ctn`
 *     (like `Resources`/`DagTree`, which is why they take `()=>callContext`).
 *     All continuation construction stays host-side, reached via the injected
 *     {@link ResourceHostBridge}.
 *   - **the ontology source** — reached only via the injected {@link OntologyProvider}
 *     (Star: Galaxy-cached row; DevStudio: a compiled platform constant), so the
 *     capability never couples to Galaxy.
 */

import { debug } from '@lumenize/debug';
import type { CallContext } from '@lumenize/mesh';
import type { ParserValidator, TypeMetadata } from '@lumenize/ts-runtime-parser-validator';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import { Subscriptions } from './subscriptions';
import { QuerySubs } from './query-subscriptions';
import type { QuerySubscriberRow } from './query-subscriptions';
import { canonicalQueryHash } from './query-hash';
import type { QueryDescriptor, QueryUpdatePayload } from './query-hash';
import { parse } from '@lumenize/structured-clone';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';

/**
 * Supplies the active ontology `{ version, facet, relationships }` for resource
 * ops — the only way the capability learns about the ontology (it never fetches
 * it itself). Star's impl reads the Galaxy-cached row; DevStudio's compiles the
 * in-source `Session`/`Turn` types. `version` is stamped into snapshot metadata
 * and is therefore server-sourced, never client-supplied.
 *
 * `relationships` is the compiled ontology's relationship metadata
 * (`Record<typeName, Record<field, Relationship>>`) — needed by `subscribeQuery`
 * (Child 2) to validate that a query's `field` exists on `typeName` and is a
 * to-one relationship (D11/D1). Widened from Child 1's `{ version, facet }`; both
 * providers already produce it (the Galaxy-cached row carries it; DevStudio's
 * `compileOntologyVersion` emits it).
 */
export type OntologyProvider = () => {
  version: string;
  facet: ParserValidator;
  relationships: TypeMetadata['relationships'];
};

/** A single fanout destination — `{ bindingName, instanceName }` (the Gateway + clientId). */
export interface BroadcastTarget {
  bindingName: string;
  instanceName: string;
}

/**
 * Host-side mesh I/O the data-plane invokes. The host DO (Star/DevStudio)
 * implements each method with its own `this.lmz`/`this.ctn`/`this.svc`, so every
 * continuation is constructed host-side (ADR-007 / review m1). Delivery targets
 * the originating client via the `NEBULA_CLIENT_GATEWAY` binding; broadcast
 * targets carry their own per-subscriber binding.
 */
export interface ResourceHostBridge {
  deliverTransactionResult(clientId: string, result: TransactionResult | Error): void;
  deliverReadResponse(clientId: string, requestId: string, result: Snapshot | null | Error): void;
  deliverResourceUpdate(
    clientId: string,
    resourceType: string,
    resourceId: string,
    result: Snapshot | Error,
  ): void;
  /** Fan a committed mutation out to `targets` (originator already excluded). The
   *  host owns the `svc.broadcast` call + its drop-on-failed-fanout cleanup. */
  broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]): void;
  /** Fan a query membership push to the NO-DENIAL group — one identical payload
   *  (the full `resourceIds`) via `svc.broadcast` (D4/D17). Attaches the 4-arg
   *  `onResult` so dead-client cleanup reaps these rows too (m6). */
  broadcastQueryUpdate(queryHash: string, resourceIds: string[], targets: BroadcastTarget[]): void;
  /** Deliver an INDIVIDUALIZED query push to one has-denial subscriber (always
   *  carries `deniedNodes`; `resourceIds` iff `onPartial:'allow'` — D4/D14), or an
   *  Error (validation failure). Also `onResult`-cleaned (m6). */
  deliverQueryUpdate(clientId: string, queryHash: string, result: QueryUpdatePayload | Error): void;
}

export class ResourceDataPlane {
  #getOntology: OntologyProvider;
  #bridge: ResourceHostBridge;
  #dagTree: DagTree;
  #resources: Resources;
  #subscriptions: Subscriptions;
  #querySubs: QuerySubs;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    getOntology: OntologyProvider,
    bridge: ResourceHostBridge,
    onDagChanged: () => void,
  ) {
    this.#getOntology = getOntology;
    this.#bridge = bridge;
    // The capability hangs the Flow-3 trigger B (D6) rerun off DagTree's onChanged,
    // IN ADDITION to the host's hook (Star's org-tree broadcast / DevStudio's no-op).
    // A permission change reruns ALL live queries (a grant changes readability across
    // every type → no typeName filter); cheap at v1 scale, no drops (D5). The host
    // hook runs first, then the query rerun. (Fires only AFTER construction — on a
    // real DAG mutation — so `#querySubs`, assigned below, always exists by then.)
    this.#dagTree = new DagTree(ctx, getCallContext, () => {
      onDagChanged();
      this.#rerunQueries(() => true);
    });
    this.#resources = new Resources(ctx, getCallContext, this.#dagTree);
    this.#subscriptions = new Subscriptions(ctx, getCallContext, this.#dagTree, this.#resources);
    this.#querySubs = new QuerySubs(ctx, getCallContext, this.#dagTree, this.#resources);
  }

  /** The composed DAG tree — the host's `@mesh dagTree()` entry returns this. */
  get dagTree(): DagTree {
    return this.#dagTree;
  }

  /** Drop all subscriber rows (deploy/ontology-install cleanup). Star's
   *  host-retained `#installState` calls this on a new-version install. */
  clearSubscribers(): Array<{ subscriberBinding: string; clientId: string }> {
    return this.#subscriptions.clear();
  }

  /** Drop one subscriber row — the host's broadcast-result handler calls this on
   *  a `ClientDisconnectedError` (drop-on-failed-fanout cleanup). */
  removeSubscriber(resourceId: string, clientId: string): void {
    this.#subscriptions.removeSubscriber(resourceId, clientId);
  }

  /** Drop all query-sub rows (ontology-install cleanup). Returns the distinct
   *  `(subscriberBinding, clientId)` pairs dropped so the host can UNION them with
   *  `clearSubscribers()` and push ONE `OntologyStaleError` per client (m1). */
  clearQuerySubscribers(): Array<{ subscriberBinding: string; clientId: string }> {
    return this.#querySubs.clear();
  }

  /** Drop one query-sub row — `unsubscribeQuery` + the host's query-broadcast-result
   *  handler call this (the latter on a `ClientDisconnectedError`, m6). */
  removeQuerySubscriber(queryHash: string, clientId: string): void {
    this.#querySubs.removeQuerySubscriber(queryHash, clientId);
  }

  // ─── Handler 2 (the actual op + delivery) ──────────────────────────

  /** Execute a transaction at the host's current ontology version + deliver the
   *  result. Committed mutations fan out via the bridge (originator excluded). */
  async doTransaction(
    newETag: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ): Promise<void> {
    try {
      const { version, facet } = this.#getOntology();
      const result = await this.#resources.transaction(ops, version, newETag, facet,
        (mutations) => {
          // The single post-commit hook drives BOTH channels (Flow 2 + Flow 3 A):
          // single-resource content fanout, then the query rerun for touched types.
          this.#broadcast(mutations, clientId);
          this.#rerunQueriesForCommit(mutations);
        });
      this.#bridge.deliverTransactionResult(clientId, result);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doTransaction').error('handler threw', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverTransactionResult(clientId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Read a resource (DAG read-permission enforced in `Resources.read`) + deliver. */
  doRead(resourceId: string, requestId: string, clientId: string): void {
    try {
      const snapshot = this.#resources.read(resourceId);
      this.#bridge.deliverReadResponse(clientId, requestId, snapshot);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doRead').error('handler threw', {
        clientId,
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverReadResponse(clientId, requestId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Register a subscriber (subscribe-time DAG read check + existence/type checks
   *  in `Subscriptions.subscribe`) + push the initial snapshot. */
  doSubscribe(
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ): void {
    try {
      const snapshot = this.#subscriptions.subscribe(resourceType, resourceId, clientId, subscriberBinding);
      this.#bridge.deliverResourceUpdate(clientId, resourceType, resourceId, snapshot);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doSubscribe').error('handler threw', {
        clientId,
        resourceType,
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverResourceUpdate(clientId, resourceType, resourceId,
        err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─── Query subscriptions (Child 2) ─────────────────────────────────

  /**
   * Register a query subscriber (Flow 1) + push the initial membership state.
   * **Registration always succeeds** — no permission check (authorize at delivery,
   * D2/D4) — but the query is FIRST validated against the ontology contract
   * (`queryType` known, `field` a to-one relationship, `orderBy` supported, D1/D12).
   * On a validation failure NOTHING is registered and the error is delivered to the
   * client keyed by the (locally-computed) `queryHash` so its handle rejects (an
   * unknown `queryType` thus fails CLOSED). On success the membership-delivery
   * routine runs scoped to JUST this new subscriber.
   */
  doSubscribeQuery(query: QueryDescriptor, clientId: string, subscriberBinding: string): void {
    try {
      this.#validateQuery(query);
    } catch (err) {
      const queryHash = canonicalQueryHash(query);
      debug('nebula.ResourceDataPlane.doSubscribeQuery').warn('query rejected', {
        clientId, queryType: query.queryType, typeName: query.typeName, field: query.field,
        error: err instanceof Error ? err.message : String(err),
      });
      this.#bridge.deliverQueryUpdate(clientId, queryHash,
        err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const { row } = this.#querySubs.registerQuerySubscriber(query, clientId, subscriberBinding);
    // Initial push — scoped to the one new subscriber (mirrors single-resource
    // subscribe, which pushes the first snapshot rather than returning it).
    this.#broadcastQueries(query, [row]);
  }

  /**
   * Validate a query against the ontology contract (D1/D12). Throws on:
   *   - an unknown `queryType` (v1 supports only `'parentChild'` — fail closed so an
   *     app on a newer type gets a clean error, not garbage);
   *   - a `field` that isn't a to-one relationship on `typeName` (per the seam's
   *     `relationships` metadata, D11);
   *   - an unsupported `orderBy` (v1 only `'validFrom'`, D15).
   */
  #validateQuery(query: QueryDescriptor): void {
    if (query.queryType !== 'parentChild') {
      throw new Error(`Unsupported queryType '${query.queryType}' — v1 supports only 'parentChild'`);
    }
    const rels = this.#getOntology().relationships;
    const rel = rels[query.typeName]?.[query.field];
    if (!rel || rel.cardinality !== 'one') {
      throw new Error(
        `Query field '${query.typeName}.${query.field}' must be a to-one relationship`,
      );
    }
    if (query.orderBy !== undefined && query.orderBy !== 'validFrom') {
      throw new Error(`Unsupported orderBy '${query.orderBy}' — v1 supports only 'validFrom'`);
    }
  }

  /**
   * The one queryType-specific step (D-generic routine): evaluate a query to its
   * current ordered result set. v1 `parentChild` → `enumerateCurrentByField` over
   * current snapshots (full scan while D8 defers the index, M1).
   */
  #evaluateQuery(query: QueryDescriptor): Array<{ resourceId: string; nodeId: number }> {
    return this.#resources.enumerateCurrentByField(query.typeName, query.field, query.value);
  }

  /**
   * The single membership-delivery primitive (generic over `queryType`) — called by
   * Flow 1 (the one new subscriber) and Flow 3 (each query's subscribers, on commit
   * or permission change). Evaluates the query to its current result set, evaluates
   * each target's read permission (no short-circuit), then PARTITIONS (D4):
   *   - **no-denial** targets (can read every match) share ONE identical payload
   *     (the full `resourceIds`) → `bridge.broadcastQueryUpdate` (svc.broadcast);
   *   - **has-denial** targets each get an individualized `bridge.deliverQueryUpdate`
   *     per their own `onPartial` (read from the stored query — `onPartial` is NOT
   *     in the queryHash, so co-`queryHash` subscribers may differ, D2/M3): `'allow'`
   *     → `{ resourceIds (readable), deniedNodes }`; `'error'` → `{ deniedNodes }`.
   * The client REPLACES its set on every push (idempotent, self-healing — no delta).
   */
  #broadcastQueries(query: QueryDescriptor, targets: QuerySubscriberRow[]): void {
    if (targets.length === 0) return;
    const queryHash = canonicalQueryHash(query);
    const matches = this.#evaluateQuery(query); // ordered by (validFrom, resourceId)
    const allResourceIds = matches.map((m) => m.resourceId);
    const matchNodeIds = matches.map((m) => m.nodeId);

    const noDenial: QuerySubscriberRow[] = [];
    for (const t of targets) {
      const { allowed, denied } = this.#dagTree.evaluatePermissions(
        matchNodeIds, 'read', t.sub, Boolean(t.accessAdmin),
      );
      if (denied.size === 0) {
        noDenial.push(t);
        continue;
      }
      // Has-denial → individualized. onPartial is read PER TARGET (not in the hash).
      const onPartial = (parse(t.query) as QueryDescriptor).onPartial ?? 'allow';
      const deniedNodes = [...denied];
      const result: QueryUpdatePayload = onPartial === 'allow'
        ? { resourceIds: matches.filter((m) => allowed.has(m.nodeId)).map((m) => m.resourceId), deniedNodes }
        : { deniedNodes };
      this.#bridge.deliverQueryUpdate(t.clientId, queryHash, result);
    }

    if (noDenial.length > 0) {
      const noDenialTargets = noDenial.map((t) => ({ bindingName: t.subscriberBinding, instanceName: t.clientId }));
      this.#bridge.broadcastQueryUpdate(queryHash, allResourceIds, noDenialTargets);
    }
  }

  /**
   * Flow 3 trigger A (on commit): rerun every live query whose `typeName` was
   * touched by the commit, re-pushing its full membership. The query channel
   * re-delivers by RERUNNING queries (not by mapping mutations to resources) — an
   * unchanged result is replaced with itself (a client-side no-op). Reruns more than
   * strictly necessary on purpose (the affected-resource filter + deltas are deferred,
   * over-the-wire cost dominates). A mutation to an unrelated `typeName` triggers NO
   * push here (the touched-type filter). `onMutations` provides the touched snapshots.
   */
  #rerunQueriesForCommit(mutations: Map<string, Snapshot>): void {
    const touched = new Set<string>();
    for (const snap of mutations.values()) touched.add(snap.meta.typeName);
    this.#rerunQueries((q) => touched.has(q.typeName));
  }

  /**
   * Rerun the live queries matching `shouldRerun`, grouped by `queryHash` (all rows
   * sharing a hash are one query + its subscribers). Selection is a SCAN of the
   * (small) subscription table (D8 — a decomposed-column index is the deferred
   * optimization), not a per-mutation match. Shared by the commit trigger (filter by
   * touched type, Phase 4) and the permission-change trigger (all live queries,
   * Phase 5 / D6).
   */
  #rerunQueries(shouldRerun: (q: QueryDescriptor) => boolean): void {
    const groups = new Map<string, { query: QueryDescriptor; rows: QuerySubscriberRow[] }>();
    for (const row of this.#querySubs.all()) {
      let g = groups.get(row.queryHash);
      if (!g) {
        g = { query: parse(row.query) as QueryDescriptor, rows: [] };
        groups.set(row.queryHash, g);
      }
      g.rows.push(row);
    }
    for (const { query, rows } of groups.values()) {
      if (shouldRerun(query)) this.#broadcastQueries(query, rows);
    }
  }

  /**
   * Resource-mutation broadcast — invoked from `Resources.transaction` via the
   * `onMutations` callback after a successful commit. Looks up subscribers per
   * mutated resource, excludes the originator, and hands the target set to the
   * host bridge for the actual `svc.broadcast`.
   *
   * D3 (Child 2): a per-push DAG read recheck closes the subscribe-time-only gap
   * Child 1 carried into the capability. A subscriber who lost read since
   * subscribing is SKIPPED for this push — never dropped (ADR-008 / D5; readable
   * state returns via the Flow-3 permission rerun when access does). The recheck
   * is an explicit-sub `evaluatePermissions` honoring the row's stored
   * `accessAdmin` (the `access.admin` bypass, D16), NOT the live caller's
   * `requirePermission`. Closing it in the capability protects Star AND DevStudio.
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorClientId: string): void {
    for (const [resourceId, snapshot] of mutations) {
      const subscribers = this.#subscriptions.forResource(resourceId);
      const targets = subscribers
        .filter((sub) => sub.clientId !== originatorClientId)
        .filter((sub) =>
          this.#dagTree.evaluatePermissions(
            [snapshot.meta.nodeId], 'read', sub.sub, Boolean(sub.accessAdmin),
          ).allowed.size > 0)
        .map((sub) => ({ bindingName: sub.subscriberBinding, instanceName: sub.clientId }));
      this.#bridge.broadcastResourceUpdate(resourceId, snapshot, targets);
    }
  }
}

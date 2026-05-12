/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access,
 * and a Resources class for temporal resource storage.
 *
 * Resource operations go through ontology-aware mesh methods that use a
 * two-handler continuation pattern: Handler 1 checks the local ontology
 * cache and dispatches; Handler 2 always does the actual work, loading
 * the per-version validator facet on demand.
 */

import { mesh } from '@lumenize/mesh';
import {
  getParserValidatorFacet,
} from '@lumenize/ts-runtime-parser-validator';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireAdmin } from './nebula-do';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import { Subscriptions } from './subscriptions';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';
import type { Galaxy, OntologyVersionRow, OntologyState } from './galaxy';
import type { NebulaClient } from './nebula-client';

const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

export class Star extends NebulaDO {
  #dagTree!: DagTree
  #resources!: Resources
  #subscriptions!: Subscriptions
  #row: OntologyVersionRow | null = null
  #facet: ParserValidator | null = null

  onStart() {
    this.#dagTree = new DagTree(
      this.ctx,
      () => this.lmz.callContext,
      () => this.#onDagChanged(),
    )
    this.#resources = new Resources(
      this.ctx,
      () => this.lmz.callContext,
      this.#dagTree,
    )
    this.#subscriptions = new Subscriptions(
      this.ctx,
      () => this.lmz.callContext,
      this.#dagTree,
      this.#resources,
    )
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Universe-scoped galaxy identifier — the first two dot-segments of Star's
   * instanceName (e.g. `acme.app.tenant-a` → `acme.app`). Both segments
   * together form a globally unique galaxy address: the leading segment is
   * the universe, the second is the galaxy slug, and identical galaxy slugs
   * in different universes produce different identifiers. Used as the
   * Galaxy DO instance name AND as the namespace prefix on the per-Worker
   * Worker Loader cache (`bundleId = "<universe.galaxy>/<version>"`).
   */
  get #galaxyId(): string {
    const parts = this.lmz.instanceName!.split('.');
    return parts.slice(0, 2).join('.');
  }

  /**
   * True iff `version` matches the latest cached version. Star's `_index`
   * holds Galaxy's full ordered history at the moment of the last fetch, so
   * the latest is the last entry — the cached row matches that label.
   * Older entries in `_index` are part of the migration chain (5.5) but no
   * row is cached for them.
   */
  #isCachedVersion(version: string): boolean {
    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY);
    return index !== undefined && index.length > 0 && index[index.length - 1] === version;
  }

  /**
   * Populate `#row` and `#facet` from KV if not already in memory.
   * The facet helper is a same-isolate cache lookup once `bundleId` is
   * active, so this is near-zero on warm DOs.
   */
  #ensureFacet(): { row: OntologyVersionRow; facet: ParserValidator } {
    if (this.#row && this.#facet) return { row: this.#row, facet: this.#facet };

    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY);
    const version = index?.[index.length - 1];
    if (!version) {
      throw new Error('No ontology cached — Galaxy fetch should have run first');
    }
    const row = this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(version));
    if (!row) {
      throw new Error(`Ontology row missing for version '${version}' — index/row drift`);
    }
    this.#row = row;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      `${this.#galaxyId}/${row.version}`,
      () => row.validatorBundle,
    );
    return { row, facet: this.#facet };
  }

  /**
   * Replace the cached ontology with a fresh state from Galaxy, atomically.
   * Drops the previous row, writes the new latest row, and stores the full
   * version history (oldest → newest) in `_index`. The history travels with
   * the row so 5.5's lazy migration has the chain order without needing a
   * separate Galaxy round-trip.
   */
  #installState(state: OntologyState): void {
    const { row, history } = state;
    this.ctx.storage.transactionSync(() => {
      const prevIndex = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
      const prevLatest = prevIndex[prevIndex.length - 1];
      const isNewVersion = prevLatest !== row.version;
      if (prevLatest && isNewVersion) {
        this.ctx.storage.kv.delete(rowKey(prevLatest));
      }
      this.ctx.storage.kv.put(rowKey(row.version), row);
      this.ctx.storage.kv.put(INDEX_KEY, history);
      // Deploy-driven subscriber cleanup (Phase 5.3.2). Only clear when we're
      // actually installing a *different* version — the first install on a
      // fresh Star has no prior subscribers to drop, and re-installing the
      // same version (defensive: shouldn't happen given #isCachedVersion
      // guards upstream) shouldn't churn existing subscriptions.
      if (isNewVersion && prevLatest) {
        this.#subscriptions.clear();
      }
    });
    this.#row = row;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      `${this.#galaxyId}/${row.version}`,
      () => row.validatorBundle,
    );
  }

  // ─── DagTree ───────────────────────────────────────────────────────

  /**
   * Single @mesh() entry point for the entire DagTree API.
   * OCAN executor checks @mesh() only on this method;
   * subsequent operations (e.g., .createNode(), .getState()) traverse freely.
   * DagTree handles per-operation auth internally via requirePermission.
   */
  @mesh()
  dagTree(): DagTree {
    return this.#dagTree
  }

  // ─── Config ────────────────────────────────────────────────────────

  @mesh(requireAdmin)
  setStarConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  // ─── Transaction (Handler 1 / Handler 2) ───────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  transaction(ontologyVersion: string, newETag: string, ops: Record<string, OperationDescriptor>) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(ontologyVersion)) {
      // Cache hit — execute directly, skip Galaxy entirely
      this.doTransaction(null, ontologyVersion, newETag, ops, clientId);
    } else {
      // Cache miss — ask Galaxy, carry context in the response handler
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doTransaction(
          this.ctn().$result, ontologyVersion, newETag, ops, clientId
        )
      );
    }
  }

  /**
   * Handler 2: Execute transaction + deliver result to client.
   * Called directly (with null) on cache hit, or as response handler on cache miss.
   * When a continuation fails, Mesh puts an Error instance in $result.
   */
  async doTransaction(
    fetchedState: OntologyState | null | Error,
    ontologyVersion: string,
    newETag: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ) {
    try {
      // Handle Galaxy fetch failure
      if (fetchedState instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(fetchedState));
        return;
      }

      // Cache miss path: install the fetched state, or surface mismatch / "not found"
      if (fetchedState !== null) {
        if (fetchedState.row.version !== ontologyVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleTransactionResult(
              new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${fetchedState.row.version}'. Refresh your schema.`)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(ontologyVersion)) {
        // `null` + no matching cache entry = Galaxy fetch returned no ontology
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(
            new Error(`Ontology version '${ontologyVersion}' not found`)));
        return;
      }
      // null + matching cache entry = cache hit; fall through

      const { row, facet } = this.#ensureFacet();
      const result = await this.#resources.transaction(ops, row.version, newETag, facet,
        (mutations) => this.#fanout(mutations, clientId));

      // Deliver result to client
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(result));
    } catch (err) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Read (Handler 1 / Handler 2) ──────────────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  read(ontologyVersion: string, resourceId: string, requestId: string) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('read requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(ontologyVersion)) {
      this.doRead(null, ontologyVersion, resourceId, requestId, clientId);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doRead(
          this.ctn().$result, ontologyVersion, resourceId, requestId, clientId
        )
      );
    }
  }

  /** Handler 2: Execute read + deliver result to client via handleReadResponse */
  doRead(
    fetchedState: OntologyState | null | Error,
    ontologyVersion: string,
    resourceId: string,
    requestId: string,
    clientId: string,
  ) {
    try {
      if (fetchedState instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResponse(requestId, fetchedState));
        return;
      }

      if (fetchedState !== null) {
        if (fetchedState.row.version !== ontologyVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleReadResponse(requestId,
              new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${fetchedState.row.version}'. Refresh your schema.`)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(ontologyVersion)) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResponse(requestId,
            new Error(`Ontology version '${ontologyVersion}' not found`)));
        return;
      }

      const snapshot = this.#resources.read(resourceId);

      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResponse(requestId, snapshot));
    } catch (err) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResponse(requestId,
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Subscribe (Handler 1 / Handler 2) ─────────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  subscribe(ontologyVersion: string, resourceType: string, resourceId: string) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribe requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribe requires a gateway in callChain.at(-1)');
    }

    if (this.#isCachedVersion(ontologyVersion)) {
      this.doSubscribe(null, ontologyVersion, resourceType, resourceId, clientId, subscriberBinding);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doSubscribe(
          this.ctn().$result, ontologyVersion, resourceType, resourceId, clientId, subscriberBinding
        )
      );
    }
  }

  /**
   * Handler 2: Validate ontology, register subscriber, push initial snapshot.
   * Errors travel through `handleResourceUpdate(rt, rid, error)` — fire-and-forget
   * + callback correlation, same pattern as `transaction()` / `read()`.
   */
  doSubscribe(
    fetchedState: OntologyState | null | Error,
    ontologyVersion: string,
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ) {
    try {
      if (fetchedState instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, fetchedState));
        return;
      }

      if (fetchedState !== null) {
        if (fetchedState.row.version !== ontologyVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
              new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${fetchedState.row.version}'. Refresh your schema.`)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(ontologyVersion)) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
            new Error(`Ontology version '${ontologyVersion}' not found`)));
        return;
      }

      const snapshot = this.#subscriptions.subscribe(resourceType, resourceId, clientId, subscriberBinding);

      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, snapshot));
    } catch (err) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * DAG mutations don't fan out today. Per the design (Phase 5.3.2):
   *   "Fanout triggers are upsert and delete only — migration does NOT fan out
   *    (deploys + lazy ontology model + onShouldRefreshUI handle cross-version
   *    transitions)"
   * Kept as a hook so future DAG-mutation-aware logic has a landing spot.
   */
  #onDagChanged() {
    // intentionally empty
  }

  /**
   * Resource-mutation fanout (Phase 5.3.2). Called from
   * `Resources.transaction` via the `onMutations` callback after a successful
   * commit. For each mutated resource, look up subscribers and dispatch
   * `handleResourceUpdate` to each — excluding the originator (they already
   * receive the authoritative result via `handleTransactionResult`).
   *
   * Per the pinned subscribe-time-only guard semantics, we do NOT re-check
   * DAG read permission per subscriber per push. Permission revocation
   * mid-subscription is accepted for demo (Phase -1 Open Q2).
   */
  #fanout(mutations: Map<string, Snapshot>, originatorClientId: string) {
    for (const [resourceId, snapshot] of mutations) {
      const subscribers = this.#subscriptions.forResource(resourceId);
      for (const sub of subscribers) {
        if (sub.clientId === originatorClientId) continue;
        this.lmz.call(sub.subscriberBinding, sub.clientId,
          this.ctn<NebulaClient>().handleResourceUpdate(
            snapshot.meta.typeName, resourceId, snapshot));
      }
    }
  }
}

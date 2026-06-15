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
import { debug } from '@lumenize/debug';
import {
  getParserValidatorFacet,
} from '@lumenize/ts-runtime-parser-validator';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireAdmin } from './nebula-do';
import { DagTree } from './dag-tree';
import { ROOT_NODE_ID } from './dag-ops';
import { Resources } from './resources';
import { Subscriptions } from './subscriptions';
import { TreeSubscriptions } from './tree-subscriptions';
import { OntologyStaleError } from './errors';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';
import type { Galaxy, OntologyVersionRow, OntologyState } from './galaxy';
import type { NebulaClient } from './nebula-client';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

export class Star extends NebulaDO {
  #dagTree!: DagTree
  #resources!: Resources
  #subscriptions!: Subscriptions
  #treeSubscriptions!: TreeSubscriptions
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
    this.#treeSubscriptions = new TreeSubscriptions(this.ctx)
  }

  /**
   * Seed the founder as a DAG `admin` grant on root at first provision.
   *
   * Stars are lazy DOs with no explicit `createStar`; the founder is the
   * scope-admin (`claims.access.admin`) who first touches this Star. We grant
   * them `admin` on `ROOT_NODE_ID` so the request-access climb has a findable
   * terminus *inside the tree* — a scope-level bypass admin isn't in the
   * permissions map and so can't be discovered by the climb (it terminates at
   * root only because the founder's grant lives there). The `setPermission`
   * call satisfies its own `admin` gate via the scope-admin bypass
   * (dag-tree.ts `requirePermission`), so no un-guarded path is needed. Runs
   * exactly once; a non-admin first caller leaves root adminless until an admin
   * connects.
   *
   * TODO(self-signup): revisit when the Galaxy gains a real Star-provisioning
   * entry point — the founder's identity should come from the signup flow, not
   * "first scope-admin to connect". See tasks/nebula-star-root-admin.md Part 1.
   */
  onBeforeCall() {
    super.onBeforeCall() // locks the active scope (aud) on first call
    if (this.ctx.storage.kv.get('__nebula_rootAdminSeeded')) return
    const auth = this.lmz.callContext.originAuth
    const claims = auth?.claims as NebulaJwtPayload | undefined
    if (!claims?.access?.admin || !auth?.sub) return
    this.#dagTree.setPermission(ROOT_NODE_ID, auth.sub, 'admin')
    this.ctx.storage.kv.put('__nebula_rootAdminSeeded', true)
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
    const bundleId = `${this.#galaxyId}/${row.version}`;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => {
        // Cache miss — first reference to this bundleId on this Worker project.
        // Warm path is the same-isolate cache lookup the helper already does.
        debug('nebula.Star.ensureFacet').info('facet cold load', {
          bundleId,
          galaxyId: this.#galaxyId,
          ontologyVersion: row.version,
        });
        return row.validatorBundle;
      },
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
    let droppedSubscribers: Array<{ subscriberBinding: string; clientId: string }> = [];
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
        droppedSubscribers = this.#subscriptions.clear();
      }
    });
    this.#row = row;
    const bundleId = `${this.#galaxyId}/${row.version}`;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => {
        debug('nebula.Star.installState').info('facet cold load', {
          bundleId,
          galaxyId: this.#galaxyId,
          ontologyVersion: row.version,
        });
        return row.validatorBundle;
      },
    );

    // Push-on-clear (Phase 5.3.4b): notify each dropped subscriber once via the
    // existing fanout plumbing. Sentinel rt='' / rid='' on `handleResourceUpdate`
    // is harmless — the client's error branch routes `OntologyStaleError` into
    // its `onShouldRefreshUI` hook regardless of which (rt, rid) pair carried
    // the signal, and there is no pending subscribe Promise keyed at ':'. We
    // can't fill in `clientVersion` server-side — the Subscribers row doesn't
    // carry it — so the client substitutes its own pinned version when it sees
    // an empty value (see NebulaClient.#dispatchOntologyStale). Fire-and-forget;
    // a failed send is tolerable — 5.3.4a reconnect + Handler-1 lazy detection
    // are the backstops.
    if (droppedSubscribers.length > 0) {
      const staleError = new OntologyStaleError('', row.version);
      for (const { subscriberBinding, clientId } of droppedSubscribers) {
        this.lmz.call(subscriberBinding, clientId,
          this.ctn<NebulaClient>().handleResourceUpdate('', '', staleError));
      }
    }
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
  transaction(appVersion: string, newETag: string, ops: Record<string, OperationDescriptor>) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(appVersion)) {
      // Cache hit — execute directly, skip Galaxy entirely
      this.doTransaction(null, appVersion, newETag, ops, clientId);
    } else {
      // Cache miss — ask Galaxy, carry context in the response handler
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doTransaction(
          this.ctn().$result, appVersion, newETag, ops, clientId
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
    appVersion: string,
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
        if (fetchedState.row.version !== appVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleTransactionResult(
              new OntologyStaleError(appVersion, fetchedState.row.version)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(appVersion)) {
        // `null` + no matching cache entry = Galaxy fetch returned no ontology
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(
            new Error(`Ontology version '${appVersion}' not found`)));
        return;
      }
      // null + matching cache entry = cache hit; fall through

      const { row, facet } = this.#ensureFacet();
      const result = await this.#resources.transaction(ops, row.version, newETag, facet,
        (mutations) => this.#broadcast(mutations, clientId));

      // Deliver result to client
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(result));
    } catch (err) {
      debug('nebula.Star.doTransaction').error('handler threw', {
        clientId,
        appVersion,
        bundleId: this.#row ? `${this.#galaxyId}/${this.#row.version}` : undefined,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Read (Handler 1 / Handler 2) ──────────────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  read(appVersion: string, resourceId: string, requestId: string) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('read requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(appVersion)) {
      this.doRead(null, appVersion, resourceId, requestId, clientId);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doRead(
          this.ctn().$result, appVersion, resourceId, requestId, clientId
        )
      );
    }
  }

  /** Handler 2: Execute read + deliver result to client via handleReadResponse */
  doRead(
    fetchedState: OntologyState | null | Error,
    appVersion: string,
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
        if (fetchedState.row.version !== appVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleReadResponse(requestId,
              new OntologyStaleError(appVersion, fetchedState.row.version)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(appVersion)) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResponse(requestId,
            new Error(`Ontology version '${appVersion}' not found`)));
        return;
      }

      const snapshot = this.#resources.read(resourceId);

      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResponse(requestId, snapshot));
    } catch (err) {
      debug('nebula.Star.doRead').error('handler threw', {
        clientId,
        resourceId,
        appVersion,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResponse(requestId,
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Subscribe (Handler 1 / Handler 2) ─────────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  subscribe(appVersion: string, resourceType: string, resourceId: string) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribe requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribe requires a gateway in callChain.at(-1)');
    }

    if (this.#isCachedVersion(appVersion)) {
      this.doSubscribe(null, appVersion, resourceType, resourceId, clientId, subscriberBinding);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doSubscribe(
          this.ctn().$result, appVersion, resourceType, resourceId, clientId, subscriberBinding
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
    appVersion: string,
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
        if (fetchedState.row.version !== appVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
              new OntologyStaleError(appVersion, fetchedState.row.version)));
          return;
        }
        this.#installState(fetchedState);
      } else if (!this.#isCachedVersion(appVersion)) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
            new Error(`Ontology version '${appVersion}' not found`)));
        return;
      }

      const snapshot = this.#subscriptions.subscribe(resourceType, resourceId, clientId, subscriberBinding);

      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, snapshot));
    } catch (err) {
      debug('nebula.Star.doSubscribe').error('handler threw', {
        clientId,
        resourceType,
        resourceId,
        appVersion,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Unsubscribe ───────────────────────────────────────────────────

  /**
   * Drop the caller's subscriber row for `(resourceType, resourceId)`. Called
   * via `client.resources.unsubscribe` — the factory's effect-scope refcount
   * loop issues it after the grace period expires for a 1→0 transition.
   * PK-targeted delete.
   *
   * `resourceType` is currently unused — `Subscribers` rows key on
   * `(resourceId, clientId)` only; the type lives on the resource snapshot.
   * Kept in the API for symmetry with `subscribe(rt, rid)` and so a future
   * type-discriminated subscriber model (per Phase -1 § 7) doesn't churn the
   * client surface.
   *
   * No ontology check — unsubscribe is best-effort. If the row doesn't exist
   * (already cleaned up by drop-on-failed-fanout, ontology-install clear, or
   * a prior call), the DELETE is a no-op.
   */
  @mesh()
  unsubscribe(resourceType: string, resourceId: string): void {
    void resourceType;
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribe requires a client origin with instanceName in callChain[0]');
    }
    this.#subscriptions.removeSubscriber(resourceId, clientId);
  }

  // ─── OrgTree (dedicated channel) ───────────────────────────────────

  /**
   * Subscribe the caller to the org/permission tree — a per-Star SINGLETON
   * delivered on its own channel (NOT a resource; never touches the
   * `Subscribers`/`Snapshots` tables). Registers the subscriber and pushes the
   * initial `dagTree.getState()` snapshot via `handleOrgTreeUpdate`.
   *
   * **Auth is NOT "parity" with resource subscribe:** the only gates are
   * `onBeforeCall`'s aud-lock (ran already) + `dagTree.getState()`'s auth check
   * (a valid in-scope `sub`). There is intentionally **NO node-level read check**
   * — the tree is universally visible by design. Ontology-version-independent, so
   * no Handler-1/2 cache dance and no `appVersion` argument.
   */
  @mesh()
  subscribeTree(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeTree requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeTree requires a gateway in callChain.at(-1)');
    }
    // getState() enforces the auth gate (#requireAuth) and is the value source.
    const state = this.#dagTree.getState();
    this.#treeSubscriptions.register(clientId, subscriberBinding);
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }));
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Fired by `DagTree` after every tree mutation. Broadcasts the fresh
   * `dagTree.getState()` to ALL tree subscribers — **including the originator**
   * (unlike resource fanout): `client.orgTree.*` has no optimistic local
   * write-through, so the echo is the only way the actor's own
   * `store.lmz.orgTree` updates. `getState()` reads the mutating caller's auth
   * (the mutation that triggered this is always authenticated).
   *
   * Drop-on-failed-broadcast cleanup rides `onTreeBroadcastResult` (its own
   * handler keyed by `clientId`, NOT the resourceId path). That handler carries
   * `@mesh()` because the tree broadcast goes to ALL connected clients and can
   * exceed `svc.broadcast`'s `directThreshold` → tier-worker dispatch.
   */
  #onDagChanged() {
    const subscribers = this.#treeSubscriptions.all();
    if (subscribers.length === 0) return;
    const state = this.#dagTree.getState();
    const targets = subscribers.map(s => ({ bindingName: s.subscriberBinding, instanceName: s.clientId }));
    const remote = this.ctn<NebulaClient>().handleOrgTreeUpdate({ value: state });
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Star>().onTreeBroadcastResult() });
  }

  /**
   * Resource-mutation broadcast (Phase 5.3.2 / Phase 5b primitive lift).
   * Called from `Resources.transaction` via the `onMutations` callback
   * after a successful commit. For each mutated resource, look up
   * subscribers and dispatch `handleResourceUpdate` to each — excluding
   * the originator (they already receive the authoritative result via
   * `handleTransactionResult`).
   *
   * Per the pinned subscribe-time-only guard semantics, we do NOT re-check
   * DAG read permission per subscriber per push. Permission revocation
   * mid-subscription is accepted for demo (Phase -1 Open Q2).
   *
   * Uses `this.svc.broadcast` — the framework primitive that picks between
   * a direct loop (`targets.length ≤ directThreshold`) and a recursive
   * Worker tier (`> directThreshold`) automatically. See
   * `packages/mesh/src/broadcast.ts` and `tasks/fanout-scaling-benchmark.md`.
   *
   * **Drop-on-failed-fanout (v2):** `svc.broadcast` is given an `onResult`
   * partial continuation that the framework completes by appending the
   * per-target call result. On `ClientDisconnectedError`, we drop the leaked
   * subscriber row using `clientInstanceName` carried on the error itself
   * (no separate target arg needed in the handler signature). For
   * unavailable Gateway / transient errors we keep the row — over-eager
   * deletion would over-cleanup.
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorClientId: string) {
    // Per-Star bench overrides. All env vars exist for the fanout-scaling
    // bench; production sets none.
    //
    //   STAR_BROADCAST_DIRECT_THRESHOLD — override svc.broadcast's
    //     direct-vs-tree cutoff. `Infinity` forces direct (naive loop);
    //     `0` forces tree; numeric overrides the framework default of 100.
    //   STAR_BROADCAST_OMIT_ON_RESULT=1 — call svc.broadcast WITHOUT the
    //     `onResult` partial. Strips drop-on-failed-fanout cleanup. Used
    //     to isolate the cost of result-handler dispatch.
    const rawThreshold = (this.env as any)?.STAR_BROADCAST_DIRECT_THRESHOLD;
    const directThreshold = rawThreshold === undefined
      ? undefined
      : rawThreshold === 'Infinity'
        ? Infinity
        : parseInt(rawThreshold, 10);
    const omitOnResult = (this.env as any)?.STAR_BROADCAST_OMIT_ON_RESULT === '1';
    for (const [resourceId, snapshot] of mutations) {
      const subscribers = this.#subscriptions.forResource(resourceId);
      const targets = subscribers
        .filter(sub => sub.clientId !== originatorClientId)
        .map(sub => ({ bindingName: sub.subscriberBinding, instanceName: sub.clientId }));
      const remote = this.ctn<NebulaClient>().handleResourceUpdate(
        snapshot.meta.typeName, resourceId, snapshot);
      const opts: { directThreshold?: number; onResult?: any } = {};
      if (!omitOnResult) opts.onResult = this.ctn<Star>().onBroadcastResult(resourceId);
      if (directThreshold !== undefined) opts.directThreshold = directThreshold;
      this.svc.broadcast(targets, remote, opts);
    }
  }

  /**
   * Per-target broadcast result handler. Invoked once per subscriber
   * (success or failure) by `svc.broadcast`'s plumbing. The framework
   * appends `result` to the partial continuation Star passed via
   * `opts.onResult`, so this method's signature is
   * `(resourceId, result)`; the target clientId comes from
   * `ClientDisconnectedError.clientInstanceName` when delivery fails.
   *
   * Public visibility because mesh handler-continuations resolve by name
   * on the local DO; needs `@mesh()` because in the tree branch the tier
   * worker dispatches this call across the service binding (so the
   * framework needs to recognize the method as call-callable).
   */
  @mesh()
  onBroadcastResult(resourceId: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#subscriptions.removeSubscriber(resourceId, clientId);
    }
    // Success path or non-disconnect error: nothing to do here.
  }

  /**
   * Per-target result handler for the org-tree broadcast (`#onDagChanged`).
   * Keyed by `clientId` alone (TreeSubscribers has no resourceId dimension) —
   * the failed client comes from `ClientDisconnectedError.clientInstanceName`,
   * mirroring `onBroadcastResult`. `@mesh()` because the tree broadcast can take
   * the tier-worker dispatch path (it fans out to every connected client).
   */
  @mesh()
  onTreeBroadcastResult(result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#treeSubscriptions.removeSubscriber(clientId);
    }
  }

}

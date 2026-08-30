/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access, and a
 * resource data-plane for temporal resource storage.
 *
 * The data-plane (DagTree + Resources + Subscriptions + Handler 2 + the mutation
 * broadcast) is composed from the shared {@link ResourceDataPlane} capability
 * (ADR-007 — composition, not reimplementation), so the Galaxy can host Resources
 * the same way. Star retains the Galaxy-multi-version machinery the capability
 * deliberately excludes: the **Handler 1** ontology-version gate, ontology
 * install/cache (`#ensureFacet`/`#installState`/`setOntology`), and the
 * non-resource org-tree + dev-preview-reload channels.
 *
 * Resource operations use a two-handler continuation pattern: Handler 1 (on
 * Star) checks the local ontology cache and dispatches; Handler 2 (in the
 * capability) does the actual work against the per-version validator facet that
 * Star's `getOntology()` provider supplies.
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import {
  getParserValidatorFacet,
} from '@lumenize/ts-runtime-parser-validator/runtime';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator/runtime';
import { NebulaDO, requireDominionHere } from './nebula-do';
import type { DagTree } from './dag-tree';
import { ROOT_NODE_ID } from './dag-ops';
import type { PermissionTier } from './dag-ops';
// Type-only: types the facade continuation below without pulling a second mesh entry into this
// module's value graph.
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import { TreeSubscriptions } from './tree-subscriptions';
import { ReloadSubscriptions } from './reload-subscriptions';
import { OntologyStaleError } from './errors';
import { ResourceDataPlane } from './resource-data-plane';
import type { BroadcastTarget, NodeInvitee, NodeInviteAck } from './resource-data-plane';
import type { QueryDescriptor, SubscriberEntry } from './query-hash';
import type { OperationDescriptor, Snapshot, TransactionResult } from './resources';
import type { Galaxy, OntologyVersionRow, OntologyState } from './galaxy';
import type { NebulaClient } from './nebula-client';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

// Node-invite types re-exported from their new home (the composed data-plane) so
// existing `@lumenize/nebula` import sites are unchanged.
export type { NodeInvitee, NodeInviteAck } from './resource-data-plane';

export class Star extends NebulaDO {
  #dataPlane!: ResourceDataPlane
  #treeSubscriptions!: TreeSubscriptions
  #reloadSubscriptions!: ReloadSubscriptions
  #row: OntologyVersionRow | null = null
  #facet: ParserValidator | null = null

  onStart() {
    this.#dataPlane = new ResourceDataPlane(
      this.ctx,
      () => this.lmz.callContext,
      // Ontology-provider seam: Star's source is the Galaxy-cached row. The row
      // already carries `relationships` (compiled by `compileOntologyVersion`),
      // so widening the seam to surface it for `subscribeQuery` field validation
      // costs nothing here.
      () => {
        const { row, facet } = this.#ensureFacet();
        return { version: row.version, facet, relationships: row.relationships };
      },
      // Host-side mesh I/O — continuations built with Star's own this.ctn/this.lmz/this.svc.
      {
        deliverResourceUpdate: (clientId, resourceType, resourceId, result) =>
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, result)),
        broadcastResourceUpdate: (resourceId, snapshot, targets) =>
          this.#broadcastResourceUpdate(resourceId, snapshot, targets),
        broadcastQueryUpdate: (queryHash, resourceIds, targets) =>
          this.#broadcastQueryUpdate(queryHash, resourceIds, targets),
        deliverQueryUpdate: (clientId, queryHash, result) =>
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleQueryUpdate(queryHash, result),
            this.ctn<Star>().onQueryBroadcastResult(queryHash), { onErrorOnly: true }),
        broadcastRosterUpdate: (queryHash, roster, targets) =>
          this.#broadcastRosterUpdate(queryHash, roster, targets),
        deliverRosterUpdate: (clientId, queryHash, result) =>
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, result),
            this.ctn<Star>().onQuerySubscriberListBroadcastResult(queryHash), { onErrorOnly: true }),
      },
      () => this.#onDagChanged(),
      // Host name as a THUNK, never a captured value — this runs inside `onStart()`, where
      // `this.lmz.instanceName` is not yet stamped, and `resetDevData` re-runs `onStart()` after a
      // `deleteAll()` that wipes the identity key. It is the scope the `access.scopeAdmin` bypass is
      // confined to at both confinement points (requirePermission + the subscribe-time writers).
      () => this.lmz.instanceName,
    )
    this.#treeSubscriptions = new TreeSubscriptions(this.ctx)
    this.#reloadSubscriptions = new ReloadSubscriptions(this.ctx)
    // Null the cached ontology row + validator facet so `onStart` is a COMPLETE
    // (re)init, not just cold-start init. A no-op on cold start (already null),
    // but load-bearing for `resetDevData`'s `this.onStart()` re-init
    // after `deleteAll()`: `#ensureFacet`/`#installState` short-circuit on a
    // populated `#row` ([star.ts] `#ensureFacet`), so a stale `#row` surviving a
    // wipe would keep authorizing the dropped ontology. (The data-plane + helper
    // objects above are likewise reassigned to fresh empty-cache instances.)
    this.#row = null
    this.#facet = null
  }

  /**
   * Seed the **initial DataPlane root admin** — a DAG `admin` grant on `ROOT_NODE_ID`, granted to the
   * first **star-scoped admin** to touch this Star.
   *
   * Two distinct things, in two planes, easily conflated: a *star-scoped admin* is a registry
   * `Memberships` row (`scopeAdmin=1` at this 3-segment scope, so the token's `authScope` IS this Star);
   * the *DataPlane root admin* is this DAG grant. This method is the bridge between them, and it runs
   * exactly once — later root admins are added by an ordinary `setPermission`, which is why this one
   * is the **initial** one and not the only possible one.
   *
   * The grant's job is to give the request-access climb a findable terminus *inside the tree*: a
   * scope-admin holding only the `claims.access.scopeAdmin` bypass is **not** in the permissions map, so
   * the climb cannot discover them. `setPermission` satisfies its own `admin` gate via that same
   * bypass (dag-tree.ts `requirePermission`), so no un-guarded path is needed.
   *
   * ⚠️ **EXACT-star, not `hasDominionOver`** (2026-08-02). A covering Galaxy/Universe admin passes
   * `hasDominionOver` here, so under the old predicate whichever admin wandered in first took the
   * grant — and because the KV flag is one-shot with no re-seed path, that Star's climb would
   * terminate at the covering admin **forever**, routing its tenants' access requests away from their
   * own Star admin. Requiring `authScope` to EQUAL this Star's id makes the grant follow ownership
   * rather than arrival order. This costs the covering admin nothing: ADR-015 keeps their dominion
   * total via the bypass — only climb *discoverability* is at stake.
   *
   * ⚠️ A Star with no star-scoped admin (`createStar` mints no identity — the `.dev` workspace) simply
   * stays root-adminless until one exists, which is already the behavior for a non-admin first caller.
   * `claim-star` self-signup needs no special machinery: the claimer's `authScope` IS this Star, so it
   * satisfies this gate on their first authenticated touch.
   *
   * ⚠️ Keep this predicate when the seed lifts to the DataPlane
   * (tasks/on-hold/nebula-dataplane-root-admin.md), which moves it onto hosts that are NOT leaves —
   * on a non-leaf host a containment form would let a descendant's admin seed an ancestor.
   */
  onBeforeCall() {
    super.onBeforeCall() // locks the active scope (aud) on first call
    if (this.ctx.storage.kv.get('__nebula_rootAdminSeeded')) return
    const auth = this.lmz.callContext.originAuth
    const claims = auth?.claims as NebulaJwtPayload | undefined
    if (!auth?.sub || !this.lmz.instanceName) return
    // Exact equality, NOT `hasDominionOver` — see the EXACT-star note above. This is the one site
    // where the transient scope-admin bypass becomes a DURABLE DAG grant.
    const access = claims?.access
    if (access?.scopeAdmin !== true || access.authScope !== this.lmz.instanceName) return
    this.#dataPlane.dagTree.setPermission(ROOT_NODE_ID, auth.sub, 'admin')
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
   *
   * `protected` (historically so a subclass could reach it; the `DevStar` subclass
   * is gone now, so it's effectively Star-internal). A pure accessor over
   * `instanceName`, not dev logic — leaving it `protected` adds no misusable surface.
   */
  protected get galaxyId(): string {
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

  /** The Star's current ontology version (latest `_index` entry), or `''` if none is
   *  set yet. Carried in `OntologyStaleError` so a version-skewed client knows what to
   *  refresh to. */
  #currentVersion(): string {
    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY);
    return index && index.length > 0 ? index[index.length - 1] : '';
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
    const bundleId = `${this.galaxyId}/${row.version}`;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => {
        // Cache miss — first reference to this bundleId on this Worker project.
        // Warm path is the same-isolate cache lookup the helper already does.
        debug('nebula.Star.ensureFacet').info('facet cold load', {
          bundleId,
          galaxyId: this.galaxyId,
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
    let isNewVersion = false;
    this.ctx.storage.transactionSync(() => {
      const prevIndex = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
      const prevLatest = prevIndex[prevIndex.length - 1];
      isNewVersion = prevLatest !== row.version;
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
        // Drain ALL THREE subscription registries and UNION by (subscriberBinding, clientId) so a client
        // subscribed to any combination of a resource, a query, AND a query's subscriber-list (watcher)
        // is signaled exactly once (m1). A query sub spans types, so an install almost always invalidates
        // it; a watcher whose watched type/field an install removed is likewise cleared + signaled
        // (tasks/nebula-subscriber-lists.md) rather than left silently stale.
        const droppedResource = this.#dataPlane.clearSubscribers();
        const droppedQuery = this.#dataPlane.clearQuerySubscribers();
        const droppedWatchers = this.#dataPlane.clearWatchers();
        const seen = new Set<string>();
        droppedSubscribers = [];
        for (const d of [...droppedResource, ...droppedQuery, ...droppedWatchers]) {
          const k = `${d.subscriberBinding} ${d.clientId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          droppedSubscribers.push(d);
        }
      }
    });
    this.#row = row;
    const bundleId = `${this.galaxyId}/${row.version}`;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => {
        debug('nebula.Star.installState').info('facet cold load', {
          bundleId,
          galaxyId: this.galaxyId,
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

    // NO reload trigger here (retired at the Galaxy collapse): the ontology label is
    // baked into the BUILD, so an install without a build gives a reload nothing new
    // to fetch — the one reload per turn fires on build completion, Galaxy-side. The
    // Star's reload channel stays parked as publish's future refresh signal.
  }


  /**
   * Install a compiled ontology version directly — the **dev-loop apply path**
   * (Decision 9/11). The Galaxy compiles the ontology `.d.ts` to a validator
   * (`compileOntologyVersion`) and pushes the resulting row here; the Star NEVER
   * compiles. This is the dev analog of the prod lazy-pull from Galaxy (Flow 2b) —
   * the same `#installState` path, applied eagerly from a pushed row instead of a
   * Galaxy fetch. It REPLACES `DevStar.deployToDev`'s Galaxy round-trip (deleted in
   * Phase 4); do not route dev compile through the Galaxy DO.
   *
   * `@mesh(requireDominionHere)`: like the other bespoke `@mesh` mutators it does NOT pass
   * through the DAG `requirePermission` checks, and `onBeforeCall` proves only
   * tenant *scope* (and `<id>.*` widening admits descendant non-admins) — so it
   * carries its own admin gate. An unguarded remote ontology-install would let any
   * in-scope caller swap the validator — so this is the SOLE ontology-install entry,
   * `@mesh(requireDominionHere)`-gated and frozen in the `Star.prototype` `@mesh`-surface test.
   *
   * `row.version` MUST be content-unique (the Galaxy derives it via `git.hashBlob` of
   * the ontology source): the Worker Loader caches the validator bundle by
   * `bundleId = galaxyId/version`, so a reused label silently serves a STALE
   * validator (durable-objects.md § Worker Loader cache).
   */
  @mesh(requireDominionHere)
  setOntology(row: OntologyVersionRow): void {
    const prevIndex = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
    const history = prevIndex.includes(row.version) ? prevIndex : [...prevIndex, row.version];
    this.#installState({ row, history });
  }

  /**
   * Atomic wipe-then-install (ADR-006): the `.dev`-loop's `resetDevData` + `setOntology`
   * pair collapsed into ONE mesh method so the Galaxy fires a single fire-and-forget
   * `call()` (continuation-only model — no awaited callRaw) and the wipe-before-install
   * ordering is guaranteed here rather than across two racing hops. `wipe` runs the same
   * `.dev`-guarded reset (`resetDevData` throws off the `.dev` Star), so the guard is
   * preserved. (The preview reload rides the Galaxy's build-completion push, not this install.)
   */
  @mesh(requireDominionHere)
  async installOntology(row: OntologyVersionRow, opts?: { wipe?: boolean }): Promise<void> {
    if (opts?.wipe) await this.resetDevData();
    this.setOntology(row);
  }

  /**
   * Fire the registry lazy-pull: fetch `version`'s row from the parent Galaxy with a
   * traveling install handler ({@link onOntologyPulled}). Rides the CURRENT op's
   * callContext (the asking member's own claims — an upward call every member has
   * passage for); fire-and-forget, never awaited (ADR-003 — the refused op answers
   * `installing` and the client retries). Idempotent: a concurrent pull's second
   * install lands on `setOntology`'s already-present no-op.
   */
  #pullOntology(version: string): void {
    this.lmz.call('GALAXY', this.galaxyId,
      this.ctn<Galaxy>().getOntologyVersion(version),
      this.ctn<Star>().onOntologyPulled(version));
  }

  /**
   * The lazy-pull's result handler — travels with the call (survives this DO's
   * eviction). Installs the pulled row; a `wipeOnInstall` row pulled over an OLDER
   * installed version wipes first (the breaking-edit bargain, decided + dominion-checked
   * Galaxy-side when the version was appended — a property of the row, never pending
   * state). `null` (version unknown to the registry) installs nothing — the client's
   * bounded retries exhaust and surface the ordinary stale signal.
   *
   * `public` and deliberately NOT `@mesh()` — the fire-back lands via `__handleResponse`
   * (allowlist off, scope-check on); an `@mesh` here would let any in-scope caller hand
   * this Star an arbitrary "ontology row" and swap the validator — the same forge fence
   * as `onInviteResult`. ⚠️ Pre-alpha the only puller is the `.dev` star; a wipeOnInstall
   * pull on a non-`.dev` star logs + skips (the prod install path is the fast-follow's).
   */
  public async onOntologyPulled(version: string, result?: unknown): Promise<void> {
    const log = debug('nebula.Star.ontologyPull');
    try {
      if (result instanceof Error) {
        log.warn('ontology pull failed', { version, error: result.message });
        return;
      }
      const row = result as OntologyVersionRow | null;
      if (!row) {
        log.warn('ontology pull returned no row — version unknown to the registry', { version });
        return;
      }
      if (row.version !== version) {
        log.error('ontology pull returned a DIFFERENT version — not installing', { version, got: row.version });
        return;
      }
      if (this.#isCachedVersion(row.version)) return; // already current — idempotent
      const hadPrior = (this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? []).length > 0;
      if (row.wipeOnInstall && hadPrior) {
        const segs = this.lmz.instanceName?.split('.') ?? [];
        if (!(segs.length === 3 && segs[2] === 'dev')) {
          // resetDevData is .dev-guarded; the prod wipe-on-install story is the
          // fast-follow's prod install path. Refuse loudly rather than half-install.
          log.error('wipeOnInstall pull on a non-.dev star — not installing (prod install path pending)', { version });
          return;
        }
        await this.resetDevData();
      }
      this.setOntology(row);
      log.debug('ontology pulled + installed', { version, wiped: Boolean(row.wipeOnInstall && hadPrior) });
    } catch (err) {
      // Never rethrow — a fire-back handler's throw vanishes. Identifiers only.
      log.error('ontology pull handling failed', {
        version, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reset the dev sandbox to empty — the breaking-edit bargain (a breaking ontology
   * edit invalidates stored snapshots, which we do NOT migrate; the user-developer
   * rebuilds test data, Decision 11). The wipe is **data-only**: the source-of-truth
   * is the Galaxy (its git `Workspace`, Decision 5), NOT the dev Star — so a
   * wipe here destroys throwaway test data, never the user's code. (The old
   * `dev-star.ts` precondition — "don't wire a live trigger until source-durability
   * holds" — is SUPERSEDED: the source never lived on this Star.)
   *
   * **Hard-guarded to the `.dev` STAR-tier instance — segment-precise, NOT a suffix
   * test** (matches `#starBinding`'s form at nebula-client.ts): `endsWith('.dev')`
   * would also pass a galaxy-tier `acme.dev`. ⚠️ **Deliberate structural→runtime
   * weakening** (Decision 2): the wipe used to live ONLY on the `DevStar` subclass so
   * a tenant `Star` *structurally* couldn't carry a data-wiping reset; the single-
   * `Star` collapse ends that, so the wipe now ships on EVERY `Star`, gated only by
   * this runtime throw. Compensating controls: the hard `.dev` guard + `@mesh(
   * requireDominionHere)` + the `Star.prototype` `@mesh`-surface-freeze test.
   *
   * **`async` + `@mesh(requireDominionHere)`** — `requireDominionHere` is a *synchronous* guard and
   * the `.dev` check below is sync, so `blockConcurrencyWhile` (the first awaited
   * work) still closes the gate before any yield. `deleteAll()` is the sanctioned
   * async-storage exception (no sync variant); it wipes the entire private SQLite DB
   * (SQL + KV + alarm rows). `onStart()` then reconstructs the helper objects (fresh
   * empty caches), recreates schema + ROOT, and nulls `#row`/`#facet` (a stale facet
   * would keep authorizing the dropped ontology). The DO + `{u}.{g}.dev` registration
   * survive. The DataPlane root-admin grant reseeds on the next admin call's
   * `onBeforeCall` first-touch (the `deleteAll` wiped the latch).
   *
   * **`ReloadSubscribers` are preserved across the wipe** (captured → wiped →
   * restored, in the body) — they are live-preview connection state, not dev data,
   * and the wipe-in-a-save flow reloads those previews onto the clean Star
   * (Decision 12 / Flow 1d); forgetting them would strand the preview.
   */
  @mesh(requireDominionHere)
  async resetDevData(): Promise<void> {
    const s = this.lmz.instanceName?.split('.') ?? [];
    if (!(s.length === 3 && s[2] === 'dev')) {
      throw new Error('resetDevData is only permitted on the .dev sandbox Star');
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      // Preserve live-preview reload subscriptions across the wipe: they're
      // live-connection state, NOT dev data, and the wipe-in-a-save flow (Flow 1b)
      // then RELOADS those very previews onto the clean Star (Decision 12 / Flow 1d).
      // Capture under the closed gate (no concurrent writes can land), wipe, re-init,
      // restore onto the fresh `#reloadSubscriptions` (onStart recreated the table).
      const reloadSubs = this.#reloadSubscriptions.all();
      await this.ctx.storage.deleteAll();
      this.onStart();
      for (const r of reloadSubs) this.#reloadSubscriptions.register(r.clientId, r.subscriberBinding);
    });
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
    return this.#dataPlane.dagTree
  }

  // ─── Node invites (the security logic lives in the plane — written once) ────

  /**
   * Invite people onto a NODE — the whole two-plane operation (the DAG gate, the
   * `pending` `_InviteStatus` rows, the grants + flips on the result) lives in
   * {@link ResourceDataPlane.invite}, written once for every host; this forward
   * supplies only the facade fire (the one mesh-typed line). TEMP → target=resources()
   * gate (tasks/nebula-data-plane-owns-its-guards.md deletes all four host forwards).
   */
  @mesh()
  async invite(nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck> {
    return this.#dataPlane.invite(nodeId, invitees, (valid) =>
      this.lmz.call(
        'NEBULA_AUTH_FACADE', undefined,
        this.ctn<NebulaAuthFacade>().invite(this.lmz.instanceName!, valid.map(({ email }) => ({ email }))),
        this.ctn<Star>().onInviteResult(nodeId, Object.fromEntries(valid.map(v => [v.email, v.tier]))),
      ));
  }

  /**
   * The node invite's result handler — travels with the facade call (never awaited).
   * `public` and deliberately NOT `@mesh()` — the fire-back lands via `__handleResponse`
   * (allowlist off, scope-check on), and an `@mesh` here would let any in-scope caller
   * forge an invite outcome and write themselves grants. Body in the plane.
   * TEMP → target=resources() gate.
   */
  public onInviteResult(
    nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown,
  ): Promise<void> {
    return this.#dataPlane.onInviteResult(nodeId, tiers, result);
  }

  // ─── Config ────────────────────────────────────────────────────────

  @mesh(requireDominionHere)
  setStarConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  // ─── Transaction (Handler 1 → capability Handler 2) ─────────────────

  /** Handler 1: validate the requested ontology version, then RETURN the transaction result — the
   *  framework fires it back to the caller's `callAsync` (D5 pattern (a)). On a stale version RETURN
   *  the `OntologyStaleError` as a VALUE (resolve, not reject): the client's submit wrapper maps it to
   *  the engine's `{ontologyStale}` signal (asymmetric with `read`, which THROWS on stale). The
   *  version-gate is Galaxy-multi-version-specific and stays on Star; the capability never sees
   *  `ontologyVersion`. */
  @mesh()
  transaction(ontologyVersion: string, newETag: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult> | OntologyStaleError {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }
    if (!this.#isCachedVersion(ontologyVersion)) {
      // LAZY-PULL (dev unified with the prod Flow-2b design): fire the registry fetch from
      // the parent Galaxy INSIDE this op's own call context — upward passage is free for
      // every member, so it works under any claims (the auth story the deleted eager push
      // never had) — and answer `installing` so the client retries the replay-idempotent
      // op instead of treating the version as stale. The op cannot await the pull
      // (ADR-003); the traveling handler installs, the retry succeeds.
      this.#pullOntology(ontologyVersion);
      return new OntologyStaleError(ontologyVersion, this.#currentVersion(), { installing: true });
    }
    return this.#dataPlane.doTransaction(newETag, ops, clientId);
  }

  // ─── Read (Handler 1 → capability Handler 2) ────────────────────────

  /** Handler 1: validate the requested ontology version, then RETURN the read value — the framework
   *  fires it back to the caller's `callAsync` (D5 pattern (a)). On a stale version THROW
   *  `OntologyStaleError` (→ error RESULT → the client's `callAsync` rejects → its `.catch` fires
   *  `onShouldRefreshUI`). */
  @mesh()
  read(ontologyVersion: string, resourceId: string): Snapshot | null {
    if (!this.#isCachedVersion(ontologyVersion)) {
      // Same lazy-pull as `transaction` — reads retry freely, so `installing` rides the throw.
      this.#pullOntology(ontologyVersion);
      throw new OntologyStaleError(ontologyVersion, this.#currentVersion(), { installing: true });
    }
    return this.#dataPlane.doRead(resourceId);
  }

  // ─── Subscribe (Handler 1 → capability Handler 2) ───────────────────

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

    if (!this.#isCachedVersion(ontologyVersion)) {
      // Same lazy-pull as `transaction`; the stale signal still pushes so the client's
      // pending subscribe settles (a re-subscribe after the install succeeds).
      this.#pullOntology(ontologyVersion);
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
          new OntologyStaleError(ontologyVersion, this.#currentVersion(), { installing: true })));
      return;
    }
    this.#dataPlane.doSubscribe(resourceType, resourceId, clientId, subscriberBinding);
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
    this.#dataPlane.removeSubscriber(resourceId, clientId);
  }

  // ─── Query subscriptions (Child 2, Handler 1 → capability) ──────────

  /**
   * Handler 1: register a query subscription + push the initial membership. **Void**
   * (ADR-003 / D7) — the client computed the canonical `queryHash` locally and keys
   * its handle before firing; the initial state arrives as a `handleQueryUpdate`
   * push. `@mesh()` not `@mesh(requireDominionHere)`: query subs are non-admin but
   * DAG-gated (authorization is per-push at delivery, D4). No ontology-version gate —
   * the query validates against the capability's current `relationships` and the
   * membership enumerates current snapshots (version-independent). `clientId` /
   * `subscriberBinding` come from `callChain` (m2/m3), never params.
   */
  @mesh()
  subscribeQuery(query: QueryDescriptor): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeQuery requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeQuery requires a gateway in callChain.at(-1)');
    }
    this.#dataPlane.doSubscribeQuery(query, clientId, subscriberBinding);
  }

  /**
   * Drop the caller's query-sub row for `queryHash`. `clientId` from `callChain[0]`
   * (never a param), so a client can only drop its OWN row (m3). Best-effort — a
   * missing row no-ops.
   */
  @mesh()
  unsubscribeQuery(queryHash: string): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribeQuery requires a client origin with instanceName in callChain[0]');
    }
    this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
  }

  /**
   * Subscribe the caller to `query`'s live subscriber-LIST roster (the STANDALONE watcher subscription —
   * NOT a data-subscriber of the query). **Void** (ADR-003): the client keys its handle by the local
   * `queryHash` and the initial roster arrives as a `handleQuerySubscribersUpdate` push. `@mesh()`,
   * reachability-gated (any Star member may watch any reachable query's roster, ADR-008); `clientId`/
   * `subscriberBinding` from `callChain`, never params. tasks/nebula-subscriber-lists.md.
   */
  @mesh()
  subscribeQuerySubscribers(query: QueryDescriptor): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeQuerySubscribers requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeQuerySubscribers requires a gateway in callChain.at(-1)');
    }
    this.#dataPlane.doSubscribeQuerySubscribers(query, clientId, subscriberBinding);
  }

  /**
   * Drop the caller's subscriber-list WATCHER row for `queryHash`. `clientId` from `callChain[0]` (never
   * a param), so a client can only drop its OWN watch (m3). Best-effort — a missing row no-ops.
   */
  @mesh()
  unsubscribeQuerySubscribers(queryHash: string): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribeQuerySubscribers requires a client origin with instanceName in callChain[0]');
    }
    this.#dataPlane.removeQuerySubscriberListWatcher(queryHash, clientId);
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
   * no Handler-1/2 cache dance and no `ontologyVersion` argument.
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
    const state = this.#dataPlane.dagTree.getState();
    this.#treeSubscriptions.register(clientId, subscriberBinding);
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }));
  }

  // ─── Reload channel (dev preview) ──────────────────────────────────

  /**
   * Subscribe the caller to this Star's **reload channel** — a per-Star,
   * non-resource signal modeled exactly on {@link subscribeTree}: registers the
   * caller in `#reloadSubscriptions` with NO resource/typeName/`ontologyVersion`
   * checks (a reload marker is none of those).
   *
   * **Kept channel, trigger deferred:** its former trigger (`DevStar.compileSFC`)
   * was deleted in Phase 4 (vite owns compile now). The channel survives as the
   * **publish-refresh signal** — when publish lands a new app-version, it will fan
   * out `broadcastReload` so live previews re-fetch. `@mesh()` not
   * `@mesh(requireDominionHere)` — gated only by `onBeforeCall`'s aud-lock, like
   * `subscribeTree`. There is no initial snapshot to push (the preview's own GET
   * loads the current bundle); subscribing just registers for future reloads.
   */
  @mesh()
  subscribeReload(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeReload requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeReload requires a gateway in callChain.at(-1)');
    }
    this.#reloadSubscriptions.register(clientId, subscriberBinding);
  }

  /**
   * Fan out a reload signal to every reload subscriber — mirrors `#onDagChanged`
   * (`svc.broadcast` + drop-on-failed-broadcast cleanup via `onReloadBroadcastResult`).
   * `protected` (not `@mesh`): never client-reachable. Its former internal trigger
   * (`DevStar.compileSFC`) is gone (Phase 4); publish will call it as the
   * publish-refresh signal. No originator exclusion — the reload channel has no
   * originator concept (any subscriber wanting the new bundle gets the signal).
   */
  protected broadcastReload(): void {
    const subscribers = this.#reloadSubscriptions.all();
    if (subscribers.length === 0) return;
    const targets = subscribers.map(s => ({ bindingName: s.subscriberBinding, instanceName: s.clientId }));
    const remote = this.ctn<NebulaClient>().handleReload();
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Star>().onReloadBroadcastResult() });
  }

  /**
   * Per-target reload-broadcast result handler — drop a subscriber whose Gateway
   * reported it disconnected (`ClientDisconnectedError.clientInstanceName`),
   * mirroring `onTreeBroadcastResult`. `@mesh()` because the broadcast can take
   * the tier-worker dispatch path.
   */
  @mesh()
  onReloadBroadcastResult(result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#reloadSubscriptions.removeSubscriber(clientId);
    }
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
    const state = this.#dataPlane.dagTree.getState();
    const targets = subscribers.map(s => ({ bindingName: s.subscriberBinding, instanceName: s.clientId }));
    const remote = this.ctn<NebulaClient>().handleOrgTreeUpdate({ value: state });
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Star>().onTreeBroadcastResult() });
  }

  /**
   * Host-side fanout for one mutated resource — the {@link ResourceHostBridge}
   * `broadcastResourceUpdate` impl the data-plane invokes per committed mutation.
   * Builds the `handleResourceUpdate` continuation + dispatches `svc.broadcast`
   * (the framework primitive that picks a direct loop vs. recursive Worker tier
   * automatically; see `packages/mesh/src/broadcast.ts`). `targets` is already
   * filtered (originator excluded) by the data-plane.
   *
   * **Drop-on-failed-fanout (v2):** `svc.broadcast` is given an `onResult` partial
   * continuation the framework completes with the per-target result. On
   * `ClientDisconnectedError`, `onBroadcastResult` drops the leaked subscriber row
   * (via the capability) using `clientInstanceName` carried on the error.
   *
   * The `STAR_BROADCAST_*` env knobs exist only for the fanout-scaling bench;
   * production sets none.
   */
  #broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]) {
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
    const remote = this.ctn<NebulaClient>().handleResourceUpdate(
      snapshot.meta.typeName, resourceId, snapshot);
    const opts: { directThreshold?: number; onResult?: any } = {};
    if (!omitOnResult) opts.onResult = this.ctn<Star>().onBroadcastResult(resourceId);
    if (directThreshold !== undefined) opts.directThreshold = directThreshold;
    this.svc.broadcast(targets, remote, opts);
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
      if (clientId) this.#dataPlane.removeSubscriber(resourceId, clientId);
    }
    // Success path or non-disconnect error: nothing to do here.
  }

  /**
   * Host-side fanout for a query membership push to the NO-DENIAL group — the
   * {@link ResourceHostBridge} `broadcastQueryUpdate` impl. One shared payload (the
   * full `resourceIds`) via `svc.broadcast`; drop-on-failed-fanout cleanup rides
   * `onQueryBroadcastResult` keyed by `queryHash` (m6).
   */
  #broadcastQueryUpdate(queryHash: string, resourceIds: string[], targets: BroadcastTarget[]) {
    const remote = this.ctn<NebulaClient>().handleQueryUpdate(queryHash, { resourceIds });
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Star>().onQueryBroadcastResult(queryHash) });
  }

  /**
   * Host-side fanout for a subscriber-list roster push (the `ResourceHostBridge` `broadcastRosterUpdate`
   * impl) — the distinct-by-`sub` roster to a query's WATCHERS via `svc.broadcast`. Dead-WATCHER cleanup
   * uses the DEDICATED `onQuerySubscriberListBroadcastResult` (drops from the watcher table, NOT
   * `QuerySubscribers`). NO `onErrorOnly` — `svc.broadcast` applies it internally for any `onResult`.
   */
  #broadcastRosterUpdate(queryHash: string, roster: SubscriberEntry[], targets: BroadcastTarget[]) {
    const remote = this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, roster);
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Star>().onQuerySubscriberListBroadcastResult(queryHash) });
  }

  /**
   * Per-target result handler for query pushes (both the no-denial broadcast and
   * the per-subscriber has-denial deliveries — m6). Keyed by `queryHash`; drops the
   * dead client's query-sub row on a `ClientDisconnectedError`. `@mesh()` for the
   * tier-worker broadcast path.
   */
  @mesh()
  onQueryBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
    }
  }

  /**
   * Per-target result handler for subscriber-list roster pushes (the `broadcastRosterUpdate` fanout + the
   * single-target `deliverRosterUpdate`). Keyed by `queryHash`; on a `ClientDisconnectedError` drops the
   * dead WATCHER's row from the WATCHER table ONLY (`removeQuerySubscriberListWatcher`), NOT
   * `QuerySubscribers` — so a dual-role client (data-subscriber AND watcher of Q) keeps its data sub.
   * `@mesh()` for the tier-worker broadcast path. tasks/nebula-subscriber-lists.md.
   */
  @mesh()
  onQuerySubscriberListBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriberListWatcher(queryHash, clientId);
    }
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

/**
 * Resources — the composable resources plane.
 *
 * Composed by every Nebula node that hosts Resources — `Star`, and the Galaxy's chat
 * `Chat`/`Message` Resources (ADR-007: composition, never reimplemented). It owns the data-plane
 * trio — `OrgTree` + `Snapshots` + `Subscriptions`, the one registry holding every kind of
 * subscription — the op itself, and every subscription update that follows from it.
 *
 * **It owns the ontology a host serves, and one version rule for every host.** A host injects
 * only where the ontology comes from ({@link OntologySource}); the check, the install, the drains
 * and each op's answer to a mismatch live here (`#gate`). So does the `.dev` sandbox's wipe, which
 * erases what the plane owns and rebuilds it.
 *
 * **It hands the wire one surface, {@link Resources.requests}, and never itself.** A host's one
 * `@mesh() get resources` returns `requests`, whose members derive what a caller may not state —
 * the client's own id, the binding its updates go to — apply the version rule, and call an op
 * below. The ops keep their `clientId` parameters harmlessly, because nothing on the wire can
 * name them.
 *
 * **It sends through the host's `lmz`, handed in as a thunk.** Every subscription update leaves
 * through `lmz.broadcast` — to one tab or to many — and the node invite's facade call through
 * `lmz.call`. Continuations come from {@link Resources.#ctn}, typed over {@link ResourcesHost} for
 * the reapers, so a host missing one, or a misnamed one, fails to compile rather than failing a
 * reap into a log line.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { newContinuation } from '@lumenize/mesh';
import type { AnyContinuation, BroadcastTarget, Continuation, LmzApi } from '@lumenize/mesh';
// Type-only: the facade continuation and the client pushes are typed without pulling a second
// mesh entry, or the client, into this module's value graph.
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import type { NebulaClient } from './nebula-client';
import { getParserValidatorFacet } from '@lumenize/ts-runtime-parser-validator/runtime';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator/runtime';
import type { InviteSummary, InviteeError, NebulaJwtPayload } from '@lumenize/nebula-auth';
import { projectActingToken } from '@lumenize/nebula-auth/claims';
import type { PermissionTier } from './org-ops';
import { OrgTree } from './org-tree';
import { Snapshots } from './snapshots';
import { Subscriptions } from './subscriptions';
import type { DroppedAddress, QuerySubscriberRow } from './subscriptions';
import { canonicalQueryHash } from './query-hash';
import type { QueryDescriptor, QueryUpdatePayload, SubscriberEntry } from './query-hash';
import { parse } from '@lumenize/structured-clone';
import type { OperationDescriptor, TransactionResult, Snapshot } from './snapshots';
import type { OntologyVersionRow } from './ontology-compile';
import { OntologyStaleError, WipedMidTransactionError } from './errors';

/**
 * Where a host's ontology comes from — the one ontology decision a host keeps (ADR-007's
 * composition, with acquisition outside the plane). The plane asks only when an op's pinned
 * version differs from what is installed, or nothing is installed.
 */
export interface OntologySource {
  /**
   * The source's current row, or `null` when it has asked and the row will arrive at
   * {@link Resources.onOntologyPulled}. The Galaxy's chat seed answers at once; a Star's source
   * asks its Galaxy, whose answer comes back by fire-back.
   */
  current(): OntologyVersionRow | null;
  /** The Worker Loader bundle id for a version — scoped by something globally unique, since the
   *  loader caches by id across the whole Worker (durable-objects.md § Dynamic Worker Loader). */
  bundleId(version: string): string;
}

/** The installed ontology an op validates against. `version` is stamped into snapshot metadata,
 *  so it is server-sourced, never client-supplied. */
export interface InstalledOntology {
  version: string;
  facet: ParserValidator;
  relationships: OntologyVersionRow['relationships'];
}

/** One requested node invitee: the address, and the DAG tier to grant at the node. */
export interface NodeInvitee { email: string; tier: PermissionTier }

/** {@link Resources.invite}'s synchronous ack — SUBMISSION outcomes only (a true delivery
 *  failure is out-of-band and arrives hours later, when no tab is listening); everything downstream
 *  lands in `_InviteStatus` rows the members panel query-subscribes. */
export interface NodeInviteAck { accepted: number; errors: InviteeError[] }

/**
 * The request-leg surface — the whole of what a host's `@mesh() get resources` hands the wire.
 * Each member derives what its caller may not state and applies the version rule before the op.
 * Built from closures over the plane, so no member and no property leads back to it: a
 * TypeScript `private` field would be walked like any other property.
 */
export interface ResourcesRequests {
  /** Returns a stale version's `OntologyStaleError` as a VALUE, as it always has. */
  transaction(ontologyVersion: string, newETag: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult | OntologyStaleError> | OntologyStaleError;
  /** Throws a stale version's `OntologyStaleError`. */
  read(ontologyVersion: string, resourceId: string): Snapshot | null;
  /** Pushes a stale version's `OntologyStaleError` on the resource channel. */
  subscribe(ontologyVersion: string, resourceType: string, resourceId: string): void;
  unsubscribe(resourceType: string, resourceId: string): void;
  subscribeQuery(query: QueryDescriptor): void;
  unsubscribeQuery(queryHash: string): void;
  subscribeQuerySubscribers(query: QueryDescriptor): void;
  unsubscribeQuerySubscribers(queryHash: string): void;
  invite(nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck>;
  /** The org tree, whose own methods check each op; a getter, so the chain reads `resources.orgTree.setPermission(…)`. */
  readonly orgTree: OrgTree;
  subscribeTree(): void;
}

/** The DAG tier vocabulary, as a runtime gate — mesh args are compile-time typed but
 *  runtime-unchecked, and `invite`'s eventual caller is Studio-GENERATED app code (ADR-001: the
 *  mesh method is the validation boundary). */
const PERMISSION_TIERS: ReadonlySet<string> = new Set(['admin', 'write', 'read']);

/** Structural email gate — non-empty local part, `@`, non-empty domain (the same hand-rolled shape
 *  the Registry re-checks; a failure here is a per-invitee error, never a whole-batch one). */
function isValidInviteEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const at = email.indexOf('@');
  return at > 0 && at < email.length - 1;
}

/** The install history, with the installed version LAST, and one row per installed version. */
const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

/**
 * Every table and storage key the plane's parts own, which a wipe drops before rebuilding them:
 * `OrgTree`'s three tables, `Snapshots`', and the one `Subscriptions` table with its migration
 * marker. The ontology keys go by their `ontology:` prefix. Anything a host keeps outside the
 * plane — the Star's `config` — survives, and so does mesh's identity, which is why the same call
 * can send straight after a wipe. Listed in drop order: a table goes before the one it references,
 * since dropping `Nodes` under a `Snapshots` row that points at it fails its foreign key. A list and
 * not a derivation, so `plane-wipe.test.ts` reads every table from `sqlite_master` after a wipe and
 * matches the set exactly: a table a part adds reds it until someone decides whether it goes here.
 */
const PLANE_TABLES = ['Subscriptions', 'Snapshots', 'Permissions', 'Edges', 'Nodes'] as const;
const PLANE_KEYS = ['__sql_migrations_Subscriptions'] as const;

/**
 * The response-leg surface — the whole of what a host's `get resourcesResults` hands the answers
 * the plane asked for: the reapers a failed update names, the node invite's facade answer, and a
 * Star's ontology pull. A reaper's result arrives locally, when a Gateway answers inside its ack;
 * the other two arrive at the host's fire-back door, where the member-level check is off. Neither
 * path consults the mark, so the gate carries none. A mark would open every member to any caller
 * with passage, and `onOntologyPulled` is the one that matters: it checks no permission and installs
 * whatever row it is handed, so a caller could load a validator of their own — and on a `.dev`
 * Star, run the install's wipe. (`onInviteResult` is not the reason: a forged call runs under the
 * forger's own claims, and `setPermission` re-checks `admin` at the node.) Built from closures over
 * the plane, like {@link ResourcesRequests}.
 */
export interface ResourcesResults {
  /** The node invite's facade answer: writes the grants, then flips each `_InviteStatus` row. */
  onInviteResult(nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown): Promise<void>;
  /** A source's answer — a Star's `getCurrentOntology()` fire-back. Installs a row it has not. */
  onOntologyPulled(result?: unknown): void;
  /** The reapers: each drops the row of the tab its Gateway reports gone — the tab from
   *  `callContext.callee`, the address the update was sent to, never from the reply. */
  onBroadcastResult(resourceId: string, result?: unknown): void;
  onQueryBroadcastResult(queryHash: string, result?: unknown): void;
  onQuerySubscriberListBroadcastResult(queryHash: string, result?: unknown): void;
  onTreeBroadcastResult(result?: unknown): void;
}

/**
 * What every host composing the plane implements: the one getter the plane's continuations are
 * addressed through, so the plane builds them over this type and a misnamed result does not
 * compile. The getter carries no `@mesh()` — see {@link ResourcesResults} for why.
 */
export interface ResourcesHost {
  readonly resourcesResults: ResourcesResults;
}

export class Resources {
  #ctx: DurableObjectState;
  #lmz: () => LmzApi;
  #source: OntologySource;
  #onCommitted?: (mutations: Map<string, Snapshot>) => void;
  #orgTree!: OrgTree;
  #snapshots!: Snapshots;
  #subscriptions!: Subscriptions;
  // Caches over the installed row (loss acceptable — rebuilt from storage on the next read).
  #row: OntologyVersionRow | null = null;
  #facet: ParserValidator | null = null;
  // Bumped by every wipe. A transaction takes it when it starts and refuses to commit if it
  // changed, so one paused at validation's `await` across a wipe writes nothing into the rebuilt
  // tables. In memory by design: a paused transaction and the wipe share one isolate.
  #generation = 0;

  /** The request-leg surface — see {@link ResourcesRequests}. A host's `@mesh() get resources`
   *  returns it; the host never returns the plane. */
  readonly requests: ResourcesRequests;

  /** The response-leg surface — see {@link ResourcesResults}. A host's unmarked
   *  `get resourcesResults` returns it. */
  readonly results: ResourcesResults;

  /**
   * @param lmz - The host's `lmz`, as a **thunk**. The plane sends every subscription update
   *   through it and derives its call context and host name from it.
   * @param source - Where this host's ontology comes from; the plane asks it only on a mismatch.
   * @param onCommitted - The host's post-commit hook, fired once per successful transaction
   *   AFTER the updates it causes, with the committed snapshots. It runs the other way from
   *   everything else here — the plane telling the host — and fires on every commit path
   *   (client transactions and server-internal ensures alike); the host's own predicate decides
   *   what reacts. The Galaxy's codegen trigger hangs here.
   */
  constructor(
    ctx: DurableObjectState,
    lmz: () => LmzApi,
    source: OntologySource,
    onCommitted?: (mutations: Map<string, Snapshot>) => void,
  ) {
    this.#ctx = ctx;
    this.#lmz = lmz;
    this.#source = source;
    this.#onCommitted = onCommitted;
    this.#build();
    this.requests = this.#buildRequests();
    this.results = this.#buildResults();
  }

  /**
   * Construct the parts — at construction, and again after a wipe drops their tables. The parts
   * get narrow thunks, never the handle: `orgTree` is handed to the wire behind the host's gate,
   * so whatever an `OrgTree` holds is reachable from it. Thunks, never captured values — this runs
   * inside the host's `onStart()`, where `lmz.instanceName` is not yet stamped. The host name is
   * the scope the `access.scopeAdmin` bypass is confined to, at both confinement points
   * (`OrgTree.requirePermission` and the subscribe-time writers), and the guards fail closed on an
   * absent one.
   */
  #build(): void {
    const getCallContext = () => this.#lmz().callContext;
    const getHostName = () => this.#lmz().instanceName;
    // Fires only AFTER construction — on a real tree mutation — so the registry, assigned below,
    // exists by then. A tree change sends the tree and nothing else: the server re-runs no query
    // on a permission change (a loss shows at the next update, and a client watching the tree
    // re-subscribes what it was denied).
    this.#orgTree = new OrgTree(this.#ctx, getCallContext, () => this.#broadcastTree(), getHostName);
    this.#snapshots = new Snapshots(this.#ctx, getCallContext, this.#orgTree);
    this.#subscriptions = new Subscriptions(this.#ctx, getCallContext, this.#snapshots, getHostName);
  }

  /**
   * A continuation typed over `T` — the shape of `profile.ts`'s `ctn()`, since the plane has no
   * `this.ctn()`. Typed over {@link ResourcesHost}, a misnamed reaper fails to compile; the
   * untyped `newContinuation()` would compile it and fail the reap into a log line.
   */
  #ctn<T>(): Continuation<T> {
    return newContinuation() as Continuation<T>;
  }

  /**
   * Every subscription update leaves here: one `lmz.broadcast`, to one tab or to many. `onResult`
   * is the reaper that drops a target the Gateway reports gone; an update with none reaps nothing.
   */
  #send<T>(targets: BroadcastTarget[], remote: Continuation<T>, onResult?: AnyContinuation): void {
    if (targets.length === 0) return;
    this.#lmz().broadcast(targets, remote, onResult ? { onResult } : undefined);
  }

  // ─── The request-leg surface ─────────────────────────────────────────

  /**
   * The caller's own address, derived — the client's id from `callChain[0]` and the binding its
   * updates go to from `callChain.at(-1)` — so no member takes either as an argument. Refuses a
   * chain that no client originated: the id names a client's rows, and nothing else has any.
   */
  #caller(): { clientId: string; subscriberBinding: string } {
    const chain = this.#lmz().callContext.callChain;
    const origin = chain[0];
    if (origin?.type !== 'LumenizeClient' || !origin.instanceName) {
      throw new Error('Resources requests need a client origin: callChain[0] must be a LumenizeClient');
    }
    const subscriberBinding = chain.at(-1)?.bindingName;
    if (!subscriberBinding) throw new Error('Resources requests need a gateway in callChain.at(-1)');
    return { clientId: origin.instanceName, subscriberBinding };
  }

  /**
   * Build {@link Resources.requests}: one closure per member, each over the plane's private
   * methods, so the object's only properties are its members.
   */
  #buildRequests(): ResourcesRequests {
    const tree = () => this.#orgTree;
    const tab = (address: { clientId: string; subscriberBinding: string }) =>
      [{ bindingName: address.subscriberBinding, instanceName: address.clientId }];
    return {
      transaction: (ontologyVersion, newETag, ops) => {
        const { clientId } = this.#caller();
        return this.#gate(ontologyVersion) ?? this.#transaction(ontologyVersion, newETag, ops, clientId);
      },
      read: (ontologyVersion, resourceId) => {
        const stale = this.#gate(ontologyVersion);
        if (stale) throw stale;
        return this.doRead(resourceId);
      },
      subscribe: (ontologyVersion, resourceType, resourceId) => {
        const address = this.#caller();
        const stale = this.#gate(ontologyVersion);
        if (stale) {
          this.#send(tab(address), this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, stale));
          return;
        }
        this.doSubscribe(resourceType, resourceId, address.clientId, address.subscriberBinding);
      },
      unsubscribe: (resourceType, resourceId) => {
        void resourceType; // resource rows key on the id; the type lives on the snapshot
        this.removeSubscriber(resourceId, this.#caller().clientId);
      },
      subscribeQuery: (query) => {
        const address = this.#caller();
        const stale = this.#gate(undefined);
        if (stale) {
          this.#sendQueryUpdate(tab(address), canonicalQueryHash(query), stale);
          return;
        }
        this.doSubscribeQuery(query, address.clientId, address.subscriberBinding);
      },
      unsubscribeQuery: (queryHash) => this.removeQuerySubscriber(queryHash, this.#caller().clientId),
      subscribeQuerySubscribers: (query) => {
        const address = this.#caller();
        const stale = this.#gate(undefined);
        if (stale) {
          this.#sendRoster(tab(address), canonicalQueryHash(query), stale);
          return;
        }
        this.doSubscribeQuerySubscribers(query, address.clientId, address.subscriberBinding);
      },
      unsubscribeQuerySubscribers: (queryHash) =>
        this.removeQuerySubscriberListWatcher(queryHash, this.#caller().clientId),
      invite: async (nodeId, invitees) => {
        const stale = this.#gate(undefined);
        if (stale) throw stale;
        return this.invite(nodeId, invitees);
      },
      get orgTree() { return tree(); },
      subscribeTree: () => {
        const address = this.#caller();
        this.doSubscribeTree(address.clientId, address.subscriberBinding);
      },
    };
  }

  /**
   * Build {@link Resources.results}, the same way as `requests`. A reaper takes the dead tab from
   * `callContext.callee` — the address the update went to — so a reply cannot name a victim.
   */
  #buildResults(): ResourcesResults {
    const gone = (result: unknown): string | undefined =>
      result instanceof Error && result.name === 'ClientDisconnectedError'
        ? this.#lmz().callContext.callee?.instanceName
        : undefined;
    return {
      onInviteResult: (nodeId, tiers, result) => this.#onInviteResult(nodeId, tiers, result),
      onOntologyPulled: (result) => this.#onOntologyPulled(result),
      onBroadcastResult: (resourceId, result) => {
        const clientId = gone(result);
        if (clientId) this.removeSubscriber(resourceId, clientId);
      },
      onQueryBroadcastResult: (queryHash, result) => {
        const clientId = gone(result);
        if (clientId) this.removeQuerySubscriber(queryHash, clientId);
      },
      onQuerySubscriberListBroadcastResult: (queryHash, result) => {
        const clientId = gone(result);
        if (clientId) this.removeQuerySubscriberListWatcher(queryHash, clientId);
      },
      onTreeBroadcastResult: (result) => {
        const clientId = gone(result);
        if (clientId) this.removeTreeSubscriber(clientId);
      },
    };
  }

  // ─── The ontology: one version rule for every host ──────────────────

  /** The installed version — the LAST entry of the install history — or `''` before any install. */
  #installedVersion(): string {
    const index = this.#ctx.storage.kv.get<string[]>(INDEX_KEY);
    return index && index.length > 0 ? index[index.length - 1] : '';
  }

  /**
   * The installed ontology, for every op that validates and for the host's own probes. With
   * nothing installed it takes the version rule's path first, so a host whose source answers at
   * once installs on first touch; one whose source answers later throws the `installing` stale,
   * which its ops never reach because the rule answered it first.
   */
  installedOntology(): InstalledOntology {
    if (!this.#installedVersion()) {
      const stale = this.#gate(undefined);
      if (stale) throw stale;
    }
    const { row, facet } = this.#ensureFacet();
    return { version: row.version, facet, relationships: row.relationships };
  }

  /** Populate `#row`/`#facet` from storage — a same-isolate cache lookup once warm. */
  #ensureFacet(): { row: OntologyVersionRow; facet: ParserValidator } {
    if (this.#row && this.#facet) return { row: this.#row, facet: this.#facet };
    const version = this.#installedVersion();
    if (!version) throw new Error('No ontology installed on this host');
    const row = this.#ctx.storage.kv.get<OntologyVersionRow>(rowKey(version));
    if (!row) throw new Error(`Ontology row missing for version '${version}' — index/row drift`);
    const bundleId = this.#source.bundleId(row.version);
    const facet = getParserValidatorFacet(this.#ctx, env.LOADER, bundleId, () => {
      debug('nebula.Resources.ontology').info('facet cold load', { bundleId, version: row.version });
      return row.validatorBundle;
    });
    this.#row = row;
    this.#facet = facet;
    return { row, facet };
  }

  /**
   * The one version rule: `null` to proceed, or the error the op answers with. A client pinned to
   * the installed version proceeds, as does an op that pins nothing once anything is installed.
   * Otherwise — a mismatch, or nothing installed — the plane asks its source once. `null` means the
   * row arrives by fire-back, answered `installing`. A row that differs from what is installed is
   * installed, and a refused install answers stale. The op then proceeds if it pinned that row or
   * nothing, and is told stale otherwise.
   */
  #gate(pinned: string | undefined): OntologyStaleError | null {
    const installed = this.#installedVersion();
    if (installed && (pinned === undefined || pinned === installed)) return null;
    // One marker per ask, stamped with the host, so a test can count asks per op.
    debug('nebula.Resources.source').debug('ask', { instanceName: this.#lmz().instanceName, pinned, installed });
    const row = this.#source.current();
    if (row === null) return new OntologyStaleError(pinned ?? '', installed, { installing: true });
    if (row.version !== installed) {
      try {
        this.#install(row);
      } catch (err) {
        debug('nebula.Resources.ontology').warn('install refused', {
          version: row.version, error: err instanceof Error ? err.message : String(err),
        });
        return new OntologyStaleError(pinned ?? '', installed);
      }
    }
    if (pinned === undefined || pinned === row.version) return null;
    return new OntologyStaleError(pinned, row.version);
  }

  /**
   * Make `row` THE installed version, recorded in one write: a row installed while the record
   * named another is the drift that once made every op throw after an eviction. A row already
   * installed changes nothing. Replacing a version first drains what the change invalidates —
   * every subscriber when the row wipes, the resource, query and roster subscribers otherwise —
   * and tells each client once, after the row is recorded. A first install drains nothing and
   * never wipes. Throws, before anything changes, when the row would wipe a host that is not a
   * `.dev` Star.
   */
  #install(row: OntologyVersionRow): void {
    const installed = this.#installedVersion();
    if (installed === row.version) return;
    const wipes = Boolean(installed && row.wipeOnInstall);
    const tell: DroppedAddress[] = wipes
      ? this.#wipe({ cause: 'install', version: row.version })
      : installed ? this.#subscriptions.clear(['resource', 'query', 'roster']) : [];
    this.#ctx.storage.transactionSync(() => {
      const history = (this.#ctx.storage.kv.get<string[]>(INDEX_KEY) ?? []).filter((v) => v !== row.version);
      const prior = history.at(-1);
      if (prior) this.#ctx.storage.kv.delete(rowKey(prior));
      this.#ctx.storage.kv.put(rowKey(row.version), row);
      this.#ctx.storage.kv.put(INDEX_KEY, [...history, row.version]);
    });
    this.#row = null;
    this.#facet = null;
    this.#notifyStale(tell, row.version);
    debug('nebula.Resources.ontology').debug('installed', {
      instanceName: this.#lmz().instanceName, version: row.version, prior: installed, wiped: wipes,
    });
  }

  /**
   * Where a source's fire-back lands — a Star's `getCurrentOntology()` answer, through
   * `results.onOntologyPulled`. Installs the row unless it is installed already. `null` (nothing applied yet) and an
   * Error install nothing, so a client's `installing` retries run out at the stale signal. Never
   * rethrows: a fire-back handler's throw vanishes.
   */
  #onOntologyPulled(result?: unknown): void {
    const log = debug('nebula.Resources.ontology');
    try {
      if (result instanceof Error) {
        log.warn('ontology pull failed', { error: result.message });
        return;
      }
      const row = result as OntologyVersionRow | null;
      if (!row) {
        log.warn('ontology pull returned no row — nothing applied yet');
        return;
      }
      this.#install(row);
    } catch (err) {
      log.error('ontology pull handling failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Erase everything the plane owns and rebuild it — the `.dev` sandbox reset behind Studio's
   * Wipe (`Star.resetDevData`). Records no ontology row, so the next op's install is a first
   * install and nothing wipes twice, and tells every subscriber of every kind once. Throws, before
   * it records or changes anything, unless the host is a `.dev` Star.
   */
  wipe(): void {
    this.#notifyStale(this.#wipe({ cause: 'reset' }), '');
  }

  /**
   * The wipe both paths share, all synchronous so no other event runs in between: refuse unless
   * the host is a `.dev` Star; write one ADR-016 record of the claims in context and the cause;
   * capture every subscriber to tell; drop every table and key the plane owns and rebuild its
   * parts, so a grant the wipe erased stops authorizing at once; and bump the generation, so a
   * transaction paused across it refuses to commit.
   */
  #wipe(cause: { cause: 'reset' } | { cause: 'install'; version: string }): DroppedAddress[] {
    const host = this.#lmz().instanceName ?? '';
    const segs = host.split('.');
    if (!(segs.length === 3 && segs[2] === 'dev')) {
      throw new Error('A wipe is only permitted on the .dev sandbox Star');
    }
    const claims = this.#lmz().callContext.originAuth?.claims as NebulaJwtPayload | undefined;
    debug('nebula.Resources.wipe').info('wipe', {
      instanceName: host, ...cause, actingToken: claims ? projectActingToken(claims) : null,
    });
    const tell = this.#subscriptions.clear(['resource', 'query', 'roster', 'tree']);
    this.#ctx.storage.transactionSync(() => {
      for (const table of PLANE_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      for (const key of PLANE_KEYS) this.#ctx.storage.kv.delete(key);
      const ontologyKeys = [...this.#ctx.storage.kv.list({ prefix: 'ontology:' })].map(([key]) => key);
      for (const key of ontologyKeys) this.#ctx.storage.kv.delete(key);
    });
    this.#build();
    this.#row = null;
    this.#facet = null;
    this.#generation++;
    return tell;
  }

  /** Tell each client once that what it holds is gone — the `OntologyStaleError` notice on the
   *  resource channel, which the client routes to its refresh hook whatever pair carried it. */
  #notifyStale(targets: DroppedAddress[], currentVersion: string): void {
    this.#send(
      targets.map((d) => ({ bindingName: d.subscriberBinding, instanceName: d.clientId })),
      this.#ctn<NebulaClient>().handleResourceUpdate('', '', new OntologyStaleError('', currentVersion)),
    );
  }

  // ─── Node invites (two-plane: the DAG grant here, the membership via the facade) ────────

  /**
   * Invite people onto a NODE — the two-plane operation, written ONCE for every host
   * (Star + Galaxy) so the security logic cannot fork: it initiates here, where the
   * inviter's authority lives (`requirePermission`: `admin` at `nodeId` — the only authz
   * decision on this path, because the facade cannot evaluate a DAG grant by design),
   * writes `pending` `_InviteStatus` rows locally, fires the membership mint at the facade,
   * and returns the ack. The result handler (`results.onInviteResult`) writes the
   * `setPermission` grants and flips each row to `sent`/`submission-failed` — so the two
   * planes are both written at INVITE time, and the invitee's first login finds everything in
   * place (no login-time sequencing). The facade call goes out only when at least one invitee
   * survived validation, and its outcome returns through the host's `resourcesResults`
   * ({@link ResourcesHost}).
   *
   * Batch semantics: one `nodeId` per call (one `requirePermission` licenses the whole
   * batch), `tier` per invitee, a malformed email joins the per-invitee errors without
   * failing the batch — but an out-of-vocabulary `tier` refuses the WHOLE call before any
   * side effect (a grant vocabulary error is a caller bug, not a per-address condition).
   *
   * The facade call NEVER requests a `scopeAdmin` bit — the cap rule in its degenerate form: a
   * node inviter's authority is a DAG grant, and the `tier` parameter governs the DAG grant only.
   * On a Galaxy the Registry still co-mints the invitee's `{galaxy}.dev` workspace membership,
   * with the admin bit exactly when the INVITER holds dominion over the Galaxy — deliberately, so a
   * collaborator can work in the preview; `four-party-chat` asserts it. Convergence: one `_InviteStatus` row per (email, node) — a re-invite
   * converges on the existing row (fresh `tier`, back to `pending`) rather than
   * duplicating, so a second admin sees one coherent state (ADR-008 org-visibility).
   *
   * Precondition: the host must hold a WORKING ontology — the `_InviteStatus` rows ride
   * the ordinary Resources pipeline, so this fails closed (before the facade fires) on a
   * host that has never had one.
   */
  async invite(nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck> {
    // ── The ADR-001 boundary: shape-check what the wire cannot. Whole-call refusals carry their
    // own messages, each distinguishable from the DAG refusal (`PermissionDeniedError`'s
    // "admin permission required on node …") and from every facade refusal.
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new Error('Invalid node invite: nodeId must be a node id string');
    }
    if (!Array.isArray(invitees)) {
      throw new Error('Invalid node invite: invitees must be an array');
    }
    const errors: InviteeError[] = [];
    const valid: NodeInvitee[] = [];
    for (const entry of invitees) {
      if (entry === null || typeof entry !== 'object') {
        errors.push({ email: '', error: 'Invalid invitee entry' });
        continue;
      }
      const { email, tier } = entry as { email: unknown; tier: unknown };
      if (!PERMISSION_TIERS.has(tier as string)) {
        // BEFORE any mint or send side effect, deliberately whole-call — see the JSDoc.
        throw new Error(`Invalid node invite: tier "${String(tier)}" is not one of admin | write | read`);
      }
      if (!isValidInviteEmail(email)) {
        errors.push({ email: typeof email === 'string' ? email : '', error: 'Invalid email format' });
        continue;
      }
      // Normalize exactly as the Registry does — the handler's tier lookup keys on the summary's
      // normalized address, so the two sides must agree.
      valid.push({ email: email.toLowerCase().trim(), tier: tier as PermissionTier });
    }

    // The DAG gate at the door — one check licenses the whole batch.
    this.#orgTree.requirePermission(nodeId, 'admin');

    if (valid.length > 0) {
      // `pending` rows, converged on (email, node) — through the ordinary transaction path, so
      // validation, `actingToken` attribution (the inviter, `act` chain included) and subscriber
      // fan-out all apply. Server-side write → no originating client to exclude ('').
      const ops: Record<string, OperationDescriptor> = {};
      for (const v of valid) {
        const existing = this.#findInviteStatus(nodeId, v.email);
        const value = { node: nodeId, email: v.email, tier: v.tier, state: 'pending' };
        if (existing) {
          ops[existing.resourceId] = { op: 'put', eTag: existing.meta.eTag, value };
        } else {
          ops[crypto.randomUUID()] = { op: 'create', nodeId, typeName: '_InviteStatus', value };
        }
      }
      let written: TransactionResult;
      try {
        written = await this.doTransaction(crypto.randomUUID(), ops, '');
      } catch (err) {
        // A wipe landed while the rows validated: nothing was written, and the inviter is told
        // stale, the answer a transaction gets.
        if (err instanceof WipedMidTransactionError) throw new OntologyStaleError('', this.#installedVersion());
        throw err;
      }
      if (!written.ok) {
        // The ops were derived from current rows, but another writer can converge the same row
        // while these validate — surface that loudly rather than half-invite.
        throw new Error(`node invite could not record its pending state: ${JSON.stringify(written.errors)}`);
      }

      // Fire the membership mint through the ONE issuing entry, receiving the outcome in the
      // host's TRAVELING handler (two one-way calls): the slow email I/O runs on the CPU-billed
      // facade Worker while the host DO's input gates stay closed, and the handler runs on a
      // cold, storage-restored host if this one was evicted. `callContext` (the inviter's
      // verified claims) propagates across the hop, so the facade's eligibility + the
      // Registry's ADR-016 record see the real acting principal. A call to another node keeps
      // the caller's identity; only a subscription update speaks for the node alone.
      const lmz = this.#lmz();
      lmz.call(
        'NEBULA_AUTH_FACADE', undefined,
        this.#ctn<NebulaAuthFacade>().invite(lmz.instanceName!, valid.map(({ email }) => ({ email }))),
        this.#ctn<ResourcesHost>().resourcesResults.onInviteResult(nodeId, Object.fromEntries(valid.map((v) => [v.email, v.tier]))),
      );
    }
    return { accepted: valid.length, errors };
  }

  /**
   * The node invite's result handler — the body behind `results.onInviteResult`, which the facade
   * call above names as its traveling continuation (never awaited), so it survives the host's
   * eviction and the inviter's disconnect. Writes the second plane: `setPermission` at the node for
   * every minted `sub` (already-member outcomes included — that is what heals the one reachable
   * two-plane inconsistency, a membership without its grant), then flips each `_InviteStatus` row
   * to `sent`/`submission-failed`. It runs at the host's fire-back door, `__handleResponse`, where
   * the member-level check is off and the scope check on. The whole body is wrapped: an uncaught
   * throw in a fire-back handler is silently lost, so failures are logged with identifiers only.
   */
  async #onInviteResult(
    nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown,
  ): Promise<void> {
    const log = debug('nebula.Resources.invite');
    try {
      if (result instanceof Error) {
        // The whole submission failed (facade refusal or infra) — every pending row flips.
        // ⚠️ DEFENSIVE, with no honest in-lane producer today (testing.md's hard-to-reach
        // exception): the host pre-validates with the same email gate the Registry re-runs, sends
        // no bit for the cap to breach on, and its caller passed `requirePermission` — so reaching
        // here requires an infrastructure failure or a facade eligibility change. What replaces
        // the test is that the event announces itself below and the flip is visible org-wide.
        await this.#flipInviteStatuses(nodeId, Object.keys(tiers).map((email) =>
          ({ email, state: 'submission-failed', error: result.message })));
        log.warn('node invite submission failed', { nodeId, error: result.message });
        return;
      }
      const summary = result as InviteSummary;
      // The grants FIRST — they are the operation's point; the flips are reporting. Runs under the
      // response-leg callContext (the inviter's claims), so `setPermission`'s own `admin` gate
      // re-checks the same principal `requirePermission` admitted at the door.
      for (const r of summary.results) {
        const tier = tiers[r.email];
        if (!tier) {
          // A summary row for an address this call never sent — an invariant breach, not a grant.
          log.error('node invite summary named an unrequested address — no grant written', { nodeId });
          continue;
        }
        this.#orgTree.setPermission(nodeId, r.sub, tier);
      }
      await this.#flipInviteStatuses(nodeId, [
        ...summary.results.map((r) => ({ email: r.email, state: 'sent' as const })),
        ...summary.errors.map((e) => ({ email: e.email, state: 'submission-failed' as const, error: e.error })),
      ]);
    } catch (err) {
      // Never rethrow — a fire-back handler's throw vanishes. Identifiers only.
      log.error('node invite result handling failed', {
        nodeId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The CURRENT `_InviteStatus` row for (email, node), or null — the convergence lookup. */
  #findInviteStatus(nodeId: string, email: string): (Snapshot & { resourceId: string }) | null {
    for (const { resourceId } of this.findCurrentByField('_InviteStatus', 'node', nodeId)) {
      const snapshot = this.doRead(resourceId);
      if (snapshot && (snapshot.value as { email?: string }).email === email) {
        return { ...snapshot, resourceId };
      }
    }
    return null;
  }

  /** Flip each (email, node) row's `state` (+ optional `error`), subscriber fan-out included.
   *  PER-ROW transactions, deliberately — the rows are independent, and one atomic batch would let
   *  a single stale eTag (a concurrent re-invite converging that address mid-flight) void the
   *  SIBLING invitees' flips, stranding them at `pending` with only a warn to show for it. A row
   *  that vanished or moved on (converged by a newer writer) is skipped: that writer owns its
   *  state. */
  async #flipInviteStatuses(
    nodeId: string,
    flips: Array<{ email: string; state: 'sent' | 'submission-failed'; error?: string }>,
  ): Promise<void> {
    for (const flip of flips) {
      const existing = this.#findInviteStatus(nodeId, flip.email);
      if (!existing) continue;
      const value = {
        ...(existing.value as Record<string, unknown>),
        state: flip.state,
        ...(flip.error !== undefined ? { error: flip.error } : {}),
      };
      if (flip.error === undefined) delete (value as Record<string, unknown>).error;
      const written = await this.doTransaction(crypto.randomUUID(), {
        [existing.resourceId]: { op: 'put', eTag: existing.meta.eTag, value },
      }, '');
      if (!written.ok) {
        debug('nebula.Resources.invite').warn('an _InviteStatus flip did not apply (a newer writer owns the row)', {
          nodeId, resourceId: existing.resourceId,
        });
      }
    }
  }

  /**
   * Push ONE transient progress chunk to the subscribers of `query` who may read `nodeId` — the
   * node the resource the progress is for will be written under, so delivery honors the same read
   * check the committed resource will. No Resource write and no reaper: a missed chunk drops only
   * the animation, and the committed resource still arrives through the query's own update.
   *
   * `replyTo` ATTRIBUTES the chunk: it goes to every subscriber of the query, so without it a
   * recipient cannot tell whose request the progress answers, and would read every chunk as
   * liveness for its own. `query` and `replyTo` come from the host's own code — this is on no
   * wire surface, since a caller able to name them could stream text attributed to someone
   * else's request.
   */
  streamProgress(
    query: QueryDescriptor, resourceId: string, progress: string, nodeId: string, replyTo: string,
  ): void {
    const targets = this.#targetsForQuery(query, nodeId);
    // Log identifiers/counts only — never the progress body.
    debug('nebula.Resources.stream').debug('chunk', { resourceId, targets: targets.length, len: progress.length });
    this.#send(targets, this.#ctn<NebulaClient>().handleStreamChunk(resourceId, progress, replyTo));
  }

  /**
   * The subscriber connections of `query` that hold `read` on `nodeId` right now — one entry per
   * subscribed tab, no dedup by `sub`, so every open tab is a delivery target. Honors the stored
   * `access.scopeAdmin` verdict as the per-push recheck does. `[]` when nobody may read `nodeId`.
   */
  #targetsForQuery(query: QueryDescriptor, nodeId: string): BroadcastTarget[] {
    return this.#subscriptions
      .forQuery(canonicalQueryHash(query))
      .filter((r) =>
        this.#orgTree.evaluatePermissions([nodeId], 'read', r.sub, Boolean(r.dominionOverHostAtSubscribe)).allowed.size > 0)
      .map((r) => ({ bindingName: r.subscriberBinding, instanceName: r.clientId }));
  }

  // --- Subscriber-list roster (a query's live subscriber roster, delivered to WATCHERS —
  //     tasks/nebula-subscriber-lists.md) ---

  /**
   * The DISTINCT-by-`sub` roster for a query — a set of PEOPLE, not connections. `forQuery` returns
   * one row per connection (per tab), so dedup by `sub`. Advisory / display-only: carries no
   * dominion or permission data (ADR-008).
   */
  #rosterFor(queryHash: string): SubscriberEntry[] {
    const bySub = new Map<string, SubscriberEntry>();
    for (const r of this.#subscriptions.forQuery(queryHash)) {
      if (!bySub.has(r.sub)) bySub.set(r.sub, { sub: r.sub, profileId: r.profileId });
    }
    return [...bySub.values()];
  }

  /**
   * Roster delivery targets — one per WATCHER connection (a subscriber of the query's subscriber-LIST,
   * NOT a data-subscriber). Built from the roster rows with NO permission filter:
   * the roster is reachability-gated + uniform (ADR-008), so any reachable watcher gets the full roster.
   */
  #watcherTargets(queryHash: string): BroadcastTarget[] {
    return this.#subscriptions
      .watchersOf(queryHash)
      .map((r) => ({ bindingName: r.subscriberBinding, instanceName: r.clientId }));
  }

  /** Broadcast the current distinct-by-`sub` roster to a query's WATCHERS — fired ONLY on a genuine
   *  data-subscriber join (`isNewSub`) or an actual leave (`rowsWritten > 0`). A read-only projection of
   *  the query rows, sent to the roster rows; a roster row is a different kind, so it never enters the
   *  commit re-run's scan. */
  #broadcastRoster(queryHash: string): void {
    const targets = this.#watcherTargets(queryHash);
    if (targets.length === 0) return;
    this.#sendRoster(targets, queryHash, this.#rosterFor(queryHash));
  }

  /** A roster update — the query's roster, or an Error for a rejected watcher query. Its reaper
   *  drops a watcher the Gateway reports gone from the roster rows only, never the query rows,
   *  so a client that is also a data-subscriber of the query keeps that row. */
  #sendRoster(targets: BroadcastTarget[], queryHash: string, result: SubscriberEntry[] | Error): void {
    this.#send(targets, this.#ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, result),
      this.#ctn<ResourcesHost>().resourcesResults.onQuerySubscriberListBroadcastResult(queryHash));
  }

  /** Drop one resource subscription — `requests.unsubscribe` for the caller's own row, and the
   *  `results.onBroadcastResult` for a tab the Gateway reports gone. */
  removeSubscriber(resourceId: string, clientId: string): void {
    this.#subscriptions.removeResource(resourceId, clientId);
  }

  /**
   * Register a WATCHER of `query`'s live subscriber-list roster (the standalone subscription — the watcher
   * is NOT a data-subscriber). Validates the query fail-closed (parity with `doSubscribeQuery`); on success
   * registers the watcher + delivers the CURRENT roster single-target to the joining watcher (its initial
   * snapshot). A watcher joining does NOT change roster content → no re-push to other watchers. Identity
   * (`clientId`/`subscriberBinding`) is derived by the `requests` door from `callChain`, never passed in.
   */
  doSubscribeQuerySubscribers(query: QueryDescriptor, clientId: string, subscriberBinding: string): void {
    const queryHash = canonicalQueryHash(query);
    try {
      this.#validateQuery(query);
    } catch (err) {
      // Fail-closed: reject the watcher handle (Error keyed by queryHash) so a typo'd/malformed query
      // doesn't register a silent, permanently-empty watcher.
      debug('nebula.Resources.doSubscribeQuerySubscribers').warn('watcher query rejected', {
        queryHash, clientId, error: err instanceof Error ? err.message : String(err),
      });
      this.#sendRoster([{ bindingName: subscriberBinding, instanceName: clientId }], queryHash,
        err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.#subscriptions.registerRoster(queryHash, clientId, subscriberBinding);
    debug('nebula.Resources.subscribers').debug('watch', { event: 'watch', queryHash, clientId });
    this.#sendRoster([{ bindingName: subscriberBinding, instanceName: clientId }], queryHash, this.#rosterFor(queryHash));
  }

  /** Drop one roster watcher — `unsubscribeQuerySubscribers` + `results`' DEDICATED
   *  roster reaper call this (the latter on a `ClientDisconnectedError`). Drops ONLY
   *  the roster row (never the client's query row) and does NOT re-fire `#broadcastRoster`. */
  removeQuerySubscriberListWatcher(queryHash: string, clientId: string): void {
    this.#subscriptions.removeRoster(queryHash, clientId);
  }

  /** Drop one query-sub row — `unsubscribeQuery` + `results`' query reaper
   *  call this (the latter on a `ClientDisconnectedError`, m6). On an ACTUAL
   *  removal (`rowsWritten > 0`) re-push the shrunk roster to the query's WATCHERS; a no-op remove
   *  (duplicate/late fire-back) emits nothing — the mass-disconnect-storm guard. */
  removeQuerySubscriber(queryHash: string, clientId: string): void {
    const removed = this.#subscriptions.removeQuery(queryHash, clientId);
    debug('nebula.Resources.subscribers').debug('remove', {
      event: 'remove', queryHash, clientId, mode: removed > 0 ? 'broadcast' : 'noop',
    });
    if (removed > 0) this.#broadcastRoster(queryHash);
  }

  // ─── The org tree, on its own channel ──────────────────────────────

  /**
   * Register a subscriber to the org/permission tree and push it the current tree. The tree is
   * a per-host singleton on its own channel — never a resource, and never in `Snapshots`.
   * `getState()` is the value source and the auth gate: it requires an authenticated caller, and
   * there is deliberately NO node-level read check — the tree is visible to anyone with passage into
   * the host, a tenant reaching its Galaxy included, for the reason `subscriptions.ts` gives at the
   * tree kind. The initial tree wires no reaper; the next change reaps a dead tab.
   */
  doSubscribeTree(clientId: string, subscriberBinding: string): void {
    const state = this.#orgTree.getState();
    this.#subscriptions.registerTree(clientId, subscriberBinding);
    this.#send([{ bindingName: subscriberBinding, instanceName: clientId }],
      this.#ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }));
  }

  /** Drop one tree subscriber — `results.onTreeBroadcastResult` calls this on a `ClientDisconnectedError`. */
  removeTreeSubscriber(clientId: string): void {
    this.#subscriptions.removeTree(clientId);
  }

  /**
   * Push the fresh tree to ALL tree subscribers — **including the originator** (unlike a resource
   * update): `client.orgTree.*` has no optimistic local write-through, so this push is the only
   * way the actor's own `store.lmz.orgTree` updates. `getState()` reads the mutating caller's auth;
   * the mutation that triggered this is always authenticated.
   */
  #broadcastTree(): void {
    const subscribers = this.#subscriptions.treeSubscribers();
    if (subscribers.length === 0) return;
    const state = this.#orgTree.getState();
    const targets = subscribers.map((t) => ({ bindingName: t.subscriberBinding, instanceName: t.clientId }));
    this.#send(targets, this.#ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }),
      this.#ctn<ResourcesHost>().resourcesResults.onTreeBroadcastResult());
  }

  /**
   * Server-internal **create-if-absent** (D-session): idempotently seed a fixed
   * platform Resource (the Galaxy's default `Session`) with NO client-facing result
   * delivery. A live snapshot already present → no-op. A first create still fans out
   * to any subscribers (mirrors {@link doTransaction}'s post-commit hook; originator
   * `''` — a server seed has no client origin). The caller must be in an authed
   * context with `write` on `nodeId`.
   *
   * ✅ **Confined, via the ordinary path — no special-casing here.** This method holds no admin
   * check of its own: it goes through `Snapshots.transaction` → `OrgTree.requirePermission`, which
   * is confinement point 1. So a seed written under an admin's call has passage **iff that admin's `authScope` covers THIS host** — the
   * same rule as every other caller. See tasks/archive/nebula-confine-admin-bypass.md.
   */
  async ensureResource(
    resourceId: string, typeName: string, nodeId: string, value: Record<string, unknown>,
    opts: { actor?: { sub: string; profileId: string }; pinnedAtPost?: true } = {},
  ): Promise<void> {
    if (this.#snapshots.read(resourceId)) return; // idempotent: a live snapshot exists
    const { version, facet } = this.installedOntology();
    const generation = this.#generation;
    await this.#snapshots.transaction(
      { [resourceId]: { op: 'create', typeName, nodeId, value } },
      version, crypto.randomUUID(), facet,
      {
        onMutations: (mutations) => {
          this.#broadcast(mutations, '');
          this.#rerunQueriesForCommit(mutations);
          this.#onCommitted?.(mutations);
        },
        // Server-composed only — see snapshots.ts TransactionOpts (the trust fence).
        actor: opts.actor,
        ...(opts.pinnedAtPost ? { pinnedAtPost: true as const } : {}),
        stillCurrent: () => this.#generation === generation,
      },
    );
  }

  // ─── Handler 2 (the actual op + delivery) ──────────────────────────

  /**
   * {@link doTransaction} for `requests.transaction`: a wipe that lands while it validates
   * refuses the commit, and the caller is answered stale, as a version change would be.
   */
  async #transaction(
    pinned: string, newETag: string, ops: Record<string, OperationDescriptor>, clientId: string,
  ): Promise<TransactionResult | OntologyStaleError> {
    try {
      return await this.doTransaction(newETag, ops, clientId);
    } catch (err) {
      if (err instanceof WipedMidTransactionError) return new OntologyStaleError(pinned, this.#installedVersion());
      throw err;
    }
  }

  /** Execute a transaction at the host's current ontology version + deliver the
   *  result. Committed mutations go out as updates to their subscribers (originator excluded).
   *  Takes no `actor`: a server-composed actor rides only {@link ensureResource}, which is on no
   *  wire, so no caller can dress its write as someone else's (the trust fence). Throws
   *  `WipedMidTransactionError`, having written nothing, when a wipe lands while it validates. */
  async doTransaction(
    newETag: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ): Promise<TransactionResult> {
    const generation = this.#generation;
    try {
      const { version, facet } = this.installedOntology();
      // RETURN the result — the framework fires it back to the originating client's `callAsync`
      // (the return-value pattern). The committed-mutation broadcasts to OTHER subscribers stay a fire-and-forget
      // side effect (originator excluded via `clientId`). An infra throw propagates → `callAsync` rejects.
      return await this.#snapshots.transaction(ops, version, newETag, facet, {
        onMutations: (mutations) => {
          // The single post-commit hook drives BOTH channels (Flow 2 + Flow 3 A):
          // single-resource content fanout, then the query rerun for touched types —
          // then the host's own post-commit observer (the codegen trigger's seam).
          this.#broadcast(mutations, clientId);
          this.#rerunQueriesForCommit(mutations);
          this.#onCommitted?.(mutations);
        },
        stillCurrent: () => this.#generation === generation,
      });
    } catch (err) {
      debug('nebula.Resources.doTransaction').error('handler threw', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Read a resource (DAG read-permission enforced in `Snapshots.read`) and RETURN it — the framework
   *  fires the value back to the originating client's `callAsync`; a permission/not-found
   *  throw propagates → `callAsync` rejects. Logged for server-side observability, then re-thrown. */
  doRead(resourceId: string): Snapshot | null {
    try {
      return this.#snapshots.read(resourceId);
    } catch (err) {
      debug('nebula.Resources.doRead').error('handler threw', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Enumerate the CURRENT resources of `typeName` whose to-one relationship `field` equals
   *  `value` — the host-side twin of a `parentChild` query's evaluation, for host code that must
   *  CONVERGE on an existing row before writing (e.g. `Star.resources.invite`'s one-`_InviteStatus`-row-per-
   *  (email, node) rule). Read-only; carries no permission gate of its own — the write that follows
   *  goes through `doTransaction`'s ordinary checks, and reads of the values go through `doRead`. */
  findCurrentByField(typeName: string, field: string, value: string): Array<{ resourceId: string; nodeId: string }> {
    return this.#snapshots.enumerateCurrentByField(typeName, field, value);
  }

  /**
   * Register a resource subscriber and push what it may see: the current snapshot to a reader,
   * `{ deniedNodes: [nodeId] }` to one who cannot read it (ADR-008 — told, not refused), and an
   * Error for a refused subscribe ({@link Subscriptions.subscribeResource} says which refuse). The
   * initial answer wires no reaper; the next update reaps a dead tab.
   *
   * **Its guard is authentication plus the read evaluation this answer and every update run.** A
   * caller who cannot read still gets a row — that is the design, not a missing check.
   */
  doSubscribe(
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ): void {
    const tab = [{ bindingName: subscriberBinding, instanceName: clientId }];
    try {
      const outcome = this.#subscriptions.subscribeResource(resourceType, resourceId, clientId, subscriberBinding);
      // Marker: one per registered resource subscribe, stamped with the client — the ask-again
      // test counts these to show a tree change re-subscribes only what was denied.
      debug('nebula.Resources.subscribers').debug('subscribe-resource', {
        event: 'subscribe-resource', resourceId, clientId, denied: 'deniedNodes' in outcome,
      });
      this.#send(tab, this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
        'deniedNodes' in outcome ? { deniedNodes: outcome.deniedNodes } : outcome.snapshot));
    } catch (err) {
      debug('nebula.Resources.doSubscribe').error('handler threw', {
        clientId,
        resourceType,
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#send(tab, this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
        err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Query subscriptions (Child 2) ─────────────────────────────────

  /**
   * Register a query subscriber (Flow 1) + push the initial membership state.
   * **Registration never fails for permissions** — the subscriber is told what it can read and
   * which nodes it can't, update by update; its guard is authentication plus that evaluation. The
   * query is FIRST validated against the ontology contract (`queryType` known, `field` a to-one
   * relationship, `orderBy` supported).
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
      debug('nebula.Resources.doSubscribeQuery').warn('query rejected', {
        clientId, queryType: query.queryType, typeName: query.typeName, field: query.field,
        error: err instanceof Error ? err.message : String(err),
      });
      this.#sendQueryUpdate([{ bindingName: subscriberBinding, instanceName: clientId }], queryHash,
        err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const { row, queryHash, isNewSub } = this.#subscriptions.registerQuery(query, clientId, subscriberBinding);
    // Initial push — scoped to the one new subscriber (mirrors single-resource
    // subscribe, which pushes the first snapshot rather than returning it).
    this.#broadcastQueries(query, [row]);
    // Subscriber-list roster: a data-subscriber join that is a distinct-by-`sub` GAIN (`isNewSub`) grew
    // the roster → re-push it to the query's WATCHERS. A non-`isNewSub` join (reconnect / 2nd tab of an
    // already-present `sub`) did NOT change the roster → fire NOTHING (no else-push: the joining
    // DATA-subscriber is not a watcher and has no binding for a roster; the reconnect-storm guard +
    // Decision 1's roster⇒watchers-only — tasks/nebula-subscriber-lists.md).
    debug('nebula.Resources.subscribers').debug('subscribe', {
      event: 'subscribe', queryHash, clientId, mode: isNewSub ? 'broadcast' : 'noop',
    });
    if (isNewSub) this.#broadcastRoster(queryHash);
  }

  /**
   * Validate a query against the ontology contract. Throws on:
   *   - an unknown `queryType` (v1 supports only `'parentChild'` — fail closed so an
   *     app on a newer type gets a clean error, not garbage);
   *   - a `field` that isn't a to-one relationship on `typeName` (per the seam's
   *     `relationships` metadata);
   *   - an unsupported `orderBy` (v1 only `'validFrom'`).
   */
  #validateQuery(query: QueryDescriptor): void {
    if (query.queryType !== 'parentChild') {
      throw new Error(`Unsupported queryType '${query.queryType}' — v1 supports only 'parentChild'`);
    }
    const rels = this.installedOntology().relationships;
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
   * current snapshots (a full scan, while an index stays deferred).
   */
  #evaluateQuery(query: QueryDescriptor): Array<{ resourceId: string; nodeId: string }> {
    return this.#snapshots.enumerateCurrentByField(query.typeName, query.field, query.value);
  }

  /**
   * The single membership-delivery primitive (generic over `queryType`) — called by
   * Flow 1 (the one new subscriber) and Flow 3 (each query's subscribers, on commit).
   * Evaluates the query to its current result set, evaluates each target's read
   * permission (no short-circuit), then PARTITIONS:
   *   - **no-denial** targets (can read every match) share ONE identical payload
   *     (the full `resourceIds`) in one `lmz.broadcast`;
   *   - **has-denial** targets each get an individualized update to their own tab:
   *     the ids they can read, and the nodes they can't (`{ resourceIds, deniedNodes }`).
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
      const { allowed, denied } = this.#orgTree.evaluatePermissions(
        matchNodeIds, 'read', t.sub, Boolean(t.dominionOverHostAtSubscribe),
      );
      if (denied.size === 0) {
        noDenial.push(t);
        continue;
      }
      // Has-denial → individualized: what it can read, and which nodes it can't.
      const result: QueryUpdatePayload = {
        resourceIds: matches.filter((m) => allowed.has(m.nodeId)).map((m) => m.resourceId),
        deniedNodes: [...denied],
      };
      this.#sendQueryUpdate([{ bindingName: t.subscriberBinding, instanceName: t.clientId }], queryHash, result);
    }

    if (noDenial.length > 0) {
      const noDenialTargets = noDenial.map((t) => ({ bindingName: t.subscriberBinding, instanceName: t.clientId }));
      this.#sendQueryUpdate(noDenialTargets, queryHash, { resourceIds: allResourceIds });
    }
  }

  /** A query update — the membership, or an Error for a rejected query. Its reaper drops a
   *  query subscriber the Gateway reports gone, keyed by `queryHash`. */
  #sendQueryUpdate(targets: BroadcastTarget[], queryHash: string, result: QueryUpdatePayload | Error): void {
    this.#send(targets, this.#ctn<NebulaClient>().handleQueryUpdate(queryHash, result),
      this.#ctn<ResourcesHost>().resourcesResults.onQueryBroadcastResult(queryHash));
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
   * query rows (a decomposed-column index is the deferred optimization), not a
   * per-mutation match. Only a commit triggers it: a permission change re-runs
   * nothing, since a loss shows at the next update and a client watching the tree
   * re-subscribes whatever it was denied.
   */
  #rerunQueries(shouldRerun: (q: QueryDescriptor) => boolean): void {
    const groups = new Map<string, { query: QueryDescriptor; rows: QuerySubscriberRow[] }>();
    for (const row of this.#subscriptions.allQueries()) {
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
   * Resource-mutation broadcast — invoked from `Snapshots.transaction` via the
   * `onMutations` callback after a successful commit. Looks up subscribers per
   * mutated resource, excludes the originator, and sends each what it may see, with the
   * resource reaper for a tab the Gateway reports gone.
   *
   * **Every subscriber is rechecked on every update, and told the result.** A reader gets the
   * committed snapshot. A subscriber who cannot read it gets `{ deniedNodes: [nodeId] }` — nothing
   * from the snapshot — and keeps its row (ADR-008: told, never silently dropped). The recheck is
   * an explicit-sub `evaluatePermissions` honoring the row's stored `dominionOverHostAtSubscribe`
   * (the `access.scopeAdmin` bypass), NOT the live caller's `requirePermission`: the update path
   * holds no token. There is no revocation window — a revoked grant is caught by the very next
   * update, and nothing is delivered in between.
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorClientId: string): void {
    for (const [resourceId, snapshot] of mutations) {
      const readers: BroadcastTarget[] = [];
      const denied: BroadcastTarget[] = [];
      for (const row of this.#subscriptions.forResource(resourceId)) {
        if (row.clientId === originatorClientId) continue;
        const canRead = this.#orgTree.evaluatePermissions(
          [snapshot.meta.nodeId], 'read', row.sub, Boolean(row.dominionOverHostAtSubscribe),
        ).allowed.size > 0;
        (canRead ? readers : denied).push({ bindingName: row.subscriberBinding, instanceName: row.clientId });
      }
      this.#send(readers,
        this.#ctn<NebulaClient>().handleResourceUpdate(snapshot.meta.typeName, resourceId, snapshot),
        this.#ctn<ResourcesHost>().resourcesResults.onBroadcastResult(resourceId));
      this.#send(denied,
        this.#ctn<NebulaClient>().handleResourceUpdate(snapshot.meta.typeName, resourceId, { deniedNodes: [snapshot.meta.nodeId] }),
        this.#ctn<ResourcesHost>().resourcesResults.onBroadcastResult(resourceId));
    }
  }
}

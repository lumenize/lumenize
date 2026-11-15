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
 * and each op's answer to a mismatch live here (`#gateClientOp` for a Client's op, `#gateServer`
 * for the host's own work). So does the `.dev` sandbox's wipe, which
 * erases what the plane owns and rebuilds it.
 *
 * **It hands the wire one surface, {@link Resources.requests}, and never itself.** A host's one
 * `@mesh() get resources` returns `requests`, whose members derive what a caller may not state —
 * the client's own address, where its updates go — apply the version rule, and call an op below.
 * The ops keep their `clientAddress` parameters harmlessly, because nothing on the wire can name
 * them.
 *
 * **It sends through the host's `lmz`, handed in as a thunk.** Every subscription update leaves
 * through `lmz.broadcast` — to one tab or to many — and the node invite's facade call through
 * `lmz.call`. Continuations come from {@link Resources.#ctn}, typed over {@link ResourcesHost} for
 * the reapers, so a host missing one, or a misnamed one, fails to compile rather than failing a
 * reap into a log line.
 */

import { env } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import { addressOf, newContinuation, requireDominionHere, splitAddress } from '@lumenize/mesh';
import type { AnyContinuation, BroadcastTarget, Continuation, LmzApi } from '@lumenize/mesh';
// Type-only: the facade continuation and the client pushes are typed without pulling a second
// mesh entry, or the client, into this module's value graph.
import type { AuthFacade } from '@lumenize/mesh/auth/facade';
import type { NebulaClient } from './nebula-client';
import { getParserValidatorFacet } from '@lumenize/ts-runtime-parser-validator/runtime';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator/runtime';
import type { InviteSummary, InviteeError, AuthClaims } from '@lumenize/mesh/auth';
import { toRecordedClaims } from '@lumenize/mesh/client';
import type { PermissionTier, TreeSeed } from './org-ops';
import { OrgTree } from './org-tree';
import { Snapshots } from './snapshots';
import { Subscriptions } from './subscriptions';
import type { DroppedAddress, QuerySubscriberRow } from './subscriptions';
import { compileIndex, compileQuery, compileWhere, QUERY_INDEX_PREFIX } from './query';
import type { CompiledQuery, CompiledWhere, Filter } from './query';
import { canonicalQueryHash, QUERY_RESULT_CAP } from './query-hash';
import type { QueryDescriptor, QueryUpdatePayload, SubscriberEntry } from './query-hash';
import { parse } from '@lumenize/structured-clone';
import type { OperationDescriptor, TransactionResult, Snapshot } from './snapshots';
import type { OntologyVersionRow } from './ontology-version';
import { OntologyStaleError, ResourceMovedOnError, WipedMidTransactionError } from './errors';

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
  /** Each field's kind, which a write's value check and a query's filter read. Absent on a row
   *  compiled before queries took a filter. */
  fields?: OntologyVersionRow['fields'];
}

/**
 * The most distinct live queries one type may have on one host. Each write of a type tests the
 * written resource against every live query of that type, so the bound is what keeps a write's
 * cost from growing with its audience.
 */
export const MAX_LIVE_QUERIES_PER_TYPE = 200;

/** One requested node invitee: the address, and the DAG tier to grant at the node. */
export interface NodeInvitee { email: string; tier: PermissionTier }

/** {@link Resources.invite}'s synchronous ack — SUBMISSION outcomes only (a true delivery
 *  failure is out-of-band and arrives hours later, when no tab is listening); everything downstream
 *  lands in `_InviteStatus` rows the members panel query-subscribes. */
export interface NodeInviteAck { accepted: number; errors: InviteeError[] }

/** How one node invite ended, once the facade answered: the addresses whose membership and grant
 *  now exist, and those the submission failed for, each with why. */
export interface NodeInviteOutcome { nodeId: string; sent: string[]; failed: InviteeError[] }

/**
 * The request-leg surface — the whole of what a host's `@mesh() get resources` hands the wire.
 * Each member derives what its caller may not state and applies the version rule before the op.
 * Built from closures over the plane, so no member and no property leads back to it: a
 * TypeScript `private` field would be walked like any other property.
 *
 * Every op on data the ontology types takes the version its page was built against, and runs only
 * at that version (ADR-024). The org tree, `subscribeTree` and every `unsubscribe` take none,
 * because nothing in them is typed by the ontology.
 */
export interface ResourcesRequests {
  /** Returns a stale version's `OntologyStaleError` as a VALUE, as it always has. */
  transaction(ontologyVersion: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult | OntologyStaleError> | OntologyStaleError;
  /** Throws a stale version's `OntologyStaleError`. */
  read(ontologyVersion: string, resourceId: string): Snapshot | null;
  /** Pushes a stale version's `OntologyStaleError` on the resource channel. */
  subscribe(ontologyVersion: string, resourceType: string, resourceId: string): void;
  unsubscribe(resourceType: string, resourceId: string): void;
  /** Pushes a stale version's `OntologyStaleError` on the query channel. */
  subscribeQuery(ontologyVersion: string, query: QueryDescriptor): void;
  unsubscribeQuery(queryHash: string): void;
  /** Pushes a stale version's `OntologyStaleError` on the roster channel. */
  subscribeQuerySubscribers(ontologyVersion: string, query: QueryDescriptor): void;
  unsubscribeQuerySubscribers(queryHash: string): void;
  /** Throws a stale version's `OntologyStaleError`. */
  invite(ontologyVersion: string, nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck>;
  /** The org tree, whose own methods check each op; a getter, so the chain reads `resources.orgTree.setPermission(…)`. */
  readonly orgTree: OrgTree;
  subscribeTree(): void;
  /**
   * Erase a `.dev` Star's test data, for a caller holding dominion over it: every Resource, node,
   * grant and subscription, and the installed ontology. It throws on any other host, and before
   * it changes anything. Memberships live in the Registry and survive, as does what the host
   * keeps outside the plane, a Star's config say. The app's source is the Galaxy's, so a wipe
   * destroys throwaway test data and never code; a breaking ontology edit is what it is for,
   * since stored snapshots are not migrated on `.dev`.
   */
  resetDevData(): void;
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

/**
 * How long a host waits on an ask whose answer has not arrived before it asks again. A Star's
 * Galaxy answers in tens of milliseconds, more when it starts cold, and a Client's retries span
 * under two seconds, so an answer this late is taken as lost.
 */
const ASK_BOUND_MS = 10_000;

/** How many live rows a version change on the `.dev` Star checks against the new validator. The
 *  count is a diagnostic, so past this it reports the cap rather than walking everything. */
const FAILING_ROW_CAP = 1_000;
const rowKey = (version: string) => `ontology:${version}`;

/**
 * Every table and storage key the plane's parts own, which a wipe drops before rebuilding them:
 * `OrgTree`'s three tables, `Snapshots`', and the one `Subscriptions` table with its migration
 * marker. The ontology keys go by their `ontology:` prefix. Anything a host keeps outside the
 * plane — the Star's `config` — survives, and so does mesh's identity, which is why the same call
 * can send straight after a wipe. One plane key survives too, `resources:latestMoment`, and must:
 * moments can run ahead of the clock, so only the stored key keeps a moment minted after a wipe
 * later than every moment a client saw before it. Listed in drop order: a table goes before the one it references,
 * since dropping `Nodes` under a `Snapshots` row that points at it fails its foreign key. A list and
 * not a derivation, so `plane-wipe.test.ts` reads every table from `sqlite_master` after a wipe and
 * matches the set exactly: a table a part adds reds it until someone decides whether it goes here.
 */
const PLANE_TABLES = ['Subscriptions', 'Snapshots', 'Permissions', 'Edges', 'Nodes'] as const;
const PLANE_KEYS = ['__sql_migrations_Subscriptions'] as const;

/**
 * The response-leg surface — the whole of what a host's `get resourcesResults` hands the answers
 * the plane asked for: the reapers a failed update names, the node invite's facade answer, and a
 * Star's ontology pull. Each arrives at the host's fire-back door, where the member-level check is
 * off, or runs locally when a target refuses at admission. Neither path checks for `@mesh()`, so
 * the gate has none. `@mesh()` would open every member to any caller
 * with passage, and `onOntologyPulled` is the one that matters: it checks no permission and installs
 * whatever row it is handed, so a caller could load a validator of their own on any Star it has
 * passage into. (`onInviteResult` is not the reason: a forged call runs under the
 * forger's own claims, and `setPermission` re-checks `admin` at the node.) Built from closures over
 * the plane, like {@link ResourcesRequests}.
 */
export interface ResourcesResults {
  /** The node invite's facade answer: writes the grants, then flips each `_InviteStatus` row. */
  onInviteResult(nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown): Promise<void>;
  /** A source's answer — a Star's `getCurrentOntology()` fire-back. Installs a row it has not. */
  onOntologyPulled(result?: unknown): void;
  /** The reapers: each drops the row of the tab its host node reports gone — the tab from
   *  `callContext.callee`, the fire-back's last hop, which that host node writes — if the row is no
   *  newer than `sentAt`, the time the failed push was sent. A re-subscribe that lands first keeps
   *  its row. */
  onBroadcastResult(resourceId: string, sentAt: string, result?: unknown): void;
  onQueryBroadcastResult(queryHash: string, sentAt: string, result?: unknown): void;
  onQuerySubscriberListBroadcastResult(queryHash: string, sentAt: string, result?: unknown): void;
  onTreeBroadcastResult(sentAt: string, result?: unknown): void;
  /** A push no subscriber row stands behind — a stale notice, a stream chunk, a refused
   *  subscribe's Error. Nothing is reaped, so a failed delivery is logged. */
  onPushUndelivered(what: string, result?: unknown): void;
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
  #onInviteOutcome: ((outcome: NodeInviteOutcome) => void | Promise<void>) | undefined;
  #seed: TreeSeed;
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
  // When this host last asked its source what is current and was told the answer would come
  // later (ISO 8601). While it is set and younger than ASK_BOUND_MS, an op that mismatches waits on
  // that ask instead of asking again. Every answer clears it. In memory by design: an eviction
  // mid-ask costs one extra ask.
  #askedAt: string | undefined;

  /** The request-leg surface — see {@link ResourcesRequests}. A host's `@mesh() get resources`
   *  returns it; the host never returns the plane. */
  readonly requests: ResourcesRequests;

  /** The response-leg surface — see {@link ResourcesResults}. A host's undecorated
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
   * @param options - `seed`: the nodes and grants this host declares, created with its tree
   *   ({@link TreeSeed}), and again after a wipe drops the tree's tables. `onInviteOutcome`: told
   *   how each node invite ended, once the facade has answered, so a host with somewhere to say
   *   so can tell the people it concerns. It runs under the inviter's claims, on the response
   *   leg, and its throw is logged and goes no further.
   */
  constructor(
    ctx: DurableObjectState,
    lmz: () => LmzApi,
    source: OntologySource,
    onCommitted?: (mutations: Map<string, Snapshot>) => void,
    options: { seed?: TreeSeed; onInviteOutcome?: (outcome: NodeInviteOutcome) => void | Promise<void> } = {},
  ) {
    this.#ctx = ctx;
    this.#lmz = lmz;
    this.#source = source;
    this.#onCommitted = onCommitted;
    this.#seed = options.seed ?? {};
    this.#onInviteOutcome = options.onInviteOutcome;
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
    this.#orgTree = new OrgTree(this.#ctx, getCallContext, () => this.#broadcastTree(), getHostName, this.#seed);
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
   * hears each failed delivery: a reaper that drops a target its host node reports gone, or, for a
   * push no subscriber row stands behind, `onPushUndelivered`, which logs it.
   */
  #send<T>(targets: BroadcastTarget[], remote: Continuation<T>, onResult: AnyContinuation): void {
    if (targets.length === 0) return;
    this.#lmz().broadcast(targets, remote, { onResult });
  }

  // ─── The request-leg surface ─────────────────────────────────────────

  /**
   * The caller's own address, derived from `callChain[0]`, which the client's server-side half
   * builds from its socket's verified attachment — `STAR/acme.crm.tenant1/alice.9f2c41aa` — so no
   * member takes it as an argument. Refuses a chain that no client originated: the address names a
   * client's rows, and nothing else has any.
   */
  #caller(): string {
    const origin = this.#lmz().callContext.callChain[0];
    if (origin?.type !== 'LumenizeClient' || !origin.instanceName) {
      throw new Error('Resources requests need a client origin: callChain[0] must be a LumenizeClient');
    }
    return addressOf(origin);
  }

  /**
   * One line per Client subscribe that reaches the host, refused or not, so a reader of the logs can
   * count how often a subscribe was sent and place it against the `installed` line.
   */
  #subscribeArrived(kind: 'resource' | 'query' | 'roster', topic: string, clientAddress: string, stale: OntologyStaleError | null): void {
    debug('nebula.Resources.subscribe').debug('arrived', {
      instanceName: this.#lmz().instanceName, kind, topic, clientAddress, stale: stale !== null,
    });
  }

  /**
   * Build {@link Resources.requests}: one closure per member, each over the plane's private
   * methods, so the object's only properties are its members.
   */
  #buildRequests(): ResourcesRequests {
    const tree = () => this.#orgTree;
    const tab = (address: string) => [splitAddress(address)];
    return {
      transaction: (ontologyVersion, ops) => {
        const clientAddress = this.#caller();
        return this.#gateClientOp(ontologyVersion) ?? this.#transaction(ontologyVersion, ops, clientAddress);
      },
      read: (ontologyVersion, resourceId) => {
        const stale = this.#gateClientOp(ontologyVersion);
        if (stale) throw stale;
        return this.doRead(resourceId);
      },
      subscribe: (ontologyVersion, resourceType, resourceId) => {
        const address = this.#caller();
        const stale = this.#gateClientOp(ontologyVersion);
        this.#subscribeArrived('resource', resourceId, address, stale);
        if (stale) {
          this.#send(tab(address), this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, stale),
            this.#ctn<ResourcesHost>().resourcesResults.onPushUndelivered('stale notice'));
          return;
        }
        this.doSubscribe(resourceType, resourceId, address);
      },
      unsubscribe: (resourceType, resourceId) => {
        void resourceType; // resource rows key on the id; the type lives on the snapshot
        this.removeSubscriber(resourceId, this.#caller());
      },
      subscribeQuery: (ontologyVersion, query) => {
        const address = this.#caller();
        const stale = this.#gateClientOp(ontologyVersion);
        this.#subscribeArrived('query', canonicalQueryHash(query), address, stale);
        if (stale) {
          this.#sendQueryUpdate(tab(address), canonicalQueryHash(query), stale);
          return;
        }
        this.doSubscribeQuery(query, address);
      },
      unsubscribeQuery: (queryHash) => this.removeQuerySubscriber(queryHash, this.#caller()),
      subscribeQuerySubscribers: (ontologyVersion, query) => {
        const address = this.#caller();
        const stale = this.#gateClientOp(ontologyVersion);
        this.#subscribeArrived('roster', canonicalQueryHash(query), address, stale);
        if (stale) {
          this.#sendRoster(tab(address), canonicalQueryHash(query), stale);
          return;
        }
        this.doSubscribeQuerySubscribers(query, address);
      },
      unsubscribeQuerySubscribers: (queryHash) =>
        this.removeQuerySubscriberListWatcher(queryHash, this.#caller()),
      invite: async (ontologyVersion, nodeId, invitees) => {
        const stale = this.#gateClientOp(ontologyVersion);
        if (stale) throw stale;
        return this.invite(nodeId, invitees);
      },
      get orgTree() { return tree(); },
      subscribeTree: () => {
        this.doSubscribeTree(this.#caller());
      },
      resetDevData: () => {
        requireDominionHere({ lmz: this.#lmz() });
        this.#notifyStale(this.#wipe(), '');
      },
    };
  }

  /**
   * Build {@link Resources.results}, the same way as `requests`. A reaper takes the dead tab's
   * address from `callContext.callee`, the fire-back's last hop, which the tab's server-side half
   * writes, and reaps only on that half's own `ClientDisconnectedError`: it renames a tab's Error
   * of that name.
   */
  #buildResults(): ResourcesResults {
    const gone = (result: unknown): string | undefined => {
      if (!(result instanceof Error)) return undefined;
      const callee = this.#lmz().callContext.callee;
      const clientAddress = callee?.instanceName ? addressOf(callee) : undefined;
      // Every reaper's receipt, so a run can see which tab an update failed to reach, and why.
      debug('nebula.Resources.reap').info('update not delivered', { clientAddress, name: result.name });
      return result.name === 'ClientDisconnectedError' ? clientAddress : undefined;
    };
    return {
      onInviteResult: (nodeId, tiers, result) => this.#onInviteResult(nodeId, tiers, result),
      onOntologyPulled: (result) => this.#onOntologyPulled(result),
      onBroadcastResult: (resourceId, sentAt, result) => {
        const clientAddress = gone(result);
        if (clientAddress) this.removeSubscriber(resourceId, clientAddress, sentAt);
      },
      onQueryBroadcastResult: (queryHash, sentAt, result) => {
        const clientAddress = gone(result);
        if (clientAddress) this.removeQuerySubscriber(queryHash, clientAddress, sentAt);
      },
      onQuerySubscriberListBroadcastResult: (queryHash, sentAt, result) => {
        const clientAddress = gone(result);
        if (clientAddress) this.removeQuerySubscriberListWatcher(queryHash, clientAddress, sentAt);
      },
      onTreeBroadcastResult: (sentAt, result) => {
        const clientAddress = gone(result);
        if (clientAddress) this.removeTreeSubscriber(clientAddress, sentAt);
      },
      onPushUndelivered: (what, result) => {
        if (!(result instanceof Error)) return;
        debug('nebula.Resources.push').warn(`${what} was not delivered`, {
          callee: this.#lmz().callContext.callee?.instanceName, error: result,
        });
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
   * once installs on first touch; one whose source answers later throws the `checking` stale,
   * which its ops never reach because the rule answered it first.
   */
  installedOntology(): InstalledOntology {
    if (!this.#installedVersion()) {
      const stale = this.#gateServer();
      if (stale) throw stale;
    }
    const { row, facet } = this.#ensureFacet();
    return { version: row.version, facet, relationships: row.relationships, fields: row.fields };
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
   * The version rule for a Client's op (ADR-024): `null` to proceed, or the error the op answers
   * with. The op runs only at the version its page was built against. A missing version is answered
   * stale without asking: the parameter is required in TypeScript, but mesh arguments are typed and
   * not checked on the wire, so a raw caller can still send none.
   */
  #gateClientOp(pinned: string): OntologyStaleError | null {
    const installed = this.#installedVersion();
    if (typeof pinned !== 'string' || pinned === '') return new OntologyStaleError('', installed);
    if (pinned === installed) return null;
    return this.#settle(pinned);
  }

  /** The version rule for the host's own work, which has no page: it runs at whatever is installed,
   *  and asks the source only when nothing is. */
  #gateServer(): OntologyStaleError | null {
    if (this.#installedVersion()) return null;
    return this.#settle(undefined);
  }

  /**
   * A mismatch, or nothing installed: ask the source what is current, unless an ask is already
   * waiting on its answer. `null` from the source means the row arrives by fire-back, so the op is
   * answered `checking` and the ask is remembered; a row that differs from what is installed is
   * installed, and a refused install answers stale. The op then proceeds if it pinned that row or
   * nothing, and is told stale otherwise.
   */
  #settle(pinned: string | undefined): OntologyStaleError | null {
    const installed = this.#installedVersion();
    if (this.#askPending()) return new OntologyStaleError(pinned ?? '', installed, { checking: true });
    // One marker per ask, stamped with the host, so a test can count asks.
    debug('nebula.Resources.source').debug('ask', { instanceName: this.#lmz().instanceName, pinned, installed });
    const row = this.#source.current();
    if (row === null) {
      this.#askedAt = new Date().toISOString();
      return new OntologyStaleError(pinned ?? '', installed, { checking: true });
    }
    if (row.version !== installed) {
      try {
        this.#install(row);
      } catch (err) {
        debug('nebula.Resources.ontology').warn('install refused', {
          version: row.version, error: err,
        });
        return new OntologyStaleError(pinned ?? '', installed);
      }
    }
    if (pinned === undefined || pinned === row.version) return null;
    return new OntologyStaleError(pinned, row.version);
  }

  /** Whether an ask is waiting on its answer. An ask older than {@link ASK_BOUND_MS} is forgotten,
   *  so an answer that never arrives costs one wait rather than a Star that never asks again. */
  #askPending(): boolean {
    if (this.#askedAt === undefined) return false;
    if (Date.parse(this.#askedAt) + ASK_BOUND_MS > Date.now()) return true;
    this.#askedAt = undefined;
    return false;
  }

  /**
   * Make `row` THE installed version, recorded in one write: a row installed while the record
   * named another is the drift that once made every op throw after an eviction. A row already
   * installed changes nothing. Replacing a version first drains what the change invalidates —
   * the resource, query and roster subscribers — and tells each client once, after the row is
   * recorded. A first install drains nothing. Installing never wipes: data a new version no
   * longer fits stays until a person resets it.
   */
  #install(row: OntologyVersionRow): void {
    const installed = this.#installedVersion();
    if (installed === row.version) return;
    const tell: DroppedAddress[] = installed ? this.#subscriptions.clear(['resource', 'query', 'roster']) : [];
    this.#ctx.storage.transactionSync(() => {
      const history = (this.#ctx.storage.kv.get<string[]>(INDEX_KEY) ?? []).filter((v) => v !== row.version);
      const prior = history.at(-1);
      if (prior) this.#ctx.storage.kv.delete(rowKey(prior));
      this.#ctx.storage.kv.put(rowKey(row.version), row);
      this.#ctx.storage.kv.put(INDEX_KEY, [...history, row.version]);
    });
    this.#row = null;
    this.#facet = null;
    this.#matchIndexes(row);
    this.#notifyStale(tell, row.version);
    debug('nebula.Resources.ontology').debug('installed', {
      instanceName: this.#lmz().instanceName, version: row.version, prior: installed,
    });
    if (installed && this.#isDevStar()) this.#countFailingRows(row.version);
  }

  /**
   * Make this host's query indexes exactly the ones `row` declares: create each it lacks, and drop
   * each query index the row does not declare. A wipe needs no drop of its own, since it drops the
   * `Snapshots` table and its indexes go with it. An index the engine refuses is logged and left
   * out, so one bad declaration cannot stop an install; the extractor refuses the same ones at
   * compile, so that is a row built by hand.
   */
  #matchIndexes(row: OntologyVersionRow): void {
    const log = debug('nebula.Resources.indexes');
    const instanceName = this.#lmz().instanceName;
    const wanted = new Map<string, string>();
    for (const spec of row.fields ? row.indexes ?? [] : []) {
      try {
        const index = compileIndex(row.fields!, spec);
        wanted.set(index.name, index.createSql);
      } catch (err) {
        log.error('index declaration refused', { instanceName, version: row.version, spec, error: err });
      }
    }
    const have = this.#ctx.storage.sql.exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND substr(name, 1, ?) = ?`,
      QUERY_INDEX_PREFIX.length, QUERY_INDEX_PREFIX,
    ).toArray().map((r) => r.name);
    const dropped = have.filter((name) => !wanted.has(name));
    for (const name of dropped) this.#ctx.storage.sql.exec(`DROP INDEX IF EXISTS "${name}"`);
    const created = [...wanted.keys()].filter((name) => !have.includes(name));
    for (const name of created) this.#ctx.storage.sql.exec(wanted.get(name)!);
    if (created.length > 0 || dropped.length > 0) {
      log.info('indexes matched to the installed version', { instanceName, version: row.version, created, dropped });
    }
  }

  /**
   * On the `.dev` Star, after a replacing install has committed, count the live rows the new
   * validator refuses and log the count, so a turn spent debugging correct code against old test
   * data can be diagnosed (installing never wipes). The validator is an RPC into the facet and the
   * install is synchronous, so the check runs detached, handed to `ctx.waitUntil`; a failure only
   * logs. Checks at most {@link FAILING_ROW_CAP} rows and says when it stopped there.
   */
  #countFailingRows(version: string): void {
    const log = debug('nebula.Resources.ontology');
    const instanceName = this.#lmz().instanceName;
    try {
      const rows = this.#snapshots.liveValues(FAILING_ROW_CAP + 1);
      const capped = rows.length > FAILING_ROW_CAP;
      const items = new Map(rows.slice(0, FAILING_ROW_CAP).map((r) => [r.resourceId, { value: r.value, typeName: r.typeName }]));
      const { facet } = this.#ensureFacet();
      this.#ctx.waitUntil(facet.parseBatch(items).then(
        (results) => {
          const failing = [...results.values()].filter((r) => !r.valid).length;
          log.info('rows failing the new version', { instanceName, version, failing, checked: items.size, cap: FAILING_ROW_CAP, capped });
        },
        (err) => log.warn('counting rows that fail the new version failed', { instanceName, version, error: err }),
      ));
    } catch (err) {
      log.warn('counting rows that fail the new version failed', { instanceName, version, error: err });
    }
  }

  /** Whether this host is a Galaxy's `.dev` Star: three segments, the last `dev`. A Galaxy whose
   *  slug is `dev` has two. */
  #isDevStar(): boolean {
    const segs = (this.#lmz().instanceName ?? '').split('.');
    return segs.length === 3 && segs[2] === 'dev';
  }

  /**
   * Where a source's fire-back lands — a Star's `getCurrentOntology()` answer, through
   * `results.onOntologyPulled`. Installs the row unless it is installed already. `null` (no row for this host) and an
   * Error install nothing, so a client's `checking` retries run out at the stale signal. Never
   * rethrows: a fire-back handler's throw vanishes.
   */
  #onOntologyPulled(result?: unknown): void {
    const log = debug('nebula.Resources.ontology');
    const instanceName = this.#lmz().instanceName;
    // Every answer ends the ask it answers, whatever it says.
    this.#askedAt = undefined;
    try {
      if (result instanceof Error) {
        log.warn('ontology pull failed', { instanceName, error: result });
        return;
      }
      const row = result as OntologyVersionRow | null;
      if (!row) {
        log.warn('ontology pull returned no row', { instanceName });
        return;
      }
      this.#install(row);
    } catch (err) {
      log.error('ontology pull handling failed', { error: err });
    }
  }

  /**
   * The wipe behind `requests.resetDevData`, which checks dominion over the host first and tells
   * every subscriber of every kind afterwards. It erases everything the plane owns and rebuilds
   * it, and records no ontology row, so the next op's install is a first install.
   * All synchronous, so no other event runs in between: refuse unless the host is a
   * `.dev` Star; write one ADR-016 record of the claims in context;
   * capture every subscriber to tell; drop every table and key the plane owns and rebuild its
   * parts, so a grant the wipe erased stops authorizing at once; and bump the generation, so a
   * transaction paused across it refuses to commit.
   */
  #wipe(): DroppedAddress[] {
    const host = this.#lmz().instanceName ?? '';
    if (!this.#isDevStar()) {
      throw new Error('A wipe is only permitted on the .dev sandbox Star');
    }
    const claims = this.#lmz().callContext.originAuth?.claims as AuthClaims | undefined;
    debug('nebula.Resources.wipe').info('wipe', {
      instanceName: host, cause: 'reset', recordedClaims: claims ? toRecordedClaims(claims) : null,
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
      targets.map((d) => (splitAddress(d.clientAddress))),
      this.#ctn<NebulaClient>().handleResourceUpdate('', '', new OntologyStaleError('', currentVersion, { notice: true })),
      this.#ctn<ResourcesHost>().resourcesResults.onPushUndelivered('stale notice'),
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
   * with the admin bit, so a collaborator can work in the preview; `four-party-chat` asserts it.
   * That is why only dominion invites into a Galaxy: the facade refuses an inviter without it,
   * though this method's own DAG gate admitted them, and the refusal arrives in the result
   * handler. Convergence: one `_InviteStatus` row per (email, node) — a re-invite
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
      // validation, `recordedClaims` attribution (the inviter, `act` chain included) and subscriber
      // fan-out all apply. Server-side write → no originating client to exclude ('').
      const ops: Record<string, OperationDescriptor> = {};
      for (const v of valid) {
        const existing = this.#findInviteStatus(nodeId, v.email);
        const value = { node: nodeId, email: v.email, tier: v.tier, state: 'pending' };
        if (existing) {
          ops[existing.resourceId] = { op: 'put', ifValidFromMatches: existing.meta.validFrom, value };
        } else {
          ops[crypto.randomUUID()] = { op: 'create', nodeId, typeName: '_InviteStatus', value };
        }
      }
      let written: TransactionResult;
      try {
        written = await this.doTransaction(ops, '');
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
        'AUTH_FACADE', undefined,
        this.#ctn<AuthFacade>().invite(lmz.instanceName!, valid.map(({ email }) => ({ email }))),
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
        // The whole submission failed, so every pending row flips: the facade refused it, or the
        // infrastructure failed. On a Galaxy the refusal has a producer: an inviter holding DAG
        // `admin` at the node and no dominion over the app, whom only the facade's rule stops,
        // since `requirePermission` at the door admitted them.
        await this.#flipInviteStatuses(nodeId, Object.keys(tiers).map((email) =>
          ({ email, state: 'submission-failed', error: result.message })));
        log.warn('node invite submission failed', { nodeId, error: result });
        await this.#onInviteOutcome?.({ nodeId, sent: [], failed: Object.keys(tiers).map((email) => ({ email, error: result.message })) });
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
      await this.#onInviteOutcome?.({ nodeId, sent: summary.results.map((r) => r.email), failed: summary.errors });
    } catch (err) {
      // Never rethrow — a fire-back handler's throw vanishes. Identifiers only.
      log.error('node invite result handling failed', {
        nodeId, error: err,
      });
    }
  }

  /** The CURRENT `_InviteStatus` row for (email, node), or null — the convergence lookup. */
  #findInviteStatus(nodeId: string, email: string): (Snapshot & { resourceId: string }) | null {
    for (const { resourceId } of this.findCurrent('_InviteStatus', { node: nodeId })) {
      const snapshot = this.doRead(resourceId);
      if (snapshot && (snapshot.value as { email?: string }).email === email) {
        return { ...snapshot, resourceId };
      }
    }
    return null;
  }

  /** Flip each (email, node) row's `state` (+ optional `error`), subscriber fan-out included.
   *  PER-ROW transactions, deliberately — the rows are independent, and one atomic batch would let
   *  a single stale version (a concurrent re-invite converging that address mid-flight) void the
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
      const written = await this.doTransaction({
        [existing.resourceId]: { op: 'put', ifValidFromMatches: existing.meta.validFrom, value },
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
    this.#send(targets, this.#ctn<NebulaClient>().handleStreamChunk(resourceId, progress, replyTo),
      this.#ctn<ResourcesHost>().resourcesResults.onPushUndelivered('stream chunk'));
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
      .map((r) => (splitAddress(r.clientAddress)));
  }

  /**
   * The addresses of the Clients subscribed to `query` under `sub`, in address order: one for each
   * tab that person has open on the query. A host reads it to call one of that person's tabs. On
   * no wire surface.
   */
  subscriberAddresses(query: QueryDescriptor, sub: string): string[] {
    return this.#subscriptions
      .forQuery(canonicalQueryHash(query))
      .filter((r) => r.sub === sub)
      .map((r) => r.clientAddress)
      .sort();
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
      .map((r) => (splitAddress(r.clientAddress)));
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
   *  drops a watcher its host node reports gone from the roster rows only, never the query rows,
   *  so a client that is also a data-subscriber of the query keeps that row. */
  #sendRoster(targets: BroadcastTarget[], queryHash: string, result: SubscriberEntry[] | Error): void {
    this.#send(targets, this.#ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, result),
      this.#ctn<ResourcesHost>().resourcesResults.onQuerySubscriberListBroadcastResult(queryHash, new Date().toISOString()));
  }

  /** Drop one resource subscription — `requests.unsubscribe` for the caller's own row, and the
   *  `results.onBroadcastResult` for a tab its host node reports gone, which passes `sentAt`. */
  removeSubscriber(resourceId: string, clientAddress: string, sentAt?: string): void {
    this.#subscriptions.removeResource(resourceId, clientAddress, sentAt);
  }

  /**
   * Register a WATCHER of `query`'s live subscriber-list roster (the standalone subscription — the watcher
   * is NOT a data-subscriber). Validates the query fail-closed (parity with `doSubscribeQuery`); on success
   * registers the watcher + delivers the CURRENT roster single-target to the joining watcher (its initial
   * snapshot). A watcher joining does NOT change roster content → no re-push to other watchers. Identity
   * (`clientAddress`) is derived by the `requests` door from `callChain`, never passed in.
   */
  doSubscribeQuerySubscribers(query: QueryDescriptor, clientAddress: string): void {
    const queryHash = canonicalQueryHash(query);
    try {
      this.#compile(query);
    } catch (err) {
      // Fail-closed: reject the watcher handle (Error keyed by queryHash) so a typo'd/malformed query
      // doesn't register a silent, permanently-empty watcher.
      debug('nebula.Resources.doSubscribeQuerySubscribers').warn('watcher query rejected', {
        queryHash, clientAddress, error: err,
      });
      this.#sendRoster([splitAddress(clientAddress)], queryHash,
        err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.#subscriptions.registerRoster(queryHash, clientAddress);
    debug('nebula.Resources.subscribers').debug('watch', { event: 'watch', queryHash, clientAddress });
    this.#sendRoster([splitAddress(clientAddress)], queryHash, this.#rosterFor(queryHash));
  }

  /** Drop one roster watcher — `unsubscribeQuerySubscribers` + `results`' DEDICATED
   *  roster reaper call this (the latter on a `ClientDisconnectedError`). Drops ONLY
   *  the roster row (never the client's query row) and does NOT re-fire `#broadcastRoster`. */
  removeQuerySubscriberListWatcher(queryHash: string, clientAddress: string, sentAt?: string): void {
    this.#subscriptions.removeRoster(queryHash, clientAddress, sentAt);
  }

  /** Drop one query-sub row — `unsubscribeQuery` + `results`' query reaper
   *  call this (the latter on a `ClientDisconnectedError`, m6). On an ACTUAL
   *  removal (`rowsWritten > 0`) re-push the shrunk roster to the query's WATCHERS; a no-op remove
   *  (duplicate/late fire-back) emits nothing — the mass-disconnect-storm guard. */
  removeQuerySubscriber(queryHash: string, clientAddress: string, sentAt?: string): void {
    const removed = this.#subscriptions.removeQuery(queryHash, clientAddress, sentAt);
    debug('nebula.Resources.subscribers').debug('remove', {
      event: 'remove', queryHash, clientAddress, mode: removed > 0 ? 'broadcast' : 'noop',
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
   * tree kind. The initial tree takes the same reaper as every later change, so a tab gone by then
   * loses its row at once.
   */
  doSubscribeTree(clientAddress: string): void {
    const state = this.#orgTree.getState();
    this.#subscriptions.registerTree(clientAddress);
    this.#send([splitAddress(clientAddress)],
      this.#ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }),
      this.#ctn<ResourcesHost>().resourcesResults.onTreeBroadcastResult(new Date().toISOString()));
  }

  /** Drop one tree subscriber — `results.onTreeBroadcastResult` calls this on a `ClientDisconnectedError`. */
  removeTreeSubscriber(clientAddress: string, sentAt?: string): void {
    this.#subscriptions.removeTree(clientAddress, sentAt);
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
    const targets = subscribers.map((t) => (splitAddress(t.clientAddress)));
    this.#send(targets, this.#ctn<NebulaClient>().handleOrgTreeUpdate({ value: state }),
      this.#ctn<ResourcesHost>().resourcesResults.onTreeBroadcastResult(new Date().toISOString()));
  }

  /**
   * Server-internal **create-if-absent**: write a resource only host code composes, with NO
   * client-facing result delivery. A live snapshot already present → no-op. A create fans out as
   * {@link doTransaction}'s post-commit hook does, with originator `''`; at a fresh id no tab
   * subscribes to the resource yet, so its subscribers hear it through the query rerun, which
   * takes no originator. Its callers are a Galaxy's agent reply and the `ServedBuild` a landing
   * records.
   *
   * It runs under the `callContext` it is called in, which stamps the subject, and takes the
   * ordinary path, with no special-casing: `Snapshots.transaction` →
   * `OrgTree.requirePermission`. So the Galaxy calls it as its local principal, whose grant on
   * the chat node admits the write. A write the transaction refuses throws, for want of the
   * permission or for a value its type rejects: nothing waits on this call's answer, so a
   * refusal returned as a value would be dropped unseen.
   */
  async ensureResource(
    resourceId: string, typeName: string, nodeId: string, value: Record<string, unknown>,
  ): Promise<void> {
    // Existence alone, with no permission check: a second ensure of the same id does nothing.
    if (this.#snapshots.currentTypeName(resourceId) !== undefined) return;
    debug('nebula.Resources.ensureResource').debug('creating', { resourceId, typeName });
    const { version, facet, fields } = this.installedOntology();
    const generation = this.#generation;
    const result = await this.#snapshots.transaction(
      { [resourceId]: { op: 'create', typeName, nodeId, value } },
      version, facet,
      {
        fields,
        onMutations: (mutations) => {
          this.#broadcast(mutations, '');
          this.#rerunQueriesForCommit(mutations);
          this.#onCommitted?.(mutations);
        },
        stillCurrent: () => this.#generation === generation,
      },
    );
    if (result.ok) return;
    const refusal = result.errors[resourceId];
    throw new Error(refusal?.type === 'permission'
      ? `ensureResource refused: ${refusal.requiredTier} permission required on node ${refusal.nodeId}`
      : `ensureResource refused: ${refusal?.type ?? 'unknown'} error creating a ${typeName}`);
  }

  // ─── Handler 2 (the actual op + delivery) ──────────────────────────

  /**
   * {@link doTransaction} for `requests.transaction`: a wipe that lands while it validates
   * refuses the commit, and the caller is answered stale, as a version change would be.
   */
  async #transaction(
    pinned: string, ops: Record<string, OperationDescriptor>, clientAddress: string,
  ): Promise<TransactionResult | OntologyStaleError> {
    try {
      return await this.doTransaction(ops, clientAddress);
    } catch (err) {
      if (err instanceof WipedMidTransactionError) return new OntologyStaleError(pinned, this.#installedVersion());
      throw err;
    }
  }

  /** Execute a transaction at the host's current ontology version + deliver the
   *  result. Committed mutations go out as updates to their subscribers (originator excluded).
   *  Takes no option naming a writer: a write records the claims its call carries. Throws
   *  `WipedMidTransactionError`, having written nothing, when a wipe lands while it validates. */
  async doTransaction(
    ops: Record<string, OperationDescriptor>,
    clientAddress: string,
  ): Promise<TransactionResult> {
    const generation = this.#generation;
    try {
      const { version, facet, fields } = this.installedOntology();
      // RETURN the result — the framework fires it back to the originating client's `callAsync`
      // (the return-value pattern). The committed-mutation broadcasts to OTHER subscribers stay a one-way
      // side effect (originator excluded via `clientAddress`). An infra throw propagates → `callAsync` rejects.
      return await this.#snapshots.transaction(ops, version, facet, {
        fields,
        onMutations: (mutations) => {
          // The single post-commit hook drives BOTH channels (Flow 2 + Flow 3 A):
          // single-resource content fanout, then the query rerun for touched types —
          // then the host's own post-commit observer (the codegen trigger's seam).
          this.#broadcast(mutations, clientAddress);
          this.#rerunQueriesForCommit(mutations);
          this.#onCommitted?.(mutations);
        },
        stillCurrent: () => this.#generation === generation,
      });
    } catch (err) {
      debug('nebula.Resources.doTransaction').error('handler threw', {
        clientAddress,
        error: err,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Run `fn` under the claims recorded on one snapshot, with `principal`, the host's local
   * principal, as actor (`lmz.actFor`). For a host acting on a person's stored request: the record
   * is the one the server stamped when that person wrote the resource, so the host names a
   * resource and never handles anyone's claims.
   *
   * The snapshot is named by its `validFrom`, as a write names the version it worked from. Host
   * code calls this in-process; it is on neither surface a host hands the wire.
   *
   * @throws ResourceMovedOnError before `fn` runs, when `validFrom` is not the resource's current
   *   one or the resource is deleted; and whatever `lmz.actFor` refuses, a local principal's own
   *   record among them.
   */
  actUnderClaimsOf<T>(resourceId: string, validFrom: string, principal: string, fn: () => T): T {
    const current = this.#snapshots.currentRecord(resourceId);
    if (!current || current.deleted || current.validFrom !== validFrom) {
      throw new ResourceMovedOnError(resourceId, validFrom, current && !current.deleted ? current.validFrom : undefined);
    }
    return this.#lmz().actFor(current.recordedClaims, principal, fn);
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
        error: err,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * The current resources of `typeName` that match `filter`, for host code that must converge on
   * an existing row before it writes: a node invite keeps one `_InviteStatus` row for each address
   * and node. It is a query's own evaluation, so it needs an index to look up as a query does.
   * Read-only, with no permission check of its own: the write that follows goes through
   * `doTransaction`'s ordinary checks, and a read of the values through `doRead`.
   */
  findCurrent(typeName: string, filter: Filter): Array<{ resourceId: string; nodeId: string }> {
    return this.#evaluateQuery({ typeName, filter }).matches;
  }

  /**
   * Register a resource subscriber and push what it may see: the current snapshot to a reader,
   * `{ deniedNodes: [nodeId] }` to one who cannot read it (ADR-008 — told, not refused), and an
   * Error for a refused subscribe ({@link Subscriptions.subscribeResource} says which refuse), which
   * is logged as a warning, since the caller's request is what it reports. The
   * first snapshot takes the same reaper as every later update, so a tab gone by then loses its row
   * at once.
   *
   * **Its guard is authentication plus the read evaluation this answer and every update run.** A
   * caller who cannot read still gets a row — that is the design, not a missing check.
   */
  doSubscribe(
    resourceType: string,
    resourceId: string,
    clientAddress: string,
  ): void {
    const tab = [splitAddress(clientAddress)];
    try {
      const outcome = this.#subscriptions.subscribeResource(resourceType, resourceId, clientAddress);
      if ('refused' in outcome) {
        // A warning, not an error: the caller asked for a row that is not there or not that type,
        // which it hears below, and an error line would raise a Workers Issue for it.
        debug('nebula.Resources.doSubscribe').warn('subscribe refused', {
          clientAddress, resourceType, resourceId, reason: outcome.refused,
        });
        this.#send(tab, this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, new Error(outcome.refused)),
          this.#ctn<ResourcesHost>().resourcesResults.onPushUndelivered('subscribe error'));
        return;
      }
      // Marker: one per registered resource subscribe, stamped with the client — the ask-again
      // test counts these to show a tree change re-subscribes only what was denied.
      debug('nebula.Resources.subscribers').debug('subscribe-resource', {
        event: 'subscribe-resource', resourceId, clientAddress, denied: 'deniedNodes' in outcome,
      });
      this.#send(tab, this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
        'deniedNodes' in outcome ? { deniedNodes: outcome.deniedNodes } : outcome.snapshot),
        this.#ctn<ResourcesHost>().resourcesResults.onBroadcastResult(resourceId, new Date().toISOString()));
    } catch (err) {
      debug('nebula.Resources.doSubscribe').error('handler threw', {
        clientAddress,
        resourceType,
        resourceId,
        error: err,
      });
      this.#send(tab, this.#ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
        err instanceof Error ? err : new Error(String(err))),
        this.#ctn<ResourcesHost>().resourcesResults.onPushUndelivered('subscribe error'));
    }
  }

  // ─── Query subscriptions ───────────────────────────────────────────

  /**
   * Register a query subscriber and push its first result.
   *
   * **Registration never fails for permissions.** The subscriber is told what it can read and
   * which nodes it cannot, update by update. A query is refused for what it is: a filter the engine
   * refuses, one no index can look up, or one more distinct query than its type may have live.
   * Nothing is registered for a refused query, and the refusal goes to the client under the
   * `queryHash` it computed, so its handle rejects.
   */
  doSubscribeQuery(query: QueryDescriptor, clientAddress: string): void {
    const log = debug('nebula.Resources.query');
    let queryHash = '';
    try {
      const compiled = this.#compile(query);
      queryHash = canonicalQueryHash(query);
      const live = this.#liveQueries();
      if (!live.has(queryHash) && [...live.values()].filter((each) => each.query.typeName === query.typeName).length >= MAX_LIVE_QUERIES_PER_TYPE) {
        throw new Error(
          `${query.typeName} already has ${MAX_LIVE_QUERIES_PER_TYPE} different live queries here, which is the most a type may have. ` +
          'Reuse a query another page already holds, or filter one of them further in the page');
      }
      if (compiled.scans) {
        log.info('query scans', { instanceName: this.#lmz().instanceName, typeName: query.typeName, queryHash, allowScan: query.allowScan === true });
      }
    } catch (err) {
      if (!queryHash) {
        try { queryHash = canonicalQueryHash(query); } catch { /* a descriptor too malformed to hash has no handle to reject */ }
      }
      log.warn('query rejected', { clientAddress, typeName: query?.typeName, queryHash, error: err });
      if (queryHash) {
        this.#sendQueryUpdate([splitAddress(clientAddress)], queryHash, err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    const { row, isNewSub } = this.#subscriptions.registerQuery(query, clientAddress);
    // The first push goes to the one new subscriber, as a single-resource subscribe pushes its
    // first snapshot rather than returning it.
    this.#broadcastQueries(query, [row]);
    // The roster goes to the query's watchers only when this `sub` was not among its subscribers
    // before. A reconnect or a second tab changes nothing a watcher sees, so it sends nothing.
    debug('nebula.Resources.subscribers').debug('subscribe', {
      event: 'subscribe', queryHash, clientAddress, mode: isNewSub ? 'broadcast' : 'noop',
    });
    if (isNewSub) this.#broadcastRoster(queryHash);
  }

  /**
   * Compile a query against the installed ontology and this host's indexes. Throws the engine's
   * refusal, or a plain one for a descriptor that is not a type and a filter, or for a row
   * compiled before queries took a filter.
   */
  #compile(query: QueryDescriptor): CompiledQuery {
    if (typeof query !== 'object' || query === null || typeof query.typeName !== 'string') {
      throw new Error('A query names a type and a filter: { typeName, filter }');
    }
    const { row } = this.#ensureFacetOrGate();
    if (!row.fields) {
      throw new Error('This app was built before queries could filter. Build it again, and its queries will run');
    }
    return compileQuery(row.fields, query.typeName, query.filter, row.indexes ?? [], { allowScan: query.allowScan === true });
  }

  /** The installed row, by the version rule's path when nothing is installed yet. */
  #ensureFacetOrGate(): { row: OntologyVersionRow } {
    this.installedOntology();
    return this.#ensureFacet();
  }

  /**
   * A query's current result, in the order of each resource's latest write, and whether it matched
   * more than {@link QUERY_RESULT_CAP}. This is the one place a query reads `Snapshots`.
   */
  #evaluateQuery(query: QueryDescriptor): { matches: Array<{ resourceId: string; nodeId: string }>; more: boolean } {
    const { where, params } = this.#compile(query);
    const rows = this.#ctx.storage.sql.exec<{ resourceId: string; nodeId: string }>(
      `SELECT resourceId, nodeId FROM Snapshots WHERE ${where} ORDER BY validFrom, resourceId LIMIT ${QUERY_RESULT_CAP + 1}`,
      ...params,
    ).toArray();
    return { matches: rows.slice(0, QUERY_RESULT_CAP), more: rows.length > QUERY_RESULT_CAP };
  }

  /**
   * Send a query's current result to `targets`: to the one new subscriber, or to every subscriber
   * of a query a commit touched. It evaluates each target's `read` on every result, then sends:
   *   - the targets who can read every result **one shared payload**, in one `lmz.broadcast`;
   *   - each other target **its own**: the ids it can read, and the nodes it cannot.
   * The client replaces its list on every push, so a push is idempotent and carries no delta.
   */
  #broadcastQueries(query: QueryDescriptor, targets: QuerySubscriberRow[]): void {
    if (targets.length === 0) return;
    const queryHash = canonicalQueryHash(query);
    const { matches, more } = this.#evaluateQuery(query); // ordered by (validFrom, resourceId)
    const flag = more ? { more: true as const } : {};
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
      // Has a denial, so its own payload: what it can read, and which nodes it cannot.
      const result: QueryUpdatePayload = {
        resourceIds: matches.filter((m) => allowed.has(m.nodeId)).map((m) => m.resourceId),
        deniedNodes: [...denied],
        ...flag,
      };
      this.#sendQueryUpdate([splitAddress(t.clientAddress)], queryHash, result);
    }

    if (noDenial.length > 0) {
      const noDenialTargets = noDenial.map((t) => (splitAddress(t.clientAddress)));
      this.#sendQueryUpdate(noDenialTargets, queryHash, { resourceIds: allResourceIds, ...flag });
    }
  }

  /** A query update — the membership, or an Error for a rejected query. Its reaper drops a
   *  query subscriber its host node reports gone, keyed by `queryHash`. */
  #sendQueryUpdate(targets: BroadcastTarget[], queryHash: string, result: QueryUpdatePayload | Error): void {
    this.#send(targets, this.#ctn<NebulaClient>().handleQueryUpdate(queryHash, result),
      this.#ctn<ResourcesHost>().resourcesResults.onQueryBroadcastResult(queryHash, new Date().toISOString()));
  }

  /** Every live query, by `queryHash`, with its subscribers. */
  #liveQueries(): Map<string, { query: QueryDescriptor; rows: QuerySubscriberRow[] }> {
    const groups = new Map<string, { query: QueryDescriptor; rows: QuerySubscriberRow[] }>();
    for (const row of this.#subscriptions.allQueries()) {
      let group = groups.get(row.queryHash);
      if (!group) {
        group = { query: parse(row.query) as QueryDescriptor, rows: [] };
        groups.set(row.queryHash, group);
      }
      group.rows.push(row);
    }
    return groups;
  }

  /**
   * After a commit, rerun each live query the commit touched, and no other.
   *
   * A written resource touches a query when its new snapshot matches the query's clause, or the
   * snapshot it replaced did: it entered the result, left it, or sits in it with a later write,
   * which moves its place in the order. Both are read in one statement, by the resource's key:
   * the new snapshot is the row whose `validFrom` is the commit's moment, and the one it replaced
   * is the row whose `validTo` is. A delete's new row is a tombstone holding the value it
   * replaced, so it answers as that row does.
   *
   * A permission change reruns nothing: a loss shows at the next update, and a client watching the
   * tree subscribes again to whatever it was denied.
   */
  #rerunQueriesForCommit(mutations: Map<string, Snapshot>): void {
    const written = new Map<string, Array<{ resourceId: string; moment: string }>>();
    for (const [resourceId, snapshot] of mutations) {
      const list = written.get(snapshot.meta.typeName) ?? [];
      list.push({ resourceId, moment: snapshot.meta.validFrom });
      written.set(snapshot.meta.typeName, list);
    }
    for (const { query, rows } of this.#liveQueries().values()) {
      const resources = written.get(query.typeName);
      if (resources && this.#touches(query, resources)) this.#broadcastQueries(query, rows);
    }
  }

  /** Whether any of `resources`, each written at `moment`, matches `query` now or did before. */
  #touches(query: QueryDescriptor, resources: Array<{ resourceId: string; moment: string }>): boolean {
    let clause: CompiledWhere;
    try {
      clause = compileWhere(this.#ensureFacet().row.fields ?? {}, query.typeName, query.filter);
    } catch (err) {
      // A query the installed version no longer compiles is dropped with its subscribers when that
      // version installs, so this is a query registered in the gap. Rerun it, and its subscribers
      // are sent the refusal.
      debug('nebula.Resources.query').warn('a live query no longer compiles', { typeName: query.typeName, error: err });
      return true;
    }
    // No conditions: every write of the type changes the result or its order.
    if (!clause.sql) return true;
    for (const { resourceId, moment } of resources) {
      const hit = this.#ctx.storage.sql.exec(
        `SELECT 1 FROM Snapshots WHERE resourceId = ? AND (validFrom = ? OR validTo = ?) AND ${clause.sql} LIMIT 1`,
        resourceId, moment, moment, ...clause.params,
      ).toArray();
      if (hit.length > 0) return true;
    }
    return false;
  }

  /**
   * Resource-mutation broadcast — invoked from `Snapshots.transaction` via the
   * `onMutations` callback after a successful commit. Looks up subscribers per
   * mutated resource, excludes the originator, and sends each what it may see, with the
   * resource reaper for a tab its host node reports gone.
   *
   * **Every subscriber is rechecked on every update, and told the result.** A reader gets the
   * committed snapshot. A subscriber who cannot read it gets `{ deniedNodes: [nodeId] }` — nothing
   * from the snapshot — and keeps its row (ADR-008: told, never silently dropped). The recheck is
   * an explicit-sub `evaluatePermissions` honoring the row's stored `dominionOverHostAtSubscribe`
   * (the `access.scopeAdmin` bypass), NOT the live caller's `requirePermission`: the update path
   * holds no token. There is no revocation window — a revoked grant is caught by the very next
   * update, and nothing is delivered in between.
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorAddress: string): void {
    const sentAt = new Date().toISOString();
    for (const [resourceId, snapshot] of mutations) {
      const readers: BroadcastTarget[] = [];
      const denied: BroadcastTarget[] = [];
      for (const row of this.#subscriptions.forResource(resourceId)) {
        if (row.clientAddress === originatorAddress) continue;
        const canRead = this.#orgTree.evaluatePermissions(
          [snapshot.meta.nodeId], 'read', row.sub, Boolean(row.dominionOverHostAtSubscribe),
        ).allowed.size > 0;
        (canRead ? readers : denied).push(splitAddress(row.clientAddress));
      }
      this.#send(readers,
        this.#ctn<NebulaClient>().handleResourceUpdate(snapshot.meta.typeName, resourceId, snapshot),
        this.#ctn<ResourcesHost>().resourcesResults.onBroadcastResult(resourceId, sentAt));
      this.#send(denied,
        this.#ctn<NebulaClient>().handleResourceUpdate(snapshot.meta.typeName, resourceId, { deniedNodes: [snapshot.meta.nodeId] }),
        this.#ctn<ResourcesHost>().resourcesResults.onBroadcastResult(resourceId, sentAt));
    }
  }
}

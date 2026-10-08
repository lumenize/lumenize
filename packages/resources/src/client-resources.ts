/**
 * ClientResources — the Client's half of the Resources plane, which a `NebulaClient` composes as a
 * node composes `Resources`.
 *
 * It holds what a Client does with resources: the `resources` and `orgTree` APIs an app calls, the
 * store the conflict-outcome engine writes through, and the state behind the host's pushes. The
 * pushes themselves arrive at `@mesh()`-decorated methods on `NebulaClient`, which forward here, so
 * nothing on this object is reachable from the wire.
 *
 * It talks through its Client: every call goes out on the Client's `lmz`, every result handler is
 * a continuation rooted at the Client, and the Client hands it three moments it cannot see itself —
 * each new token ({@link ClientResources.onClaimsChange}), each connection state
 * ({@link ClientResources.onConnectionStateChange}), and the host's report that subscriptions may be
 * gone ({@link ClientResources.onSubscriptionRequired}). The session itself (the token, the active
 * scope, logout, impersonation, profiles) is `MeshClient`'s.
 */

import { debug } from '@lumenize/debug';
import { awaitFirstPush, type ClientContinuation, type ConnectionState, type PendingPush } from '@lumenize/mesh/client';
import type { AuthClaims } from '@lumenize/mesh/client';
import { isOntologyStaleError, NoOntologyInstalledError } from './errors';
import {
  createConflictOutcomeEngine,
  type ConflictOutcomeEngine,
  type EngineOp,
  type ResourceHandler,
  type ServerBatchResponse,
  type ServerResourceResult,
  type Snapshot as EngineSnapshot,
  type TransactionOutcome,
  type TransactionResourceResolution,
} from './frontend/conflict-outcome';
import type { ConflictResolverVerdict } from './frontend/text-merge';
import type { QueueSubmission } from './frontend/debounce';
import type { OperationDescriptor as WireOp, TransactionResult, Snapshot } from './snapshots';
import type { QueryUpdatePayload, QueryDescriptor, SubscriberEntry, SubscriberRosterPayload } from './query-hash';
import { canonicalQueryHash } from './query-hash';
import type { OrgTreeState, PermissionTier } from './org-ops';
import type { NodeInvitee, NodeInviteAck, ResourcesRequests } from './resources';
// Type-only: the Client this composes into, whose forwarders every result handler is rooted at.
import type { NebulaClient } from './nebula-client';

const log = debug('lumenize.nebula-client');

// The conflict-outcome engine (`./frontend/conflict-outcome`) owns the resolution vocabulary.
// ClientResources instantiates it, injects a store adapter (the factory swaps in a Vue-reactive
// one), and re-exports its types as the public surface. api-reference.md is the contract.
export type { TransactionOutcome, TransactionResourceResolution, ResourceHandler, ConflictResolverVerdict };

/**
 * The surface every node that hosts this client's Resources serves, whatever its class: a Star, a
 * Galaxy or a Universe answers `resources` the same way through its one `@mesh()`-decorated getter.
 */
interface ResourcesHostNode {
  readonly resources: ResourcesRequests;
}
/**
 * Public operation descriptor (the engine op shape): `typeName` on every op;
 * `eTag` optional (auto-derived from the local store when omitted — the
 * subset still required by the server is supplied at submit time). The *wire*
 * op (`./resources`) omits `typeName` on put/move/delete — the server reads it
 * from the current snapshot — so `#buildMeshOps` strips it on the way out.
 */
export type OperationDescriptor = EngineOp;

/**
 * A `using`-compatible subscription handle returned by
 * {@link NebulaClient.resources.subscribe}. `snapshot` resolves on the first server answer for
 * `(rt, rid)` (later updates write through to bound state but do not re-resolve it).
 * `[Symbol.dispose]()` is per-handle (idempotent); the server-side subscription releases when the
 * **last** handle for `(rt, rid)` disposes (refcounted — mirrors the factory's auto-subscribe).
 * api-reference § client.resources.subscribe is the contract.
 *
 * **A subscriber who cannot read the resource is told, not refused** (ADR-008). Its `snapshot`
 * resolves `null` and never rejects for permission, and `deniedNodes` names the node it cannot read
 * the resource under. The subscription stays live: a later update says whether access came back.
 */
export interface ResourceSubscription extends Disposable {
  /** The first answer: the snapshot, or `null` for a resource this subscriber cannot read (see
   *  {@link deniedNodes}). Rejects for a refused subscribe — a missing resource, a wrong type. */
  readonly snapshot: Promise<Snapshot | null>;
  /** The node this subscriber cannot read the resource under — `[]` when it can, never undefined. */
  readonly deniedNodes: string[];
  /** Register a callback fired when access is lost or gained. */
  onChange(cb: () => void): void;
}

/** The update a resource subscriber gets instead of the snapshot when it cannot read it — the node,
 *  and nothing from the snapshot. */
export interface ResourceDenied {
  deniedNodes: string[];
}

function isResourceDenied(result: unknown): result is ResourceDenied {
  return typeof result === 'object' && result !== null && !(result instanceof Error)
    && Array.isArray((result as { deniedNodes?: unknown }).deniedNodes) && !('meta' in result);
}

/**
 * One resource's entry in the reactive store, at `store.resources[typeName][resourceId]`, written by
 * the subscription that holds it. A subscriber who cannot read the resource has `deniedNodes` naming
 * the node and no `value` or `meta` — the entry keeps nothing it can no longer read, and with no
 * `meta.eTag` a `v-model` write to it submits nothing.
 */
export interface ResourceStoreEntry {
  /** The resource's value; absent while denied. */
  value?: unknown;
  /** The snapshot's metadata; absent while denied, so `meta.eTag` is too. */
  meta?: Snapshot['meta'];
  /** The node this subscriber cannot read the resource under — `[]` when it can. */
  deniedNodes: string[];
}

const sameNodes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/** Options for {@link NebulaClient.resources.subscribeQuery}. */
export interface SubscribeQueryOptions {
  /** Grace before a per-resource content sub is released after its id leaves the
   *  rendered window (default 2000 ms — matches the factory's binding grace). An id
   *  that leaves and returns within this window keeps its live content sub
   *  (flicker-free on membership churn / scroll bounce). */
  renderGraceMs?: number;
}

/**
 * A `using`-compatible query-subscription handle returned by
 * {@link NebulaClient.resources.subscribeQuery}. The membership
 * (`resourceIds`, ordered) is REPLACED on every push (idempotent, self-healing —
 * no delta merge). `subscribeQuery` is one-way (the client computes the
 * canonical `queryHash` LOCALLY and correlates pushes by it — ADR-003), so the
 * initial state arrives asynchronously; `ready` resolves on the first push.
 *
 * Content is NOT carried on this channel — call {@link setRenderWindow} with the
 * ids you're rendering to lazily per-resource-subscribe them (refcounted, shares
 * rows with direct `subscribe`). `[Symbol.dispose]()` is per-handle; the server
 * `unsubscribeQuery` fires when the LAST handle releases.
 */
export interface QuerySubscription extends Disposable {
  /** Resolves on the first membership push; rejects if the query is rejected. */
  readonly ready: Promise<void>;
  /** Current ordered membership — the resource ids the subscriber may read. */
  readonly resourceIds: string[];
  /** Denied node ids (for the request-access UI). */
  readonly deniedNodes: string[];
  /** Set the rendered window — content subs open for exactly these ids (∩ current
   *  membership); ids that leave are released after the grace period. */
  setRenderWindow(resourceIds: string[]): void;
  /** Register a callback fired on every membership/denied change. */
  onChange(cb: () => void): void;
}

/**
 * A `using`-compatible handle for a subscriber-LIST watcher subscription (the STANDALONE
 * `subscribeQuerySubscribers`). `ready` resolves on the first roster push (rejects if the query is
 * rejected fail-closed). `[Symbol.dispose]()` releases `unsubscribeQuerySubscribers` on the last handle
 * (refcounted). The roster itself lands in `store.lmz.querySubscribers.*` via the factory listener, NOT
 * on this handle. tasks/nebula-subscriber-lists.md.
 */
export interface SubscriberListSubscription extends Disposable {
  readonly ready: Promise<void>;
}

/** A roster delivery to the factory listener — carries the `query` so the factory computes the
 *  query-in-path store path (`store.lmz.querySubscribers.<typeName>.<field>[value]`). */
export interface SubscriberRosterDelivery {
  queryHash: string;
  query: QueryDescriptor;
  roster: SubscriberEntry[];
}

/** Internal per-watcher state, keyed by canonical `queryHash` (refcounted across handles). */
interface QuerySubscriberEntry {
  query: QueryDescriptor;
  refcount: number;
  ready: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void; settled: boolean };
}

/** Internal per-query state shared across handles of the same canonical query. */
interface QueryEntry {
  query: QueryDescriptor;
  resourceIds: string[];
  deniedNodes: string[];
  refcount: number;
  ready: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void; settled: boolean };
  /** Ids the consumer asked to render; effective window = this ∩ resourceIds. */
  desiredWindow: Set<string>;
  /** Live per-resource content subs (incl. those in their grace window pending dispose). */
  windowSubs: Map<string, { sub: ResourceSubscription; graceTimer?: ReturnType<typeof setTimeout> }>;
  renderGraceMs: number;
  listeners: Set<() => void>;
}

export interface OntologyStaleInfo {
  reason: 'ontology-stale';
  clientVersion: string;
  currentVersion: string;
}

/**
 * Per-call options for `client.resources.transaction()`. The transaction-wide
 * `TransactionOutcome` it resolves with + the per-resource
 * `TransactionResourceResolution`s delivered to handlers are the
 * conflict-outcome engine's vocabulary (re-exported above; api-reference is the
 * contract).
 */
export interface TransactionOptions {
  /** Override the constructor's `ontologyVersion` for this call (admin/scripting only). */
  ontologyVersion?: string;
  /**
   * Per-call resolution handlers, **keyed by `resourceId`** (api-reference
   * § onTransactionResourceResolution). A listed resource's handler layers in
   * front of its per-type handler; resources absent from the map fall through
   * to their per-type handler automatically (no defensive `rid` filtering).
   */
  onTransactionResourceResolution?: Record<string, ResourceHandler>;
  /**
   * Per-call override for the max recursive `'use-this'` retries before
   * `'retries-exhausted'`. Falls back to the per-type value, then 5.
   */
  maxRetries?: number;
}

/** Per-call options for `client.resources.read()`. */
export interface ReadOptions {
  /** Override the constructor's `ontologyVersion` for this call. */
  ontologyVersion?: string;
}

/** Bounded retry for an `installing` OntologyStaleError — the host fired a registry
 *  lazy-pull inside the refused op's call context; the install typically lands within a
 *  round trip, so a few short retries cover it without masking a genuinely stale client. */
const INSTALLING_RETRY_LIMIT = 4;
const INSTALLING_RETRY_DELAY_MS = 400;

/** True for the answer a host gives while it installs its ontology — a retry lands it. */
function isInstalling(result: unknown): boolean {
  return isOntologyStaleError(result) && result.installing === true;
}

type SubscribeKey = string; // `${resourceType}:${resourceId}`

type PendingSubscribe = PendingPush<Snapshot | null>;

/**
 * The store-effect seam the conflict-outcome engine drives. The factory
 * (`@lumenize/resources/frontend`) injects a Vue-reactive implementation via
 * {@link NebulaClient.bindStore}; headless NebulaClient (Node tests, admin
 * scripting) uses the default in-memory one so transactions resolve without a
 * UI store. All effects are keyed by `(resourceType, resourceId)`; the
 * `resourceType` IS the resource's `typeName` (the store path is
 * `resources.{typeName}.{rid}`).
 */
export interface NebulaStoreAdapter {
  /** Current (optimistic) value + baseline eTag the engine submits against. */
  readResource(rt: string, rid: string): { value: unknown; eTag?: string };
  /** Conflict `use-server`: adopt the server snapshot's value + meta. */
  applyServer(rt: string, rid: string, snapshot: Snapshot): void;
  /** Commit: advance the cached `meta.eTag`. */
  applyCommit(rt: string, rid: string, eTag: string): void;
  /** Terminal failure: restore the pre-write value (`undefined` removes a
   *  rolled-back optimistic create). */
  rollbackTo(rt: string, rid: string, value: unknown): void;
  /** Broadcast push (held mid-edit by the engine): write the snapshot through. */
  applyFanout(rt: string, rid: string, snapshot: Snapshot): void;
  /** A subscription's read access: write `deniedNodes` to the entry (`[]` when readable). On a loss
   *  the entry drops its `value` and its `meta`, so with no `meta.eTag` no edit can submit against it. */
  applyDenied(rt: string, rid: string, deniedNodes: string[]): void;
  /** `use-this`: paint the merged verdict value (a fresh optimistic write). */
  applyResolvedValue(rt: string, rid: string, value: unknown): void;
  /** Explicit-transaction op value + baseline eTag (create/put paint). */
  applyOptimistic(rt: string, rid: string, value: unknown, eTag: string): void;
  /** Default flash class (DOM in v4; no-op headless). */
  flash(rt: string, rid: string, cssClass: string): void;
}

/**
 * Default in-memory store adapter for headless NebulaClient (no UI store). Holds
 * the optimistic resource state so the engine's reads/commits/rollbacks have
 * somewhere to land. The factory replaces this with a Vue-reactive adapter.
 */
function createInMemoryStoreAdapter(): NebulaStoreAdapter {
  const m = new Map<string, { value: unknown; eTag?: string }>();
  const k = (rt: string, rid: string) => `${rt}:${rid}`;
  const upsertValue = (rt: string, rid: string, value: unknown) => {
    const e = m.get(k(rt, rid));
    if (e) e.value = value;
    else m.set(k(rt, rid), { value });
  };
  return {
    readResource: (rt, rid) => m.get(k(rt, rid)) ?? { value: undefined, eTag: undefined },
    applyServer: (rt, rid, snap) => m.set(k(rt, rid), { value: snap.value, eTag: snap.meta.eTag }),
    applyFanout: (rt, rid, snap) => m.set(k(rt, rid), { value: snap.value, eTag: snap.meta.eTag }),
    applyDenied: (rt, rid, deniedNodes) => {
      if (deniedNodes.length > 0) m.delete(k(rt, rid));
    },
    applyCommit: (rt, rid, eTag) => {
      const e = m.get(k(rt, rid));
      if (e) e.eTag = eTag;
    },
    rollbackTo: (rt, rid, value) => {
      if (value === undefined) m.delete(k(rt, rid));
      else upsertValue(rt, rid, value);
    },
    applyResolvedValue: (rt, rid, value) => upsertValue(rt, rid, value),
    applyOptimistic: (rt, rid, value, eTag) => m.set(k(rt, rid), { value, eTag }),
    flash: () => {},
  };
}

/** What a {@link ClientResources} is built with: the parts of `NebulaClientConfig` that are its own. */
export interface ClientResourcesOptions {
  /** The app version every resource op pins; absent until an ontology is applied. */
  ontologyVersion?: string;
  /** The binding hosting this Client's Resources, `STAR` by default. */
  resourceHostBinding?: string;
  /** How long a subscribe waits for its first push; Mesh's default when absent. */
  subscribeTimeoutMs?: number;
  /** Told when the host says this Client's ontology version is stale. */
  onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
}

/**
 * The Client's half of the Resources plane. Built by `NebulaClient`, which hands it the Client it
 * talks through; see the module header for what it holds and what the Client hands it.
 */
export class ClientResources {
  readonly #client: NebulaClient;
  /** Absent when no ontology has been applied — see `NebulaClientConfig.ontologyVersion`. */
  #ontologyVersion?: string;
  /** Binding hosting this client's Resources (default 'STAR'; the resource pair). */
  #resourceHostBinding: string;
  /** Retries used per subscribe channel (`resource:`, `query:` or `roster:` plus its key) while a
   *  host installs its ontology — see {@link #retryInstalling}. */
  #installingAttempts = new Map<string, number>();
  /** Ceiling on a subscribe's wait for its first push; Mesh's default when absent. */
  #subscribeTimeoutMs?: number;
  #onShouldRefreshUI?: (info: OntologyStaleInfo) => void;

  /** Store adapter the conflict-outcome engine drives; the factory swaps in a
   *  Vue-reactive one via {@link bindStore}, headless uses the in-memory
   *  default. */
  #storeAdapter: NebulaStoreAdapter = createInMemoryStoreAdapter();

  /** Conflict-outcome engine (debounce queue + resolution). */
  #engine: ConflictOutcomeEngine;

  /** Whether the Client has connected before, so the connection-state hook can tell a first
   *  connection from every later one. */
  #connectedBefore = false;

  /** The last token's `access.scopeAdmin`. A change under the same `sub` restores every
   *  subscription, since a host decided what each one may see by the old verdict. */
  #lastScopeAdmin: boolean | undefined;
  /** Set when that verdict changed; the next reconnect restores every subscription. */
  #scopeAdminChanged = false;
  /** Set by `onSubscriptionRequired` on this connection, so the reconnect handler that runs just
   *  after it does not send the same subscribes again. Cleared whenever the state leaves `connected`. */
  #restoredOnThisConnection = false;
  /** The org tree's subscribe went out and its first snapshot has not arrived. */
  #treeSnapshotAwaited = false;

  /**
   * Runtime connection-state listener registered by the factory — it mirrors state into
   * `store.lmz.connection.*`. Single-handler; a later call replaces it.
   */
  #connectionStateListener: ((state: ConnectionState) => void) | null = null;

  /**
   * Runtime org-tree listener registered by the factory — it mirrors the tree state into
   * `store.lmz.orgTree.value`. Single-handler; a later call replaces it. Fed by the
   * `handleOrgTreeUpdate` push (initial `subscribeTree` snapshot + every tree-change broadcast).
   */
  #orgTreeListener: ((state: OrgTreeState) => void) | null = null;

  /**
   * Active subscriptions registry. Used by the re-subscribe walk when the host node reports a loss
   * or the admin verdict changes, and by refcount-with-grace. The entry is minimal — just enough to
   * know what's subscribed.
   */
  #subscriptionRegistry = new Map<SubscribeKey, { resourceType: string; resourceId: string }>();

  /**
   * Per-`(rt, rid)` subscription-handle refcount. Both `using` handles from
   * `resources.subscribe(...)` and the factory's auto-subscribe (one held handle
   * per component-bound resource) increment it; each `[Symbol.dispose]()` /
   * standalone `unsubscribe` decrements. The server-side `Star.resources.unsubscribe`
   * fires only when the count reaches zero (the last interested party released),
   * so component bindings and explicit handles both keep the subscription open.
   */
  #subscribeRefcount = new Map<SubscribeKey, number>();
  /**
   * Per-`(rt, rid)` read-access state, shared by every handle of the resource: the nodes this
   * client cannot read it under (`[]` when it can) and the `onChange` listeners. Created with the
   * first handle, dropped with the last; `answered` is false until the first server answer.
   */
  #resourceAccess = new Map<SubscribeKey, { deniedNodes: string[]; answered: boolean; listeners: Set<() => void> }>();

  /**
   * In-flight `subscribe(rt, rid)` Promises awaiting their first
   * `handleResourceUpdate`. Settled (resolved on snapshot, rejected on Error)
   * on the first matching update, then cleared. Subsequent updates are
   * pure side-effect (state write-through only).
   */
  #pendingSubscribes = new Map<SubscribeKey, PendingSubscribe>();

  /**
   * Active query subscriptions, keyed by the locally-computed canonical
   * `queryHash`. Shared across handles of the same query (refcounted). Each entry
   * holds the membership set, the windowed per-resource content subs, and the
   * grace timers — see {@link QueryEntry}.
   */
  #queryEntries = new Map<string, QueryEntry>();

  /**
   * Active STANDALONE subscriber-list watcher subscriptions, keyed by canonical `queryHash` (refcounted,
   * reconnect-walked). Delivered rosters flow to `#querySubscribersListener` (the factory) → the store.
   */
  #querySubscriberEntries = new Map<string, QuerySubscriberEntry>();
  /** Factory listener that mirrors each roster into `store.lmz.querySubscribers.*`. Single-handler. */
  #querySubscribersListener: ((delivery: SubscriberRosterDelivery) => void) | null = null;

  /**
   * Ephemeral assistant-progress streams, keyed by `assistantMessageId`.
   * Accumulates the transient `handleStreamChunk` pushes for the
   * in-flight reply — a **deliberate ephemeral cache** (client-side, not a DO, so
   * mutable instance state is fine): loss on reload/disconnect just drops the live
   * animation; the durable `Message` arrives via the query sub regardless. Reconciled
   * (dropped) when the durable Message lands in `handleResourceUpdate` — so the UI
   * renders the durable content, never a duplicate. No pending-Promise dependency.
   */
  #streamingMessages = new Map<string, string>();
  /** `replyTo` is the id of the USER message whose turn is streaming — the chunk rides a
   *  broadcast to the whole chat, so a consumer must compare it against its own last post
   *  before reading the chunk as liveness for its own turn. */
  #onStreamChunk?: (messageId: string, progress: string, replyTo?: string) => void;

  constructor(client: NebulaClient, options: ClientResourcesOptions = {}) {
    this.#client = client;
    this.#ontologyVersion = options.ontologyVersion;
    this.#resourceHostBinding = options.resourceHostBinding ?? 'STAR';
    this.#subscribeTimeoutMs = options.subscribeTimeoutMs;
    this.#onShouldRefreshUI = options.onShouldRefreshUI;
    // The engine over the store adapter and the mesh submit. Store effects delegate to
    // `#storeAdapter`, read fresh each call so `bindStore` can swap it. The engine's structural
    // `Snapshot` ({ value, meta.eTag }) is satisfied at runtime by the real wire snapshots it
    // forwards, so the adapter casts recover the meta.
    this.#engine = createConflictOutcomeEngine({
      submitBatch: (subs) => this.#meshSubmit(subs),
      readResource: (rt, rid) => this.#storeAdapter.readResource(rt, rid),
      applyServer: (rt, rid, snap) => this.#storeAdapter.applyServer(rt, rid, snap as unknown as Snapshot),
      applyFanout: (rt, rid, snap) => this.#storeAdapter.applyFanout(rt, rid, snap as unknown as Snapshot),
      applyCommit: (rt, rid, eTag) => this.#storeAdapter.applyCommit(rt, rid, eTag),
      rollbackTo: (rt, rid, value) => this.#storeAdapter.rollbackTo(rt, rid, value),
      applyResolvedValue: (rt, rid, value) => this.#storeAdapter.applyResolvedValue(rt, rid, value),
      applyOptimistic: (rt, rid, value, eTag) => this.#storeAdapter.applyOptimistic(rt, rid, value, eTag),
      flash: (rt, rid, cls) => this.#storeAdapter.flash(rt, rid, cls),
      onShouldRefreshUI: (info) => this.#dispatchOntologyStale(info.clientVersion, info.currentVersion),
    });
  }

  /** The binding hosting these Resources, `STAR` unless the config named another. */
  get resourceHostBinding(): string {
    return this.#resourceHostBinding;
  }

  /** The app version every resource op pins, or `undefined` before an ontology is applied. */
  get ontologyVersion(): string | undefined {
    return this.#ontologyVersion;
  }

  // ─── What the Client hands over ───────────────────────────────────────────

  /**
   * Every connection state the Client passes through. Each connection after the first restores
   * only what may be missing: a subscribe whose first snapshot has not arrived, or everything when
   * the token's admin verdict changed. That covers a reconnect and an explicit `disconnect()` then
   * `connect()` alike. Everything else comes from {@link onSubscriptionRequired}, which the host
   * node's report triggers and which runs just after this on the same connection, hence the
   * microtask. An in-flight transaction recovers on its own: its `callAsync` Promise survives the
   * drop and its answer re-resolves to the new socket.
   */
  onConnectionStateChange(state: ConnectionState): void {
    if (state !== 'connected') this.#restoredOnThisConnection = false;
    if (state === 'connected') {
      if (this.#connectedBefore) queueMicrotask(() => this.#afterReconnect());
      this.#connectedBefore = true;
    }
    // Gate the engine's submission queue: not-'connected' suspends flush + timers (a blip never
    // rolls back); 'connected' replays held and in-flight work.
    this.#engine.setConnectionState(state);
    // The factory's listener mirrors state into store.lmz.connection.* (it also replays the
    // current state once at creation, so factory and connect ordering do not matter).
    this.#connectionStateListener?.(state);
  }

  /**
   * The host node says this Client's subscriptions may be gone — a first connection, or a reconnect
   * after a delivery to it failed or past the grace period — so every live one is sent again.
   */
  onSubscriptionRequired(): void {
    this.#restoredOnThisConnection = true;
    this.#scopeAdminChanged = false;
    this.#restoreSubscriptions();
  }

  /**
   * A new token. A changed `access.scopeAdmin` under the same `sub` means a host decided what each
   * subscription may see by the old verdict, so the next reconnect restores them all; the socket
   * that reconnect opens carries the new token. A changed `sub` needs nothing here: the Client
   * reconnects under a new id, which its host node has no record of, so it reports
   * `subscriptionRequired: true`.
   */
  onClaimsChange(): void {
    const claims = this.#client.claims as Readonly<AuthClaims> | null;
    if (!claims) return;
    const verdict = claims.access?.scopeAdmin === true;
    if (this.#lastScopeAdmin !== undefined && verdict !== this.#lastScopeAdmin) this.#scopeAdminChanged = true;
    this.#lastScopeAdmin = verdict;
  }

  /**
   * Settle the engine: flush pending debounced writes and every open submission. Nothing submits
   * after this resolves. `NebulaClient.dispose()` calls it before disconnecting.
   */
  async dispose(): Promise<void> {
    await this.#engine.dispose();
  }

  /**
   * A one-way call to this page's resource host; one made before the first token waits for it.
   * Every one is a subscribe or an unsubscribe, so `onRefused` hears only an Error: a subscribe's
   * goes to the push handler a host-reported error uses, and an unsubscribe's is logged.
   */
  #hostCall(remote: unknown, onRefused: ClientContinuation<any>): void {
    const scope = this.#client.activeScope;
    if (scope !== undefined) {
      this.#client.lmz.call(this.#resourceHostBinding, scope, remote as never, onRefused, { onErrorOnly: true });
      return;
    }
    void this.#client.activeScopeKnown.then((known) =>
      this.#client.lmz.call(this.#resourceHostBinding, known, remote as never, onRefused, { onErrorOnly: true }));
  }

  // A subscribe's result handlers, each sent `onErrorOnly` and reached through the Client's
  // forwarder of the same name. A refusal goes to the push handler a host-reported error uses, so
  // the pending subscribe rejects at once and its entry unwinds. An unsubscribe's refusal goes to
  // the Client's `logRefusal`.

  onResourceSubscribeRefused(resourceType: string, resourceId: string, result?: unknown): void {
    if (result instanceof Error) this.handleResourceUpdate(resourceType, resourceId, result);
  }

  onQuerySubscribeRefused(queryHash: string, result?: unknown): void {
    if (result instanceof Error) this.handleQueryUpdate(queryHash, result);
  }

  onRosterSubscribeRefused(queryHash: string, result?: unknown): void {
    if (result instanceof Error) this.handleQuerySubscribersUpdate(queryHash, result);
  }

  /** {@link #hostCall}, awaiting the answer. */
  async #hostCallAsync<T = any>(remote: unknown): Promise<T> {
    const scope = this.#client.activeScope ?? await this.#client.activeScopeKnown;
    return this.#client.lmz.callAsync<T>(this.#resourceHostBinding, scope, remote as never);
  }

  /**
   * Inject the UI store the engine writes through — the factory's Vue-reactive
   * adapter, replacing the headless in-memory default. Call once before the
   * first transaction. The engine reads `#storeAdapter` fresh on every effect,
   * so swapping the field suffices (no engine rebuild).
   */
  bindStore(adapter: NebulaStoreAdapter): void {
    this.#storeAdapter = adapter;
  }

  /**
   * The factory's connection-state listener, which mirrors state into `store.lmz.connection.*`.
   * Single-handler; a later call replaces it.
   */
  setConnectionStateListener(handler: ((state: ConnectionState) => void) | null): void {
    this.#connectionStateListener = handler;
  }

  /**
   * The factory's org-tree listener, which mirrors the tree into `store.lmz.orgTree.value`.
   * Single-handler; a later call replaces it. Registering one also opts this Client into
   * subscribing the tree on every restore.
   */
  setOrgTreeListener(handler: ((state: OrgTreeState) => void) | null): void {
    this.#orgTreeListener = handler;
  }

  /**
   * The factory's roster listener, which mirrors each roster into the query-in-path store surface
   * `store.lmz.querySubscribers.<typeName>.<field>[value]`. Single-handler; a later call replaces it.
   */
  setQuerySubscribersListener(handler: ((delivery: SubscriberRosterDelivery) => void) | null): void {
    this.#querySubscribersListener = handler;
  }

  /**
   * Flush pending debounced writes immediately (component unmount / input blur
   * / explicit). No args flushes every resource. In-flight keys flush on
   * release; while disconnected the write path stays held until reconnect.
   * Delegates to the conflict-outcome engine's debounce queue.
   */
  flush(resourceType?: string, resourceId?: string): void {
    this.#engine.flush(resourceType, resourceId);
  }

  // ─── Serial mesh-submit gate ──────────────────────────────────────────────

  /**
   * The engine's `submitBatch` hook: submit a batch as one atomic mesh transaction via `callAsync`
   * and resolve with the raw server facts. The submit-gate is RETIRED — `callAsync` correlates
   * each transaction by its own `callId`, so concurrent independent-resource batches run in parallel
   * (the engine's per-resource queue still serializes same-resource writes; ADR-005 + `snapshots.ts`
   * Step 4.5a/6.5 own no-double-commit). Ontology-stale arrives as a RETURNED `OntologyStaleError`,
   * which `callAsync` rejects with as it does any Error outcome; it is caught here and becomes
   * `{ontologyStale}`, and any other Error stays the engine's infrastructure-error. Resilient across reconnect: a dropped RESULT re-resolves to the
   * new socket. A RESULT that never arrives ends in a timeout, and the engine rolls the write back
   * and reports it `retryable`; resubmitting is the app's call, as the platform docs tell it.
   */
  async #meshSubmit(subs: QueueSubmission[], attempt = 0): Promise<ServerBatchResponse> {
    // One mesh `newETag` per batch (the server writes it as every resource's eTag — snapshots.ts
    // Step 4.5a); stable across reconnect replays, so a re-issued submission is replay-idempotent.
    const meshNewETag = subs[0]!.newETag;
    let result: any;
    try {
      result = await this.#hostCallAsync(
        this.#client.ctn<ResourcesHostNode>().resources.transaction(this.requireOntologyVersion('transaction'), meshNewETag, this.#buildMeshOps(subs)),
      );
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      result = e;
    }
    if (result instanceof Error) {
      // Ontology-stale is a version-skew signal, not an infrastructure error, so it is answered
      // here rather than thrown on.
      if (isOntologyStaleError(result)) {
        // `installing` = the host fired a registry lazy-pull of the CURRENT version inside our
        // op's call context (an install it cannot await — ADR-003), so the op succeeds shortly
        // if this version is current. Retry the replay-idempotent submission (same `newETag`) a few
        // times before treating the version as genuinely stale.
        if (result.installing && attempt < INSTALLING_RETRY_LIMIT) {
          await new Promise((r) => setTimeout(r, INSTALLING_RETRY_DELAY_MS));
          return this.#meshSubmit(subs, attempt + 1);
        }
        return { ontologyStale: { clientVersion: result.clientVersion, currentVersion: result.currentVersion } };
      }
      throw result; // any other Error-as-value → engine infrastructure-error
    }
    return this.#mapTransactionResult(result, subs);
  }

  /** Turn queue submissions into wire ops. A submission carrying an explicit
   *  `op` (transactionOps) becomes that op (typeName stripped on put/move/
   *  delete — the server reads it from the current snapshot); a bare submission
   *  (debounced write) is a `put` whose typeName IS its resourceType. */
  #buildMeshOps(subs: QueueSubmission[]): Record<string, WireOp> {
    const ops: Record<string, WireOp> = {};
    for (const s of subs) {
      const op = s.op as EngineOp | undefined;
      ops[s.rid] = op ? this.#engineOpToWire(op, s.eTag) : { op: 'put', eTag: s.eTag, value: s.value };
    }
    return ops;
  }

  #engineOpToWire(op: EngineOp, baselineETag: string): WireOp {
    switch (op.op) {
      case 'create': return { op: 'create', typeName: op.typeName, nodeId: op.nodeId, value: op.value };
      case 'put':    return { op: 'put', eTag: op.eTag ?? baselineETag, value: op.value };
      case 'move':   return { op: 'move', eTag: op.eTag ?? baselineETag, nodeId: op.nodeId };
      case 'delete': return { op: 'delete', eTag: op.eTag ?? baselineETag };
    }
  }

  /** Map the server's atomic `TransactionResult` to the engine's per-resource
   *  `ServerBatchResponse` (same order as the submitted batch). A non-stale
   *  thrown Error rejects the submit promise → the engine's infrastructure-error. */
  #mapTransactionResult(result: TransactionResult, subs: QueueSubmission[]): ServerBatchResponse {
    if (result.ok) {
      const eTag = subs[0]!.newETag;
      return { resources: subs.map(() => ({ result: 'committed', eTag })) };
    }
    return {
      resources: subs.map((s): ServerResourceResult => {
        const err = result.errors[s.rid];
        if (!err) {
          // Atomic batch: a sibling failed (step precedence discloses one
          // class), so this op didn't commit and carries no detail of its own.
          // Roll it back as a permission-denied placeholder — the precise
          // multi-resource atomic-batch shape is a §5.3.8 real-Star probe (P10).
          return { result: 'permission-denied' };
        }
        switch (err.type) {
          case 'conflict': return { result: 'conflict', snapshot: err.currentSnapshot as unknown as EngineSnapshot };
          case 'validation': return { result: 'validation-failed', errors: err.errors };
          case 'permission': return { result: 'permission-denied' };
        }
      }),
    };
  }

  /** What a reconnect the host node does not report as a loss still restores. */
  #afterReconnect(): void {
    if (this.#restoredOnThisConnection) return;
    if (this.#scopeAdminChanged) {
      this.#scopeAdminChanged = false;
      this.#restoreSubscriptions();
      return;
    }
    this.#resendPendingSubscribes();
  }

  /**
   * Re-issue every live subscription: every `#subscriptionRegistry` entry, every query and roster
   * watcher, and the org tree when a listener renders it. Run when the host node reports the
   * subscriptions may be gone, or the token's admin verdict changed. Profiles are the Client's, and
   * `MeshClient.onSubscriptionRequired` restores them; a profile's visibility never depends on the
   * admin verdict (ADR-012).
   *
   * Unconditional, no dedupe-on-pending, through `#hostCall` rather than `#subscribeResource`,
   * whose coalesce path piggybacks on a pending entry without sending a fresh subscribe. The
   * server's `INSERT OR REPLACE` makes a second arrival idempotent, and a second initial snapshot
   * deep-equals-dedups in `handleResourceUpdate`.
   */
  #restoreSubscriptions(): void {
    // Every `#subscriptionRegistry` entry is a resource on this page's host → re-subscribe there.
    // (Profiles are NOT in this registry: they ride the Client's own channel, on the PROFILE binding,
    // which is what keeps a dev-user `Profile`-typed resource from being re-routed to the global
    // PROFILE DO — tasks/nebula-subscriber-lists.md.)
    // ⚠️ The version gates THIS LOOP ONLY — never the method. The query and roster loops below need
    // no ontology version, and an early return here silently stopped them, and the profiles the walk
    // restored then, from re-firing on reconnect (caught by `first-app-built`, 2026-09-25). Reading it once and
    // skipping the loop is right: without a version nothing can have subscribed, because every
    // subscribe pins one, so the registry is empty and the loop is a no-op anyway — and a
    // reconnect handler is the wrong place to throw.
    const version = this.#ontologyVersion;
    if (version) {
      for (const { resourceType, resourceId } of this.#subscriptionRegistry.values()) {
        this.#hostCall(
          this.#client.ctn<ResourcesHostNode>().resources.subscribe(version, resourceType, resourceId),
          this.#client.ctn<NebulaClient>().onResourceSubscribeRefused(resourceType, resourceId));
      }
    }
    // Re-fire every live query sub too, so a changed admin verdict is re-derived server-side and
    // the stored `dominionOverHostAtSubscribe` is cleared. The window subs ride the single-resource
    // loop above.
    for (const [queryHash, entry] of this.#queryEntries) {
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuery(entry.query), this.#client.ctn<NebulaClient>().onQuerySubscribeRefused(queryHash));
    }
    // Re-fire every live STANDALONE subscriber-list watcher sub (the roster re-arrives via
    // handleQuerySubscribersUpdate; the server's INSERT OR REPLACE makes the re-register idempotent).
    for (const [queryHash, entry] of this.#querySubscriberEntries) {
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuerySubscribers(entry.query),
        this.#client.ctn<NebulaClient>().onRosterSubscribeRefused(queryHash));
    }
    // The org tree, gated on a registered listener so headless clients (admin scripts, tests) that
    // don't render it don't register or broadcast needlessly.
    if (this.#orgTreeListener) this.#subscribeTree();
  }

  /**
   * Send again every subscribe whose first snapshot has not arrived. One sent just as a socket
   * closed may never have reached its host, and a reconnect the host node reports nothing lost on
   * restores nothing else.
   */
  #resendPendingSubscribes(): void {
    const version = this.#ontologyVersion;
    if (version) {
      for (const key of this.#pendingSubscribes.keys()) {
        const entry = this.#subscriptionRegistry.get(key);
        if (!entry) continue;
        this.#hostCall(
          this.#client.ctn<ResourcesHostNode>().resources.subscribe(version, entry.resourceType, entry.resourceId),
          this.#client.ctn<NebulaClient>().onResourceSubscribeRefused(entry.resourceType, entry.resourceId));
      }
    }
    for (const [queryHash, entry] of this.#queryEntries) {
      if (entry.ready.settled) continue;
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuery(entry.query), this.#client.ctn<NebulaClient>().onQuerySubscribeRefused(queryHash));
    }
    for (const [queryHash, entry] of this.#querySubscriberEntries) {
      if (entry.ready.settled) continue;
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuerySubscribers(entry.query),
        this.#client.ctn<NebulaClient>().onRosterSubscribeRefused(queryHash));
    }
    if (this.#treeSnapshotAwaited && this.#orgTreeListener) this.#subscribeTree();
  }

  #subscribeTree(): void {
    this.#treeSnapshotAwaited = true;
    this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.subscribeTree(), this.#client.ctn<NebulaClient>().logRefusal('subscribeTree'));
  }

  /**
   * @internal Test-only — runs the same walk `onSubscriptionRequired` runs, for tests that
   * exercise what one re-subscribe does without forcing a lost subscription first.
   */
  _restoreSubscriptionsForTest(): void { this.#restoreSubscriptions(); }

  /** Resource namespace — entry point for subscribe / read / transaction; `NebulaClient.resources`. */
  readonly api = {
    /**
     * The factory's debounced v-model path: enqueue a debounced put of the
     * resource's CURRENT (optimistic) store value. The optimistic paint has
     * already landed in the store (the factory's synced-state middleware writes
     * the value first, then calls this); `write` only drives WHEN the
     * transaction submits — quiet/maxWait windows, serial-per-resource
     * buffering, connection gating. `preWriteValue` is the B4 first-divergence
     * baseline (the value the store held before the first keystroke of the
     * burst). Delegates to the engine's debounce queue.
     */
    write: (
      resourceType: string,
      resourceId: string,
      opts?: { quietMs?: number; preWriteValue?: unknown },
    ): void => {
      this.#engine.write(resourceType, resourceId, opts);
    },

    /**
     * Subscribe to a resource. Returns a `using`-compatible
     * {@link ResourceSubscription} handle synchronously (the subscriber row is
     * registered immediately); the initial snapshot arrives asynchronously on
     * `.snapshot`, which resolves on the first `handleResourceUpdate` for
     * `(rt, rid)` (subsequent fanout pushes write through to bound state but do
     * not re-resolve). Each call increments the per-`(rt, rid)` handle refcount;
     * `[Symbol.dispose]()` decrements (per-handle, idempotent) and issues
     * `Star.resources.unsubscribe` only when the last handle releases.
     *
     * If a pending subscribe for the same `(rt, rid)` already exists, `.snapshot`
     * piggybacks on that pending settlement instead of issuing a duplicate
     * request — Star's `INSERT OR REPLACE` would no-op anyway, and clients
     * calling subscribe multiple times for the same key should observe a single
     * first-snapshot resolve.
     */
    subscribe: (resourceType: string, resourceId: string): ResourceSubscription => {
      this.#holdResource(resourceType, resourceId);
      return this.#resourceHandle(resourceType, resourceId, this.#subscribeResource(resourceType, resourceId));
    },

    /**
     * Create a resource and subscribe to it in one call — the ergonomic form of
     * the **create-then-subscribe** pattern the server requires (a subscribe to
     * a not-yet-existent resource is rejected; the server has no
     * subscribe-before-create path). Returns a `using`-compatible
     * {@link ResourceSubscription} **synchronously** — refcount + `[Symbol.dispose]`
     * behave exactly as {@link resources.subscribe} — but the underlying
     * `Star.resources.subscribe` is deferred until the `create` transaction commits, so
     * `.snapshot` resolves with the freshly-created snapshot. If the create does
     * NOT commit (already exists, permission, validation), `.snapshot` **rejects**
     * — use plain `subscribe` for a resource that already exists.
     *
     * Pure client-side sequencing over the two existing primitives (`transaction`
     * then `subscribe`); no special server path, and it routes to the active
     * scope's Star binding like every other resource call. Disposing before the
     * create lands cancels the pending subscription (the already-submitted create
     * is not unwound).
     */
    createAndSubscribe: (
      resourceType: string,
      resourceId: string,
      nodeId: string,
      value: unknown,
    ): ResourceSubscription => {
      this.#holdResource(resourceType, resourceId);
      let disposed = false;
      const snapshot = (async (): Promise<Snapshot | null> => {
        const outcome = await this.api.transaction({
          [resourceId]: { op: 'create', typeName: resourceType, nodeId, value },
        });
        if (outcome.kind !== 'committed') {
          throw new Error(
            `createAndSubscribe: create of (${resourceType}, ${resourceId}) did not commit ` +
            `— outcome '${outcome.kind}'; use subscribe() for a resource that already exists`,
          );
        }
        if (disposed) return null; // disposed before the create landed — don't arm the subscription
        return this.#subscribeResource(resourceType, resourceId);
      })();
      return this.#resourceHandle(resourceType, resourceId, snapshot, () => { disposed = true; });
    },

    /**
     * Ad-hoc read of a resource. Each call gets its own `requestId`; concurrent
     * reads to the same `(rt, rid)` are independently correlated. Does NOT
     * write to bound state — `read` is for scripting / ad-hoc inspection.
     * Use `subscribe` for reactive UIs.
     */
    read: (resourceType: string, resourceId: string, options?: ReadOptions): Promise<Snapshot | null> => {
      return this.#readResource(resourceType, resourceId, options);
    },

    /**
     * Submit a transaction. **Always resolves** with a `TransactionOutcome`
     * (never rejects); the await-site switches on `outcome.kind`. Per-resource
     * detail is delivered to the per-type `onTransactionResourceResolution`
     * handler (or the per-call override) and mirrored on `outcome.resources`.
     * `ops` is keyed by `resourceId`.
     */
    transaction: (
      ops: Record<string, OperationDescriptor>,
      options?: TransactionOptions,
    ): Promise<TransactionOutcome> => {
      const engineOps: Record<string, { rt: string } & EngineOp> = {};
      for (const [rid, op] of Object.entries(ops)) {
        // Auto-derive eTag: a put/move/delete with no explicit eTag and no
        // baseline in the local store is a programming error (forgot to
        // subscribe / pass eTag) — throw synchronously at the call site rather
        // than letting it surface as an opaque outcome (api-reference
        // § resources.transaction). `create` asserts non-existence (no eTag).
        if (op.op !== 'create' && op.eTag === undefined &&
            this.#storeAdapter.readResource(op.typeName, rid).eTag === undefined) {
          throw new Error(
            `can't auto-derive eTag for (${op.typeName}, ${rid}) — not in local store; pass eTag explicitly or subscribe first`,
          );
        }
        // resourceType === typeName (the store path is resources.{typeName}.{rid}).
        engineOps[rid] = { rt: op.typeName, ...op } as { rt: string } & EngineOp;
      }
      return this.#engine.transactionOps(engineOps, {
        onTransactionResourceResolution: options?.onTransactionResourceResolution,
        maxRetries: options?.maxRetries,
      });
    },

    /**
     * Register a per-type resolution handler (api-reference
     * § onTransactionResourceResolution) — replaces the shipped `onETagConflict`.
     * The handler returns a `ConflictResolverVerdict` on `'conflict-pending'`
     * and reacts to terminal branches for UX side-effects. Later registrations
     * replace earlier ones (per-type, single handler).
     */
    onTransactionResourceResolution: (
      resourceType: string,
      handler: ResourceHandler,
      options?: { maxRetries?: number },
    ): void => {
      this.#engine.onTransactionResourceResolution(resourceType, handler, { maxRetries: options?.maxRetries });
    },

    /**
     * Runtime per-type debounce override (quiet / maxWait windows). Normal
     * config is ontology-declared; this is the escape hatch.
     */
    transactionDebounce: (
      resourceType: string,
      opts: { quietMs?: number; maxWaitMs?: number },
    ): void => {
      this.#engine.transactionDebounce(resourceType, opts);
    },

    /**
     * Release a subscription. **Equivalent to one `[Symbol.dispose]()`** on a
     * {@link ResourceSubscription} handle — decrements the per-`(rt, rid)` handle
     * refcount and issues `Star.resources.unsubscribe` only when the last handle releases.
     * Use this standalone form when the subscribe and release sites legitimately
     * differ; otherwise prefer the `using` handle.
     */
    unsubscribe: (resourceType: string, resourceId: string): void => {
      this.#disposeSubscription(resourceType, resourceId);
    },

    /**
     * Subscribe to a QUERY across resources — v1: equality on one to-one
     * relationship field. Returns a `using`-compatible {@link QuerySubscription}
     * synchronously; the client computes the canonical `queryHash` LOCALLY and keys
     * the handle before firing the (void) `subscribeQuery` (ADR-003). Membership
     * arrives on `ready` + every subsequent push (full-set replace). Use
     * `setRenderWindow` to lazily hydrate content for the rendered ids only.
     * Refcounted: `[Symbol.dispose]()` releases `unsubscribeQuery` on the last handle.
     */
    subscribeQuery: (query: QueryDescriptor, options?: SubscribeQueryOptions): QuerySubscription => {
      const queryHash = canonicalQueryHash(query);
      let entry = this.#queryEntries.get(queryHash);
      if (!entry) {
        let resolve!: () => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
        entry = {
          query,
          resourceIds: [],
          deniedNodes: [],
          refcount: 0,
          ready: { promise, resolve, reject, settled: false },
          desiredWindow: new Set<string>(),
          windowSubs: new Map(),
          renderGraceMs: options?.renderGraceMs ?? 2000,
          listeners: new Set(),
        };
        this.#queryEntries.set(queryHash, entry);
        this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.subscribeQuery(query), this.#client.ctn<NebulaClient>().onQuerySubscribeRefused(queryHash));
      }
      entry.refcount++;
      const e = entry;
      let disposed = false;
      return {
        ready: e.ready.promise,
        get resourceIds() { return e.resourceIds; },
        get deniedNodes() { return e.deniedNodes; },
        setRenderWindow: (resourceIds: string[]): void => {
          e.desiredWindow = new Set(resourceIds);
          this.#reconcileQueryWindow(e);
        },
        onChange: (cb: () => void): void => { e.listeners.add(cb); },
        [Symbol.dispose]: (): void => {
          if (disposed) return; // per-handle idempotent
          disposed = true;
          this.#disposeQuerySubscription(queryHash);
        },
      };
    },

    /**
     * Invite people onto a NODE of this host's org tree — a DAG grant at `nodeId`, never
     * `scopeAdmin`. The caller needs `admin` at the node. Distinct from the Client's own `invite`,
     * which reaches the Registry and invites into a SCOPE; the first argument's kind and the
     * `resources.` prefix tell them apart. Resolves with the submission ack; each invitee's row
     * reaches the members panel through its query subscription. Retried while the host installs its
     * ontology, which it answers before writing anything.
     */
    invite: (nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck> =>
      this.#inviteToNode(nodeId, invitees),
  };

  async #inviteToNode(nodeId: string, invitees: NodeInvitee[], attempt = 0): Promise<NodeInviteAck> {
    try {
      return await this.#hostCallAsync(
        this.#client.ctn<ResourcesHostNode>().resources.invite(nodeId, invitees));
    } catch (err) {
      if (isInstalling(err) && attempt < INSTALLING_RETRY_LIMIT) {
        await new Promise((r) => setTimeout(r, INSTALLING_RETRY_DELAY_MS));
        return this.#inviteToNode(nodeId, invitees, attempt + 1);
      }
      if (isOntologyStaleError(err)) this.#dispatchOntologyStale(err.clientVersion, err.currentVersion);
      throw err;
    }
  }

  /**
   * Org/permission-tree MUTATIONS (api-reference § client.orgTree). Reads are
   * NOT here — the tree is delivered on its own channel to `store.lmz.orgTree`
   * (auto-subscribed on connect). Each mutator fires a resilient `call()`
   * ({@link #orgTreeMutate} → `callAsync`) through the host's `resources` door and returns a
   * resilient Promise — reject-on-failure, NO optimistic local write-through (the
   * broadcast echo, originator included, is the only store update path). `callAsync`
   * holds the Promise in-heap keyed by callId and its delivery re-resolves to the
   * current socket, so a WS reconnect or tab freeze no longer strands it (a
   * local Promise over one-way fire + re-resolvable fire-back, NOT a socket-bound
   * awaited RPC); a lost RESULT rejects on `callAsync`'s default timeout rather
   * than hanging, and a full reload/discard triggers orgTree-resync. Idempotent/retry-safe.
   * `createNode` takes a **client-supplied** nodeId (a v4 UUID), so it is
   * server-idempotent too: a dropped/replayed call returns the same node.
   */
  readonly orgTree = {
    createNode: (nodeId: string, parentNodeId: string, slug: string, label: string): Promise<string> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.createNode(nodeId, parentNodeId, slug, label)),
    addEdge: (parentNodeId: string, childNodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.addEdge(parentNodeId, childNodeId)),
    removeEdge: (parentNodeId: string, childNodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.removeEdge(parentNodeId, childNodeId)),
    reparentNode: (childNodeId: string, oldParentId: string, newParentId: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.reparentNode(childNodeId, oldParentId, newParentId)),
    deleteNode: (nodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.deleteNode(nodeId)),
    undeleteNode: (nodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.undeleteNode(nodeId)),
    renameNode: (nodeId: string, newSlug: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.renameNode(nodeId, newSlug)),
    relabelNode: (nodeId: string, newLabel: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.relabelNode(nodeId, newLabel)),
    setPermission: (nodeId: string, targetSub: string, level: PermissionTier): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.setPermission(nodeId, targetSub, level)),
    revokePermission: (nodeId: string, targetSub: string): Promise<void> =>
      this.#orgTreeMutate(this.#client.ctn<ResourcesHostNode>().resources.orgTree.revokePermission(nodeId, targetSub)),
  };

  /** Count one more handle on `(rt, rid)`, creating the key's read-access state with the first. */
  #holdResource(resourceType: string, resourceId: string): void {
    const key = `${resourceType}:${resourceId}`;
    this.#subscribeRefcount.set(key, (this.#subscribeRefcount.get(key) ?? 0) + 1);
    if (!this.#resourceAccess.has(key)) {
      this.#resourceAccess.set(key, { deniedNodes: [], answered: false, listeners: new Set() });
    }
  }

  /**
   * One {@link ResourceSubscription} over `(rt, rid)`'s shared read-access state. `onChange`
   * callbacks belong to the handle that registered them and go when it is disposed; `onDispose`
   * runs first, for a caller with its own disposal state.
   */
  #resourceHandle(
    resourceType: string,
    resourceId: string,
    snapshot: Promise<Snapshot | null>,
    onDispose?: () => void,
  ): ResourceSubscription {
    const access = this.#resourceAccess.get(`${resourceType}:${resourceId}`)!;
    const mine: Array<() => void> = [];
    let disposed = false;
    return {
      snapshot,
      get deniedNodes() { return access.deniedNodes; },
      onChange: (cb: () => void): void => {
        if (disposed) return;
        mine.push(cb);
        access.listeners.add(cb);
      },
      [Symbol.dispose]: (): void => {
        if (disposed) return; // per-handle idempotent
        disposed = true;
        onDispose?.();
        for (const cb of mine) access.listeners.delete(cb);
        this.#disposeSubscription(resourceType, resourceId);
      },
    };
  }

  /**
   * Decrement the per-`(rt, rid)` handle refcount; on the last release, drop the
   * local registry entry first (a reconnect mid-call can't resurrect it) then
   * issue `Star.resources.unsubscribe`. Shared by handle `[Symbol.dispose]()` and the
   * standalone `unsubscribe`.
   */
  #disposeSubscription(resourceType: string, resourceId: string): void {
    const key = `${resourceType}:${resourceId}`;
    const n = this.#subscribeRefcount.get(key) ?? 0;
    if (n > 1) {
      this.#subscribeRefcount.set(key, n - 1);
      return; // other handles still hold it open
    }
    this.#subscribeRefcount.delete(key);
    this.#subscriptionRegistry.delete(key);
    this.#resourceAccess.delete(key);
    this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.unsubscribe(resourceType, resourceId), this.#client.ctn<NebulaClient>().logRefusal('unsubscribe'));
  }

  /**
   * Reconcile a query's windowed per-resource content subs with its effective
   * window (`desiredWindow ∩ resourceIds`). Opens a content sub for each newly-
   * effective id (or cancels its pending grace dispose if it returned in time —
   * the flicker-free path), and schedules a grace-delayed dispose for each id that
   * left the effective window. A now-denied resource (absent from `resourceIds`)
   * falls out of the effective set automatically and is released after grace.
   */
  #reconcileQueryWindow(entry: QueryEntry): void {
    const members = new Set(entry.resourceIds);
    const effective = new Set<string>();
    for (const id of entry.desiredWindow) if (members.has(id)) effective.add(id);

    // Open (or rescue from grace) the effective ids.
    for (const id of effective) {
      const ws = entry.windowSubs.get(id);
      if (ws) {
        if (ws.graceTimer !== undefined) { clearTimeout(ws.graceTimer); ws.graceTimer = undefined; }
      } else {
        const sub = this.api.subscribe(entry.query.typeName, id);
        entry.windowSubs.set(id, { sub });
      }
    }
    // Schedule grace-delayed dispose for ids no longer effective.
    for (const [id, ws] of entry.windowSubs) {
      if (effective.has(id) || ws.graceTimer !== undefined) continue;
      ws.graceTimer = setTimeout(() => {
        ws.sub[Symbol.dispose]();
        entry.windowSubs.delete(id);
      }, entry.renderGraceMs);
    }
  }

  /**
   * Decrement a query subscription's refcount; on the last release tear down all
   * window subs (cancelling grace timers) and issue `unsubscribeQuery`. Shared by
   * the handle's `[Symbol.dispose]()`.
   */
  #disposeQuerySubscription(queryHash: string): void {
    const entry = this.#queryEntries.get(queryHash);
    if (!entry) return;
    if (entry.refcount > 1) { entry.refcount--; return; }
    this.#queryEntries.delete(queryHash);
    for (const ws of entry.windowSubs.values()) {
      if (ws.graceTimer !== undefined) clearTimeout(ws.graceTimer);
      ws.sub[Symbol.dispose]();
    }
    entry.windowSubs.clear();
    this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.unsubscribeQuery(queryHash), this.#client.ctn<NebulaClient>().logRefusal('unsubscribeQuery'));
  }

  #subscribeResource(resourceType: string, resourceId: string): Promise<Snapshot | null> {
    // BEFORE any state. Refusing inside `fire()` instead would leave a registry entry and an armed
    // abandon timer behind a subscribe that never went out.
    const version = this.requireOntologyVersion('subscribe');
    const key = `${resourceType}:${resourceId}`;
    this.#subscriptionRegistry.set(key, { resourceType, resourceId });
    return awaitFirstPush(
      this.#pendingSubscribes,
      key,
      () => this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribe(version, resourceType, resourceId),
        this.#client.ctn<NebulaClient>().onResourceSubscribeRefused(resourceType, resourceId)),
      // Through the SAME door the host's own error push uses, so abandoning runs that branch's
      // cleanup — the registry entry goes too, which is what stops a reconnect replaying a
      // subscribe that was never acknowledged.
      (reason) => this.handleResourceUpdate(resourceType, resourceId, reason),
      this.#subscribeTimeoutMs,
    );
  }

  /**
   * Subscribe to the live subscriber-LIST roster of `query` — the STANDALONE watcher subscription (roster
   * only; does NOT subscribe to the query's DATA). Returns a `using`-compatible {@link SubscriberListSubscription}
   * whose `ready` resolves on the first roster push; the roster lands in the reactive store at the
   * query-in-path `store.lmz.querySubscribers.<typeName>.<field>[value]` via the factory listener.
   * Refcounted (a 2nd subscribe of the same canonical query coalesces) + reconnect-safe (re-sent on any
   * reconnect until its first roster arrives, and re-fired whenever subscriptions may be gone). Routes to
   * the active-scope host (Star/Galaxy). tasks/nebula-subscriber-lists.md.
   */
  subscribeQuerySubscribers(query: QueryDescriptor): SubscriberListSubscription {
    const queryHash = canonicalQueryHash(query);
    let entry = this.#querySubscriberEntries.get(queryHash);
    if (!entry) {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      entry = { query, refcount: 0, ready: { promise, resolve, reject, settled: false } };
      this.#querySubscriberEntries.set(queryHash, entry);
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuerySubscribers(query),
        this.#client.ctn<NebulaClient>().onRosterSubscribeRefused(queryHash));
    }
    entry.refcount++;
    const e = entry;
    let disposed = false;
    return {
      ready: e.ready.promise,
      [Symbol.dispose]: (): void => {
        if (disposed) return; // per-handle idempotent
        disposed = true;
        this.#disposeQuerySubscribersSubscription(queryHash);
      },
    };
  }

  #disposeQuerySubscribersSubscription(queryHash: string): void {
    const entry = this.#querySubscriberEntries.get(queryHash);
    if (!entry) return;
    if (entry.refcount > 1) { entry.refcount--; return; } // other handles still hold it open
    this.#querySubscriberEntries.delete(queryHash);
    this.#hostCall(
      this.#client.ctn<ResourcesHostNode>().resources.unsubscribeQuerySubscribers(queryHash),
      this.#client.ctn<NebulaClient>().logRefusal('unsubscribeQuerySubscribers'));
  }

  /**
   * The ontology version this op pins, or a refusal naming why there is none.
   *
   * Every resource op sends a version the host ENFORCES, so an op cannot proceed without one — but
   * the client itself can, and does. That asymmetry is the whole point: an app with no resources is
   * a first-class app, and refusing at CONSTRUCTION instead would stop a freshly generated app
   * rendering at all. It did exactly that until 2026-09-25, blanking the Studio preview on
   * `<div id="app"></div>` with a mount-time throw as the only trace.
   *
   * ⚠️ Studio's own client is never the one that trips this — it is constructed with
   * {@link CHAT_MESSAGE_ONTOLOGY_VERSION}, a platform constant rather than an applied version. Only
   * a generated app's client, whose version comes from the Galaxy's applied head, can be without one.
   */
  requireOntologyVersion(operation: string): string {
    if (!this.#ontologyVersion) throw new NoOntologyInstalledError(operation);
    return this.#ontologyVersion;
  }

  #readResource(
    resourceType: string,
    resourceId: string,
    options?: ReadOptions,
  ): Promise<Snapshot | null> {
    // `resourceType` is currently not used over the wire: `Snapshots.read`
    // keys on `resourceId` alone (storage assumes globally unique resourceIds
    // per Star). Kept in the client signature for API symmetry with
    // subscribe/transaction and for future addressing changes.
    void resourceType;
    const version = options?.ontologyVersion ?? this.requireOntologyVersion('read');
    // `callAsync` returns the snapshot (framework fire-back) — resilient across
    // reconnect/freeze, bounded by the default timeout. Concurrent reads are correlated by the
    // primitive's `callId`. On a stale version `Star.resources.read` throws `OntologyStaleError` → the reject
    // path fires `onShouldRefreshUI` (relocated from the old push handler) before re-rejecting —
    // except an `installing` stale (the host is mid-lazy-pull), which retries the idempotent read.
    const attempt = (options as { installingAttempt?: number } | undefined)?.installingAttempt ?? 0;
    return this.#hostCallAsync<Snapshot | null>(
      this.#client.ctn<ResourcesHostNode>().resources.read(version, resourceId),
    ).catch(async (err) => {
      if (isOntologyStaleError(err)) {
        if (err.installing && attempt < INSTALLING_RETRY_LIMIT) {
          await new Promise((r) => setTimeout(r, INSTALLING_RETRY_DELAY_MS));
          return this.#readResource(resourceType, resourceId,
            { ...(options ?? {}), installingAttempt: attempt + 1 } as ReadOptions);
        }
        this.#dispatchOntologyStale(err.clientVersion, err.currentVersion);
      }
      throw err;
    });
  }


  /**
   * Schedule one more subscribe after an `installing` answer, and say whether one was scheduled.
   * `false` once a channel has used its retries, so the caller ends at the stale signal the way
   * `transaction` and `read` do. Keyed per channel and cleared by that channel's next real
   * answer, so a later install starts a fresh count.
   */
  #retryInstalling(channel: string, resend: () => void): boolean {
    const attempt = this.#installingAttempts.get(channel) ?? 0;
    if (attempt >= INSTALLING_RETRY_LIMIT) {
      this.#installingAttempts.delete(channel);
      return false;
    }
    this.#installingAttempts.set(channel, attempt + 1);
    setTimeout(resend, INSTALLING_RETRY_DELAY_MS);
    return true;
  }

  /**
   * Fire the `onShouldRefreshUI` constructor hook (if registered) with the
   * staleness info. Swallows user-callback throws so an erroring hook can't
   * take the framework down.
   *
   * When the inbound error's `clientVersion` is empty, substitute the client's
   * own pinned version. This is load-bearing for the push-on-clear
   * path: the plane doesn't store per-subscriber `clientVersion` on a Subscriptions
   * row, so the `OntologyStaleError` it sends carries an empty `clientVersion`.
   * The door's mismatch answers (transaction / read / subscribe) always carry
   * a real client version, so the substitution is a no-op for those.
   */
  #dispatchOntologyStale(clientVersion: string, currentVersion: string): void {
    if (!this.#onShouldRefreshUI) return;
    try {
      this.#onShouldRefreshUI({
        reason: 'ontology-stale',
        clientVersion: clientVersion || this.#ontologyVersion || '',
        currentVersion,
      });
    } catch (err) {
      // User-supplied callback threw — swallow so the framework keeps
      // operating, but surface the bug to the developer.
      log.warn('onShouldRefreshUI callback threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }


  /**
   * Fire an `orgTree.*` mutation via `callAsync` — the Mesh client primitive that returns a Promise
   * settled by the re-resolvable RESULT: resolves with the mutation's value (`createNode`
   * → nodeId; other mutators → undefined) or rejects with its Error (e.g. permission denied). Resilient
   * by construction (survives WS reconnect + tab freeze) and bounded by `callAsync`'s default timeout,
   * so a lost RESULT rejects rather than hanging. No per-call `requestId` / settler handler — the
   * primitive owns correlation + dedup.
   */
  #orgTreeMutate(remote: any): Promise<any> {
    return this.#hostCallAsync(remote);
  }

  /**
   * Receive a resource update from the host — the answer to a subscribe, or a later broadcast.
   *
   * Three jobs:
   *   1. Record what this subscriber may read: a snapshot means readable (`deniedNodes: []`), a
   *      {@link ResourceDenied} names the node it cannot read the resource under. The store entry
   *      takes it through the adapter's `applyDenied` — on a loss the entry drops its `value` and
   *      `meta` — and each handle's `onChange` fires when it changes after the first answer.
   *   2. Write a snapshot to the store via the engine's `notifyFanout`, which implements the
   *      hold-pending-fanouts contract — a push that lands while the resource has pending
   *      optimistic state is held (not clobbering the user's in-progress edit) until the next
   *      submit's conflict resolution.
   *   3. Settle the originating `subscribe(rt, rid)` Promise if one is pending (first-call-wins):
   *      the snapshot, or `null` for a denied subscriber.
   *
   * An Error is a refused subscribe — a missing resource or a wrong type; it rejects the pending
   * Promise and writes nothing. Soft-deleted resources arrive as a real Snapshot with
   * `meta.deleted: true` and flow through `notifyFanout` like any other push.
   */
  handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | ResourceDenied | null | Error): void {
    const key = `${resourceType}:${resourceId}`;
    const pending = this.#pendingSubscribes.get(key);

    if (result instanceof Error) {
      // The host is installing its ontology: ask again, and answer nothing yet. A subscribe no
      // handle holds any more is not retried.
      if (isInstalling(result) && this.#subscriptionRegistry.has(key)
        && this.#retryInstalling(`resource:${key}`, () => {
          const version = this.#ontologyVersion;
          const registered = this.#subscriptionRegistry.get(key);
          if (!version || !registered) return;
          this.#hostCall(
            this.#client.ctn<ResourcesHostNode>().resources.subscribe(version, registered.resourceType, registered.resourceId),
            this.#client.ctn<NebulaClient>().onResourceSubscribeRefused(registered.resourceType, registered.resourceId));
        })) {
        return;
      }
      // Ontology-stale path: fire the constructor hook so the UI can reload
      // even though there's no Promise outcome variant for subscribe (it
      // rejects on error). Same staleness signal as transaction / read.
      if (isOntologyStaleError(result)) {
        this.#dispatchOntologyStale(result.clientVersion, result.currentVersion);
      }
      // Error path: reject pending Promise (if any) and drop the registry entry.
      // No state write-through on error.
      if (pending) {
        this.#pendingSubscribes.delete(key);
        this.#subscriptionRegistry.delete(key);
        pending.reject(result);
      }
      return;
    }

    if (isResourceDenied(result)) {
      this.#installingAttempts.delete(`resource:${key}`);
      this.#applyAccess(resourceType, resourceId, result.deniedNodes);
      if (pending) {
        this.#pendingSubscribes.delete(key);
        pending.resolve(null);
      }
      return;
    }

    this.#installingAttempts.delete(`resource:${key}`);
    // Write-through via the engine (hold-pending-fanouts). `null` (never-created)
    // writes nothing — the slot stays undefined until a real snapshot arrives.
    if (result !== null) {
      this.#applyAccess(resourceType, resourceId, []);
      this.#engine.notifyFanout(resourceType, resourceId, result as unknown as EngineSnapshot);
      // Reconcile-by-id: the durable Message superseded any
      // ephemeral progress stream for the same id — drop it so the UI shows the
      // durable content, not a duplicate. Idempotent (no-op when nothing streamed).
      this.#streamingMessages.delete(resourceId);
    }

    // Settle pending subscribe Promise (first-call-wins)
    if (pending) {
      this.#pendingSubscribes.delete(key);
      pending.resolve(result);
    }
  }

  /**
   * Record `(rt, rid)`'s read access from one update: mirror it into the store entry, update the
   * handles' `deniedNodes`, and fire their `onChange` when it changed after the first answer. A
   * push for a key no handle holds (a raw test initiator's) still reaches the store.
   */
  #applyAccess(resourceType: string, resourceId: string, deniedNodes: string[]): void {
    this.#storeAdapter.applyDenied(resourceType, resourceId, deniedNodes);
    const access = this.#resourceAccess.get(`${resourceType}:${resourceId}`);
    if (!access) return;
    const changed = access.answered && !sameNodes(access.deniedNodes, deniedNodes);
    access.deniedNodes = deniedNodes;
    access.answered = true;
    if (!changed) return;
    for (const cb of [...access.listeners]) {
      try { cb(); } catch { /* a listener throw must not break the push channel */ }
    }
  }

  /**
   * Receive an org-tree snapshot from Star — the initial `subscribeTree`
   * snapshot or the plane's tree-change broadcast (originator included). Forwards the
   * tree state to the factory's registered listener, which mirrors it to
   * `store.lmz.orgTree.value`. The tree is delivered on a dedicated channel (not
   * a resource), so this is wholly separate from `handleResourceUpdate`.
   *
   * Then asks again for whatever was denied, because a tree change is where a grant lands and the
   * host re-runs nothing on a permission change (see {@link #askAgain}).
   */
  handleOrgTreeUpdate(envelope: { value: OrgTreeState }): void {
    this.#treeSnapshotAwaited = false;
    this.#orgTreeListener?.(envelope.value);
    this.#askAgain();
  }

  /**
   * Re-subscribe exactly the subscriptions whose last update named `deniedNodes` — the resource
   * subscriptions and the queries — so a grant reaches this client at the next tree change rather
   * than at the next write. The host answers each through its ordinary subscribe path. Filtered on
   * purpose: every client `createNebulaClient` builds watches the tree, and each re-subscribe costs
   * the host a billed write, so a tab with nothing denied costs nothing here. Never
   * {@link #restoreSubscriptions}, which would re-subscribe everything on every tree change.
   *
   * When the subscriptions are restored, the tree's first answer asks again for what
   * `#restoreSubscriptions` asked a moment earlier: one extra idempotent write per denied
   * subscription per restore. Accepted — telling that first answer apart would need a flag and an
   * argument about arrival order to save it.
   */
  #askAgain(): void {
    const version = this.#ontologyVersion;
    if (version) {
      for (const [key, access] of this.#resourceAccess) {
        if (access.deniedNodes.length === 0) continue;
        const registered = this.#subscriptionRegistry.get(key);
        if (!registered) continue;
        this.#hostCall(
          this.#client.ctn<ResourcesHostNode>().resources.subscribe(version, registered.resourceType, registered.resourceId),
          this.#client.ctn<NebulaClient>().onResourceSubscribeRefused(registered.resourceType, registered.resourceId));
      }
    }
    for (const [queryHash, entry] of this.#queryEntries) {
      if (entry.deniedNodes.length === 0) continue;
      this.#hostCall(
        this.#client.ctn<ResourcesHostNode>().resources.subscribeQuery(entry.query), this.#client.ctn<NebulaClient>().onQuerySubscribeRefused(queryHash));
    }
  }

  /**
   * Receive a query-membership push from the host — the initial
   * `subscribeQuery` state or a Flow-3 rerun. Correlated by the **locally-computed**
   * `queryHash` (subscribeQuery is void). `result` is `{ resourceIds?, deniedNodes? }`
   * (the client REPLACES its set per push — idempotent, self-healing) or an Error
   * (a rejected query — bad `queryType`/`field`).
   *
   * Replaces the entry's membership set + denied set (full-set replace —
   * idempotent), reconciles the rendered window (opening/releasing per-resource
   * content subs), fires the entry's change listeners, and settles `ready`. A push
   * for an unknown `queryHash` (no live handle — e.g. a raw test initiator) is
   * ignored. An Error rejects `ready` (a rejected query).
   */
  handleQueryUpdate(queryHash: string, result: QueryUpdatePayload | Error): void {
    const entry = this.#queryEntries.get(queryHash);
    if (!entry) return;
    if (result instanceof Error) {
      if (isInstalling(result) && this.#retryInstalling(`query:${queryHash}`, () => {
        const live = this.#queryEntries.get(queryHash);
        if (live) this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.subscribeQuery(live.query), this.#client.ctn<NebulaClient>().onQuerySubscribeRefused(queryHash));
      })) return;
      if (isOntologyStaleError(result)) this.#dispatchOntologyStale(result.clientVersion, result.currentVersion);
      if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.reject(result); }
      return;
    }
    this.#installingAttempts.delete(`query:${queryHash}`);
    entry.resourceIds = result.resourceIds ?? [];
    entry.deniedNodes = result.deniedNodes ?? [];
    this.#reconcileQueryWindow(entry);
    for (const cb of entry.listeners) {
      try { cb(); } catch { /* a listener throw must not break the push channel */ }
    }
    if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.resolve(); }
  }

  /**
   * Receive a subscriber-list roster push (the query's distinct-by-`sub` `{ sub, profileId }` set) for a
   * query whose STANDALONE WATCHER subscription this client holds — or an Error (a fail-closed invalid
   * watcher query). Correlated by the locally-computed `queryHash`; a push for an unknown/disposed
   * `queryHash` is ignored (a late/racing push can't resurrect a disposed watcher). On a roster: deliver
   * it to the factory's registered listener (→ `store.lmz.querySubscribers.*`, keyed by the entry's
   * query + optional name) and settle `ready`. On an Error: reject `ready`. Reached through
   * `NebulaClient`'s `@mesh()`-decorated forwarder of the same name.
   */
  handleQuerySubscribersUpdate(queryHash: string, result: SubscriberRosterPayload | Error): void {
    const entry = this.#querySubscriberEntries.get(queryHash);
    if (!entry) return;
    if (result instanceof Error) {
      if (isInstalling(result) && this.#retryInstalling(`roster:${queryHash}`, () => {
        const live = this.#querySubscriberEntries.get(queryHash);
        if (live) {
          this.#hostCall(this.#client.ctn<ResourcesHostNode>().resources.subscribeQuerySubscribers(live.query),
            this.#client.ctn<NebulaClient>().onRosterSubscribeRefused(queryHash));
        }
      })) return;
      if (isOntologyStaleError(result)) this.#dispatchOntologyStale(result.clientVersion, result.currentVersion);
      if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.reject(result); }
      return;
    }
    this.#installingAttempts.delete(`roster:${queryHash}`);
    this.#querySubscribersListener?.({ queryHash, query: entry.query, roster: result });
    if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.resolve(); }
  }

  /**
   * Receive a transient assistant-progress chunk for `messageId`.
   * Server→client direct delivery (`lmz.broadcast` from the Galaxy, addressed to this
   * client's stable `instanceName`) as the codegen loop makes progress. Accumulates
   * into the ephemeral {@link #streamingMessages} cache + fires the optional live hook.
   * NOT durable: reconciled away when the durable `Message` lands ({@link handleResourceUpdate}),
   * or lost on reload (the durable Message restores via the query sub). Reached through
   * `NebulaClient`'s `@mesh()`-decorated forwarder, like the other pushes.
   */
  handleStreamChunk(messageId: string, progress: string, replyTo?: string): void {
    const accumulated = (this.#streamingMessages.get(messageId) ?? '') + progress;
    this.#streamingMessages.set(messageId, accumulated);
    this.#onStreamChunk?.(messageId, accumulated, replyTo);
  }

  /** The accumulated ephemeral progress for an in-flight assistant `messageId`, or
   *  `undefined` once the durable Message superseded it (or nothing streamed). */
  streamingProgress(messageId: string): string | undefined {
    return this.#streamingMessages.get(messageId);
  }

  /** Register the live-progress hook (the UI renders each accumulated chunk). The
   *  UI seam; headless clients (tests) read {@link streamingProgress} instead. */
  setOnStreamChunk(hook: (messageId: string, progress: string, replyTo?: string) => void): void {
    this.#onStreamChunk = hook;
  }

}

/**
 * NebulaClient — extends LumenizeClient with the two-scope model + reactive
 * resource bindings.
 *
 * Auth scope: determines the refresh cookie path (e.g., 'acme.app.tenant-a' or 'acme')
 * Active scope: baked into the JWT's aud claim AND used as the Star DO
 * instance name for all `client.resources.*` traffic.
 */

// Imports use the Node-safe /client subpath so this file can be imported
// from Node test harnesses (e.g. apps/nebula/test/browser/) — the main
// `@lumenize/mesh` entry pulls in `cloudflare:workers` via LumenizeDO and
// fails outside Workers. The same applies to types: import only from
// /client to keep this module Node-importable in full.
import { LumenizeClient, mesh, LoginRequiredError } from '@lumenize/mesh/client';
import type { ConnectionState, LumenizeClientConfig } from '@lumenize/mesh/client';
import type {
  NebulaJwtPayload, AffectedScope, ScopeDeletionPlan, InviteeRequest, InviteSummary,
} from '@lumenize/nebula-auth';
// Type-only, so nothing of the facade's mesh-server chain reaches this Node/browser-safe module —
// it types the continuation below and is erased at compile.
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import { debug } from '@lumenize/debug';
import { isOntologyStaleError } from './errors';
// Impersonation's own knowledge lives in its module — this client keeps only the two touchpoints
// (the construction seam below, and one hook in `disconnect()`). Relative import: deliberately not
// on the package barrel, and Node/browser-safe like the rest of this file.
import {
  INTERNAL_REFRESH, INTERNAL_PARENT, assertCanImpersonate, childInstanceName, parentTabIdFrom,
  mintNarrowerToken, registerChild, deregisterChild, onClientTornDown, isTornDown,
  ImpersonationMintError,
  type ChildConfigBase, type ImpersonateOptions, type RefreshFn,
} from './impersonation';
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
import type { OperationDescriptor as WireOp, TransactionResult, Snapshot, TransactionError } from './resources';
import type { QueryUpdatePayload, QueryDescriptor, SubscriberEntry, SubscriberRosterPayload } from './query-hash';
import { canonicalQueryHash } from './query-hash';
import type { DagTreeState, PermissionTier } from './dag-ops';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID } from './chat-constants';
import type { Star } from './star';
import type { Galaxy } from './galaxy';

const log = debug('lumenize.nebula-client');

// The conflict-outcome engine (apps/nebula/src/frontend) owns the resolution
// vocabulary. NebulaClient instantiates it, injects a store adapter (the
// factory swaps in a Vue-reactive one), and re-exports its types as the public
// surface. api-reference.md is the contract.
export type { TransactionOutcome, TransactionResourceResolution, ResourceHandler, ConflictResolverVerdict };
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
 * {@link NebulaClient.resources.subscribe}. `snapshot` resolves with the initial
 * snapshot on the first server push for `(rt, rid)` (subsequent fanout updates
 * write through to bound state but do not re-resolve it). `[Symbol.dispose]()`
 * is per-handle (idempotent); the server-side subscription releases when the
 * **last** handle for `(rt, rid)` disposes (refcounted — mirrors the factory's
 * auto-subscribe). api-reference § client.resources.subscribe is the contract.
 */
export interface ResourceSubscription extends Disposable {
  readonly snapshot: Promise<Snapshot | null>;
}

/**
 * The minimal snapshot the DEDICATED global-Profile channel delivers — a public `value` + an eTag-only
 * `meta` (the Profile DO carries no ADR-004/005 resource meta). A resources `Snapshot` is a structural
 * superset, so a real push (typed `Snapshot`) is assignable to this; tests construct it directly. Used by
 * the `onProfileUpdate` listener + the factory's `store.lmz.profiles[id]` write-back.
 */
export interface ProfileChannelSnapshot {
  value: unknown;
  meta: { eTag: string };
}

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
 * {@link NebulaClient.resources.subscribeQuery} (Child 2). The membership
 * (`resourceIds`, ordered) is REPLACED on every push (idempotent, self-healing —
 * no delta merge). `subscribeQuery` is fire-and-forget (the client computes the
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

export interface NebulaClientConfig extends Omit<LumenizeClientConfig, 'refresh' | 'gatewayBindingName'> {
  /** Auth scope — determines refresh cookie path (e.g., 'acme.app.tenant-a' or 'acme' for admins) */
  authScope: string;
  /** Active scope — baked into JWT aud claim AND Star DO instance name (e.g., 'acme.app.tenant-a') */
  activeScope: string;
  /**
   * App version this client was built against (lock-step with the server's
   * ontology version). Auto-attached to every `client.resources.*` call.
   * Studio bakes this in at app build time.
   */
  ontologyVersion: string;
  /**
   * Optional hook invoked when the server signals the client's ontology
   * version is stale (deploys happened since this client started). Typical
   * implementation: `() => window.location.reload()`. No default — undefined
   * means opted-out, in which case the staleness signal still surfaces via
   * the originating Promise's `{ resolution: 'ontology-stale' }` outcome.
   */
  onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
  /**
   * Optional hook invoked when the dev Star signals a fresh compile landed (the
   * Studio dev-preview reload channel — `Star.broadcastReload`). Typical preview
   * implementation: `() => window.location.reload()`. No default — undefined
   * means opted-out (a non-preview client simply ignores reload signals).
   */
  onReload?: () => void;
  /**
   * Optional hook invoked when the Galaxy signals the preview can (re)load (the
   * {@link NebulaClient.handlePreviewReady} push, in response to
   * {@link NebulaClient.warmPreview}). The Studio uses it to auto-refresh the preview
   * iframe — no manual Reload. `scope` is the scope the readiness is for (ignore if
   * the UI has since switched scopes).
   */
  onPreviewReady?: (scope: string) => void;
  /**
   * Which mesh binding hosts this client's Resources (the data-plane: transaction /
   * read / subscribe / unsubscribe / dagTree, + the org-tree & reload channels).
   * Default `'STAR'` (generated apps + the published `client.resources.*` surface are
   * untouched by the chat pair). The chat paths route via {@link chatHostBinding} +
   * {@link chatScope}, never this field.
   *
   * NOTE: the org-tree channel (`subscribeTree`) rides THIS pair and the Galaxy does
   * not host it; the reload channel routes by which pair the signal source is on —
   * the chat pair (the Galaxy's build-completion push) when one is configured, else
   * this pair (the Star's parked publish signal).
   */
  resourceHostBinding?: string;
  /**
   * The CHAT host pair — which binding + instance host this client's chat
   * (`postUserMessage` / `chat` / `warmPreview`). Chat `Chat`/`Message` Resources live on
   * **GALAXY `{u}.{g}`** (the app-level brain) while app resources stay on the Star, so
   * the two planes are separate construction pairs — PER CLIENT INSTANCE, never per op
   * (no client needs two hosts: Studio's client chats and never touches app resources;
   * a generated app's client does the reverse and leaves this unset).
   *
   * ⚠️ NO default, deliberately — a chat-path call with the pair unset THROWS loudly,
   * which is what kills the silent misroute (chat falling back to the resource pair
   * would write the user `Message` to the Star's plane). `Profile` subs ride NEITHER
   * pair (the fixed `PROFILE` binding with the profileId as instance, ADR-012).
   */
  chatHostBinding?: string;
  /** The chat host's instance — the galaxy `{u}.{g}` (see {@link chatHostBinding}). */
  chatScope?: string;
}

/** Bounded retry for an `installing` OntologyStaleError — the host fired a registry
 *  lazy-pull inside the refused op's call context; the install typically lands within a
 *  round trip, so a few short retries cover it without masking a genuinely stale client. */
const INSTALLING_RETRY_LIMIT = 4;
const INSTALLING_RETRY_DELAY_MS = 400;

type SubscribeKey = string; // `${resourceType}:${resourceId}`

interface PendingSubscribe {
  resolve: (snapshot: Snapshot | null) => void;
  reject: (error: Error) => void;
}

/**
 * The store-effect seam the conflict-outcome engine drives. The factory
 * (`@lumenize/nebula/frontend`) injects a Vue-reactive implementation via
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

/** Minimal structural target for the Profile subscribe/unsubscribe continuations — avoids importing the
 *  Profile DO (a `cloudflare:workers` class) into the browser-bundled client. Matches `Profile.subscribe()`
 *  / `Profile.unsubscribe()`. The subscribe instance is the profileId (binding-agnostic; NOT `activeScope`),
 *  since the Profile DO is global/cross-scope. Profiles ride a DEDICATED client channel (`#profileRefcount`
 *  / `handleProfileUpdate`), NOT the resource keyspace — so a dev-user ontology type named `Profile` can't
 *  collide (tasks/nebula-subscriber-lists.md). */
interface ProfileSubscribeTarget {
  subscribe(): void;
  unsubscribe(): void;
  writeProfile(fields: { name?: string; nickname?: string; picture?: string }): Promise<void>;
}

export class NebulaClient extends LumenizeClient<NebulaJwtPayload> {
  #authScope: string;
  #activeScope: string;
  #ontologyVersion: string;
  /** Binding hosting this client's Resources (default 'STAR'; the resource pair). */
  #resourceHostBinding: string;
  /** The chat host pair — NO default; chat paths throw when unset (see the config JSDoc). */
  #chatHostBinding?: string;
  #chatScope?: string;
  #onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
  #onReload?: () => void;
  #onPreviewReady?: (scope: string) => void;
  // Captured for `logout()` (the embedded refresh closure reads them too, but a
  // method can't reach the constructor's `config`). `#baseUrl` may be undefined
  // when the browser auto-detects it for the WS URL — logout falls back to the
  // current origin in that case.
  #baseUrl?: string;
  #fetchFn: typeof fetch;
  /** Exactly what a child from `impersonate()` inherits — see {@link impersonate}. */
  #childConfigBase!: ChildConfigBase;
  /**
   * The parent this client was minted from, when it IS an impersonated child; `undefined` on an
   * ordinary client. Post-construction users only (the child's `logout()` branch and deregistration)
   * — the re-mint path uses a lexically captured reference instead, because a `refresh` closure can
   * run during `super()`, before this field exists.
   */
  #mintedFrom?: NebulaClient;

  /**
   * Decoded JWT payload — **non-null on NebulaClient**.
   *
   * Base `LumenizeClient` types `claims` as `Readonly<NebulaJwtPayload> | null`
   * (a genuine null window before the first token refresh). NebulaClient
   * narrows it to non-null: the factory's `ready` promise resolves only after
   * that first refresh populates claims, so by the time component / app code
   * runs, `client.claims` is always present — which is what lets the blessed
   * examples write `client.claims.sub` without `!`/`?.` under strict TS.
   *
   * Behaviorally-neutral re-declaration: the runtime getter is the inherited
   * one (this only drops `| null` from the type). Code that runs **before**
   * `ready` — admin tools, scripts — must still guard with `?.`.
   */
  get claims(): Readonly<NebulaJwtPayload> {
    return super.claims as Readonly<NebulaJwtPayload>;
  }

  /** Store adapter the conflict-outcome engine drives; the factory swaps in a
   *  Vue-reactive one via {@link bindStore}, headless uses the in-memory
   *  default. */
  #storeAdapter: NebulaStoreAdapter = createInMemoryStoreAdapter();

  /** Conflict-outcome engine (debounce queue + resolution). Assigned in the
   *  constructor body once `#storeAdapter` exists. */
  #engine!: ConflictOutcomeEngine;

  /** Previous connection state, for detecting the `reconnecting → connected`
   *  transition in the connection-state callback (see constructor). */
  #prevConnectionState: ConnectionState | null = null;

  /**
   * Runtime connection-state listener registered by the factory
   * ({@link onConnectionStateChange}) — it mirrors state into
   * `store.lmz.connection.*`. Single-handler; a later call replaces it. The
   * engine's connection gate is wired separately in the constructor callback
   * (NebulaClient owns the gate; the factory only surfaces the state).
   */
  #connectionStateListener: ((state: ConnectionState) => void) | null = null;

  /**
   * Runtime org-tree listener registered by the factory ({@link onOrgTreeUpdate})
   * — it mirrors the tree state into `store.lmz.orgTree.value`. Single-handler;
   * a later call replaces it. Fed by the `handleOrgTreeUpdate` @mesh handler
   * (initial `subscribeTree` snapshot + every `#onDagChanged` broadcast).
   */
  #orgTreeListener: ((state: DagTreeState) => void) | null = null;

  /**
   * Active subscriptions registry. Used by Phase 5.3.4 auto-resubscribe on
   * reconnect, and (in 5.3.6) by refcount-with-grace. For 5.3.3a the entry
   * is minimal — just enough to know what's subscribed.
   */
  #subscriptionRegistry = new Map<SubscribeKey, { resourceType: string; resourceId: string }>();

  /**
   * Per-`(rt, rid)` subscription-handle refcount. Both `using` handles from
   * `resources.subscribe(...)` and the factory's auto-subscribe (one held handle
   * per component-bound resource) increment it; each `[Symbol.dispose]()` /
   * standalone `unsubscribe` decrements. The server-side `Star.unsubscribe`
   * fires only when the count reaches zero (the last interested party released),
   * so component bindings and explicit handles both keep the subscription open.
   */
  #subscribeRefcount = new Map<SubscribeKey, number>();

  /**
   * In-flight `subscribe(rt, rid)` Promises awaiting their first
   * `handleResourceUpdate`. Settled (resolved on snapshot, rejected on Error)
   * on the first matching update, then cleared. Subsequent updates are
   * pure side-effect (state write-through only).
   */
  #pendingSubscribes = new Map<SubscribeKey, PendingSubscribe>();

  /**
   * Dedicated global-Profile subscription state — a SEPARATE channel from the resource
   * `#subscriptionRegistry`/`#subscribeRefcount`/`#pendingSubscribes` above, keyed by bare `profileId`.
   * Kept separate so the platform profile never shares the `${resourceType}:${resourceId}` keyspace/routing
   * with a dev-user ontology type named `Profile` (that collision was a footgun AND a shipped reconnect
   * mis-route — tasks/nebula-subscriber-lists.md). `#profileRefcount` keys ARE the live-sub set (walked on
   * reconnect); `#profilePending` settles each `subscribeProfile().snapshot` on its first push.
   */
  #profileRefcount = new Map<string, number>();
  #profilePending = new Map<string, PendingSubscribe>();

  /**
   * Runtime profile listener registered by the factory ({@link onProfileUpdate}) — it mirrors each pushed
   * profile snapshot into `store.lmz.profiles[profileId].value`. Single-handler (mirrors {@link #orgTreeListener}).
   * Fed by the `handleProfileUpdate` @mesh handler (initial subscribe snapshot + every fanout push).
   */
  #profileListener: ((profileId: string, snapshot: ProfileChannelSnapshot | null) => void) | null = null;

  /**
   * Active query subscriptions (Child 2), keyed by the locally-computed canonical
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
   * Ephemeral assistant-progress streams, keyed by `assistantMessageId` (Child 3
   * option (b)). Accumulates the transient `handleStreamChunk` pushes for the
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

  constructor(config: NebulaClientConfig) {
    const {
      authScope,
      activeScope,
      ontologyVersion,
      onShouldRefreshUI,
      onReload,
      onPreviewReady,
      resourceHostBinding,
      chatHostBinding,
      chatScope,
      onConnectionStateChange: userOnConnectionStateChange,
      ...baseConfig
    } = config;

    // LumenizeClient defers the initial onConnectionStateChange to a microtask,
    // so this wrapper only ever fires *after* construction completes — meaning
    // it can safely read/write subclass fields (`#prevConnectionState`,
    // `#state`) directly. No closure-variable workaround needed.
    super({
      ...baseConfig,
      gatewayBindingName: 'NEBULA_CLIENT_GATEWAY',
      // ── TOUCHPOINT 1 of 2: the impersonation construction seam ──────────────────────────────────
      // A child from `impersonate()` renews through its parent's mint helper, not off a cookie it
      // does not have. `refresh` is `Omit`ted from `NebulaClientConfig` AND overwritten here, so it
      // cannot be supplied even by casting — which is exactly the footgun we keep closed (a caller
      // could otherwise build a client whose token and `authScope` disagree). The symbol is the
      // narrow exception: unreachable from the public config type, and not exported from the barrel.
      refresh: (config as unknown as Record<symbol, unknown>)[INTERNAL_REFRESH] as RefreshFn | undefined ?? (async () => {
        const fetchFn = config.fetch ?? fetch;
        const res = await fetchFn(
          `${config.baseUrl}/auth/${authScope}/refresh-token`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeScope }),
          },
        );
        if (!res.ok) {
          // Classify like mesh's #refreshToken string-endpoint path (P9): a
          // 401/403 means the refresh cookie is expired/invalid → terminal, so
          // #connectInternal fires onLoginRequired + 'disconnected' and the
          // factory's `ready` rejects (a logged-out visitor redirects, not hangs);
          // any other status is transient → reconnect. Because NebulaClient
          // supplies `refresh` as a FUNCTION, mesh's string-path classification
          // never runs — we MUST throw the typed error here, or a first-connect
          // 401 silently swallows into unbounded reconnect.
          if (res.status === 401 || res.status === 403) {
            throw new LoginRequiredError(
              `Refresh failed: ${res.status}`,
              res.status,
              'Refresh token expired or invalid',
            );
          }
          throw new Error(`Refresh failed: ${res.status}`);
        }
        const data = await res.json() as { access_token: string; sub: string };
        // The per-workspace AUTH-SCOPE HINT, written at the one authoritative moment:
        // the client just PROVED the (authScope, activeScope) pair works — it called
        // this authScope's path-scoped refresh for this activeScope and got a token.
        // localStorage, never a cookie (the hint tells the CLIENT which refresh
        // endpoint to call; it must never ride to the server), keyed per active scope
        // (one machine, several workspaces, several identities). Self-healing: a later
        // success under a different identity overwrites; nothing ever clears. Both
        // surfaces embed this client, so built apps inherit it with no Studio code.
        try {
          localStorage.setItem(`nebula.authScope:${activeScope}`, authScope);
        } catch { /* no localStorage outside a browser (tests, restricted iframes) */ }
        return { access_token: data.access_token, sub: data.sub };
      }),
      onConnectionStateChange: (state) => {
        // Phase 5.3.4a: re-subscribe everything on reconnect. The
        // `reconnecting → connected` transition is the precise signal that
        // a network-blip recovery just completed (LumenizeClient stays in
        // `reconnecting` across retry attempts and only flips to `connected`
        // when the WS is back up). The initial-connect transition is
        // `disconnected → connecting → connected`, which we don't treat as
        // a reconnect (registry is empty anyway).
        if (this.#prevConnectionState === 'reconnecting' && state === 'connected') {
          // The in-flight mesh transaction recovers on its own: its `callAsync` Promise survives the
          // drop and its RESULT re-resolves to the new socket, or the default timeout
          // rejects → the engine retries. No submit-gate to clear (retired, D7).
          this.#resubscribeAll();
        }
        // Gate the engine's submission queue: not-'connected' suspends flush +
        // timers (a blip never rolls back); 'connected' replays held/in-flight.
        // `lmz.connection.*` surfacing is the factory's job (it observes the
        // client directly + replays at creation).
        this.#engine?.setConnectionState(state);
        // OrgTree is a universal singleton (no refcount/grace): (re)subscribe on
        // every `'connected'` — initial connect AND reconnecting→connected.
        // Gated on a registered tree listener so headless clients (admin scripts,
        // tests) that don't render the tree don't register/broadcast needlessly.
        // Idempotent server-side (INSERT OR REPLACE).
        if (state === 'connected' && this.#orgTreeListener) {
          this.lmz.call(this.#resourceHostBinding, this.#activeScope, this.ctn<Star>().subscribeTree());
        }
        // Preview-reload channel: (re)subscribe on every 'connected' — gated on a
        // configured `onReload`. Routed by which pair the signal source is on: with a
        // CHAT pair (Studio) the subscription lands on the GALAXY, whose
        // `broadcastReload` fires on build completion and Studio reloads the iframe
        // it composes; without one it falls to the resource pair (the Star's parked
        // channel — publish's future refresh signal). Idempotent server-side
        // (INSERT OR REPLACE by clientId), mirroring the orgTree singleton above.
        if (state === 'connected' && this.#onReload) {
          if (this.#chatHostBinding && this.#chatScope) {
            this.lmz.call(this.#chatHostBinding, this.#chatScope, this.ctn<Galaxy>().subscribeReload());
          } else {
            this.lmz.call(this.#resourceHostBinding, this.#activeScope, this.ctn<Star>().subscribeReload());
          }
        }
        this.#prevConnectionState = state;
        // Factory listener mirrors state into store.lmz.connection.* (it also
        // replays the current state once at creation via `connectionState`, so
        // factory/connect ordering is irrelevant).
        this.#connectionStateListener?.(state);
        userOnConnectionStateChange?.(state);
      },
    });

    this.#authScope = authScope;
    this.#activeScope = activeScope;
    this.#ontologyVersion = ontologyVersion;
    this.#resourceHostBinding = resourceHostBinding ?? 'STAR';
    this.#chatHostBinding = chatHostBinding;
    this.#chatScope = chatScope;
    // The inheritance contract for a child from `impersonate()`, captured as ONE field because a
    // method cannot reach the constructor's `config` (see `#baseUrl` above) and `LumenizeClient`'s
    // own `#config` is private. Deliberately EXCLUDES `onLoginRequired`: a child must not hold the
    // admin's handler, or someone else's session ending would bounce the admin to login.
    this.#childConfigBase = {
      baseUrl: config.baseUrl,
      ontologyVersion,
      fetch: config.fetch,
      // Passed THROUGH, `undefined` included — the `/live` harness supplies no `WebSocket` and
      // relies on the Node global, so requiring one here would break that path.
      WebSocket: config.WebSocket,
      sessionStorage: config.sessionStorage,
      BroadcastChannel: config.BroadcastChannel,
      resourceHostBinding: this.#resourceHostBinding,
      chatHostBinding: this.#chatHostBinding,
      chatScope: this.#chatScope,
    };
    this.#mintedFrom = (config as unknown as Record<symbol, unknown>)[INTERNAL_PARENT] as NebulaClient | undefined;
    this.#onShouldRefreshUI = onShouldRefreshUI;
    this.#onReload = onReload;
    this.#onPreviewReady = onPreviewReady;
    this.#baseUrl = config.baseUrl;
    this.#fetchFn = config.fetch ?? fetch;

    // Build the conflict-outcome engine over the store adapter + the serial
    // mesh gate. Store effects delegate to `#storeAdapter` (read fresh each
    // call, so `bindStore` can swap it). The engine's structural `Snapshot`
    // ({ value, meta.eTag }) is satisfied at runtime by the real wire
    // `resources.Snapshot`s it forwards, so the adapter casts recover the meta.
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
   * Register a runtime listener for connection-state transitions. The factory
   * (`@lumenize/nebula/frontend`) uses this to mirror state into
   * `store.lmz.connection.*`; it also reads {@link connectionState} once at
   * creation to replay the current state (so factory/connect ordering is
   * irrelevant). Single-handler; a later call replaces the previous one. The
   * constructor's `onConnectionStateChange` config callback (if any) still
   * fires too — this is chained alongside it, not in place of it.
   */
  onConnectionStateChange(handler: ((state: ConnectionState) => void) | null): void {
    this.#connectionStateListener = handler;
  }

  /**
   * Register a runtime listener for org-tree updates. The factory uses this to
   * mirror the tree into `store.lmz.orgTree.value`. Single-handler; replaces.
   * Fed by every `handleOrgTreeUpdate` (initial subscribe snapshot + broadcasts).
   */
  onOrgTreeUpdate(handler: ((state: DagTreeState) => void) | null): void {
    this.#orgTreeListener = handler;
  }

  /**
   * Register a runtime listener for global-Profile updates. The factory uses this to mirror each pushed
   * profile snapshot into `store.lmz.profiles[profileId].value`. Single-handler; replaces. Fed by every
   * `handleProfileUpdate` (initial `subscribeProfile` snapshot + every fanout push). Dedicated channel —
   * profiles never flow through the resource `handleResourceUpdate`/engine path.
   */
  onProfileUpdate(handler: ((profileId: string, snapshot: ProfileChannelSnapshot | null) => void) | null): void {
    this.#profileListener = handler;
  }

  /**
   * Register a runtime listener for subscriber-list roster updates. The factory uses this to mirror each
   * roster into the query-in-path store surface `store.lmz.querySubscribers.<typeName>.<field>[value]`
   * (keyed by the delivery's `query`). Single-handler; replaces. Fed by `handleQuerySubscribersUpdate`.
   */
  onQuerySubscribersUpdate(handler: ((delivery: SubscriberRosterDelivery) => void) | null): void {
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

  /**
   * Tear down the client: flush pending debounced writes + settle every open
   * submission (engine quiesces), then disconnect the WebSocket. Nothing submits
   * after this resolves (api-reference § client.dispose). Distinct from
   * {@link logout}, which *also* revokes the session — a disposed client could
   * reconnect with the same valid cookie; a logged-out one cannot. The factory's
   * `dispose()` calls this after clearing its own refcount/grace timers.
   */
  async dispose(): Promise<void> {
    await this.#engine.dispose();
    this.disconnect();
    this.#tearDownImpersonation();
  }

  /** `using` support — an end-of-session door, so it carries the impersonation teardown too. */
  override [Symbol.dispose](): void {
    super[Symbol.dispose]();
    this.#tearDownImpersonation();
  }

  /**
   * ── TOUCHPOINT 2 of 2: the impersonation teardown seam ──────────────────────────────────────────
   *
   * Marks this client un-mintable, tears down any impersonated children, and deregisters this client
   * from its own parent. Called from the three END-OF-SESSION doors — `dispose()`, `logout()` and
   * `[Symbol.dispose]()`.
   *
   * ⚠️ **NOT hooked on `disconnect()`, though all three doors route through it.** `disconnect()` has
   * a FOURTH caller those three do not share: application code pausing a connection, which is
   * **reversible** — the base explicitly keeps the token so a later `connect()` succeeds. Latching
   * there would permanently kill impersonation for a session the user never ended, and would
   * contradict this feature's own contract that *a disconnected parent still mints*.
   *
   * ⚠️ **And NOT a connection-state listener.** A transient drop goes
   * `#handleClose → #scheduleReconnect()` and reaches `'reconnecting'`, never `'disconnected'` —
   * so hooking a state transition would end an admin's impersonation session on a network blip.
   */
  #tearDownImpersonation(): void {
    onClientTornDown(this, this.#mintedFrom);
  }

  /**
   * User-initiated sign-out. Revokes + clears the (HttpOnly, path-scoped) refresh
   * cookie via the nebula-auth `POST /auth/{authScope}/logout` endpoint, drops the
   * in-memory access token + claims ({@link LumenizeClient.clearAccessToken}), and
   * tears down the connection ({@link LumenizeClient.disconnect} → the factory
   * mirrors `lmz.connection.state = 'disconnected'`).
   *
   * Does NOT navigate — the app redirects to login after this resolves (typically
   * the same redirect as the `onLoginRequired` terminal-auth path). Distinct from
   * {@link dispose}, which tears down WITHOUT revoking the session.
   *
   * Best-effort revoke: a failed endpoint call (offline, 5xx) is logged but does
   * not throw — the user is still signed out client-side (in-memory token dropped,
   * connection closed); only the server-side cookie revocation is missed. Always
   * resolves.
   *
   * @see https://lumenize.com/docs/nebula/api-reference#clientlogout
   */
  async logout(): Promise<void> {
    if (this.#mintedFrom) {
      await this.dispose();
      return;
    }
    // ⚠️ On an IMPERSONATED CHILD this is child-only teardown, and that is the faithful reading of
    // the method rather than a weakening of it: `logout()` is revoke + clear + disconnect, and a
    // child holds NO refresh cookie (the whole design is that no new durable credential exists), so
    // the revoke half is vacuous and the remainder IS dispose.
    //
    // Inheriting the parent's behaviour here would be actively harmful. `authScope` IS the
    // refresh-cookie path (`security.md` § two-scope model) and `logout()` is its only reader, so
    // the POST below would go to a path whose cookie belongs to the ADMIN — revoking the admin's
    // 30-day refresh token because someone ended an impersonation session. ⚠️ Pinning the child's
    // `authScope` to the impersonated scope is NOT a sufficient guard on its own: it diverges from
    // the parent's path only while the two scopes differ, and an admin who logged in AT the scope
    // they impersonate into gets an exact cookie-path match — the ordinary support shape.
    const baseUrl = this.#baseUrl
      ?? (typeof window !== 'undefined' ? window.location.origin : '');
    try {
      await this.#fetchFn(`${baseUrl}/auth/${this.#authScope}/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      const log = debug('nebula.NebulaClient.logout');
      log.warn('Logout endpoint call failed; signing out client-side anyway', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.clearAccessToken();
    this.disconnect();
    this.#tearDownImpersonation();
  }

  /**
   * Produce a working client that acts as another person — the admin-debug capability behind
   * *"why can't this user do X?"*.
   *
   * Dominion-**reducing**: the returned client carries the subject's permissions, which are
   * narrower than the caller's. It is a full `NebulaClient` — `resources`, `orgTree`, `subscribe`
   * all work unchanged — and `claims` answers both questions structurally: top-level `sub` /
   * `profileId` are the person being acted as, and the presence of `act` is what makes it an
   * impersonation session.
   *
   * **The parent is the credential.** No durable credential is created anywhere: the child renews by
   * re-minting through this client, so revocation propagates at the next token boundary and the
   * session dies with this client rather than at term.
   *
   * ⚠️ **Precondition:** this client must already have an `instanceName` — it has connected at least
   * once, or was constructed with one — because the child's Gateway name derives from this one's
   * tabId. A *disconnected* or *expired-token* parent is fine (the mint refreshes its own token
   * first); a never-connected one is not.
   *
   * @param sub The subject's surrogate `sub` — the person to act as.
   * @param activeScope The scope to act in. Required and explicit: it is the token's `aud`, bounded
   *   by the subject's dominion rather than equal to it, so deriving it would pick the WIDEST valid
   *   value — the wrong end of the range for a debug session, which wants the specific star where
   *   the trouble is.
   * @throws {ImpersonationChainError} when this client is itself impersonating — before any network
   *   call. Impersonation does not chain.
   * @throws {ImpersonationMintError} when the endpoint refuses, carrying its status and message.
   */
  async impersonate(sub: string, activeScope: string, opts?: ImpersonateOptions): Promise<NebulaClient> {
    // Local, decidable, and enforced independently by the endpoint's root-identity gate. `?.` is
    // required rather than defensive: `claims` is genuinely nullable on the base class.
    assertCanImpersonate(this.claims as { act?: unknown } | null | undefined);

    const base = this.#baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
    // Bound, because `authedFetch` is `protected` — that stops a free function from CALLING it, not
    // from receiving it. It also refreshes this client's own token first when needed, which is what
    // lets a parent holding an expired token still mint.
    const authedFetch = (url: string, init?: RequestInit) => this.authedFetch(url, init);
    // ONE mint path, captured LEXICALLY — never via the child's `#mintedFrom`, which does not exist
    // yet while the child's `refresh` may already be running inside `super()`. `opts` is captured
    // too, so every re-mint replays the same `ttlSeconds` and the session keeps its cadence.
    const parent = this;
    // Assigned immediately after construction; see the TDZ note in the terminal branch below.
    let childRef: NebulaClient | undefined;
    const mint = async () => {
      // The latch, checked on every mint including the first. Ending the admin's session ends
      // impersonation BY CONSTRUCTION rather than by waiting for the token to lapse.
      if (isTornDown(parent)) {
        throw new ImpersonationMintError(
          0, 'The client that created this impersonation session has been torn down',
          /* terminal */ true, // by construction — the session it would mint through is over
        );
      }
      return mintNarrowerToken(authedFetch, base, {
        subOfNarrowerToken: sub, activeScope, ttlSeconds: opts?.ttlSeconds,
      });
    };

    // MINT FIRST, then seed. Doing it the other way round — constructing tokenless and letting the
    // child's own connect be the single mint — moves this failure inside `super()`, where it becomes
    // a scheduled reconnect and the caller gets no error at all.
    const minted = await mint();

    const child = new NebulaClient({
      ...this.#childConfigBase,
      // `authScope` is INERT on a child: it names a refresh-cookie path and a child has no cookie.
      // It is set to the impersonated scope rather than this client's so that nothing inherited can
      // address the admin's cookie path by accident.
      authScope: activeScope,
      activeScope,
      accessToken: minted.access_token,
      instanceName: childInstanceName(sub, parentTabIdFrom(this.lmz.instanceName), activeScope),
      [INTERNAL_REFRESH]: (async () => {
        try {
          return await mint();
        } catch (e) {
          // TERMINAL vs TRANSIENT, stated structurally (4xx / everything else) rather than as a
          // status list, so a status the endpoint gains later inherits the right behaviour.
          //
          // ⚠️ Terminal reuses `LoginRequiredError` DELIBERATELY. It is the only signal mesh's
          // reconnect catch treats as terminal — its comment names the transient default as the
          // safe one — so a bespoke class would leave the child reconnect-looping forever instead of
          // ending. What protects the admin is NOT the error class but the inheritance contract:
          // a child never receives `onLoginRequired`, so mesh's terminal path has nothing to call
          // and the admin is never bounced to login because someone else's session ended.
          if (e instanceof ImpersonationMintError && e.terminal) {
            // The child is ending here and `disconnect()` will not run, so deregister explicitly.
            // ⚠️ Via a mutable holder, NOT the `const child` below: this closure can run inside
            // `super()` (a seeded token already inside the refresh-ahead window refreshes during
            // construction), where `child` is still in its temporal dead zone and touching it would
            // throw a ReferenceError *instead of* the terminal signal. Undefined here simply means
            // the child was never registered — registration happens after the first mint resolves.
            if (childRef) deregisterChild(parent, childRef);
            throw new LoginRequiredError(
              `Impersonation session ended: ${e.message}`, e.status, 'impersonation_ended',
            );
          }
          throw e; // transient (5xx, network) → mesh schedules a reconnect and the session survives
        }
      }) as RefreshFn,
      [INTERNAL_PARENT]: this,
    } as NebulaClientConfig);

    childRef = child;
    // AFTER the mint resolves, so a refused mint leaves no half-registered child holding a socket.
    registerChild(this, child);
    return child;
  }

  /**
   * Invite people into `targetScope` — the ONE client surface for the invite facade (the
   * `impersonate()` shape: this method is the sole site that knows the transport, so the harness,
   * the test fixtures, and the eventual UI affordance all route through it, and the
   * `invited | already-member | promoted` discriminant has one owning type).
   *
   * An ordinary mesh call to the `NEBULA_AUTH_FACADE` Worker binding (`instanceName: undefined`
   * routes it as a `LumenizeWorker`), so verified claims ride `callContext.originAuth` — never a
   * Bearer header this client would have to surface. Eligibility is the facade's: every member may
   * invite non-admin peers into exactly their own scope; dominion additionally permits inviting
   * downward and is the only thing that can confer a requested `scopeAdmin` (a peer's request caps
   * to false). A refusal rejects with the facade's message.
   *
   * The summary reports MINT outcomes; mail finishes server-side after it returns. In test mode
   * (server-configured) `links` carries the raw invite URLs; production summaries never do.
   */
  invite(targetScope: string, invitees: InviteeRequest[]): Promise<InviteSummary> {
    return this.lmz.callAsync(
      'NEBULA_AUTH_FACADE', undefined,
      this.ctn<NebulaAuthFacade>().invite(targetScope, invitees),
    );
  }

  // ─── Scope hierarchy (Universe / Galaxy / Star management) ────────────────
  //
  // The nebula-auth registry endpoints are HTTP routes (NOT on the mesh), so they need a Bearer
  // header — supplied by the base `authedFetch`, which keeps the JWT INSIDE the client (the bearer
  // never reaches UI/page code, and there's a single token authority — no cookie-rotation race).
  // App code calls `client.scopes.createGalaxy(...)` etc. and reacts to the result; it never touches
  // a token. (Platform-DO `teardown` after a delete still goes over the mesh — see the UI.)

  get scopes() {
    const base = this.#baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
    const post = async (endpoint: string, body: Record<string, unknown> = {}): Promise<unknown> => {
      const res = await this.authedFetch(`${base}/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`${endpoint} ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return res.json();
    };
    return {
      /** The caller's manageable instance tree (Universe + descendants). */
      list: async (): Promise<AffectedScope[]> =>
        ((await post('my-scopes')) as { scopes: AffectedScope[] }).scopes,
      /** Create a Galaxy `{universe}.{galaxySlug}` (admin over the universe). */
      createGalaxy: (universe: string, galaxySlug: string): Promise<{ instanceName: string }> =>
        post('create-galaxy', { universeGalaxyId: `${universe}.${galaxySlug}` }) as Promise<{ instanceName: string }>,
      /**
       * Create the user-developer's `.dev` authoring workspace under `{galaxy}` — in-session, no email.
       *
       * ⚠️ Takes a **galaxy** and hardcodes `{galaxy}.dev`; it cannot create a tenant Star. Named for
       * what it does, not for the endpoint it calls: a tenant Star is founded by the end user through
       * the open `claim-star` self-signup, never minted here.
       */
      createDevWorkspace: (galaxy: string): Promise<{ instanceName: string }> =>
        post('create-star', { universeGalaxyStarId: `${galaxy}.dev` }) as Promise<{ instanceName: string }>,
      /** Read-only deletion plan for the confirm screen: the down-only cascade + a bounded
       *  `affectedUsers` warning. Attached users never refuse a delete (ADR-015). */
      deletePlan: (target: string): Promise<ScopeDeletionPlan> =>
        post('delete-scope-plan', { target }) as Promise<ScopeDeletionPlan>,
      /** Execute the cascade delete; returns the affected set for the platform-DO teardown fan-out. */
      delete: (target: string): Promise<{ affected: AffectedScope[] }> =>
        post('delete-scope', { target }) as Promise<{ affected: AffectedScope[] }>,
    };
  }

  // ─── Serial mesh-submit gate ──────────────────────────────────────────────

  /**
   * The engine's `submitBatch` hook: submit a batch as one atomic mesh transaction via `callAsync`
   * and resolve with the raw server facts. The submit-gate is RETIRED — `callAsync` correlates
   * each transaction by its own `callId`, so concurrent independent-resource batches run in parallel
   * (the engine's per-resource queue still serializes same-resource writes; ADR-005 + `resources.ts`
   * Step 4.5a/6.5 own no-double-commit). Ontology-stale arrives as a RETURNED `OntologyStaleError`
   * (resolve → `{ontologyStale}`, not reject); an infra throw/timeout rejects → the engine's
   * infrastructure-error. Resilient across reconnect (D16/D17): a dropped RESULT re-resolves to the
   * new socket, or `callAsync`'s default timeout rejects → the engine retries.
   */
  async #meshSubmit(subs: QueueSubmission[], attempt = 0): Promise<ServerBatchResponse> {
    // One mesh `newETag` per batch (the server writes it as every resource's eTag — resources.ts
    // Step 4.5a); stable across reconnect replays, so a re-issued submission is replay-idempotent.
    const meshNewETag = subs[0]!.newETag;
    const result = await this.lmz.callAsync(
      this.#resourceHostBinding, this.#activeScope,
      this.ctn<Star>().transaction(this.#ontologyVersion, meshNewETag, this.#buildMeshOps(subs)),
    );
    if (result instanceof Error) {
      // Ontology-stale is delivered as a RETURNED value (resolve, not reject) — the engine treats it
      // as a version-skew signal, not an infrastructure error (asymmetric with `read`, which rejects).
      if (isOntologyStaleError(result)) {
        // `installing` = the host fired a registry lazy-pull for exactly this version inside
        // our op's call context (an install it cannot await — ADR-003), so the op is expected
        // to succeed shortly. Retry the replay-idempotent submission (same `newETag`) a few
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

  /**
   * Re-issue `Star.subscribe()` for every entry in `#subscriptionRegistry`.
   * Fired from the `reconnecting → connected` transition in the constructor's
   * connection-state callback.
   *
   * We unconditionally re-issue (no dedupe-on-pending) for correctness: if a
   * subscribe was sent before the WS dropped but the initial-snapshot response
   * was lost in flight, LumenizeClient does NOT re-send already-sent
   * fire-and-forget messages on reconnect, so the pending Promise would hang
   * forever without a fresh subscribe RTT here. The cost of being safe: a
   * subscribe issued while the WS was already down (in LumenizeClient's
   * #messageQueue) will both flush from the queue AND get re-issued — server's
   * `INSERT OR REPLACE` makes both arrivals idempotent and the second
   * initial-snapshot push deep-equals-dedups in `handleResourceUpdate`.
   *
   * We bypass `#subscribeResource` (rather than calling it for each entry)
   * because its coalesce path piggybacks on existing pending entries without
   * issuing a fresh RTT — which is exactly the trap above.
   */
  #resubscribeAll(): void {
    // Every `#subscriptionRegistry` entry is a Star resource → re-subscribe to the active-scope Star.
    // (Global Profiles are NOT in this registry — they walk `#profileRefcount` below on their dedicated
    // PROFILE binding. This is what fixes the shipped mis-route where a dev-user `Profile`-typed resource
    // was re-routed to the global PROFILE DO — tasks/nebula-subscriber-lists.md.)
    for (const { resourceType, resourceId } of this.#subscriptionRegistry.values()) {
      this.lmz.call(this.#resourceHostBinding, this.#activeScope,
        this.ctn<Star>().subscribe(this.#ontologyVersion, resourceType, resourceId));
    }
    // Re-fire every live global-Profile sub on its own PROFILE binding (binding-agnostic, instance = profileId).
    for (const profileId of this.#profileRefcount.keys()) {
      this.lmz.call('PROFILE', profileId, this.ctn<ProfileSubscribeTarget>().subscribe());
    }
    // Re-fire every live query sub too. This is the demote self-heal vehicle:
    // a reconnect after token expiry re-subscribes with the fresh token, so a
    // demoted admin's new (non-admin) `access.scopeAdmin` is re-derived server-side and
    // the stored `dominionOverHostAtSubscribe` is cleared. The window subs ride the single-resource
    // re-subscribe loop above.
    for (const entry of this.#queryEntries.values()) {
      this.lmz.call(this.#resourceHostBinding, this.#activeScope,
        this.ctn<Star>().subscribeQuery(entry.query));
    }
    // Re-fire every live STANDALONE subscriber-list watcher sub (the roster re-arrives via
    // handleQuerySubscribersUpdate; the server's INSERT OR REPLACE makes the re-register idempotent).
    for (const entry of this.#querySubscriberEntries.values()) {
      this.lmz.call(this.#resourceHostBinding, this.#activeScope,
        this.ctn<Star>().subscribeQuerySubscribers(entry.query));
    }
  }

  /**
   * @internal Test-only — invokes the same resubscribe walk that fires on a
   * `reconnecting → connected` transition. Provided because forcing an
   * unsolicited WS close from outside the client is awkward in the
   * vitest-pool-workers harness. The state-machine wiring that calls this
   * in production is covered by mesh-level tests + a smoke test that
   * exercises the real supersede path.
   */
  _resubscribeAllForTest(): void { this.#resubscribeAll(); }

  /** Resource namespace — entry point for subscribe / read / transaction. */
  readonly resources = {
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
     * `Star.unsubscribe` only when the last handle releases.
     *
     * If a pending subscribe for the same `(rt, rid)` already exists, `.snapshot`
     * piggybacks on that pending settlement instead of issuing a duplicate
     * request — Star's `INSERT OR REPLACE` would no-op anyway, and clients
     * calling subscribe multiple times for the same key should observe a single
     * first-snapshot resolve.
     */
    subscribe: (resourceType: string, resourceId: string): ResourceSubscription => {
      const key = `${resourceType}:${resourceId}`;
      this.#subscribeRefcount.set(key, (this.#subscribeRefcount.get(key) ?? 0) + 1);
      const snapshot = this.#subscribeResource(resourceType, resourceId);
      let disposed = false;
      return {
        snapshot,
        [Symbol.dispose]: (): void => {
          if (disposed) return; // per-handle idempotent
          disposed = true;
          this.#disposeSubscription(resourceType, resourceId);
        },
      };
    },

    /**
     * Create a resource and subscribe to it in one call — the ergonomic form of
     * the **create-then-subscribe** pattern the server requires (a subscribe to
     * a not-yet-existent resource is rejected; the server has no
     * subscribe-before-create path). Returns a `using`-compatible
     * {@link ResourceSubscription} **synchronously** — refcount + `[Symbol.dispose]`
     * behave exactly as {@link resources.subscribe} — but the underlying
     * `Star.subscribe` is deferred until the `create` transaction commits, so
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
      const key = `${resourceType}:${resourceId}`;
      this.#subscribeRefcount.set(key, (this.#subscribeRefcount.get(key) ?? 0) + 1);
      let disposed = false;
      const snapshot = (async (): Promise<Snapshot | null> => {
        const outcome = await this.resources.transaction({
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
      return {
        snapshot,
        [Symbol.dispose]: (): void => {
          if (disposed) return; // per-handle idempotent
          disposed = true;
          this.#disposeSubscription(resourceType, resourceId);
        },
      };
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
     * refcount and issues `Star.unsubscribe` only when the last handle releases.
     * Use this standalone form when the subscribe and release sites legitimately
     * differ; otherwise prefer the `using` handle.
     */
    unsubscribe: (resourceType: string, resourceId: string): void => {
      this.#disposeSubscription(resourceType, resourceId);
    },

    /**
     * Subscribe to a QUERY across resources (Child 2) — v1: equality on one to-one
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
        this.lmz.call(this.#resourceHostBinding, this.#activeScope, this.ctn<Star>().subscribeQuery(query));
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
  };

  /**
   * Org/permission-tree MUTATIONS (api-reference § client.orgTree). Reads are
   * NOT here — the tree is delivered on its own channel to `store.lmz.orgTree`
   * (auto-subscribed on connect). Each mutator fires a resilient 4-arg `call()`
   * ({@link #orgTreeMutate} → `callAsync`) to Star's `dagTree` entry and returns a
   * resilient Promise — reject-on-failure, NO optimistic local write-through (the
   * broadcast echo, originator included, is the only store update path). `callAsync`
   * holds the Promise in-heap keyed by callId and its delivery re-resolves to the
   * current socket, so a WS reconnect or tab freeze no longer strands it (D16 — a
   * local Promise over one-way fire + re-resolvable fire-back, NOT a socket-bound
   * awaited RPC); a lost RESULT rejects on `callAsync`'s default timeout rather
   * than hanging, and a full reload/discard triggers orgTree-resync. Idempotent/retry-safe.
   * `createNode` takes a **client-supplied** nodeId (a v4 UUID), so it is
   * server-idempotent too: a dropped/replayed call returns the same node.
   */
  readonly orgTree = {
    createNode: (nodeId: string, parentNodeId: string, slug: string, label: string): Promise<string> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().createNode(nodeId, parentNodeId, slug, label)),
    addEdge: (parentNodeId: string, childNodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().addEdge(parentNodeId, childNodeId)),
    removeEdge: (parentNodeId: string, childNodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().removeEdge(parentNodeId, childNodeId)),
    reparentNode: (childNodeId: string, oldParentId: string, newParentId: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().reparentNode(childNodeId, oldParentId, newParentId)),
    deleteNode: (nodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().deleteNode(nodeId)),
    undeleteNode: (nodeId: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().undeleteNode(nodeId)),
    renameNode: (nodeId: string, newSlug: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().renameNode(nodeId, newSlug)),
    relabelNode: (nodeId: string, newLabel: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().relabelNode(nodeId, newLabel)),
    setPermission: (nodeId: string, targetSub: string, level: PermissionTier): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().setPermission(nodeId, targetSub, level)),
    revokePermission: (nodeId: string, targetSub: string): Promise<void> =>
      this.#orgTreeMutate(this.ctn<Star>().dagTree().revokePermission(nodeId, targetSub)),
  };

  /**
   * Decrement the per-`(rt, rid)` handle refcount; on the last release, drop the
   * local registry entry first (a reconnect mid-call can't resurrect it) then
   * issue `Star.unsubscribe`. Shared by handle `[Symbol.dispose]()` and the
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
    this.lmz.call(this.#resourceHostBinding, this.#activeScope, this.ctn<Star>().unsubscribe(resourceType, resourceId));
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
        const sub = this.resources.subscribe(entry.query.typeName, id);
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
    this.lmz.call(this.#resourceHostBinding, this.#activeScope, this.ctn<Star>().unsubscribeQuery(queryHash));
  }

  #subscribeResource(resourceType: string, resourceId: string): Promise<Snapshot | null> {
    const key = `${resourceType}:${resourceId}`;
    this.#subscriptionRegistry.set(key, { resourceType, resourceId });
    return this.#subscribeVia(key, () =>
      this.lmz.call(this.#resourceHostBinding, this.#activeScope,
        this.ctn<Star>().subscribe(this.#ontologyVersion, resourceType, resourceId)));
  }

  /**
   * Write public `Profile` fields (name / nickname / picture) for the session's
   * `profileId` claim — the profile-completion save. Routes on the fixed `PROFILE`
   * binding at that claim (ADR-012); the Profile DO enforces owner-or-admin
   * server-side (`#requireOwnerOrAdmin` — under impersonation the claim names the
   * SUBJECT, so the owner branch never fires and the admin branches decide). The live
   * subscription fans the change to every subscriber, back-filling names on earlier
   * messages.
   */
  updateMyProfile(fields: { name?: string; nickname?: string; picture?: string }): Promise<void> {
    const profileId = this.claims.profileId;
    if (!profileId) throw new Error('updateMyProfile: this session carries no profileId claim');
    return this.lmz.callAsync('PROFILE', profileId,
      this.ctn<ProfileSubscribeTarget>().writeProfile(fields)) as Promise<void>;
  }

  /**
   * Subscribe to a global Profile's PUBLIC fields by `profileId` — the **binding-agnostic** path (callee
   * instance = `profileId`, NOT `activeScope`; the Profile DO is global/cross-scope). Returns a
   * `using`-compatible {@link ResourceSubscription}: `.snapshot` resolves with the initial snapshot on the
   * first `handleProfileUpdate`; `[Symbol.dispose]()` decrements a per-`profileId` refcount and issues
   * `Profile.unsubscribe` only when the LAST handle releases — so the factory's windowed auto-subscribe
   * (the reactive store's grace→dispose) can actually unwind a profile. DEDICATED channel: profiles use
   * `#profileRefcount` / `#profilePending` / `handleProfileUpdate` and are mirrored to `store.lmz.profiles`
   * by the factory listener — never the resource keyspace, so a dev-user ontology type named `Profile`
   * can't collide. tasks/archive/nebula-subscriber-lists.md.
   */
  subscribeProfile(profileId: string): ResourceSubscription {
    this.#profileRefcount.set(profileId, (this.#profileRefcount.get(profileId) ?? 0) + 1);
    const snapshot = this.#subscribeVia(
      profileId,
      () => this.lmz.call('PROFILE', profileId, this.ctn<ProfileSubscribeTarget>().subscribe()),
      this.#profilePending,
    );
    let disposed = false;
    return {
      snapshot,
      [Symbol.dispose]: (): void => {
        if (disposed) return; // per-handle idempotent
        disposed = true;
        this.#disposeProfileSubscription(profileId);
      },
    };
  }

  /**
   * Release a profile subscription — equivalent to one `[Symbol.dispose]()` on a `subscribeProfile`
   * handle. Decrements the per-`profileId` refcount; on the last release drops the local entry then
   * issues `Profile.unsubscribe` (routed to **PROFILE**, NOT the Star). Shared by the handle's
   * `[Symbol.dispose]()`.
   */
  unsubscribeProfile(profileId: string): void {
    this.#disposeProfileSubscription(profileId);
  }

  #disposeProfileSubscription(profileId: string): void {
    const n = this.#profileRefcount.get(profileId) ?? 0;
    if (n > 1) { this.#profileRefcount.set(profileId, n - 1); return; } // other handles still hold it open
    this.#profileRefcount.delete(profileId);
    this.lmz.call('PROFILE', profileId, this.ctn<ProfileSubscribeTarget>().unsubscribe());
  }

  /**
   * Subscribe to the live subscriber-LIST roster of `query` — the STANDALONE watcher subscription (roster
   * only; does NOT subscribe to the query's DATA). Returns a `using`-compatible {@link SubscriberListSubscription}
   * whose `ready` resolves on the first roster push; the roster lands in the reactive store at the
   * query-in-path `store.lmz.querySubscribers.<typeName>.<field>[value]` via the factory listener.
   * Refcounted (a 2nd subscribe of the same canonical query coalesces) + reconnect-safe (re-fired by
   * `#resubscribeAll`). Routes to the active-scope host (Star/Galaxy). tasks/nebula-subscriber-lists.md.
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
      this.lmz.call(this.#resourceHostBinding, this.#activeScope,
        this.ctn<Star>().subscribeQuerySubscribers(query));
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
    this.lmz.call(this.#resourceHostBinding, this.#activeScope,
      this.ctn<Star>().unsubscribeQuerySubscribers(queryHash));
  }

  /**
   * Shared subscribe plumbing (binding-agnostic): coalesce with an in-flight subscribe for `key` in the
   * given `pending` map, else register a pending entry and `fire()` the subscribe call. Extracted so the
   * Star-resource path (`#pendingSubscribes`) and the dedicated global-Profile path (`#profilePending`)
   * share the pending/coalesce logic — only the callee binding+instance and the pending map differ.
   */
  #subscribeVia(
    key: string,
    fire: () => void,
    pending: Map<string, PendingSubscribe> = this.#pendingSubscribes,
  ): Promise<Snapshot | null> {
    // Coalesce with an in-flight subscribe for the same key. Capture the entry's CURRENT resolve/reject
    // as plain function values (not via the entry object) — aliasing the object would make the chained
    // closure read the newly-installed function back through itself, recursing.
    const inFlight = pending.get(key);
    if (inFlight) {
      return new Promise<Snapshot | null>((resolve, reject) => {
        const prevResolve = inFlight.resolve;
        const prevReject = inFlight.reject;
        inFlight.resolve = (snap) => { prevResolve(snap); resolve(snap); };
        inFlight.reject = (err) => { prevReject(err); reject(err); };
      });
    }
    return new Promise<Snapshot | null>((resolve, reject) => {
      pending.set(key, { resolve, reject });
      fire();
    });
  }

  #readResource(
    resourceType: string,
    resourceId: string,
    options?: ReadOptions,
  ): Promise<Snapshot | null> {
    // `resourceType` is currently not used over the wire: `Resources.read`
    // keys on `resourceId` alone (storage assumes globally unique resourceIds
    // per Star). Kept in the client signature for API symmetry with
    // subscribe/transaction and for future addressing changes.
    void resourceType;
    const version = options?.ontologyVersion ?? this.#ontologyVersion;
    // `callAsync` returns the snapshot (framework fire-back, D5 pattern (a)) — resilient across
    // reconnect/freeze, bounded by the default timeout. Concurrent reads are correlated by the
    // primitive's `callId`. On a stale version `Star.read` throws `OntologyStaleError` → the reject
    // path fires `onShouldRefreshUI` (relocated from the old push handler) before re-rejecting —
    // except an `installing` stale (the host is mid-lazy-pull), which retries the idempotent read.
    const attempt = (options as { installingAttempt?: number } | undefined)?.installingAttempt ?? 0;
    return this.lmz.callAsync<Snapshot | null>(this.#resourceHostBinding, this.#activeScope,
      this.ctn<Star>().read(version, resourceId),
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
   * Fire the `onShouldRefreshUI` constructor hook (if registered) with the
   * staleness info. Swallows user-callback throws so an erroring hook can't
   * take the framework down.
   *
   * When the inbound error's `clientVersion` is empty, substitute the client's
   * own pinned version. This is load-bearing for the Phase 5.3.4b push-on-clear
   * path: Star doesn't store per-subscriber `clientVersion` on the Subscribers
   * row, so the `OntologyStaleError` it sends carries an empty `clientVersion`.
   * The Handler-1 mismatch paths (transaction / read / subscribe) always carry
   * a real client version, so the substitution is a no-op for those.
   */
  #dispatchOntologyStale(clientVersion: string, currentVersion: string): void {
    if (!this.#onShouldRefreshUI) return;
    try {
      this.#onShouldRefreshUI({
        reason: 'ontology-stale',
        clientVersion: clientVersion || this.#ontologyVersion,
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
   * settled by the re-resolvable RESULT (D16/D17): resolves with the mutation's value (`createNode`
   * → nodeId; other mutators → undefined) or rejects with its Error (e.g. permission denied). Resilient
   * by construction (survives WS reconnect + tab freeze) and bounded by `callAsync`'s default timeout,
   * so a lost RESULT rejects rather than hanging. No per-call `requestId` / settler handler — the
   * primitive owns correlation + dedup.
   */
  #orgTreeMutate(remote: any): Promise<any> {
    return this.lmz.callAsync(this.#resourceHostBinding, this.#activeScope, remote);
  }

  /**
   * Receive a resource snapshot push from Star (initial subscribe snapshot or
   * a later broadcast fanout).
   *
   * Two interleaved jobs:
   *   1. Write the snapshot to the store via the engine's `notifyFanout`, which
   *      implements the hold-pending-fanouts contract — a push that lands while
   *      the resource has pending optimistic state is held (not clobbering the
   *      user's in-progress edit) until the next submit's conflict resolution.
   *   2. Settle the originating `subscribe(rt, rid)` Promise if one is pending
   *      (first-call-wins).
   *
   * `result === null` means the resource is genuinely absent (subscribe-before-
   * create); nothing is written (the store slot stays undefined). Soft-deleted
   * resources arrive as a real Snapshot with `meta.deleted: true` and flow
   * through `notifyFanout` like any other push.
   */
  @mesh()
  handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | null | Error): void {
    const key = `${resourceType}:${resourceId}`;
    const pending = this.#pendingSubscribes.get(key);

    if (result instanceof Error) {
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

    // Write-through via the engine (hold-pending-fanouts). `null` (never-created)
    // writes nothing — the slot stays undefined until a real snapshot arrives.
    if (result !== null) {
      this.#engine.notifyFanout(resourceType, resourceId, result as unknown as EngineSnapshot);
      // Reconcile-by-id (Child 3 option (b)): the durable Message superseded any
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
   * Receive a global-Profile snapshot push from the Profile DO — the initial `subscribeProfile` snapshot
   * or a later fanout. A **dedicated** channel (not `handleResourceUpdate`), correlated by bare `profileId`
   * so the platform profile never shares the resource keyspace with a dev-user ontology type named
   * `Profile`. Two jobs (mirrors `handleResourceUpdate`): mirror the snapshot into the store via the
   * factory's `#profileListener` (→ `store.lmz.profiles[profileId]`) and settle a pending
   * `subscribeProfile().snapshot` (first-call-wins). `result === null` (absent profile) writes nothing.
   * An Error rejects the pending Promise (no state write). `@mesh()` — a remotely dispatched Gateway push.
   */
  @mesh()
  handleProfileUpdate(profileId: string, result: Snapshot | null | Error): void {
    const pending = this.#profilePending.get(profileId);
    if (result instanceof Error) {
      if (pending) { this.#profilePending.delete(profileId); pending.reject(result); }
      return;
    }
    if (result !== null) this.#profileListener?.(profileId, result);
    if (pending) { this.#profilePending.delete(profileId); pending.resolve(result); }
  }

  /**
   * Receive an org-tree snapshot from Star — the initial `subscribeTree`
   * snapshot or a `#onDagChanged` broadcast (originator included). Forwards the
   * tree state to the factory's registered listener, which mirrors it to
   * `store.lmz.orgTree.value`. The tree is delivered on a dedicated channel (not
   * a resource), so this is wholly separate from `handleResourceUpdate`.
   */
  @mesh()
  handleOrgTreeUpdate(envelope: { value: DagTreeState }): void {
    this.#orgTreeListener?.(envelope.value);
  }

  /**
   * Receive a query-membership push from the host (Child 2) — the initial
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
  @mesh()
  handleQueryUpdate(queryHash: string, result: QueryUpdatePayload | Error): void {
    const entry = this.#queryEntries.get(queryHash);
    if (!entry) return;
    if (result instanceof Error) {
      if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.reject(result); }
      return;
    }
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
   * query + optional name) and settle `ready`. On an Error: reject `ready`. `@mesh()` — a Gateway push.
   */
  @mesh()
  handleQuerySubscribersUpdate(queryHash: string, result: SubscriberRosterPayload | Error): void {
    const entry = this.#querySubscriberEntries.get(queryHash);
    if (!entry) return;
    if (result instanceof Error) {
      if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.reject(result); }
      return;
    }
    this.#querySubscribersListener?.({ queryHash, query: entry.query, roster: result });
    if (!entry.ready.settled) { entry.ready.settled = true; entry.ready.resolve(); }
  }

  /**
   * Receive a dev-preview reload signal from the Star (`Star.broadcastReload`). The
   * channel is kept for the **publish-refresh signal** — its former trigger
   * (`DevStar.compileSFC`) was retired in Phase 4 (vite owns compile); publish will
   * fan this out so live previews re-fetch. Invokes the optional `onReload` hook
   * (the preview wires `() => window.location.reload()`); a non-preview client
   * without the hook ignores it. `@mesh()` because the signal arrives via
   * `svc.broadcast` through the Gateway.
   */
  @mesh()
  handleReload(): void {
    this.#onReload?.();
  }

  /**
   * Receive a transient assistant-progress chunk for `messageId` (Child 3 option (b)).
   * Server→client direct delivery (`svc.broadcast` from the Galaxy, addressed to this
   * client's stable `instanceName`) as the codegen loop makes progress. Accumulates
   * into the ephemeral {@link #streamingMessages} cache + fires the optional live hook.
   * NOT durable: reconciled away when the durable `Message` lands ({@link handleResourceUpdate}),
   * or lost on reload (the durable Message restores via the query sub). `@mesh()` — a
   * remotely dispatched Gateway push, like `handleQueryUpdate`/`handleResourceUpdate`.
   */
  @mesh()
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

  /** Register the live-progress hook (the UI renders each accumulated chunk). Phase-5
   *  UI seam; headless clients (tests) read {@link streamingProgress} instead. */
  setOnStreamChunk(hook: (messageId: string, progress: string, replyTo?: string) => void): void {
    this.#onStreamChunk = hook;
  }

  /**
   * The chat host pair, or a LOUD throw when unset — the guard that kills the silent
   * misroute (a chat path falling back to the resource pair would land the user
   * `Message` on the Star's plane and Phase 4's subscription would watch the wrong
   * host). Construct the client with `chatHostBinding: 'GALAXY', chatScope: '{u}.{g}'`
   * to chat.
   */
  #chatHost(): { binding: string; scope: string } {
    if (!this.#chatHostBinding || !this.#chatScope) {
      throw new Error(
        'This client has no chat host: construct it with chatHostBinding + chatScope ' +
        "(chat lives on GALAXY at the {u}.{g} tier) — chat never falls back to the resource pair.",
      );
    }
    return { binding: this.#chatHostBinding, scope: this.#chatScope };
  }

  // (`chat()` is GONE — the committed human `Message` IS the codegen trigger since the
  // collapse: the send is {@link postUserMessage}, the Galaxy's commit hook starts the
  // turn under the poster's own authority, and completion arrives on the `Message`
  // subscription — which also re-derives on reconnect and reload, so there is no
  // one-shot delivery machinery to strand.)

  /**
   * Post a human `Message` to the pre-alpha chat — a single atomic create on the CHAT
   * host's data plane (the chat pair — throws without one). ⚠️ Writes NO identity
   * fields: attribution comes entirely from the server-stamped `meta.actingToken`
   * (`sub` + `profileId` from the writer's verified JWT), which is what makes author
   * spoofing impossible — a client-written `author`/`role` would be a second, forgeable
   * source of truth. Returns the client-minted message id (idempotency, ADR-010); the
   * agent reply links back to it via `replyTo`. Rides the
   * `Message where chat==DEFAULT_CHAT_ID` query, so the sender AND every other
   * subscriber see it via the fanout (no optimistic echo). `chat` calls this before
   * kicking codegen; a non-codegen participant can call it directly to just chat.
   */
  async postUserMessage(content: string): Promise<string> {
    const { binding, scope } = this.#chatHost();
    const messageId = crypto.randomUUID();
    const newETag = crypto.randomUUID();
    // The Galaxy's Handler-1 returns an OntologyStaleError as a VALUE on a version
    // mismatch (Star's asymmetry); everything else is the ordinary TransactionResult.
    const result = await this.lmz.callAsync(
      binding, scope,
      this.ctn<Galaxy>().transaction(this.#ontologyVersion, newETag, {
        [messageId]: {
          op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID,
          value: { chat: DEFAULT_CHAT_ID, content },
        },
      }),
    ) as TransactionResult | Error;
    if (result instanceof Error) throw result;
    if (!result.ok) {
      throw new Error(`postUserMessage failed: ${JSON.stringify(result.errors)}`);
    }
    return messageId;
  }

  /**
   * Ask the Galaxy to signal the preview can load (post-collapse there is nothing to warm
   * for viewing — dist/ serves from the Galaxy's own VFS), so the
   * UI can auto-refresh the iframe (no manual Reload). Fire-and-forget (NOT awaited
   * `callRaw`) — the container boot is long and the readiness comes back via the
   * {@link handlePreviewReady} push (direct delivery by this client's stable
   * `instanceName`), so it survives a WS reconnect during the boot. Passes its own
   * `instanceName` explicitly as the reply target.
   */
  warmPreview(): void {
    const clientId = this.lmz.instanceName;
    const { binding, scope } = this.#chatHost();
    this.lmz.call(binding, scope, this.ctn<Galaxy>().warmPreview(clientId));
  }

  /**
   * Receive the Galaxy's "preview is serving" signal (direct delivery, addressed to this
   * client's `instanceName`). Invokes the `onPreviewReady` hook so the UI can refresh
   * the preview iframe. `@mesh()` because it arrives over the Gateway like the other pushes.
   */
  @mesh()
  handlePreviewReady(scope: string): void {
    this.#onPreviewReady?.(scope);
  }

  // No onBeforeCall override — NebulaClient inherits the base LumenizeClient default, which blocks
  // only a DIRECT client→client call (immediate caller is another client) and accepts DO/Worker-
  // mediated pushes (Star fanout, transaction/read result). Nebula does no direct client→client, and
  // the real cross-scope boundary is NebulaClientGateway.onBeforeCallToClient (the same-aud fence).
}

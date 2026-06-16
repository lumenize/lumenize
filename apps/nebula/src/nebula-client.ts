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
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { debug } from '@lumenize/debug';
import { isOntologyStaleError } from './errors';
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
import type { DagTreeState, PermissionTier } from './dag-ops';
import type { Star } from './star';

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
  /** Override the constructor's `appVersion` for this call (admin/scripting only). */
  appVersion?: string;
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
  /** Override the constructor's `appVersion` for this call. */
  appVersion?: string;
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
  appVersion: string;
  /**
   * Optional hook invoked when the server signals the client's ontology
   * version is stale (deploys happened since this client started). Typical
   * implementation: `() => window.location.reload()`. No default — undefined
   * means opted-out, in which case the staleness signal still surfaces via
   * the originating Promise's `{ resolution: 'ontology-stale' }` outcome.
   */
  onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
}

type SubscribeKey = string; // `${resourceType}:${resourceId}`

interface PendingSubscribe {
  resolve: (snapshot: Snapshot | null) => void;
  reject: (error: Error) => void;
}

interface PendingRead {
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

export class NebulaClient extends LumenizeClient<NebulaJwtPayload> {
  #authScope: string;
  #activeScope: string;
  #appVersion: string;
  #onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
  // Captured for `logout()` (the embedded refresh closure reads them too, but a
  // method can't reach the constructor's `config`). `#baseUrl` may be undefined
  // when the browser auto-detects it for the WS URL — logout falls back to the
  // current origin in that case.
  #baseUrl?: string;
  #fetchFn: typeof fetch;

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

  /**
   * Serial mesh-submit gate. `handleTransactionResult` is an uncorrelated
   * single callback channel, so at most one mesh transaction is in flight; the
   * engine's per-resource queue can request concurrent submissions, which queue
   * FIFO here. On reconnect the gate is cleared — the engine replays in-flight
   * work with the same `newETag` (server replay is idempotent).
   */
  #submitGate: Array<{ subs: QueueSubmission[]; resolve: (r: ServerBatchResponse) => void; reject: (e: unknown) => void }> = [];
  #inFlightSubmit: { subs: QueueSubmission[]; resolve: (r: ServerBatchResponse) => void; reject: (e: unknown) => void } | null = null;

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
   * In-flight `read(rt, rid)` Promises, correlated by `requestId`. Each
   * concurrent read gets its own UUID; the server returns the same id via
   * `handleReadResponse(requestId, result)` which settles the matching entry.
   */
  #pendingReads = new Map<string, PendingRead>();

  constructor(config: NebulaClientConfig) {
    const {
      authScope,
      activeScope,
      appVersion,
      onShouldRefreshUI,
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
      refresh: async () => {
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
        return { access_token: data.access_token, sub: data.sub };
      },
      onConnectionStateChange: (state) => {
        // Phase 5.3.4a: re-subscribe everything on reconnect. The
        // `reconnecting → connected` transition is the precise signal that
        // a network-blip recovery just completed (LumenizeClient stays in
        // `reconnecting` across retry attempts and only flips to `connected`
        // when the WS is back up). The initial-connect transition is
        // `disconnected → connecting → connected`, which we don't treat as
        // a reconnect (registry is empty anyway).
        if (this.#prevConnectionState === 'reconnecting' && state === 'connected') {
          // The in-flight mesh transaction's result may have been lost in the
          // drop; the engine's queue replays it (same newETag) on reconnect, so
          // clear the stale gate — otherwise the replay deadlocks behind a
          // `handleTransactionResult` that never arrives.
          this.#inFlightSubmit = null;
          this.#submitGate.length = 0;
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
          this.lmz.call(this.#starBinding(), this.#activeScope, this.ctn<Star>().subscribeTree());
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
    this.#appVersion = appVersion;
    this.#onShouldRefreshUI = onShouldRefreshUI;
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
  }

  // ─── Serial mesh-submit gate ──────────────────────────────────────────────

  /**
   * The engine's `submitBatch` hook: submit a batch of queue submissions as one
   * atomic mesh transaction and resolve with the raw server facts. Serial — at
   * most one in flight (the `handleTransactionResult` channel is uncorrelated).
   * Concurrent calls (independent resources) queue FIFO.
   */
  #meshSubmit(subs: QueueSubmission[]): Promise<ServerBatchResponse> {
    return new Promise<ServerBatchResponse>((resolve, reject) => {
      this.#submitGate.push({ subs, resolve, reject });
      this.#pumpSubmitGate();
    });
  }

  #pumpSubmitGate(): void {
    if (this.#inFlightSubmit) return;
    const next = this.#submitGate.shift();
    if (!next) return;
    this.#inFlightSubmit = next;
    // One mesh `newETag` per batch (the server writes it as every resource's
    // eTag — resources.ts Step 4.5a); stable across reconnect replays because
    // the engine re-sends the same submissions.
    const meshNewETag = next.subs[0]!.newETag;
    this.lmz.call(this.#starBinding(), this.#activeScope,
      this.ctn<Star>().transaction(this.#appVersion, meshNewETag, this.#buildMeshOps(next.subs)));
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
    for (const { resourceType, resourceId } of this.#subscriptionRegistry.values()) {
      this.lmz.call(this.#starBinding(), this.#activeScope,
        this.ctn<Star>().subscribe(this.#appVersion, resourceType, resourceId));
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
      nodeId: number,
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
  };

  /**
   * Org/permission-tree MUTATIONS (api-reference § client.orgTree). Reads are
   * NOT here — the tree is delivered on its own channel to `store.lmz.orgTree`
   * (auto-subscribed on connect). Each mutator is a generic awaited `callRaw`
   * to Star's `dagTree` entry — reject-on-failure, NO optimistic local
   * write-through (the broadcast echo, originator included, is the only store
   * update path). Intentionally NOT connection-gated like the resource write
   * path: the tree carries no optimistic state to roll back, so a call issued
   * while disconnected queues and sends on reconnect (or rejects on timeout).
   * All mutators are idempotent/retry-safe EXCEPT `createNode` (server-assigned
   * nodeId — a dropped response can't be safely replayed; reload re-syncs).
   */
  readonly orgTree = {
    createNode: (parentNodeId: number, slug: string, label: string): Promise<number> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().createNode(parentNodeId, slug, label)),
    addEdge: (parentNodeId: number, childNodeId: number): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().addEdge(parentNodeId, childNodeId)),
    removeEdge: (parentNodeId: number, childNodeId: number): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().removeEdge(parentNodeId, childNodeId)),
    reparentNode: (childNodeId: number, oldParentId: number, newParentId: number): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().reparentNode(childNodeId, oldParentId, newParentId)),
    deleteNode: (nodeId: number): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().deleteNode(nodeId)),
    undeleteNode: (nodeId: number): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().undeleteNode(nodeId)),
    renameNode: (nodeId: number, newSlug: string): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().renameNode(nodeId, newSlug)),
    relabelNode: (nodeId: number, newLabel: string): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().relabelNode(nodeId, newLabel)),
    setPermission: (nodeId: number, targetSub: string, level: PermissionTier): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().setPermission(nodeId, targetSub, level)),
    revokePermission: (nodeId: number, targetSub: string): Promise<void> =>
      this.lmz.callRaw(this.#starBinding(), this.#activeScope, this.ctn<Star>().dagTree().revokePermission(nodeId, targetSub)),
  };

  /**
   * Select the Star DO binding for the active scope. A 3rd-segment slug of
   * `dev` (`{u}.{g}.dev`) routes to the DevStar sandbox binding; any other star
   * slug routes to the production Star binding. Applied at **every**
   * Star-targeting call (the resource hot path) so a dev-scope client always
   * reaches `DevStar` and a production-scope client always reaches `Star`.
   *
   * Deliberately a **binary choice between two literal binding-name constants**,
   * NOT a case-conversion or an `env` lookup (that's the routing-layer
   * smart-match, a different mechanism) — there are exactly two possible
   * targets, both known at authoring time, so the slug only picks *which*
   * literal. Uses a **local slug check**, not an imported `parseId`:
   * `nebula-client.ts` is browser-bundled and must stay free of
   * `cloudflare:workers` (packaging.md), and a value import of
   * `@lumenize/nebula-auth` would drag the barrel's DO classes into the bundle.
   * `#activeScope` is set at construction and on every scope-switch, so the slug
   * is always known at call time. See tasks/dev-star.md § Naming & binding selection.
   */
  #starBinding(): 'STAR' | 'DEV_STAR' {
    return this.#activeScope.split('.')[2] === 'dev' ? 'DEV_STAR' : 'STAR';
  }

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
    this.lmz.call(this.#starBinding(), this.#activeScope, this.ctn<Star>().unsubscribe(resourceType, resourceId));
  }

  #subscribeResource(resourceType: string, resourceId: string): Promise<Snapshot | null> {
    const key = `${resourceType}:${resourceId}`;

    // Coalesce with an in-flight subscribe for the same key. Capture the
    // entry's CURRENT resolve/reject as plain function values (not via the
    // entry object) — aliasing the object would make the chained closure
    // read the newly-installed function back through itself, recursing.
    const inFlight = this.#pendingSubscribes.get(key);
    if (inFlight) {
      return new Promise<Snapshot | null>((resolve, reject) => {
        const prevResolve = inFlight.resolve;
        const prevReject = inFlight.reject;
        inFlight.resolve = (snap) => { prevResolve(snap); resolve(snap); };
        inFlight.reject = (err) => { prevReject(err); reject(err); };
      });
    }

    this.#subscriptionRegistry.set(key, { resourceType, resourceId });

    return new Promise<Snapshot | null>((resolve, reject) => {
      this.#pendingSubscribes.set(key, { resolve, reject });
      this.lmz.call(this.#starBinding(), this.#activeScope,
        this.ctn<Star>().subscribe(this.#appVersion, resourceType, resourceId));
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
    const requestId = crypto.randomUUID();
    const version = options?.appVersion ?? this.#appVersion;
    return new Promise<Snapshot | null>((resolve, reject) => {
      this.#pendingReads.set(requestId, { resolve, reject });
      this.lmz.call(this.#starBinding(), this.#activeScope,
        this.ctn<Star>().read(version, resourceId, requestId));
    });
  }

  /**
   * Receive a transaction result from Star and settle the in-flight mesh
   * submission (the engine's `submitBatch`). Maps the server's atomic
   * `TransactionResult` to the per-resource `ServerBatchResponse` the engine
   * consumes; an `OntologyStaleError` becomes the engine's `ontologyStale`
   * signal, any other thrown Error rejects so the engine surfaces
   * `infrastructure-error`. The engine owns all resolution + the queue timeout —
   * NebulaClient only relays facts and serializes the uncorrelated wire channel.
   */
  @mesh()
  handleTransactionResult(result: TransactionResult | Error): void {
    const inFlight = this.#inFlightSubmit;
    if (!inFlight) return; // late / spurious arrival (gate already advanced)
    this.#inFlightSubmit = null;
    if (result instanceof Error) {
      if (isOntologyStaleError(result)) {
        inFlight.resolve({
          ontologyStale: { clientVersion: result.clientVersion, currentVersion: result.currentVersion },
        });
      } else {
        inFlight.reject(result); // → engine queue's infrastructure-error
      }
    } else {
      inFlight.resolve(this.#mapTransactionResult(result, inFlight.subs));
    }
    this.#pumpSubmitGate();
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
        clientVersion: clientVersion || this.#appVersion,
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
   * Receive a read response from Star. Settles the matching `requestId`'s
   * pending Promise; concurrent reads are independently correlated.
   *
   * Ontology-stale errors also fire the `onShouldRefreshUI` hook before the
   * Promise rejects — same staleness signal as the transaction path.
   */
  @mesh()
  handleReadResponse(requestId: string, result: Snapshot | null | Error): void {
    const pending = this.#pendingReads.get(requestId);
    if (!pending) return;
    this.#pendingReads.delete(requestId);
    if (result instanceof Error) {
      if (isOntologyStaleError(result)) {
        this.#dispatchOntologyStale(result.clientVersion, result.currentVersion);
      }
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
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
    }

    // Settle pending subscribe Promise (first-call-wins)
    if (pending) {
      this.#pendingSubscribes.delete(key);
      pending.resolve(result);
    }
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
   * Accept calls relayed through Star (fanout, transaction-result, read-result).
   *
   * The default `LumenizeClient.onBeforeCall` rejects calls where `callChain[0]`
   * is another `LumenizeClient` instance (its peer-to-peer guard). Nebula's
   * fanout pattern is **Star-mediated**, not peer-to-peer: client A mutates →
   * Star fans out → client B receives `handleResourceUpdate`. The default's
   * `callChain[0] === otherClient` view of this is too strict.
   *
   * The actual security boundary is `NebulaClientGateway.onBeforeCallToClient`,
   * which verifies the call's `originAuth.claims.aud` matches the connected
   * client's aud at the Gateway. Once a call has cleared that check, it has
   * a legitimate Nebula-scope and can be dispatched on the client.
   */
  override onBeforeCall(): void {
    // intentionally permissive — Gateway aud check is the boundary
  }
}

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
import { LumenizeClient, mesh } from '@lumenize/mesh/client';
import type { LumenizeClientConfig } from '@lumenize/mesh/client';
import type { StateManager } from '@lumenize/state';
import type { OperationDescriptor, TransactionResult, Snapshot, TransactionError } from './resources';
import type { Star } from './star';

export interface OntologyStaleInfo {
  reason: 'ontology-stale';
  clientVersion: string;
  currentVersion: string;
}

/**
 * `client.resources.transaction()` always resolves with this discriminated
 * union — never rejects (except for infrastructure failures which still
 * throw `Error`). Caller switches on `outcome.resolution` to handle every
 * terminal state. See `tasks/nebula-frontend.md` § Types for design rationale.
 *
 * Phase 5.3.3b ships the non-conflict-resolver variants. The resolver-driven
 * `'use-server'`, `'retries-exhausted'`, and `'human-in-the-loop'` paths
 * land in 5.3.3c. Until then, conflicts arrive as the framework default
 * `'use-server'` (write server value, resolve with that outcome).
 */
export type TransactionResolution =
  | { resolution: 'committed'; eTag: string }
  | { resolution: 'use-server'; resources: Record<string, Snapshot> }
  | { resolution: 'human-in-the-loop'; resources: Record<string, Snapshot> }
  | { resolution: 'retries-exhausted'; resources: Record<string, Snapshot>; attempts: number }
  | { resolution: 'validation-failed'; errors: Record<string, unknown> }
  | { resolution: 'permission-denied'; resources: string[] }
  | { resolution: 'ontology-stale'; clientVersion: string; currentVersion: string }
  | { resolution: 'timeout' };

/** Per-call options for `client.resources.transaction()`. */
export interface TransactionOptions {
  /** Override the constructor's `ontologyVersion` for this call (admin/scripting only). */
  ontologyVersion?: string;
  /** Override the auto-generated `newETag` (idempotency-probe / retry scenarios). */
  newETag?: string;
  /**
   * Per-call conflict resolver. Overrides any per-type registered resolver
   * for this transaction. Precedence: per-call > per-type > framework default
   * (`() => ({ resolution: 'use-server' })`).
   */
  onETagConflict?: ConflictResolver;
  /**
   * Per-call override for max recursive `'use-this'` retries before resolving
   * with `'retries-exhausted'`. Falls back to the per-type registered value,
   * then the framework default (5).
   */
  maxRetries?: number;
}

/**
 * Resolver verdict returned from `ConflictResolver`. Discriminant `resolution`
 * intentionally matches `TransactionResolution`'s discriminant so the
 * vocabulary is consistent end-to-end.
 *
 * - `'use-server'`: accept the server's value, abandon local changes.
 * - `'use-this'`: re-submit with `value` and the server's new eTag. Bounded
 *   by `maxRetries` — on cap, the transaction resolves with `'retries-exhausted'`.
 * - `'human-in-the-loop'`: defer to user. Optimistic state stays painted.
 *   Caller is responsible for any follow-up `transaction()` call.
 */
export type ConflictResolution =
  | { resolution: 'use-server' }
  | { resolution: 'use-this'; value: unknown }
  | { resolution: 'human-in-the-loop' };

/**
 * Per-type conflict resolver. Invoked when the server returns an eTag conflict
 * on a `put` op. Receives the local (attempted) value, the server's current
 * snapshot, and a context object (Phase 5.3.6 will populate `context.bindings`
 * with the path → HTMLElement[] map from `bindDom`; 5.3.3c passes an empty Map).
 *
 * Can be sync or async. The in-flight queue's 5–10 s timeout is **suspended**
 * during resolver execution — a modal can sit open for minutes without
 * triggering `'timeout'`.
 */
export type ConflictResolver = (
  local: { value: unknown; eTag: string },
  server: Snapshot,
  context: { bindings: Map<string, HTMLElement[]> },
) => ConflictResolution | Promise<ConflictResolution>;

/** Options for `client.resources.onETagConflict(rt, resolver, options?)`. */
export interface ETagConflictOptions {
  /** Max recursive `'use-this'` retries before `'retries-exhausted'`. Default 5. */
  maxRetries?: number;
  /**
   * CSS class to flash on bound elements at fields where the resolved value
   * differs from `local.value`. Phase 5.3.6 wires this through `bindDom`.
   * Stored on the registration here so 5.3.6 can read it.
   */
  flashClass?: string | null;
  /** Flash duration in ms. Phase 5.3.6 reads this. Default 1000. */
  flashDuration?: number;
}

interface RegisteredResolver {
  resolver: ConflictResolver;
  options: Required<Omit<ETagConflictOptions, 'flashClass'>> & { flashClass: string | null };
}

/** Framework default — server-wins. */
const DEFAULT_RESOLVER: ConflictResolver = () => ({ resolution: 'use-server' });
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_FLASH_CLASS = 'lumenize-conflict-revert';
const DEFAULT_FLASH_DURATION_MS = 1000;

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
   * Ontology version this client was built against. Auto-attached to every
   * `client.resources.*` call. Studio bakes this in at app build time.
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

interface QueuedTransaction {
  ops: Record<string, OperationDescriptor>;
  newETag: string;
  ontologyVersion: string;
  /** Caller's resolver override (highest precedence). */
  onETagConflict?: ConflictResolver;
  /** Caller's maxRetries override; per-type or default if unset. */
  maxRetries?: number;
  /**
   * Attempt counter — 1 on initial submission, incremented on each
   * `'use-this'` resubmit. Compared against the resolved `maxRetries` value
   * to decide between recursive retry and `'retries-exhausted'`.
   */
  attempt: number;
  resolve: (outcome: TransactionResolution) => void;
}

/** Default in-flight transaction timeout (ms). */
const TRANSACTION_TIMEOUT_MS = 10_000;

export class NebulaClient extends LumenizeClient {
  #authScope: string;
  #activeScope: string;
  #ontologyVersion: string;
  #onShouldRefreshUI?: (info: OntologyStaleInfo) => void;

  /** Bound StateManager — set by `bindToState()`. `handleResourceUpdate` is a
   *  no-op for state when null (Promise correlation still works). */
  #state: StateManager | null = null;

  /**
   * Active subscriptions registry. Used by Phase 5.3.4 auto-resubscribe on
   * reconnect, and (in 5.3.6) by refcount-with-grace. For 5.3.3a the entry
   * is minimal — just enough to know what's subscribed.
   */
  #subscriptionRegistry = new Map<SubscribeKey, { resourceType: string; resourceId: string }>();

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

  /**
   * Serial transaction queue (Phase 5.3.3b decision). At most one in-flight
   * transaction; subsequent calls queue. `#inFlightTxn` is the currently-
   * submitted transaction awaiting `handleTransactionResult`. Timer kills
   * stuck transactions and resolves them as `{ resolution: 'timeout' }`.
   */
  #txnQueue: QueuedTransaction[] = [];
  #inFlightTxn: QueuedTransaction | null = null;
  #inFlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** Per-type conflict resolvers registered via `onETagConflict`. */
  #perTypeResolvers = new Map<string, RegisteredResolver>();

  constructor(config: NebulaClientConfig) {
    const { authScope, activeScope, ontologyVersion, onShouldRefreshUI, ...baseConfig } = config;

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
        if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
        const data = await res.json() as { access_token: string; sub: string };
        return { access_token: data.access_token, sub: data.sub };
      },
    });

    this.#authScope = authScope;
    this.#activeScope = activeScope;
    this.#ontologyVersion = ontologyVersion;
    this.#onShouldRefreshUI = onShouldRefreshUI;
  }

  /**
   * Bind a `StateManager` so resource updates write through to
   * `resources.{rt}.{rid}.value` and `resources.{rt}.{rid}.meta`.
   *
   * Phase 5.3.3a — minimal-binding form: just registers the store reference.
   * Phase 5.3.6 will expand this method to install the local-writes →
   * remote-transactions `setState` middleware, auto-subscribe-via-refcount,
   * unsubscribe-with-grace, and connection-state surfacing at `lmz.connection.*`.
   * Callers should keep using `bindToState` — the name is stable; the
   * functionality grows in place.
   */
  bindToState(state: StateManager): void {
    this.#state = state;
  }

  /** Resource namespace — entry point for subscribe / read / transaction. */
  readonly resources = {
    /**
     * Subscribe to a resource. Resolves with the initial snapshot on the
     * first `handleResourceUpdate` for `(rt, rid)`. Subsequent updates are
     * fanout pushes that write through to bound state but do not re-resolve.
     *
     * If a pending subscribe for the same `(rt, rid)` already exists, the
     * returned Promise piggybacks on that pending settlement instead of
     * issuing a duplicate request — Star's `INSERT OR REPLACE` would no-op
     * anyway, and clients calling subscribe multiple times for the same key
     * should observe a single first-snapshot resolve.
     */
    subscribe: (resourceType: string, resourceId: string): Promise<Snapshot | null> => {
      return this.#subscribeResource(resourceType, resourceId);
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
     * Submit a transaction. Always resolves with `TransactionResolution`;
     * caller switches on `outcome.resolution`. Throws only for infrastructure
     * failures (network drops, mesh crashes).
     *
     * `newETag` is auto-generated (one per call, shared across all resources
     * in the batch). Pass `options.newETag` to override — needed for the
     * idempotency-retry pattern where a dropped response is retried with
     * the original eTag.
     */
    transaction: (
      ops: Record<string, OperationDescriptor>,
      options?: TransactionOptions,
    ): Promise<TransactionResolution> => {
      return this.#submitTransaction(ops, options);
    },

    /**
     * Register a conflict resolver for `resourceType`. Returns `void`; later
     * registrations replace earlier ones (per-type, single resolver).
     *
     * Precedence at conflict time: per-call `options.onETagConflict` >
     * per-type registered > framework default (`'use-server'`).
     */
    onETagConflict: (
      resourceType: string,
      resolver: ConflictResolver,
      options?: ETagConflictOptions,
    ): void => {
      this.#perTypeResolvers.set(resourceType, {
        resolver,
        options: {
          maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
          flashClass: options?.flashClass === null
            ? null
            : (options?.flashClass ?? DEFAULT_FLASH_CLASS),
          flashDuration: options?.flashDuration ?? DEFAULT_FLASH_DURATION_MS,
        },
      });
    },
  };

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
      this.lmz.call('STAR', this.#activeScope,
        this.ctn<Star>().subscribe(this.#ontologyVersion, resourceType, resourceId));
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
    const version = options?.ontologyVersion ?? this.#ontologyVersion;
    return new Promise<Snapshot | null>((resolve, reject) => {
      this.#pendingReads.set(requestId, { resolve, reject });
      this.lmz.call('STAR', this.#activeScope,
        this.ctn<Star>().read(version, resourceId, requestId));
    });
  }

  #submitTransaction(
    ops: Record<string, OperationDescriptor>,
    options?: TransactionOptions,
  ): Promise<TransactionResolution> {
    return new Promise<TransactionResolution>((resolve) => {
      const queued: QueuedTransaction = {
        ops,
        newETag: options?.newETag ?? crypto.randomUUID(),
        ontologyVersion: options?.ontologyVersion ?? this.#ontologyVersion,
        onETagConflict: options?.onETagConflict,
        maxRetries: options?.maxRetries,
        attempt: 1,
        resolve,
      };
      this.#txnQueue.push(queued);
      this.#pumpTxnQueue();
    });
  }

  #pumpTxnQueue(): void {
    if (this.#inFlightTxn) return; // already submitted; wait for handleTransactionResult
    const next = this.#txnQueue.shift();
    if (!next) return;

    this.#inFlightTxn = next;
    this.#inFlightTimer = setTimeout(() => {
      // Timeout — resolve the in-flight Promise with timeout outcome,
      // clear in-flight, drain the queue. The server's eventual response
      // (if it ever arrives) is dropped by `handleTransactionResult`.
      const stuck = this.#inFlightTxn;
      this.#inFlightTxn = null;
      this.#inFlightTimer = null;
      if (stuck) stuck.resolve({ resolution: 'timeout' });
      this.#pumpTxnQueue();
    }, TRANSACTION_TIMEOUT_MS);

    this.lmz.call('STAR', this.#activeScope,
      this.ctn<Star>().transaction(next.ontologyVersion, next.newETag, next.ops));
  }

  /**
   * Receive transaction result from Star. Routes synchronous outcomes
   * through `#finalize` and asynchronous conflict-resolver outcomes through
   * `#handleConflict`. The in-flight queue's timeout is cleared on arrival;
   * during resolver execution the queue stays blocked (we know what's
   * happening — the user has a modal — so no timeout is enforced).
   */
  @mesh()
  handleTransactionResult(result: TransactionResult | Error): void {
    const inFlight = this.#inFlightTxn;
    if (!inFlight) return; // late arrival after timeout — drop
    if (this.#inFlightTimer !== null) {
      clearTimeout(this.#inFlightTimer);
      this.#inFlightTimer = null;
    }

    // Conflict-only path: route through async resolver. Other outcomes
    // (committed, validation-failed, permission-denied, ontology-stale,
    // infrastructure error) are synchronous.
    if (!(result instanceof Error) && !result.ok) {
      const types = new Set(Object.values(result.errors).map((e) => e.type));
      if (types.has('conflict') && !types.has('validation') && !types.has('permission')) {
        // Fire-and-forget — handler advances queue after resolver settles.
        this.#handleConflict(inFlight, result).catch(() => {
          // Resolver / framework error during conflict handling — fall back
          // to use-server with whatever conflicts we have visible.
          this.#finalize(inFlight, this.#useServerOutcome(result));
        });
        return;
      }
    }

    this.#finalize(inFlight, this.#mapSynchronousOutcome(inFlight, result));
  }

  /**
   * Settle the in-flight transaction with `outcome` and pump the queue.
   * Single source of truth for "I'm done with this transaction"; conflict
   * paths converge here after the resolver verdict has been processed.
   */
  #finalize(inFlight: QueuedTransaction, outcome: TransactionResolution): void {
    this.#inFlightTxn = null;
    inFlight.resolve(outcome);
    this.#pumpTxnQueue();
  }

  /**
   * Synchronous outcome mapping for committed / validation-failed /
   * permission-denied / ontology-stale / infrastructure-error paths.
   * Conflicts route through `#handleConflict` instead.
   */
  #mapSynchronousOutcome(
    inFlight: QueuedTransaction,
    result: TransactionResult | Error,
  ): TransactionResolution {
    if (result instanceof Error) {
      // Detect ontology-stale via message pattern. Phase 5.3.3d will
      // replace this with a structured signal at the Star → Client boundary.
      const m = result.message.match(/Ontology version mismatch: client sent '([^']+)' but latest is '([^']+)'/);
      if (m) {
        const info = { reason: 'ontology-stale' as const, clientVersion: m[1], currentVersion: m[2] };
        if (this.#onShouldRefreshUI) {
          try { this.#onShouldRefreshUI(info); } catch { /* swallow user-callback throws */ }
        }
        return { resolution: 'ontology-stale', clientVersion: m[1], currentVersion: m[2] };
      }
      void inFlight;
      return { resolution: 'timeout' };
    }

    if (result.ok) {
      return { resolution: 'committed', eTag: inFlight.newETag };
    }

    const errors = result.errors;
    const errorTypes = new Set(Object.values(errors).map((e) => e.type));

    if (errorTypes.has('validation')) {
      const validationErrors: Record<string, unknown> = {};
      for (const [rid, err] of Object.entries(errors)) {
        if (err.type === 'validation') validationErrors[rid] = err.errors;
      }
      return { resolution: 'validation-failed', errors: validationErrors };
    }

    if (errorTypes.has('permission')) {
      const resources = Object.entries(errors)
        .filter(([, err]) => err.type === 'permission')
        .map(([rid]) => rid);
      return { resolution: 'permission-denied', resources };
    }

    // Mixed errors (conflict + validation, etc.) shouldn't reach here —
    // handleTransactionResult's branch checks for conflict-ONLY before
    // dispatching to async path. Defensive fall-through to use-server.
    return this.#useServerOutcome(result);
  }

  /**
   * Build a `use-server` outcome from a conflict-bearing result. Writes
   * server snapshots through to bound state. Used by the framework-default
   * resolver path AND as a fallback when async resolver flow errors out.
   */
  #useServerOutcome(result: { ok: false; errors: Record<string, TransactionError> }): TransactionResolution {
    const serverResources: Record<string, Snapshot> = {};
    for (const [rid, err] of Object.entries(result.errors)) {
      if (err.type === 'conflict') serverResources[rid] = err.currentSnapshot;
    }
    if (this.#state) {
      for (const [rid, snap] of Object.entries(serverResources)) {
        const basePath = `resources.${snap.meta.typeName}.${rid}`;
        this.#state.setState(`${basePath}.value`, snap.value);
        this.#state.setState(`${basePath}.meta`, snap.meta);
      }
    }
    return { resolution: 'use-server', resources: serverResources };
  }

  /**
   * Async conflict-resolver flow. Picks the resolver per precedence
   * (per-call > per-type > framework default), invokes it (sync or async),
   * and acts on the returned `ConflictResolution`:
   *
   * - `'use-server'`: write server.value through bound state, resolve
   *   transaction with `'use-server'`.
   * - `'use-this'`: build a new ops batch using server's new eTag for
   *   conflicted resources + resolver's value; re-submit (recursive,
   *   bounded by `maxRetries`).
   * - `'human-in-the-loop'`: resolve transaction with the handoff outcome;
   *   optimistic state stays painted (no write-through here).
   *
   * Resolver receives info about the FIRST conflicting resource. For
   * single-resource transactions (typical UI case) this is unambiguous;
   * for multi-resource transactions with mixed types, the per-call override
   * is the right tool (one resolver covers all).
   */
  async #handleConflict(
    inFlight: QueuedTransaction,
    result: { ok: false; errors: Record<string, TransactionError> },
  ): Promise<void> {
    const conflictResources: Record<string, Snapshot> = {};
    for (const [rid, err] of Object.entries(result.errors)) {
      if (err.type === 'conflict') conflictResources[rid] = err.currentSnapshot;
    }
    const firstConflictRid = Object.keys(conflictResources)[0];
    const firstServer = conflictResources[firstConflictRid];
    const firstType = firstServer.meta.typeName;

    // Resolve precedence: per-call > per-type > default
    const registered = this.#perTypeResolvers.get(firstType);
    const resolver: ConflictResolver = inFlight.onETagConflict
      ?? registered?.resolver
      ?? DEFAULT_RESOLVER;
    const maxRetries = inFlight.maxRetries
      ?? registered?.options.maxRetries
      ?? DEFAULT_MAX_RETRIES;

    // Build `local` from the original op (only `put` carries a value; for
    // non-put conflicts we still call the resolver with `value: undefined`
    // and the op's eTag).
    const originalOp = inFlight.ops[firstConflictRid];
    const localValue: unknown = (originalOp && (originalOp.op === 'put' || originalOp.op === 'create'))
      ? originalOp.value
      : undefined;
    const localETag: string = (originalOp && 'eTag' in originalOp) ? originalOp.eTag : '';

    let verdict: ConflictResolution;
    try {
      verdict = await resolver(
        { value: localValue, eTag: localETag },
        firstServer,
        { bindings: new Map() }, // Phase 5.3.6 will populate from bindDom
      );
    } catch {
      // Resolver itself errored — default to use-server.
      this.#finalize(inFlight, this.#useServerOutcome(result));
      return;
    }

    switch (verdict.resolution) {
      case 'use-server':
        this.#finalize(inFlight, this.#useServerOutcome(result));
        return;

      case 'human-in-the-loop':
        // Optimistic state stays painted — do NOT write server.value through.
        this.#finalize(inFlight, { resolution: 'human-in-the-loop', resources: conflictResources });
        return;

      case 'use-this': {
        // Bounded recursion: increment attempt; cap → retries-exhausted.
        const nextAttempt = inFlight.attempt + 1;
        if (nextAttempt > maxRetries) {
          this.#finalize(inFlight, {
            resolution: 'retries-exhausted',
            resources: conflictResources,
            attempts: inFlight.attempt,
          });
          return;
        }
        // Rebuild ops: replace the conflicted resource's op with a put using
        // server's new eTag + resolver's value. Other ops in the batch keep
        // their original eTags (if they also conflicted they'll re-route
        // through the resolver on the next round-trip).
        const newOps: Record<string, OperationDescriptor> = { ...inFlight.ops };
        newOps[firstConflictRid] = {
          op: 'put',
          eTag: firstServer.meta.eTag,
          value: verdict.value,
        };
        // Fresh newETag for the retry (idempotency key is per-attempt).
        inFlight.ops = newOps;
        inFlight.newETag = crypto.randomUUID();
        inFlight.attempt = nextAttempt;
        // Re-submit. Restart the timeout; the queue stays blocked.
        this.#inFlightTimer = setTimeout(() => {
          const stuck = this.#inFlightTxn;
          this.#inFlightTxn = null;
          this.#inFlightTimer = null;
          if (stuck) stuck.resolve({ resolution: 'timeout' });
          this.#pumpTxnQueue();
        }, TRANSACTION_TIMEOUT_MS);
        this.lmz.call('STAR', this.#activeScope,
          this.ctn<Star>().transaction(inFlight.ontologyVersion, inFlight.newETag, inFlight.ops));
        return;
      }
    }
  }

  /**
   * Receive a read response from Star. Settles the matching `requestId`'s
   * pending Promise; concurrent reads are independently correlated.
   */
  @mesh()
  handleReadResponse(requestId: string, result: Snapshot | null | Error): void {
    const pending = this.#pendingReads.get(requestId);
    if (!pending) return;
    this.#pendingReads.delete(requestId);
    if (result instanceof Error) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  }

  /**
   * Receive resource snapshot push from Star.
   *
   * Two interleaved jobs:
   *   1. Settle the originating `subscribe(rt, rid)` Promise if one is pending
   *      for this key (first-call-wins semantic).
   *   2. Write through to bound StateManager if one is registered. Single
   *      atomic write at `resources.{rt}.{rid}.value` + `.meta`; deep-binding
   *      directives reactivate via JurisJS hierarchical-notify + deep-equals
   *      dedup (per the 5.3.0 port's extended `subscribe` semantics).
   *
   * `result === null` means resource genuinely absent (reserved for future
   * subscribe-before-create semantics — Phase 5.3.1 currently rejects that
   * case as an Error). Soft-deleted resources arrive as a real Snapshot with
   * `meta.deleted: true`.
   */
  @mesh()
  handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | null | Error): void {
    const key = `${resourceType}:${resourceId}`;
    const pending = this.#pendingSubscribes.get(key);

    if (result instanceof Error) {
      // Error path: reject pending Promise (if any) and drop the registry entry.
      // No state write-through on error.
      if (pending) {
        this.#pendingSubscribes.delete(key);
        this.#subscriptionRegistry.delete(key);
        pending.reject(result);
      }
      return;
    }

    // Write-through to bound state
    if (this.#state) {
      const basePath = `resources.${resourceType}.${resourceId}`;
      if (result === null) {
        this.#state.setState(`${basePath}.value`, undefined);
        this.#state.setState(`${basePath}.meta`, undefined);
      } else {
        this.#state.setState(`${basePath}.value`, result.value);
        this.#state.setState(`${basePath}.meta`, result.meta);
      }
    }

    // Settle pending subscribe Promise (first-call-wins)
    if (pending) {
      this.#pendingSubscribes.delete(key);
      pending.resolve(result);
    }
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

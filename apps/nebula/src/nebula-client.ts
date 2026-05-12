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
   * Map a server-side `TransactionResult` (or `Error` for ontology-stale /
   * infrastructure paths) into the client-facing `TransactionResolution`.
   *
   * Phase 5.3.3b: conflict → default `'use-server'` (write server.value,
   * resolve with that outcome). Phase 5.3.3c will route conflicts through
   * the registered resolver instead.
   */
  #mapTransactionOutcome(
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
      // Other infrastructure-shaped errors: surface as a thrown Error rather
      // than a resolution variant. We can't throw here (caller awaits the
      // Promise that always resolves), so we synthesize a timeout-like
      // outcome — better signaling lands when the structured signal arrives.
      // For now route to 'timeout' to indicate "we don't know what happened."
      void inFlight;
      return { resolution: 'timeout' };
    }

    if (result.ok) {
      // All resources share the per-transaction newETag.
      return { resolution: 'committed', eTag: inFlight.newETag };
    }

    // Inspect the first error to classify the resolution. Permission and
    // validation errors are server-determined; conflicts route through the
    // resolver (5.3.3c) but default to 'use-server' for 5.3.3b.
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

    if (errorTypes.has('conflict')) {
      // Phase 5.3.3b: default to 'use-server'. Phase 5.3.3c routes through
      // the registered resolver.
      const serverResources: Record<string, Snapshot> = {};
      for (const [rid, err] of Object.entries(errors)) {
        if (err.type === 'conflict') serverResources[rid] = err.currentSnapshot;
      }
      // Write through server.value to bound state so the UI converges.
      if (this.#state) {
        for (const [rid, snap] of Object.entries(serverResources)) {
          const basePath = `resources.${snap.meta.typeName}.${rid}`;
          this.#state.setState(`${basePath}.value`, snap.value);
          this.#state.setState(`${basePath}.meta`, snap.meta);
        }
      }
      return { resolution: 'use-server', resources: serverResources };
    }

    // Shouldn't reach — but fail closed to timeout if we somehow do.
    return { resolution: 'timeout' };
  }

  /**
   * Receive transaction result from Star. Settles the in-flight transaction
   * Promise with a `TransactionResolution` and drains the queue.
   */
  @mesh()
  handleTransactionResult(result: TransactionResult | Error): void {
    const inFlight = this.#inFlightTxn;
    if (!inFlight) return; // late arrival after timeout — drop
    this.#inFlightTxn = null;
    if (this.#inFlightTimer !== null) {
      clearTimeout(this.#inFlightTimer);
      this.#inFlightTimer = null;
    }
    const outcome = this.#mapTransactionOutcome(inFlight, result);
    inFlight.resolve(outcome);
    this.#pumpTxnQueue();
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

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
import type { TransactionResult, Snapshot } from './resources';
import type { Star } from './star';

export interface OntologyStaleInfo {
  reason: 'ontology-stale';
  clientVersion: string;
  currentVersion: string;
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

  /** Receive transaction result from Star — Phase 5.3.3b will add real implementation */
  @mesh()
  handleTransactionResult(_result: TransactionResult | Error): void {
    console.warn('handleTransactionResult not yet implemented — see Phase 5.3.3b');
  }

  /** Receive read result from Star — Phase 5.3.3b replaces this with `handleReadResponse(requestId, result)` */
  @mesh()
  handleReadResult(_result: Snapshot | null | Error): void {
    console.warn('handleReadResult not yet implemented — see Phase 5.3.3b');
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

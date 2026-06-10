/**
 * HarnessNebulaClient — Promise-wrapped NebulaClient for bench measurement.
 *
 * The bench needs sub-ms timing precision; vi.waitFor's 50ms polling interval
 * dominates that noise floor. A single shared `#pending` slot routes all
 * mesh-callback result paths through one Promise so each bench iteration is
 * a clean `await client.callXxx(...)`.
 *
 * Single-slot is fine for the latency bench because vi.bench (and beforeAll)
 * are sequential. The throughput task uses a Map keyed on resourceId for
 * concurrent in-flight calls.
 *
 * Also captures `bench_marker` frames emitted by
 * `InstrumentedNebulaClientGateway` for the gateway-hop benchmark
 * (`tasks/gateway-hop-benchmark.md`). Markers are correlated by the
 * callId carried in each frame and timestamped on arrival via
 * `performance.now()`. The decomposed-call helpers (`callStarDelayDecomposed`,
 * `callStarTransactionDecomposed`) thread the callId via the
 * `CallOptions.onSent` callback, then look the marker up by callId.
 */

import { mesh } from '@lumenize/mesh/client';
import { NebulaClient } from '@lumenize/nebula/client';
import type { OperationDescriptor, Snapshot, TransactionResult } from '@lumenize/nebula/client';

/** Per-call decomposed timing: arrival timestamps from the Node clock. */
export interface DecomposedTimings {
  /** `performance.now()` at the moment `onSent` fires (right before the WS send). */
  sendTs: number;
  /** `performance.now()` when the `bench_marker` frame for this callId arrived. */
  markerArrival: number;
  /** `performance.now()` when the call's response settled the Promise. */
  responseArrival: number;
}

export interface DecomposedCallResult<T> extends DecomposedTimings {
  result: T;
}

export class HarnessNebulaClient extends NebulaClient {
  #pending?: { resolve: (v: any) => void; reject: (e: Error) => void };
  /** Map<callId, markerArrival ms>. Entries are deleted by the helper that consumed them. */
  #markersByCallId = new Map<string, number>();
  /**
   * Map<eTag, t_arrived ms> — populated by every `handleResourceUpdate` carrying
   * a non-error Snapshot. Used by the fanout bench (`tasks/fanout-scaling-benchmark.md`)
   * to capture per-subscriber push delivery time, correlated by the eTag the
   * originator pre-generates via `client.resources.transaction({ newETag })`.
   */
  #fanoutArrivalsByETag = new Map<string, number>();
  /** Resolvers registered by `waitForFanoutArrival` for eTags not yet seen. */
  #pendingFanoutWaits = new Map<string, (t: number) => void>();

  #settle(v: any): void {
    if (v instanceof Error) this.#pending?.reject(v);
    else this.#pending?.resolve(v);
    this.#pending = undefined;
  }

  override onUnknownMessage(message: any): void {
    if (message?.type === 'bench_marker' && typeof message.callId === 'string') {
      this.#markersByCallId.set(message.callId, performance.now());
      return;
    }
    super.onUnknownMessage(message);
  }

  // Mesh callbacks the Star invokes directly over the existing WS.
  // Always chain to super so the public-API in-flight queue used by
  // `client.resources.transaction()` settles too. Tests using the direct
  // `callStarTransaction` pattern leave `#inFlightTxn` unset, so super is
  // a no-op in that mode; tests using the public API never set `#pending`,
  // so the `#settle` call is a no-op in that mode.
  @mesh()
  override handleTransactionResult(r: TransactionResult | Error): void {
    this.#settle(r);
    super.handleTransactionResult(r);
  }

  @mesh()
  handlePingResult(r: number | Error): void {
    this.#settle(r);
  }

  /**
   * Override `handleResourceUpdate` to record the Node-side arrival time for
   * every snapshot delivery, keyed by `snapshot.meta.eTag`. Initial-subscribe
   * snapshots and fanout pushes both flow through here — the fanout bench
   * filters by the originator-generated eTag so initial-snapshot deliveries
   * don't pollute the measurement.
   *
   * Calls super to preserve normal subscribe-Promise settlement, bound-state
   * write-through, and ontology-stale handling.
   */
  @mesh()
  override handleResourceUpdate(
    resourceType: string,
    resourceId: string,
    result: Snapshot | null | Error,
  ): void {
    if (result && !(result instanceof Error)) {
      const eTag = result.meta.eTag;
      const t = performance.now();
      this.#fanoutArrivalsByETag.set(eTag, t);
      const waiter = this.#pendingFanoutWaits.get(eTag);
      if (waiter) {
        this.#pendingFanoutWaits.delete(eTag);
        waiter(t);
      }
    }
    super.handleResourceUpdate(resourceType, resourceId, result);
  }

  /**
   * Resolve with the `performance.now()` timestamp captured when this client's
   * `handleResourceUpdate` fired for `eTag`. If already received, resolves
   * immediately; otherwise waits until the matching delivery arrives.
   *
   * Test code typically pre-generates `eTag` via `crypto.randomUUID()` and
   * passes it to `client.resources.transaction(ops, { newETag: eTag })` so the
   * eTag is known before any subscriber receives the push.
   */
  waitForFanoutArrival(eTag: string, timeoutMs = 30_000): Promise<number> {
    const cached = this.#fanoutArrivalsByETag.get(eTag);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    return new Promise<number>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.#pendingFanoutWaits.delete(eTag);
        reject(new Error(`waitForFanoutArrival: timeout after ${timeoutMs}ms for eTag ${eTag}`));
      }, timeoutMs);
      this.#pendingFanoutWaits.set(eTag, (t) => {
        globalThis.clearTimeout(timer);
        resolve(t);
      });
    });
  }

  /** Drop any captured arrivals — useful between bench iterations to bound memory. */
  resetFanoutArrivals(): void {
    this.#fanoutArrivalsByETag.clear();
  }

  // Plain handler for callers that explicitly forward via
  // `(this.ctn() as any).handleResult(remote)` — Galaxy ontology
  // registration uses this pattern.
  handleResult(r: any): void {
    this.#settle(r);
  }

  callStarTransaction(
    starName: string,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    newETag: string = crypto.randomUUID(),
  ): Promise<DecomposedCallResult<TransactionResult>> {
    return this.#callWithMarker((onSent) => {
      this.lmz.call(
        'STAR',
        starName,
        (this.ctn() as any).transaction(ontologyVersion, newETag, ops),
        undefined,
        { onSent },
      );
    });
  }

  callStarPing(starName: string): Promise<DecomposedCallResult<number>> {
    return this.#callWithMarker((onSent) => {
      this.lmz.call(
        'STAR',
        starName,
        (this.ctn() as any).ping(),
        undefined,
        { onSent },
      );
    });
  }

  /**
   * Mesh-callback helper: dispatches a fire-and-forget `lmz.call` whose
   * result is delivered via `handleTransactionResult` / `handlePingResult`
   * (not via CALL_RESPONSE), and combines that with the per-callId marker
   * arrival into a `DecomposedCallResult`.
   *
   * The dispatch closure receives the `onSent` callback and is responsible
   * for calling `lmz.call(...)` with `{ onSent }` in CallOptions.
   */
  #callWithMarker<T>(dispatch: (onSent: (id: string) => void) => void): Promise<DecomposedCallResult<T>> {
    return new Promise<DecomposedCallResult<T>>((resolve, reject) => {
      let callId: string | undefined;
      let sendTs = NaN;
      this.#pending = {
        resolve: (result: T) => {
          const responseArrival = performance.now();
          if (!callId) return reject(new Error('callWithMarker: onSent never fired'));
          const markerArrival = this.#markersByCallId.get(callId);
          if (markerArrival === undefined) {
            return reject(new Error(`callWithMarker: no bench_marker received for callId ${callId}`));
          }
          this.#markersByCallId.delete(callId);
          resolve({ result, sendTs, markerArrival, responseArrival });
        },
        reject,
      };
      dispatch((id: string) => {
        callId = id;
        sendTs = performance.now();
      });
    });
  }

  /**
   * Spike helper: invokes `Star.delay(delayMs)`, which awaits server-side
   * before returning. Uses `callRaw` (the async/Promise variant) since
   * `delay()` returns its argument directly via CALL_RESPONSE — no mesh
   * callback needed.
   */
  async callStarDelay(starName: string, delayMs: number): Promise<DecomposedCallResult<number>> {
    let callId: string | undefined;
    let sendTs = NaN;
    const result = await this.lmz.callRaw(
      'STAR',
      starName,
      (this.ctn() as any).delay(delayMs),
      {
        onSent: (id: string) => {
          callId = id;
          sendTs = performance.now();
        },
      },
    );
    const responseArrival = performance.now();
    if (!callId) throw new Error('callStarDelay: onSent never fired');
    const markerArrival = this.#markersByCallId.get(callId);
    if (markerArrival === undefined) {
      throw new Error(`callStarDelay: no bench_marker received for callId ${callId}`);
    }
    this.#markersByCallId.delete(callId);
    return { result, sendTs, markerArrival, responseArrival };
  }

  callGalaxyAppendOntologyVersion(
    galaxyName: string,
    cfg: { version: string; types: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      const remote = (this.ctn() as any).appendOntologyVersion(cfg);
      this.lmz.call('GALAXY', galaxyName, remote, (this.ctn() as any).handleResult(remote));
    });
  }

}

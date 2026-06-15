/**
 * Faithful mock of the `StoreClient` seam for jsdom factory tests.
 *
 * The mock is a thin stand-in for NebulaClient's engine integration: it runs
 * the SAME `createConflictOutcomeEngine` over the SAME store adapter the factory
 * injects, replacing ONLY the mesh transport (`submitBatch`) with a recorder +
 * programmable responder. So the factory ↔ engine ↔ store data flow under test
 * is the real one (debounce coalescing, optimistic paint, commit/rollback/
 * use-server write-through, hold-pending-fanouts) — just without a Star.
 *
 * Fidelity boundary: this proves the factory drives the engine correctly, NOT
 * that the engine matches a real server's facts — that's the §5.3.8 real-Star
 * e2e obligation (tasks/nebula-frontend.md § Test-fidelity obligation).
 */
import {
  createConflictOutcomeEngine,
  type ConflictOutcomeEngine,
  type ServerBatchResponse,
  type ServerResourceResult,
  type Snapshot,
} from '../../src/frontend/conflict-outcome';
import type { NebulaStoreAdapter, ResourceSubscription } from '../../src/nebula-client';
import type { StoreClient } from '../../src/frontend/types';
import type { ConnectionState } from '@lumenize/mesh/client';
import type { QueueSubmission } from '../../src/frontend/debounce';
import type { Snapshot as WireSnapshot } from '../../src/resources';

/** Per-resource server fact (what `Star.transaction` resolves to per op). */
export type MockServerResult = ServerResourceResult;

let etagCounter = 0;

export class MockClient implements StoreClient {
  // Call log — `txns` records each submitted resource (eTag = baseline asserted,
  // newETag = idempotency token, value = coalesced submitted value).
  txns: Array<{ rt: string; rid: string; eTag: string; value: unknown; newETag: string }> = [];
  subscribes: Array<{ rt: string; rid: string }> = [];
  unsubscribes: Array<{ rt: string; rid: string }> = [];

  /** Programmable per-submission server response. Default: commit with a fresh eTag. */
  txnResponder: (sub: QueueSubmission) => MockServerResult =
    () => ({ result: 'committed', eTag: `eTag-auto-${etagCounter++}` });

  /** Programmable subscribe response (reject to exercise the auto-subscribe error path). */
  subscribeResponder: (rt: string, rid: string) => Promise<unknown> = async () => null;

  connectionState: ConnectionState = 'disconnected';

  #adapter: NebulaStoreAdapter | null = null;
  #engine: ConflictOutcomeEngine;
  #connHandler: ((state: ConnectionState) => void) | null = null;

  constructor(opts: { quietMs?: number; maxWaitMs?: number; timeoutMs?: number } = {}) {
    // Mirror NebulaClient: instantiate the engine over the bound adapter +
    // a recording submit. No custom `clone` — the adapter's readResource
    // returns toRaw'd values so the engine's default structuredClone works.
    this.#engine = createConflictOutcomeEngine({
      quietMs: opts.quietMs,
      maxWaitMs: opts.maxWaitMs,
      timeoutMs: opts.timeoutMs,
      submitBatch: (subs) => this.#submit(subs),
      readResource: (rt, rid) => this.#adapter!.readResource(rt, rid),
      // The engine's structural Snapshot is satisfied at runtime by the wire
      // Snapshot the adapter expects (same cast NebulaClient uses).
      applyServer: (rt, rid, snap) => this.#adapter!.applyServer(rt, rid, snap as unknown as WireSnapshot),
      applyFanout: (rt, rid, snap) => this.#adapter!.applyFanout(rt, rid, snap as unknown as WireSnapshot),
      applyCommit: (rt, rid, eTag) => this.#adapter!.applyCommit(rt, rid, eTag),
      rollbackTo: (rt, rid, value) => this.#adapter!.rollbackTo(rt, rid, value),
      applyResolvedValue: (rt, rid, value) => this.#adapter!.applyResolvedValue(rt, rid, value),
      applyOptimistic: (rt, rid, value, eTag) => this.#adapter!.applyOptimistic(rt, rid, value, eTag),
      flash: (rt, rid, cls) => this.#adapter!.flash(rt, rid, cls),
    });
  }

  bindStore(adapter: NebulaStoreAdapter): void {
    this.#adapter = adapter;
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): void {
    this.#connHandler = handler;
  }

  flush(rt?: string, rid?: string): void {
    this.#engine.flush(rt, rid);
  }

  dispose(): Promise<void> {
    return this.#engine.dispose();
  }

  readonly resources = {
    write: (rt: string, rid: string, opts?: { quietMs?: number; preWriteValue?: unknown }): void => {
      this.#engine.write(rt, rid, opts);
    },
    subscribe: (rt: string, rid: string): ResourceSubscription => {
      this.subscribes.push({ rt, rid });
      const snapshot = this.subscribeResponder(rt, rid) as Promise<never>;
      let disposed = false;
      return {
        snapshot,
        [Symbol.dispose]: (): void => {
          if (disposed) return;
          disposed = true;
          this.unsubscribes.push({ rt, rid });
        },
      };
    },
  };

  /** Test helper: simulate a server-side fanout push (drives hold-pending-fanouts). */
  simulateFanout(rt: string, rid: string, snapshot: Snapshot): void {
    this.#engine.notifyFanout(rt, rid, snapshot);
  }

  /** Test helper: simulate a connection-state change (mirrors NebulaClient's wiring). */
  simulateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.#engine.setConnectionState(state);
    this.#connHandler?.(state);
  }

  #submit(subs: QueueSubmission[]): Promise<ServerBatchResponse> {
    for (const s of subs) {
      this.txns.push({ rt: s.rt, rid: s.rid, eTag: s.eTag, value: s.value, newETag: s.newETag });
    }
    return Promise.resolve({ resources: subs.map((s) => this.txnResponder(s)) });
  }

  reset(): void {
    this.txns = [];
    this.subscribes = [];
    this.unsubscribes = [];
  }
}

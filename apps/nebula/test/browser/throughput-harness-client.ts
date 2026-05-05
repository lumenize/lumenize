/**
 * `ThroughputHarnessClient` — Map-keyed Promise dispatch for concurrent
 * in-flight transactions.
 *
 * Used by both throughput benches:
 * - [`throughput.benchmark.ts`](throughput.benchmark.ts) — single-client saturation curve.
 * - [`throughput-multi.benchmark.ts`](throughput-multi.benchmark.ts) — Shape A vs Shape B comparison
 *   for the gateway-hop benchmark's Phase 5 (`tasks/gateway-hop-benchmark.md`).
 *
 * Result correlation is by `resourceId`: each iteration creates a unique
 * `resourceId` (`crypto.randomUUID()`); the Star's `handleTransactionResult`
 * callback's `result.eTags` is keyed by that same `resourceId`. The client
 * tracks `Map<resourceId, {resolve, reject}>` and dispatches by inspecting
 * eTag keys. No Star-side changes needed.
 *
 * Single-slot (#singleSlot) is retained for non-concurrent flows: ping
 * baseline, ontology registration, etc. Same dual-mode pattern as the
 * single-slot `HarnessNebulaClient` in [`harness-client.ts`](harness-client.ts).
 */

import { mesh } from '@lumenize/mesh/client';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { TransactionResult } from '@lumenize/nebula/client';

export class ThroughputHarnessClient extends NebulaClient {
  #pending = new Map<string, { resolve: (r: TransactionResult) => void; reject: (e: Error) => void }>();
  #singleSlot?: { resolve: (v: any) => void; reject: (e: Error) => void };

  #settleSingle(v: any): void {
    if (v instanceof Error) this.#singleSlot?.reject(v);
    else this.#singleSlot?.resolve(v);
    this.#singleSlot = undefined;
  }

  // Mesh callback the Star invokes for each transaction. Map-keyed dispatch
  // by resourceId (which the bench fed in as the only key in `ops`).
  @mesh()
  override handleTransactionResult(r: TransactionResult | Error): void {
    if (r instanceof Error) {
      // Errors aren't correlatable without a callId. Fail-loud: reject all
      // in-flight so the bench stops immediately.
      const err = r;
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      return;
    }
    if (!r.ok) {
      // Validation/conflict failure — should never happen in a saturation
      // ramp creating fresh UUIDs. Try to correlate by errors keys.
      const errIds = Object.keys(r.errors);
      const err = new Error(`Transaction failed: ${JSON.stringify(r.errors).slice(0, 500)}`);
      if (errIds.length === 1) {
        const p = this.#pending.get(errIds[0]);
        if (p) {
          this.#pending.delete(errIds[0]);
          p.reject(err);
        }
        return;
      }
      // Multi-key error — fail all
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      return;
    }
    const ids = Object.keys(r.eTags);
    if (ids.length !== 1) {
      const err = new Error(`Expected exactly one eTag in result, got ${ids.length}`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      return;
    }
    const resourceId = ids[0];
    const p = this.#pending.get(resourceId);
    if (!p) return;  // late callback for an already-resolved/rejected call
    this.#pending.delete(resourceId);
    p.resolve(r);
  }

  @mesh()
  handlePingResult(r: number | Error): void {
    this.#settleSingle(r);
  }

  // Sequential Galaxy ontology registration uses the explicit-callback pattern.
  handleResult(r: any): void {
    this.#settleSingle(r);
  }

  callStarPing(starName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#singleSlot = { resolve, reject };
      this.lmz.call('STAR', starName, (this.ctn() as any).ping());
    });
  }

  callGalaxyAppendOntologyVersion(galaxyName: string, cfg: { version: string; types: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#singleSlot = { resolve, reject };
      const remote = (this.ctn() as any).appendOntologyVersion(cfg);
      this.lmz.call('GALAXY', galaxyName, remote, (this.ctn() as any).handleResult(remote));
    });
  }

  callStarTransactionForBench(starName: string, ontologyVersion: string, resourceId: string, timeoutMs = 30_000): Promise<TransactionResult> {
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        if (this.#pending.has(resourceId)) {
          this.#pending.delete(resourceId);
          reject(new Error(`call-timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.#pending.set(resourceId, {
        resolve: (r) => { globalThis.clearTimeout(timer); resolve(r); },
        reject: (e) => { globalThis.clearTimeout(timer); reject(e); },
      });
      this.lmz.call('STAR', starName,
        (this.ctn() as any).transaction(ontologyVersion, {
          [resourceId]: {
            op: 'create',
            typeName: 'TestResource',
            nodeId: ROOT_NODE_ID,
            value: { title: 'bench' },
          },
        }));
    });
  }

  inFlightCount(): number {
    return this.#pending.size;
  }
}

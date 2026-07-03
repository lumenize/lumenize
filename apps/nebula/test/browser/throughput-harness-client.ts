/**
 * `ThroughputHarnessClient` — concurrent in-flight transactions for the throughput benches.
 *
 * Used by both throughput benches:
 * - [`throughput.benchmark.ts`](throughput.benchmark.ts) — single-client saturation curve.
 * - [`throughput-multi.benchmark.ts`](throughput-multi.benchmark.ts) — Shape A vs Shape B comparison
 *   for the gateway-hop benchmark's Phase 5 (`tasks/gateway-hop-benchmark.md`).
 *
 * Each transaction is its OWN awaitable `callAsync` (correlated by callId, bounded by `timeoutMs`), so
 * concurrent calls fan out as independent Promises — no manual `Map<resourceId, {resolve,reject}>` +
 * `handleTransactionResult` dispatch (that was the uncorrelated-channel workaround D7 retires).
 * ⚠️ Bench needs a `wrangler dev` + chromium re-run to re-validate timings (out of the pool-workers gate).
 *
 * Single-slot (#singleSlot) is retained for non-concurrent flows: ping baseline, ontology registration.
 */

import { mesh } from '@lumenize/mesh/client';
import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { TransactionResult } from '@lumenize/nebula/client';

export class ThroughputHarnessClient extends NebulaClient {
  /** Concurrent in-flight count. `callAsync` correlates each transaction by its own `callId`, so the
   *  old `Map<resourceId, {resolve,reject}>` + `handleTransactionResult` dispatch — a workaround for
   *  the uncorrelated channel — is gone (exactly what D7 retires). ⚠️ Bench needs re-verification under
   *  `wrangler dev` + chromium (out of the pool-workers gate). */
  #inFlight = 0;
  #singleSlot?: { resolve: (v: any) => void; reject: (e: Error) => void };

  #settleSingle(v: any): void {
    if (v instanceof Error) this.#singleSlot?.reject(v);
    else this.#singleSlot?.resolve(v);
    this.#singleSlot = undefined;
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
    // Each transaction is its OWN awaitable `callAsync` (correlated by callId, bounded by `timeoutMs`).
    // Concurrent calls fan out as independent Promises — no manual resourceId correlation (D7).
    this.#inFlight++;
    const newETag = crypto.randomUUID();
    return (this.lmz.callAsync('STAR', starName,
      (this.ctn() as any).transaction(ontologyVersion, newETag, {
        [resourceId]: {
          op: 'create',
          typeName: 'TestResource',
          nodeId: ROOT_NODE_ID,
          value: { title: 'bench' },
        },
      }),
      { timeoutMs },
    ) as Promise<TransactionResult>).finally(() => { this.#inFlight--; });
  }

  inFlightCount(): number {
    return this.#inFlight;
  }
}

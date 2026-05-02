/**
 * HarnessNebulaClient — Promise-wrapped NebulaClient for bench measurement.
 *
 * The bench needs sub-ms timing precision; vi.waitFor's 50ms polling interval
 * dominates that noise floor. A single shared `#pending` slot routes all
 * result paths through one Promise so each bench iteration is a clean
 * `await client.callXxx(...)`.
 *
 * Single-slot is fine because vi.bench (and beforeAll) are sequential. The
 * throughput task uses a Map for concurrent in-flight calls.
 */

import { mesh } from '@lumenize/mesh/client';
import { NebulaClient } from '@lumenize/nebula/client';
import type { OperationDescriptor, TransactionResult } from '@lumenize/nebula/client';

export class HarnessNebulaClient extends NebulaClient {
  #pending?: { resolve: (v: any) => void; reject: (e: Error) => void };

  #settle(v: any): void {
    if (v instanceof Error) this.#pending?.reject(v);
    else this.#pending?.resolve(v);
    this.#pending = undefined;
  }

  // Mesh callbacks the Star invokes directly over the existing WS.
  @mesh()
  override handleTransactionResult(r: TransactionResult | Error): void {
    this.#settle(r);
  }

  @mesh()
  handlePingResult(r: number | Error): void {
    this.#settle(r);
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
  ): Promise<TransactionResult> {
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.lmz.call('STAR', starName,
        (this.ctn() as any).transaction(ontologyVersion, ops));
    });
  }

  callStarPing(starName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.lmz.call('STAR', starName, (this.ctn() as any).ping());
    });
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

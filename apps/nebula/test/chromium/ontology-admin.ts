/**
 * Browser-safe ontology-install admin client for the real-chromium harness.
 *
 * The baseline (Node) e2e installs an ontology via `NebulaClientTest`'s
 * `callStarApplyOntology` initiator — but that class re-exports the
 * server DO classes (Star/Galaxy/Universe as VALUES), so importing it into a
 * browser bundle pulls `cloudflare:workers` in and fails Vite resolution. This
 * minimal subclass installs an ontology the same way but stays browser-bundleable:
 * `StarTest` is imported as a TYPE only (erased at runtime — the `ctn()` proxy
 * records just the method name), and it extends the vue-free, browser-safe
 * `NebulaClient` from `@lumenize/nebula/client`.
 *
 * `applyOntologyForTest` is `@mesh(requireDominionHere)` on the STAR (it compiles
 * server-side in the test app — the deployed Worker carries no compiler), so this must
 * connect as an admin whose dominion covers the star (the harness's bootstrapped admin
 * cookie) — a raw-RPC seed route can't carry that auth context.
 */
import { NebulaClient } from '@lumenize/nebula/client';
import type { OntologyVersionConfig } from '@lumenize/nebula/client';
// Type-only — erased at runtime, so no server code reaches the browser bundle.
import type { StarTest } from '../test-apps/baseline/index';

export class OntologyAdminClient extends NebulaClient {
  lastResult: unknown = undefined;
  callCompleted = false;

  /** Local result handler for the 4-arg `lmz.call` (no `@mesh` — runs locally). */
  handleResult(value: unknown): void {
    this.lastResult = value;
    this.callCompleted = true;
  }

  /** Install an ontology version directly on `starName` (admin-gated, server-side
   *  compile in the StarTest test app). */
  callStarApplyOntology(starName: string, config: OntologyVersionConfig): void {
    this.callCompleted = false;
    const remote = this.ctn<StarTest>().applyOntologyForTest(config);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }
}

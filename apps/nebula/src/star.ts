/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access,
 * and a Resources class for temporal resource storage.
 *
 * Resource operations go through ontology-aware mesh methods that use a
 * two-handler continuation pattern: Handler 1 checks the local ontology
 * cache and dispatches; Handler 2 always does the actual work.
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireAdmin } from './nebula-do';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import { Ontology } from './ontology';
import type { OntologyVersionConfig } from './ontology';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';
import type { Galaxy } from './galaxy';
import type { NebulaClient } from './nebula-client';

export class Star extends NebulaDO {
  #dagTree!: DagTree
  #resources!: Resources
  #ontology: Ontology | null = null

  onStart() {
    this.#dagTree = new DagTree(
      this.ctx,
      () => this.lmz.callContext,
      () => this.#onChanged(),
    )
    this.#resources = new Resources(
      this.ctx,
      () => this.lmz.callContext,
      this.#dagTree,
      () => this.#onChanged(),
    )
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /** Galaxy name derived from Star's dot-separated instance name */
  get #galaxyName(): string {
    const parts = this.lmz.instanceName!.split('.');
    return parts.slice(0, 2).join('.');
  }

  #hasOntologyVersion(version: string): boolean {
    const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology');
    return stored?.some(v => v.version === version) ?? false;
  }

  get #currentOntology(): Ontology {
    if (!this.#ontology) {
      const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology');
      if (!stored?.length) throw new Error('No ontology cached — Galaxy fetch should have run first');
      this.#ontology = new Ontology(stored);
    }
    return this.#ontology;
  }

  // ─── DagTree ───────────────────────────────────────────────────────

  /**
   * Single @mesh() entry point for the entire DagTree API.
   * OCAN executor checks @mesh() only on this method;
   * subsequent operations (e.g., .createNode(), .getState()) traverse freely.
   * DagTree handles per-operation auth internally via requirePermission.
   */
  @mesh()
  dagTree(): DagTree {
    return this.#dagTree
  }

  // ─── Config ────────────────────────────────────────────────────────

  @mesh(requireAdmin)
  setStarConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getStarConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  // ─── Transaction (Handler 1 / Handler 2) ───────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  transaction(ontologyVersion: string, ops: Record<string, OperationDescriptor>) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;

    if (this.#hasOntologyVersion(ontologyVersion)) {
      // Cache hit — execute directly, skip Galaxy entirely
      this.doTransaction(null, ontologyVersion, ops, clientId);
    } else {
      // Cache miss — ask Galaxy, carry context in the response handler
      this.lmz.call(
        'GALAXY', this.#galaxyName,
        this.ctn<Galaxy>().getOntology(),
        this.ctn().doTransaction(
          this.ctn().$result, ontologyVersion, ops, clientId
        )
      );
    }
  }

  /**
   * Handler 2: Execute transaction + deliver result to client.
   * Called directly (with null) on cache hit, or as response handler on cache miss.
   * When a continuation fails, Mesh puts an Error instance in $result.
   */
  doTransaction(
    ontologyConfig: OntologyVersionConfig[] | null | Error,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ) {
    try {
      // Handle Galaxy fetch failure
      if (ontologyConfig instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(ontologyConfig));
        return;
      }

      // Cache miss path: store the fetched ontology from Galaxy
      if (ontologyConfig !== null) {
        if (!ontologyConfig.some(v => v.version === ontologyVersion)) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleTransactionResult(
              new Error(`Ontology version '${ontologyVersion}' not found`)));
          return;
        }
        this.ctx.storage.kv.put('ontology', ontologyConfig);
        this.#ontology = null;  // Reset cached Ontology instance
      }
      // Cache hit path: ontologyConfig is null, local KV already has the ontology

      // Version mismatch check: reject stale clients
      const ontology = this.#currentOntology;
      if (ontologyVersion !== ontology.latestVersion) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(
            new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${ontology.latestVersion}'. Refresh your schema.`)));
        return;
      }
      const result = this.#resources.transaction(ops, ontology);

      // Deliver result to client
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(result));
    } catch (err) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Read (Handler 1 / Handler 2) ──────────────────────────────────

  /** Handler 1: Check cache, dispatch to Handler 2 */
  @mesh()
  read(ontologyVersion: string, resourceId: string) {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;

    if (this.#hasOntologyVersion(ontologyVersion)) {
      this.doRead(null, ontologyVersion, resourceId, clientId);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyName,
        this.ctn<Galaxy>().getOntology(),
        this.ctn().doRead(
          this.ctn().$result, ontologyVersion, resourceId, clientId
        )
      );
    }
  }

  /** Handler 2: Execute read + deliver result to client */
  doRead(
    ontologyConfig: OntologyVersionConfig[] | null | Error,
    ontologyVersion: string,
    resourceId: string,
    clientId: string,
  ) {
    try {
      // Handle Galaxy fetch failure
      if (ontologyConfig instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResult(ontologyConfig));
        return;
      }

      // Cache miss path: store the fetched ontology from Galaxy
      if (ontologyConfig !== null) {
        if (!ontologyConfig.some(v => v.version === ontologyVersion)) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleReadResult(
              new Error(`Ontology version '${ontologyVersion}' not found`)));
          return;
        }
        this.ctx.storage.kv.put('ontology', ontologyConfig);
        this.#ontology = null;
      }

      // Version mismatch check
      const ontology = this.#currentOntology;
      if (ontologyVersion !== ontology.latestVersion) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResult(
            new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${ontology.latestVersion}'. Refresh your schema.`)));
        return;
      }

      const snapshot = this.#resources.read(resourceId);

      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResult(snapshot));
    } catch (err) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResult(
          err instanceof Error ? err : new Error(String(err))));
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  #onChanged() {
    // Phase 3.1: placeholder — tests verify this callback fires on mutations
    // Phase 5: subscription fan-out via lmz.call() through NebulaClientGateway
  }
}

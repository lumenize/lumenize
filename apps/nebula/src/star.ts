/**
 * Star — singleton per star (e.g., instanceName = "acme.app.tenant-a")
 *
 * Owns a DAG tree for organizing resources and controlling access,
 * and a Resources class for temporal resource storage.
 *
 * Resource operations go through ontology-aware mesh methods that use a
 * two-handler continuation pattern: Handler 1 checks the local ontology
 * cache and dispatches; Handler 2 always does the actual work, loading
 * the per-version validator facet on demand.
 */

import { mesh } from '@lumenize/mesh';
import {
  getParserValidatorFacet,
} from '@lumenize/ts-runtime-parser-validator';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireAdmin } from './nebula-do';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';
import type { Galaxy, OntologyVersionRow } from './galaxy';
import type { NebulaClient } from './nebula-client';

const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

export class Star extends NebulaDO {
  #dagTree!: DagTree
  #resources!: Resources
  #row: OntologyVersionRow | null = null
  #facet: ParserValidator | null = null

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

  /**
   * Universe-scoped galaxy identifier — the first two dot-segments of Star's
   * instanceName (e.g. `acme.app.tenant-a` → `acme.app`). Both segments
   * together form a globally unique galaxy address: the leading segment is
   * the universe, the second is the galaxy slug, and identical galaxy slugs
   * in different universes produce different identifiers. Used as the
   * Galaxy DO instance name AND as the namespace prefix on the per-Worker
   * Worker Loader cache (`bundleId = "<universe.galaxy>/<version>"`).
   */
  get #galaxyId(): string {
    const parts = this.lmz.instanceName!.split('.');
    return parts.slice(0, 2).join('.');
  }

  /**
   * True iff `version` matches the single cached row's version label.
   * Reads `_index` directly so this works after hibernation (when in-memory
   * `#row` is null but KV still has the cached row).
   */
  #isCachedVersion(version: string): boolean {
    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY);
    return index?.[0] === version;
  }

  /**
   * Populate `#row` and `#facet` from KV if not already in memory.
   * Called by Handler 2 on cache-hit path. The facet helper is a same-isolate
   * cache lookup once `bundleId` is active, so this is near-zero on warm DOs.
   */
  #ensureFacet(): { row: OntologyVersionRow; facet: ParserValidator } {
    if (this.#row && this.#facet) return { row: this.#row, facet: this.#facet };

    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY);
    const version = index?.[0];
    if (!version) {
      throw new Error('No ontology cached — Galaxy fetch should have run first');
    }
    const row = this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(version));
    if (!row) {
      throw new Error(`Ontology row missing for version '${version}' — index/row drift`);
    }
    this.#row = row;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      `${this.#galaxyId}/${row.version}`,
      () => row.validatorBundle,
    );
    return { row, facet: this.#facet };
  }

  /**
   * Replace the cached ontology with a new row, atomically. Drops any
   * pre-existing row + index entry, writes the new row + single-element
   * index, and refreshes in-memory `#row` and `#facet`.
   */
  #installRow(row: OntologyVersionRow): void {
    this.ctx.storage.transactionSync(() => {
      const prevIndex = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
      for (const v of prevIndex) {
        if (v !== row.version) this.ctx.storage.kv.delete(rowKey(v));
      }
      this.ctx.storage.kv.put(rowKey(row.version), row);
      this.ctx.storage.kv.put(INDEX_KEY, [row.version]);
    });
    this.#row = row;
    this.#facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      `${this.#galaxyId}/${row.version}`,
      () => row.validatorBundle,
    );
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
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(ontologyVersion)) {
      // Cache hit — execute directly, skip Galaxy entirely
      this.doTransaction(null, ontologyVersion, ops, clientId);
    } else {
      // Cache miss — ask Galaxy, carry context in the response handler
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
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
  async doTransaction(
    fetchedRow: OntologyVersionRow | null | Error,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ) {
    try {
      // Handle Galaxy fetch failure
      if (fetchedRow instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(fetchedRow));
        return;
      }

      // Cache miss path: install the fetched row, or surface mismatch / "not found"
      if (fetchedRow !== null) {
        if (fetchedRow.version !== ontologyVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleTransactionResult(
              new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${fetchedRow.version}'. Refresh your schema.`)));
          return;
        }
        this.#installRow(fetchedRow);
      } else if (!this.#isCachedVersion(ontologyVersion)) {
        // `null` + no matching cache entry = Galaxy fetch returned no ontology
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleTransactionResult(
            new Error(`Ontology version '${ontologyVersion}' not found`)));
        return;
      }
      // null + matching cache entry = cache hit; fall through

      const { row, facet } = this.#ensureFacet();
      const result = await this.#resources.transaction(ops, row.version, facet);

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
    if (!clientId) {
      throw new Error('read requires a client origin with instanceName in callChain[0]');
    }

    if (this.#isCachedVersion(ontologyVersion)) {
      this.doRead(null, ontologyVersion, resourceId, clientId);
    } else {
      this.lmz.call(
        'GALAXY', this.#galaxyId,
        this.ctn<Galaxy>().getLatestOntologyVersion(),
        this.ctn().doRead(
          this.ctn().$result, ontologyVersion, resourceId, clientId
        )
      );
    }
  }

  /** Handler 2: Execute read + deliver result to client */
  doRead(
    fetchedRow: OntologyVersionRow | null | Error,
    ontologyVersion: string,
    resourceId: string,
    clientId: string,
  ) {
    try {
      if (fetchedRow instanceof Error) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResult(fetchedRow));
        return;
      }

      if (fetchedRow !== null) {
        if (fetchedRow.version !== ontologyVersion) {
          this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
            this.ctn<NebulaClient>().handleReadResult(
              new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${fetchedRow.version}'. Refresh your schema.`)));
          return;
        }
        this.#installRow(fetchedRow);
      } else if (!this.#isCachedVersion(ontologyVersion)) {
        this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
          this.ctn<NebulaClient>().handleReadResult(
            new Error(`Ontology version '${ontologyVersion}' not found`)));
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

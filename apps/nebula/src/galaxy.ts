/**
 * Galaxy — singleton per galaxy (e.g., instanceName = "acme.app")
 *
 * Owns the per-galaxy ontology registry. Each `appendOntologyVersion()`
 * call compiles a `validatorBundle` via @lumenize/ts-runtime-parser-validator
 * and stores it as an immutable per-version row. Stars fetch rows on cache
 * miss and host the bundle as a same-isolate DO facet.
 */

import { mesh } from '@lumenize/mesh';
import {
  extractTypeMetadata,
  generateParseModule,
} from '@lumenize/ts-runtime-parser-validator';
import type { TypeMetadata } from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireAdmin } from './nebula-do';

// ─── Types ───────────────────────────────────────────────────────────

/** Caller-supplied input for `appendOntologyVersion()`. */
export interface OntologyVersionConfig {
  version: string;
  types: string;
}

/**
 * Compiled, stored-per-version row. Immutable after write.
 *
 * `relationships` rides along for 5.5's lazy-migration path — no Phase 1–6
 * code reads it, but co-locating it with `validatorBundle` saves the future
 * migrator a re-extract on every cold migration.
 */
export interface OntologyVersionRow {
  version: string;
  types: string;
  validatorBundle: string;
  relationships: TypeMetadata['relationships'];
}

/**
 * Reply shape for `getLatestOntologyVersion()`. Bundles the latest row with
 * the full ordered version history (oldest → newest, latest = last entry) so
 * Star fetches both atomically on a cache miss. Star caches `history` locally
 * to drive 5.5's lazy migration ordering without a follow-up Galaxy round-trip.
 *
 * `history` is computed at fetch time from `ontology:_index` — it's not stored
 * on any row, since the row is immutable but the index keeps growing.
 */
export interface OntologyState {
  row: OntologyVersionRow;
  history: string[];
}

// ─── Constants ───────────────────────────────────────────────────────

const VERSION_LABEL_RE = /^[A-Za-z0-9-]+$/;
const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Compile a versionConfig into a stored row. Throws on invalid TypeScript or
 * typia compile errors; the caller surfaces the message to the admin.
 */
export function compileOntologyVersion(
  versionConfig: OntologyVersionConfig,
): OntologyVersionRow {
  const md = extractTypeMetadata(versionConfig.types);
  const validatorBundle = generateParseModule(md.writeShapeTypeDefinitions);
  return {
    version: versionConfig.version,
    types: versionConfig.types,
    validatorBundle,
    relationships: md.relationships,
  };
}

// ─── Galaxy DO ───────────────────────────────────────────────────────

export class Galaxy extends NebulaDO {
  @mesh(requireAdmin)
  setGalaxyConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getGalaxyConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  /**
   * Append a new immutable version. Validates label, compiles eagerly so
   * malformed types reject at submit time, and writes the row + index in a
   * single sync transaction.
   */
  @mesh(requireAdmin)
  appendOntologyVersion(versionConfig: OntologyVersionConfig) {
    if (!VERSION_LABEL_RE.test(versionConfig.version)) {
      throw new Error(
        `Invalid ontology version label '${versionConfig.version}': must match /^[A-Za-z0-9-]+$/ (alphanumerics and dashes only).`,
      );
    }

    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
    if (index.includes(versionConfig.version)) {
      throw new Error(
        `Ontology version '${versionConfig.version}' already exists — versions are append-only`,
      );
    }

    const row = compileOntologyVersion(versionConfig);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(rowKey(row.version), row);
      this.ctx.storage.kv.put(INDEX_KEY, [...index, row.version]);
    });
  }

  /**
   * Latest row + full ordered version history, or `null` if no versions have
   * been appended yet. Single-call so Star captures a consistent snapshot of
   * (current, history) without an interleaved append racing between two RPCs.
   */
  @mesh()
  getLatestOntologyVersion(): OntologyState | null {
    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
    if (index.length === 0) return null;
    const latest = index[index.length - 1];
    const row = this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(latest));
    if (!row) return null;
    return { row, history: index };
  }

  /** Specific row by label, or `null` if absent. */
  @mesh()
  getOntologyVersion(version: string): OntologyVersionRow | null {
    return this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(version)) ?? null;
  }

  /** Ordered version labels (oldest → newest). */
  @mesh()
  listOntologyVersions(): string[] {
    return this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
  }
}

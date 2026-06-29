/**
 * Galaxy — singleton per galaxy (e.g., instanceName = "acme.app")
 *
 * Owns the per-galaxy ontology registry. Each `appendOntologyVersion()`
 * call compiles a `validatorBundle` via @lumenize/ts-runtime-parser-validator
 * and stores it as an immutable per-version row. Stars fetch rows on cache
 * miss and host the bundle as a same-isolate DO facet.
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
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

/** One model tool call (the future tool-calling loop populates these). */
export interface ToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

/**
 * One captured codegen turn — the unit the eval suite replays, so the record
 * schema IS the eval-fixture schema. Stored as JSON `payload` on the Galaxy and
 * shaped for the tool-calling loop (not just today's one-shot regex path).
 */
export interface TurnRecord {
  /** Stable id, supplied by DevStudio (never a server rowid — coding-style.md). */
  id: string;
  /** Turn time (ms); the ordering key. */
  createdAt: number;
  /** The `{u}.{g}.dev` DevStudio sandbox that produced the turn. */
  instance: string;
  /** Codegen model id (the eval needs it — judge must differ from generator). */
  model: string;
  systemPrompt: string;
  userMessage: string;
  /** The current source fed as context (e.g. App.vue); '' on the first turn. */
  currentSource: string;
  /** Raw model output. */
  output: string;
  /** Chain-of-thought (`reasoning_content`); '' when the model returns none. */
  reasoning: string;
  /** Tool-calling turns populate this; `[]` for the current one-shot regex path. */
  toolCalls: ToolCall[];
  /** Whether a file was extracted + applied. */
  applied: boolean;
  /** The applied path (e.g. 'src/App.vue'), if any. */
  appliedPath?: string;
  /** Apply/render/compile error tail (the Rung-1 slot); absent on success. */
  error?: string;
  /** Rung-1 validate result slot (compile gate) — absent until that gate lands. */
  validate?: unknown;
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
  // Pass the original relationship map so the generated validator can emit a
  // loud, actionable error when a caller embeds an object in a relationship
  // field instead of referencing the related resource by id (the write shape
  // types relationships as `string`, which otherwise yields an opaque
  // "expected (string | undefined)").
  const validatorBundle = generateParseModule(md.writeShapeTypeDefinitions, md.relationships);
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

  // ─── Turn recorder (Studio codegen corpus) ──────────────────────────
  // DevStudio fires recordTurn (fire-and-forget) for every codegen turn; the
  // corpus seeds prompt iteration + the eval suite. The full record is the
  // replayable eval fixture (stored as JSON `payload`); the columns are a query
  // index over it. See tasks/nebula-agentic-development-engine.md Part 2.

  #turnsReady = false;
  #ensureTurns(): void {
    if (this.#turnsReady) return;
    // TEXT primary key ⇒ WITHOUT ROWID (durable-objects.md SQLite write-cost rule).
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS Turns (
      id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, instance TEXT NOT NULL,
      model TEXT NOT NULL, applied INTEGER NOT NULL, hasError INTEGER NOT NULL,
      payload TEXT NOT NULL
    ) WITHOUT ROWID`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_Turns_time ON Turns(createdAt)`);
    this.#turnsReady = true;
  }

  /**
   * Record one codegen turn (called by DevStudio, fire-and-forget). The full
   * record is stored as JSON `payload` (the eval fixture); id/createdAt/instance/
   * model/applied/hasError are extracted as a query index. `INSERT OR REPLACE`
   * keeps it idempotent on the DevStudio-supplied `id` (1 write, not 2).
   */
  @mesh(requireAdmin)
  recordTurn(record: TurnRecord): void {
    this.#ensureTurns();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Turns (id, createdAt, instance, model, applied, hasError, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id, record.createdAt, record.instance, record.model,
      record.applied ? 1 : 0, record.error ? 1 : 0, JSON.stringify(record),
    );
    debug('nebula.Galaxy.recordTurn').debug('recorded', {
      id: record.id, instance: record.instance, applied: record.applied,
    });
  }

  /**
   * Read recorded turns (oldest → newest) for prompt iteration / the eval suite.
   * `since` filters by `createdAt` (ms); `limit` caps the return (default 100,
   * hard max 1000) so a large corpus doesn't ship in one envelope.
   */
  @mesh(requireAdmin)
  getTurns(opts: { since?: number; limit?: number } = {}): TurnRecord[] {
    this.#ensureTurns();
    const limit = Math.min(opts.limit ?? 100, 1000);
    const rows = this.ctx.storage.sql.exec(
      `SELECT payload FROM Turns WHERE createdAt >= ? ORDER BY createdAt LIMIT ?`,
      opts.since ?? 0, limit,
    ).toArray();
    return rows.map((r) => JSON.parse(r.payload as string) as TurnRecord);
  }
}

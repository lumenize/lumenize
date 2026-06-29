/**
 * `SQLSchemaMigrations` — a minimal id-gated SQL schema-migration runner for
 * SQLite-backed Durable Objects. Append-only migration list, a stored last-applied
 * marker, each migration runs exactly once, the batch atomic.
 *
 * Vendored and modified from durable-utils' `SQLSchemaMigrations`
 * (https://github.com/lambrospetrou/durable-utils, MIT, © Lambros Petrou). See
 * `ATTRIBUTIONS.md`. Modifications:
 *   1. Storage access ported from the legacy async API (`doStorage.get/put/transaction`)
 *      to Cloudflare's synchronous API (`ctx.storage.kv.get/put` + `ctx.storage.transactionSync`);
 *      `runAll()` is therefore **synchronous** (safe to call from a DO constructor body).
 *   2. Deliberately narrowed public surface — dropped `keyNameTrackingLastMigrationID`,
 *      the `sqlGen` callback, and `hasMigrationsToRun()`; the marker key name is fixed.
 *   3. Added per-migration `params` for bound (`?`) values (never interpolate).
 *
 * MIT License. Portions © Lambros Petrou (durable-utils); modifications © Larry Maccherone.
 */
import type { DurableObjectStorage, SqlStorageValue } from '@cloudflare/workers-types';

/** The kv key under which the last-applied migration id is tracked. */
const MARKER_KEY = '__sql_migrations_lastID';

export interface SQLSchemaMigration {
  /**
   * Monotonically increasing identifier. Append-only: never edit, reorder, or reuse the
   * id of an already-applied migration — add a new entry with a higher id instead.
   */
  idMonotonicInc: number;
  /** Human-readable description; not used by the runner. */
  description: string;
  /** The SQL to run for this migration. Keep it to a single statement so bound `?` are unambiguous. */
  sql: string;
  /** Bound values for `?` placeholders in `sql` — parameterized binding, never string interpolation. */
  params?: SqlStorageValue[];
}

export interface SQLSchemaMigrationsConfig {
  /** The DO's `ctx.storage` handle. */
  doStorage: DurableObjectStorage;
  /** Every migration ever (not just new ones). Sorted and duplicate-checked at construction. */
  migrations: SQLSchemaMigration[];
}

export class SQLSchemaMigrations {
  #doStorage: DurableObjectStorage;
  #migrations: SQLSchemaMigration[];
  /** In-memory cache of the last-applied id; -1 on a cold construct (re-read from storage in `runAll`). */
  #lastApplied = -1;

  constructor(config: SQLSchemaMigrationsConfig) {
    this.#doStorage = config.doStorage;
    const migrations = [...config.migrations].sort((a, b) => a.idMonotonicInc - b.idMonotonicInc);
    const seen = new Set<number>();
    for (const m of migrations) {
      if (m.idMonotonicInc < 0) {
        throw new Error(`migration ID cannot be negative: ${m.idMonotonicInc}`);
      }
      if (seen.has(m.idMonotonicInc)) {
        throw new Error(`duplicate migration ID detected: ${m.idMonotonicInc}`);
      }
      seen.add(m.idMonotonicInc);
    }
    this.#migrations = migrations;
  }

  /**
   * Apply every not-yet-applied migration, in id order, in **one atomic `transactionSync` batch**.
   * Synchronous — callable from a DO constructor body. Re-running once current is a no-op.
   * Returns SQL-cursor rows read/written aggregated across the batch (the marker write is not counted).
   */
  runAll(): { rowsRead: number; rowsWritten: number } {
    const result = { rowsRead: 0, rowsWritten: 0 };
    if (this.#migrations.length === 0) return result;

    const highest = this.#migrations[this.#migrations.length - 1].idMonotonicInc;
    // In-memory short-circuit: once this instance has applied everything, skip even the marker read.
    // A cold construct resets #lastApplied to -1, so it still reads the marker exactly once below.
    if (this.#lastApplied === highest) return result;

    this.#lastApplied = this.#doStorage.kv.get<number>(MARKER_KEY) ?? -1;

    let idx = 0;
    const sz = this.#migrations.length;
    while (idx < sz && this.#migrations[idx].idMonotonicInc <= this.#lastApplied) idx += 1;
    if (idx >= sz) return result; // nothing new to apply

    const sql = this.#doStorage.sql;
    const toRun = this.#migrations.slice(idx);

    this.#doStorage.transactionSync(() => {
      let last = this.#lastApplied;
      for (const m of toRun) {
        const cursor = sql.exec(m.sql, ...(m.params ?? []));
        // Load-bearing: forces statement execution and populates rowsRead/rowsWritten. Do not drop.
        cursor.toArray();
        result.rowsRead += cursor.rowsRead;
        result.rowsWritten += cursor.rowsWritten;
        last = m.idMonotonicInc;
      }
      this.#lastApplied = last;
      this.#doStorage.kv.put(MARKER_KEY, this.#lastApplied);
    });

    return result;
  }
}

/**
 * HistoryStoreDO — arm 1 of the R2-OLAP-latency spike: history rows in a DO's SQLite,
 * queried via the mesh path so `lmz.call` + auth overhead is in the measurement.
 *
 * ⚠️ SKELETON. Faithful-path TODOs (see README + tasks/spike-r2-olap-latency.md):
 *   - extends `LumenizeDO` now (captures core mesh overhead); upgrade to `NebulaDO` +
 *     `@mesh(requireAdmin)` + scope-isolation to also capture the Nebula auth-check delta.
 *   - wire the mesh entrypoint + Gateway so the Node harness can issue real mesh calls.
 *   - replace the placeholder `allowAll` guard with the real `@mesh` guard signature.
 */
import { LumenizeDO, mesh } from '@lumenize/mesh';

// TODO: replace with `requireAdmin` once this is a NebulaDO. Placeholder permissive guard.
const allowAll = () => true;

const END_OF_TIME = 8640000000000000; // ADR-004 "current" sentinel

interface HistoryRow {
  resourceId: string; type: string; tenant: string; version: number;
  validFrom: number; validTo: number; payloadBytes: number;
}

export class HistoryStoreDO extends LumenizeDO {
  override async onStart(): Promise<void> {
    const sql = this.ctx.storage.sql;
    // Compound PK + WITHOUT ROWID (durable-objects.md SQLite write-cost rule).
    sql.exec(`CREATE TABLE IF NOT EXISTS Snapshots (
      resourceId TEXT NOT NULL, type TEXT NOT NULL, tenant TEXT NOT NULL,
      version INTEGER NOT NULL, validFrom INTEGER NOT NULL, validTo INTEGER NOT NULL,
      payloadBytes INTEGER NOT NULL,
      PRIMARY KEY (resourceId, validFrom)
    ) WITHOUT ROWID`);
    // Partial index for "current" lookups (validTo = sentinel) — zero cost for historical rows.
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_Snapshots_current ON Snapshots(resourceId) WHERE validTo = ${END_OF_TIME}`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_Snapshots_time ON Snapshots(validFrom)`);
  }

  /** Bulk-load rows (the seed; call once before measuring). */
  @mesh(allowAll)
  seed(rows: HistoryRow[]): { inserted: number } {
    const sql = this.ctx.storage.sql;
    for (const r of rows) {
      sql.exec(
        `INSERT OR REPLACE INTO Snapshots (resourceId,type,tenant,version,validFrom,validTo,payloadBytes) VALUES (?,?,?,?,?,?,?)`,
        r.resourceId, r.type, r.tenant, r.version, r.validFrom, r.validTo, r.payloadBytes,
      );
    }
    return { inserted: rows.length };
  }

  /** Mesh round-trip baseline (no SQL) — subtract to isolate SQL cost from the mesh+auth floor. */
  @mesh(allowAll)
  noop(): { ok: true } { return { ok: true }; }

  /** Point: all versions of one resource over time. */
  @mesh(allowAll)
  pointQuery(resourceId: string): HistoryRow[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM Snapshots WHERE resourceId = ? ORDER BY validFrom`, resourceId)
      .toArray() as unknown as HistoryRow[];
  }

  /** Range: snapshots in a [from, to) window. */
  @mesh(allowAll)
  rangeQuery(from: number, to: number): HistoryRow[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM Snapshots WHERE validFrom >= ? AND validFrom < ? ORDER BY validFrom LIMIT 1000`, from, to)
      .toArray() as unknown as HistoryRow[];
  }

  /** Aggregate: write count per type. */
  @mesh(allowAll)
  aggregateByType(): Array<{ type: string; n: number }> {
    return this.ctx.storage.sql
      .exec(`SELECT type, COUNT(*) AS n FROM Snapshots GROUP BY type ORDER BY n DESC`)
      .toArray() as unknown as Array<{ type: string; n: number }>;
  }

  /** Top-N: most-revised resources. */
  @mesh(allowAll)
  topRevised(limit = 10): Array<{ resourceId: string; versions: number }> {
    return this.ctx.storage.sql
      .exec(`SELECT resourceId, COUNT(*) AS versions FROM Snapshots GROUP BY resourceId ORDER BY versions DESC LIMIT ?`, limit)
      .toArray() as unknown as Array<{ resourceId: string; versions: number }>;
  }
}

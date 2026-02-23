import { DurableObject } from "cloudflare:workers";

export interface SqlResult {
  rowsWritten: number;
  rowsRead: number;
  rows: Record<string, unknown>[];
}

/**
 * Minimal DO for measuring SQLite write costs.
 * Exposes ctx.storage.sql.exec via RPC and returns cursor metrics.
 */
export class WriteCostDO extends DurableObject<Env> {
  /**
   * Execute a SQL statement and return the billing-relevant metrics.
   * For DDL (CREATE TABLE, CREATE INDEX), rowsWritten/rowsRead are 0.
   */
  execSql(sql: string, params?: any[]): SqlResult {
    const cursor = this.ctx.storage.sql.exec(sql, ...(params ?? []));
    const rows = [...cursor];
    return {
      rowsWritten: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rows: rows as Record<string, unknown>[],
    };
  }
}

export default {
  async fetch() {
    return new Response("Write cost experiment DO");
  },
} satisfies ExportedHandler<Env>;

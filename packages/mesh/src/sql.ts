/**
 * SQL template literal tag for Durable Object storage.
 *
 * This function provides a clean template literal syntax for SQL queries
 * with automatic parameter binding and result array conversion.
 *
 * @param doInstance - The Durable Object instance (needs ctx.storage.sql)
 * @returns A template literal tag function for SQL queries
 *
 * @example
 * Standalone usage:
 * ```typescript
 * import { sql } from '@lumenize/mesh';
 * import { DurableObject } from 'cloudflare:workers';
 *
 * class MyDO extends DurableObject {
 *   #sql = sql(this);
 *
 *   getUser(id: string) {
 *     const rows = this.#sql`SELECT * FROM users WHERE id = ${id}`;
 *     return rows[0];
 *   }
 * }
 * ```
 *
 * @example
 * With LumenizeDO (auto-available):
 * ```typescript
 * import { LumenizeDO } from '@lumenize/mesh';
 *
 * class MyDO extends LumenizeDO<Env> {
 *   getUser(id: string) {
 *     const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
 *     return rows[0];
 *   }
 * }
 * ```
 */
export function sql(doInstance: any) {
  const ctx = doInstance.ctx;

  if (!ctx?.storage?.sql) {
    throw new Error('sql() requires a Durable Object instance with ctx.storage.sql');
  }

  return (strings: TemplateStringsArray, ...values: any[]) => {
    // Build parameterized query with ? placeholders
    const query = strings.reduce((acc, str, i) =>
      acc + str + (i < values.length ? "?" : ""), ""
    );

    // Execute and convert cursor to array
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

// TypeScript declaration merging for type safety
// This augments the global LumenizeServices interface so TypeScript knows
// about this.svc.sql in LumenizeDO subclasses
declare global {
  interface LumenizeServices {
    sql: ReturnType<typeof sql>;
  }
}

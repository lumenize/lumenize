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
 * import { sql } from '@lumenize/core';
 * import { DurableObject } from 'cloudflare:workers';
 * 
 * class MyDO extends DurableObject {
 *   // Convenient convention - You can use sql(this)` ... directly just as well
 *   // We need `this` passed in because it's just the pattern that every Lumenize NADIS
 *   // plugin requires when used stand-alone. When using LumenizeBase, this is not necessary.
 *   #sql = sql(this);
 *   
 *   async getUser(id: string) {
 *     const rows = this.#sql`SELECT * FROM users WHERE id = ${id}`;
 *     return rows[0];
 *   }
 * }
 * ```
 * 
 * @example
 * With LumenizeBase (auto-injected):
 * ```typescript
 * import '@lumenize/core';  // Registers sql in this.svc
 * // You could also do this: import { sql } from '@lumenize/core';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async getUser(id: string) {
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

// TypeScript declaration merging magic
// This augments the global LumenizeServices interface so TypeScript knows
// about this.svc.sql when you import this package
declare global {
  interface LumenizeServices {
    sql: ReturnType<typeof sql>;
  }
}

// Register service in global registry for LumenizeBase auto-injection
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.sql = (doInstance: any) => sql(doInstance);


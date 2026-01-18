import type { sql } from './sql';

/**
 * Global LumenizeServices interface
 *
 * This interface is augmented via declaration merging by each NADIS package.
 * When you import a NADIS package (e.g., '@lumenize/alarms'), it adds its
 * service to this interface, enabling TypeScript autocomplete.
 *
 * The `sql` service is built-in and always available on `this.svc.sql`.
 *
 * @example
 * ```typescript
 * import '@lumenize/alarms';  // Adds 'alarms' to LumenizeServices
 *
 * // this.svc.sql is always available (built-in)
 * // this.svc.alarms is available after importing @lumenize/alarms
 * ```
 */
export interface LumenizeServices {
  /** Built-in SQL template literal tag for DO storage */
  sql: ReturnType<typeof sql>;
  // Additional services are added via declaration merging in their respective packages
  // Example: alarms: Alarms<any>;  // Added by @lumenize/alarms
}

// Also export as a global declaration for convenience
declare global {
  interface LumenizeServices {
    /** Built-in SQL template literal tag for DO storage */
    sql: ReturnType<typeof sql>;
    // Additional services are added via declaration merging
  }
}


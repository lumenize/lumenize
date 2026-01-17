/**
 * Global LumenizeServices interface
 * 
 * This interface is augmented via declaration merging by each NADIS package.
 * When you import a NADIS package (e.g., '@lumenize/core'), it adds its
 * service to this interface, enabling TypeScript autocomplete.
 * 
 * @example
 * ```typescript
 * import '@lumenize/core';    // Adds 'sql' to LumenizeServices
 * import '@lumenize/alarms';  // Adds 'alarms' to LumenizeServices
 * 
 * // Now this.svc.sql and this.svc.alarms have full type hints
 * ```
 */
export interface LumenizeServices {
  // Services are added via declaration merging in their respective packages
  // Examples:
  // sql: ReturnType<typeof sql>;           // Added by @lumenize/core
  // alarms: Alarms<any>;                   // Added by @lumenize/alarms
}

// Also export as a global declaration for convenience
declare global {
  interface LumenizeServices {
    // Same as above - services added via declaration merging
  }
}


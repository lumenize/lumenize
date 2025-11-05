/**
 * @lumenize/debug - Scoped debug logging for Cloudflare Durable Objects
 * 
 * Provides structured, filterable debug logging optimized for Cloudflare's JSON log dashboard.
 * Inspired by npm's `debug` package with level support (debug, info, warn).
 * 
 * Server-side (NADIC-enabled):
 * ```typescript
 * import '@lumenize/debug';  // Registers in this.svc
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   myMethod() {
 *     const log = this.svc.createDebug('proxy-fetch.serialization');
 *     log.debug('processing request', { url, method });
 *     log.info('milestone reached', { step: 3 });
 *     log.warn('suspicious behavior', { retryCount: 5 });
 *   }
 * }
 * ```
 * 
 * Configuration via environment variables:
 * - `DEBUG=proxy-fetch` - Enable all levels for proxy-fetch and children
 * - `DEBUG=proxy-fetch:warn` - Only warn level for proxy-fetch
 * - `DEBUG=*` - Enable everything
 * - `DEBUG=proxy-fetch,-proxy-fetch.verbose` - Exclusions
 */

import { createMatcher } from './pattern-matcher';
import { DebugLoggerImpl } from './logger';
import type { DebugLogger } from './types';

/**
 * Create debug logger factory for a Durable Object instance
 * 
 * This function is the NADIC service entrypoint. It reads the DEBUG
 * environment variable from the DO's env and creates a factory function
 * for creating namespaced loggers.
 * 
 * @param doInstance - The Durable Object instance (needs env.DEBUG)
 * @returns Factory function for creating debug loggers
 * 
 * @example
 * Standalone usage:
 * ```typescript
 * import { createDebug } from '@lumenize/debug';
 * import { DurableObject } from 'cloudflare:workers';
 * 
 * class MyDO extends DurableObject {
 *   #createDebug = createDebug(this);
 *   
 *   myMethod() {
 *     const log = this.#createDebug('my-namespace');
 *     log.debug('message', { data });
 *   }
 * }
 * ```
 * 
 * @example
 * With LumenizeBase (auto-injected):
 * ```typescript
 * import '@lumenize/debug';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   myMethod() {
 *     const log = this.svc.createDebug('my-namespace');
 *     log.debug('message', { data });
 *   }
 * }
 * ```
 */
export function createDebug(doInstance: any): (namespace: string) => DebugLogger {
  // Get DEBUG environment variable
  // Try this.env first (LumenizeBase pattern), fallback to doInstance.env (vanilla DO)
  const env = doInstance.env || (doInstance as any).env;
  const debugFilter = env?.DEBUG || process.env?.DEBUG;
  
  // Create matcher from environment
  const matcher = createMatcher(debugFilter);
  
  // Return factory function
  return (namespace: string): DebugLogger => {
    return new DebugLoggerImpl({
      namespace,
      shouldLog: matcher,
    });
  };
}

// Export types for external use
export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

// TypeScript declaration merging magic
// This augments the global LumenizeServices interface so TypeScript knows
// about this.svc.createDebug when you import this package
declare global {
  interface LumenizeServices {
    createDebug: ReturnType<typeof createDebug>;
  }
}

// Register service in global registry for LumenizeBase auto-injection
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.createDebug = (doInstance: any) => createDebug(doInstance);


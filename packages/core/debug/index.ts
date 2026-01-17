/**
 * Debug - Scoped debug logging for Cloudflare Workers and Durable Objects
 *
 * Provides structured, filterable debug logging optimized for Cloudflare's
 * JSON log dashboard. Inspired by npm's `debug` package with level support
 * (debug, info, warn, error).
 *
 * Usage:
 * ```typescript
 * import { debug } from '@lumenize/core';
 *
 * class MyDO extends DurableObject<Env> {
 *   #log = debug(this);
 *
 *   myMethod() {
 *     const log = this.#log('lmz.my-do.MyDO');
 *     log.debug('processing request', { url, method });
 *     log.info('milestone reached', { step: 3 });
 *     log.warn('retry limit reached', { retryCount: 5 });
 *     log.error('unexpected failure', { error: e.message }); // ALWAYS outputs
 *   }
 * }
 * ```
 *
 * Configuration via environment variables:
 * - `DEBUG=lmz.proxy-fetch` - Enable all levels for proxy-fetch and children
 * - `DEBUG=lmz.proxy-fetch:warn` - Only warn level for proxy-fetch
 * - `DEBUG=*` - Enable everything
 * - `DEBUG=lmz.proxy-fetch,-lmz.proxy-fetch.verbose` - Exclusions
 * 
 * IMPORTANT: error() level ALWAYS outputs, regardless of DEBUG filter.
 */

import { createMatcher } from './pattern-matcher';
import { DebugLoggerImpl } from './logger';
import type { DebugLogger } from './types';

/**
 * Create debug logger factory
 *
 * Reads the DEBUG environment variable and creates a factory function
 * for creating namespaced loggers.
 *
 * @param withEnv - Object with env property (DO instance, Worker context, or plain object)
 * @returns Factory function for creating debug loggers
 *
 * @see [Debug Documentation](/docs/core/debug) for complete usage examples and configuration
 */
export function debug(withEnv: any): (namespace: string) => DebugLogger {
  // Get DEBUG environment variable
  // Try withEnv.env first (DO, Worker, or { env } object)
  const env = withEnv?.env || (withEnv as any)?.env;
  
  // Validate that we can access env - fail fast with helpful error
  if (!env) {
    throw new Error(
      'debug() requires an object with an "env" property. ' +
      'Pass doInstance or { env } instead of ctx. ' +
      'Example: debug(doInstance)(\'namespace\') or debug({ env })(\'namespace\')'
    );
  }
  
  const debugFilter = env.DEBUG || (typeof process !== 'undefined' ? process.env?.DEBUG : undefined);
  
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

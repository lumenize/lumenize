/**
 * Debug - Scoped debug logging for Cloudflare Durable Objects
 * 
 * Part of @lumenize/core. Provides structured, filterable debug logging optimized 
 * for Cloudflare's JSON log dashboard. Inspired by npm's `debug` package with 
 * level support (debug, info, warn, error).
 * 
 * Server-side (NADIS-enabled):
 * ```typescript
 * import '@lumenize/core';  // Registers in this.svc
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   myMethod() {
 *     const log = this.svc.debug('lmz.proxy-fetch.ProxyFetchDO');
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
 * This function is the NADIS service entrypoint. It reads the DEBUG
 * environment variable and creates a factory function for creating
 * namespaced loggers.
 * 
 * @param withEnv - Object with env property (DO instance, Worker context, or plain object)
 * @returns Factory function for creating debug loggers
 * 
 * @example
 * In Durable Objects:
 * ```typescript
 * import { debug } from '@lumenize/core';
 * import { DurableObject } from 'cloudflare:workers';
 * 
 * class MyDO extends DurableObject {
 *   #log = debug(this)('my-namespace');
 *   
 *   myMethod() {
 *     this.#log.debug('message', { data });
 *   }
 * }
 * ```
 * 
 * @example
 * In Workers:
 * ```typescript
 * import { debug } from '@lumenize/core';
 * 
 * export default {
 *   async fetch(request, environment, ctx) {
 *     const log = debug({ env: environment })('worker.router');
 *     log.debug('Routing request', { pathname: new URL(request.url).pathname });
 *     // ... route to DO or return response
 *   }
 * }
 * ```
 * 
 * @example
 * With LumenizeBase (auto-injected):
 * ```typescript
 * import '@lumenize/core';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase {
 *   myMethod() {
 *     const log = this.svc.debug('my-namespace');
 *     log.debug('message', { data });
 *   }
 * }
 * ```
 */
export function debug(withEnv: any): (namespace: string) => DebugLogger {
  // Get DEBUG environment variable
  // Try withEnv.env first (DO, Worker, or { env } object)
  const env = withEnv.env || (withEnv as any).env;
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
// about this.svc.debug when you import this package
declare global {
  interface LumenizeServices {
    debug: ReturnType<typeof debug>;
  }
}

// Register service in global registry for LumenizeBase auto-injection
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.debug = (withEnv: any) => debug(withEnv);


/**
 * @lumenize/debug - Zero-dependency debug logging
 *
 * Works in Cloudflare Workers, Node.js, Bun, and browsers with automatic
 * environment detection for the DEBUG filter.
 *
 * Usage:
 * ```typescript
 * import { debug } from '@lumenize/debug';
 *
 * const log = debug('MyApp.myFunction');
 * log.debug('processing request', { url, method });
 * log.info('milestone reached', { step: 3 });
 * log.warn('retry limit reached', { retryCount: 5 });
 * log.error('unexpected failure', { error: e.message }); // ALWAYS outputs
 * ```
 *
 * Configuration:
 * - **Cloudflare Workers**: Set `DEBUG` in wrangler.jsonc vars or .dev.vars
 * - **Node.js/Bun**: Set `DEBUG` environment variable
 * - **Browser**: Set `localStorage.setItem('DEBUG', '...')`
 *
 * Filter patterns:
 * - `DEBUG=MyApp` - Enable MyApp and all children (MyApp.*)
 * - `DEBUG=MyApp:warn` - Only warn+ level for MyApp
 * - `DEBUG=*` - Enable everything
 * - `DEBUG=MyApp,-MyApp.verbose` - Enable MyApp, exclude verbose
 *
 * IMPORTANT: error() level ALWAYS outputs, regardless of DEBUG filter.
 */

import { createMatcher } from './pattern-matcher';
import { DebugLoggerImpl } from './logger';
import type { DebugLogger, DebugLevel } from './types';

/**
 * Cached matcher - lazily initialized on first use
 * In Workers, this gets recreated per-isolate which is correct behavior
 */
let cachedMatcher: ((namespace: string, level: DebugLevel) => boolean) | null = null;
let cachedDebugValue: string | undefined | null = null;
let explicitlyConfigured = false;

/**
 * Get the DEBUG filter value from the environment
 *
 * Auto-detects the runtime environment:
 * - Cloudflare Workers: Not available at module init (use debug.configure())
 * - Node.js/Bun: process.env.DEBUG
 * - Browser: localStorage.getItem('DEBUG')
 *
 * @returns The DEBUG filter string or undefined
 */
function getDebugFilter(): string | undefined {
  // Node.js / Bun
  if (typeof process !== 'undefined' && process.env?.DEBUG !== undefined) {
    return process.env.DEBUG;
  }

  // Browser
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem('DEBUG') ?? undefined;
    } catch {
      // localStorage may throw in some contexts (e.g., sandboxed iframes)
      return undefined;
    }
  }

  return undefined;
}

/**
 * Get or create the matcher function
 * Caches the matcher for performance
 */
function getMatcher(): (namespace: string, level: DebugLevel) => boolean {
  // If explicitly configured (via debug.configure()), use that value
  if (explicitlyConfigured && cachedMatcher !== null) {
    return cachedMatcher;
  }

  const currentDebugValue = getDebugFilter();

  // Return cached matcher if DEBUG value hasn't changed
  if (cachedMatcher !== null && cachedDebugValue === currentDebugValue) {
    return cachedMatcher;
  }

  // Create new matcher and cache it
  cachedDebugValue = currentDebugValue;
  cachedMatcher = createMatcher(currentDebugValue);
  return cachedMatcher;
}

/**
 * Create a debug logger for a namespace
 *
 * @overload
 * @param namespace - The namespace for this logger (e.g., 'MyApp.myFunction')
 * @returns A debug logger with debug(), info(), warn(), and error() methods
 *
 * @example
 * ```typescript
 * import { debug } from '@lumenize/debug';
 *
 * // In Node.js/Bun/Browser (auto-detects DEBUG from environment)
 * const log = debug('MyApp.myFunction');
 * log.info('Something happened', { data });
 *
 * // In Cloudflare Workers (configure first)
 * debug.configure(env);
 * const log = debug('Worker.handler');
 * ```
 */
export function debug(namespace: string): DebugLogger;

/**
 * Create a debug logger factory for Durable Objects and Workers
 *
 * @overload
 * @param instance - A DO/Worker instance (env can be protected, uses runtime access)
 * @returns A factory function that creates loggers for the given namespace
 *
 * @example
 * ```typescript
 * import { debug } from '@lumenize/debug';
 *
 * class MyDO extends DurableObject<Env> {
 *   #debug = debug(this);
 *
 *   async fetch(request: Request) {
 *     const log = this.#debug('MyDO.fetch');
 *     log.info('Processing request');
 *     return new Response('OK');
 *   }
 * }
 * ```
 */
export function debug(instance: object): (namespace: string) => DebugLogger;

/**
 * Create a debug logger (implementation)
 */
export function debug(namespaceOrInstance: string | object): DebugLogger | ((namespace: string) => DebugLogger) {
  // Overload 1: debug('namespace') - create logger directly
  if (typeof namespaceOrInstance === 'string') {
    return new DebugLoggerImpl({
      namespace: namespaceOrInstance,
      shouldLog: getMatcher(),
    });
  }

  // Overload 2: debug(instance) - return factory function
  // Auto-configure from the instance's env (accessed at runtime, may be protected in TS)
  const env = (namespaceOrInstance as { env?: { DEBUG?: string } }).env;
  if (env) {
    debug.configure(env);
  }

  return (namespace: string): DebugLogger => {
    return new DebugLoggerImpl({
      namespace,
      shouldLog: getMatcher(),
    });
  };
}

/**
 * Configure debug for Cloudflare Workers
 *
 * In Cloudflare Workers, environment variables are not available at module init time.
 * Call this once per request/event with the env object to configure the DEBUG filter.
 *
 * @param env - The Cloudflare environment object (must have DEBUG property)
 *
 * @example
 * ```typescript
 * import { debug } from '@lumenize/debug';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     debug.configure(env);
 *
 *     const log = debug('Worker.router');
 *     log.debug('Routing request', { pathname: new URL(request.url).pathname });
 *
 *     return new Response('OK');
 *   }
 * };
 * ```
 *
 * @example
 * ```typescript
 * // In a Durable Object
 * class MyDO extends DurableObject<Env> {
 *   async fetch(request: Request) {
 *     debug.configure(this.env);
 *
 *     const log = debug('MyDO.fetch');
 *     log.info('Processing request');
 *
 *     return new Response('OK');
 *   }
 * }
 * ```
 */
debug.configure = function(env: { DEBUG?: string } | undefined): void {
  const debugValue = env?.DEBUG;
  explicitlyConfigured = true;

  // Only recreate matcher if value changed
  if (cachedDebugValue !== debugValue) {
    cachedDebugValue = debugValue;
    cachedMatcher = createMatcher(debugValue);
  }
};

/**
 * Reset the debug configuration (useful for testing)
 */
debug.reset = function(): void {
  cachedMatcher = null;
  cachedDebugValue = null;
  explicitlyConfigured = false;
};

// Export types for external use
export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

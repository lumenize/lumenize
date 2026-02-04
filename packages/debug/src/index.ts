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

// Minimal process type for Node.js/Bun environment detection
// Avoids dependency on @types/node for packages using only workers-types
declare const process: { env?: { DEBUG?: string } } | undefined;

// Cloudflare Workers env from `cloudflare:workers` module
// Resolved via top-level await; null in non-Workers environments
let cfEnv: { DEBUG?: string } | null = null;
try {
  const mod = await import('cloudflare:workers');
  cfEnv = (mod as { env?: { DEBUG?: string } }).env ?? null;
} catch {
  // Not in Cloudflare Workers runtime — expected in Node.js, Bun, browser
}

/**
 * Cached matcher - lazily initialized on first use
 * In Workers, this gets recreated per-isolate which is correct behavior
 */
let cachedMatcher: ((namespace: string, level: DebugLevel) => boolean) | null = null;
let cachedDebugValue: string | undefined | null = null;

/**
 * Get the DEBUG filter value from the environment
 *
 * Auto-detects the runtime environment:
 * - Cloudflare Workers: `env.DEBUG` via `import('cloudflare:workers')`
 * - Node.js/Bun: `process.env.DEBUG`
 * - Browser: `localStorage.getItem('DEBUG')`
 *
 * @returns The DEBUG filter string or undefined
 */
function getDebugFilter(): string | undefined {
  // Cloudflare Workers (resolved at module init via top-level await)
  if (cfEnv?.DEBUG !== undefined) {
    return cfEnv.DEBUG;
  }

  // Node.js / Bun
  if (typeof process !== 'undefined' && process?.env?.DEBUG !== undefined) {
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
 * Works in all environments — Cloudflare Workers, Node.js, Bun, and browsers.
 * The DEBUG filter is auto-detected from the environment.
 *
 * @param namespace - The namespace for this logger (e.g., 'MyApp.myFunction')
 * @returns A debug logger with debug(), info(), warn(), and error() methods
 *
 * @example
 * ```typescript
 * import { debug } from '@lumenize/debug';
 *
 * const log = debug('MyApp.myFunction');
 * log.info('Something happened', { data });
 * ```
 */
export function debug(namespace: string): DebugLogger {
  return new DebugLoggerImpl({
    namespace,
    shouldLog: getMatcher(),
  });
}

/**
 * Reset the debug configuration (useful for testing)
 */
debug.reset = function(): void {
  cachedMatcher = null;
  cachedDebugValue = null;
};

// Export types for external use
export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

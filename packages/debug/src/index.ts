/**
 * @lumenize/debug - Zero-dependency debug logging
 *
 * Works in Cloudflare Workers, Node.js, Bun, Deno, and browsers. The runtime is
 * selected by package-export *conditions* (see `package.json` `exports`), not by
 * a runtime `try/catch`:
 *
 * - `workerd`  → `index.workerd.ts` — reads `env.DEBUG` from `cloudflare:workers`
 * - `node`     → `index.node.ts`    — reads `process.env.DEBUG` (also Bun/Deno)
 * - `browser`  → `index.browser.ts` — reads `localStorage.getItem('DEBUG')`
 *
 * This file is the universal fallback used for `types`/`main` resolution and by
 * any toolchain that loads the package's `main` directly. It intentionally
 * contains **no `cloudflare:workers` import**, so it can be bundled for the
 * browser (e.g. inside `@lumenize/mesh/client`) without a module-resolution
 * failure. It detects `process.env.DEBUG` (Node/Bun/Deno) and `localStorage`
 * (browser); Cloudflare Workers get `env.DEBUG` via the `workerd` condition.
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
 * - **Node.js/Bun/Deno**: Set `DEBUG` environment variable
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

import { createDebug } from './create-debug';

// Minimal process type for Node.js/Bun/Deno environment detection.
// Avoids a dependency on @types/node for packages using only workers-types.
declare const process: { env?: { DEBUG?: string } } | undefined;

/**
 * Get the DEBUG filter value without touching `cloudflare:workers`.
 *
 * Cloudflare Workers are served by `index.workerd.ts` via the `workerd`
 * export condition, so this universal entry only needs env + browser.
 */
function getDebugFilter(): string | undefined {
  // Node.js / Bun / Deno
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
 * Create a debug logger for a namespace.
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
export const debug = createDebug(getDebugFilter);

// Export types for external use
export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

// Test-only sink — not part of the documented public API. See ./sink.ts.
export { setDebugSink, clearDebugSink } from './sink';
export type { DebugSink } from './sink';

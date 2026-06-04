/**
 * @lumenize/debug — browser entry point (`browser` condition).
 *
 * Resolved under the `browser` package-export condition (set by esbuild/vite/
 * webpack browser builds). Reads the `DEBUG` filter from
 * `localStorage.getItem('DEBUG')`. Contains no `cloudflare:workers` or Node
 * (`process`) references, so it bundles cleanly for the browser — this is the
 * build that makes `@lumenize/mesh/client` browser-bundleable.
 *
 * Do NOT import this file directly — import `@lumenize/debug` and let the
 * bundler's export conditions pick this entry.
 */

import { createDebug } from './create-debug';

export const debug = createDebug(() => {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    return localStorage.getItem('DEBUG') ?? undefined;
  } catch {
    // localStorage may throw in some contexts (e.g., sandboxed iframes)
    return undefined;
  }
});

export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

// Test-only sink — not part of the documented public API. See ./sink.ts.
export { setDebugSink, clearDebugSink } from './sink';
export type { DebugSink } from './sink';

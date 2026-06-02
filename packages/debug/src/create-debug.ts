/**
 * Environment-agnostic core of `@lumenize/debug`.
 *
 * All the logic that does NOT depend on how the `DEBUG` filter is sourced lives
 * here. Each environment entry point (`index.workerd.ts`, `index.node.ts`,
 * `index.browser.ts`, and the universal `index.ts`) supplies its own
 * `getDebugFilter` and gets back a fully-formed `debug` factory.
 *
 * This split is what keeps the browser/Node builds free of any
 * `cloudflare:workers` import — that specifier only appears in
 * `index.workerd.ts`, which is resolved exclusively under the `workerd`
 * package-export condition. See `package.json` `exports`.
 */

import { createMatcher } from './pattern-matcher';
import { DebugLoggerImpl } from './logger';
import type { DebugLogger, DebugLevel } from './types';

/** The `debug(namespace)` factory, plus a `reset()` for tests. */
export type DebugFn = ((namespace: string) => DebugLogger) & { reset(): void };

/**
 * Build a `debug` factory bound to a specific `DEBUG`-filter source.
 *
 * The matcher is cached and only rebuilt when the filter value changes, so the
 * common hot path (filter unchanged) is a single map lookup.
 *
 * @param getDebugFilter - Reads the current `DEBUG` filter string for this
 *   environment (e.g. `env.DEBUG`, `process.env.DEBUG`, or
 *   `localStorage.getItem('DEBUG')`). Return `undefined` when unset.
 */
export function createDebug(getDebugFilter: () => string | undefined): DebugFn {
  let cachedMatcher: ((namespace: string, level: DebugLevel) => boolean) | null = null;
  let cachedDebugValue: string | undefined | null = null;

  function getMatcher(): (namespace: string, level: DebugLevel) => boolean {
    const currentDebugValue = getDebugFilter();

    // Reuse the cached matcher while the DEBUG value is unchanged.
    if (cachedMatcher !== null && cachedDebugValue === currentDebugValue) {
      return cachedMatcher;
    }

    cachedDebugValue = currentDebugValue;
    cachedMatcher = createMatcher(currentDebugValue);
    return cachedMatcher;
  }

  const debug = ((namespace: string): DebugLogger =>
    new DebugLoggerImpl({
      namespace,
      shouldLog: getMatcher(),
    })) as DebugFn;

  // Reset the cached configuration (useful for testing).
  debug.reset = function (): void {
    cachedMatcher = null;
    cachedDebugValue = null;
  };

  return debug;
}

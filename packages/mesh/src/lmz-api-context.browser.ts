/**
 * CallContext storage — browser implementation.
 *
 * Selected by the `browser` package-export condition (see
 * `packages/mesh/package.json` `imports` field). Uses a module-scoped
 * variable instead of `node:async_hooks` so the file bundles cleanly for
 * the browser — `node:async_hooks` is not available in browser runtimes
 * and the literal specifier causes static-analysis failures in vite/esbuild.
 *
 * # Caveat: no preservation across `await` boundaries
 *
 * The companion `lmz-api-context.workerd.ts` (server-side) uses real
 * `AsyncLocalStorage`, which transparently preserves the active context
 * across awaits via runtime async-context tracking. This module-variable
 * implementation does NOT — when a `fn` passed to `runWithCallContext`
 * awaits, control yields to the event loop. If another `runWithCallContext`
 * runs during the yield, the module variable is overwritten; when the
 * original `fn` resumes, `getCurrentCallContext()` returns the wrong value.
 *
 * What this means in practice:
 *
 * ✅ Safe: reading `this.lmz.callContext` synchronously inside an `@mesh()`
 *    handler before any await, or capturing it once and passing it through
 *    a closure.
 *
 * ❌ Unsafe: reading `this.lmz.callContext` after an `await` inside an
 *    `@mesh()` handler when there might be concurrent mesh calls in
 *    flight on the same client.
 *
 * No existing client-side `@mesh()` handler in `apps/nebula/` reads
 * `callContext` after an await (verified 2026-06-02), so this limitation
 * doesn't affect current usage. If a future use case needs full async-context
 * preservation in the browser, options include the TC39 `AsyncContext`
 * proposal (stage 3 at the time of writing), a zone.js-style monkey-patch,
 * or refactoring to thread context explicitly through closures.
 *
 * @internal
 */

import type { CallContext } from './types';

let currentContext: CallContext | undefined = undefined;

/**
 * Get the current call context.
 * Returns undefined when called outside a `runWithCallContext` scope OR
 * when called after an await inside a scope that has been replaced by a
 * concurrent call (see file-level caveat).
 */
export function getCurrentCallContext(): CallContext | undefined {
  return currentContext;
}

/**
 * Run a function with a specific call context.
 *
 * The context is preserved for synchronous code inside `fn` but NOT across
 * `await` boundaries (see file-level caveat). For workerd/Node, the
 * companion implementation provides full async-context preservation.
 */
export function runWithCallContext<T>(context: CallContext, fn: () => T): T {
  const prev = currentContext;
  currentContext = context;
  try {
    return fn();
  } finally {
    currentContext = prev;
  }
}

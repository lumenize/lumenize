/**
 * CallContext storage — workerd / Workers / Node / Bun / Deno implementation.
 *
 * Selected by the `workerd`, `worker`, and `node` package-export conditions
 * (see `packages/mesh/package.json` `imports` field). Uses Node.js's
 * `AsyncLocalStorage` API for true context preservation across `await`
 * boundaries — this is what lets `this.lmz.callContext` return the correct
 * context even when concurrent mesh calls are interleaved through awaits.
 *
 * The `cloudflare:workers` runtime provides `node:async_hooks` natively at
 * the project's `compatibility_date: "2026-03-12"` — no `nodejs_compat`
 * flag required.
 *
 * The companion `lmz-api-context.browser.ts` is a synchronous shim selected
 * for the `browser` condition; it does NOT preserve across awaits. See that
 * file for the caveat.
 *
 * @internal
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallContext } from './types';

const storage = new AsyncLocalStorage<CallContext>();

/**
 * Get the current call context from AsyncLocalStorage.
 * Returns undefined when called outside a `runWithCallContext` scope.
 */
export function getCurrentCallContext(): CallContext | undefined {
  return storage.getStore();
}

/**
 * Run a function with a specific call context.
 * The context is preserved across all `await` boundaries inside `fn`.
 */
export function runWithCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

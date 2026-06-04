/**
 * @lumenize/debug — Cloudflare Workers (`workerd`) entry point.
 *
 * Resolved only under the `workerd` (and `worker`) package-export condition, so
 * the static `cloudflare:workers` import below is always available here and
 * never reaches a browser/Node bundle. Reads the `DEBUG` filter from the Worker
 * `env` (wrangler.jsonc vars or `.dev.vars`).
 *
 * Do NOT import this file directly — import `@lumenize/debug` and let the
 * runtime's export conditions pick this entry.
 */

// @ts-ignore — cloudflare:workers resolves under the workerd condition, not in
// debug's own tsconfig.
import { env } from 'cloudflare:workers';
import { createDebug } from './create-debug';

export const debug = createDebug(
  () => (env as { DEBUG?: string } | undefined)?.DEBUG,
);

export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

// Test-only sink — not part of the documented public API. See ./sink.ts.
export { setDebugSink, clearDebugSink } from './sink';
export type { DebugSink } from './sink';

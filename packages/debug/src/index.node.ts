/**
 * @lumenize/debug — env-var entry point (`node` condition).
 *
 * Resolved under the `node` package-export condition. Despite the file name,
 * this is the "read `DEBUG` from an environment variable" build and is shared by
 * **Node.js, Bun, and Deno** — all of which fall through to the `node`
 * condition for npm packages. It contains no `cloudflare:workers` or browser
 * (`localStorage`) references.
 *
 * Do NOT import this file directly — import `@lumenize/debug` and let the
 * runtime's export conditions pick this entry.
 */

import { createDebug } from './create-debug';

// Minimal process type — avoids a dependency on @types/node.
declare const process: { env?: { DEBUG?: string } } | undefined;

export const debug = createDebug(() =>
  typeof process !== 'undefined' ? process?.env?.DEBUG : undefined,
);

export type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

// Test-only sink — not part of the documented public API. See ./sink.ts.
export { setDebugSink, clearDebugSink } from './sink';
export type { DebugSink } from './sink';

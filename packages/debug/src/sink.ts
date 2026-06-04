/**
 * Test-only sink for capturing every log entry from every `debug()` logger in
 * the current isolate. Not part of the package's documented public API — it
 * is exported because the Lumenize test suite needs to assert on log output,
 * but the surface may change without notice and is not advertised in the
 * package README or website docs.
 *
 * Production code MUST NOT depend on this module.
 *
 * Behavior when a sink is installed:
 * - Every `log.debug()` / `log.info()` / `log.warn()` / `log.error()` call
 *   feeds a `DebugLogOutput` entry to the sink.
 * - The DEBUG filter is bypassed entirely — sink-installed implies "capture
 *   everything," so tests don't need to set `DEBUG` to see filtered levels.
 * - The default `console.debug` output is REPLACED (not augmented) for the
 *   duration, so the sink can capture without polluting vitest output.
 *
 * Scope: the sink slot is **per-isolate / module-instance**. A sink installed
 * in a Node test process does NOT capture logs emitted inside a workerd
 * isolate (e.g., a DO running under vitest-pool-workers). For cross-isolate
 * capture, install the sink on each side independently.
 */
import type { DebugLogOutput } from './types';

/** Sink function signature — receives each log entry as it fires. */
export type DebugSink = (entry: DebugLogOutput) => void;

let currentSink: DebugSink | null = null;

/**
 * Install a sink to capture every log entry. See module docstring for behavior
 * and scope caveats.
 *
 * Pattern (single test):
 * ```ts
 * import { setDebugSink, clearDebugSink } from '@lumenize/debug';
 *
 * it('logs a warn', () => {
 *   const entries: DebugLogOutput[] = [];
 *   setDebugSink((e) => entries.push(e));
 *   // ... exercise code under test ...
 *   expect(entries.some((e) => e.level === 'warn')).toBe(true);
 *   clearDebugSink();
 * });
 * ```
 *
 * Pattern (across multiple tests in a describe): install in `beforeEach`,
 * tear down in `afterEach` with `clearDebugSink()` to avoid cross-test
 * leakage.
 *
 * Passing `null` is equivalent to `clearDebugSink()`.
 */
export function setDebugSink(fn: DebugSink | null): void {
  currentSink = fn;
}

/** Remove any installed sink. Safe to call when no sink is set. */
export function clearDebugSink(): void {
  currentSink = null;
}

/** Internal — `DebugLoggerImpl` reads this on every log call. */
export function getDebugSink(): DebugSink | null {
  return currentSink;
}

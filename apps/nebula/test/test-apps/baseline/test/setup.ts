/**
 * Baseline-project vitest setup.
 *
 * Bumps `vi.waitFor`'s default timeout from 1000 ms to 5000 ms. Several
 * baseline tests are sensitive to parallel-execution contention — each
 * waitFor independently waits for an async state transition that's usually
 * fast (< 100 ms) but can be pushed past the 1 s default when many tests
 * compete for CPU/IO. Per-call timeouts existed already where the test
 * author thought to add them; this setup makes the global default safer
 * for the rest.
 *
 * Callers passing an explicit `{ timeout: ... }` override the default
 * normally. The interval default of 50 ms is preserved.
 */
import { vi } from 'vitest';

const originalWaitFor = vi.waitFor;
const patchedWaitFor = ((fn: Parameters<typeof vi.waitFor>[0], options?: Parameters<typeof vi.waitFor>[1]) => {
  return originalWaitFor(fn, { timeout: 5000, interval: 50, ...options });
}) as typeof vi.waitFor;
vi.waitFor = patchedWaitFor;

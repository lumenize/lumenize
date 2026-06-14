/**
 * vitest setup — bump vi.waitFor default timeout from 1000 ms to 5000 ms.
 * Mirrors the baseline test-app's setup; under parallel contention the 1 s
 * default is fragile for any test that hits real network / DO bindings.
 */
import { vi } from 'vitest';

const originalWaitFor = vi.waitFor;
const patchedWaitFor = ((fn: never, options?: never) => {
  const baseDefaults = { timeout: 5000, interval: 50 };
  const opts = options ? { ...baseDefaults, ...(options as object) } : baseDefaults;
  return originalWaitFor(fn, opts as never);
}) as typeof vi.waitFor;
vi.waitFor = patchedWaitFor;

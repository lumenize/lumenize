/**
 * Frontend scaffold smoke — proves the frontend modules resolve in the jsdom
 * `frontend` project. Imports the factory skeleton + helpers via their relative
 * paths (not the `@lumenize/nebula/frontend` subpath, which transitively pulls
 * NebulaClient → @lumenize/{mesh,debug,state} — exercised by the baseline/e2e
 * suites instead; the subpath export-map itself is validated by `tsc`).
 * Capable-of-failing: a dropped export fails the imports; the factory skeleton
 * no longer throwing fails the last assertion.
 */
import { describe, it, expect } from 'vitest';
import { createNebulaClient } from '../../src/frontend/create-nebula-client';
import { textMerge, makeLongformResolver } from '../../src/frontend/text-merge';
import type { NebulaClient } from '../../src/nebula-client';
import type { StoreClient } from '../../src/frontend/types';

// Compile-time guard (P6 criterion 1): the real NebulaClient must structurally
// satisfy the StoreClient seam the factory depends on. P7 wires the real client
// through createNebulaStore (the first production call site); this keeps the
// contract enforced by `tsc` until then. Type-only — erased at runtime, so it
// does NOT pull NebulaClient's mesh/debug deps into the jsdom project.
const _seamGuard = (c: NebulaClient): StoreClient => c;
void _seamGuard;

describe('nebula frontend scaffold', () => {
  it('exposes the public surface', () => {
    expect(typeof createNebulaClient).toBe('function');
    expect(typeof textMerge).toBe('function');
    expect(typeof makeLongformResolver).toBe('function');
  });

  it('the factory skeleton throws until its v3 port lands', () => {
    expect(() => createNebulaClient({ appVersion: 'dev' })).toThrow(/not yet ported/);
  });
});

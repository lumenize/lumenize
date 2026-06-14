/**
 * Scaffold smoke — proves the package resolves and the public index wires up in
 * the jsdom unit environment. Capable-of-failing: if the index drops an export
 * or the package can't resolve, the imports fail; if the factory skeleton stops
 * throwing its "not yet ported" error, the last test fails. `textMerge` /
 * `makeLongformResolver` are real as of Phase 2 (see text-merge.test.ts); only
 * the factory remains a skeleton until its port phase.
 */
import { describe, it, expect } from 'vitest';
import { createNebulaClient, textMerge, makeLongformResolver } from '../../src/index';

describe('nebula-frontend scaffold', () => {
  it('exposes the public surface', () => {
    expect(typeof createNebulaClient).toBe('function');
    expect(typeof textMerge).toBe('function');
    expect(typeof makeLongformResolver).toBe('function');
  });

  it('the factory skeleton throws until its v3 port lands', () => {
    expect(() => createNebulaClient({ appVersion: 'dev' })).toThrow(/not yet ported/);
  });
});

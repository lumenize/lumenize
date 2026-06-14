/**
 * Scaffold smoke — proves the package resolves and the public index wires up in
 * the jsdom unit environment. Capable-of-failing: if the index drops an export
 * or the package can't resolve, the imports fail; if a skeleton stops throwing
 * the documented "not yet ported" error, the second test fails. Replaced by the
 * real factory/helper suites as the v3 port lands.
 */
import { describe, it, expect } from 'vitest';
import { createNebulaClient, textMerge } from '../../src/index';

describe('nebula-frontend scaffold', () => {
  it('exposes the public factory surface', () => {
    expect(typeof createNebulaClient).toBe('function');
    expect(typeof textMerge).toBe('function');
  });

  it('skeleton entry points throw until the v3 port lands', () => {
    expect(() => createNebulaClient({ appVersion: 'dev' })).toThrow(/not yet ported/);
    expect(() => textMerge('s', 'l', 'b')).toThrow(/not yet ported/);
  });
});

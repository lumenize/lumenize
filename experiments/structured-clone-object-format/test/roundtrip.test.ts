import { describe, it, expect } from 'vitest';
import {
  buildSyntheticDag,
  mutateAddLeaf,
  mutateRenameLabel,
  mutateMoveSingle,
  mutateMoveSubtree50,
  mutateGrantPermission,
} from '../src/dag';
import { ALL_FORMATS } from '../src/formats';
import { applyMergePatch, diff } from '../src/merge-patch';

describe('wire formats round-trip the DAG state', () => {
  for (const N of [100, 1000]) {
    for (const fmt of ALL_FORMATS) {
      it(`${fmt.name} round-trips N=${N}`, () => {
        const state = buildSyntheticDag(N, 1);
        const wire = fmt.encode(state);
        const decoded = fmt.decode(wire as never);
        expect(decoded).toEqual(state);
      });
    }
  }
});

describe('JSON.stringify(encode) → JSON.parse → decode preserves state', () => {
  // Catches accidental use of non-JSON types in wire encoding
  for (const fmt of ALL_FORMATS) {
    it(`${fmt.name} survives JSON round-trip`, () => {
      const state = buildSyntheticDag(200, 7);
      const wire = fmt.encode(state);
      const reparsed = JSON.parse(JSON.stringify(wire));
      const decoded = fmt.decode(reparsed);
      expect(decoded).toEqual(state);
    });
  }
});

describe('merge-patch: apply(before, diff(before, after)) === after', () => {
  const ops = [
    { name: 'add-leaf', fn: mutateAddLeaf },
    { name: 'rename-label', fn: mutateRenameLabel },
    { name: 'move-single', fn: mutateMoveSingle },
    { name: 'move-subtree-50', fn: mutateMoveSubtree50 },
    { name: 'grant-permission', fn: mutateGrantPermission },
  ];
  for (const fmt of ALL_FORMATS) {
    for (const op of ops) {
      it(`${fmt.name} + ${op.name}: patch reconstructs after (logical equality)`, () => {
        const state = buildSyntheticDag(1000, 1);
        const mutation = op.fn(state, 99);
        const wireBefore = JSON.parse(JSON.stringify(fmt.encode(mutation.before)));
        const wireAfter = JSON.parse(JSON.stringify(fmt.encode(mutation.after)));
        const patch = diff(wireBefore, wireAfter);
        const reconstructed = applyMergePatch(wireBefore, patch);
        // Logical (decoded) equality is the real correctness criterion.
        // Byte-level JSON identity is NOT required: under merge-patch, a
        // field-merge can produce different key-insertion order than a
        // fresh whole-object encoding, even when logical content matches.
        // This matters especially for the id-table formats (W1/W2/W3) on
        // add-leaf, where slot id shifts cause the diff to merge fields
        // rather than replace whole slots. See RESULTS.md § id-shift.
        const decodedAfter = fmt.decode(reconstructed as never);
        expect(decodedAfter).toEqual(mutation.after);
      });
    }
  }
});

describe('merge-patch sanity: diff(a, a) is undefined; arrays atomic; null deletes', () => {
  it('identical inputs → no-op patch', () => {
    expect(diff({ a: 1 }, { a: 1 })).toBeUndefined();
  });
  it('arrays are replaced wholesale', () => {
    expect(diff({ a: [1, 2, 3] }, { a: [1, 2, 4] })).toEqual({ a: [1, 2, 4] });
  });
  it('null deletes a key on apply', () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });
  it('nested object diffs are recursive', () => {
    expect(diff({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3 } })).toEqual({ a: { y: 3 } });
  });
});

describe('failing-probe: a degraded patch path must reject bad reconstructions', () => {
  // Verifies the test harness has signal — if the merge-patch implementation is
  // gutted to "always return the after object", our patch-size benchmarks become
  // meaningless. This test confirms diff is doing structural work.
  it('diff returns a strict subset of after, not after itself', () => {
    const before = { nodes: { n0: { label: 'A' }, n1: { label: 'B' } } };
    const after = { nodes: { n0: { label: 'A' }, n1: { label: 'X' } } };
    const patch = diff(before, after) as Record<string, unknown>;
    expect(patch).toEqual({ nodes: { n1: { label: 'X' } } });
    // Strictly smaller stringified
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(after).length);
  });
});

/**
 * Tests for the RFC 7396 JSON Merge Patch primitives and their integration
 * with `preprocess()` / `postprocess()` for the per-mutation sync use case.
 */

import { describe, it, expect } from 'vitest';
import {
  preprocess,
  postprocess,
  diff,
  applyMergePatch,
  type JsonValue,
} from '../src/index.js';

describe('diff / applyMergePatch — core semantics', () => {
  it('returns undefined for identical inputs', () => {
    expect(diff({ a: 1 }, { a: 1 })).toBeUndefined();
    expect(diff(null, null)).toBeUndefined();
    expect(diff([1, 2, 3], [1, 2, 3])).toBeUndefined();
  });

  it('null in patch deletes a key on apply', () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  it('arrays are atomic — any change replaces the whole array', () => {
    const before = { items: [1, 2, 3] };
    const after = { items: [1, 2, 4] };
    expect(diff(before, after)).toEqual({ items: [1, 2, 4] });
    expect(applyMergePatch(before as JsonValue, diff(before, after))).toEqual(after);
  });

  it('nested object diffs are recursive', () => {
    const before = { a: { x: 1, y: 2 }, b: { z: 3 } };
    const after = { a: { x: 1, y: 99 }, b: { z: 3 } };
    expect(diff(before, after)).toEqual({ a: { y: 99 } });
  });

  it('apply with undefined patch returns a deep clone of target', () => {
    const target = { a: 1, b: { c: 2 } };
    const result = applyMergePatch(target, undefined) as { a: number; b: { c: number } };
    expect(result).toEqual(target);
    expect(result).not.toBe(target);
    expect(result.b).not.toBe(target.b);
  });

  it('replacing a primitive with an object', () => {
    expect(applyMergePatch({ a: 1 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it('replacing an object with a primitive', () => {
    expect(applyMergePatch({ a: { x: 1 } }, { a: 7 })).toEqual({ a: 7 });
  });
});

describe('merge-patch over the W4 wire format', () => {
  it('rename: single nested field produces a tiny patch', () => {
    const before = preprocess({
      nodes: {
        n0: { slug: 'root', label: 'Root' },
        n1: { slug: 'child', label: 'Child' },
      },
    });
    const after = preprocess({
      nodes: {
        n0: { slug: 'root', label: 'Renamed' },
        n1: { slug: 'child', label: 'Child' },
      },
    });
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    expect(patch).toBeDefined();
    // Patch must be smaller than the full snapshot — the whole point of
    // the W4 format is per-field merge-patch granularity. For larger
    // documents the ratio is dramatic (see RESULTS.md); even at this tiny
    // size the patch is well under half the snapshot.
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(after).length);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    expect(postprocess(reconstructed as any)).toEqual(postprocess(after));
  });

  it('add-leaf: adding a sibling produces a small patch', () => {
    const before = preprocess({
      nodes: { n0: { label: 'A' }, n1: { label: 'B' } },
    });
    const after = preprocess({
      nodes: { n0: { label: 'A' }, n1: { label: 'B' }, n2: { label: 'C' } },
    });
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    expect(postprocess(reconstructed as any)).toEqual(postprocess(after));
  });

  it('Map: per-mutation patch round-trips logically', () => {
    const beforeMap = new Map<string, number>([['a', 1], ['b', 2]]);
    const afterMap = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]]);
    const before = preprocess(beforeMap);
    const after = preprocess(afterMap);
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    const restored = postprocess(reconstructed as any) as Map<string, number>;
    expect(restored).toBeInstanceOf(Map);
    expect(Array.from(restored.entries())).toEqual([
      ['a', 1], ['b', 2], ['c', 3],
    ]);
  });

  it('Date: changing a Date round-trips logically', () => {
    const before = preprocess(new Date('2020-01-01T00:00:00Z'));
    const after = preprocess(new Date('2025-12-31T23:59:59Z'));
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    expect(postprocess(reconstructed as any)).toEqual(new Date('2025-12-31T23:59:59Z'));
  });

  it('Error: changing a custom property round-trips logically', () => {
    const e1 = new Error('boom');
    (e1 as any).code = 'E_OLD';
    const e2 = new Error('boom');
    (e2 as any).code = 'E_NEW';
    const before = preprocess(e1);
    const after = preprocess(e2);
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    const restored = postprocess(reconstructed as any) as Error & { code: string };
    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('boom');
    expect(restored.code).toBe('E_NEW');
  });

  it('cycle-bearing graph: patches against aliases round-trip', () => {
    const a1: any = { kind: 'node', label: 'A' };
    const b1: any = { kind: 'node', label: 'B' };
    a1.other = b1;
    b1.other = a1; // cycle
    const a2: any = { kind: 'node', label: 'A-renamed' };
    const b2: any = { kind: 'node', label: 'B' };
    a2.other = b2;
    b2.other = a2;
    const before = preprocess(a1);
    const after = preprocess(a2);
    // Aliases must be present (cycles)
    expect((before.meta as any).aliases).toBeDefined();
    const patch = diff(before as unknown as JsonValue, after as unknown as JsonValue);
    const reconstructed = applyMergePatch(before as unknown as JsonValue, patch);
    const restored = postprocess(reconstructed as any) as any;
    expect(restored.label).toBe('A-renamed');
    // Cycle preserved
    expect(restored.other.other).toBe(restored);
  });
});

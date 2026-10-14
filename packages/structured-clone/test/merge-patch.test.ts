/**
 * `diff` and `applyMergePatch` over the codec's encoding: one change patches
 * to about its own size, and every key patches as data.
 *
 * The codec and the patch functions are pure, so these need no running system.
 *
 * Mutations, each of which reds a test here:
 * - encode every Map as `entries`, or every Set as `values`, or every array plain
 * - number the `$ref`s by a counter
 * - `in` rather than `Object.hasOwn` in `diff`, or in the equality check
 * - a bare bracket read in `diff` or in `applyMergePatch`
 * - plain assignment in `diff`, in the deep copy, or in `applyMergePatch`
 * - drop the prototype check, so two Dates diff to nothing
 */

import { describe, it, expect } from 'vitest';
import { preprocess, postprocess, diff, applyMergePatch, type JsonValue } from '../src/index.js';
import { applyDiff, patchThrough, shape } from './patching.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('diff / applyMergePatch — core semantics', () => {
  it('answers same for identical inputs', () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual({ kind: 'same' });
    expect(diff(null, null)).toEqual({ kind: 'same' });
    expect(diff([1, 2, 3], [1, 2, 3])).toEqual({ kind: 'same' });
  });

  it('null in patch deletes a key on apply', () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  it('arrays are atomic — any change replaces the whole array', () => {
    const before = { items: [1, 2, 3] };
    const after = { items: [1, 2, 4] };
    expect(diff(before, after)).toEqual({ kind: 'patches', patches: [{ items: [1, 2, 4] }] });
    expect(applyDiff(before, diff(before, after), after)).toEqual(after);
  });

  it('nested object diffs are recursive', () => {
    const before = { a: { x: 1, y: 2 }, b: { z: 3 } };
    const after = { a: { x: 1, y: 99 }, b: { z: 3 } };
    expect(diff(before, after)).toEqual({ kind: 'patches', patches: [{ a: { y: 99 } }] });
  });

  it('apply leaves the target unchanged', () => {
    const target = { a: 1, b: { c: 2 } };
    const result = applyMergePatch(target, { b: { c: 3 } });
    expect(result).toEqual({ a: 1, b: { c: 3 } });
    expect(target).toEqual({ a: 1, b: { c: 2 } });
  });

  it('replacing a primitive with an object, and an object with a primitive', () => {
    expect(applyMergePatch({ a: 1 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
    expect(applyMergePatch({ a: { x: 1 } }, { a: 7 })).toEqual({ a: 7 });
  });
});

describe('merge-patch over the encoding', () => {
  it('renaming one nested field patches that field', () => {
    const { answer, restore } = patchThrough(
      { nodes: { n0: { slug: 'root', label: 'Root' }, n1: { slug: 'child', label: 'Child' } } },
      { nodes: { n0: { slug: 'root', label: 'Renamed' }, n1: { slug: 'child', label: 'Child' } } },
    );
    expect(answer).toEqual({ kind: 'patches', patches: [{ nodes: { n0: { label: 'Renamed' } } }] });
    expect(restore().nodes.n0.label).toBe('Renamed');
  });

  it('a Date, an Error property and a cycle each patch and decode', () => {
    expect(patchThrough(new Date('2020-01-01T00:00:00Z'), new Date('2025-12-31T23:59:59Z')).restore())
      .toEqual(new Date('2025-12-31T23:59:59Z'));

    const restoredError = patchThrough(
      Object.assign(new Error('boom'), { code: 'E_OLD' }),
      Object.assign(new Error('boom'), { code: 'E_NEW' }),
    ).restore();
    expect(restoredError).toBeInstanceOf(Error);
    expect(restoredError.code).toBe('E_NEW');

    const a1: any = { label: 'A' };
    a1.other = { label: 'B', other: a1 };
    const a2: any = { label: 'A-renamed' };
    a2.other = { label: 'B', other: a2 };
    const { before, restore } = patchThrough(a1, a2);
    expect((before as any).other.other).toEqual({ $ref: '#' });
    const restored = restore();
    expect(restored.label).toBe('A-renamed');
    expect(restored.other.other).toBe(restored);
  });
});

describe('one change patches to about its own size', () => {
  // The org tree as Resources rebuilds it in memory: Map nodes, a Set of
  // `parentId:childId` edges and `Map<Map>` permissions, in creation order.
  function orgTree(size: number) {
    const nodes = new Map<string, { slug: string; label: string; deleted: boolean }>();
    const edges = new Set<string>();
    const permissions = new Map<string, Map<string, string>>();
    for (let i = 0; i < size; i++) {
      nodes.set(id(i), { slug: `node-${i}`, label: `Node ${i}`, deleted: false });
      if (i > 0) edges.add(`${id(Math.floor((i - 1) / 4))}:${id(i)}`);
      if (i % 10 === 0) permissions.set(id(i), new Map([[id(100_000 + i), 'admin'], [id(200_000 + i), 'read']]));
    }
    return { nodes, edges, permissions };
  }

  it('adding a leaf to a 1,000-node org tree patches to at most 300 B', () => {
    const before = orgTree(1000);
    const after = orgTree(1000);
    after.nodes.set(id(1000), { slug: 'node-1000', label: 'Node 1000', deleted: false });
    after.edges.add(`${id(10)}:${id(1000)}`);

    const { bytes, restore } = patchThrough(before, after);
    expect(bytes).toBeLessThanOrEqual(300);
    expect(shape(restore())).toEqual(shape(after));
  });

  it('one grant patches to at most 150 B', () => {
    const before = orgTree(1000);
    const after = orgTree(1000);
    after.permissions.get(id(500))!.set(id(300_000), 'admin');

    const { bytes, restore } = patchThrough(before, after);
    expect(bytes).toBeLessThanOrEqual(150);
    expect(shape(restore())).toEqual(shape(after));
  });

  it('adding one edge to a Set of 1,000 patches to at most 120 B', () => {
    const edges = Array.from({ length: 1000 }, (_, i) => `${id(i)}:${id(i + 1)}`);
    const { bytes, restore } = patchThrough(new Set(edges), new Set([...edges, `${id(5)}:${id(9999)}`]));

    expect(bytes).toBeLessThanOrEqual(120);
    expect([...restore()].at(-1)).toBe(`${id(5)}:${id(9999)}`);
  });

  it('adding one entry to a 1,000-entry Map<number, string> patches to at most 100 B', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => [i, `value-${i}`] as [number, string]);
    const { bytes, restore } = patchThrough(new Map(entries), new Map([...entries, [1000, 'value-1000']]));

    expect(bytes).toBeLessThanOrEqual(100);
    expect(restore().get(1000)).toBe('value-1000');
  });

  it('appending to or removing from a 500-id list patches to at most 100 B', () => {
    const ids = Array.from({ length: 500 }, (_, i) => id(i));
    const appended = patchThrough({ members: ids }, { members: [...ids, id(500)] });
    const removed = patchThrough({ members: ids }, { members: ids.filter((_, i) => i !== 3) });

    expect(appended.bytes).toBeLessThanOrEqual(100);
    expect(removed.bytes).toBeLessThanOrEqual(100);
    expect(appended.restore().members).toEqual([...ids, id(500)]);
    expect(removed.restore().members).toEqual(ids.filter((_, i) => i !== 3));
  });

  it('adding a shared pair ahead of 200 shared rows patches to at most 500 B', () => {
    const rows: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      const row = { id: id(i), label: `Row ${i}` };
      rows[`r${i}a`] = row;
      rows[`r${i}b`] = row;
    }
    const pinned = { id: id(999), label: 'Pinned' };
    const { bytes, restore } = patchThrough({ pinned: {}, rows }, { pinned: { first: pinned, second: pinned }, rows });

    expect(bytes).toBeLessThanOrEqual(500);
    const restored = restore();
    expect(restored.pinned.second).toBe(restored.pinned.first);
    expect(restored.rows.r7b).toBe(restored.rows.r7a);
  });
});

describe('a null survives a patch', () => {
  it('as a property value, which stays an own key', () => {
    const { answer, restore } = patchThrough({ a: 1, b: 2 }, { a: 1, b: null });

    expect(answer).toEqual({ kind: 'patches', patches: [{ b: { $type: 'null' } }] });
    const restored = restore();
    expect(Object.hasOwn(restored, 'b')).toBe(true);
    expect(restored.b).toBeNull();
  });

  it('as the top-level value, in both directions', () => {
    expect(patchThrough({ a: 1 }, null).restore()).toBeNull();
    expect(patchThrough(null, { a: 1 }).restore()).toEqual({ a: 1 });
  });
});

describe('every key is data to diff and applyMergePatch', () => {
  const ownProto = (value: unknown) => JSON.parse(`{"__proto__":${JSON.stringify(value)}}`);

  it.each([
    ['a plain key constructor', {}, { constructor: 1 }, { constructor: 2 }],
    ['a Map entry toString', new Map(), new Map([['toString', 1]]), new Map([['toString', 2]])],
    ['a Set member valueOf', new Set(['a']), new Set(['a', 'valueOf']), new Set(['a', 'valueOf', 'b'])],
    ['a Map entry __proto__', new Map(), new Map([['__proto__', 1]]), new Map([['__proto__', 2]])],
    ['an own __proto__ on a plain object', {}, ownProto({}), ownProto({ x: 1 })],
  ])('%s is added, changed and deleted', (_, empty, holding, changed) => {
    for (const [from, to] of [[empty, holding], [holding, changed], [changed, empty]]) {
      expect(shape(patchThrough(from, to).restore())).toEqual(shape(to));
    }
    expect(Object.getPrototypeOf(patchThrough(empty, holding).restore())).toBe(Object.getPrototypeOf(holding));
  });

  it('an own __proto__ renamed to a key holding the same value is a change', () => {
    const restored = patchThrough(ownProto({}), { y: {} }).restore();

    expect(Object.hasOwn(restored, '__proto__')).toBe(false);
    expect(restored).toEqual({ y: {} });
  });

  it('a nested object added under toString', () => {
    expect(patchThrough({ a: 1 }, { a: 1, toString: { deep: true } }).restore()).toEqual({ a: 1, toString: { deep: true } });
  });

  it('an own __proto__ in an array element and in a newly added subtree stays data', () => {
    const restored = patchThrough(
      { list: [] as unknown[] },
      { list: [ownProto({ isAdmin: true })], added: { inner: ownProto({ isAdmin: true }) } },
    ).restore();

    for (const object of [restored.list[0], restored.added.inner]) {
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
      expect(Object.hasOwn(object, '__proto__')).toBe(true);
      expect(object.isAdmin).toBeUndefined();
    }
    expect(({} as any).isAdmin).toBeUndefined();
  });

  it('an inherited property is never read as a value', () => {
    // A polluted Object.prototype is exactly what an own-property read ignores.
    Object.defineProperty(Object.prototype, 'polluted', { value: { isAdmin: true }, configurable: true, writable: true });
    try {
      expect(diff({}, { polluted: { isAdmin: true } })).toEqual({ kind: 'patches', patches: [{ polluted: { isAdmin: true } }] });
      expect(applyMergePatch({}, { polluted: { x: 1 } })).toEqual({ polluted: { x: 1 } });
      expect(diff({ polluted: 1 }, {})).toEqual({ kind: 'patches', patches: [{ polluted: null }] });
    } finally {
      delete (Object.prototype as any).polluted;
    }
  });

  it('refuses a decoded value', () => {
    // @ts-expect-error a Date is not JSON
    expect(() => diff(new Date(0), new Date(1))).toThrow(TypeError);
    // @ts-expect-error a Map is not JSON
    expect(() => applyMergePatch({}, { m: new Map([['a', 1]]) })).toThrow(TypeError);
  });

  it('types an encode, diff, apply and decode round trip with no cast', () => {
    const before: JsonValue = preprocess({ a: new Map([['k', 1]]) });
    const after: JsonValue = preprocess({ a: new Map([['k', 2]]) });
    const answer = diff(before, after);
    const patched: JsonValue = answer.kind === 'patches'
      ? answer.patches.reduce((target, patch) => applyMergePatch(target, patch), before)
      : after;
    // @ts-expect-error diff answers a Diff, which applyMergePatch does not take
    applyMergePatch(before, answer);
    expect(postprocess(patched).a.get('k')).toBe(2);
  });
});

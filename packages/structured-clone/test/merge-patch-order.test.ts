/**
 * A patch can move no key, so `diff` sets a reordered Map, Set or object-form
 * array again whole: under a plain object by two patches, deleting it and
 * then setting it, and at the root or inside a Map by answering `full`. Every
 * case decodes with each kept order checked, and in Node the same patches
 * applied by SQLite's `json_patch` decode to the same value.
 *
 * The codec and the patch functions are pure, so these need no running system.
 *
 * Mutations, each of which reds a test here:
 * - skip the order check, so a mid-array edit is one patch and decodes out of order
 * - stop at the first order change in an object
 * - compare members without their order inside an array
 * - read `object` without checking the collection is in object form
 * - declare the answers as a type alias, so the `@ts-expect-error` in
 *   `merge-patch.test.ts` no longer holds under `tsc`
 */

import { describe, it, expect } from 'vitest';
import { postprocess, applyMergePatch, type Diff, type JsonValue } from '../src/index.js';
import { patchThrough, patchBytes, shape } from './patching.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const step = (n: number) => `Step ${String(n).padStart(2, '0')}: ${'stir gently and wait until it thickens '.slice(0, 50)}`;

interface Case {
  name: string;
  before: unknown;
  after: unknown;
  kind: Diff['kind'];
  patches?: number;
}

// Each pair is a value before and after one edit, with the answer `diff` owes.
const map = (...keys: string[]) => new Map(keys.map((k, i) => [k, i]));
const steps = Array.from({ length: 12 }, (_, i) => step(i));
const editedSteps = steps.map((s, i) => (i === 5 ? `${s} (edited)` : s));
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => id(from + i));
const shared = { id: 'shared' };

const CASES: Case[] = [
  { name: 'a mid-array edit under a plain object', kind: 'patches', patches: 2,
    before: { title: 'Pie', note: 'n'.repeat(1500), steps }, after: { title: 'Pie', note: 'n'.repeat(1500), steps: editedSteps } },
  { name: "a plain object field's Map deleting a key and setting it again", kind: 'patches', patches: 2,
    before: { perms: map('a', 'b') }, after: { perms: new Map([['b', 1], ['a', 0]]) } },
  { name: 'the same reorder in a Map that is the root value', kind: 'full',
    before: map('a', 'b'), after: new Map([['b', 1], ['a', 0]]) },
  { name: 'the same reorder in a Map inside another Map', kind: 'full',
    before: new Map([['outer', map('a', 'b')]]), after: new Map([['outer', new Map([['b', 1], ['a', 0]])]]) },
  { name: 'a plain object rebuilt with a key in the middle', kind: 'patches', patches: 1,
    before: { title: 't', status: 's' }, after: { title: 't', dueDate: 'd', status: 's' } },
  { name: 'a reordered Map beside a changed sibling', kind: 'patches', patches: 2,
    before: { m: map('a', 'b'), n: 1 }, after: { m: new Map([['b', 1], ['a', 0]]), n: 2 } },
  { name: 'two reordered Maps under different parents', kind: 'patches', patches: 2,
    before: { p: { m: map('a', 'b') }, q: { m: map('c', 'd') } },
    after: { p: { m: new Map([['b', 1], ['a', 0]]) }, q: { m: new Map([['d', 1], ['c', 0]]) } } },
  { name: 'two reordered Maps under one parent', kind: 'patches', patches: 2,
    before: { m1: map('a', 'b'), m2: map('c', 'd') }, after: { m1: new Map([['b', 1], ['a', 0]]), m2: new Map([['d', 1], ['c', 0]]) } },
  { name: 'a reordered Map inside a plain array', kind: 'patches', patches: 1,
    before: { list: [map('a', 'b')] }, after: { list: [new Map([['b', 1], ['a', 0]])] } },
  { name: 'a Map gaining a number key, so it switches to entries', kind: 'patches', patches: 1,
    before: { m: new Map<unknown, number>([['a', 1]]) }, after: { m: new Map<unknown, number>([['a', 1], [2, 2]]) } },
  { name: 'a Set gaining a non-string member', kind: 'patches', patches: 1,
    before: { s: new Set<unknown>(['a']) }, after: { s: new Set<unknown>(['a', true]) } },
  { name: 'an array crossing 256 bytes upward', kind: 'patches', patches: 1,
    before: { list: ids(0, 6) }, after: { list: ids(0, 7) } },
  { name: 'an array crossing 256 bytes downward', kind: 'patches', patches: 1,
    before: { list: ids(0, 7) }, after: { list: ids(0, 6) } },
  { name: 'an array gaining a duplicate', kind: 'patches', patches: 1,
    before: { list: ids(0, 8) }, after: { list: [...ids(0, 8), id(0)] } },
  { name: "a shared object whose pointer moves with its Map's form", kind: 'patches', patches: 1,
    before: { m: new Map<unknown, unknown>([['k', shared]]), later: shared },
    after: { m: new Map<unknown, unknown>([['k', shared], [1, 'one']]), later: shared } },
  { name: 'a catch-up from {a, b} to {b, a} in one diff', kind: 'patches', patches: 2,
    before: { m: map('a', 'b') }, after: { m: new Map([['b', 1], ['a', 0]]) } },
];

describe('a change of order', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const { answer, restore } = patchThrough(c.before, c.after);

    expect(answer.kind).toBe(c.kind);
    if (answer.kind === 'patches') expect(answer.patches).toHaveLength(c.patches!);
    expect(shape(restore())).toEqual(shape(c.after));
  });

  it('costs about what replacing the collection costs today', () => {
    const recipe = CASES[0];
    const { bytes } = patchThrough(recipe.before, recipe.after);

    expect(bytes).toBeLessThanOrEqual(1.2 * JSON.stringify(editedSteps).length);
  });

  it('keeps a shared object one object when its pointer moves', () => {
    const c = CASES.find((x) => x.name.startsWith('a shared object'))!;
    const restored = patchThrough(c.before, c.after).restore();

    expect(restored.later).toBe(restored.m.get('k'));
  });

  it('never answers same for a reordered Map inside a plain array', () => {
    const c = CASES.find((x) => x.name === 'a reordered Map inside a plain array')!;

    expect(patchThrough(c.before, c.after).answer.kind).not.toBe('same');
  });

  it('catches up step by step through {b} to the same order', () => {
    const first = patchThrough({ m: map('a', 'b') }, { m: new Map([['b', 1]]) });
    const second = patchThrough({ m: new Map([['b', 1]]) }, { m: new Map([['b', 1], ['a', 0]]) });

    expect(first.answer).toMatchObject({ kind: 'patches', patches: [expect.anything()] });
    expect(second.answer).toMatchObject({ kind: 'patches', patches: [expect.anything()] });
    const viaSteps = [first, second].reduce<JsonValue>(
      (target, p) => (p.answer.kind === 'patches' ? p.answer.patches.reduce((t, patch) => applyMergePatch(t, patch), target) : target),
      first.before,
    );
    expect([...postprocess(viaSteps).m.keys()]).toEqual(['b', 'a']);
    expect(patchBytes(second.answer)).toBeLessThan(40);
  });
});

describe("SQLite's json_patch", () => {
  const isNode = globalThis.navigator?.userAgent?.startsWith('Node.js') === true;

  it.runIf(isNode)('applies every patch list above to the same value, nested once per patch', async () => {
    const sqlite = 'node:sqlite';
    const { DatabaseSync } = await import(/* @vite-ignore */ sqlite);
    const db = new DatabaseSync(':memory:');
    const patchOnce = db.prepare('SELECT json_patch(?, ?) AS patched');
    try {
      for (const c of CASES) {
        const { before, answer } = patchThrough(c.before, c.after);
        if (answer.kind !== 'patches') continue;
        let text = JSON.stringify(before);
        for (const patch of answer.patches) text = (patchOnce.get(text, JSON.stringify(patch)) as { patched: string }).patched;
        const viaSqlite = postprocess(JSON.parse(text));
        const viaOurs = postprocess(answer.patches.reduce((t, patch) => applyMergePatch(t, patch), before));

        expect(shape(viaSqlite), c.name).toEqual(shape(viaOurs));
        expect(shape(viaSqlite), c.name).toEqual(shape(c.after));
      }
    } finally {
      db.close();
    }
  });
});

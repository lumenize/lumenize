/**
 * deepEquals property tests — ported from the factory-textmerge isolation detour
 * (tasks/factory-textmerge.md; the vue-factory spike was removed in 5.3.7/P11). Pins the documented
 * semantics: plain JSON-shaped data + Date + cycles/aliases — NOT deep Maps,
 * Sets, TypedArrays, or class instances (those compare by reference).
 */
import { describe, it, expect } from 'vitest';
import { deepEquals } from '../../src/frontend/deep-equals';

describe('primitives', () => {
  it('identical primitives are equal', () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals('a', 'a')).toBe(true);
    expect(deepEquals(true, true)).toBe(true);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(undefined, undefined)).toBe(true);
  });

  it('different primitives are not equal', () => {
    expect(deepEquals(1, 2)).toBe(false);
    expect(deepEquals('a', 'b')).toBe(false);
    expect(deepEquals(0, '0')).toBe(false); // no coercion
    expect(deepEquals(true, 1)).toBe(false);
  });

  it('null/undefined never equal a value or each other', () => {
    expect(deepEquals(null, undefined)).toBe(false);
    expect(deepEquals(null, 0)).toBe(false);
    expect(deepEquals(undefined, '')).toBe(false);
    expect(deepEquals({}, null)).toBe(false);
  });

  it('NaN !== NaN (documented: SameValueZero is NOT used — a NaN write never dedups)', () => {
    expect(deepEquals(NaN, NaN)).toBe(false);
  });
});

describe('objects', () => {
  it('structurally equal nested objects are equal', () => {
    expect(deepEquals({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x' }] } })).toBe(true);
  });

  it('key order does not matter', () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('differing nested value is detected', () => {
    expect(deepEquals({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it('extra / missing keys are detected both directions', () => {
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("explicit-undefined key differs from absent key by key count (matches Lumenize's optional-over-nullable shape)", () => {
    expect(deepEquals({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  it('empty objects are equal', () => {
    expect(deepEquals({}, {})).toBe(true);
  });
});

describe('arrays', () => {
  it('equal arrays, including nested', () => {
    expect(deepEquals([1, [2, 3], { a: 4 }], [1, [2, 3], { a: 4 }])).toBe(true);
    expect(deepEquals([], [])).toBe(true);
  });

  it('length and element differences are detected', () => {
    expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
  });

  it('array never equals a plain object (either side)', () => {
    expect(deepEquals([], {})).toBe(false);
    expect(deepEquals({}, [])).toBe(false);
    expect(deepEquals({ 0: 'a', length: 1 }, ['a'])).toBe(false);
  });
});

describe('Date', () => {
  it('same instant ⇒ equal; different instant ⇒ not', () => {
    expect(deepEquals(new Date(1700000000000), new Date(1700000000000))).toBe(true);
    expect(deepEquals(new Date(1700000000000), new Date(1700000000001))).toBe(false);
  });

  it('Date never equals a non-Date', () => {
    expect(deepEquals(new Date(1700000000000), 1700000000000)).toBe(false);
    expect(deepEquals(new Date(1700000000000), {})).toBe(false);
  });

  it('Dates nested in structures participate', () => {
    expect(deepEquals({ at: new Date(42) }, { at: new Date(42) })).toBe(true);
    expect(deepEquals({ at: new Date(42) }, { at: new Date(43) })).toBe(false);
  });
});

describe('cycles and aliases (ADR-002 — structured-clone value space)', () => {
  it('structurally equal cyclic graphs are equal (no stack overflow)', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    const b: Record<string, unknown> = { name: 'x' };
    b.self = b;
    expect(deepEquals(a, b)).toBe(true);
  });

  it('cyclic graphs differing outside the cycle are detected', () => {
    const a: Record<string, unknown> = { name: 'x', extra: 1 };
    a.self = a;
    const b: Record<string, unknown> = { name: 'x', extra: 2 };
    b.self = b;
    expect(deepEquals(a, b)).toBe(false);
  });

  it('a structured-clone of a cyclic value equals its original', () => {
    const a: Record<string, unknown> = { items: [1, 2], meta: { tag: 't' } };
    a.root = a;
    expect(deepEquals(a, structuredClone(a))).toBe(true);
  });

  it('Map/Set compare by reference only — never falsely equal', () => {
    const m = new Map([['a', 1]]);
    expect(deepEquals(m, m)).toBe(true);
    expect(deepEquals(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false); // documented: no deep Map support
    expect(deepEquals({ tags: new Set([1]) }, { tags: new Set([1]) })).toBe(false);
  });
});

describe('reference vs structure', () => {
  it('same reference short-circuits true', () => {
    const o = { a: [1, 2, { b: 3 }] };
    expect(deepEquals(o, o)).toBe(true);
  });

  it('deeply different only at the leaf is still detected (capable-of-failing depth probe)', () => {
    const a = { l1: { l2: { l3: { l4: 'x' } } } };
    const b = { l1: { l2: { l3: { l4: 'y' } } } };
    expect(deepEquals(a, b)).toBe(false);
  });
});

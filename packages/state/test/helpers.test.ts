import { describe, it, expect } from 'vitest';
import { isValidPath, getPathParts, deepEquals } from '../src/helpers';

describe('isValidPath', () => {
  it('accepts a single-segment path', () => {
    expect(isValidPath('count')).toBe(true);
  });

  it('accepts a multi-segment dotted path', () => {
    expect(isValidPath('resources.todo.task-42.value.title')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidPath('')).toBe(false);
  });

  it('rejects whitespace-only string', () => {
    expect(isValidPath('   ')).toBe(false);
  });

  it('rejects paths containing consecutive dots', () => {
    expect(isValidPath('a..b')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidPath(123 as unknown)).toBe(false);
    expect(isValidPath(null)).toBe(false);
    expect(isValidPath(undefined)).toBe(false);
    expect(isValidPath({} as unknown)).toBe(false);
  });
});

describe('getPathParts', () => {
  it('splits on dots', () => {
    expect(getPathParts('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty segments', () => {
    expect(getPathParts('.a..b.')).toEqual(['a', 'b']);
  });

  it('handles single segment', () => {
    expect(getPathParts('count')).toEqual(['count']);
  });
});

describe('deepEquals', () => {
  it('returns true for identical primitives', () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals('x', 'x')).toBe(true);
    expect(deepEquals(true, true)).toBe(true);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(undefined, undefined)).toBe(true);
  });

  it('treats NaN as equal to NaN', () => {
    expect(deepEquals(NaN, NaN)).toBe(true);
  });

  it('returns false for differing primitives', () => {
    expect(deepEquals(1, 2)).toBe(false);
    expect(deepEquals('x', 'y')).toBe(false);
    expect(deepEquals(true, false)).toBe(false);
    expect(deepEquals(null, undefined)).toBe(false);
  });

  it('returns false when one side is null', () => {
    expect(deepEquals(null, {})).toBe(false);
    expect(deepEquals({}, null)).toBe(false);
  });

  it('compares plain objects structurally', () => {
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('compares nested objects', () => {
    expect(deepEquals({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
    expect(deepEquals({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
  });

  it('compares arrays', () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEquals([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it('distinguishes arrays from objects', () => {
    expect(deepEquals([], {})).toBe(false);
  });

  it('compares Dates by time', () => {
    const a = new Date('2026-05-12T00:00:00Z');
    const b = new Date('2026-05-12T00:00:00Z');
    const c = new Date('2026-05-13T00:00:00Z');
    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });

  it('compares Maps', () => {
    const a = new Map([
      ['x', 1],
      ['y', 2],
    ]);
    const b = new Map([
      ['x', 1],
      ['y', 2],
    ]);
    const c = new Map([
      ['x', 1],
      ['y', 3],
    ]);
    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });

  it('compares Sets', () => {
    expect(deepEquals(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(true);
    expect(deepEquals(new Set([1, 2, 3]), new Set([1, 2, 4]))).toBe(false);
  });

  it('compares RegExp by source and flags', () => {
    expect(deepEquals(/abc/gi, /abc/gi)).toBe(true);
    expect(deepEquals(/abc/g, /abc/gi)).toBe(false);
  });

  it('compares typed arrays', () => {
    expect(deepEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(deepEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('distinguishes typed-array kinds', () => {
    expect(deepEquals(new Uint8Array([1]), new Uint16Array([1]))).toBe(false);
  });

  it('compares raw ArrayBuffers by byte content', () => {
    const a = new ArrayBuffer(4);
    const b = new ArrayBuffer(4);
    new Uint8Array(a).set([1, 2, 3, 4]);
    new Uint8Array(b).set([1, 2, 3, 4]);
    expect(deepEquals(a, b)).toBe(true);

    const c = new ArrayBuffer(4);
    new Uint8Array(c).set([1, 2, 3, 5]);
    expect(deepEquals(a, c)).toBe(false);

    const d = new ArrayBuffer(8);
    expect(deepEquals(a, d)).toBe(false);
  });

  it('handles cyclic references without stack overflow', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const b: Record<string, unknown> = { x: 1 };
    b.self = b;
    expect(deepEquals(a, b)).toBe(true);

    const c: Record<string, unknown> = { x: 2 };
    c.self = c;
    expect(deepEquals(a, c)).toBe(false);
  });
});

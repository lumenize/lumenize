/**
 * RFC 7396 Appendix A conformance test.
 *
 * The fifteen test vectors below are the canonical example cases from
 * Appendix A of RFC 7396 (JSON Merge Patch):
 *   https://datatracker.ietf.org/doc/html/rfc7396#appendix-A
 *
 * Every conforming implementation of `applyMergePatch()` must produce
 * the expected RESULT for each (ORIGINAL, PATCH) pair. The RFC does not
 * define `diff()` — that's an implementation choice — but we additionally
 * round-trip check that `applyMergePatch(before, diff(before, after))`
 * yields `after`, which is the sync correctness property our consumers
 * actually rely on.
 *
 * Test vectors copied verbatim from the RFC (public spec; no license issue).
 */

import { describe, it, expect } from 'vitest';
import { applyMergePatch, diff, type JsonValue } from '../src/index.js';

interface Rfc7396Vector {
  original: JsonValue;
  patch: JsonValue;
  result: JsonValue;
  /** Optional human-readable label for failure reporting. */
  note?: string;
}

const RFC_7396_APPENDIX_A: Rfc7396Vector[] = [
  { original: { a: 'b' }, patch: { a: 'c' }, result: { a: 'c' }, note: 'replace string field' },
  { original: { a: 'b' }, patch: { b: 'c' }, result: { a: 'b', b: 'c' }, note: 'add new field' },
  { original: { a: 'b' }, patch: { a: null }, result: {}, note: 'delete via null' },
  { original: { a: 'b', b: 'c' }, patch: { a: null }, result: { b: 'c' }, note: 'delete one of two fields' },
  { original: { a: ['b'] }, patch: { a: 'c' }, result: { a: 'c' }, note: 'replace array with string' },
  { original: { a: 'c' }, patch: { a: ['b'] }, result: { a: ['b'] }, note: 'replace string with array' },
  { original: { a: { b: 'c' } }, patch: { a: { b: 'd', c: null } }, result: { a: { b: 'd' } }, note: 'nested object merge with null-delete' },
  { original: { a: [{ b: 'c' }] }, patch: { a: [1] }, result: { a: [1] }, note: 'arrays are atomic — wholesale replace' },
  { original: ['a', 'b'], patch: ['c', 'd'], result: ['c', 'd'], note: 'top-level array replacement' },
  { original: { a: 'b' }, patch: ['c'], result: ['c'], note: 'patch is array — replaces target' },
  { original: { a: 'foo' }, patch: null, result: null, note: 'patch null — replaces with null' },
  { original: { a: 'foo' }, patch: 'bar', result: 'bar', note: 'patch string — replaces' },
  { original: { e: null }, patch: { a: 1 }, result: { e: null, a: 1 }, note: 'existing null value preserved' },
  { original: [1, 2], patch: { a: 'b', c: null }, result: { a: 'b' }, note: 'target array, patch object — base becomes {}, null delete on absent key is no-op' },
  { original: {}, patch: { a: { bb: { ccc: null } } }, result: { a: { bb: {} } }, note: 'deeply nested creation with embedded null delete on absent leaf' },
];

describe('RFC 7396 Appendix A conformance', () => {
  RFC_7396_APPENDIX_A.forEach((vec, idx) => {
    const num = idx + 1;
    it(`vector ${num}: ${vec.note}`, () => {
      const out = applyMergePatch(vec.original, vec.patch);
      expect(out).toEqual(vec.result);
    });
  });
});

describe('RFC 7396 round-trip: apply(before, diff(before, after)) === after', () => {
  // Every Appendix A vector also serves as a round-trip case — `after` is
  // `result`. We don't expect our `diff()` to produce the same patch the
  // RFC shows (the spec only defines `apply`, not the canonical diff form),
  // but applying our diff must yield the same result.
  RFC_7396_APPENDIX_A.forEach((vec, idx) => {
    const num = idx + 1;
    it(`round-trip vector ${num}: ${vec.note}`, () => {
      const patch = diff(vec.original, vec.result);
      const out = applyMergePatch(vec.original, patch);
      expect(out).toEqual(vec.result);
    });
  });
});

describe('RFC 7396 additional edge cases (not in Appendix A but implied by spec)', () => {
  it('apply(target, undefined) returns a deep clone of target (our no-op sentinel)', () => {
    // RFC doesn't have a "no-op" patch — but our diff() returns undefined
    // for identical inputs, and apply() must handle it.
    const target = { a: 1, b: [2, 3] };
    const out = applyMergePatch(target, undefined) as { a: number; b: number[] };
    expect(out).toEqual(target);
    expect(out).not.toBe(target);
    expect(out.b).not.toBe(target.b);
  });

  it('diff(x, x) returns undefined (no-op sentinel)', () => {
    expect(diff({ a: 1 }, { a: 1 })).toBeUndefined();
    expect(diff(null, null)).toBeUndefined();
    expect(diff([1, 2], [1, 2])).toBeUndefined();
    expect(diff('foo', 'foo')).toBeUndefined();
  });

  it('null in a deeply-nested patch deletes', () => {
    expect(applyMergePatch({ a: { b: { c: 'x', d: 'y' } } }, { a: { b: { c: null } } }))
      .toEqual({ a: { b: { d: 'y' } } });
  });

  it('replacing a number with an object', () => {
    expect(applyMergePatch({ a: 1 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it('replacing an object with a number', () => {
    expect(applyMergePatch({ a: { x: 1 } }, { a: 7 })).toEqual({ a: 7 });
  });

  it('replacing a number with null deletes the key', () => {
    expect(applyMergePatch({ a: 7 }, { a: null })).toEqual({});
  });
});

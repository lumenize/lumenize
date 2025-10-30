/**
 * Special number tests (NaN, Infinity, -Infinity)
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess } from '../src/index.js';

describe('Special Numbers', () => {
  it('handles NaN', async () => {
    const result = await parse(await stringify(NaN));
    expect(result).toBeNaN();
  });

  it('handles Infinity', async () => {
    const result = await parse(await stringify(Infinity));
    expect(result).toBe(Infinity);
  });

  it('handles -Infinity', async () => {
    const result = await parse(await stringify(-Infinity));
    expect(result).toBe(-Infinity);
  });

  it('handles NaN in objects', async () => {
    const obj = { value: NaN, other: 42 };
    const result = await parse(await stringify(obj));
    expect(result.value).toBeNaN();
    expect(result.other).toBe(42);
  });

  it('handles Infinity in objects', async () => {
    const obj = { max: Infinity, min: -Infinity };
    const result = await parse(await stringify(obj));
    expect(result.max).toBe(Infinity);
    expect(result.min).toBe(-Infinity);
  });

  it('handles special numbers in arrays', async () => {
    const arr = [1, NaN, 2, Infinity, 3, -Infinity, 4];
    const result = await parse(await stringify(arr));
    expect(result[0]).toBe(1);
    expect(result[1]).toBeNaN();
    expect(result[2]).toBe(2);
    expect(result[3]).toBe(Infinity);
    expect(result[4]).toBe(3);
    expect(result[5]).toBe(-Infinity);
    expect(result[6]).toBe(4);
  });

  it('handles special numbers in nested structures', async () => {
    const nested = {
      stats: {
        avg: NaN,
        max: Infinity,
        min: -Infinity
      },
      values: [1, 2, NaN, Infinity]
    };
    const result = await parse(await stringify(nested));
    expect(result.stats.avg).toBeNaN();
    expect(result.stats.max).toBe(Infinity);
    expect(result.stats.min).toBe(-Infinity);
    expect(result.values[2]).toBeNaN();
    expect(result.values[3]).toBe(Infinity);
  });

  it('handles special numbers as Map values', async () => {
    const map = new Map([
      ['nan', NaN],
      ['inf', Infinity],
      ['neginf', -Infinity],
      ['normal', 42]
    ]);
    const result = await parse(await stringify(map));
    expect(result).toBeInstanceOf(Map);
    expect(result.get('nan')).toBeNaN();
    expect(result.get('inf')).toBe(Infinity);
    expect(result.get('neginf')).toBe(-Infinity);
    expect(result.get('normal')).toBe(42);
  });

  it('handles special numbers in Set', async () => {
    const set = new Set([1, NaN, Infinity, -Infinity, 2]);
    const result = await parse(await stringify(set));
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(5);
    // Note: NaN is special in Set - NaN === NaN in Set semantics
    expect(result.has(1)).toBe(true);
    expect(result.has(Infinity)).toBe(true);
    expect(result.has(-Infinity)).toBe(true);
    expect(result.has(2)).toBe(true);
    // Check for NaN (tricky because NaN !== NaN)
    let hasNaN = false;
    for (const val of result) {
      if (Number.isNaN(val)) {
        hasNaN = true;
        break;
      }
    }
    expect(hasNaN).toBe(true);
  });

  it('distinguishes between different special numbers', async () => {
    const obj = {
      a: NaN,
      b: NaN,  // Two NaNs
      c: Infinity,
      d: -Infinity
    };
    const result = await parse(await stringify(obj));
    expect(result.a).toBeNaN();
    expect(result.b).toBeNaN();
    expect(result.c).toBe(Infinity);
    expect(result.d).toBe(-Infinity);
    expect(result.c).not.toBe(result.d);
  });

  it('handles special numbers with normal numbers', async () => {
    const mixed = {
      zero: 0,
      negZero: -0,
      nan: NaN,
      inf: Infinity,
      negInf: -Infinity,
      normal: 42.5,
      negative: -42.5
    };
    const result = await parse(await stringify(mixed));
    expect(result.zero).toBe(0);
    // Note: -0 becomes +0 through JSON (known limitation)
    expect(result.negZero).toBe(0);
    expect(result.nan).toBeNaN();
    expect(result.inf).toBe(Infinity);
    expect(result.negInf).toBe(-Infinity);
    expect(result.normal).toBe(42.5);
    expect(result.negative).toBe(-42.5);
  });

  it('handles special numbers in circular references', async () => {
    const obj: any = {
      value: NaN,
      inf: Infinity
    };
    obj.self = obj;
    
    const result = await parse(await stringify(obj));
    expect(result.value).toBeNaN();
    expect(result.inf).toBe(Infinity);
    expect(result.self).toBe(result);
  });
});

describe('Special Numbers - Preprocess/Postprocess', () => {
  it('preprocesses special numbers correctly', async () => {
    const obj = { nan: NaN, inf: Infinity };
    const preprocessed = await preprocess(obj);
    const jsonString = JSON.stringify(preprocessed);
    const parsed = JSON.parse(jsonString);
    const result = await postprocess(parsed);
    
    expect(result.nan).toBeNaN();
    expect(result.inf).toBe(Infinity);
  });

  it('preprocessed special numbers are JSON-safe', async () => {
    const values = [NaN, Infinity, -Infinity];
    const preprocessed = await preprocess(values);
    
    // Should be able to stringify without losing information
    expect(() => JSON.stringify(preprocessed)).not.toThrow();
    const jsonString = JSON.stringify(preprocessed);
    expect(jsonString).not.toContain('null'); // NaN shouldn't become null
  });
});

describe('Special Numbers - Edge Cases', () => {
  it('handles NaN in different contexts', async () => {
    const contexts = {
      direct: NaN,
      calculation: 0 / 0,
      parseResult: parseInt('not a number')
    };
    const result = await parse(await stringify(contexts));
    expect(result.direct).toBeNaN();
    expect(result.calculation).toBeNaN();
    expect(result.parseResult).toBeNaN();
  });

  it('does not preserve sign of zero (JSON limitation)', async () => {
    // Note: +0 and -0 are NOT special numbers, but interesting edge case
    // JSON does not preserve the sign of zero - known limitation
    const obj = { pos: +0, neg: -0 };
    const result = await parse(await stringify(obj));
    // Both become +0 after JSON round-trip
    expect(Object.is(result.pos, +0)).toBe(true);
    expect(Object.is(result.neg, +0)).toBe(true); // -0 becomes +0
  });

  it('handles arrays of only special numbers', async () => {
    const arr = [NaN, Infinity, -Infinity];
    const result = await parse(await stringify(arr));
    expect(result).toHaveLength(3);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBe(Infinity);
    expect(result[2]).toBe(-Infinity);
  });
});


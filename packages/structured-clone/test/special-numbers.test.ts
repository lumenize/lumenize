/**
 * Special number tests (NaN, Infinity, -Infinity, -0)
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess } from '../src/index.js';

describe('Special Numbers', () => {
  it('handles NaN', async () => {
    const result = parse(stringify(NaN));
    expect(result).toBeNaN();
  });

  it('handles Infinity', async () => {
    const result = parse(stringify(Infinity));
    expect(result).toBe(Infinity);
  });

  it('handles -Infinity', async () => {
    const result = parse(stringify(-Infinity));
    expect(result).toBe(-Infinity);
  });

  it('handles NaN in objects', async () => {
    const obj = { value: NaN, other: 42 };
    const result = parse(stringify(obj));
    expect(result).toEqual(obj);
  });

  it('handles Infinity in objects', async () => {
    const obj = { max: Infinity, min: -Infinity };
    const result = parse(stringify(obj));
    expect(result).toEqual(obj);
  });

  it('handles special numbers in arrays', async () => {
    const arr = [1, NaN, 2, Infinity, 3, -Infinity, 4];
    const result = parse(stringify(arr));
    expect(result).toEqual(arr);
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
    const result = parse(stringify(nested));
    expect(result).toEqual(nested);
  });

  it('handles special numbers as Map values', async () => {
    const map = new Map([
      ['nan', NaN],
      ['inf', Infinity],
      ['neginf', -Infinity],
      ['normal', 42]
    ]);
    const result = parse(stringify(map));
    expect(result).toEqual(map);
  });

  it('handles special numbers in Set', async () => {
    const set = new Set([1, NaN, Infinity, -Infinity, 2]);
    const result = parse(stringify(set));
    expect(result).toEqual(set);
  });

  it('distinguishes between different special numbers', async () => {
    const obj = {
      a: NaN,
      b: NaN,  // Two NaNs
      c: Infinity,
      d: -Infinity
    };
    const result = parse(stringify(obj));
    expect(result).toEqual(obj);
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
    const result = parse(stringify(mixed));
    expect(result.zero).toBe(0);
    expect(result.negZero).toBe(-0);
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
    
    const result = parse(stringify(obj));
    expect(result).toEqual(obj);
  });
});

describe('Special Numbers - Preprocess/Postprocess', () => {
  it('preprocesses special numbers correctly', async () => {
    const obj = { nan: NaN, inf: Infinity };
    const preprocessed = preprocess(obj);
    const jsonString = JSON.stringify(preprocessed);
    const parsed = JSON.parse(jsonString);
    const result = postprocess(parsed);
    
    expect(result).toEqual(obj);
  });

  it('preprocessed special numbers are JSON-safe', async () => {
    const values = [NaN, Infinity, -Infinity];
    const preprocessed = preprocess(values);
    
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
    const result = parse(stringify(contexts));
    expect(result).toEqual(contexts);
  });

  // JSON writes -0 as 0, so -0 travels tagged; +0 must stay untagged and positive.
  it('preserves the sign of zero', async () => {
    const result = parse(stringify({
      pos: +0,
      neg: -0,
      inArray: [-0, 0],
      boxed: new Number(-0),
      floats: new Float64Array([-0, 0]),
    }));

    expect(Object.is(result.pos, +0)).toBe(true);
    expect(Object.is(result.neg, -0)).toBe(true);
    expect(result.inArray.map((n: number) => Object.is(n, -0))).toEqual([true, false]);
    expect(result.boxed).toBeInstanceOf(Number);
    expect(Object.is(result.boxed.valueOf(), -0)).toBe(true);
    expect(Array.from(result.floats, (n: number) => Object.is(n, -0))).toEqual([true, false]);
    expect(Object.is(parse(stringify(-0)), -0)).toBe(true);
  });

  it('handles arrays of only special numbers', async () => {
    const arr = [NaN, Infinity, -Infinity];
    const result = parse(stringify(arr));
    expect(result).toEqual(arr);
  });
});


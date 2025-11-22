/**
 * Core functionality tests
 * Tests structured clone with tuple-based $lmz format
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess } from '../src/index.js';

describe('Core Types', () => {
  it('handles primitives', async () => {
    expect(parse(await stringify(null))).toBe(null);
    expect(parse(await stringify(undefined))).toBe(undefined);
    expect(parse(await stringify(true))).toBe(true);
    expect(parse(await stringify(false))).toBe(false);
    expect(parse(await stringify(123))).toBe(123);
    expect(parse(await stringify('hello'))).toBe('hello');
  });

  it('handles arrays', async () => {
    const arr = [1, 2, 3, 'four', true, null];
    const result = parse(await stringify(arr));
    expect(result).toEqual(arr);
  });

  it('handles plain objects', async () => {
    const obj = { a: 1, b: 'two', c: true, d: null };
    const result = parse(await stringify(obj));
    expect(result).toEqual(obj);
  });

  it('handles nested structures', async () => {
    const nested = {
      array: [1, 2, { nested: true }],
      object: { deep: { deeper: 'value' } }
    };
    const result = parse(await stringify(nested));
    expect(result).toEqual(nested);
  });
});

describe('Special Types', () => {
  it('handles Date objects', async () => {
    const date = new Date('2025-01-30T12:00:00Z');
    const result = parse(await stringify(date));
    expect(result).toEqual(date);
  });

  it('handles RegExp objects', async () => {
    const regex = /test\d+/gi;
    const result = parse(await stringify(regex));
    expect(result).toEqual(regex);
  });

  it('handles Map objects', async () => {
    const map = new Map<any, any>([
      ['key1', 'value1'],
      ['key2', 42],
      [{ nested: true }, 'nested key']
    ]);
    const result = parse(await stringify(map));
    expect(result).toEqual(map);
  });

  it('handles Set objects', async () => {
    const set = new Set([1, 2, 3, 'four', true]);
    const result = parse(await stringify(set));
    expect(result).toEqual(set);
  });

  it('handles BigInt values', async () => {
    const bigint = BigInt('9007199254740991');
    const result = parse(await stringify(bigint));
    expect(result).toBe(bigint);
  });

  it('handles Error objects', async () => {
    const error = new Error('Test error');
    const result = parse(await stringify(error));
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Test error');
  });

  it('handles TypeError objects', async () => {
    const error = new TypeError('Type error');
    const result = parse(await stringify(error));
    // Note: Error subclass types are preserved
    expect(result).toBeInstanceOf(TypeError);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Type error');
  });
});

describe('TypedArrays', () => {
  it('handles Uint8Array', async () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5]);
    const result = parse(await stringify(arr));
    expect(result).toEqual(arr);
  });

  it('handles Int16Array', async () => {
    const arr = new Int16Array([-100, 0, 100]);
    const result = parse(await stringify(arr));
    expect(result).toEqual(arr);
  });

  it('handles Float32Array', async () => {
    const arr = new Float32Array([1.5, 2.7, 3.9]);
    const result = parse(await stringify(arr));
    expect(result).toEqual(arr);
  });

  it('handles ArrayBuffer', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = parse(await stringify(buffer));
    expect(new Uint8Array(result)).toEqual(new Uint8Array(buffer));
  });

  it('handles DataView', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const view = new DataView(buffer);
    const result = parse(await stringify(view));
    expect(result).toBeInstanceOf(DataView);
    expect(result.byteLength).toBe(4);
  });
});

describe('Circular References', () => {
  it('handles self-referencing objects', async () => {
    const obj: any = { name: 'circular' };
    obj.self = obj;
    
    const result = parse(await stringify(obj));
    expect(result.name).toBe('circular');
    expect(result.self).toBe(result);
    expect(result).toEqual(obj);
  });

  it('handles self-referencing arrays', async () => {
    const arr: any = [1, 2, 3];
    arr.push(arr);
    
    const result = parse(await stringify(arr));
    expect(result[0]).toBe(1);
    expect(result[3]).toBe(result);
  });

  it('handles complex circular structures', async () => {
    const obj1: any = { name: 'obj1' };
    const obj2: any = { name: 'obj2' };
    obj1.ref = obj2;
    obj2.ref = obj1;
    
    const result = parse(await stringify(obj1));
    expect(result.name).toBe('obj1');
    expect(result.ref.name).toBe('obj2');
    expect(result.ref.ref).toBe(result);
  });

  it('handles circular references in Maps', async () => {
    const map: any = new Map();
    map.set('self', map);
    map.set('key', 'value');
    
    const result = parse(await stringify(map));
    expect(result.get('key')).toBe('value');
    expect(result.get('self')).toBe(result);
  });

  it('handles circular references in Sets', async () => {
    const set: any = new Set();
    set.add(1);
    set.add(set);
    
    const result = parse(await stringify(set));
    expect(result.has(1)).toBe(true);
    expect(result.has(result)).toBe(true);
  });
});

describe('Edge Cases', () => {
  it('handles empty arrays', async () => {
    const result = parse(await stringify([]));
    expect(result).toEqual([]);
  });

  it('handles empty objects', async () => {
    const result = parse(await stringify({}));
    expect(result).toEqual({});
  });

  it('handles empty Maps', async () => {
    const result = parse(await stringify(new Map()));
    expect(result).toEqual(new Map());
  });

  it('handles empty Sets', async () => {
    const result = parse(await stringify(new Set()));
    expect(result).toEqual(new Set());
  });

  it('converts functions to markers', async () => {
    const obj = { func: () => 'test', value: 123 };
    const result = parse(await stringify(obj));
    
    expect(result.value).toBe(123);
    expect(result.func).toBeDefined();
    expect(result.func.name).toBeDefined();
    expect(typeof result.func.name).toBe('string');
  });

  it('converts functions in arrays to markers', async () => {
    const arr = [1, () => 'test', 3];
    const result = parse(await stringify(arr));
    
    expect(result[0]).toBe(1);
    expect(result[1]).toBeDefined();
    expect(result[1].name).toBeDefined();
    expect(typeof result[1].name).toBe('string');
    expect(result[2]).toBe(3);
  });

  it('converts nested functions to markers', async () => {
    const obj = {
      nested: {
        func: () => 'test'
      }
    };
    const result = parse(await stringify(obj));
    
    expect(result.nested.func).toBeDefined();
    expect(result.nested.func.name).toBeDefined();
    expect(typeof result.nested.func.name).toBe('string');
  });

  it('throws on symbols', async () => {
    const sym = Symbol('test');
    const obj = { symbolValue: sym, normal: 'value' };
    await expect(stringify(obj)).rejects.toThrow(TypeError);
    await expect(stringify(obj)).rejects.toThrow('unable to serialize symbol');
  });

  it('throws on symbol in Map key', async () => {
    const map = new Map([[Symbol('key'), 'value']]);
    await expect(stringify(map)).rejects.toThrow(TypeError);
  });

  it('throws on symbol in Set', async () => {
    const set = new Set([1, Symbol('test')]);
    await expect(stringify(set)).rejects.toThrow(TypeError);
  });
});

describe('Preprocess/Postprocess', () => {
  it('preprocess/postprocess round-trip', async () => {
    const o = { a: 1, b: 2 };
    expect(postprocess(await preprocess(o))).toEqual(o);
  });

  it('round-trip with complex types', async () => {
    const original = { date: new Date(), map: new Map([['key', 'value']]) };
    expect(postprocess(await preprocess(original))).toEqual(original);
  });

  it('round-trip with JSON.stringify/parse (MessagePort/BroadcastChannel)', async () => {
    const original = {
      date: new Date('2025-01-30'),
      set: new Set([1, 2, 3]),
      nested: { value: 42 }
    };
    const intermediate = await preprocess(original);
    const transported = JSON.parse(JSON.stringify(intermediate));
    expect(postprocess(transported)).toEqual(original);
  });
});

describe('Wrapper Types', () => {
  it('handles Boolean objects', async () => {
    const bool = new Boolean(true);
    const result = parse(await stringify(bool));
    expect(result.valueOf()).toBe(true);
  });

  it('handles Number objects', async () => {
    const num = new Number(42);
    const result = parse(await stringify(num));
    expect(result.valueOf()).toBe(42);
  });

  it('handles String objects', async () => {
    const str = new String('hello');
    const result = parse(await stringify(str));
    expect(result.valueOf()).toBe('hello');
  });

  it('handles BigInt objects', async () => {
    const bigint = Object(BigInt(123));
    const result = parse(await stringify(bigint));
    expect(result.valueOf()).toBe(BigInt(123));
  });
});


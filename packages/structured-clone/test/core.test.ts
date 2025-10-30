/**
 * Core functionality tests
 * Ported and adapted from @ungap/structured-clone test suite
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess } from '../src/index.js';

describe('Core Types', () => {
  it('handles primitives', async () => {
    expect(await parse(await stringify(null))).toBe(null);
    expect(await parse(await stringify(undefined))).toBe(undefined);
    expect(await parse(await stringify(true))).toBe(true);
    expect(await parse(await stringify(false))).toBe(false);
    expect(await parse(await stringify(123))).toBe(123);
    expect(await parse(await stringify('hello'))).toBe('hello');
  });

  it('handles arrays', async () => {
    const arr = [1, 2, 3, 'four', true, null];
    const result = await parse(await stringify(arr));
    expect(result).toEqual(arr);
  });

  it('handles plain objects', async () => {
    const obj = { a: 1, b: 'two', c: true, d: null };
    const result = await parse(await stringify(obj));
    expect(result).toEqual(obj);
  });

  it('handles nested structures', async () => {
    const nested = {
      array: [1, 2, { nested: true }],
      object: { deep: { deeper: 'value' } }
    };
    const result = await parse(await stringify(nested));
    expect(result).toEqual(nested);
  });
});

describe('Special Types', () => {
  it('handles Date objects', async () => {
    const date = new Date('2025-01-30T12:00:00Z');
    const result = await parse(await stringify(date));
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(date.getTime());
  });

  it('handles RegExp objects', async () => {
    const regex = /test\d+/gi;
    const result = await parse(await stringify(regex));
    expect(result).toBeInstanceOf(RegExp);
    expect(result.source).toBe(regex.source);
    expect(result.flags).toBe(regex.flags);
  });

  it('handles Map objects', async () => {
    const map = new Map([
      ['key1', 'value1'],
      ['key2', 42],
      [{ nested: true }, 'nested key']
    ]);
    const result = await parse(await stringify(map));
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(3);
    expect(result.get('key1')).toBe('value1');
    expect(result.get('key2')).toBe(42);
  });

  it('handles Set objects', async () => {
    const set = new Set([1, 2, 3, 'four', true]);
    const result = await parse(await stringify(set));
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(5);
    expect(result.has(1)).toBe(true);
    expect(result.has('four')).toBe(true);
  });

  it('handles BigInt values', async () => {
    const bigint = BigInt('9007199254740991');
    const result = await parse(await stringify(bigint));
    expect(result).toBe(bigint);
  });

  it('handles Error objects', async () => {
    const error = new Error('Test error');
    const result = await parse(await stringify(error));
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Test error');
  });

  it('handles TypeError objects', async () => {
    const error = new TypeError('Type error');
    const result = await parse(await stringify(error));
    // Note: @ungap/structured-clone doesn't preserve Error subclass types
    // TypeError becomes Error (limitation of original implementation)
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Type error');
  });
});

describe('TypedArrays', () => {
  it('handles Uint8Array', async () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await parse(await stringify(arr));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles Int16Array', async () => {
    const arr = new Int16Array([-100, 0, 100]);
    const result = await parse(await stringify(arr));
    expect(result).toBeInstanceOf(Int16Array);
    expect(Array.from(result)).toEqual([-100, 0, 100]);
  });

  it('handles Float32Array', async () => {
    const arr = new Float32Array([1.5, 2.7, 3.9]);
    const result = await parse(await stringify(arr));
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([1.5, 2.700000047683716, 3.9000000953674316]);
  });

  it('handles ArrayBuffer', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await parse(await stringify(buffer));
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('handles DataView', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const view = new DataView(buffer);
    const result = await parse(await stringify(view));
    expect(result).toBeInstanceOf(DataView);
    expect(result.byteLength).toBe(4);
  });
});

describe('Circular References', () => {
  it('handles self-referencing objects', async () => {
    const obj: any = { name: 'circular' };
    obj.self = obj;
    
    const result = await parse(await stringify(obj));
    expect(result.name).toBe('circular');
    expect(result.self).toBe(result);
  });

  it('handles self-referencing arrays', async () => {
    const arr: any = [1, 2, 3];
    arr.push(arr);
    
    const result = await parse(await stringify(arr));
    expect(result[0]).toBe(1);
    expect(result[3]).toBe(result);
  });

  it('handles complex circular structures', async () => {
    const obj1: any = { name: 'obj1' };
    const obj2: any = { name: 'obj2' };
    obj1.ref = obj2;
    obj2.ref = obj1;
    
    const result = await parse(await stringify(obj1));
    expect(result.name).toBe('obj1');
    expect(result.ref.name).toBe('obj2');
    expect(result.ref.ref).toBe(result);
  });

  it('handles circular references in Maps', async () => {
    const map: any = new Map();
    map.set('self', map);
    map.set('key', 'value');
    
    const result = await parse(await stringify(map));
    expect(result.get('key')).toBe('value');
    expect(result.get('self')).toBe(result);
  });

  it('handles circular references in Sets', async () => {
    const set: any = new Set();
    set.add(1);
    set.add(set);
    
    const result = await parse(await stringify(set));
    expect(result.has(1)).toBe(true);
    expect(result.has(result)).toBe(true);
  });
});

describe('Edge Cases', () => {
  it('handles empty arrays', async () => {
    const result = await parse(await stringify([]));
    expect(result).toEqual([]);
  });

  it('handles empty objects', async () => {
    const result = await parse(await stringify({}));
    expect(result).toEqual({});
  });

  it('handles empty Maps', async () => {
    const result = await parse(await stringify(new Map()));
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('handles empty Sets', async () => {
    const result = await parse(await stringify(new Set()));
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('converts functions to markers', async () => {
    const obj = { func: () => 'test', value: 123 };
    const result = await parse(await stringify(obj));
    
    expect(result.value).toBe(123);
    expect(result.func).toBeDefined();
    expect(result.func.__lmz_Function).toBe(true);
    expect(result.func.__operationChain).toBeDefined();
    expect(result.func.__functionName).toBe('func');
  });

  it('converts functions in arrays to markers', async () => {
    const arr = [1, () => 'test', 3];
    const result = await parse(await stringify(arr));
    
    expect(result[0]).toBe(1);
    expect(result[1].__lmz_Function).toBe(true);
    expect(result[1].__functionName).toBe('1');
    expect(result[2]).toBe(3);
  });

  it('handles operation chains for nested functions', async () => {
    const obj = {
      nested: {
        func: () => 'test'
      }
    };
    const result = await parse(await stringify(obj));
    
    expect(result.nested.func.__lmz_Function).toBe(true);
    expect(result.nested.func.__operationChain).toHaveLength(2);
    expect(result.nested.func.__operationChain[0].key).toBe('nested');
    expect(result.nested.func.__operationChain[1].key).toBe('func');
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
  it('preprocess returns object array', async () => {
    const result = await preprocess({ a: 1, b: 2 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('postprocess restores from preprocessed', async () => {
    const original = { date: new Date(), map: new Map([['key', 'value']]) };
    const preprocessed = await preprocess(original);
    const restored = await postprocess(preprocessed);
    
    expect(restored.date).toBeInstanceOf(Date);
    expect(restored.map).toBeInstanceOf(Map);
    expect(restored.map.get('key')).toBe('value');
  });

  it('manual JSON.stringify/parse with preprocess/postprocess', async () => {
    const original = {
      date: new Date('2025-01-30'),
      set: new Set([1, 2, 3]),
      nested: { value: 42 }
    };
    
    const preprocessed = await preprocess(original);
    const jsonString = JSON.stringify(preprocessed);
    const parsed = JSON.parse(jsonString);
    const restored = await postprocess(parsed);
    
    expect(restored.date).toBeInstanceOf(Date);
    expect(restored.set).toBeInstanceOf(Set);
    expect(restored.set.size).toBe(3);
    expect(restored.nested.value).toBe(42);
  });
});

describe('Wrapper Types', () => {
  it('handles Boolean objects', async () => {
    const bool = new Boolean(true);
    const result = await parse(await stringify(bool));
    expect(result.valueOf()).toBe(true);
  });

  it('handles Number objects', async () => {
    const num = new Number(42);
    const result = await parse(await stringify(num));
    expect(result.valueOf()).toBe(42);
  });

  it('handles String objects', async () => {
    const str = new String('hello');
    const result = await parse(await stringify(str));
    expect(result.valueOf()).toBe('hello');
  });

  it('handles BigInt objects', async () => {
    const bigint = Object(BigInt(123));
    const result = await parse(await stringify(bigint));
    expect(result.valueOf()).toBe(BigInt(123));
  });
});


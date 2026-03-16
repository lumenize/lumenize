/**
 * validate() tests — positive validation, negative type-checking, performance.
 */

import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate';

// ============================================================================
// Guard tests
// ============================================================================

describe('validate — guards', () => {
  it('throws TypeError for empty typeDefinitions', () => {
    expect(() => validate({}, 'Foo', '')).toThrow(TypeError);
    expect(() => validate({}, 'Foo', '')).toThrow('typeDefinitions must not be empty');
  });

  it('throws TypeError for whitespace-only typeDefinitions', () => {
    expect(() => validate({}, 'Foo', '   \n  ')).toThrow(TypeError);
  });

  it('throws RangeError for oversized combined program', () => {
    const bigType = `interface Big { ${'x: string; '.repeat(30000)} }`;
    expect(() => validate({}, 'Big', bigType)).toThrow(RangeError);
    expect(() => validate({}, 'Big', bigType)).toThrow('Combined program size exceeds 256 KB limit');
  });
});

// ============================================================================
// Positive validation tests
// ============================================================================

describe('validate — positive (valid: true)', () => {
  it('simple object', () => {
    const result = validate(
      { title: 'Fix bug', done: false },
      'Todo',
      'interface Todo { title: string; done: boolean; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('string primitive', () => {
    const result = validate('hello', 'T', 'type T = string;');
    expect(result).toEqual({ valid: true });
  });

  it('number primitive', () => {
    const result = validate(42, 'T', 'type T = number;');
    expect(result).toEqual({ valid: true });
  });

  it('boolean primitive', () => {
    const result = validate(true, 'T', 'type T = boolean;');
    expect(result).toEqual({ valid: true });
  });

  it('null', () => {
    const result = validate(null, 'T', 'type T = null;');
    expect(result).toEqual({ valid: true });
  });

  it('undefined', () => {
    const result = validate(undefined, 'T', 'type T = undefined;');
    expect(result).toEqual({ valid: true });
  });

  it('bigint', () => {
    const result = validate(BigInt('123'), 'T', 'type T = bigint;');
    expect(result).toEqual({ valid: true });
  });

  it('Date', () => {
    const result = validate(
      new Date('2026-01-15'),
      'T',
      'type T = Date;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('RegExp', () => {
    const result = validate(/test/gi, 'T', 'type T = RegExp;');
    expect(result).toEqual({ valid: true });
  });

  it('URL', () => {
    const result = validate(
      new URL('https://example.com'),
      'T',
      'type T = URL;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('array of numbers', () => {
    const result = validate([1, 2, 3], 'T', 'type T = number[];');
    expect(result).toEqual({ valid: true });
  });

  it('nested object', () => {
    const result = validate(
      { user: { name: 'Alice', age: 30 } },
      'T',
      'interface User { name: string; age: number; }\ninterface T { user: User; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Map<string, number>', () => {
    const result = validate(
      new Map([['a', 1], ['b', 2]]),
      'T',
      'type T = Map<string, number>;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Set<string>', () => {
    const result = validate(
      new Set(['a', 'b', 'c']),
      'T',
      'type T = Set<string>;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('ArrayBuffer', () => {
    const result = validate(
      new ArrayBuffer(16),
      'T',
      'type T = ArrayBuffer;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Uint8Array', () => {
    const result = validate(
      new Uint8Array([1, 2, 3]),
      'T',
      'type T = Uint8Array;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Float64Array', () => {
    const result = validate(
      new Float64Array([1.5, 2.5]),
      'T',
      'type T = Float64Array;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('BigInt64Array', () => {
    const result = validate(
      new BigInt64Array([1n, 2n]),
      'T',
      'type T = BigInt64Array;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('DataView', () => {
    const result = validate(
      new DataView(new ArrayBuffer(8)),
      'T',
      'type T = DataView;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('simple Error', () => {
    const result = validate(
      new Error('something'),
      'T',
      'type T = Error;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('TypeError', () => {
    const result = validate(
      new TypeError('bad type'),
      'T',
      'type T = TypeError;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Error with custom properties', () => {
    const err = Object.assign(new Error('fail'), { code: 500 });
    const result = validate(
      err,
      'ApiError',
      'interface ApiError extends Error { code: number; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('Error with cause', () => {
    const err = new Error('wrapper', { cause: new Error('root') });
    const result = validate(err, 'T', 'type T = Error;');
    expect(result).toEqual({ valid: true });
  });

  it('Boolean wrapper', () => {
    const result = validate(new Boolean(true), 'T', 'type T = Boolean;');
    expect(result).toEqual({ valid: true });
  });

  it('Number wrapper', () => {
    const result = validate(new Number(42), 'T', 'type T = Number;');
    expect(result).toEqual({ valid: true });
  });

  it('String wrapper', () => {
    const result = validate(new String('hello'), 'T', 'type T = String;');
    expect(result).toEqual({ valid: true });
  });

  it('Headers', () => {
    const result = validate(
      new Headers([['content-type', 'text/plain']]),
      'T',
      'type T = Headers;',
    );
    expect(result).toEqual({ valid: true });
  });

  it('optional properties (present)', () => {
    const result = validate(
      { title: 'Test', priority: 1 },
      'Todo',
      'interface Todo { title: string; priority?: number; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('optional properties (absent)', () => {
    const result = validate(
      { title: 'Test' },
      'Todo',
      'interface Todo { title: string; priority?: number; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('union types', () => {
    const result = validate('hello', 'T', 'type T = string | number;');
    expect(result).toEqual({ valid: true });
  });

  it('cyclic object', () => {
    const obj: any = { id: 1 };
    obj.self = obj;
    const result = validate(obj, 'T', 'interface T { id: number; self: any; }');
    expect(result).toEqual({ valid: true });
  });

  it('aliased object', () => {
    const shared = { city: 'Portland' };
    const result = validate(
      { shipping: shared, billing: shared },
      'T',
      'interface Addr { city: string; }\ninterface T { shipping: Addr; billing: Addr; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('NaN validates as number', () => {
    const result = validate(NaN, 'T', 'type T = number;');
    expect(result).toEqual({ valid: true });
  });

  it('Infinity validates as number', () => {
    const result = validate(Infinity, 'T', 'type T = number;');
    expect(result).toEqual({ valid: true });
  });

  it('export-prefixed type definitions work (stripped)', () => {
    const result = validate(
      { title: 'Test' },
      'Todo',
      'export interface Todo { title: string; }',
    );
    expect(result).toEqual({ valid: true });
  });

  it('type definitions with imports work (stripped)', () => {
    const result = validate(
      { title: 'Test' },
      'Todo',
      `import { Something } from './other';
interface Todo { title: string; }`,
    );
    expect(result).toEqual({ valid: true });
  });
});

// ============================================================================
// Negative type-checking tests
// ============================================================================

describe('validate — negative (valid: false)', () => {
  it('typeName not in typeDefinitions', () => {
    const result = validate({}, 'Foo', 'interface Bar { x: string; }');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('Foo');
      expect(result.errors[0].source).toBe('value');
    }
  });

  it('wrong primitive type', () => {
    const result = validate(
      { title: 42 },
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("not assignable to type 'string'");
    }
  });

  it('extra properties', () => {
    const result = validate(
      { title: 'x', typo: true },
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.property === 'typo')).toBe(true);
    }
  });

  it('missing required properties', () => {
    const result = validate(
      {},
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.property === 'title')).toBe(true);
    }
  });

  it('wrong nested type', () => {
    const result = validate(
      { items: ['not a number'] },
      'List',
      'interface List { items: number[]; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('wrong Map value type', () => {
    const result = validate(
      new Map([['k', 42]]),
      'T',
      'type T = Map<string, string>;',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('wrong Error custom property type', () => {
    const err = Object.assign(new Error('x'), { code: 'str' });
    const result = validate(
      err,
      'ApiError',
      'interface ApiError extends Error { code: number; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('syntax error in type definitions reports source as type-definitions', () => {
    const result = validate(
      {},
      'Foo',
      'interface Foo { title: string;; }',  // double semicolon is fine in TS, use actual syntax error
    );
    // A double semicolon is valid TS, use a real syntax error
    const result2 = validate(
      {},
      'Foo',
      'interface Foo { title: }',
    );
    expect(result2.valid).toBe(false);
    if (!result2.valid) {
      expect(result2.errors.some(e => e.source === 'type-definitions')).toBe(true);
    }
  });

  it('error has code field (tsc diagnostic code)', () => {
    const result = validate(
      { title: 42 },
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(typeof result.errors[0].code).toBe('number');
      expect(result.errors[0].code).toBeGreaterThan(0);
    }
  });

  it('error has line field', () => {
    const result = validate(
      { title: 42 },
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(typeof result.errors[0].line).toBe('number');
    }
  });
});

// ============================================================================
// Property extraction tests
// ============================================================================

describe('validate — property extraction', () => {
  it('extracts property for missing property error', () => {
    const result = validate(
      {},
      'Todo',
      'interface Todo { title: string; done: boolean; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const props = result.errors.map(e => e.property).filter(Boolean);
      expect(props).toContain('title');
    }
  });

  it('extracts property for excess property error', () => {
    const result = validate(
      { title: 'x', oops: true },
      'Todo',
      'interface Todo { title: string; }',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const props = result.errors.map(e => e.property).filter(Boolean);
      expect(props).toContain('oops');
    }
  });

  it('property is undefined for generic type mismatch', () => {
    const result = validate(42, 'T', 'type T = string;');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // "Type 'number' is not assignable to type 'string'" — no property named
      expect(result.errors[0].property).toBeUndefined();
    }
  });
});

// ============================================================================
// Performance test
// ============================================================================

describe('validate — performance', () => {
  it('warm validation latency <5ms per call', () => {
    const typeDefs = 'interface Todo { title: string; done: boolean; priority?: number; }';
    const value = { title: 'Fix bug', done: false };

    // Warm up
    validate(value, 'Todo', typeDefs);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      validate(value, 'Todo', typeDefs);
    }
    const elapsed = (performance.now() - start) / 100;
    expect(elapsed).toBeLessThan(5); // ms per call
  });
});

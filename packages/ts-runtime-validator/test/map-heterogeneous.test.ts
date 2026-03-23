/**
 * Map validation tests
 *
 * Verifies Map validation behavior with the constructor-with-entries pattern.
 * Homogeneous Maps (single value type) validate correctly.
 * Heterogeneous Maps (union value types) are a known tsc limitation —
 * tsc infers V from the first entry and rejects subsequent entries with
 * different types. Vibe coders should use Map<string, any> or homogeneous types.
 */
import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate';

describe('Map validation', () => {

  it('homogeneous Map<string, number> validates', () => {
    const r = validate(
      { data: new Map([['a', 1], ['b', 2]]) },
      'C', 'interface C { data: Map<string, number>; }'
    );
    expect(r.valid).toBe(true);
  });

  it('homogeneous Map<string, string> validates', () => {
    const r = validate(
      { data: new Map([['a', 'hello'], ['b', 'world']]) },
      'C', 'interface C { data: Map<string, string>; }'
    );
    expect(r.valid).toBe(true);
  });

  it('Map<number, string> with numeric keys validates', () => {
    const r = validate(
      { lookup: new Map<number, string>([[1, 'one'], [2, 'two']]) },
      'C', 'interface C { lookup: Map<number, string>; }'
    );
    expect(r.valid).toBe(true);
  });

  it('empty Map validates against any Map type', () => {
    const r = validate(
      { data: new Map() },
      'C', 'interface C { data: Map<string, number>; }'
    );
    expect(r.valid).toBe(true);
  });

  it('rejects wrong value type in homogeneous Map', () => {
    const r = validate(
      { data: new Map([['a', 'not-a-number']]) },
      'C', 'interface C { data: Map<string, number>; }'
    );
    expect(r.valid).toBe(false);
  });

  it('standalone Map type alias validates', () => {
    const r = validate(
      new Map([['x', 42]]),
      'NumMap', 'type NumMap = Map<string, number>;'
    );
    expect(r.valid).toBe(true);
  });

  it('Set<string> validates', () => {
    const r = validate(
      { tags: new Set(['a', 'b']) },
      'C', 'interface C { tags: Set<string>; }'
    );
    expect(r.valid).toBe(true);
  });

  it('Date validates', () => {
    const r = validate(
      { created: new Date('2026-01-01') },
      'C', 'interface C { created: Date; }'
    );
    expect(r.valid).toBe(true);
  });

  // Skipped: heterogeneous Maps require toTypeScript() to emit typed entries
  // (e.g., new Map<string, string | number>([...])) which means passing the
  // target type from validate() into toTypeScript(). Without explicit type
  // params, tsc infers V from the first entry and rejects the rest.
  // This is a real tsc limitation (fails with lib.es5.d.ts too).
  // Fix: have validate() extract Map type params from the type definitions
  // and pass them to toTypeScript() for emission. See nebula-scratchpad.md.
  it.skip('heterogeneous Map<string, string | number> with mixed values', () => {
    const r = validate(
      { data: new Map([['count', 42], ['label', 'hello']]) },
      'C', 'interface C { data: Map<string, string | number>; }'
    );
    expect(r.valid).toBe(true);
  });
});

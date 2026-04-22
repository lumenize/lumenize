import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';
import { generateParseModule } from '../src/generate-parse-module';

/**
 * Edge-case tests: mainly exercising error branches to get coverage over 90% / 80%.
 */

describe('extractTypeMetadata edge cases', () => {
  it('throws a SyntaxError on unparseable type definitions', () => {
    expect(() => extractTypeMetadata('interface Broken { x')).toThrow(SyntaxError);
  });

  it('returns an empty result for empty input', () => {
    const md = extractTypeMetadata('');
    expect(md.interfaceNames).toEqual([]);
    expect(md.relationships).toEqual({});
    expect(md.defaults).toEqual({});
    expect(md.writeShapeTypeDefinitions).toBe('');
  });

  it('skips `type` aliases (non-interface declarations)', () => {
    const md = extractTypeMetadata(`
type User = { name: string; };
interface Real { x: number; }
`);
    expect(md.interfaceNames).toEqual(['Real']);
  });

  it('ignores signature members that are not property signatures (e.g., methods)', () => {
    const md = extractTypeMetadata(`
interface Svc {
  name: string;
  doIt(): void;
}
`);
    // method is silently skipped; `name` is present.
    expect(md.interfaceNames).toEqual(['Svc']);
    expect(md.defaults).toEqual({});
  });

  it('treats Array<NonOntologyType> as non-relationship', () => {
    const md = extractTypeMetadata(`
interface A { tags: Array<string>; }
`);
    expect(md.relationships).toEqual({});
    expect(md.writeShapeTypeDefinitions).toContain('Array<string>');
  });

  it('treats non-nullish union types as non-relationship', () => {
    const md = extractTypeMetadata(`
interface A { x: string | number | boolean; }
`);
    expect(md.relationships).toEqual({});
  });

  it('treats a T | U union (both ontology types) as non-relationship', () => {
    const md = extractTypeMetadata(`
interface Cat { meow: string; }
interface Dog { bark: string; }
interface Owner { pet: Cat | Dog; }
`);
    // Union of two ontology types is not a simple relationship — the
    // extractor requires exactly one non-null variant.
    expect(md.relationships).toEqual({});
  });

  it('handles a JSDoc @default with surrounding whitespace', () => {
    const md = extractTypeMetadata(`
interface X {
  /** @default   42   */
  n?: number;
}
`);
    expect(md.defaults.X.n).toBe(42);
  });

  it('last @default wins when a field has multiple', () => {
    const md = extractTypeMetadata(`
interface X {
  /**
   * @default 1
   * @default 2
   */
  n?: number;
}
`);
    expect(md.defaults.X.n).toBe(2);
  });
});

describe('generateParseModule edge cases', () => {
  it('throws when the input has no interfaces', () => {
    expect(() => generateParseModule('type X = number;')).toThrow(/no interfaces/);
  });

  it('produces a self-contained module (no typia/ imports, no default imports from "typia")', () => {
    const emitted = generateParseModule(`
interface Thing { name: string; }
`);
    // Guard inside the compile function already throws if surviving typia imports
    // are detected. Verify here from the outside too.
    expect(emitted).not.toMatch(/import[^;]*from\s+["']typia(?:\/|["'])/);
    expect(emitted).toContain('class ParserValidator extends DurableObject');
    expect(emitted).toContain('__typeMetadata');
  });

  it('bakes relationships and defaults into the emitted module', () => {
    const emitted = generateParseModule(`
interface Parent { id: string; }
interface Child {
  id: string;
  parent: Parent;
  /** @default "active" */
  status?: string;
}
`);
    expect(emitted).toContain('"Child"');
    expect(emitted).toContain('"status":"active"');
    expect(emitted).toContain('"target":"Parent"');
  });

  it('handles an interface with only non-property members (type-only / pure signatures)', () => {
    const emitted = generateParseModule(`
interface Marker {}
interface Real { id: string; }
`);
    // After typia transforms, the createValidate<T>() call is replaced by
    // an inline IIFE. Verify the validator key exists in the generated
    // validators object.
    expect(emitted).toMatch(/Marker:\s*\(\(\)\s*=>/);
    expect(emitted).toMatch(/Real:\s*\(\(\)\s*=>/);
  });
});

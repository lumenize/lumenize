/**
 * Pedagogical examples for the api-reference.mdx documentation page.
 * Covers all public API functions with realistic usage.
 */

import { describe, it, expect } from 'vitest';
import {
  validate,
  toTypeScript,
  extractTypeMetadata,
} from '@lumenize/ts-runtime-validator';
import type { ValidationResult } from '@lumenize/ts-runtime-validator';
import todoTypes from './todo.ts?raw';

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe('validate()', () => {
  it('returns { valid: true } for conforming values', () => {
    const result: ValidationResult = validate(
      { title: 'Ship it', done: false },
      'Todo',
      todoTypes,
    );
    expect(result).toEqual({ valid: true });
  });

  it('reports wrong types', () => {
    const result = validate({ title: 42, done: false }, 'Todo', todoTypes);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message)
      .toBe("Type 'number' is not assignable to type 'string'. → title: 42");
  });

  it('reports missing properties', () => {
    const result = validate({ title: 'Ship it' }, 'Todo', todoTypes);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message)
      .toBe("Property 'done' is missing in type '{ title: string; }' but required in type 'Todo'. → const __validate: Todo = {");
  });

  it('reports excess properties', () => {
    const result = validate({ title: 'Ship it', done: false, extra: true }, 'Todo', todoTypes);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message)
      .toBe("Object literal may only specify known properties, and 'extra' does not exist in type 'Todo'. → extra: true");
  });

  it('reports bad type definitions via source field', () => {
    const badTypes = `interfce Todo { title: string; }`;
    const result = validate({ title: 'hi' }, 'Todo', badTypes);

    expect(result.valid).toBe(false);
    expect(result.errors[0].source).toBe('type-definitions');
  });

  it('throws TypeError for empty type definitions', () => {
    expect(() => validate({}, 'Foo', '')).toThrow(TypeError);
    expect(() => validate({}, 'Foo', '   ')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// toTypeScript()
// ---------------------------------------------------------------------------

describe('toTypeScript()', () => {
  it('serializes primitives', () => {
    expect(toTypeScript('hello', 'T')).toBe('const __validate: T = "hello";');
    expect(toTypeScript(42, 'T')).toBe('const __validate: T = 42;');
    expect(toTypeScript(true, 'T')).toBe('const __validate: T = true;');
    expect(toTypeScript(null, 'T')).toBe('const __validate: T = null;');
  });

  it('serializes objects with typed properties', () => {
    const program = toTypeScript({ title: 'Ship it', done: false }, 'Todo');
    expect(program).toBe(
      'const __validate: Todo = {\n  title: "Ship it",\n  done: false,\n};'
    );
  });

  it('serializes Maps as constructor calls', () => {
    const program = toTypeScript(
      new Map([['key', 'value']]),
      'Map<string, string>',
    );
    expect(program).toContain('new Map(');
  });

  it('serializes Dates as constructor calls', () => {
    const program = toTypeScript(new Date('2025-01-01'), 'Date');
    expect(program).toContain('new Date(');
  });

  it('throws TypeError for functions', () => {
    expect(() => toTypeScript({ fn: () => {} }, 'T')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// extractTypeMetadata()
// ---------------------------------------------------------------------------

describe('extractTypeMetadata()', () => {
  it('discovers relationships between interfaces', () => {
    const types = `
interface Author {
  name: string;
  books: Book[];
}
interface Book {
  title: string;
  author: Author;
  tags?: string[];
}
`;
    const meta = extractTypeMetadata(types);

    // Author has a "many" relationship to Book
    expect(meta.relationships['Author']['books']).toEqual({
      target: 'Book',
      cardinality: 'many',
      optional: false,
    });

    // Book has a "one" relationship to Author
    expect(meta.relationships['Book']['author']).toEqual({
      target: 'Author',
      cardinality: 'one',
      optional: false,
    });
  });

  it('generates write-shape type definitions', () => {
    const types = `
interface Author { name: string; books: Book[]; }
interface Book { title: string; author: Author; }
`;
    const meta = extractTypeMetadata(types);

    // Write shapes replace relationship refs with string IDs
    expect(meta.writeShapeTypeDefinitions).toContain('books: string[]');
    expect(meta.writeShapeTypeDefinitions).toContain('author: string');
  });

  it('detects optional relationships', () => {
    const types = `
interface Task {
  title: string;
  assignee?: User;
  watchers: User[] | null;
}
interface User { name: string; }
`;
    const meta = extractTypeMetadata(types);

    expect(meta.relationships['Task']['assignee'].optional).toBe(true);
    expect(meta.relationships['Task']['watchers'].optional).toBe(true);
  });
});


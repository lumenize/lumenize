/**
 * extractTypeMetadata() tests — relationship extraction and write-shape generation.
 */

import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

// ============================================================================
// Relationship extraction
// ============================================================================

describe('extractTypeMetadata — relationships', () => {

  it('extracts "one" relationship for direct type reference', () => {
    const types = `
      interface Todo { owner: Person; title: string; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo.owner).toEqual({
      target: 'Person',
      cardinality: 'one',
      optional: false,
    });
  });

  it('extracts "many" relationship for array type', () => {
    const types = `
      interface Todo { assignedTo: Person[]; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo.assignedTo).toEqual({
      target: 'Person',
      cardinality: 'many',
      optional: false,
    });
  });

  it('extracts "many" relationship for Array<T> generic syntax', () => {
    const types = `
      interface Todo { assignedTo: Array<Person>; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo.assignedTo).toEqual({
      target: 'Person',
      cardinality: 'many',
      optional: false,
    });
  });

  it('extracts optional "one" relationship with question mark', () => {
    const types = `
      interface Todo { reviewer?: Person; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo.reviewer).toEqual({
      target: 'Person',
      cardinality: 'one',
      optional: true,
    });
  });

  it('extracts optional "one" relationship with T | null union', () => {
    const types = `
      interface Todo { reviewer: Person | null; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo.reviewer).toEqual({
      target: 'Person',
      cardinality: 'one',
      optional: true,
    });
  });

  it('does not extract relationship for primitive types', () => {
    const types = `
      interface Todo { title: string; done: boolean; count: number; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo).toBeUndefined();
  });

  it('does not extract relationship for unknown type references', () => {
    const types = `
      interface Todo { data: SomeExternalType; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships.Todo).toBeUndefined();
  });

  it('extracts cross-references between multiple interfaces', () => {
    const types = `
      interface Project { lead: Person; todos: Todo[]; }
      interface Todo { title: string; assignedTo: Person; }
      interface Person { name: string; }
    `;
    const meta = extractTypeMetadata(types);

    expect(meta.relationships.Project.lead).toEqual({
      target: 'Person', cardinality: 'one', optional: false,
    });
    expect(meta.relationships.Project.todos).toEqual({
      target: 'Todo', cardinality: 'many', optional: false,
    });
    expect(meta.relationships.Todo.assignedTo).toEqual({
      target: 'Person', cardinality: 'one', optional: false,
    });
    expect(meta.relationships.Person).toBeUndefined();
  });

  it('handles interface with no relationships', () => {
    const types = `
      interface Config { debug: boolean; version: string; }
    `;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships).toEqual({});
  });
});

// ============================================================================
// Write-shape type definition generation
// ============================================================================

describe('extractTypeMetadata — write-shape generation', () => {

  it('replaces "one" relationship with string', () => {
    const types = `interface Todo { owner: Person; title: string; }
interface Person { name: string; }`;
    const meta = extractTypeMetadata(types);
    expect(meta.writeShapeTypeDefinitions).toContain('owner: string');
    expect(meta.writeShapeTypeDefinitions).not.toContain('owner: Person');
  });

  it('replaces "many" relationship with string[]', () => {
    const types = `interface Todo { assignedTo: Person[]; }
interface Person { name: string; }`;
    const meta = extractTypeMetadata(types);
    expect(meta.writeShapeTypeDefinitions).toContain('assignedTo: string[]');
    expect(meta.writeShapeTypeDefinitions).not.toContain('assignedTo: Person[]');
  });

  it('replaces Array<T> relationship with string[]', () => {
    const types = `interface Todo { assignedTo: Array<Person>; }
interface Person { name: string; }`;
    const meta = extractTypeMetadata(types);
    expect(meta.writeShapeTypeDefinitions).toContain('assignedTo: string[]');
  });

  it('preserves non-relationship fields unchanged', () => {
    const types = `interface Todo { title: string; done: boolean; owner: Person; }
interface Person { name: string; }`;
    const meta = extractTypeMetadata(types);
    expect(meta.writeShapeTypeDefinitions).toContain('title: string');
    expect(meta.writeShapeTypeDefinitions).toContain('done: boolean');
  });

  it('preserves all interfaces in write-shape output', () => {
    const types = `interface Todo { assignedTo: Person[]; }
interface Person { name: string; email: string; }`;
    const meta = extractTypeMetadata(types);
    // Person interface should still be present (it's a standalone resource type)
    expect(meta.writeShapeTypeDefinitions).toContain('interface Person');
    expect(meta.writeShapeTypeDefinitions).toContain('name: string');
    expect(meta.writeShapeTypeDefinitions).toContain('email: string');
  });

  it('returns type definitions unchanged when no relationships exist', () => {
    const types = `interface Config { debug: boolean; version: string; }`;
    const meta = extractTypeMetadata(types);
    expect(meta.writeShapeTypeDefinitions).toBe(types);
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('extractTypeMetadata — error handling', () => {

  it('throws SyntaxError on unparseable type definitions', () => {
    expect(() => extractTypeMetadata('interface Bad {')).toThrow(SyntaxError);
  });

  it('handles empty interface gracefully', () => {
    const types = `interface Empty {}`;
    const meta = extractTypeMetadata(types);
    expect(meta.relationships).toEqual({});
    expect(meta.writeShapeTypeDefinitions).toBe(types);
  });

  it('handles optional T | null with array', () => {
    const types = `interface Todo { tags: Person[] | null; }
interface Person { name: string; }`;
    const meta = extractTypeMetadata(types);
    // T[] | null — the array in a union: analyzeTypeNode handles the union,
    // finds Person[] as the non-null type, and extracts it
    expect(meta.relationships.Todo.tags).toEqual({
      target: 'Person',
      cardinality: 'many',
      optional: true,
    });
  });
});

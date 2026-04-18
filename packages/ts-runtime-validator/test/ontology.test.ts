/**
 * Ontology unit tests
 *
 * Tests the Ontology class: versioned config, validation delegation,
 * write-shape generation, defaults, relationship metadata, error handling.
 * Pure tests — no DO bindings needed.
 */

import { describe, it, expect } from 'vitest';
import { Ontology } from '../../../apps/nebula/src/ontology';
import type { OntologyVersionConfig } from '../../../apps/nebula/src/ontology';

// ============================================================================
// Construction
// ============================================================================

describe('Ontology — construction', () => {

  it('constructs from a single version', () => {
    const ontology = new Ontology([{
      version: 'v1',
      types: 'interface Todo { title: string; done: boolean; }',
    }]);
    expect(ontology.latestVersion).toBe('v1');
  });

  it('constructs from multiple versions, latestVersion is the last', () => {
    const ontology = new Ontology([
      { version: 'v1', types: 'interface Todo { title: string; }' },
      { version: 'v2', types: 'interface Todo { title: string; done: boolean; }' },
    ]);
    expect(ontology.latestVersion).toBe('v2');
  });

  it('throws on empty versions array', () => {
    expect(() => new Ontology([])).toThrow('Ontology requires at least one version');
  });

  it('throws on unparseable type definitions', () => {
    expect(() => new Ontology([{
      version: 'v1',
      types: 'interface Bad {',
    }])).toThrow(SyntaxError);
  });
});

// ============================================================================
// Validation delegation
// ============================================================================

describe('Ontology — validate()', () => {

  const ontology = new Ontology([{
    version: 'v1',
    types: 'interface Todo { title: string; done: boolean; }',
  }]);

  it('returns valid for conforming value', () => {
    const result = ontology.validate({ title: 'Fix bug', done: false }, 'Todo');
    expect(result.valid).toBe(true);
  });

  it('returns invalid for non-conforming value', () => {
    const result = ontology.validate({ title: 123, done: false }, 'Todo');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('returns invalid for missing required field', () => {
    const result = ontology.validate({ title: 'Fix bug' }, 'Todo');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.message.includes('done'))).toBe(true);
    }
  });

  it('returns invalid for excess property', () => {
    const result = ontology.validate({ title: 'Fix', done: false, extra: 'nope' }, 'Todo');
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Write-shape validation (relationship refs → string IDs)
// ============================================================================

describe('Ontology — write-shape validation', () => {

  const ontology = new Ontology([{
    version: 'v1',
    types: `
      interface Todo { title: string; assignedTo: Person[]; owner: Person; }
      interface Person { name: string; email: string; }
    `,
  }]);

  it('validates write-shape with string IDs for relationships', () => {
    const result = ontology.validate(
      { title: 'Fix bug', assignedTo: ['uuid-1', 'uuid-2'], owner: 'uuid-3' },
      'Todo',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects read-shape with object values for relationships', () => {
    const result = ontology.validate(
      { title: 'Fix bug', assignedTo: [{ name: 'Alice', email: 'a@b.com' }], owner: { name: 'Bob', email: 'b@b.com' } },
      'Todo',
    );
    expect(result.valid).toBe(false);
  });

  it('validates Person as a standalone resource type', () => {
    const result = ontology.validate({ name: 'Alice', email: 'alice@example.com' }, 'Person');
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Defaults
// ============================================================================

describe('Ontology — defaults', () => {

  const ontology = new Ontology([{
    version: 'v1',
    types: `interface Todo { title: string; priority: string; }`,
    defaults: {
      Todo: { priority: 'medium' },
    },
  }]);

  it('returns defaults for a type that has them', () => {
    expect(ontology.getDefaults('Todo')).toEqual({ priority: 'medium' });
  });

  it('returns null for a type with no defaults', () => {
    expect(ontology.getDefaults('Person')).toBeNull();
  });

  it('returns null when version has no defaults at all', () => {
    const o = new Ontology([{ version: 'v1', types: 'interface X { a: string; }' }]);
    expect(o.getDefaults('X')).toBeNull();
  });
});

// ============================================================================
// Relationship metadata
// ============================================================================

describe('Ontology — getRelationship()', () => {

  const ontology = new Ontology([{
    version: 'v1',
    types: `
      interface Todo { title: string; assignedTo: Person[]; owner: Person; reviewer?: Person; }
      interface Person { name: string; }
    `,
  }]);

  it('returns "many" relationship for array ref', () => {
    expect(ontology.getRelationship('Todo', 'assignedTo')).toEqual({
      target: 'Person', cardinality: 'many', optional: false,
    });
  });

  it('returns "one" relationship for direct ref', () => {
    expect(ontology.getRelationship('Todo', 'owner')).toEqual({
      target: 'Person', cardinality: 'one', optional: false,
    });
  });

  it('returns optional "one" relationship for optional ref', () => {
    expect(ontology.getRelationship('Todo', 'reviewer')).toEqual({
      target: 'Person', cardinality: 'one', optional: true,
    });
  });

  it('returns null for non-relationship field', () => {
    expect(ontology.getRelationship('Todo', 'title')).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(ontology.getRelationship('Unknown', 'field')).toBeNull();
  });

  it('returns null for unknown field', () => {
    expect(ontology.getRelationship('Todo', 'nonexistent')).toBeNull();
  });
});

// ============================================================================
// Migrate placeholder
// ============================================================================

describe('Ontology — migrate placeholder', () => {

  it('accepts migrate property without error', () => {
    const ontology = new Ontology([{
      version: 'v1',
      types: 'interface Todo { title: string; }',
      migrate: { Todo: '(data) => ({ ...data })' },
    }]);
    expect(ontology.latestVersion).toBe('v1');
  });
});

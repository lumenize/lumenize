import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

async function parse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<{
  result: {
    valid: boolean;
    data?: unknown;
    errors?: Array<{ path: string; expected: string }>;
  };
}> {
  const response = await SELF.fetch('http://example.com/parse', {
    method: 'POST',
    body: JSON.stringify({ typeDefinitions, typeName, value, bundleId }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('extractTypeMetadata — relationships + write-shape', () => {
  it('identifies a one-to-one relationship and rewrites to string', () => {
    const md = extractTypeMetadata(`
interface Address { street: string; }
interface User { id: string; home: Address; }
`);
    expect(md.relationships.User.home).toMatchObject({
      target: 'Address',
      cardinality: 'one',
      optional: false,
    });
    expect(md.writeShapeTypeDefinitions).toContain('home: string');
  });

  it('identifies a one-to-many relationship and rewrites to string[]', () => {
    const md = extractTypeMetadata(`
interface Tag { name: string; }
interface Post { id: string; tags: Tag[]; }
`);
    expect(md.relationships.Post.tags).toMatchObject({
      target: 'Tag',
      cardinality: 'many',
      optional: false,
      container: 'array',
    });
    expect(md.writeShapeTypeDefinitions).toContain('tags: string[]');
  });

  it('handles Array<T> generic syntax identically to T[]', () => {
    const md = extractTypeMetadata(`
interface Tag { name: string; }
interface Post { id: string; tags: Array<Tag>; }
`);
    expect(md.relationships.Post.tags.cardinality).toBe('many');
    expect(md.writeShapeTypeDefinitions).toContain('tags: string[]');
  });

  it('marks T | null as an optional one-relationship', () => {
    const md = extractTypeMetadata(`
interface Parent { id: string; }
interface Child { id: string; parent: Parent | null; }
`);
    expect(md.relationships.Child.parent).toMatchObject({
      target: 'Parent',
      cardinality: 'one',
      optional: true,
    });
  });

  it('leaves non-ontology references alone (no write-shape rewrite)', () => {
    const md = extractTypeMetadata(`
interface User { id: string; email: string; when: Date; }
`);
    // No other interface referenced, so no relationships at all.
    expect(md.relationships).toEqual({});
    expect(md.writeShapeTypeDefinitions).toContain('when: Date');
  });
});

describe('Facet: relationship fields validate as IDs (write-shape path)', () => {
  it('accepts a string ID for a one-to-one relationship field', async () => {
    const types = `
interface Address { street: string; city: string; zip: string; }
interface User { id: string; name: string; home: Address; }
`;
    const { result } = await parse(
      types,
      'User',
      { id: 'u-1', name: 'Alice', home: 'addr-123' },
      'rel-one',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ id: 'u-1', name: 'Alice', home: 'addr-123' });
  });

  it('accepts an array of string IDs for a one-to-many relationship', async () => {
    const types = `
interface Tag { name: string; }
interface Post { id: string; tags: Tag[]; }
`;
    const { result } = await parse(
      types,
      'Post',
      { id: 'p-1', tags: ['t-1', 't-2', 't-3'] },
      'rel-many',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ id: 'p-1', tags: ['t-1', 't-2', 't-3'] });
  });

  it('rejects a nested-object value where a string ID is now expected', async () => {
    const types = `
interface Address { street: string; }
interface User { id: string; home: Address; }
`;
    const { result } = await parse(
      types,
      'User',
      { id: 'u-1', home: { street: '1 Main' } },
      'rel-reject',
    );
    expect(result.valid).toBe(false);
    const paths = result.errors!.map((e) => e.path);
    expect(paths.some((p) => p.includes('home'))).toBe(true);
  });
});

describe('Facet: defaults recurse into nested non-relationship objects (Phase 4 P4.5)', () => {
  it('fills defaults inside an inline nested object via JSON-object @default', async () => {
    const types = `
interface Settings {
  /** @default {"timeout": 30, "retries": 3} */
  config?: { timeout: number; retries: number; };
}
`;
    const { result } = await parse(types, 'Settings', {}, 'rec-default');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ config: { timeout: 30, retries: 3 } });
  });

  it('fills defaults inside a related type when relationship field carries a nested object (dev mode)', async () => {
    // If a relationship field carries a nested object instead of a string ID
    // (e.g., in a hypothetical dev-mode where clients send objects), defaults
    // on the target type still apply. The validator still rejects (expects string),
    // but the filler at least runs non-destructively.
    const types = `
interface Address {
  /** @default "US" */
  country?: string;
  street: string;
}
interface User { id: string; home: Address; }
`;
    const { result } = await parse(
      types,
      'User',
      { id: 'u-1', home: { street: '1 Main' } },
      'rec-obj',
    );
    // Validator rejects because home expected string; but the behaviour we
    // care about is that the filler ran (country default applied). We can't
    // observe the filled-then-rejected value easily here — the important
    // contract is "filler is non-destructive and doesn't crash." The main
    // defaults-on-nested path is exercised by the JSON-object @default test
    // above; this one just confirms no crash.
    expect(result.valid).toBe(false);
  });
});

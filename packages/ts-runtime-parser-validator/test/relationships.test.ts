import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

type ParseResult = {
  valid: boolean;
  data?: unknown;
  errors?: Array<{ path: string; expected: string }>;
};

interface PrimaryStub {
  parse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

function parse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<ParseResult> {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.parse(typeDefinitions, typeName, value, bundleId);
}

describe('extractTypeMetadata — type-graph edges + write-shape', () => {
  it('identifies a one-to-one edge and produces a write-shape with string', () => {
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

  it('identifies a one-to-many edge and produces a write-shape with string[]', () => {
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

  it('marks T | null as an optional one-edge', () => {
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

  it('leaves non-named-interface references alone', () => {
    const md = extractTypeMetadata(`
interface User { id: string; email: string; when: Date; }
`);
    expect(md.relationships).toEqual({});
    expect(md.writeShapeTypeDefinitions).toContain('when: Date');
  });
});

describe('Facet: named-interface fields validate as embedded objects (Phase 6.5)', () => {
  it('accepts a nested object for a named-interface field', async () => {
    const types = `
interface Address { street: string; city: string; zip: string; }
interface User { id: string; name: string; home: Address; }
`;
    const result = await parse(
      types,
      'User',
      {
        id: 'u-1',
        name: 'Alice',
        home: { street: '1 Main', city: 'Springfield', zip: '62701' },
      },
      'embedded-one',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({
      id: 'u-1',
      name: 'Alice',
      home: { street: '1 Main', city: 'Springfield', zip: '62701' },
    });
  });

  it('accepts an array of nested objects for a named-interface many field', async () => {
    const types = `
interface Tag { name: string; }
interface Post { id: string; tags: Tag[]; }
`;
    const result = await parse(
      types,
      'Post',
      { id: 'p-1', tags: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      'embedded-many',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({
      id: 'p-1',
      tags: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
  });

  it('rejects a string ID where a nested object is expected (no auto-rewrite)', async () => {
    const types = `
interface Address { street: string; }
interface User { id: string; home: Address; }
`;
    const result = await parse(
      types,
      'User',
      { id: 'u-1', home: 'addr-123' },
      'string-reject',
    );
    expect(result.valid).toBe(false);
    const paths = result.errors!.map((e) => e.path);
    expect(paths.some((p) => p.includes('home'))).toBe(true);
  });
});

describe('Explicit write-shape composition (ORM pattern)', () => {
  it('callers that want string-ID validation pre-rewrite via extractTypeMetadata', async () => {
    const original = `
interface Address { street: string; city: string; zip: string; }
interface User { id: string; name: string; home: Address; }
`;
    const md = extractTypeMetadata(original);
    // Generate the module from the pre-rewritten write-shape. Now `home` is `string`.
    const idOk = await parse(
      md.writeShapeTypeDefinitions,
      'User',
      { id: 'u-1', name: 'Alice', home: 'addr-123' },
      'write-shape-id',
    );
    expect(idOk.valid).toBe(true);
    expect(idOk.data).toEqual({ id: 'u-1', name: 'Alice', home: 'addr-123' });

    // And a nested object is now rejected in the write-shape module.
    const objReject = await parse(
      md.writeShapeTypeDefinitions,
      'User',
      { id: 'u-1', name: 'Alice', home: { street: '1 Main', city: 'SF', zip: '94107' } },
      'write-shape-reject',
    );
    expect(objReject.valid).toBe(false);
  });
});

describe('Facet: defaults recurse through the type graph (Phase 4 P4.5 + 6.5 D6.5.5)', () => {
  it('fills defaults inside an inline nested object via JSON-object @default', async () => {
    const types = `
interface Settings {
  /** @default {"timeout": 30, "retries": 3} */
  config?: { timeout: number; retries: number; };
}
`;
    const result = await parse(types, 'Settings', {}, 'rec-default');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ config: { timeout: 30, retries: 3 } });
  });

  it('fills defaults inside a named-interface sub-type when the field carries a nested object', async () => {
    const types = `
interface Address {
  /** @default "US" */
  country?: string;
  street: string;
}
interface User { id: string; home: Address; }
`;
    const result = await parse(
      types,
      'User',
      { id: 'u-1', home: { street: '1 Main' } },
      'rec-obj',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({
      id: 'u-1',
      home: { street: '1 Main', country: 'US' },
    });
  });
});

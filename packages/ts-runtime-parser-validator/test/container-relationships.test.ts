import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

type ParseResult = {
  valid: boolean;
  data?: unknown;
  errors?: Array<{ path: string; expected: string; value?: unknown }>;
};

interface PrimaryStub {
  rpcParse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

function rpcParse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<ParseResult> {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.rpcParse(typeDefinitions, typeName, value, bundleId);
}

describe('Container-of-ontology-type relationships — extraction', () => {
  it('Set<User> is detected as a many-cardinality relationship and rewritten to Set<string>', () => {
    const md = extractTypeMetadata(`
interface User { id: string; }
interface Team {
  id: string;
  members: Set<User>;
}
`);
    expect(md.relationships.Team.members).toEqual({
      target: 'User',
      cardinality: 'many',
      optional: false,
      container: 'set',
    });
    expect(md.writeShapeTypeDefinitions).toContain('members: Set<string>');
    expect(md.writeShapeTypeDefinitions).not.toContain('Set<User>');
  });

  it('ReadonlySet<User> is detected and rewritten', () => {
    const md = extractTypeMetadata(`
interface User { id: string; }
interface Team {
  id: string;
  members: ReadonlySet<User>;
}
`);
    expect(md.relationships.Team.members.container).toBe('readonlyset');
    expect(md.writeShapeTypeDefinitions).toContain('members: ReadonlySet<string>');
  });

  it('Map<string, User> is detected as many-cardinality (values are the relationship)', () => {
    const md = extractTypeMetadata(`
interface User { id: string; }
interface Team {
  id: string;
  roleMap: Map<string, User>;
}
`);
    expect(md.relationships.Team.roleMap).toEqual({
      target: 'User',
      cardinality: 'many',
      optional: false,
      container: 'map',
      mapKeyType: 'string',
    });
    expect(md.writeShapeTypeDefinitions).toContain('roleMap: Map<string, string>');
  });

  it('ReadonlyMap<K, User> preserves the original K source text', () => {
    const md = extractTypeMetadata(`
interface User { id: string; }
interface Team {
  roleMap: ReadonlyMap<"admin" | "editor" | "viewer", User>;
}
`);
    expect(md.relationships.Team.roleMap.container).toBe('readonlymap');
    expect(md.relationships.Team.roleMap.mapKeyType).toBe('"admin" | "editor" | "viewer"');
    expect(md.writeShapeTypeDefinitions).toContain(
      'roleMap: ReadonlyMap<"admin" | "editor" | "viewer", string>',
    );
  });

  it('Map<K, PrimitiveValue> is NOT a relationship (value is not ontology)', () => {
    const md = extractTypeMetadata(`
interface Team {
  scores: Map<string, number>;
}
`);
    expect(md.relationships).toEqual({});
    expect(md.writeShapeTypeDefinitions).toContain('scores: Map<string, number>');
  });

  it('Set<Primitive> is NOT a relationship', () => {
    const md = extractTypeMetadata(`
interface Team {
  tags: Set<string>;
}
`);
    expect(md.relationships).toEqual({});
  });

  it('Existing T[] / Array<T> detection still works', () => {
    const md = extractTypeMetadata(`
interface User { id: string; }
interface Team {
  a: User[];
  b: Array<User>;
}
`);
    expect(md.relationships.Team.a.container).toBe('array');
    expect(md.relationships.Team.b.container).toBe('array');
    expect(md.writeShapeTypeDefinitions).toContain('a: string[]');
    expect(md.writeShapeTypeDefinitions).toContain('b: string[]');
  });
});

describe('Container-of-ontology-type relationships — facet validation (write-shape IDs)', () => {
  it('accepts a Set of ID strings for a Set<User> relationship', async () => {
    const types = `
interface User { id: string; name: string; }
interface Team {
  id: string;
  members: Set<User>;
}
`;
    const result = await rpcParse(
      types,
      'Team',
      { id: 't-1', members: new Set(['u-1', 'u-2', 'u-3']) },
      'set-ids',
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a Map<string, string> for a Map<string, User> relationship', async () => {
    const types = `
interface User { id: string; name: string; }
interface Team {
  id: string;
  roleMap: Map<string, User>;
}
`;
    const result = await rpcParse(
      types,
      'Team',
      {
        id: 't-1',
        roleMap: new Map([
          ['admin', 'u-1'],
          ['editor', 'u-2'],
        ]),
      },
      'map-ids',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a Set with full User objects (write-shape expects strings)', async () => {
    const types = `
interface User { id: string; name: string; }
interface Team {
  id: string;
  members: Set<User>;
}
`;
    const result = await rpcParse(
      types,
      'Team',
      {
        id: 't-1',
        members: new Set([{ id: 'u-1', name: 'Alice' }]),
      },
      'set-full-reject',
    );
    expect(result.valid).toBe(false);
  });
});

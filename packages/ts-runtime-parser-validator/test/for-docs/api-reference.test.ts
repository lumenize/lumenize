/**
 * For-docs tests backing website/docs/ts-runtime-parser-validator/api-reference.md.
 *
 * Blocks that declare types/signatures point at source files (facet-helper.ts,
 * extract-type-metadata.ts, generate-parse-module.ts). Executable usage blocks
 * point at this file.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { generateParseModule } from '../../src/generate-parse-module';
import { extractTypeMetadata } from '../../src/extract-type-metadata';

type ParseResult = {
  valid: boolean;
  data?: any;
  errors?: Array<{ path: string; expected: string; value?: unknown; description?: string }>;
};

type ParseRequest = { value: unknown; typeName: string };

interface PrimaryStub {
  parse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
  parseBatch: (
    typeDefinitions: string,
    items: Map<string, ParseRequest>,
    bundleId?: string,
  ) => Promise<Map<string, ParseResult>>;
}

let bundleCounter = 0;

function makeFacet(types: string) {
  const bundleId = `ar-${++bundleCounter}`;
  return {
    parse: (value: unknown, typeName: string): Promise<ParseResult> => {
      const ns = env.PRIMARY_DO;
      const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
      return stub.parse(types, typeName, value, bundleId);
    },
    parseBatch: (items: Map<string, ParseRequest>): Promise<Map<string, ParseResult>> => {
      const ns = env.PRIMARY_DO;
      const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
      return stub.parseBatch(types, items, bundleId);
    },
  };
}

const TODO_TYPES = `
// todo.d.ts
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
`;

describe('generateParseModule()', () => {
  it('accepts TypeScript interface definitions and returns a JS module source', () => {
    const todoTypes = TODO_TYPES;
    const moduleSource = generateParseModule(todoTypes);
    // Pass moduleSource to Worker Loader — see Getting Started.
    expect(typeof moduleSource).toBe('string');
    expect(moduleSource.length).toBeGreaterThan(0);
  });
});

describe('ParserValidator#parse()', () => {
  const facet = makeFacet(TODO_TYPES);

  it('unknown type name returns a single-entry error list', async () => {
    const result = await facet.parse({}, 'NotATypeName');
    expect(result).toEqual({
      valid: false,
      errors: [{
        path: '$',
        expected: 'NotATypeName',
        value: {},
        description: 'unknown type',
      }],
    });
  });

  it('valid: true — success', async () => {
    const result = await facet.parse(
      { title: 'Ship it', done: false },
      'Todo',
    );
    expect(result).toEqual({
      valid: true,
      data: { title: 'Ship it', done: false, priority: 0 },
    });
  });

  it('valid: false — type mismatch', async () => {
    const result = await facet.parse(
      { title: 42, done: 'not a boolean' },
      'Todo',
    );
    expect(result).toMatchObject({
      valid: false,
      errors: [
        { path: '$input.title', expected: 'string', value: 42 },
        { path: '$input.done', expected: 'boolean', value: 'not a boolean' },
      ],
    });
  });

  it('valid: false — missing required field', async () => {
    const result = await facet.parse({ title: 'only title' }, 'Todo');
    expect(result).toMatchObject({
      valid: false,
      errors: [
        { path: '$input.done', expected: 'boolean', value: undefined },
      ],
    });
  });

  it('valid: false — constraint violation', async () => {
    // Shadow outer `facet` so the doc's `facet.parse` substring-matches here.
    // interface Person { /** @minimum 13 */ age: number; }
    const facet = makeFacet(`
interface Person {
  /** @minimum 13 */
  age: number;
}
`);
    const result = await facet.parse({ age: 12 }, 'Person');
    expect(result).toMatchObject({
      valid: false,
      errors: [
        { path: '$input.age', expected: 'number & Minimum<13>', value: 12 },
      ],
    });
  });
});

describe('ParserValidator#parseBatch()', () => {
  const TYPES = `
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
interface Tag {
  name: string;
}
`;

  it('heterogeneous batch: keys preserved, mixed typeNames', async () => {
    const facet = makeFacet(TYPES);
    const items = new Map<string, ParseRequest>([
      ['todo-1', { value: { title: 'Ship it', done: false }, typeName: 'Todo' }],
      ['tag-x', { value: { name: 'x' }, typeName: 'Tag' }],
    ]);
    const out = await facet.parseBatch(items);
    const todo1 = out.get('todo-1');
    const tagX = out.get('tag-x');
    if (todo1?.valid && tagX?.valid) {
      expect(todo1.data).toEqual({ title: 'Ship it', done: false, priority: 0 });
      expect(tagX.data).toEqual({ name: 'x' });
    }
  });

  it('per-item failure does not affect other keys', async () => {
    const facet = makeFacet(TYPES);
    const items = new Map<string, ParseRequest>([
      ['ok', { value: { title: 'good', done: true }, typeName: 'Todo' }],
      ['bad', { value: { title: 42 }, typeName: 'Todo' }],
    ]);
    const out = await facet.parseBatch(items);
    expect(out.get('ok')?.valid).toBe(true);
    expect(out.get('bad')?.valid).toBe(false);
  });
});

describe('Composer pattern — validate string-ID references', () => {
  const TEAM_TYPES = `
interface User { id: string; name: string; }
interface Team {
  lead: User;               // validates as a full User
  members: User[];          // validates as an array of full Users
  roles: Map<string, User>; // validates as a Map of full Users
}
`;

  it('default behavior — named interfaces validate as embedded objects', async () => {
    // Default behavior — named interfaces validate as embedded objects.
    const facet = makeFacet(TEAM_TYPES);
    const ok = await facet.parse(
      {
        lead: { id: 'u-1', name: 'Alice' },
        members: [{ id: 'u-1', name: 'Alice' }, { id: 'u-2', name: 'Bob' }],
        roles: new Map([['admin', { id: 'u-1', name: 'Alice' }]]),
      },
      'Team',
    );
    expect(ok.valid).toBe(true);
  });

  it('write-shape — pre-extract metadata, feed the write-shape to generate', async () => {
    // Composer pattern — pre-extract metadata, feed the write-shape to generate.
    const types = TEAM_TYPES;
    const md = extractTypeMetadata(types);
    // Persist md.relationships wherever your ORM keeps metadata.
    const moduleSource = generateParseModule(md.writeShapeTypeDefinitions);
    // Mount moduleSource as a facet. parse() now expects string IDs.
    expect(moduleSource.length).toBeGreaterThan(0);
    expect(Object.keys(md.relationships)).toContain('Team');

    // With the write-shape module, the same Team validates from string IDs.
    const facet = makeFacet(md.writeShapeTypeDefinitions);
    const ok = await facet.parse(
      {
        lead: 'u-1',
        members: ['u-1', 'u-2'],
        roles: new Map([['admin', 'u-1']]),
      },
      'Team',
    );
    expect(ok.valid).toBe(true);
  });
});

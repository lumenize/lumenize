/**
 * For-docs tests backing website/docs/ts-runtime-parser-validator/default.md.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { generateParseModule } from '../../src/generate-parse-module';

type ParseResult = {
  valid: boolean;
  data?: any;
  errors?: Array<{ path: string; expected: string; value?: unknown }>;
};

interface PrimaryStub {
  parse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

let bundleCounter = 0;

function makeFacet(types: string) {
  const bundleId = `df-${++bundleCounter}`;
  return {
    parse: (value: unknown, typeName: string): Promise<ParseResult> => {
      const ns = env.PRIMARY_DO;
      const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
      return stub.parse(types, typeName, value, bundleId);
    },
  };
}

describe('Fill semantics', () => {
  const facet = makeFacet(`
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
`);

  it('fills missing optional field before validation', async () => {
    const result = await facet.parse({ title: 'Ship it' }, 'Todo');
    expect(result).toEqual({
      valid: true,
      data: { title: 'Ship it', priority: 0 },  // priority filled from @default
    });
  });

  it('missing | undefined | supplied behavior', async () => {
    // Missing → default applied
    const missing = await facet.parse({ title: 'x' }, 'Todo');
    expect(missing.data).toMatchObject({ priority: 0 });

    // Explicit undefined → default applied
    const undef = await facet.parse({ title: 'x', priority: undefined }, 'Todo');
    expect(undef.data).toMatchObject({ priority: 0 });

    // Caller-supplied value wins (even 0, '', false)
    const supplied = await facet.parse({ title: 'x', priority: 99 }, 'Todo');
    expect(supplied.data).toMatchObject({ priority: 99 });
  });

  it('explicit null preserved (default NOT applied)', async () => {
    // Shadows the describe-scope `facet` so the doc example's `facet.parse(...)`
    // substring-matches verbatim here.
    const facet = makeFacet(`
interface Note {
  /** @default 0 */
  count?: number | null;
}
`);
    const nullResult = await facet.parse({ count: null }, 'Note');
    expect(nullResult.data).toMatchObject({ count: null });  // default NOT applied
  });
});

describe('Required vs optional', () => {
  it('@default on required field throws at generateParseModule', () => {
    // This throws from generateParseModule():
    const types = `
interface X {
  /** @default 0 */
  x: number;  // required — no ?
}
`;
    // Error: @default on required field 'X.x' — declare the field optional
    //        (x?: ...) or remove the @default tag.
    expect(() => generateParseModule(types)).toThrow();
  });
});

describe('Nested recursion', () => {
  it('nested object: default fires inside the nested shape', async () => {
    const facet = makeFacet(`
interface Address {
  street: string;
  /** @default "US" */
  country?: string;
}

interface User {
  name: string;
  address?: Address;
}
`);
    // Nested object: default fires inside the nested shape
    const nested = await facet.parse({ name: 'Alice', address: { street: '1 Main' } }, 'User');
    expect(nested.data).toMatchObject({
      name: 'Alice',
      address: { street: '1 Main', country: 'US' },
    });
  });

  it('missing array default fires', async () => {
    const facet = makeFacet(`
interface Tagged {
  /** @default [] */
  tags?: string[];
}
`);
    // Missing array → empty array
    const tagged = await facet.parse({}, 'Tagged');
    expect(tagged.data).toMatchObject({ tags: [] });
  });
});

describe('Guidance — split nested defaults into named interfaces', () => {
  it('harder-to-read inline pattern (still works at runtime)', async () => {
    const facet = makeFacet(`
// Harder to read — defaults buried inside an inline object
interface Config {
  server?: {
    retries?: {
      /** @default 3 */
      max?: number;
      /** @default 100 */
      backoffMs?: number;
    };
  };
}
`);
    const ok = await facet.parse({ server: { retries: {} } }, 'Config');
    expect(ok.data).toMatchObject({
      server: { retries: { max: 3, backoffMs: 100 } },
    });
  });

  it('easier-to-read named-interface pattern', async () => {
    const facet = makeFacet(`
// Easier to read — defaults attached to a named interface
interface RetryConfig {
  /** @default 3 */
  max?: number;
  /** @default 100 */
  backoffMs?: number;
}

interface ServerConfig {
  retries?: RetryConfig;
}

interface Config {
  server?: ServerConfig;
}
`);
    const ok = await facet.parse({ server: { retries: {} } }, 'Config');
    expect(ok.data).toMatchObject({
      server: { retries: { max: 3, backoffMs: 100 } },
    });
  });
});

describe('Containers of inline types (Array / Set / Map)', () => {
  it('Array<{...}> — defaults fill for each element', async () => {
    const facet = makeFacet(`
interface Config {
  servers?: Array<{
    host: string;
    /** @default 8080 */
    port?: number;
  }>;
}
`);
    const ok = await facet.parse(
      { servers: [{ host: 'a' }, { host: 'b', port: 9090 }] },
      'Config',
    );
    expect(ok.data).toMatchObject({
      servers: [
        { host: 'a', port: 8080 },
        { host: 'b', port: 9090 },
      ],
    });
  });

  it('T[] — shorthand array syntax also recurses', async () => {
    const facet = makeFacet(`
interface Config {
  items?: {
    id: string;
    /** @default 0 */
    weight?: number;
  }[];
}
`);
    const ok = await facet.parse({ items: [{ id: 'x' }, { id: 'y' }] }, 'Config');
    expect(ok.data).toMatchObject({
      items: [{ id: 'x', weight: 0 }, { id: 'y', weight: 0 }],
    });
  });

  it('Set<{...}> — defaults fill for each element', async () => {
    const facet = makeFacet(`
interface Config {
  peers?: Set<{
    name: string;
    /** @default 0 */
    priority?: number;
  }>;
}
`);
    const peers = new Set<{ name: string; priority?: number }>([
      { name: 'a' },
      { name: 'b', priority: 5 },
    ]);
    const ok = await facet.parse({ peers }, 'Config');
    const out = (ok.data as { peers: Set<{ name: string; priority?: number }> }).peers;
    expect(out).toBeInstanceOf(Set);
    const arr = [...out].sort((a, b) => a.name.localeCompare(b.name));
    expect(arr).toEqual([
      { name: 'a', priority: 0 },
      { name: 'b', priority: 5 },
    ]);
  });

  it('Map<K, {...}> — defaults fill for each value', async () => {
    const facet = makeFacet(`
interface Config {
  routes?: Map<string, {
    target: string;
    /** @default 200 */
    status?: number;
  }>;
}
`);
    const routes = new Map<string, { target: string; status?: number }>([
      ['home', { target: '/index' }],
      ['api', { target: '/api', status: 301 }],
    ]);
    const ok = await facet.parse({ routes }, 'Config');
    const out = (ok.data as { routes: Map<string, { target: string; status?: number }> }).routes;
    expect(out).toBeInstanceOf(Map);
    expect(out.get('home')).toEqual({ target: '/index', status: 200 });
    expect(out.get('api')).toEqual({ target: '/api', status: 301 });
  });

  it('Array<Array<{...}>> — nested containers recurse to innermost element', async () => {
    const facet = makeFacet(`
interface Grid {
  cells?: Array<Array<{
    value: string;
    /** @default 1 */
    weight?: number;
  }>>;
}
`);
    const ok = await facet.parse(
      {
        cells: [
          [{ value: 'a' }, { value: 'b', weight: 5 }],
          [{ value: 'c' }],
        ],
      },
      'Grid',
    );
    expect(ok.data).toMatchObject({
      cells: [
        [{ value: 'a', weight: 1 }, { value: 'b', weight: 5 }],
        [{ value: 'c', weight: 1 }],
      ],
    });
  });

  it('Map<K, Array<{...}>> — mixed container chain recurses correctly', async () => {
    const facet = makeFacet(`
interface Config {
  routes?: Map<string, Array<{
    target: string;
    /** @default 200 */
    status?: number;
  }>>;
}
`);
    const routes = new Map<string, Array<{ target: string; status?: number }>>([
      ['home', [{ target: '/index' }, { target: '/home' }]],
      ['api', [{ target: '/api', status: 301 }]],
    ]);
    const ok = await facet.parse({ routes }, 'Config');
    const out = (ok.data as { routes: Map<string, Array<{ target: string; status?: number }>> }).routes;
    expect(out).toBeInstanceOf(Map);
    expect(out.get('home')).toEqual([
      { target: '/index', status: 200 },
      { target: '/home', status: 200 },
    ]);
    expect(out.get('api')).toEqual([{ target: '/api', status: 301 }]);
  });

  it('{...} | null — nullable-union-wrapped inline type recurses', async () => {
    const facet = makeFacet(`
interface Config {
  primary?: {
    host: string;
    /** @default 80 */
    port?: number;
  } | null;
}
`);
    const ok = await facet.parse({ primary: { host: 'a' } }, 'Config');
    expect(ok.data).toMatchObject({ primary: { host: 'a', port: 80 } });

    const nullCase = await facet.parse({ primary: null }, 'Config');
    expect(nullCase.data).toMatchObject({ primary: null }); // null preserved
  });
});

describe('Containers of named interfaces (Array / Set / Map)', () => {
  // Previously the filler handled Array<T> for T=named-interface but skipped
  // Set<T> and Map<K, T>. These tests pin the fixed behaviour.
  it('Set<T> where T is a named interface with @default fills elements', async () => {
    const facet = makeFacet(`
interface Peer {
  name: string;
  /** @default 0 */
  priority?: number;
}
interface Config {
  peers?: Set<Peer>;
}
`);
    const peers = new Set<{ name: string; priority?: number }>([
      { name: 'a' },
      { name: 'b', priority: 5 },
    ]);
    const ok = await facet.parse({ peers }, 'Config');
    const out = (ok.data as { peers: Set<{ name: string; priority?: number }> }).peers;
    expect(out).toBeInstanceOf(Set);
    const arr = [...out].sort((a, b) => a.name.localeCompare(b.name));
    expect(arr).toEqual([
      { name: 'a', priority: 0 },
      { name: 'b', priority: 5 },
    ]);
  });

  it('Map<K, T> where T is a named interface with @default fills values', async () => {
    const facet = makeFacet(`
interface Route {
  target: string;
  /** @default 200 */
  status?: number;
}
interface Config {
  routes?: Map<string, Route>;
}
`);
    const routes = new Map<string, { target: string; status?: number }>([
      ['home', { target: '/index' }],
    ]);
    const ok = await facet.parse({ routes }, 'Config');
    const out = (ok.data as { routes: Map<string, { target: string; status?: number }> }).routes;
    expect(out).toBeInstanceOf(Map);
    expect(out.get('home')).toEqual({ target: '/index', status: 200 });
  });
});

describe('Discriminated-union @default recursion', () => {
  // NOTE: JSDoc `@default` must be on its own line above the field (same rule
  // as elsewhere in the package; see additional-constraints.md footgun). Inline
  // JSDoc between members on the same line doesn't attach to the next field.
  const CONFIG_TYPES = `
interface Config {
  payload?:
    | {
        kind: 'retry';
        /** @default 3 */
        max?: number;
      }
    | {
        kind: 'cache';
        /** @default 60 */
        ttlSeconds?: number;
      };
}
`;

  it('routes to the matching variant by the discriminator field', async () => {
    const facet = makeFacet(CONFIG_TYPES);
    const retry = await facet.parse({ payload: { kind: 'retry' } }, 'Config');
    expect(retry.data).toMatchObject({ payload: { kind: 'retry', max: 3 } });

    const cache = await facet.parse({ payload: { kind: 'cache' } }, 'Config');
    expect(cache.data).toMatchObject({ payload: { kind: 'cache', ttlSeconds: 60 } });
  });

  it('caller-supplied values win over defaults within the chosen variant', async () => {
    const facet = makeFacet(CONFIG_TYPES);
    const ok = await facet.parse(
      { payload: { kind: 'retry', max: 7 } },
      'Config',
    );
    expect(ok.data).toMatchObject({ payload: { kind: 'retry', max: 7 } });
  });

  it('numeric discriminators work', async () => {
    const facet = makeFacet(`
interface Result {
  body?:
    | {
        code: 200;
        /** @default "ok" */
        message?: string;
      }
    | {
        code: 500;
        /** @default "internal error" */
        reason?: string;
      };
}
`);
    const ok = await facet.parse({ body: { code: 200 } }, 'Result');
    expect(ok.data).toMatchObject({ body: { code: 200, message: 'ok' } });

    const err = await facet.parse({ body: { code: 500 } }, 'Result');
    expect(err.data).toMatchObject({ body: { code: 500, reason: 'internal error' } });
  });

  it('unknown discriminator value — no recursion, typia flags the mismatch', async () => {
    const facet = makeFacet(CONFIG_TYPES);
    const bad = await facet.parse(
      { payload: { kind: 'unexpected' as any } },
      'Config',
    );
    expect(bad.valid).toBe(false);
  });
});

describe('Mixed inline + named-interface nesting', () => {
  it('inline type containing a named-interface reference — both defaults fire', async () => {
    const facet = makeFacet(`
interface User {
  name: string;
  /** @default 0 */
  age?: number;
}

interface Config {
  admin?: {
    user?: User;
    /** @default "guest" */
    role?: string;
  };
}
`);
    const ok = await facet.parse(
      { admin: { user: { name: 'Alice' } } },
      'Config',
    );
    // Both defaults should apply: User.age (named-interface recursion) and
    // Config.admin.role (inline-subtype recursion).
    expect(ok.data).toMatchObject({
      admin: {
        user: { name: 'Alice', age: 0 },
        role: 'guest',
      },
    });
  });
});

describe('When defaults fail validation', () => {
  it('filler runs before validator; typia flags type-mismatched default', async () => {
    const facet = makeFacet(`
interface Bad {
  /** @default "hello" */
  count?: number;
}
`);
    const result = await facet.parse({}, 'Bad');
    expect(result).toMatchObject({
      valid: false,
      errors: [
        { path: '$input.count', expected: '(number | undefined)', value: 'hello' },
      ],
    });
  });
});

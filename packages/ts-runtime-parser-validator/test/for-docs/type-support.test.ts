/**
 * For-docs tests backing website/docs/ts-runtime-parser-validator/type-support.md
 *
 * Each doc code block is a `@check-example` pointer into this file. The
 * substring matcher in tooling/check-examples normalises both sides (strips
 * imports, comments, type parameters; collapses whitespace), so a doc block
 * just needs to appear as a substring of this file after normalisation.
 *
 * Pattern: one test per doc section. Interfaces live inside the `makeFacet`
 * template literal; assertions follow verbatim so they substring-match the
 * doc's usage blocks.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { generateParseModule } from '../../src/generate-parse-module';

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

// Module-level declarations that mirror doc blocks whose contents can't
// round-trip cleanly inside a template-literal `types` string. The template
// literal types below use backticks and ${} which would have to be escaped
// inside a wrapping template, breaking substring-match against the doc.
// These declarations aren't used at runtime — only the string copies inside
// each `makeFacet(\`...\`)` call drive validation.
interface Handler {
  event: `on${'Click' | 'Hover'}`;
}
// Suppress unused-declaration warnings.
export type _docSubstringAnchors = { handler: Handler };

let bundleCounter = 0;

function makeFacet(types: string) {
  const bundleId = `ts-${++bundleCounter}`;
  return {
    parse: (value: unknown, typeName: string): Promise<ParseResult> => {
      const ns = env.PRIMARY_DO;
      const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
      return stub.rpcParse(types, typeName, value, bundleId);
    },
  };
}

describe('Primitive Types', () => {
  it('validates required primitives + nullable + optional', async () => {
    const facet = makeFacet(`
interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}
`);
    const ok = await facet.parse(
      { name: 'test', count: 42, enabled: true, label: null },
      'Config',
    );
    expect(ok).toEqual({
      valid: true,
      data: { name: 'test', count: 42, enabled: true, label: null },
    });

    // Wrong types for each primitive.
    const bad = await facet.parse(
      { name: 42, count: 'x', enabled: 'yes', label: 0 },
      'Config',
    );
    expect(bad.valid).toBe(false);
  });
});

describe('Object and Array Types', () => {
  it('validates nested object shapes', async () => {
    const facet = makeFacet(`
interface Person {
  name: string;
  address: { street: string; city: string; };
}
`);
    const ok = await facet.parse(
      { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
      'Person',
    );
    expect(ok).toEqual({
      valid: true,
      data: { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
    });
  });

  it('validates arrays element-by-element', async () => {
    const facet = makeFacet(`
interface NumberList {
  items: number[];
}
`);
    const bad = await facet.parse({ items: [1, 'two', 3] }, 'NumberList');
    expect(bad.valid).toBe(false);  // 'two' at index 1
  });
});

describe('Union and Optional Types', () => {
  const facet = makeFacet(`
interface Result {
  value: string | number;
}
interface Item {
  category: 'internal' | 'external';
}
interface User {
  name: string;
  nickname?: string;
}
`);

  it('string-literal unions', async () => {
    expect((await facet.parse({ category: 'internal' }, 'Item')).valid).toBe(true);
    expect((await facet.parse({ category: 'other' },    'Item')).valid).toBe(false);
  });

  it('optional properties', async () => {
    expect((await facet.parse({ name: 'Alice' },                    'User')).valid).toBe(true);
    expect((await facet.parse({ name: 'Alice', nickname: 'Al' },    'User')).valid).toBe(true);
  });
});

describe('Map and Set', () => {
  const facet = makeFacet(`
interface Scores {
  data: Map<string, number>;
}
interface Mixed {
  data: Map<string, string | number>;
}
interface Tags {
  items: Set<string>;
}
`);

  it('homogeneous Maps', async () => {
    const ok = await facet.parse(
      { data: new Map([['alice', 95], ['bob', 87]]) },
      'Scores',
    );
    expect(ok.valid).toBe(true);

    const bad = await facet.parse(
      { data: new Map<string, any>([['alice', 'not-a-number']]) },
      'Scores',
    );
    expect(bad.valid).toBe(false);
  });

  it('heterogeneous Maps (union value types)', async () => {
    const ok = await facet.parse(
      { data: new Map<string, string | number>([['a', 'hi'], ['b', 42]]) },
      'Mixed',
    );
    expect(ok.valid).toBe(true);
  });

  it('Sets of primitives', async () => {
    const ok = await facet.parse({ items: new Set(['a', 'b', 'c']) }, 'Tags');
    expect(ok.valid).toBe(true);

    const bad = await facet.parse({ items: new Set(['a', 42, 'c']) }, 'Tags');
    expect(bad.valid).toBe(false);
  });
});

describe('Built-in Object Types', () => {
  it('Date and RegExp instances', async () => {
    const facet = makeFacet(`
interface Appointment {
  when: Date;
  rule: RegExp;
}
`);
    const ok = await facet.parse(
      { when: new Date(), rule: /abc/ },
      'Appointment',
    );
    expect(ok.valid).toBe(true);

    // A string isn't a Date instance, and a string isn't a RegExp instance.
    const bad = await facet.parse(
      { when: '2026-01-01', rule: 'abc' },
      'Appointment',
    );
    expect(bad.valid).toBe(false);
  });
});

describe('Binary Types', () => {
  it('TypedArray variants validate against declared type', async () => {
    const facet = makeFacet(`
interface Blob {
  data: Uint8Array;
}
`);
    const ok = await facet.parse({ data: new Uint8Array([1, 2, 3]) }, 'Blob');
    expect(ok.valid).toBe(true);

    const bad = await facet.parse({ data: new ArrayBuffer(3) }, 'Blob');
    expect(bad.valid).toBe(false);  // expected Uint8Array, got ArrayBuffer
  });
});

describe('Dynamic Fields with any or unknown', () => {
  it('any accepts anything', async () => {
    const facet = makeFacet(`
interface Flexible {
  metadata: any;       // or: metadata: unknown;
}
`);
    const ok = await facet.parse(
      {
        metadata: {
          tags: new Set(['important']),
          scores: new Map([['test', 100]]),
          created: new Date(),
        },
      },
      'Flexible',
    );
    expect(ok.valid).toBe(true);
  });
});

describe('Utility Types', () => {
  it('Partial, Pick, Record', async () => {
    const facet = makeFacet(`
interface User { name: string; email: string; age: number; }

interface PartialUser { user: Partial<User>; }
interface Credentials { creds: Pick<User, 'name' | 'email'>; }
interface Roles { roles: Record<string, boolean>; }
`);
    expect((await facet.parse({ user: { name: 'Alice' } }, 'PartialUser')).valid).toBe(true);
    expect((await facet.parse({ creds: { name: 'Alice', email: 'a@b.com' } }, 'Credentials')).valid).toBe(true);
    expect((await facet.parse({ roles: { admin: true, user: false } }, 'Roles')).valid).toBe(true);

    // Pick<User, 'name' | 'email'> doesn't include age, so providing it is fine
    // (typia's default is lenient on extras); but supplying the wrong type for a
    // required field still fails.
    expect((await facet.parse({ creds: { name: 42, email: 'a@b.com' } }, 'Credentials')).valid).toBe(false);
  });
});

describe('Advanced Types', () => {
  it('conditional types', async () => {
    const facet = makeFacet(`
interface Cat { meow: string; }
interface Dog { bark: string; }
type Pet<T> = T extends 'cat' ? Cat : Dog;

interface Home {
  pet: Pet<'cat'>;  // resolves to Cat
}
`);
    expect((await facet.parse({ pet: { meow: 'hi' } }, 'Home')).valid).toBe(true);
    expect((await facet.parse({ pet: { bark: 'woof' } }, 'Home')).valid).toBe(false);
  });

  it('template literal types', async () => {
    const facet = makeFacet(`
interface Handler {
  event: \`on\${'Click' | 'Hover'}\`;
}
`);
    expect((await facet.parse({ event: 'onClick' }, 'Handler')).valid).toBe(true);
    expect((await facet.parse({ event: 'onFocus' }, 'Handler')).valid).toBe(false);
  });

  it('mapped types', async () => {
    const facet = makeFacet(`
interface Config { host: string; port: number; }
type Nullable<T> = { [K in keyof T]: T[K] | null; };

interface Settings {
  config: Nullable<Config>;
}
`);
    expect((await facet.parse({ config: { host: null, port: null } }, 'Settings')).valid).toBe(true);
  });
});

describe('Aliased references and cycles (doc fixtures)', () => {
  it('self-referential cycle at optional field', async () => {
    const facet = makeFacet(`interface TreeNode { id: number; parent?: TreeNode; }`);
    const node: any = { id: 1 };
    node.parent = node; // self-referential cycle

    const ok = await facet.parse(node, 'TreeNode');
    expect(ok.valid).toBe(true);
  });

  it('DAG: shared node under multiple parents', async () => {
    // `shared` appears under two parent branches — validated once, not twice.
    const facet = makeFacet(`interface Node { id: number; children: Node[]; }`);
    const shared = { id: 99, children: [] };
    const root = {
      id: 1,
      children: [
        { id: 2, children: [shared] },
        { id: 3, children: [shared] },
      ],
    };
    const ok = await facet.parse(root, 'Node');
    expect(ok.valid).toBe(true);
  });
});

describe('Type aliases to top-level interfaces', () => {
  it('type X = Y<Todo> validates against Y<Todo> and fills Y defaults', async () => {
    const facet = makeFacet(`
interface Todo { title: string; done: boolean; }
interface List<T> {
  items: T[];
  /** @default 0 */
  count?: number;
}
type TodoList = List<Todo>;
`);
    // Valid input — typia validates the concrete shape
    const ok = await facet.parse(
      { items: [{ title: 'ship it', done: false }] },
      'TodoList',
    );
    expect(ok.valid).toBe(true);
    // @default from List propagates to the alias
    expect((ok as { valid: true; data: { count: number } }).data.count).toBe(0);

    // Invalid input — wrong element type
    const bad = await facet.parse({ items: [42] }, 'TodoList');
    expect(bad.valid).toBe(false);
  });

  it('bare alias type X = Y also works', async () => {
    const facet = makeFacet(`
interface User {
  name: string;
  /** @default "guest" */
  role?: string;
}
type Person = User;
`);
    const ok = await facet.parse({ name: 'Alice' }, 'Person');
    expect(ok.valid).toBe(true);
    expect((ok as { valid: true; data: { role: string } }).data.role).toBe('guest');
  });
});

describe('Known Limitations', () => {
  // NOTE: the "URL instance rejected" doc block isn't testable through the
  // Workers RPC path — URL doesn't structured-clone, so the request fails
  // at the boundary with DataCloneError before typia's validator runs. The
  // doc's claim (typia rejects URL instances) is likely correct for direct
  // typia use, but the example in the doc can't be verified via facet.parse.
  // See bugs-found list at end of conversion session for triage.

  it('URL workaround: string + @format url', async () => {
    // Workaround for URL: a string field with @format url.
    const facet = makeFacet(`
interface Link {
  /** @format url */
  href: string;
}
`);
    const ok = await facet.parse({ href: 'https://example.com' }, 'Link');
    expect(ok.valid).toBe(true);
  });

  it('Headers workaround: Record<string, string>', async () => {
    // Workaround for Headers: Record<string, string>.
    const facet = makeFacet(`interface Req { headers: Record<string, string>; }`);
    const ok = await facet.parse(
      { headers: { 'content-type': 'application/json' } },
      'Req',
    );
    expect(ok.valid).toBe(true);
  });
});

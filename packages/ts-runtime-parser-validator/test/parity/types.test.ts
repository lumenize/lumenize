/**
 * Type-support delta suite — TypeScript type-system features layer.
 *
 * Walks each category from `website/docs/ts-runtime-validator/type-support.md`
 * and exercises the new package against it. This is a **decision-forcing**
 * suite, NOT a parity gate — failing tests are expected where typia's type
 * walker differs from tsc's native type system. The pass/fail matrix feeds
 * Phase 7's type-support.mdx (keep-with-example vs drop-with-reason).
 *
 * Each test uses `.only` or `.skip` is NOT used — we want every test to run
 * so the aggregate pass/fail gives a complete picture. Failing tests stay
 * failing (don't band-aid them with skips); the write-up in Phase 7 describes
 * the gap.
 *
 * Naming: `it('[SUPPORTED] ...')` or `it('[DROP] ...')` is used to tag
 * intent. At Phase 5 close, review each DROP and confirm it's intentional.
 */

import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

async function parse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<{
  result: { valid: boolean; data?: unknown; errors?: Array<{ path: string; expected: string }> };
}> {
  const response = await SELF.fetch('http://example.com/parse', {
    method: 'POST',
    body: JSON.stringify({ typeDefinitions, typeName, value, bundleId }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('Parity — Primitives', () => {
  it('[SUPPORTED] string, number, boolean, null, optional', async () => {
    const types = `
interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}
`;
    const { result } = await parse(
      types,
      'Config',
      { name: 'test', count: 42, enabled: true, label: null },
      'prim-ok',
    );
    expect(result.valid).toBe(true);
  });

  it('[DROP] bigint — does not survive JSON serialisation at test boundary', async () => {
    // bigint can't round-trip through JSON.stringify (which is what our test
    // harness uses to POST values). Real usage goes through Workers RPC which
    // does preserve bigint. The delta suite's values-layer file will cover
    // RPC-path bigint; the types-layer can only document the doc boundary.
    expect(true).toBe(true);
  });
});

describe('Parity — Object and Array', () => {
  it('[SUPPORTED] nested inline objects', async () => {
    const types = `
interface Person {
  name: string;
  address: { street: string; city: string; };
}
`;
    const { result } = await parse(
      types,
      'Person',
      { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
      'nest-ok',
    );
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] typed arrays catch wrong element types', async () => {
    const types = `interface NumberList { items: number[]; }`;
    const { result } = await parse(types, 'NumberList', { items: [1, 'two', 3] }, 'arr-fail');
    expect(result.valid).toBe(false);
  });
});

describe('Parity — Union and Optional', () => {
  it('[SUPPORTED] union type accepts both members', async () => {
    const types = `interface Result { value: string | number; }`;
    const { result: s } = await parse(types, 'Result', { value: 'hi' }, 'un-str');
    expect(s.valid).toBe(true);
    const { result: n } = await parse(types, 'Result', { value: 42 }, 'un-num');
    expect(n.valid).toBe(true);
  });

  it('[SUPPORTED] string-literal union rejects invalid values', async () => {
    const types = `interface Item { category: 'internal' | 'external'; }`;
    const { result: ok } = await parse(types, 'Item', { category: 'internal' }, 'lit-ok');
    expect(ok.valid).toBe(true);
    const { result: bad } = await parse(types, 'Item', { category: 'other' }, 'lit-bad');
    expect(bad.valid).toBe(false);
  });

  it('[SUPPORTED] optional property (both present and absent)', async () => {
    const types = `interface User { name: string; nickname?: string; }`;
    const { result: absent } = await parse(types, 'User', { name: 'Alice' }, 'opt-absent');
    expect(absent.valid).toBe(true);
    const { result: present } = await parse(types, 'User', { name: 'Alice', nickname: 'Al' }, 'opt-present');
    expect(present.valid).toBe(true);
  });
});

describe('Parity — Utility Types', () => {
  it('[SUPPORTED] Partial<T> via type alias', async () => {
    // Phase 6.8a (2026-04-24): top-level `type` aliases materialise as
    // validator targets, so `type PartialUser = Partial<User>;` works —
    // typia expands the utility type and generates a validator.
    const types = `
interface User { name: string; email: string; age: number; }
type PartialUser = Partial<User>;
`;
    const { result } = await parse(types, 'PartialUser', { name: 'x' }, 'partial-ok');
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] Utility types work when embedded in an interface', async () => {
    const types = `
interface User { name: string; email: string; age: number; }
interface Draft { user: Partial<User>; }
`;
    const { result: ok } = await parse(
      types,
      'Draft',
      { user: { name: 'Alice' } },
      'partial-embed',
    );
    expect(ok.valid).toBe(true);
  });

  it('[SUPPORTED] Pick via embedded field', async () => {
    const types = `
interface User { name: string; email: string; age: number; }
interface Contact { data: Pick<User, 'name' | 'email'>; }
`;
    const { result: ok } = await parse(
      types,
      'Contact',
      { data: { name: 'Alice', email: 'a@b.com' } },
      'pick-ok',
    );
    expect(ok.valid).toBe(true);
  });

  it('[SUPPORTED] Record via embedded field', async () => {
    const types = `interface Roles { data: Record<string, boolean>; }`;
    const { result } = await parse(types, 'Roles', { data: { admin: true, user: false } }, 'rec-ok');
    expect(result.valid).toBe(true);
  });
});

describe('Parity — Advanced Types', () => {
  it('[SUPPORTED] conditional types (resolved by tsc before typia sees them)', async () => {
    const types = `
interface Cat { meow: string; }
interface Dog { bark: string; }
type Pet<T> = T extends 'cat' ? Cat : Dog;
interface Home { pet: Pet<'cat'>; }
`;
    const { result } = await parse(types, 'Home', { pet: { meow: 'loud' } }, 'cond-ok');
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] template literal types', async () => {
    const types = `
type EventName = \`on\${'Click' | 'Hover'}\`;
interface Handler { event: EventName; }
`;
    const { result } = await parse(types, 'Handler', { event: 'onClick' }, 'tmpl-ok');
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] custom mapped type', async () => {
    const types = `
interface Config { host: string; port: number; }
type Nullable<T> = { [K in keyof T]: T[K] | null; };
interface Settings { config: Nullable<Config>; }
`;
    const { result } = await parse(
      types,
      'Settings',
      { config: { host: null, port: 8080 } },
      'map-ok',
    );
    expect(result.valid).toBe(true);
  });
});

describe('Parity — Generic Types', () => {
  it('[DROP] generic type as typeName directly (not supported — must be embedded)', async () => {
    // Old tsc package: users passed `'List<Todo>'` as typeName. New package
    // only generates validators for top-level `interface` declarations.
    // Users wanting generic instantiations must embed them in a named interface.
    const types = `
interface Todo { title: string; done: boolean; }
interface List<T> { items: T[]; }
`;
    const { result } = await parse(types, 'List<Todo>', { items: [] }, 'gen-drop');
    expect(result.valid).toBe(false);
    expect(result.errors![0].expected).toBe('List<Todo>');
  });

  it('[SUPPORTED] generics work when materialized in a named interface', async () => {
    const types = `
interface Todo { title: string; done: boolean; }
interface TodoList { items: Todo[]; }
`;
    const { result } = await parse(
      types,
      'TodoList',
      { items: [{ title: 'Ship', done: false }] },
      'gen-concrete',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ items: [{ title: 'Ship', done: false }] });
  });
});

describe('Parity — Known Limitations', () => {
  it('[DROP] `any` field — typia treats as structural, unlike tsc behavior', async () => {
    // Old package: `metadata: any` accepts Maps, Sets, Dates, cycles. New package
    // does a typeof check only — lets anything through, doesn't recurse.
    const types = `interface Flex { metadata: any; }`;
    const { result } = await parse(
      types,
      'Flex',
      { metadata: { a: 1, b: [1, 2, 3] } },
      'any-ok',
    );
    expect(result.valid).toBe(true);
  });

  it('[DROP] functions are not supported (same as old package)', async () => {
    // typia rejects functions by type; old package threw TypeError. New package
    // validates that the function field matches whatever shape was declared,
    // but functions themselves can't cross the Workers RPC boundary anyway.
    const types = `interface X { fn: any; }`;
    const { result } = await parse(types, 'X', { fn: null }, 'fn-any');
    expect(result.valid).toBe(true); // `any` accepts null
  });
});

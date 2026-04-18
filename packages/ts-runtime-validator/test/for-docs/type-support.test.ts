/**
 * Pedagogical examples for the type-support.mdx documentation page.
 * Demonstrates supported types, type mappings, and known limitations.
 */

import { describe, it, expect } from 'vitest';
import { validate } from '@lumenize/ts-runtime-validator';
import types from './type-support-types.ts?raw';

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

describe('Primitive Types', () => {
  it('validates string, number, boolean, null, undefined', () => {
    const value = { name: 'test', count: 42, enabled: true, label: null };
    expect(validate(value, 'Config', types).valid).toBe(true);
  });

  it('validates bigint', () => {
    expect(validate({ value: BigInt(9007199254740993) }, 'HasBigInt', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Object and Array types
// ---------------------------------------------------------------------------

describe('Objects and Arrays', () => {
  it('validates nested objects', () => {
    const person = { name: 'Alice', address: { street: '123 Main', city: 'Springfield' } };
    expect(validate(person, 'Person', types).valid).toBe(true);
  });

  it('rejects wrong element types in arrays', () => {
    const result = validate({ items: [1, 'two', 3] }, 'NumberList', types);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Union and optional types
// ---------------------------------------------------------------------------

describe('Union and Optional Types', () => {
  it('validates union types', () => {
    expect(validate({ value: 'hello' }, 'Result', types).valid).toBe(true);
    expect(validate({ value: 42 }, 'Result', types).valid).toBe(true);
  });

  it('validates string literal union types', () => {
    expect(validate({ category: 'internal' }, 'Item', types).valid).toBe(true);
    expect(validate({ category: 'external' }, 'Item', types).valid).toBe(true);
    expect(validate({ category: 'other' }, 'Item', types).valid).toBe(false);
  });

  it('validates optional properties', () => {
    expect(validate({ name: 'Alice' }, 'User', types).valid).toBe(true);
    expect(validate({ name: 'Alice', nickname: 'Al' }, 'User', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Map and Set
// ---------------------------------------------------------------------------

describe('Map and Set', () => {
  it('validates homogeneous Maps', () => {
    const value = { data: new Map([['alice', 95], ['bob', 87]]) };
    expect(validate(value, 'Scores', types).valid).toBe(true);
  });

  it('rejects wrong Map value types', () => {
    const invalid = { data: new Map<string, any>([['alice', 'not-a-number']]) };
    const result = validate(invalid, 'Scores', types);
    expect(result.valid).toBe(false);
  });

  it('validates heterogeneous Maps with union value types', () => {
    const value = { data: new Map<string, string | number>([['a', 'hello'], ['b', 42]]) };
    const result = validate(value, 'Mixed', types);
    expect(result.valid).toBe(true);
  });

  it('validates Sets', () => {
    const value = { items: new Set(['a', 'b', 'c']) };
    expect(validate(value, 'Tags', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Date, RegExp, URL, Headers
// ---------------------------------------------------------------------------

describe('Built-in Object Types', () => {
  it('validates Date', () => {
    expect(validate({ when: new Date() }, 'Appointment', types).valid).toBe(true);
  });

  it('validates RegExp', () => {
    expect(validate({ re: /hello/gi }, 'Pattern', types).valid).toBe(true);
  });

  it('validates URL', () => {
    expect(validate({ url: new URL('https://example.com') }, 'Link', types).valid).toBe(true);
  });

  it('validates Headers', () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    expect(validate({ headers }, 'Req', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe('Error Types', () => {
  it('validates standard errors', () => {
    expect(validate({ error: new TypeError('bad input') }, 'Failure', types).valid).toBe(true);
  });

  it('validates errors structurally — define as interfaces not classes', () => {
    const err = Object.assign(new Error('Not found'), { statusCode: 404 });
    expect(validate({ error: err }, 'ErrorResult', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Binary types
// ---------------------------------------------------------------------------

describe('Binary Types', () => {
  it('validates ArrayBuffer', () => {
    expect(validate({ data: new ArrayBuffer(16) }, 'BlobData', types).valid).toBe(true);
  });

  it('validates Uint8Array', () => {
    expect(validate({ bytes: new Uint8Array([1, 2, 3]) }, 'Packet', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rich types in `any` fields
// ---------------------------------------------------------------------------

describe('Rich Types in any Fields', () => {
  it('Maps, Sets, and Dates pass through any fields', () => {
    const value = {
      metadata: {
        tags: new Set(['important']),
        scores: new Map([['test', 100]]),
        created: new Date(),
      },
    };
    expect(validate(value, 'Flexible', types).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

describe('Utility Types', () => {
  const utilityTypes = `
    interface User { name: string; email: string; age: number; }
  `;

  it('Partial makes all properties optional', () => {
    expect(validate({ name: 'Alice' }, 'Partial<User>', utilityTypes).valid).toBe(true);
    expect(validate({}, 'Partial<User>', utilityTypes).valid).toBe(true);
  });

  it('Required makes all properties required', () => {
    const optTypes = `interface Profile { name: string; bio?: string; }`;
    expect(validate({ name: 'Alice', bio: 'hi' }, 'Required<Profile>', optTypes).valid).toBe(true);
    expect(validate({ name: 'Alice' }, 'Required<Profile>', optTypes).valid).toBe(false);
  });

  it('Pick selects specific properties', () => {
    expect(validate({ name: 'Alice' }, "Pick<User, 'name'>", utilityTypes).valid).toBe(true);
    expect(validate({ name: 'Alice', email: 'a@b.com' }, "Pick<User, 'name'>", utilityTypes).valid).toBe(false);
  });

  it('Omit excludes specific properties', () => {
    expect(validate({ name: 'Alice', email: 'a@b.com' }, "Omit<User, 'age'>", utilityTypes).valid).toBe(true);
  });

  it('Record creates a typed dictionary', () => {
    const recordTypes = `type Roles = Record<string, boolean>;`;
    expect(validate({ admin: true, user: false }, 'Roles', recordTypes).valid).toBe(true);
  });

  it('Readonly validates the same structure', () => {
    expect(validate({ name: 'Alice', email: 'a@b.com', age: 30 }, 'Readonly<User>', utilityTypes).valid).toBe(true);
  });

  it('Uppercase intrinsic works', () => {
    const types = `interface Label { text: Uppercase<string>; }`;
    expect(validate({ text: 'HELLO' }, 'Label', types).valid).toBe(true);
    expect(validate({ text: 'hello' }, 'Label', types).valid).toBe(false);
  });

  it('Lowercase intrinsic works', () => {
    const types = `interface Label { text: Lowercase<string>; }`;
    expect(validate({ text: 'hello' }, 'Label', types).valid).toBe(true);
    expect(validate({ text: 'HELLO' }, 'Label', types).valid).toBe(false);
  });

  it('Capitalize intrinsic works', () => {
    const types = `interface Label { text: Capitalize<string>; }`;
    expect(validate({ text: 'Hello' }, 'Label', types).valid).toBe(true);
    expect(validate({ text: 'hello' }, 'Label', types).valid).toBe(false);
  });

  it('Uncapitalize intrinsic works', () => {
    const types = `interface Label { text: Uncapitalize<string>; }`;
    expect(validate({ text: 'hello' }, 'Label', types).valid).toBe(true);
    expect(validate({ text: 'Hello' }, 'Label', types).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Known limitations
// ---------------------------------------------------------------------------

describe('Known Limitations', () => {
  it('cyclic objects with typed self-reference', () => {
    const cyclicTypes = `
      interface TreeNode { id: number; parent: TreeNode; }
    `;
    const node: any = { id: 1 };
    node.parent = node; // cycle

    const result = validate(node, 'TreeNode', cyclicTypes);
    expect(result.valid).toBe(true);
  });

  it('cyclic objects with optional typed self-reference', () => {
    const cyclicTypes = `
      interface TreeNode { id: number; parent?: TreeNode; }
    `;
    const node: any = { id: 1 };
    node.parent = node; // cycle

    const result = validate(node, 'TreeNode', cyclicTypes);
    expect(result.valid).toBe(true);
  });

  it('custom conditional types work', () => {
    const conditionalTypes = `
      interface Cat { meow: string; }
      interface Dog { bark: string; }
      type Pet<T> = T extends 'cat' ? Cat : Dog;
      interface Home { pet: Pet<'cat'>; }
    `;
    const result = validate({ pet: { meow: 'loud' } }, 'Home', conditionalTypes);
    expect(result.valid).toBe(true);
  });

  it('template literal types work', () => {
    const templateTypes = `
      type EventName = \`on\${'Click' | 'Hover'}\`;
      interface Handler { event: EventName; }
    `;
    const result = validate({ event: 'onClick' }, 'Handler', templateTypes);
    expect(result.valid).toBe(true);
  });

  it('custom mapped types work', () => {
    const mappedTypes = `
      interface Config { host: string; port: number; }
      type Nullable<T> = { [K in keyof T]: T[K] | null; };
      interface Settings { config: Nullable<Config>; }
    `;
    const result = validate({ config: { host: null, port: 8080 } }, 'Settings', mappedTypes);
    expect(result.valid).toBe(true);
  });

  it('cyclic objects validate when the back-edge field is typed as any', () => {
    const node: any = { id: 1 };
    node.self = node; // cycle

    const result = validate(node, 'Node', types);
    expect(result.valid).toBe(true);
  });

  it('functions throw TypeError', () => {
    expect(() => validate({ fn: () => {} }, 'X', 'interface X { fn: any; }')).toThrow(TypeError);
  });

  it('cyclic object Map keys with back-references work', () => {
    const cyclicMapTypes = `
      interface Parent { children: Map<Child, string>; }
      interface Child { name: string; parent: Parent; }
    `;
    const parent: any = { children: new Map() };
    const child: any = { name: 'Alice', parent };
    parent.children.set(child, 'first');
    const result = validate(parent, 'Parent', cyclicMapTypes);
    expect(result.valid).toBe(true);
  });

  it('non-cyclic object Map keys work', () => {
    const mapTypes = `interface X { data: Map<{id: number}, string>; }`;
    const map = new Map([[{ id: 1 }, 'one'], [{ id: 2 }, 'two']]);
    const result = validate({ data: map }, 'X', mapTypes);
    expect(result.valid).toBe(true);
  });

  it('object-keyed Map value cycles validate', () => {
    const map = new Map<any, any>();
    const key = { id: 1 };
    map.set(key, { ref: map });
    expect(validate({ data: map }, 'X', 'interface X { data: any; }').valid).toBe(true);
  });

  it('generic typeName resolves correctly', () => {
    const genericTypes = `
      interface List<T> { items: T[]; }
      interface Todo { title: string; done: boolean; }
    `;
    const list = { items: [{ title: 'Ship it', done: false }] };
    expect(validate(list, 'List<Todo>', genericTypes).valid).toBe(true);
    expect(validate({ items: [42] }, 'List<Todo>', genericTypes).valid).toBe(false);
  });

  it('generic typeName with Map', () => {
    const genericTypes = `
      interface Cache<V> { data: Map<string, V>; }
      interface Todo { title: string; done: boolean; }
    `;
    const cache = { data: new Map([['todo-1', { title: 'Ship it', done: false }]]) };
    expect(validate(cache, 'Cache<Todo>', genericTypes).valid).toBe(true);
  });

  it('generic typeName with Set', () => {
    const genericTypes = `
      interface UniqueCollection<T> { items: Set<T>; }
    `;
    const collection = { items: new Set(['a', 'b', 'c']) };
    expect(validate(collection, 'UniqueCollection<string>', genericTypes).valid).toBe(true);
  });
});

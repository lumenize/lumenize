---
title: Type Support & Validation Boundaries
description: Comprehensive table of supported types, with tested examples for every category.
---
# Type Support & Validation Boundaries

**tl;dr** — Everything you'd reasonably put in a resource definition works: primitives, objects, arrays, unions, optional fields, Maps, Sets, Dates, RegExp, all eleven TypedArrays, cyclic references, `any`, and `unknown`. TypeScript's structural and utility types (`Partial`, `Pick`, `Omit`, `Record`, conditional types, template literal types, mapped types) work too.

For per-field constraints (range, format, length, pattern, uniqueness), see [Additional Constraints](./additional-constraints).

The rest of this page is the receipts — tested examples for every category we could think of.

---

## Primitive Types

| Type | Example |
| --- | --- |
| `string` | `"hello"` |
| `number` | `42`, `-1.5e3` |
| `boolean` | `true`, `false` |
| `null` | `null` |
| `bigint` | `BigInt("9007199254740993")` (requires `@type "int64"` or similar) |
| Optional | `field?: T` — accepts `undefined` or omitted |

```typescript
@skip-check
interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}
```

```typescript
@skip-check
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
```

## Object and Array Types

Nested objects validate against inline shapes. Named interfaces used as fields also validate as embedded objects by default — to validate string-ID references instead (ORM-style), see [`extractTypeMetadata()` → Composer pattern](./api-reference#composer-pattern-validate-string-id-references).

```typescript
@skip-check
interface Person {
  name: string;
  address: { street: string; city: string; };
}
```

```typescript
@skip-check
const ok = await facet.parse(
  { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
  'Person',
);
expect(ok).toEqual({
  valid: true,
  data: { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
});
```

Arrays check each element:

```typescript
@skip-check
interface NumberList {
  items: number[];
}
```

```typescript
@skip-check
const bad = await facet.parse({ items: [1, 'two', 3] }, 'NumberList');
expect(bad.valid).toBe(false);  // 'two' at index 1
```

## Union and Optional Types

```typescript
@skip-check
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
```

String-literal unions accept listed values and reject others:

```typescript
@skip-check
expect((await facet.parse({ category: 'internal' }, 'Item')).valid).toBe(true);
expect((await facet.parse({ category: 'other' },    'Item')).valid).toBe(false);
```

Optional properties accept both present and absent:

```typescript
@skip-check
expect((await facet.parse({ name: 'Alice' },                    'User')).valid).toBe(true);
expect((await facet.parse({ name: 'Alice', nickname: 'Al' },    'User')).valid).toBe(true);
```

## Map and Set

`Map` and `Set` values pass through Workers RPC with their structure intact, and typia's validators check key/value types.

```typescript
@skip-check
interface Scores {
  data: Map<string, number>;
}
interface Mixed {
  data: Map<string, string | number>;
}
interface Tags {
  items: Set<string>;
}
```

Homogeneous Maps:

```typescript
@skip-check
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
```

Heterogeneous (union value types):

```typescript
@skip-check
const ok = await facet.parse(
  { data: new Map<string, string | number>([['a', 'hi'], ['b', 42]]) },
  'Mixed',
);
expect(ok.valid).toBe(true);
```

Sets of primitives:

```typescript
@skip-check
const ok = await facet.parse({ items: new Set(['a', 'b', 'c']) }, 'Tags');
expect(ok.valid).toBe(true);

const bad = await facet.parse({ items: new Set(['a', 42, 'c']) }, 'Tags');
expect(bad.valid).toBe(false);
```

`Set<Interface>` and `Map<K, Interface>` validate containers of *nested objects* by default — same as `Interface[]`. The composer pattern ([API Reference](./api-reference#composer-pattern-validate-string-id-references)) narrows these to `Set<string>` / `Map<K, string>`.

## Built-in Object Types

| Type | Notes |
| --- | --- |
| `Date` | `Date` instances validate; strings can be validated via `@format date-time` (see [Additional Constraints](./additional-constraints)). |
| `RegExp` | `RegExp` instances validate; for string pattern checking, prefer `@pattern`. |
| `URL` | **Not supported as a value type.** Use `@format url` on a string field instead. |
| `Headers` | **Not supported.** Use `Record<string, string>` instead. |

```typescript
@skip-check
interface Appointment {
  when: Date;
  rule: RegExp;
}
```

```typescript
@skip-check
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
```

## Binary Types

All eleven TypedArray variants validate against their declared type. `ArrayBuffer` is supported via its structural shape.

- `Int8Array`, `Uint8Array`, `Uint8ClampedArray`
- `Int16Array`, `Uint16Array`
- `Int32Array`, `Uint32Array`
- `Float32Array`, `Float64Array`
- `BigInt64Array`, `BigUint64Array`
- `ArrayBuffer`

```typescript
@skip-check
interface Blob {
  data: Uint8Array;
}
```

```typescript
@skip-check
const ok = await facet.parse({ data: new Uint8Array([1, 2, 3]) }, 'Blob');
expect(ok.valid).toBe(true);

const bad = await facet.parse({ data: new ArrayBuffer(3) }, 'Blob');
expect(bad.valid).toBe(false);  // expected Uint8Array, got ArrayBuffer
```

## Dynamic Fields with `any` or `unknown`

Both `any` and `unknown` accept any value — primitives, `null`, Maps, Sets, Dates, cycles, nested arrays. They're equivalent at the validator level; pick whichever matches your type-system discipline.

```typescript
@skip-check
interface Flexible {
  metadata: any;       // or: metadata: unknown;
}
```

```typescript
@skip-check
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

// Nothing to reject at the `metadata` level — both `any` and `unknown` accept
// any shape. The only way to fail is at the enclosing interface (e.g., missing
// the `metadata` field entirely if it were required).
```

## Utility Types

Standard TypeScript utility types work — `Partial`, `Pick`, `Omit`, `Record`, `Required`, `Readonly`, `NonNullable`, `Exclude`, `Extract`.

```typescript
@skip-check
interface User { name: string; email: string; age: number; }

interface PartialUser { user: Partial<User>; }
interface Credentials { creds: Pick<User, 'name' | 'email'>; }
interface Roles { roles: Record<string, boolean>; }
```

```typescript
@skip-check
expect((await facet.parse({ user: { name: 'Alice' } }, 'PartialUser')).valid).toBe(true);
expect((await facet.parse({ creds: { name: 'Alice', email: 'a@b.com' } }, 'Credentials')).valid).toBe(true);
expect((await facet.parse({ roles: { admin: true, user: false } }, 'Roles')).valid).toBe(true);

// Pick<User, 'name' | 'email'> doesn't include age, so providing it is fine
// (typia's default is lenient on extras); but supplying the wrong type for a
// required field still fails.
expect((await facet.parse({ creds: { name: 42, email: 'a@b.com' } }, 'Credentials')).valid).toBe(false);
```

## Advanced Types

Conditional types:

```typescript
@skip-check
interface Cat { meow: string; }
interface Dog { bark: string; }
type Pet<T> = T extends 'cat' ? Cat : Dog;

interface Home {
  pet: Pet<'cat'>;  // resolves to Cat
}

expect((await facet.parse({ pet: { meow: 'hi' } }, 'Home')).valid).toBe(true);
expect((await facet.parse({ pet: { bark: 'woof' } }, 'Home')).valid).toBe(false);
```

Template literals:

```typescript
@skip-check
interface Handler {
  event: `on${'Click' | 'Hover'}`;
}

expect((await facet.parse({ event: 'onClick' }, 'Handler')).valid).toBe(true);
expect((await facet.parse({ event: 'onFocus' }, 'Handler')).valid).toBe(false);
```

Mapped types — the positive case here is the receipt: passing `null` for every field succeeds because `Nullable<Config>` rewrote every field to `T | null`. Against the raw `Config`, this same input would fail.

```typescript
@skip-check
interface Config { host: string; port: number; }
type Nullable<T> = { [K in keyof T]: T[K] | null; };

interface Settings {
  config: Nullable<Config>;
}

expect((await facet.parse({ config: { host: null, port: null } }, 'Settings')).valid).toBe(true);
```

## Aliased references and cycles

The input value can freely contain **aliased references** — the same object appearing multiple times under different parents. Workers RPC and `@lumenize/structured-clone` (which Lumenize Mesh `call()` is built on) preserve the aliasing across the boundary. The `@default` filler walks with a `WeakMap` so it visits each node once. Typia's validator re-validates the aliased subtree each time it's reached — correct, but pays a duplicate-validation cost for widely-aliased subtrees.

[TODO: change to something like "This package preprocesses cycles and alias so typia doesn't stack overflow on cycles and doesn't do extra work for aliased branches." Also consider splitting aliases and cycles into two ]

```typescript
@skip-check
// DAG: `shared` appears under two different parent branches — no cycle.
interface Node { id: number; children: Node[]; }

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
```

**True runtime cycles** — a reference path that closes back on itself — currently stack-overflow typia's validator. A planned pre-release change (cycle-acyclify pre-pass) will make cycles validate natively; until then, two workarounds.

```typescript
@skip-check
// Current limitation: self-referential named-interface field + runtime cycle → stack overflow.
interface TreeNode { id: number; parent: TreeNode | null; }

const node: { id: number; parent: any } = { id: 1, parent: null };
node.parent = node;  // cycle

await expect(facet.parse(node, 'TreeNode')).rejects.toThrow(/Maximum call stack/);
```

```typescript
@skip-check
// Workaround 1: type the field as `any`. Typia stops recursing at the `any`
// boundary; structure there is unchecked but cycles are safe.
interface TreeNode { id: number; parent: any; }

const node: { id: number; parent: any } = { id: 1, parent: null };
node.parent = node;

const ok = await facet.parse(node, 'TreeNode');
expect(ok.valid).toBe(true);
```

```typescript
@skip-check
// Workaround 2: ORM composer pattern. Pre-extract metadata and feed the
// write-shape so `parent: TreeNode` becomes `parent: string` in the validator.
// Cycles can't form at runtime because each reference is a string, not an object.
import { extractTypeMetadata, generateParseModule } from '@lumenize/ts-runtime-parser-validator';

const md = extractTypeMetadata(`interface TreeNode { id: number; parent: TreeNode | null; }`);
const moduleSource = generateParseModule(md.writeShapeTypeDefinitions);
// Mount moduleSource. parse() now expects { id, parent: <id-string> | null }.
```


## Known Limitations

### `URL` and `Headers` values

Not supported as value types. Use string equivalents.

```typescript
@skip-check
// Limitation: URL instances aren't accepted by typia's structural check.
interface Link { href: URL; }
const bad = await facet.parse({ href: new URL('https://example.com') }, 'Link');
expect(bad.valid).toBe(false);
```

```typescript
@skip-check
// Workaround for URL: a string field with @format url.
interface Link {
  /** @format url */
  href: string;
}
const ok = await facet.parse({ href: 'https://example.com' }, 'Link');
expect(ok.valid).toBe(true);
```

```typescript
@skip-check
// Workaround for Headers: Record<string, string>.
interface Req { headers: Record<string, string>; }
const ok = await facet.parse(
  { headers: { 'content-type': 'application/json' } },
  'Req',
);
expect(ok.valid).toBe(true);
```

### Functions

Functions aren't validators-of-anything-sensible and aren't resource data. Don't include function-typed fields — they can't cross the Workers RPC boundary, either.

### Other transport-level types

Although [`@lumenize/structured-clone`](/docs/structured-clone) and Workers RPC faithfully transport values like `Error`, `Request`, `Response`, and `ResponseSync`, these aren't supported as field types here — they're not the shapes you'd persist or validate as resource data. If you have a use case, reach out.

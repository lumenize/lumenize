---
title: Type Support & Validation Boundaries
description: Comprehensive table of supported types, with tested examples for every category.
---
# Type Support & Validation Boundaries

**tl;dr** — Everything you'd reasonably put in a resource definition works: primitives, objects, arrays, unions, optional fields, Maps, Sets, Dates, RegExp, all eleven TypedArrays, cyclic references, and `any`. TypeScript's structural and utility types (`Partial`, `Pick`, `Omit`, `Record`, conditional types, template literal types, mapped types) work when embedded in a named interface. Relationship references (nested interfaces used as fields) are rewritten to string IDs in the generated validator — see [Write-shape rewriting](#write-shape-rewriting). For per-field constraints (range, format, length, pattern, uniqueness), see [Additional Constraints](./additional-constraints).

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

```typescript @skip-check
interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}
```

```typescript @skip-check
const ok = await facet.parse(
  { name: 'test', count: 42, enabled: true, label: null },
  'Config',
);
// valid: true
```

## Object and Array Types

Nested objects validate against inline shapes. **For named interfaces used as fields, see [Write-shape rewriting](#write-shape-rewriting) — relationships are rewritten to string IDs.**

```typescript @skip-check
interface Person {
  name: string;
  address: { street: string; city: string; };
}
```

```typescript @skip-check
const ok = await facet.parse(
  { name: 'Alice', address: { street: '1 Main', city: 'Springfield' } },
  'Person',
);
// valid: true
```

Arrays check each element:

```typescript @skip-check
interface NumberList {
  items: number[];
}
```

```typescript @skip-check
const bad = await facet.parse({ items: [1, 'two', 3] }, 'NumberList');
// valid: false — 'two' at index 1
```

## Union and Optional Types

```typescript @skip-check
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

```typescript @skip-check
await facet.parse({ category: 'internal' }, 'Item');  // valid: true
await facet.parse({ category: 'other' },   'Item');   // valid: false
```

Optional properties accept both present and absent:

```typescript @skip-check
await facet.parse({ name: 'Alice' },                    'User');  // valid: true
await facet.parse({ name: 'Alice', nickname: 'Al' },    'User');  // valid: true
```

## Map and Set

`Map` and `Set` values pass through Workers RPC with their structure intact, and typia's validators check key/value types.

```typescript @skip-check
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

```typescript @skip-check
const ok = await facet.parse(
  { data: new Map([['alice', 95], ['bob', 87]]) },
  'Scores',
);
// valid: true
```

Heterogeneous (union value types):

```typescript @skip-check
const ok = await facet.parse(
  { data: new Map<string, string | number>([['a', 'hi'], ['b', 42]]) },
  'Mixed',
);
// valid: true
```

Sets of primitives:

```typescript @skip-check
const ok = await facet.parse({ items: new Set(['a', 'b', 'c']) }, 'Tags');
// valid: true
```

**`Set<Interface>` and `Map<K, Interface>` on named interfaces trigger write-shape rewriting** — see below.

## Built-in Object Types

| Type | Notes |
| --- | --- |
| `Date` | `Date` instances validate; strings can be validated via `@format date-time` (see [Additional Constraints](./additional-constraints)). |
| `RegExp` | `RegExp` instances validate; for string pattern checking, prefer `@pattern`. |
| `URL` | **Not supported as a value type.** Use `@format url` on a string field instead. |
| `Headers` | **Not supported.** Use `Record<string, string>` instead. |

```typescript @skip-check
interface Appointment {
  when: Date;
  rule: RegExp;
}
```

```typescript @skip-check
const ok = await facet.parse(
  { when: new Date(), rule: /abc/ },
  'Appointment',
);
// valid: true
```

## Binary Types

All eleven TypedArray variants validate against their declared type. `ArrayBuffer` is supported via its structural shape.

- `Int8Array`, `Uint8Array`, `Uint8ClampedArray`
- `Int16Array`, `Uint16Array`
- `Int32Array`, `Uint32Array`
- `Float32Array`, `Float64Array`
- `BigInt64Array`, `BigUint64Array`
- `ArrayBuffer`

```typescript @skip-check
interface Blob {
  data: Uint8Array;
}
```

```typescript @skip-check
const ok = await facet.parse({ data: new Uint8Array([1, 2, 3]) }, 'Blob');
// valid: true

const bad = await facet.parse({ data: [1, 2, 3] }, 'Blob');
// valid: false — expected Uint8Array, got plain array
```

## Dynamic Fields with `any`

`any` accepts anything structural — Maps, Sets, Dates, cycles, nested arrays.

```typescript @skip-check
interface Flexible {
  metadata: any;
}
```

```typescript @skip-check
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
// valid: true
```

## Utility Types

Standard TypeScript utility types work when embedded in a named interface — `Partial`, `Pick`, `Omit`, `Record`, `Required`, `Readonly`, `NonNullable`, `Exclude`, `Extract`.

```typescript @skip-check
interface User { name: string; email: string; age: number; }

interface PartialUser { user: Partial<User>; }
interface Credentials { creds: Pick<User, 'name' | 'email'>; }
interface Roles { roles: Record<string, boolean>; }
```

```typescript @skip-check
await facet.parse({ user: { name: 'Alice' } }, 'PartialUser');      // valid: true
await facet.parse({ creds: { name: 'Alice', email: 'a@b.com' } }, 'Credentials');  // valid: true
await facet.parse({ roles: { admin: true, user: false } }, 'Roles'); // valid: true
```

## Advanced Types

Conditional types, template literal types, and mapped types are resolved by `tsc` before typia sees them — so the full type system is available, as long as you end up with a named interface.

```typescript @skip-check
interface Cat { meow: string; }
interface Dog { bark: string; }
type Pet<T> = T extends 'cat' ? Cat : Dog;

interface Home {
  pet: Pet<'cat'>;  // resolves to Cat
}
```

```typescript @skip-check
interface Handler {
  event: `on${'Click' | 'Hover'}`;  // template literal
}
```

```typescript @skip-check
interface Config { host: string; port: number; }
type Nullable<T> = { [K in keyof T]: T[K] | null; };

interface Settings {
  config: Nullable<Config>;
}
```

## Cyclic References

Workers RPC preserves cyclic references via structured-clone semantics, and the default-filler walks with a `WeakMap` so cycles don't blow the stack.

```typescript @skip-check
interface TreeNode {
  id: number;
  parent?: TreeNode;  // self-reference
}

const node: any = { id: 1 };
node.parent = node;  // cycle
await facet.parse(node, 'TreeNode');
// valid: true (note: this is a relationship — see Write-shape rewriting)
```

## Write-shape rewriting

When an interface field refers to another top-level interface (directly, via `T[]`, via `Array<T>`, via `Set<T>` / `ReadonlySet<T>`, or via `Map<K, T>` / `ReadonlyMap<K, T>`), the generated validator rewrites that field to expect string IDs — not the nested interface.

```typescript @skip-check
// Input:
interface User { id: string; name: string; }
interface Team {
  lead: User;           // becomes lead: string
  members: User[];      // becomes members: string[]
  roles: Map<string, User>;  // becomes roles: Map<string, string>
}
```

At `parse()` time, pass IDs:

```typescript @skip-check
const ok = await facet.parse(
  {
    lead: 'u-1',
    members: ['u-1', 'u-2'],
    roles: new Map([['admin', 'u-1']]),
  },
  'Team',
);
// valid: true
```

This mirrors Lumenize Nebula's transaction model (relationships are references, not embedded payloads). If you want nested-object validation instead, declare the nested shape **inline** rather than as a named interface:

```typescript @skip-check
interface Team {
  // Inline — NOT rewritten
  lead: { id: string; name: string; };
}
```

Container shape and key type are preserved when rewriting. `Map<'admin' | 'editor', User>` becomes `Map<'admin' | 'editor', string>` — only the ontology-referenced value is rewritten to `string`.

## Known Limitations

### Generic instantiation as a `typeName`

The old `@lumenize/ts-runtime-validator` accepted `'List<Todo>'` as a `typeName`. This package requires a **named** interface. Workaround: materialise the shape as an alias.

```typescript @skip-check
// Won't work:
// await facet.parse(list, 'List<Todo>');

// Instead:
interface TodoList { items: Todo[]; }
await facet.parse(list, 'TodoList');
```

### `URL` and `Headers` values

Not supported as value types. Use string equivalents:

- `URL` → `string` with `@format url`
- `Headers` → `Record<string, string>`

### Functions

Functions aren't validators-of-anything-sensible and aren't resource data. Don't include function-typed fields.
